// Project creation: request validation (POST /api/projects) and the create job pipeline.
//
// Everything is assembled in projects/.staging/<id>/ and renamed to projects/<id>/ at the end, so a
// project folder only ever appears complete. On failure the staging folder is removed, unless data
// was MOVED into it (then it is kept and its path reported, so nothing is lost). A small owner record
// (.owner.json) inside the staging folder names the job, its process and the moves, so leftovers of
// killed processes can be cleaned up safely (sweepStaging).

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import proj4 from "proj4";
import { MAX_COORDINATES_BYTES, RESERVED_IDS, config } from "./config.mjs";
import { assertValidProj4, canonicalCrsName, lookupProj4 } from "./crs.mjs";
import { converterAvailable, converterInputs, runConverter } from "./converter.mjs";
import { inspectImages360, inspectLabels, inspectPointcloudInput, inspectVector, readLasHeader } from "./browse.mjs";
import { copyPublicFile, copyTree, freeBytes, getAllowedRoots, getMoveRoots, isFollowableRealPath, localTreeSize, resolveAllowedPath, scanTree } from "./fsutil.mjs";
import { writeProjectPage } from "./page.mjs";
import { projectDir, readProject, registryEntry, updateRegistryFile } from "./registry.mjs";
import { isPlainObject, normalizeMaterial, normalizeMetadata, normalizeView, normalizeViewer, optionalString, requiredString } from "./requests.mjs";
import { HttpError, ID_RE, formatBytes, formatCount, isInside, isSafeRelativePath, isValidId, lstatOrNull, nowIso, readJson, slugify, statOrNull, writeJsonAtomic } from "./util.mjs";

export const CREATE_STEPS = [
	{ key: "validate", label: "Validate request", weight: 2 },
	{ key: "convert", label: "Convert point cloud", weight: 60 },
	{ key: "images360", label: "Import 360° images", weight: 8 },
	{ key: "labels", label: "Import label sets", weight: 6 },
	{ key: "vectors", label: "Import vector layers", weight: 2 },
	{ key: "project", label: "Write project.json", weight: 1 },
	{ key: "page", label: "Generate page", weight: 1 },
	{ key: "finalize", label: "Finalize project folder", weight: 1 },
	{ key: "preview", label: "Render preview", weight: 12 },
	{ key: "registry", label: "Update registry", weight: 2 },
];

export const PREVIEW_STEPS = [
	{ key: "preview", label: "Render preview", weight: 9 },
	{ key: "registry", label: "Update registry", weight: 1 },
];

const IMPORT_MODES = ["copy", "symlink", "move"];
const ENCODINGS = ["DEFAULT", "BROTLI"];
const METHODS = ["poisson", "poisson_average", "random"];
const CREATE_REQUEST_KEYS = new Set(["id", "title", "description", "keywords", "location", "date", "source", "notes", "pointcloud", "conversion", "images360", "labelSets", "vectors", "importMode", "viewer", "material", "view", "previewView", "renderPreview"]);
const CRS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
const LABEL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Potree material attributes that are not stored in the point cloud itself.
const VIRTUAL_ATTRIBUTES = new Set(["rgba", "elevation", "color", "level of detail", "indices", "composite"]);
const MOVE_DISABLED = "move import is disabled on this server (set MOVE_ROOTS)";
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Build output folders: the converter binary inside one of them makes its parent (the checkout) protected too.
const BUILD_DIR_RE = /^(build.*|bin|out|release|debug)$/i;
// Owner record of a staging folder: {jobId, projectId, pid, createdAt, moved: [{from, to}]}.
const OWNER_FILE = ".owner.json";

/** Whether a project id is in use (project folder, staging folder or a queued/running create job). */
async function isIdTaken(id, reservedIds) {
	return reservedIds.has(id)
		|| RESERVED_IDS.has(id)
		|| (await lstatOrNull(projectDir(id))) !== null
		|| (await lstatOrNull(path.join(config.stagingDir, id))) !== null;
}

/** Why an id is taken; points at a leftover staging folder (interrupted create) and how to clear it. */
async function idConflictMessage(id, reservedIds) {
	const staging = path.join(config.stagingDir, id);
	if (reservedIds.has(id) || (await lstatOrNull(projectDir(id))) || !(await lstatOrNull(staging))) {
		return `a project with id "${id}" already exists or is being created`;
	}
	return `id "${id}" is blocked by the staging folder ${staging} of an unfinished or interrupted create; `
		+ `when no create of "${id}" is running, "node server/cli.mjs clean-staging" removes it (folders holding moved data are kept)`;
}

async function chooseProjectId(requestedId, title, reservedIds) {
	if (requestedId !== undefined && requestedId !== null && requestedId !== "") {
		if (!isValidId(requestedId)) {
			throw new HttpError(400, `id must match ${ID_RE} (lower-case letters, digits and "-", 2–63 characters)`);
		}
		if (RESERVED_IDS.has(requestedId)) {
			throw new HttpError(400, `id "${requestedId}" is reserved`);
		}
		if (await isIdTaken(requestedId, reservedIds)) {
			throw new HttpError(409, await idConflictMessage(requestedId, reservedIds));
		}
		return requestedId;
	}
	let base = slugify(title);
	if (!isValidId(base) || RESERVED_IDS.has(base)) {
		base = "project";
	}
	for (let n = 1; n < 1000; n++) {
		const suffix = n === 1 ? "" : `-${n}`;
		const candidate = base.slice(0, 63 - suffix.length).replace(/-+$/, "") + suffix;
		if (!(await isIdTaken(candidate, reservedIds))) {
			return candidate;
		}
	}
	throw new HttpError(409, `no free project id derived from "${base}"; please provide one`);
}

/** Point-cloud CRS: a known name, a custom proj4 definition (named, default "CUSTOM"), "local" or none. */
async function resolvePointcloudCrs(pc, warnings) {
	let crs = pc.crs || null;
	if (crs !== null && (typeof crs !== "string" || !CRS_NAME_RE.test(crs.trim()))) {
		throw new HttpError(400, "pointcloud.crs must be a CRS name such as \"EPSG:2056\"");
	}
	crs &&= canonicalCrsName(crs);
	if (pc.proj4 !== undefined && pc.proj4 !== null && pc.proj4 !== "") {
		const def = assertValidProj4(pc.proj4, "pointcloud.proj4");
		crs ??= "CUSTOM";
		return { crs, crsDefs: { [crs]: def }, projection: def };
	}
	if (crs === null) {
		warnings.push("no CRS given: the map view and coordinate transforms of layers are disabled");
		return { crs: null, crsDefs: null, projection: null };
	}
	if (crs === "local") {
		return { crs, crsDefs: null, projection: null };
	}
	const def = await lookupProj4(crs);
	if (!def) {
		throw new HttpError(400, `unknown CRS "${crs}": choose one from GET /api/crs or provide pointcloud.proj4`);
	}
	return { crs, crsDefs: null, projection: assertValidProj4(def, `proj4 definition of ${crs}`) };
}

