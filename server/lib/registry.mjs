// Project discovery, per-project statistics and the projects/registry.json summary (SPEC §7).

import fs from "node:fs/promises";
import path from "node:path";
import { MAX_COORDINATES_BYTES, config } from "./config.mjs";
import { HttpError, createMutex, formatBytes, isInside, isSafeRelativePath, isValidId, nowIso, readJson, statOrNull, writeJsonAtomic } from "./util.mjs";

const REMOTE_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function isRemoteUrl(url) {
	return typeof url === "string" && REMOTE_URL_RE.test(url);
}

export function projectDir(id) {
	return path.join(config.projectsDir, id);
}

/** Ids of all project folders (non-dot folders that contain a project.json), sorted. */
export async function listProjectIds() {
	const ids = [];
	for (const entry of await fs.readdir(config.projectsDir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || !entry.isDirectory()) {
			continue;
		}
		if (await statOrNull(path.join(config.projectsDir, entry.name, "project.json"))) {
			ids.push(entry.name);
		}
	}
	return ids.sort();
}

/** Parsed project.json of a project; 400 for a malformed id, 404 when it does not exist. */
export async function readProject(id) {
	if (!isValidId(id)) {
		throw new HttpError(400, `invalid project id: ${id}`);
	}
	const file = path.join(projectDir(id), "project.json");
	try {
		return await readJson(file);
	} catch (err) {
		if (err.code === "ENOENT") {
			throw new HttpError(404, `project not found: ${id}`);
		}
		if (err instanceof SyntaxError) {
			throw new HttpError(500, `project.json of ${id} is not valid JSON: ${err.message}`);
		}
		throw err;
	}
}

export async function writeProject(id, project) {
	await writeJsonAtomic(path.join(projectDir(id), "project.json"), project);
}

/**
 * Resolve a URL relative to the project folder `dir` to a file path, as a browser would (so "../x"
 * works), but only inside POTREE_ROOT. Null for remote, absolute or escaping URLs.
 */
export function resolveProjectUrl(dir, url) {
	if (typeof url !== "string" || url === "" || isRemoteUrl(url) || url.startsWith("/")) {
		return null;
	}
	const file = path.resolve(dir, url.split(/[?#]/)[0]);
	return isInside(file, config.potreeRoot) ? file : null;
}

/** Data rows of a 360° coordinates file (header line and blank lines excluded). */
async function countCoordinateRows(file) {
	const st = await fs.stat(file);
	if (st.size > MAX_COORDINATES_BYTES) {
		throw new Error(`${path.basename(file)} is too large to count (${formatBytes(st.size)}, at most ${formatBytes(MAX_COORDINATES_BYTES)})`);
	}
	const text = await fs.readFile(file, "utf8");
	let rows = 0;
	const lines = text.split(/\r?\n/);
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() !== "") {
			rows++;
		}
	}
	return rows;
}

/** Number of layers listed in a lazy vector manifest ({files:[{layers:[...]}]}). */
async function countManifestLayers(file) {
	const manifest = await readJson(file);
	return (manifest.files ?? []).reduce((sum, f) => sum + (Array.isArray(f.layers) ? f.layers.length : 1), 0);
}

/** Registry statistics of one project; values that cannot be determined are null. */
export async function computeStats(dir, project, warn = () => {}) {
	const pointclouds = Array.isArray(project.pointclouds) ? project.pointclouds : [];
	// A cloud hidden by default ("visible": false) is an alternative view of the same
	// points (e.g. a prediction next to the ground truth): it does not add to the count.
	const counted = pointclouds.filter((pc) => pc?.visible !== false);
	let points = 0;
	let pointsKnown = counted.length > 0;
	for (const pc of counted) {
		const file = resolveProjectUrl(dir, pc.url);
		try {
			if (!file) {
				throw new Error(`remote or invalid url ${pc.url}`);
			}
			const metadata = await readJson(file);
			points += Number(metadata.points) || 0;
		} catch (err) {
			pointsKnown = false;
			warn(`points of ${pc.name ?? pc.url} unknown: ${err.message}`);
		}
	}

	let images360 = null;
	const i360 = project.images360;
	if (i360?.url) {
		const base = resolveProjectUrl(dir, i360.url);
		const coordinatesFile = i360.coordinatesFile || "coordinates.txt";
		if (base && isSafeRelativePath(coordinatesFile)) {
			try {
				images360 = await countCoordinateRows(path.join(base, coordinatesFile));
			} catch (err) {
				warn(`360° coordinates not readable: ${err.message}`);
			}
		}
	}

	let vectors = 0;
	for (const vector of Array.isArray(project.vectors) ? project.vectors : []) {
		const manifest = vector.manifest ? resolveProjectUrl(dir, vector.manifest) : null;
		if (manifest) {
			try {
				vectors += await countManifestLayers(manifest);
				continue;
			} catch (err) {
				warn(`vector manifest ${vector.manifest} not readable: ${err.message}`);
			}
		}
		vectors += 1;
	}

	return {
		points: pointsKnown ? points : null,
		pointclouds: pointclouds.length,
		images360,
		labelSets: (i360?.labelSets ?? []).map((set) => set.name ?? set.id),
		vectors,
		meshes: Array.isArray(project.meshes) ? project.meshes.length : 0,
	};
}

/** Registry entry of one project (SPEC §7). */
export async function registryEntry(id, project, warn) {
	const dir = projectDir(id);
	const entry = project.entry || "index.html";
	const previewName = project.preview || "preview.jpg";
	const previewStat = isSafeRelativePath(previewName) ? await statOrNull(path.join(dir, previewName)) : null;
	return {
		id,
		title: project.title || id,
		description: project.description ?? "",
		keywords: Array.isArray(project.keywords) ? project.keywords : [],
		location: project.location ?? null,
		date: project.date ?? null,
		source: project.source ?? null,
		url: `${id}/${entry}`,
		preview: previewStat ? `${id}/${previewName}?v=${Math.round(previewStat.mtimeMs)}` : null,
		crs: project.crs ?? null,
		custom: project.custom === true,
		updatedAt: project.updatedAt ?? null,
		notes: project.notes ?? null,
		stats: await computeStats(dir, project, warn),
	};
}

/**
 * Build the registry object from every project folder. Projects whose project.json cannot be read
 * are left out and reported in `problems`.
 */
export async function buildRegistry() {
	const projects = [];
	const problems = [];
	for (const id of await listProjectIds()) {
		try {
			const project = await readProject(id);
			if (project.id && project.id !== id) {
				problems.push({ id, level: "warning", message: `project.json id "${project.id}" differs from folder name` });
			}
			projects.push(await registryEntry(id, project, (message) => problems.push({ id, level: "warning", message })));
		} catch (err) {
			problems.push({ id, level: "error", message: err.message });
		}
	}
	projects.sort((a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id));
	return { registry: { generatedAt: nowIso(), projects }, problems };
}

const runExclusive = createMutex();

/** Rebuild and atomically write projects/registry.json. */
export function updateRegistryFile() {
	return runExclusive(async () => {
		const result = await buildRegistry();
		await writeJsonAtomic(config.registryFile, result.registry);
		return result;
	});
}
