#!/usr/bin/env node
// Command-line interface of the Potree project service (same environment variables as the server).

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./lib/config.mjs";
import { CREATE_STEPS, cleanupStaging, prepareCreate, runCreateJob, sweepStaging } from "./lib/create.mjs";
// Namespace import: isServiceRunning is optional (older jobs.mjs versions do not export it).
import * as jobsModule from "./lib/jobs.mjs";
import { writeProjectPage } from "./lib/page.mjs";
import { PreviewRenderer, startStaticServer } from "./lib/preview.mjs";
import { validateProject } from "./lib/projects.mjs";
import { listProjectIds, projectDir, readProject, updateRegistryFile } from "./lib/registry.mjs";
import { formatCount, isSafeRelativePath, statOrNull } from "./lib/util.mjs";

const USAGE = `Usage: node server/cli.mjs <command> [arguments]

Commands:
  registry                      rebuild projects/registry.json from every projects/*/project.json
  page <id> | --all             regenerate index.html of non-custom projects from server/templates/project.html
  preview <id> | --all [--force]
                                render preview.jpg headless; without --force only missing or outdated previews
  create <request.json>         create a project from a CreateRequest file (see server/README.md), in the foreground;
                                refused while the project service is running (use its API / the portal then)
  clean-staging [--dry-run]     remove projects/.staging/<id> folders left by interrupted creates (folders holding
                                moved data, or belonging to a running create, are kept and listed)
  validate [<id>]               check project.json and that every relative URL it references exists on disk
  help                          show this help

Environment: POTREE_ROOT, PROJECTS_DIR, POTREE_CONVERTER, ALLOWED_ROOTS, MOVE_ROOTS, PREVIEW_BASE_URL (see server/README.md).`;

// Exit codes 128 + signal number, as a shell reports a process stopped by that signal.
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
// How long an interrupted create may take to stop and clean up before the CLI exits anyway.
const INTERRUPT_GRACE_MS = 20000;

function fail(message) {
	console.error(`error: ${message}`);
	process.exitCode = 1;
}

/** Project ids selected by "<id>" or "--all". */
async function selectProjects(args, command) {
	const ids = args.filter((a) => !a.startsWith("--"));
	if (args.includes("--all")) {
		return listProjectIds();
	}
	if (ids.length === 0) {
		throw new Error(`${command}: give a project id or --all`);
	}
	return ids;
}

async function cmdRegistry() {
	const { registry, problems } = await updateRegistryFile();
	console.log(`wrote ${config.registryFile} (${registry.projects.length} projects)`);
	for (const p of registry.projects) {
		const s = p.stats;
		console.log(`  ${p.id.padEnd(22)} ${String(s.points === null ? "?" : formatCount(s.points)).padStart(15)} pts  ${String(s.images360 ?? "-").padStart(6)} 360  labels:[${s.labelSets.join(", ")}]  vectors:${s.vectors}  meshes:${s.meshes}  preview:${p.preview ? "yes" : "no"}${p.custom ? "  (custom)" : ""}`);
	}
	for (const p of problems) {
		console.log(`  ${p.level}: ${p.id}: ${p.message}`);
	}
}

async function cmdPage(args) {
	for (const id of await selectProjects(args, "page")) {
		try {
			const project = await readProject(id);
			if (project.custom === true) {
				console.log(`  ${id}: skipped (custom page)`);
				continue;
			}
			const file = await writeProjectPage(projectDir(id), id, project);
			console.log(`  ${id}: wrote ${file}`);
		} catch (err) {
			fail(`${id}: ${err.message}`);
		}
	}
}

/** A preview is outdated when project.json or the page changed after it was rendered. */
async function previewIsCurrent(id, project) {
	const previewName = project.preview || "preview.jpg";
	if (!isSafeRelativePath(previewName)) {
		return false;
	}
	const dir = projectDir(id);
	const preview = await statOrNull(path.join(dir, previewName));
	if (!preview) {
		return false;
	}
	for (const name of ["project.json", project.entry || "index.html"]) {
		const st = await statOrNull(path.join(dir, name));
		if (st && st.mtimeMs > preview.mtimeMs) {
			return false;
		}
	}
	return true;
}

/** Run `fn(renderer)` with one browser and, unless PREVIEW_BASE_URL is set, a temporary static server. */
async function withRenderer(fn) {
	const staticServer = config.previewBaseUrl ? null : await startStaticServer();
	const renderer = new PreviewRenderer({ baseUrl: config.previewBaseUrl ?? staticServer.baseUrl });
	try {
		return await fn(renderer);
	} finally {
		await renderer.close();
		await staticServer?.close();
	}
}

async function cmdPreview(args) {
	const force = args.includes("--force");
	const ids = await selectProjects(args, "preview");
	const todo = [];
	for (const id of ids) {
		try {
			const project = await readProject(id);
			if (!force && (await previewIsCurrent(id, project))) {
				console.log(`  ${id}: preview is up to date (use --force to re-render)`);
				continue;
			}
			todo.push({ id, project });
		} catch (err) {
			fail(`${id}: ${err.message}`);
		}
	}
	if (todo.length === 0) {
		return;
	}
	await withRenderer(async (renderer) => {
		for (const { id, project } of todo) {
			try {
				const r = await renderer.render(id, project, (line) => console.log(`  [${id}] ${line}`));
				console.log(`  ${id}: OK (${(r.ms / 1000).toFixed(1)} s, ${r.renderer})`);
			} catch (err) {
				fail(`${id}: ${err.message}`);
			}
		}
	});
	await updateRegistryFile();
	console.log(`registry updated: ${config.registryFile}`);
}