/** CRS name of a layer (360° images, vectors): null = same as the point cloud. */
async function resolveLayerCrs(value, label, projectCrs, crsDefs, warnings) {
	if (value === undefined || value === null || value === "") {
		return null;
	}
	if (typeof value !== "string" || !CRS_NAME_RE.test(value.trim())) {
		throw new HttpError(400, `${label} must be a CRS name or null`);
	}
	const name = canonicalCrsName(value);
	if (name === projectCrs) {
		return name;
	}
	if (!(await lookupProj4(name, crsDefs ?? {}))) {
		throw new HttpError(400, `${label}: unknown CRS "${name}"`);
	}
	if (!projectCrs || projectCrs === "local") {
		warnings.push(`${label} is ${name} but the point cloud has no CRS: the layer will not be reprojected`);
	}
	return name;
}

/**
 * A user-supplied import source: `input` is the absolute path as given (normalised, links not
 * resolved), `real` its real path inside ALLOWED_ROOTS. The move policy needs both.
 */
async function resolveSource(input, label) {
	const real = await resolveAllowedPath(input, label);
	return { label, input: path.resolve(input), real };
}

async function requireDirectory(input, label) {
	const source = await resolveSource(input, label);
	if (!(await fs.stat(source.real)).isDirectory()) {
		throw new HttpError(400, `${label} must be a folder: ${input}`);
	}
	return source;
}

/**
 * The coordinates file of a 360° folder: a regular text file of at most MAX_COORDINATES_BYTES whose
 * real path stays inside ALLOWED_ROOTS (a link leaving them is reported as "not found").
 */
async function checkCoordinatesFile(dir, coordinatesFile) {
	const real = await fs.realpath(path.join(dir, coordinatesFile)).catch(() => null);
	const st = real && (await isFollowableRealPath(real)) ? await statOrNull(real) : null;
	if (!st?.isFile()) {
		throw new HttpError(400, `images360: ${coordinatesFile} not found in ${dir}`);
	}
	if (st.size > MAX_COORDINATES_BYTES) {
		throw new HttpError(400, `images360.coordinatesFile is too large (${formatBytes(st.size)}, at most ${formatBytes(MAX_COORDINATES_BYTES)}); expected the tab-separated coordinates text file`);
	}
}

/**
 * Real paths of the LAS/LAZ files the converter will read (exactly the files that were inspected):
 * links must stay inside ALLOWED_ROOTS, and a file reached through several links is converted once.
 */
async function pointcloudFiles(files, warnings) {
	const reals = [];
	const seen = new Set();
	for (const file of files) {
		const real = await fs.realpath(file).catch(() => null);
		if (!real) {
			throw new HttpError(400, `pointcloud.path: ${path.basename(file)} cannot be read (broken link?)`);
		}
		if (!(await isFollowableRealPath(real))) {
			throw new HttpError(400, `pointcloud.path: ${path.basename(file)} links to a location outside the allowed roots`);
		}
		if (seen.has(real)) {
			warnings.push(`${path.basename(file)} is another link to ${real}; that file is converted once`);
			continue;
		}
		seen.add(real);
		reals.push(real);
	}
	return reals;
}

/** A unique file name inside vectors/ (case-insensitive), e.g. a.gpkg, a-2.gpkg. */
function uniqueFileName(name, used) {
	const ext = path.extname(name);
	const stem = name.slice(0, name.length - ext.length);
	let candidate = name;
	for (let n = 2; used.has(candidate.toLowerCase()); n++) {
		candidate = `${stem}-${n}${ext}`;
	}
	used.add(candidate.toLowerCase());
	return candidate;
}

/**
 * Validate a CreateRequest (SPEC §5) and turn it into a plan for the create job.
 * Fast checks only (paths, CRS, ids, LAS headers); deeper data checks run in the job's validate step.
 * `reservedIds` are ids of projects already queued for creation.
 */
export async function prepareCreate(body, { reservedIds = new Set() } = {}) {
	if (!isPlainObject(body)) {
		throw new HttpError(400, "request body must be a JSON object");
	}
	if (!converterAvailable(config.converter)) {
		throw new HttpError(503, `PotreeConverter is not available at ${config.converter}`);
	}
	const warnings = [];
	const metadata = normalizeMetadata(body);
	const notes = optionalString(body.notes, "notes", 10000);
	const id = await chooseProjectId(body.id, metadata.title, reservedIds);

	// Point cloud input and CRS.
	const pc = body.pointcloud;
	if (!isPlainObject(pc) || pc.path === undefined || pc.path === null || pc.path === "") {
		throw new HttpError(400, "pointcloud.path is required");
	}
	const pcPath = await resolveAllowedPath(pc.path, "pointcloud.path");
	const pcInfo = await inspectPointcloudInput(pcPath, await fs.stat(pcPath));
	if (!pcInfo.ok) {
		throw new HttpError(400, `pointcloud.path is not usable: ${pcInfo.warnings.join("; ")}`, { path: pcPath });
	}
	const pcFiles = await pointcloudFiles(pcInfo.files, warnings);
	const { crs, crsDefs, projection } = await resolvePointcloudCrs(pc, warnings);

	const conversion = isPlainObject(body.conversion) ? body.conversion : {};
	const encoding = conversion.encoding ?? "DEFAULT";
	const method = conversion.method ?? "poisson";
	if (!ENCODINGS.includes(encoding)) {
		throw new HttpError(400, `conversion.encoding must be one of ${ENCODINGS.join(", ")}`);
	}
	if (!METHODS.includes(method)) {
		throw new HttpError(400, `conversion.method must be one of ${METHODS.join(", ")}`);
	}

	const importMode = body.importMode ?? "copy";
	if (!IMPORT_MODES.includes(importMode)) {
		throw new HttpError(400, `importMode must be one of ${IMPORT_MODES.join(", ")}`);
	}
	if (importMode === "move" && (await getMoveRoots()).length === 0) {
		throw new HttpError(400, MOVE_DISABLED);
	}

	// 360° images and label sets.
	let images360 = null;
	if (body.images360 !== undefined && body.images360 !== null) {
		if (!isPlainObject(body.images360)) {
			throw new HttpError(400, "images360 must be an object or null");
		}
		const { input, real } = await requireDirectory(body.images360.path, "images360.path");
		const coordinatesFile = body.images360.coordinatesFile || "coordinates.txt";
		if (!isSafeRelativePath(coordinatesFile)) {
			throw new HttpError(400, "images360.coordinatesFile must be a relative file name");
		}
		await checkCoordinatesFile(real, coordinatesFile);
		images360 = { source: real, input, coordinatesFile, crs: await resolveLayerCrs(body.images360.crs, "images360.crs", crs, crsDefs, warnings) };
	}

	const labelSetsIn = body.labelSets ?? [];
	if (!Array.isArray(labelSetsIn) || labelSetsIn.length > 20) {
		throw new HttpError(400, "labelSets must be an array (at most 20)");
	}
	if (labelSetsIn.length > 0 && !images360) {
		throw new HttpError(400, "labelSets require images360");
	}
	const labelSets = [];
	const labelIds = new Set();
	for (const [i, set] of labelSetsIn.entries()) {
		if (!isPlainObject(set)) {
			throw new HttpError(400, `labelSets[${i}] must be an object`);
		}
		const name = requiredString(set.name, `labelSets[${i}].name`, 100);
		let setId;
		if (set.id) {
			setId = String(set.id);
			if (!LABEL_ID_RE.test(setId) || labelIds.has(setId)) {
				throw new HttpError(400, `labelSets[${i}].id must be a unique slug (a-z, 0-9, "-", "_")`);
			}
		} else {
			const base = slugify(name, 40) || `labels-${i + 1}`;
			setId = base;
			for (let n = 2; labelIds.has(setId); n++) {
				setId = `${base}-${n}`;
			}
		}
		labelIds.add(setId);
		const { input, real } = await requireDirectory(set.path, `labelSets[${i}].path`);
		labelSets.push({ id: setId, name, source: real, input });
	}

	// Vector layers (GeoPackage files).
	const vectorsIn = body.vectors ?? [];
	if (!Array.isArray(vectorsIn) || vectorsIn.length > 100) {
		throw new HttpError(400, "vectors must be an array (at most 100)");
	}
	const vectors = [];
	const usedNames = new Set();
	for (const [i, v] of vectorsIn.entries()) {
		if (!isPlainObject(v)) {
			throw new HttpError(400, `vectors[${i}] must be an object`);
		}
		const { input, real: source } = await resolveSource(v.path, `vectors[${i}].path`);
		if (!(await fs.stat(source)).isFile() || path.extname(source).toLowerCase() !== ".gpkg") {
			throw new HttpError(400, `vectors[${i}].path must be a .gpkg file: ${v.path}`);
		}
		const fileName = uniqueFileName(path.basename(source), usedNames);
		vectors.push({
			source,
			input,
			fileName,
			name: optionalString(v.name, `vectors[${i}].name`, 200) ?? path.basename(source, path.extname(source)),
			crs: await resolveLayerCrs(v.crs, `vectors[${i}].crs`, crs, crsDefs, warnings),
			visible: v.visible === undefined ? true : v.visible === true,
		});
	}

	await checkImportSources(importMode, importSources({ images360, labelSets, vectors }), warnings);

	for (const key of Object.keys(body)) {
		if (!CREATE_REQUEST_KEYS.has(key)) {
			warnings.push(`ignored unknown request field "${key}"`);
		}
	}

	return {
		id,
		...metadata,
		notes,
		pointcloud: { path: pcPath, files: pcFiles, crs, crsDefs, projection, summary: pcInfo.summary },
		conversion: { encoding, method },
		images360,
		labelSets,
		vectors,
		importMode,
		viewer: normalizeViewer(body.viewer),
		material: normalizeMaterial(body.material),
		view: normalizeView(body.view),
		previewView: normalizeView(body.previewView, "previewView"),
		renderPreview: body.renderPreview !== false,
		warnings,
	};
}

