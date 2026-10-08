// Server-side path picker support: directory listings and data inspection (SPEC §5 /api/fs/*).

import fs from "node:fs/promises";
import path from "node:path";
import { MAX_COORDINATES_BYTES } from "./config.mjs";
import { getAllowedRoots, isAllowedRealPath, isFollowableRealPath, resolveAllowedPath, scanTree } from "./fsutil.mjs";
import { HttpError, createLimiter, formatBytes, formatCount, isSafeRelativePath, mapLimit, statOrNull } from "./util.mjs";

export { MAX_COORDINATES_BYTES };

const MAX_LIST_ENTRIES = 500;
const MAX_QUERY_LENGTH = 255;
const POINTCLOUD_EXTENSIONS = new Set([".las", ".laz"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_HEADER_READS = 1000;
// Limits of GET /api/fs/inspect (the create job scans without them).
const INSPECT_MAX_FILES = 200_000;
const INSPECT_TIME_BUDGET_MS = 10_000;
// At most 3 inspections run at a time; 20 more may wait for a slot, further requests get 429.
const runInspection = createLimiter(3, 20);

function extensionFilter(ext) {
	if (typeof ext !== "string" || ext.trim() === "") {
		return null;
	}
	const set = new Set(
		ext.split(",")
			.map((e) => e.trim().toLowerCase())
			.filter(Boolean)
			.map((e) => (e.startsWith(".") ? e : "." + e)),
	);
	return set.size > 0 ? set : null;
}

/** Lower-cased name filter of /api/fs/list (`q`), or null for none. */
function nameQuery(q) {
	if (q === undefined || q === null) {
		return null;
	}
	if (typeof q !== "string" || q.length > MAX_QUERY_LENGTH) {
		throw new HttpError(400, `q must be a string of at most ${MAX_QUERY_LENGTH} characters`);
	}
	return q.trim() === "" ? null : q.trim().toLowerCase();
}

const byName = (a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });

/**
 * GET /api/fs/list: directories first, hidden entries skipped, optional extension filter for files and
 * case-insensitive name filter `q` (both applied before the MAX_LIST_ENTRIES cap; `total` counts the
 * matching entries).
 */
export async function listDirectory(inputPath, ext, q) {
	const query = nameQuery(q);
	const roots = await getAllowedRoots();
	if (roots.length === 0) {
		throw new HttpError(503, "no ALLOWED_ROOTS exist on this server");
	}
	const dir = inputPath ? await resolveAllowedPath(inputPath) : roots[0];
	const st = await fs.stat(dir);
	if (!st.isDirectory()) {
		throw new HttpError(400, `not a directory: ${dir}`);
	}
	const filter = extensionFilter(ext);
	let dirents;
	try {
		dirents = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		throw new HttpError(err.code === "EACCES" ? 403 : 500, `cannot read directory ${dir}: ${err.code || err.message}`);
	}

	const dirs = [];
	const files = [];
	for (const d of dirents) {
		if (d.name.startsWith(".") || (query && !d.name.toLowerCase().includes(query))) {
			continue;
		}
		let isDir = d.isDirectory();
		let isFile = d.isFile();
		if (d.isSymbolicLink()) {
			const target = await statOrNull(path.join(dir, d.name));
			if (!target) {
				continue; // broken link
			}
			isDir = target.isDirectory();
			isFile = target.isFile();
		}
		if (isDir) {
			dirs.push({ name: d.name, type: "dir" });
		} else if (isFile && (!filter || filter.has(path.extname(d.name).toLowerCase()))) {
			files.push({ name: d.name, type: "file" });
		}
	}
	const all = [...dirs.sort(byName), ...files.sort(byName)];
	const entries = await mapLimit(all.slice(0, MAX_LIST_ENTRIES), 32, async ({ name, type }) => {
		const full = path.join(dir, name);
		const s = await statOrNull(full);
		return {
			name,
			path: full,
			type,
			size: type === "file" && s ? s.size : null,
			mtime: s ? s.mtime.toISOString() : null,
		};
	});
	const parentPath = path.dirname(dir);
	return {
		path: dir,
		parent: parentPath !== dir && (await isAllowedRealPath(parentPath)) ? parentPath : null,
		roots,
		q: query === null ? "" : q.trim(), // the filter as sent, to match answers to requests
		entries,
		truncated: all.length > entries.length,
		total: all.length,
	};
}

/**
 * Read the public header of a LAS/LAZ file (LAZ keeps the LAS header uncompressed).
 * Offsets follow the ASPRS LAS 1.0–1.4 specification.
 */
export async function readLasHeader(file) {
	const handle = await fs.open(file, "r");
	try {
		const buf = Buffer.alloc(375);
		const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
		if (bytesRead < 227 || buf.toString("latin1", 0, 4) !== "LASF") {
			throw new Error("not a LAS/LAZ file (missing LASF signature)");
		}
		const major = buf[24];
		const minor = buf[25];
		let points = buf.readUInt32LE(107);
		if (major === 1 && minor >= 4 && bytesRead >= 255) {
			const points64 = Number(buf.readBigUInt64LE(247));
			if (points64 > 0) {
				points = points64;
			}
		}
		return {
			version: `${major}.${minor}`,
			pointFormat: buf[104] & 0x3f,
			compressed: (buf[104] & 0x80) !== 0,
			recordLength: buf.readUInt16LE(105),
			points,
			min: [buf.readDoubleLE(187), buf.readDoubleLE(203), buf.readDoubleLE(219)],
			max: [buf.readDoubleLE(179), buf.readDoubleLE(195), buf.readDoubleLE(211)],
		};
	} finally {
		await handle.close();
	}
}

const isPointcloudFile = (name) => POINTCLOUD_EXTENSIONS.has(path.extname(name).toLowerCase());

/**
 * Inspect a point-cloud input the way PotreeConverter will see it: one LAS/LAZ file, or the LAS/LAZ
 * files directly inside a directory (the converter does not descend into subfolders).
 * At most MAX_HEADER_READS headers are read; beyond that, point count and output size are
 * extrapolated from the share of bytes whose headers were read (`pointsPartial`/`estimatedPartial`).
 */
export async function inspectPointcloudInput(real, st, { signal } = {}) {
	const warnings = [];
	let files;
	if (st.isDirectory()) {
		const dirents = await fs.readdir(real, { withFileTypes: true });
		files = [];
		let subdirs = 0;
		for (const d of dirents) {
			if (d.name.startsWith(".")) {
				continue;
			}
			const full = path.join(real, d.name);
			const s = d.isSymbolicLink() ? await statOrNull(full) : null;
			if ((d.isFile() || s?.isFile()) && isPointcloudFile(d.name)) {
				files.push(full);
			} else if (d.isDirectory() || s?.isDirectory()) {
				subdirs++;
			}
		}
		files.sort();
		if (files.length === 0) {
			const names = new Set(dirents.map((d) => d.name));
			if (names.has("metadata.json") && names.has("octree.bin")) {
				warnings.push("this folder is already a converted Potree point cloud; select the LAS/LAZ source instead");
			} else {
				warnings.push(`no .las/.laz files directly in this folder${subdirs ? " (PotreeConverter does not search subfolders)" : ""}`);
			}
		}
	} else if (isPointcloudFile(real)) {
		files = [real];
	} else {
		files = [];
		warnings.push("not a .las/.laz file");
	}

	let bytes = 0;
	let points = 0;
	let headersRead = 0;
	let readBytes = 0; // input bytes of the files whose header was read
	let estimatedBytes = 0;
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	const versions = new Set();
	await mapLimit(files, 16, async (file, i) => {
		signal?.throwIfAborted();
		const s = await statOrNull(file);
		bytes += s?.size ?? 0;
		if (i >= MAX_HEADER_READS) {
			return;
		}
		try {
			const h = await readLasHeader(file);
			headersRead++;
			readBytes += s?.size ?? 0;
			points += h.points;
			estimatedBytes += h.points * h.recordLength;
			versions.add(`${h.version}/${h.pointFormat}`);
			for (let k = 0; k < 3; k++) {
				min[k] = Math.min(min[k], h.min[k]);
				max[k] = Math.max(max[k], h.max[k]);
			}
		} catch (err) {
			warnings.push(`${path.basename(file)}: ${err.message}`);
		}
	});
	// Headers that were not read (beyond the cap) are extrapolated by their share of the input bytes,
	// so the disk-space check of the create job does not underestimate surveys with many tiles.
	const partial = headersRead > 0 && headersRead < files.length;
	const scale = partial ? (readBytes > 0 ? bytes / readBytes : files.length / headersRead) : 1;
	if (files.length > MAX_HEADER_READS) {
		warnings.push(`only the first ${formatCount(MAX_HEADER_READS)} of ${formatCount(files.length)} file headers were read; point count and output size are extrapolated`);
	}
	const ok = files.length > 0 && headersRead > 0 && headersRead === Math.min(files.length, MAX_HEADER_READS);
	const pointsOut = headersRead > 0 ? Math.round(points * scale) : null;
	return {
		ok,
		size: bytes,
		files,
		summary: {
			files: files.length,
			bytes,
			points: pointsOut,
			pointsPartial: partial,
			// Rough size of the converted, uncompressed octree (record length × points).
			estimatedOutputBytes: headersRead > 0 ? Math.ceil(estimatedBytes * scale) : null,
			estimatedPartial: partial,
			// Bounding box of the files whose header was read.
			bbox: headersRead > 0 ? { min, max } : null,
			formats: [...versions].sort(),
			text: `${formatCount(files.length)} LAS/LAZ file(s), ${formatBytes(bytes)}` + (headersRead > 0 ? `, ${partial ? "≈ " : ""}${formatCount(pointsOut)} points` : ""),
		},
		warnings,
	};
}

function parseCoordinateRow(line) {
	const tokens = line.split("\t");
	const file = (tokens[0] ?? "").replace(/"/g, "").trim();
	const x = Number.parseFloat(tokens[2]);
	const y = Number.parseFloat(tokens[3]);
	const z = Number.parseFloat(tokens[4]);
	return { file, x, y, z, valid: file !== "" && tokens.length >= 8 && [x, y, z].every(Number.isFinite) };
}

/** Evenly spaced sample of at most `n` items. */
function sample(items, n) {
	if (items.length <= n) {
		return items;
	}
	const step = items.length / n;
	return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

/**
 * Real path and size of the coordinates file `coordinatesFile` (relative) of the 360° folder `dir`;
 * `{error}` when it is missing, resolves (e.g. through a symlink) outside ALLOWED_ROOTS or into the
 * service's own folders, is not a regular file or is larger than MAX_COORDINATES_BYTES.
 */
export async function resolveCoordinatesFile(dir, coordinatesFile) {
	const real = await fs.realpath(path.join(dir, coordinatesFile)).catch(() => null);
	const st = real && (await isFollowableRealPath(real)) ? await statOrNull(real) : null;
	if (!st?.isFile()) {
		return { error: `coordinates file not found: ${coordinatesFile}` };
	}
	if (st.size > MAX_COORDINATES_BYTES) {
		return { error: `coordinates file ${coordinatesFile} is too large (${formatBytes(st.size)}, at most ${formatBytes(MAX_COORDINATES_BYTES)}); expected a tab-separated text file` };
	}
	return { real, size: st.size };
}

/**
 * Inspect a 360° image folder: its tab-separated coordinates file (File Time x y z course pitch roll,
 * one header line, File relative to the folder) and whether the listed images exist. All rows are
 * checked up to `maxChecks`, otherwise an evenly spaced sample of `sampleSize`.
 */
export async function inspectImages360(dir, coordinatesFile = "coordinates.txt", { maxChecks = 20000, sampleSize = 2000, signal } = {}) {
	const warnings = [];
	if (!isSafeRelativePath(coordinatesFile)) {
		throw new HttpError(400, `invalid coordinatesFile: ${coordinatesFile}`);
	}
	const summary = { coordinatesFile, coordinatesFound: false, rows: 0, malformedRows: 0, duplicateRows: 0, imagesInFolder: 0, checked: 0, missingImages: 0, missingExamples: [], sampled: false, bbox: null, files: [] };

	const dirents = await fs.readdir(dir, { withFileTypes: true });
	summary.imagesInFolder = dirents.filter((d) => !d.isDirectory() && IMAGE_EXTENSIONS.has(path.extname(d.name).toLowerCase())).length;

	const coordinates = await resolveCoordinatesFile(dir, coordinatesFile);
	if (coordinates.error) {
		warnings.push(coordinates.error);
		return { ok: false, summary, warnings };
	}
	signal?.throwIfAborted();
	let text;
	try {
		text = await fs.readFile(coordinates.real, "utf8");
		summary.coordinatesFound = true;
	} catch (err) {
		warnings.push(`coordinates file not readable: ${coordinatesFile} (${err.code || err.message})`);
		return { ok: false, summary, warnings };
	}
	signal?.throwIfAborted();

	const lines = text.split(/\r?\n/);
	if ((lines[0] ?? "").split("\t").length < 8) {
		warnings.push("header line is not tab-separated with 8 columns (expected: File Time x y z course pitch roll)");
	}
	const rows = [];
	const seen = new Set();
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "") {
			continue;
		}
		const row = parseCoordinateRow(lines[i]);
		if (!row.valid) {
			summary.malformedRows++;
			continue;
		}
		if (seen.has(row.file)) {
			summary.duplicateRows++;
		}
		seen.add(row.file);
		rows.push(row);
		const xyz = [row.x, row.y, row.z];
		for (let k = 0; k < 3; k++) {
			min[k] = Math.min(min[k], xyz[k]);
			max[k] = Math.max(max[k], xyz[k]);
		}
	}
	summary.rows = rows.length;
	summary.bbox = rows.length > 0 ? { min, max } : null;
	if (summary.malformedRows > 0) {
		warnings.push(`${formatCount(summary.malformedRows)} malformed row(s) will be ignored by the viewer`);
	}
	if (summary.duplicateRows > 0) {
		warnings.push(`${formatCount(summary.duplicateRows)} duplicate row(s) (same image listed twice)`);
	}
	if (rows.length === 0) {
		warnings.push("the coordinates file has no valid rows");
		return { ok: false, summary, warnings };
	}

	const toCheck = rows.length <= maxChecks ? rows : sample(rows, sampleSize);
	summary.sampled = toCheck.length < rows.length;
	summary.checked = toCheck.length;
	const missing = (await mapLimit(toCheck, 64, async (row) => {
		signal?.throwIfAborted();
		return isSafeRelativePath(row.file) && (await statOrNull(path.join(dir, row.file))) ? null : row.file;
	})).filter(Boolean);
	summary.missingImages = missing.length;
	summary.missingExamples = missing.slice(0, 5);
	if (missing.length > 0) {
		warnings.push(`${formatCount(missing.length)} of ${formatCount(toCheck.length)} ${summary.sampled ? "sampled " : ""}row(s) reference a missing image (e.g. ${missing[0]})`);
	}
	summary.text = `${formatCount(rows.length)} positions in ${coordinatesFile}, ${formatCount(summary.imagesInFolder)} images in the folder`
		+ (missing.length > 0 ? `, ${formatCount(missing.length)} of ${formatCount(toCheck.length)} checked missing` : "");
	// Relative image paths, kept for cross-checks of label sets (not sent to clients).
	summary.files = rows.map((row) => row.file);
	return { ok: missing.length < toCheck.length, summary, warnings };
}

/**
 * Inspect a label-set folder; when `imageFiles` are given, check a sample of matching label files.
 * `maxFiles` / `timeBudgetMs` bound the folder scan (then `summary.truncated` is set and the counts are
 * lower bounds); an aborted `signal` stops it.
 */
export async function inspectLabels(dir, imageFiles = null, { sampleSize = 200, signal, maxFiles = Infinity, timeBudgetMs = Infinity } = {}) {
	const warnings = [];
	const tree = await scanTree(dir, { signal, maxFiles, deadline: Date.now() + timeBudgetMs });
	signal?.throwIfAborted();
	const imageCount = tree.files.filter((f) => IMAGE_EXTENSIONS.has(path.extname(f.rel).toLowerCase())).length;
	const fileCount = tree.count ?? tree.files.length;
	const truncated = tree.truncated === true;
	const summary = {
		files: fileCount,
		imageFiles: imageCount,
		bytes: tree.bytes,
		truncated,
		checked: 0,
		missingLabels: 0,
		text: `${truncated ? "≥ " : ""}${formatCount(imageCount)} label images, ${truncated ? "≥ " : ""}${formatBytes(tree.bytes)}`,
	};
	if (truncated) {
		warnings.push(`very large folder: the scan stopped after ${formatCount(fileCount)} files, counts are lower bounds`);
	}
	if (imageCount === 0) {
		warnings.push("no image files (.jpg/.png/.webp) in this folder");
	}
	if (imageFiles?.length) {
		const toCheck = sample(imageFiles, sampleSize);
		const missing = (await mapLimit(toCheck, 64, async (rel) => {
			signal?.throwIfAborted();
			return isSafeRelativePath(rel) && (await statOrNull(path.join(dir, rel))) ? 0 : 1;
		})).reduce((a, b) => a + b, 0);
		summary.checked = toCheck.length;
		summary.missingLabels = missing;
		if (missing > 0) {
			warnings.push(`${missing} of ${toCheck.length} sampled 360° images have no label file with the same name`);
		}
	}
	return { ok: imageCount > 0, size: tree.bytes, summary, warnings };
}

/** Inspect a GeoPackage file (extension and SQLite signature). */
export async function inspectVector(file, st) {
	const warnings = [];
	const isGpkg = path.extname(file).toLowerCase() === ".gpkg";
	if (!isGpkg) {
		warnings.push("not a .gpkg file");
	}
	let sqlite = false;
	const handle = await fs.open(file, "r");
	try {
		const buf = Buffer.alloc(16);
		await handle.read(buf, 0, 16, 0);
		sqlite = buf.toString("latin1") === "SQLite format 3\0";
	} finally {
		await handle.close();
	}
	if (!sqlite) {
		warnings.push("file is not an SQLite database (GeoPackage files are SQLite)");
	}
	return { ok: isGpkg && sqlite, size: st.size, summary: { bytes: st.size, format: "gpkg", sqlite, text: formatBytes(st.size) }, warnings };
}

const INSPECT_KINDS = ["pointcloud", "images360", "labels", "vector"];

/**
 * GET /api/fs/inspect. Runs through a small concurrency limiter; `signal` (aborted when the client goes
 * away) stops the work, and folder scans are bounded by INSPECT_MAX_FILES / INSPECT_TIME_BUDGET_MS.
 */
export async function inspectPath(inputPath, kind, { coordinatesFile, signal } = {}) {
	if (!INSPECT_KINDS.includes(kind)) {
		throw new HttpError(400, `kind must be one of ${INSPECT_KINDS.join(", ")}`);
	}
	return runInspection(() => inspectKind(inputPath, kind, { coordinatesFile, signal }), signal);
}

async function inspectKind(inputPath, kind, { coordinatesFile, signal }) {
	const real = await resolveAllowedPath(inputPath);
	const st = await fs.stat(real);
	const type = st.isDirectory() ? "dir" : "file";
	const wrongType = (expected) => ({ ok: false, path: real, type, size: st.size, summary: null, warnings: [`expected a ${expected}`] });

	switch (kind) {
		case "pointcloud": {
			const r = await inspectPointcloudInput(real, st, { signal });
			return { ok: r.ok, path: real, type, size: r.size, summary: r.summary, warnings: r.warnings };
		}
		case "images360": {
			if (type !== "dir") {
				return wrongType("folder");
			}
			const r = await inspectImages360(real, coordinatesFile || "coordinates.txt", { maxChecks: 0, sampleSize: 200, signal });
			const { files, ...summary } = r.summary;
			return { ok: r.ok, path: real, type, size: null, summary, warnings: r.warnings };
		}
		case "labels": {
			if (type !== "dir") {
				return wrongType("folder");
			}
			const r = await inspectLabels(real, null, { signal, maxFiles: INSPECT_MAX_FILES, timeBudgetMs: INSPECT_TIME_BUDGET_MS });
			return { ok: r.ok, path: real, type, size: r.size, summary: r.summary, warnings: r.warnings };
		}
		case "vector": {
			if (type !== "file") {
				return wrongType(".gpkg file");
			}
			const r = await inspectVector(real, st);
			return { ok: r.ok, path: real, type, size: r.size, summary: r.summary, warnings: r.warnings };
		}
	}
}
