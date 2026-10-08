// Service configuration, read once from the environment (see server/README.md).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "1.0.0";

/** Coordinates files of 360° images larger than this are refused (inspect, create, registry stats). */
export const MAX_COORDINATES_BYTES = 64 * 1024 * 1024;

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;

const potreeRoot = path.resolve(env.POTREE_ROOT || "/mnt/Data2/potree");
const projectsDir = path.resolve(env.PROJECTS_DIR || path.join(potreeRoot, "projects"));
const projectsRel = path.relative(potreeRoot, projectsDir).split(path.sep).join("/");

function parsePort(value, fallback) {
	const port = Number.parseInt(value ?? "", 10);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

/** Real paths of the existing directories of a colon-separated list of absolute paths (others are ignored with a warning). */
function existingRealDirs(value, name) {
	const dirs = [];
	for (const entry of (value ?? "").split(":").map((p) => p.trim()).filter(Boolean)) {
		if (!path.isAbsolute(entry)) {
			console.warn(`[config] ${name} entry is not an absolute path and is ignored: ${entry}`);
			continue;
		}
		try {
			const real = fs.realpathSync(entry);
			if (!fs.statSync(real).isDirectory()) {
				throw new Error("not a directory");
			}
			if (!dirs.includes(real)) {
				dirs.push(real);
			}
		} catch {
			console.warn(`[config] ${name} entry is not an existing folder and is ignored: ${entry}`);
		}
	}
	return Object.freeze(dirs);
}

const apiToken = (env.API_TOKEN ?? "").trim() || null;
if (apiToken !== null && apiToken.length < 16) {
	console.warn("[config] API_TOKEN is shorter than 16 characters; use a long random value (e.g. openssl rand -hex 32)");
}

// "move" imports relocate the source folder, so they are only offered below MOVE_ROOTS (default: none).
const moveRoots = existingRealDirs(env.MOVE_ROOTS, "MOVE_ROOTS");

export const config = Object.freeze({
	host: env.HOST || "127.0.0.1",
	port: parsePort(env.PORT, 8090),
	potreeRoot,
	projectsDir,
	// URL path under which PROJECTS_DIR is reachable when POTREE_ROOT is served at "/" (previews need
	// PROJECTS_DIR inside POTREE_ROOT).
	projectsUrlPath: projectsRel ? `/${projectsRel}` : "",
	stagingDir: path.join(projectsDir, ".staging"),
	jobsDir: path.join(projectsDir, ".jobs"),
	registryFile: path.join(projectsDir, "registry.json"),
	converter: env.POTREE_CONVERTER || "/mnt/Data2/PotreeConverter/build/PotreeConverter",
	allowedRoots: (env.ALLOWED_ROOTS || "/mnt/Data2").split(":").filter(Boolean).map((p) => path.resolve(p)),
	moveRoots,
	// Import modes accepted for new projects; "move" only when MOVE_ROOTS names at least one folder.
	importModes: Object.freeze(moveRoots.length > 0 ? ["copy", "symlink", "move"] : ["copy", "symlink"]),
	// Shared secret for the protected API endpoints (null = not configured: those endpoints answer 503).
	apiToken,
	previewBaseUrl: env.PREVIEW_BASE_URL ? env.PREVIEW_BASE_URL.replace(/\/+$/, "") : null,
	templateFile: path.join(SERVER_DIR, "templates", "project.html"),
	// Shared CRS table of the viewer runtime (ES module, also importable from Node).
	crsModule: path.resolve(SERVER_DIR, "..", "projects", "shared", "crs.js"),
});

/** Folder names inside PROJECTS_DIR that are not projects and can never be used as ids. */
export const RESERVED_IDS = new Set(["shared", "portal"]);