/** The import sources of a plan (images360, label sets, vectors) as {label, input, real}. */
function importSources({ images360, labelSets, vectors }) {
	return [
		...(images360 ? [{ label: "images360.path", input: images360.input, real: images360.source }] : []),
		...labelSets.map((set, i) => ({ label: `labelSets[${i}].path`, input: set.input, real: set.source })),
		...vectors.map((v, i) => ({ label: `vectors[${i}].path`, input: v.input, real: v.source })),
	];
}

/** Guard rails for imported sources, especially for "move" (which must never damage other data). */
async function checkImportSources(importMode, sources, warnings) {
	const projectsReal = await fs.realpath(config.projectsDir);
	for (const { real } of sources) {
		if (isInside(projectsReal, real)) {
			throw new HttpError(400, `${real} contains the projects folder and cannot be imported`);
		}
	}
	if (importMode === "move") {
		await checkMoveSources(sources);
	}
	for (const a of sources) {
		for (const b of sources) {
			if (a.real === b.real || !isInside(a.real, b.real)) {
				continue;
			}
			if (importMode === "move") {
				throw new HttpError(400, `import sources overlap: ${a.real} is inside ${b.real}; they cannot both be moved`);
			}
			if (importMode === "copy") {
				warnings.push(`${a.real} is inside ${b.real}: its files will be copied twice`);
			}
		}
	}
}

/**
 * Folders a move must never take away or take from: the Potree site (libs, build, examples, server,
 * projects ...), the projects folder, the project service and the PotreeConverter installation.
 * Each as given and as real path: [{dir, what}].
 */
async function protectedFolders() {
	const converterDirs = [path.dirname(path.resolve(config.converter))];
	const converterReal = await fs.realpath(config.converter).catch(() => null);
	if (converterReal) {
		converterDirs.push(path.dirname(converterReal));
	}
	const list = [
		[config.potreeRoot, "the Potree web root"],
		[config.projectsDir, "the projects folder"],
		[SERVER_DIR, "the project service"],
		...converterDirs.flatMap((dir) => (BUILD_DIR_RE.test(path.basename(dir)) ? [dir, path.dirname(dir)] : [dir]))
			.map((dir) => [dir, "the PotreeConverter installation"]),
	];
	const folders = [];
	for (const [dir, what] of list) {
		folders.push({ dir: path.resolve(dir), what });
		const real = await fs.realpath(dir).catch(() => null);
		if (real) {
			folders.push({ dir: real, what });
		}
	}
	return folders;
}

/**
 * Real targets of the symlinks that existing projects (and projects being created) use for their
 * data: pointcloud, images360, labels/<set> and vectors/<file> of every folder in projects/ and in
 * projects/.staging/. Returns [{target, owner}].
 */
async function projectLinkTargets() {
	const containers = [];
	for (const base of [config.projectsDir, config.stagingDir]) {
		const dirents = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
		for (const d of dirents) {
			if (d.isDirectory() && !d.name.startsWith(".")) {
				containers.push({ owner: base === config.stagingDir ? `${d.name} (being created)` : d.name, dir: path.join(base, d.name) });
			}
		}
	}
	const targets = [];
	for (const { owner, dir } of containers) {
		const entries = [path.join(dir, "pointcloud"), path.join(dir, "images360")];
		for (const sub of ["labels", "vectors"]) {
			const names = await fs.readdir(path.join(dir, sub)).catch(() => []);
			entries.push(...names.map((name) => path.join(dir, sub, name)));
		}
		for (const entry of entries) {
			const st = await fs.lstat(entry).catch(() => null);
			const target = st?.isSymbolicLink() ? await fs.realpath(entry).catch(() => null) : null;
			if (target) {
				targets.push({ target, owner });
			}
		}
	}
	return targets;
}

/**
 * Move policy (moves relocate user data, so they are opt-in and narrow). A source is refused unless
 * MOVE_ROOTS is configured and the source
 * - is not reached through a symlink (its normalised path equals its real path),
 * - lies strictly inside one of MOVE_ROOTS (a root itself is refused) and is not an ALLOWED_ROOT,
 * - is neither inside nor above the Potree site, the projects folder, the service or the converter,
 * - is neither inside nor above data that an existing project links to (it would break that project),
 * - is listed once, sits on the projects filesystem and its parent folder is writable.
 */
