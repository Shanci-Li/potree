#!/usr/bin/env node
// Potree project service: HTTP API (SPEC §5) for the project portal, with a persisted job queue for
// project creation and preview rendering. Configuration: see server/README.md.

import crypto from "node:crypto";
import express from "express";
import { VERSION, config } from "./lib/config.mjs";
import { inspectPath, listDirectory } from "./lib/browse.mjs";
import { converterAvailable, killConverters } from "./lib/converter.mjs";
import { CREATE_STEPS, PREVIEW_STEPS, cleanupStaging, describePlan, prepareCreate, runCreateJob, runPreviewJob } from "./lib/create.mjs";
import { getCrsList } from "./lib/crs.mjs";
import { JobQueue } from "./lib/jobs.mjs";
import { PreviewRenderer, previewAvailability, staticRootMiddleware } from "./lib/preview.mjs";
import { patchProject } from "./lib/projects.mjs";
import { buildRegistry, readProject } from "./lib/registry.mjs";
import { HttpError, createMutex } from "./lib/util.mjs";

// Base URL under which the renderer finds POTREE_ROOT: an external server, or this one.
const loopbackHost = ["0.0.0.0", "::", ""].includes(config.host) ? "127.0.0.1" : config.host;
const previewBaseUrl = config.previewBaseUrl ?? `http://${loopbackHost.includes(":") ? `[${loopbackHost}]` : loopbackHost}:${config.port}`;

// One browser for consecutive preview renders; closed whenever the queue becomes idle.
let renderer = null;
async function getRenderer() {
	const availability = await previewAvailability();
	if (!availability.available) {
		throw new Error(`preview rendering unavailable: ${availability.reason}`);
	}
	renderer ??= new PreviewRenderer({ baseUrl: previewBaseUrl });
	return renderer;
}

const jobs = new JobQueue({
	jobsDir: config.jobsDir,
	runners: {
		create: (job) => runCreateJob(job, job.context, { getRenderer }),
		preview: (job) => runPreviewJob(job, { getRenderer }),
	},
	onInterrupted: async (job) => {
		if (job.type === "create") {
			const note = await cleanupStaging(job);
			if (note) {
				job.error += ` — ${note}`;
			}
		}
	},
	onIdle: async () => {
		const r = renderer;
		renderer = null;
		await r?.close();
	},
});

// --- Authentication (API_TOKEN) -------------------------------------------------------------------
// Reading the project list, a project, the CRS table and the health status is open; every other
// request (all writes, the server file browser and the jobs) needs `Authorization: Bearer <token>`
// (or `X-Api-Token: <token>`). Without a configured API_TOKEN those endpoints are disabled (503).

const OPEN_READ_ENDPOINTS = [/^\/health\/?$/i, /^\/projects\/?$/i, /^\/projects\/[^/]+\/?$/i, /^\/crs\/?$/i];

// Tokens are compared as SHA-256 digests: equal-length buffers for timingSafeEqual, whatever was sent.
const tokenDigest = (token) => crypto.createHash("sha256").update(token, "utf8").digest();
const apiTokenDigest = config.apiToken === null ? null : tokenDigest(config.apiToken);

function requestToken(req) {
	const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.get("authorization") ?? "");
	return bearer?.[1] ?? (req.get("x-api-token")?.trim() || null);
}

function requireToken(req, res, next) {
	if ((req.method === "GET" || req.method === "HEAD") && OPEN_READ_ENDPOINTS.some((re) => re.test(req.path))) {
		next();
		return;
	}
	if (apiTokenDigest === null) {
		res.status(503).json({ error: "project service has no API_TOKEN configured; creating and editing projects is disabled", auth: "unconfigured" });
		return;
	}
	const token = requestToken(req);
	if (token === null || !crypto.timingSafeEqual(tokenDigest(token), apiTokenDigest)) {
		res.set("WWW-Authenticate", 'Bearer realm="potree-projects"');
		res.status(401).json({ error: "authentication required", auth: "token" });
		return;
	}
	next();
}

// --- API ------------------------------------------------------------------------------------------

const asyncRoute = (fn) => (req, res, next) => fn(req, res).catch(next);

// Requests are answered only once restart recovery has finished (see startup below).
let ready = false;

const api = express.Router();
api.use((req, res, next) => {
	if (ready) {
		next();
	} else {
		res.status(503).json({ error: "the project service is starting; try again in a moment" });
	}
});
api.use(requireToken);
api.use(express.json({ limit: "1mb" }));

api.get("/health", asyncRoute(async (req, res) => {
	const preview = await previewAvailability();
	res.json({
		ok: true,
		version: VERSION,
		converter: { path: config.converter, exists: converterAvailable(config.converter) },
		preview: { ...preview, baseUrl: previewBaseUrl },
		queue: jobs.stats(),
		auth: { required: true, configured: config.apiToken !== null },
		importModes: config.importModes,
		moveRoots: config.moveRoots,
	});
}));

api.get("/projects", asyncRoute(async (req, res) => {
	const { registry } = await buildRegistry();
	res.json(registry);
}));

api.get("/projects/:id", asyncRoute(async (req, res) => {
	res.json(await readProject(req.params.id));
}));

// Creates whose title-derived id was taken by a concurrent request while they were validated choose
// again one at a time, so each sees the reservations of the others.
const retryCreateExclusive = createMutex();

