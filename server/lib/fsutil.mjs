// Filesystem helpers: ALLOWED_ROOTS enforcement, tree scanning/copying, sizes, log tails.

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { HttpError, isInside } from "./util.mjs";

/** Real paths of the existing entries of a configured folder list (missing ones are reported once). */
async function realpathsOf(list, envName) {
	const roots = [];
	for (const root of list) {
		try {
			roots.push(await fs.realpath(root));
		} catch {
			console.warn(`[config] ${envName} entry does not exist and is ignored: ${root}`);
		}
	}
	return [...new Set(roots)];
}

let allowedRootsPromise = null;
let moveRootsPromise = null;
let serviceDirsPromise = null;

/** Real paths of the configured ALLOWED_ROOTS that exist (resolved once). */
export function getAllowedRoots() {
	allowedRootsPromise ??= realpathsOf(config.allowedRoots, "ALLOWED_ROOTS");
	return allowedRootsPromise;
}

/** Real paths of the configured MOVE_ROOTS that exist (resolved once); empty = "move" imports disabled. */
export function getMoveRoots() {
	moveRootsPromise ??= realpathsOf(config.moveRoots ?? [], "MOVE_ROOTS");
	return moveRootsPromise;
}

export async function isAllowedRealPath(realPath) {
	return (await getAllowedRoots()).some((root) => isInside(realPath, root));
}

/** Real paths of the service's private folders (projects/.staging and projects/.jobs). */
function getServiceDirs() {
	serviceDirsPromise ??= fs.realpath(config.projectsDir)
		.catch(() => config.projectsDir)
		.then((projects) => [path.join(projects, path.basename(config.stagingDir)), path.join(projects, path.basename(config.jobsDir))]);
	return serviceDirsPromise;
}

/**
 * Whether a symlink target (real path) may be followed when reading user data: it must lie inside
 * ALLOWED_ROOTS and outside the service's own .staging / .jobs folders.
 */
export async function isFollowableRealPath(realPath) {
	return (await isAllowedRealPath(realPath)) && !(await getServiceDirs()).some((dir) => isInside(realPath, dir));
}

/**
 * Resolve a user-supplied absolute path to its real path and require it to lie inside ALLOWED_ROOTS.
 * Throws 400 (malformed / missing) or 403 (outside the allowed roots).
 */
export async function resolveAllowedPath(input, label = "path") {
	if (typeof input !== "string" || input.trim() === "") {
		throw new HttpError(400, `${label} is required`);
	}
	if (!path.isAbsolute(input) || input.includes("\0")) {
		throw new HttpError(400, `${label} must be an absolute server path: ${input}`);
	}
	let real;
	try {
		real = await fs.realpath(input);
	} catch (err) {
		if (err.code === "ENOENT" || err.code === "ENOTDIR") {
			// Do not reveal anything about paths outside the allowed roots.
			if (!(await isAllowedRealPath(path.resolve(input)))) {
				throw new HttpError(403, `${label} is outside the allowed roots: ${input}`);
			}
			throw new HttpError(400, `${label} does not exist: ${input}`);
		}
		if (err.code === "EACCES") {
			throw new HttpError(403, `${label} is not accessible: ${input}`);
		}
		throw err;
	}
	if (!(await isAllowedRealPath(real))) {
		throw new HttpError(403, `${label} is outside the allowed roots: ${input}`);
	}
	return real;
}

// How many directory entries are processed between two checks of the abort signal and deadline.
const SCAN_CHECK_INTERVAL = 256;

/**
 * Recursively list the regular files below `root` (a real path inside ALLOWED_ROOTS).
 *
 * Symlinks are followed only when their target is followable (inside ALLOWED_ROOTS, outside
 * projects/.staging and projects/.jobs, see isFollowableRealPath); other links, broken or unreadable
 * entries and symlink cycles are skipped and reported with `onSkip(rel, reason)`.
 * Limits: `signal` (AbortSignal) aborts the walk by throwing its reason; the walk stops early with
 * `truncated: true` once `maxFiles` files were seen or when Date.now() passes `deadline` (epoch ms).
 * With `keepFiles: false` only `count` and `bytes` are collected (`files` and `dirs` stay empty).
 *
 * Returns {files: [{rel, size, mode}], dirs: [rel], bytes, count, truncated}.
 */