async function checkMoveSources(sources) {
	const moveRoots = await getMoveRoots();
	if (moveRoots.length === 0) {
		throw new HttpError(400, MOVE_DISABLED);
	}
	const allowedRoots = await getAllowedRoots();
	const protectedDirs = await protectedFolders();
	const linkTargets = await projectLinkTargets();
	const projectsStat = await fs.stat(config.projectsDir);
	const seen = new Set();
	for (const { label, input, real } of sources) {
		const refuse = (reason) => new HttpError(400, `refusing to move ${label} ${input}: ${reason}; use importMode "copy" or "symlink"`);
		if (seen.has(real)) {
			throw new HttpError(400, `${real} is listed twice; it can only be moved once`);
		}
		seen.add(real);
		if (input !== real) {
			throw refuse(`it is reached through a symbolic link (real path ${real})`);
		}
		if (!moveRoots.some((root) => real !== root && isInside(real, root))) {
			throw refuse(`moves are only allowed from inside ${moveRoots.join(", ")} (MOVE_ROOTS)`);
		}
		if (allowedRoots.includes(real)) {
			throw refuse("it is an allowed root folder");
		}
		for (const { dir, what } of protectedDirs) {
			if (isInside(real, dir) || isInside(dir, real)) {
				throw refuse(`it is inside or contains ${what} (${dir})`);
			}
		}
		for (const { target, owner } of linkTargets) {
			if (isInside(real, target) || isInside(target, real)) {
				throw refuse(`project "${owner}" links to ${target}`);
			}
		}
		if ((await fs.stat(real)).dev !== projectsStat.dev) {
			throw refuse(`it is on another filesystem than ${config.projectsDir}`);
		}
		try {
			await fs.access(path.dirname(real), fsConstants.W_OK);
		} catch {
			throw refuse("its parent folder is not writable");
		}
	}
}

/**
 * At job start (possibly long after the request): every import source must still resolve to the
 * real path that was validated (no link swapped meanwhile) and the move policy is applied again
 * (a project created in between may link to a source).
 */
async function recheckImportSources(plan) {
	const sources = importSources(plan);
	for (const { label, input, real } of sources) {
		const now = await resolveAllowedPath(input, label);
		if (now !== real) {
			throw new Error(`${label} changed since the request was accepted: ${input} now resolves to ${now} instead of ${real}`);
		}
	}
	await checkImportSources(plan.importMode, sources, []);
}

/**
 * Whether the web server's user (an "other" user) can read `p`: read (+ traverse for folders) on
 * `p` itself and, with `ancestors`, traverse permission on every folder above it.
 */
async function readableByOthers(p, { ancestors }) {
	const st = await fs.stat(p);
	const need = st.isDirectory() ? 0o005 : 0o004;
	if ((st.mode & need) !== need) {
		return false;
	}
	for (let dir = path.dirname(p); ancestors; dir = path.dirname(dir)) {
		if (((await fs.stat(dir)).mode & 0o001) === 0) {
			return false;
		}
		if (dir === path.dirname(dir)) {
			break;
		}
	}
	return true;
}

/** The plan as stored with the job (no internal lists). */
export function describePlan(plan) {
	const { summary, files, ...pointcloud } = plan.pointcloud;
	return { ...plan, pointcloud: { ...pointcloud, files: summary.files, points: summary.points } };
}

/** Remove a staging folder created by this service (symlinks inside are removed, not followed). */
export async function removeStagingDir(dir) {
	if (path.dirname(dir) !== config.stagingDir || !isValidId(path.basename(dir))) {
		throw new Error(`refusing to remove ${dir}: not a staging folder`);
	}
	await fs.rm(dir, { recursive: true, force: true });
}

/** Write the owner record of the job's staging folder (job, process, moves; see sweepStaging). */
async function writeOwnerRecord(job) {
	const { dir, moved } = job.staging;
	await writeJsonAtomic(path.join(dir, OWNER_FILE), { jobId: job.id, projectId: job.projectId, pid: process.pid, createdAt: job.createdAt, moved });
}

/** Save the staging bookkeeping (job state and owner record) before an irreversible action. */
async function persistStaging(job) {
	await job.persist();
	await writeOwnerRecord(job);
}

/** After a failure (or an interrupted run): drop the staging folder unless data was moved into it. */
export async function cleanupStaging(job) {
	const staging = job.staging;
	if (!staging?.created || !(await lstatOrNull(staging.dir))) {
		return null;
	}
	if (staging.moved.length > 0) {
		const moved = staging.moved.map((m) => `${m.from} → ${m.to}`).join(", ");
		job.log(`staging folder kept because it contains moved data: ${moved}`);
		return `staging folder kept at ${staging.dir} because it contains moved data (${moved}); move it back or finish the project manually`;
	}
	await removeStagingDir(staging.dir);
	job.log(`removed staging folder ${staging.dir}`);
	return null;
}

function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	if (pid === process.pid) {
		return true;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}

/**
 * Remove staging folders left behind by creates whose process is gone (e.g. a CLI create killed with
 * SIGKILL, or a power loss). Only folders whose owner record lists no moved data are removed; folders
 * of `activeIds` (queued or running jobs), of a live process, without an owner record or holding
 * moved data are kept and reported. With `dryRun` nothing is removed.
 * Returns [{id, dir, action: "removed" | "would remove" | "kept", reason}].
 */
export async function sweepStaging({ activeIds = new Set(), dryRun = false } = {}) {
	const report = [];
	const dirents = await fs.readdir(config.stagingDir, { withFileTypes: true }).catch(() => []);
	for (const d of dirents) {
		if (!d.isDirectory() || !isValidId(d.name)) {
			continue;
		}
		const dir = path.join(config.stagingDir, d.name);
		const keep = (reason) => report.push({ id: d.name, dir, action: "kept", reason });
		if (activeIds.has(d.name)) {
			keep("a create job for this id is queued or running");
			continue;
		}
		const owner = await readJson(path.join(dir, OWNER_FILE)).catch(() => null);
		if (!isPlainObject(owner) || !Array.isArray(owner.moved)) {
			keep(`it has no readable ${OWNER_FILE} (created by an older version, or interrupted while starting); check it and remove it by hand`);
			continue;
		}
		if (owner.moved.length > 0) {
			keep(`it holds moved data (${owner.moved.map((m) => `${m.from} → ${m.to}`).join(", ")}); move it back or finish the project by hand`);
			continue;
		}
		if (isProcessAlive(owner.pid)) {
			keep(`its create process (pid ${owner.pid}) is still running`);
			continue;
		}
		if (!dryRun) {
			await removeStagingDir(dir);
		}
		report.push({ id: d.name, dir, action: dryRun ? "would remove" : "removed", reason: `left over by job ${owner.jobId} (process ${owner.pid} has ended)` });
	}
	return report;
}