api.post("/projects", asyncRoute(async (req, res) => {
	const explicitId = ![undefined, null, ""].includes(req.body?.id);
	const createJob = async () => {
		const plan = await prepareCreate(req.body, { reservedIds: jobs.activeProjectIds("create") });
		// enqueue() checks and reserves the id synchronously (before its first await): no other request
		// can take it between this check and the 202 below. A taken id fails with code EPROJECTBUSY.
		const job = await jobs.enqueue({
			type: "create",
			projectId: plan.id,
			steps: CREATE_STEPS,
			request: describePlan(plan),
			context: plan,
			exclusiveProject: true,
		});
		return { plan, job };
	};
	let created;
	try {
		created = await createJob();
	} catch (err) {
		if (err.code !== "EPROJECTBUSY" || explicitId) {
			throw err; // a requested id that another request reserved meanwhile is a conflict (409)
		}
		created = await retryCreateExclusive(async () => {
			for (let attempt = 1; ; attempt++) {
				try {
					return await createJob();
				} catch (retryErr) {
					if (retryErr.code !== "EPROJECTBUSY" || attempt >= 5) {
						throw retryErr;
					}
				}
			}
		});
	}
	res.status(202).json({ jobId: created.job.id, projectId: created.plan.id });
}));

api.patch("/projects/:id", asyncRoute(async (req, res) => {
	const { project, warnings } = await patchProject(req.params.id, req.body);
	if (warnings.length > 0) {
		res.set("X-Warnings", encodeURIComponent(warnings.join("; ")));
	}
	res.json(project);
}));

api.post("/projects/:id/preview", asyncRoute(async (req, res) => {
	const project = await readProject(req.params.id);
	const job = await jobs.enqueue({ type: "preview", projectId: req.params.id, steps: PREVIEW_STEPS, request: { custom: project.custom === true } });
	res.status(202).json({ jobId: job.id });
}));

api.get("/jobs", (req, res) => {
	res.json(jobs.list());
});

api.get("/jobs/:id", asyncRoute(async (req, res) => {
	const job = await jobs.describe(req.params.id);
	if (!job) {
		throw new HttpError(404, `job not found: ${req.params.id}`);
	}
	res.json(job);
}));

api.get("/fs/list", asyncRoute(async (req, res) => {
	res.json(await listDirectory(req.query.path, req.query.ext, req.query.q));
}));

api.get("/fs/inspect", asyncRoute(async (req, res) => {
	// Stop the inspection (folder scans can be long) when the client goes away before the answer.
	const abort = new AbortController();
	res.on("close", () => {
		if (!res.writableFinished) {
			res.locals.clientGone = true;
			abort.abort();
		}
	});
	res.json(await inspectPath(req.query.path, req.query.kind, { coordinatesFile: req.query.coordinatesFile, signal: abort.signal }));
}));

api.get("/crs", asyncRoute(async (req, res) => {
	res.json(await getCrsList());
}));

api.use((req, res) => {
	res.status(404).json({ error: `unknown API endpoint: ${req.method} ${req.originalUrl}` });
});

// Errors → {error, details?}.
api.use((err, req, res, next) => {
	if (res.locals.clientGone) {
		return; // nobody to answer (the work was aborted because the client disconnected)
	}
	if (res.headersSent) {
		next(err);
		return;
	}
	if (err.type === "entity.parse.failed") {
		res.status(400).json({ error: `invalid JSON body: ${err.message}` });
		return;
	}
	if (err.type === "entity.too.large") {
		res.status(413).json({ error: "request body too large" });
		return;
	}
	const status = err instanceof HttpError ? err.status : 500;
	if (status >= 500) {
		console.error(`[api] ${req.method} ${req.originalUrl}:`, err);
	}
	res.status(status).json(err.details === undefined ? { error: err.message } : { error: err.message, details: err.details });
});

const app = express();
app.disable("x-powered-by");
app.use("/api", api);
if (!config.previewBaseUrl) {
	// Static POTREE_ROOT for the preview renderer (and local use); dot folders such as .jobs are denied.
	app.get("/", (req, res) => res.redirect(`${config.projectsUrlPath}/`));
	app.use(staticRootMiddleware());
}

// --- Startup --------------------------------------------------------------------------------------
// 1. Take the single-instance lock of PROJECTS_DIR: a second instance must not touch the jobs or the
//    staging folders of the running one. 2. Bind the port. 3. Only then recover the jobs that were
//    interrupted by the last stop (marks them failed and removes their staging folders).

function listen(port, host) {
	return new Promise((resolve, reject) => {
		const s = app.listen(port, host);
		s.once("error", reject);
		s.once("listening", () => {
			s.off("error", reject);
			s.on("error", (err) => console.error(`[server] ${err.message}`));
			resolve(s);
		});
	});
}

try {
	jobs.lock();
} catch (err) {
	console.error(`[server] ${err.message}`);
	process.exit(1);
}

let server;
try {
	server = await listen(config.port, config.host);
} catch (err) {
	console.error(`[server] cannot listen on ${config.host}:${config.port}: ${err.message}`);
	process.exit(1); // the lock is released by the exit handler
}

try {
	await jobs.init();
} catch (err) {
	console.error(`[server] cannot load the job state in ${config.jobsDir}:`, err);
	process.exit(1);
}
ready = true;
console.log(`[server] Potree project service ${VERSION} on http://${config.host}:${config.port} (projects: ${config.projectsDir})`);
console.log(`[server] previews rendered from ${previewBaseUrl}${config.previewBaseUrl ? "" : " (served by this process)"}`);
if (config.apiToken === null) {
	console.warn("[server] API_TOKEN is not set: creating and editing projects, the file browser and the jobs API are disabled");
}
console.log(`[server] import modes: ${config.importModes.join(", ")}${config.moveRoots.length ? ` (move below ${config.moveRoots.join(", ")})` : ""}`);

let shuttingDown = false;
async function shutdown(signal) {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	console.log(`[server] ${signal}: shutting down`);
	killConverters();
	server.close();
	server.closeAllConnections?.();
	await renderer?.close().catch(() => {});
	await jobs.close().catch(() => {});
	process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => shutdown(signal));
}