/**
 * Refuse to work on staging folders while the project service runs on the same PROJECTS_DIR: its
 * jobs own them (and a create here would bypass its queue and id reservations).
 */
async function assertServiceStopped(command) {
	if (await jobsModule.isServiceRunning?.(config)) {
		const pid = jobsModule.serviceLockOwner?.(config)?.pid;
		throw new Error(`${command}: the project service${pid ? ` (pid ${pid})` : ""} is running on ${config.projectsDir}; `
			+ `${command === "create" ? "create the project through its API or the portal, or " : ""}stop the service first`);
	}
}

async function cmdCreate(args) {
	const file = args[0];
	if (!file) {
		throw new Error("create: give the path of a CreateRequest JSON file");
	}
	await assertServiceStopped("create");
	const request = JSON.parse(await fs.readFile(file, "utf8"));
	const plan = await prepareCreate(request);
	console.log(`creating project "${plan.id}" in ${projectDir(plan.id)}`);

	let lastPrinted = 0;
	const job = new jobsModule.Job({
		type: "create",
		projectId: plan.id,
		steps: CREATE_STEPS,
		onLog: (line) => console.log(line),
		onChange: () => {
			// Print the running step's progress at most every 5 s.
			const step = job.steps.find((s) => s.status === "running");
			if (step?.detail && Date.now() - lastPrinted > 5000) {
				lastPrinted = Date.now();
				console.log(`progress ${job.progress}% — ${step.key}: ${step.detail}`);
			}
		},
	});
	job.status = "running";
	let staticServer = null;
	let renderer = null;
	const getRenderer = async () => {
		if (!renderer) {
			staticServer = config.previewBaseUrl ? null : await startStaticServer();
			renderer = new PreviewRenderer({ baseUrl: config.previewBaseUrl ?? staticServer.baseUrl });
		}
		return renderer;
	};

	// Ctrl-C, a closed terminal or a kill: stop the converter and copies, let the job clean up its
	// staging folder (kept when it holds moved data), then exit. A second signal exits at once.
	const controller = new AbortController();
	let interrupted = null;
	const jobPromise = runCreateJob(job, plan, { getRenderer, signal: controller.signal });
	const onSignal = async (signal) => {
		if (interrupted) {
			console.error(`\n${signal} again: exiting now; check ${job.staging?.dir ?? "projects/.staging"} (see "clean-staging")`);
			process.exit(SIGNAL_EXIT_CODES[signal]);
		}
		interrupted = signal;
		console.error(`\n${signal}: stopping the create job and cleaning up (press Ctrl-C again to exit at once)`);
		controller.abort(new Error(`interrupted by ${signal}`));
		const settled = await Promise.race([
			jobPromise.then(() => true, () => true),
			new Promise((resolve) => setTimeout(resolve, INTERRUPT_GRACE_MS, false).unref()),
		]);
		if (!settled) {
			// A step that does not react to the abort (e.g. one huge file copy): clean up directly.
			const note = await cleanupStaging(job).catch((err) => `staging cleanup failed: ${err.message}`);
			console.error(`the job did not stop within ${INTERRUPT_GRACE_MS / 1000} s; ${note ?? "nothing is left in projects/.staging"}`);
			await renderer?.close().catch(() => {});
			process.exit(SIGNAL_EXIT_CODES[signal]);
		}
	};
	const signals = Object.keys(SIGNAL_EXIT_CODES);
	signals.forEach((signal) => process.on(signal, onSignal));
	try {
		const result = await jobPromise;
		console.log(`\ncreated ${result.dir}${result.warnings.length ? ` with ${result.warnings.length} warning(s)` : ""}`);
		for (const step of job.steps) {
			console.log(`  ${step.key.padEnd(10)} ${step.status.padEnd(9)} ${step.detail ?? ""}`);
		}
	} catch (err) {
		if (interrupted) {
			console.error(`error: ${err.message}`);
			process.exitCode = SIGNAL_EXIT_CODES[interrupted];
			return;
		}
		throw err;
	} finally {
		signals.forEach((signal) => process.off(signal, onSignal));
		await renderer?.close();
		await staticServer?.close();
	}
}

async function cmdCleanStaging(args) {
	await assertServiceStopped("clean-staging");
	const dryRun = args.includes("--dry-run");
	const report = await sweepStaging({ dryRun });
	if (report.length === 0) {
		console.log(`no staging folders in ${config.stagingDir}`);
	}
	for (const r of report) {
		console.log(`  ${r.action.padEnd(12)} ${r.dir}: ${r.reason}`);
	}
}

async function cmdValidate(args) {
	const ids = args.length > 0 ? args : await listProjectIds();
	let errorCount = 0;
	for (const id of ids) {
		const { errors, warnings } = await validateProject(id);
		errorCount += errors.length;
		console.log(`${errors.length ? "FAIL" : "ok  "} ${id}${warnings.length ? ` (${warnings.length} warning(s))` : ""}`);
		errors.forEach((e) => console.log(`       error: ${e}`));
		warnings.forEach((w) => console.log(`       warning: ${w}`));
	}
	if (errorCount > 0) {
		fail(`${errorCount} error(s)`);
	}
}

const [command, ...args] = process.argv.slice(2);
const commands = { registry: cmdRegistry, page: cmdPage, preview: cmdPreview, create: cmdCreate, "clean-staging": cmdCleanStaging, validate: cmdValidate };
try {
	if (!command || command === "help" || command === "--help" || command === "-h") {
		console.log(USAGE);
	} else if (!Object.hasOwn(commands, command)) {
		console.log(USAGE);
		fail(`unknown command: ${command}`);
	} else {
		await commands[command](args);
	}
} catch (err) {
	fail(err.details ? `${err.message} ${JSON.stringify(err.details)}` : err.message);
}