function boxesOverlap(a, b, margin) {
	return [0, 1].every((k) => a.min[k] <= b.max[k] + margin && a.max[k] >= b.min[k] - margin);
}

const fmtXYZ = (v) => v.map((x) => x.toFixed(2)).join(", ");

/** Job step "validate": deep data checks, disk space, reservation of the staging folder. */
async function validateStep(job, plan, ctx, signal) {
	const pcs = plan.pointcloud.summary;
	job.log(`point cloud input: ${plan.pointcloud.path} — ${pcs.text}`);
	if (pcs.bbox) {
		job.log(`point cloud bbox: [${fmtXYZ(pcs.bbox.min)}] – [${fmtXYZ(pcs.bbox.max)}]`);
	}
	job.log(`CRS: ${plan.pointcloud.crs ?? "none"}${plan.pointcloud.projection ? ` (${plan.pointcloud.projection})` : ""}`);
	await recheckImportSources(plan);
	if (plan.importMode !== "copy") {
		// Moved and linked data keep their own permissions (copies are made world-readable).
		for (const { label, real } of importSources(plan)) {
			if (!(await readableByOthers(real, { ancestors: plan.importMode === "symlink" }))) {
				job.warn(`${label}: ${real} is not readable by other users, so nginx (www-data) cannot serve it after a ${plan.importMode} import; fix its permissions (e.g. chmod -R o+rX)`);
			}
		}
	}
	let copyBytes = 0;

	if (plan.images360) {
		const { source, coordinatesFile } = plan.images360;
		const r = await inspectImages360(source, coordinatesFile);
		r.warnings.forEach((w) => job.warn(`360° images: ${w}`));
		if (!r.ok) {
			throw new Error(`360° images are not usable: ${r.warnings.join("; ")}`);
		}
		const s = r.summary;
		ctx.images360Rows = s.rows;
		ctx.imageFiles = s.files;
		job.log(`360° images: ${formatCount(s.rows)} rows in ${coordinatesFile}, ${formatCount(s.imagesInFolder)} images in folder, ${formatCount(s.checked)} rows checked${s.sampled ? " (sample)" : ""}, ${formatCount(s.missingImages)} missing`);
		const sameCrs = plan.images360.crs === null || plan.images360.crs === plan.pointcloud.crs;
		if (sameCrs && s.bbox && pcs.bbox && !boxesOverlap(s.bbox, pcs.bbox, 200)) {
			job.warn(`360° image positions ([${fmtXYZ(s.bbox.min)}] – [${fmtXYZ(s.bbox.max)}]) do not overlap the point cloud; check the coordinates and their CRS`);
		}
		if (plan.importMode === "copy") {
			copyBytes += (await scanTree(source, { signal, keepFiles: false })).bytes;
		}
	}
	for (const set of plan.labelSets) {
		signal?.throwIfAborted();
		const r = await inspectLabels(set.source, ctx.imageFiles, { signal });
		r.warnings.forEach((w) => job.warn(`label set "${set.name}": ${w}`));
		if (!r.ok) {
			throw new Error(`label set "${set.name}" is not usable: ${r.warnings.join("; ")}`);
		}
		job.log(`label set "${set.name}" (${set.id}): ${formatCount(r.summary.imageFiles)} images, ${formatBytes(r.summary.bytes)}`);
		copyBytes += plan.importMode === "copy" ? r.summary.bytes : 0;
	}
	for (const v of plan.vectors) {
		const st = await fs.stat(v.source);
		const r = await inspectVector(v.source, st);
		if (!r.ok) {
			throw new Error(`vector layer ${v.source} is not usable: ${r.warnings.join("; ")}`);
		}
		job.log(`vector layer "${v.name}": ${v.source} (${formatBytes(st.size)}) → vectors/${v.fileName}`);
		copyBytes += plan.importMode === "copy" ? st.size : 0;
	}

	// Converter peak usage: temporary chunks plus the octree, each about points × record length.
	const octreeBytes = pcs.estimatedOutputBytes ?? pcs.bytes * 4;
	const required = 1.5 * octreeBytes + copyBytes;
	const free = await freeBytes(config.projectsDir);
	job.log(`disk: about ${formatBytes(required)} needed (octree ≈ ${formatBytes(octreeBytes)}${pcs.estimatedPartial ? ", extrapolated" : ""}, copies ${formatBytes(copyBytes)}), ${formatBytes(free)} free`);
	if (free < required) {
		throw new Error(`not enough disk space in ${config.projectsDir}: about ${formatBytes(required)} needed, ${formatBytes(free)} free`);
	}
	if (free < 2 * required) {
		job.warn(`disk space is tight: ${formatBytes(free)} free for about ${formatBytes(required)} needed`);
	}

	// Reserve the id: the exclusive mkdir of the staging folder acts as a lock.
	if (await lstatOrNull(ctx.finalDir)) {
		throw new Error(`project folder already exists: ${ctx.finalDir}`);
	}
	await fs.mkdir(config.stagingDir, { recursive: true });
	try {
		await fs.mkdir(ctx.stagingDir);
	} catch (err) {
		if (err.code === "EEXIST") {
			throw new Error(`staging folder ${ctx.stagingDir} already exists (another job is creating "${plan.id}" or a failed job left data there)`);
		}
		throw err;
	}
	job.staging.created = true;
	await persistStaging(job);
	return pcs.text;
}

/** Extent [min, max] of the converted points: the "position" attribute range, else the (cubic) octree box. */
function pointcloudExtent(metadata) {
	const position = (metadata.attributes ?? []).find((a) => a.name === "position");
	const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
	if (isVec3(position?.min) && isVec3(position?.max)) {
		return { min: position.min, max: position.max };
	}
	const box = metadata.boundingBox;
	return isVec3(box?.min) && isVec3(box?.max) ? { min: box.min, max: box.max } : null;
}