export async function scanTree(root, { onSkip = () => {}, signal, maxFiles = Infinity, deadline = Infinity, keepFiles = true } = {}) {
	const files = [];
	const dirs = [];
	let bytes = 0;
	let count = 0;
	let truncated = false;
	let sinceCheck = 0;
	// Throws when aborted; true when the time budget is used up.
	const outOfTime = () => {
		signal?.throwIfAborted();
		return Date.now() > deadline;
	};
	const visited = new Set([await fs.realpath(root)]);
	const stack = [""];
	walk: while (stack.length > 0) {
		if (outOfTime()) {
			truncated = true;
			break;
		}
		const rel = stack.pop();
		const abs = path.join(root, rel);
		let entries;
		try {
			entries = await fs.readdir(abs, { withFileTypes: true });
		} catch (err) {
			onSkip(rel, err.code || err.message);
			continue;
		}
		for (const entry of entries) {
			if (++sinceCheck >= SCAN_CHECK_INTERVAL) {
				sinceCheck = 0;
				if (outOfTime()) {
					truncated = true;
					break walk;
				}
			}
			const childRel = rel ? path.join(rel, entry.name) : entry.name;
			const childAbs = path.join(root, childRel);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();
			let st = null;
			if (entry.isSymbolicLink()) {
				let real;
				try {
					real = await fs.realpath(childAbs);
				} catch (err) {
					onSkip(childRel, `broken link or unreadable (${err.code || err.message})`);
					continue;
				}
				if (!(await isFollowableRealPath(real))) {
					onSkip(childRel, "link to a location outside the allowed roots");
					continue;
				}
			}
			if (entry.isSymbolicLink() || isFile) {
				try {
					st = await fs.stat(childAbs);
				} catch (err) {
					onSkip(childRel, `broken link or unreadable (${err.code || err.message})`);
					continue;
				}
				isDir = st.isDirectory();
				isFile = st.isFile();
			}
			if (isDir) {
				const real = await fs.realpath(childAbs);
				if (visited.has(real)) {
					onSkip(childRel, "symlink cycle");
					continue;
				}
				visited.add(real);
				if (keepFiles) {
					dirs.push(childRel);
				}
				stack.push(childRel);
			} else if (isFile) {
				if (count >= maxFiles) {
					truncated = true;
					break walk;
				}
				count++;
				bytes += st.size;
				if (keepFiles) {
					files.push({ rel: childRel, size: st.size, mode: st.mode });
				}
			}
		}
	}
	return { files, dirs, bytes, count, truncated };
}

/** Permissions of a copy: readable by everyone (nginx), never world-writable, no special bits. */
const publicFileMode = (mode) => (mode & 0o775) | 0o444;

/** Add read + traverse permission for everyone to a folder created by the service. */
async function makeDirPublic(dir) {
	const { mode } = await fs.stat(dir);
	if ((mode & 0o555) !== 0o555) {
		await fs.chmod(dir, (mode & 0o7777) | 0o555);
	}
}

/** Copy one file (never overwriting) and make the copy readable by everyone. `mode` = source mode. */
export async function copyPublicFile(src, dest, mode) {
	await fs.copyFile(src, dest, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
	// copyFile keeps the source permissions (the umask does not apply), e.g. 0600 → nginx gets 403.
	await fs.chmod(dest, publicFileMode(mode ?? (await fs.stat(src)).mode));
}

/**
 * Copy a directory tree, following only the symlinks scanTree accepts. Never overwrites existing
 * files; copies are made world-readable (files |= 0444, folders |= 0555) so nginx can serve them.
 * `onProgress({files, totalFiles, bytes, totalBytes})` is called while copying; `signal` aborts.
 */
export async function copyTree(src, dest, { onProgress = () => {}, onSkip, signal, concurrency = 4 } = {}) {
	const tree = await scanTree(src, { onSkip, signal });
	for (const dir of ["", ...tree.dirs]) {
		await fs.mkdir(path.join(dest, dir), { recursive: true });
		await makeDirPublic(path.join(dest, dir));
	}
	const progress = { files: 0, totalFiles: tree.files.length, bytes: 0, totalBytes: tree.bytes };
	onProgress(progress);
	// Workers stop at the first error (or abort) and all of them settle before it is rethrown, so no
	// copy is still writing into `dest` when the caller cleans up.
	let next = 0;
	let error = null;
	const worker = async () => {
		while (error === null && next < tree.files.length) {
			const file = tree.files[next++];
			try {
				signal?.throwIfAborted();
				await copyPublicFile(path.join(src, file.rel), path.join(dest, file.rel), file.mode);
			} catch (err) {
				error ??= err;
				return;
			}
			progress.files++;
			progress.bytes += file.size;
			onProgress(progress);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, tree.files.length) }, worker));
	if (error) {
		throw error;
	}
	return progress;
}

/** Bytes stored below `root` without following symlinks (what the folder itself occupies). */
export async function localTreeSize(root) {
	let bytes = 0;
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(abs);
			} else if (entry.isFile()) {
				bytes += (await fs.lstat(abs)).size;
			}
		}
	}
	return bytes;
}

/** Last `maxLines` lines of a (possibly large) text file; [] when it does not exist. */
export async function readTailLines(file, maxLines, maxBytes = 256 * 1024) {
	let handle;
	try {
		handle = await fs.open(file, "r");
	} catch (err) {
		if (err.code === "ENOENT") {
			return [];
		}
		throw err;
	}
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, size - length);
		const lines = buffer.toString("utf8").split("\n");
		if (length < size) {
			lines.shift(); // first line is probably partial
		}
		if (lines.at(-1) === "") {
			lines.pop();
		}
		return lines.slice(-maxLines);
	} finally {
		await handle.close();
	}
}

/** Free bytes available to this user on the filesystem holding `p`. */
export async function freeBytes(p) {
	const st = await fs.statfs(p);
	return st.bavail * st.bsize;
}