/** Job step "convert": PotreeConverter into <staging>/pointcloud, then sanity checks of its output. */
async function convertStep(job, plan, ctx, signal) {
	const outDir = path.join(ctx.stagingDir, "pointcloud");
	const { encoding, method } = plan.conversion;
	const { files, summary } = plan.pointcloud;
	// The converter gets exactly the validated files: given a folder it would also take dot-files and
	// sub-folders whose names end in "las"/"laz". Long lists go through a folder of links (named after
	// the project, which becomes metadata "name").
	const inputDir = path.join(ctx.stagingDir, ".input");
	const startedAt = nowIso();
	try {
		const inputs = await converterInputs(files, path.join(inputDir, plan.id));
		if (inputs.length === 1 && inputs[0] !== files[0]) {
			job.log(`${formatCount(files.length)} input files are passed to the converter as links in ${inputs[0]}`);
		}
		await runConverter({
			converter: config.converter,
			inputs,
			outDir,
			encoding,
			method,
			projection: plan.pointcloud.projection,
			signal,
			onLine: (line) => job.log(line),
			onProgress: (p) => job.stepProgress("convert", p.percent / 100, `${p.pass.toLowerCase()} ${Math.round(p.passPercent)}% · total ${Math.round(p.percent)}%`),
		});
	} finally {
		await fs.rm(inputDir, { recursive: true, force: true });
	}
	const finishedAt = nowIso();
	for (const file of ["metadata.json", "hierarchy.bin", "octree.bin"]) {
		if (!(await statOrNull(path.join(outDir, file)))) {
			throw new Error(`PotreeConverter finished but ${file} is missing in ${outDir}`);
		}
	}
	const metadata = await readJson(path.join(outDir, "metadata.json"));
	ctx.points = Number(metadata.points) || 0;
	ctx.extent = pointcloudExtent(metadata);
	if (Number.isFinite(summary.points) && !summary.pointsPartial && files.length === summary.files && ctx.points !== summary.points) {
		job.warn(`the converted point cloud has ${formatCount(ctx.points)} points but the LAS/LAZ headers announce ${formatCount(summary.points)}`);
	}
	if ((plan.pointcloud.projection ?? "") !== (metadata.projection ?? "")) {
		job.warn("metadata.json projection differs from the requested CRS definition");
	}
	const attributes = new Set((metadata.attributes ?? []).map((a) => a.name));
	const material = ctx.material;
	if (material.activeAttribute === "rgba" && !attributes.has("rgb")) {
		job.warn("the point cloud has no RGB colours; the page starts with the \"elevation\" attribute instead");
		material.activeAttribute = "elevation";
	} else if (!VIRTUAL_ATTRIBUTES.has(material.activeAttribute) && !attributes.has(material.activeAttribute)) {
		job.warn(`attribute "${material.activeAttribute}" does not exist in the point cloud (available: ${[...attributes].join(", ")})`);
	}
	ctx.conversion = {
		input: plan.pointcloud.path,
		encoding,
		method,
		converter: config.converter,
		projection: plan.pointcloud.projection,
		startedAt,
		finishedAt,
		durationSec: Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000),
	};
	return `${formatCount(ctx.points)} points (${encoding}, ${method}) in ${ctx.conversion.durationSec} s`;
}

/** Bring one source (folder or file) into the staging folder with the requested import mode. */
async function importEntry(job, { source, dest, mode, label, signal, onProgress = () => {} }) {
	await fs.mkdir(path.dirname(dest), { recursive: true });
	if (mode === "symlink") {
		await fs.symlink(source, dest);
		job.log(`${label}: linked ${dest} → ${source}`);
		return;
	}
	if (mode === "move") {
		// Record the intent first: if the process dies mid-way, the staging folder must be kept.
		const record = { from: source, to: dest };
		job.staging.moved.push(record);
		await persistStaging(job);
		try {
			await fs.rename(source, dest);
		} catch (err) {
			job.staging.moved.splice(job.staging.moved.indexOf(record), 1);
			await persistStaging(job);
			if (err.code === "EXDEV") {
				throw new Error(`cannot move ${source}: it is on a different filesystem than the projects folder (nothing was moved for it); use importMode "copy" or "symlink"`);
			}
			throw new Error(`cannot move ${source}: ${err.message}`);
		}
		job.log(`${label}: moved ${source} → ${dest}`);
		return;
	}
	const st = await fs.stat(source);
	if (st.isFile()) {
		await copyPublicFile(source, dest, st.mode);
		onProgress(1, `${label}: ${formatBytes(st.size)} copied`);
		job.log(`${label}: copied ${source} (${formatBytes(st.size)})`);
		return;
	}
	let lastReport = 0;
	const result = await copyTree(source, dest, {
		signal,
		onSkip: (rel, reason) => job.warn(`${label}: skipped ${rel} (${reason})`),
		onProgress: (p) => {
			const now = Date.now();
			if (now - lastReport < 1000 && p.files < p.totalFiles) {
				return;
			}
			lastReport = now;
			const fraction = p.totalBytes > 0 ? p.bytes / p.totalBytes : p.totalFiles > 0 ? p.files / p.totalFiles : 1;
			onProgress(fraction, `${label}: ${formatCount(p.files)} / ${formatCount(p.totalFiles)} files, ${formatBytes(p.bytes)} / ${formatBytes(p.totalBytes)}`);
		},
	});
	job.log(`${label}: copied ${formatCount(result.files)} files (${formatBytes(result.bytes)}) from ${source}`);
}

// Automatic preview framing (SPEC: project.json "previewView", used only by the preview renderer).
const PREVIEW_NEIGHBOUR_RADIUS = 150; // m: density measure around a panorama
const PREVIEW_MAX_CANDIDATES = 3000; // panoramas evaluated as the view centre
const PREVIEW_MAX_NEIGHBOURS = 30000; // panoramas used to count neighbours (evenly sampled)
const PREVIEW_EXTENT_MARGIN = 50; // m around the point cloud's extent
const PANO_HEIGHT = 2.5; // m: camera height of a panorama above the ground
const PREVIEW_COMPACT_SPAN = 600; // m: clouds up to this size are framed by fitToScreen instead
const PREVIEW_MIN_DISTANCE = 60; // m: camera-to-target distance bounds of the close-up
const PREVIEW_MAX_DISTANCE = 300;

const PREVIEW_MAX_HEADER_READS = 5000; // input files whose LAS header extent is used for framing
const PREVIEW_BOX_CELL = 250; // m: grid cell of the tile lookup

/** Horizontal extents ({min, max}) from the LAS/LAZ headers of the input files; unreadable ones are skipped. */
async function inputBoxes(files) {
	const list = (files ?? []).slice(0, PREVIEW_MAX_HEADER_READS);
	const boxes = [];
	for (let i = 0; i < list.length; i += 16) {
		const headers = await Promise.all(list.slice(i, i + 16).map((f) => readLasHeader(f).catch(() => null)));
		for (const h of headers) {
			if (h && h.min.concat(h.max).every(Number.isFinite) && h.max[0] >= h.min[0] && h.max[1] >= h.min[1]) {
				boxes.push({ min: h.min, max: h.max });
			}
		}
	}
	return boxes;
}

/** Returns (x, y) => the first box containing the point (grown by `margin`), or null; grid-indexed. */
function boxFinder(boxes, margin) {
	const grid = new Map();
	const large = []; // boxes covering too many cells (or with absurd header values) are checked linearly
	const cell = (v) => Math.floor(v / PREVIEW_BOX_CELL);
	for (const box of boxes) {
		const cells = (cell(box.max[0] + margin) - cell(box.min[0] - margin) + 1) * (cell(box.max[1] + margin) - cell(box.min[1] - margin) + 1);
		if (cells > 10000) {
			large.push(box);
			continue;
		}
		for (let cx = cell(box.min[0] - margin); cx <= cell(box.max[0] + margin); cx++) {
			for (let cy = cell(box.min[1] - margin); cy <= cell(box.max[1] + margin); cy++) {
				const key = `${cx},${cy}`;
				if (!grid.has(key)) {
					grid.set(key, []);
				}
				grid.get(key).push(box);
			}
		}
	}
	return (x, y) => {
		for (const box of (grid.get(`${cell(x)},${cell(y)}`) ?? []).concat(large)) {
			if (x >= box.min[0] - margin && x <= box.max[0] + margin && y >= box.min[1] - margin && y <= box.max[1] + margin) {
				return box;
			}
		}
		return null;
	};
}

/** Evenly spaced sample of at most `n` items. */
function evenSample(items, n) {
	if (items.length <= n) {
		return items;
	}
	const step = items.length / n;
	return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

/** Panorama positions [x, y, z] of a coordinates file (tab-separated: File Time x y z course pitch roll). */
async function readPanoramaPositions(file) {
	const st = await fs.stat(file);
	if (st.size > MAX_COORDINATES_BYTES) {
		throw new Error(`${path.basename(file)} is larger than ${formatBytes(MAX_COORDINATES_BYTES)}`);
	}
	const positions = [];
	const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/);
	for (const line of lines.slice(1)) {
		const tokens = line.split("\t");
		const xyz = [tokens[2], tokens[3], tokens[4]].map((t) => Number.parseFloat(t));
		if (tokens.length >= 8 && xyz.every(Number.isFinite)) {
			positions.push(xyz);
		}
	}
	return positions;
}

/** Converts panorama positions into the point cloud's CRS (identity when they share it), or null. */
async function panoramaTransform(plan) {
	const from = plan.images360.crs;
	if (from === null || from === plan.pointcloud.crs) {
		return (p) => p;
	}
	const fromDef = await lookupProj4(from, plan.pointcloud.crsDefs ?? {});
	if (!fromDef || !plan.pointcloud.projection) {
		return null;
	}
	const converter = proj4(fromDef, plan.pointcloud.projection);
	return ([x, y, z]) => [...converter.forward([x, y]), z];
}

/** The panorama with the most neighbours within PREVIEW_NEIGHBOUR_RADIUS (grid bucketing). */
function densestPosition(positions) {
	const r = PREVIEW_NEIGHBOUR_RADIUS;
	const grid = new Map();
	const cellKey = (i, j) => `${i},${j}`;
	for (const p of evenSample(positions, PREVIEW_MAX_NEIGHBOURS)) {
		const key = cellKey(Math.floor(p[0] / r), Math.floor(p[1] / r));
		if (!grid.has(key)) {
			grid.set(key, []);
		}
		grid.get(key).push(p);
	}
	let best = null;
	let bestCount = -1;
	for (const c of evenSample(positions, PREVIEW_MAX_CANDIDATES)) {
		const ci = Math.floor(c[0] / r);
		const cj = Math.floor(c[1] / r);
		let count = 0;
		for (let di = -1; di <= 1; di++) {
			for (let dj = -1; dj <= 1; dj++) {
				for (const p of grid.get(cellKey(ci + di, cj + dj)) ?? []) {
					const dx = p[0] - c[0];
					const dy = p[1] - c[1];
					count += dx * dx + dy * dy <= r * r ? 1 : 0;
				}
			}
		}
		if (count > bestCount) {
			best = c;
			bestCount = count;
		}
	}
	return best && { position: best, neighbours: bestCount };
}

/**
 * previewView for a project with 360° images and no view of its own: an oblique close-up of the
 * densest part of the survey (fitting a long corridor survey into a 1280×720 card shows a thin line).
 * Centre: the panorama with the most neighbours, among the panoramas inside the point cloud's extent
 * (the image folder may cover a much larger area). Returns null when no panorama lies inside.
 */
async function automaticPreviewView(job, plan, ctx) {
	// A compact cloud is framed well by fitToScreen; only long surveys (a
	// thin line in a 1280×720 card) need a close-up of their densest area.
	if (ctx.extent) {
		const span = Math.max(ctx.extent.max[0] - ctx.extent.min[0], ctx.extent.max[1] - ctx.extent.min[1]);
		if (span <= PREVIEW_COMPACT_SPAN) {
			job.log(`automatic preview view skipped: the point cloud spans ${Math.round(span)} m, fit to screen frames it`);
			return null;
		}
	}
	const transform = await panoramaTransform(plan);
	if (!transform) {
		job.log(`automatic preview view skipped: cannot convert ${plan.images360.crs} positions into the point cloud CRS`);
		return null;
	}
	const file = path.join(ctx.stagingDir, "images360", plan.images360.coordinatesFile);
	let positions = (await readPanoramaPositions(file)).map(transform);
	// Disjoint tiles leave large empty areas inside the overall extent, so a
	// panorama must lie on one of the input files' own extents (LAS headers).
	const boxes = await inputBoxes(plan.pointcloud.files);
	if (boxes.length === 0 && ctx.extent) {
		boxes.push(ctx.extent);
	}
	if (boxes.length > 0) {
		const findBox = boxFinder(boxes, PREVIEW_EXTENT_MARGIN);
		positions = positions.filter(([x, y]) => findBox(x, y) !== null);
	}
	const densest = densestPosition(positions);
	if (!densest) {
		job.log("automatic preview view skipped: no 360° image position lies on the point cloud");
		return null;
	}
	let [x, y, z] = densest.position;
	const ground = z - PANO_HEIGHT;
	// Frame the data around the centre: the union of the tiles within
	// PREVIEW_MAX_DISTANCE, so isolated small tiles fill the frame too.
	let distance = PREVIEW_MAX_DISTANCE;
	const r = PREVIEW_MAX_DISTANCE;
	const near = boxes.filter((b) => b.min[0] <= x + r && b.max[0] >= x - r && b.min[1] <= y + r && b.max[1] >= y - r);
	if (near.length > 0) {
		const min = [Math.min(...near.map((b) => b.min[0])), Math.min(...near.map((b) => b.min[1]))];
		const max = [Math.max(...near.map((b) => b.max[0])), Math.max(...near.map((b) => b.max[1]))];
		const span = Math.hypot(max[0] - min[0], max[1] - min[1]);
		distance = Math.min(Math.max(0.9 * span, PREVIEW_MIN_DISTANCE), PREVIEW_MAX_DISTANCE);
		if (span <= 2 * PREVIEW_MIN_DISTANCE) {
			[x, y] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
		} else {
			x = Math.min(Math.max(x, min[0]), max[0]);
			y = Math.min(Math.max(y, min[1]), max[1]);
		}
	}
	const round = (v) => Math.round(v * 100) / 100;
	const view = {
		position: [x, y - 0.8 * distance, ground + 0.6 * distance].map(round),
		target: [x, y, ground].map(round),
	};
	job.log(`preview view: centred on the 360° image at [${fmtXYZ(densest.position)}] (${formatCount(densest.neighbours)} images within ${PREVIEW_NEIGHBOUR_RADIUS} m)`);
	return view;
}

function buildProjectJson(plan, ctx, diskBytes) {
	const now = nowIso();
	const project = {
		schemaVersion: 1,
		id: plan.id,
		title: plan.title,
		description: plan.description,
		keywords: plan.keywords,
		location: plan.location,
		date: plan.date,
		source: plan.source,
		createdAt: now,
		updatedAt: now,
		entry: "index.html",
		preview: "preview.jpg",
		custom: false,
		crs: plan.pointcloud.crs,
	};
	if (plan.pointcloud.crsDefs) {
		project.crsDefs = plan.pointcloud.crsDefs;
	}
	Object.assign(project, {
		pointclouds: [{ name: plan.id, url: "pointcloud/metadata.json", material: ctx.material }],
		viewer: plan.viewer,
		view: plan.view,
	});
	const previewView = plan.previewView ?? ctx.previewView;
	if (previewView) {
		project.previewView = previewView;
	}
	Object.assign(project, {
		images360: plan.images360
			? {
				url: "images360",
				coordinatesFile: plan.images360.coordinatesFile,
				crs: plan.images360.crs,
				labelSets: plan.labelSets.map((s) => ({ id: s.id, name: s.name, url: `labels/${s.id}` })),
			}
			: null,
		vectors: plan.vectors.map((v) => ({ name: v.name, url: `vectors/${v.fileName}`, crs: v.crs, visible: v.visible })),
		meshes: [],
		stats: { points: ctx.points, images360: ctx.images360Rows ?? null, diskBytes },
		conversion: ctx.conversion,
	});
	if (plan.notes) {
		project.notes = plan.notes;
	}
	return project;
}

/**
 * The create job. `getRenderer()` returns a PreviewRenderer (or throws when previews are unavailable).
 * An optional `signal` (AbortSignal) interrupts the job: the converter is terminated, copies stop and
 * the staging folder is cleaned up as after any failure. Returns {projectId, url, dir, preview, warnings}.
 */
export async function runCreateJob(job, plan, { getRenderer, signal }) {
	const ctx = {
		stagingDir: path.join(config.stagingDir, plan.id),
		finalDir: projectDir(plan.id),
		material: { ...plan.material },
		points: null,
		extent: null,
		images360Rows: null,
		imageFiles: null,
		conversion: null,
		previewView: null,
	};
	job.staging = { dir: ctx.stagingDir, created: false, moved: [] };
	plan.warnings.forEach((w) => job.warn(w));
	if (!plan.images360) {
		job.skipStep("images360", "no 360° images");
	}
	if (plan.labelSets.length === 0) {
		job.skipStep("labels", "no label sets");
	}
	if (plan.vectors.length === 0) {
		job.skipStep("vectors", "no vector layers");
	}
	if (!plan.renderPreview) {
		job.skipStep("preview", "disabled in the request");
	}
	const runStep = (key, fn, options) => {
		signal?.throwIfAborted();
		return job.runStep(key, fn, options);
	};

	let project;
	try {
		await runStep("validate", () => validateStep(job, plan, ctx, signal));
		await runStep("convert", () => convertStep(job, plan, ctx, signal));
		if (plan.images360) {
			await runStep("images360", async () => {
				await importEntry(job, {
					source: plan.images360.source,
					dest: path.join(ctx.stagingDir, "images360"),
					mode: plan.importMode,
					label: "images360",
					signal,
					onProgress: (f, detail) => job.stepProgress("images360", f, detail),
				});
				return `${plan.importMode}: ${formatCount(ctx.images360Rows)} positions`;
			});
		}
		if (plan.labelSets.length > 0) {
			await runStep("labels", async () => {
				for (const [i, set] of plan.labelSets.entries()) {
					await importEntry(job, {
						source: set.source,
						dest: path.join(ctx.stagingDir, "labels", set.id),
						mode: plan.importMode,
						label: `labels/${set.id}`,
						signal,
						onProgress: (f, detail) => job.stepProgress("labels", (i + f) / plan.labelSets.length, detail),
					});
					job.stepProgress("labels", (i + 1) / plan.labelSets.length);
				}
				return `${plan.importMode}: ${plan.labelSets.map((s) => s.name).join(", ")}`;
			});
		}
		if (plan.vectors.length > 0) {
			await runStep("vectors", async () => {
				for (const [i, v] of plan.vectors.entries()) {
					signal?.throwIfAborted();
					await importEntry(job, {
						source: v.source,
						dest: path.join(ctx.stagingDir, "vectors", v.fileName),
						mode: plan.importMode,
						label: `vectors/${v.fileName}`,
						signal,
					});
					job.stepProgress("vectors", (i + 1) / plan.vectors.length);
				}
				return `${plan.importMode}: ${plan.vectors.length} file(s)`;
			});
		}
		await runStep("project", async () => {
			if (plan.images360 && !plan.view && !plan.previewView) {
				ctx.previewView = await automaticPreviewView(job, plan, ctx).catch((err) => {
					job.warn(`automatic preview view failed: ${err.message}`);
					return null;
				});
			}
			project = buildProjectJson(plan, ctx, await localTreeSize(ctx.stagingDir));
			await writeJsonAtomic(path.join(ctx.stagingDir, "project.json"), project);
			return "project.json written";
		});
		await runStep("page", async () => {
			await writeProjectPage(ctx.stagingDir, plan.id, project);
			return "index.html generated";
		});
		await runStep("finalize", async () => {
			if (await lstatOrNull(ctx.finalDir)) {
				throw new Error(`project folder appeared meanwhile: ${ctx.finalDir}`);
			}
			await fs.rm(path.join(ctx.stagingDir, OWNER_FILE), { force: true });
			await fs.rename(ctx.stagingDir, ctx.finalDir);
			job.staging = null;
			await job.persist();
			return ctx.finalDir;
		});
	} catch (err) {
		const note = await cleanupStaging(job).catch((cleanupErr) => `staging cleanup failed: ${cleanupErr.message}`);
		throw new Error(note ? `${err.message} — ${note}` : err.message);
	}

	if (plan.renderPreview) {
		await runStep("preview", async () => {
			const renderer = await getRenderer();
			const r = await renderer.render(plan.id, project, (line) => job.log(line));
			return `rendered in ${(r.ms / 1000).toFixed(1)} s (${r.renderer})`;
		}, { fatal: false });
	}
	let entry = null;
	await runStep("registry", async () => {
		await updateRegistryFile();
		entry = await registryEntry(plan.id, project);
		return "registry.json updated";
	}, { fatal: false });

	return {
		projectId: plan.id,
		url: `${plan.id}/${project.entry}`,
		dir: ctx.finalDir,
		preview: entry?.preview ?? null,
		warnings: job.warnings,
	};
}

/** The preview job: re-render projects/<id>/preview.jpg, then refresh the registry. */
export async function runPreviewJob(job, { getRenderer }) {
	const project = await readProject(job.projectId);
	await job.runStep("preview", async () => {
		const renderer = await getRenderer();
		const r = await renderer.render(job.projectId, project, (line) => job.log(line));
		return `rendered in ${(r.ms / 1000).toFixed(1)} s (${r.renderer})`;
	});
	let entry = null;
	await job.runStep("registry", async () => {
		await updateRegistryFile();
		entry = await registryEntry(job.projectId, project);
		return "registry.json updated";
	});
	return { projectId: job.projectId, preview: entry?.preview ?? null };
}
