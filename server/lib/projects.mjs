// Operations on existing projects: metadata updates (PATCH) and on-disk validation (CLI validate).

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.mjs";
import { lookupProj4 } from "./crs.mjs";
import { writeProjectPage } from "./page.mjs";
import { isRemoteUrl, projectDir, readProject, resolveProjectUrl, updateRegistryFile, writeProject } from "./registry.mjs";
import { METADATA_FIELDS, isPlainObject, normalizeMetadata } from "./requests.mjs";
import { HttpError, createMutex, isInside, isSafeRelativePath, nowIso, readJson, statOrNull } from "./util.mjs";

// Per-project mutexes (entries exist only while a project has pending updates).
const projectLocks = new Map();

/** Run `fn` exclusively for project `id`, so read-modify-write cycles of project.json never interleave. */
function withProjectLock(id, fn) {
	let lock = projectLocks.get(id);
	if (!lock) {
		lock = { run: createMutex(), pending: 0 };
		projectLocks.set(id, lock);
	}
	lock.pending++;
	return lock.run(fn).finally(() => {
		if (--lock.pending === 0) {
			projectLocks.delete(id);
		}
	});
}

/**
 * PATCH /api/projects/:id — only title, description, keywords, location, date and source.
 * Bumps updatedAt, regenerates the page title of non-custom projects and the registry.
 * Optional `expectedUpdatedAt` (the updatedAt the client last read): when the project has changed
 * since, nothing is written and 409 is returned (optimistic concurrency for editors that send every
 * field). Returns {project, warnings}.
 */
export async function patchProject(id, body) {
	if (!isPlainObject(body)) {
		throw new HttpError(400, "request body must be a JSON object");
	}
	const { expectedUpdatedAt, ...fields } = body;
	if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null && typeof expectedUpdatedAt !== "string") {
		throw new HttpError(400, "expectedUpdatedAt must be the updatedAt string of the project as last read");
	}
	const unknown = Object.keys(fields).filter((key) => !METADATA_FIELDS.includes(key));
	if (unknown.length > 0) {
		throw new HttpError(400, `only ${METADATA_FIELDS.join(", ")} can be changed`, { unknownFields: unknown });
	}
	const changes = normalizeMetadata(fields, { partial: true });
	if (Object.keys(changes).length === 0) {
		throw new HttpError(400, `nothing to update; send one of ${METADATA_FIELDS.join(", ")}`);
	}

	const warnings = [];
	// project.json and the page generated from it are updated under the project's lock.
	const project = await withProjectLock(id, async () => {
		const current = await readProject(id);
		if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== (current.updatedAt ?? null)) {
			throw new HttpError(409, "the project was changed by someone else since it was loaded; reload it and apply your changes again", { updatedAt: current.updatedAt ?? null });
		}
		Object.assign(current, changes, { updatedAt: nowIso() });
		await writeProject(id, current);
		if (current.custom !== true) {
			try {
				await writeProjectPage(projectDir(id), id, current);
			} catch (err) {
				warnings.push(`page not regenerated: ${err.message}`);
			}
		}
		return current;
	});
	try {
		await updateRegistryFile();
	} catch (err) {
		warnings.push(`registry not updated: ${err.message}`);
	}
	return { project, warnings };
}

/**
 * Check a project folder: project.json schema basics and that every relative URL it references
 * exists on disk (broken symlinks count as missing). Returns {id, errors[], warnings[]}.
 */
export async function validateProject(id) {
	const errors = [];
	const warnings = [];
	const dir = projectDir(id);
	let project;
	try {
		project = await readProject(id);
	} catch (err) {
		return { id, errors: [err.message], warnings };
	}

	const check = async (url, label, { kind = "any", optional = false } = {}) => {
		if (url === undefined || url === null || url === "") {
			if (!optional) {
				errors.push(`${label}: missing URL`);
			}
			return null;
		}
		if (isRemoteUrl(url)) {
			warnings.push(`${label}: remote URL not checked (${url})`);
			return null;
		}
		const file = resolveProjectUrl(dir, url);
		if (!file) {
			errors.push(`${label}: invalid URL ${JSON.stringify(url)} (must be relative and stay inside ${config.potreeRoot})`);
			return null;
		}
		if (!isInside(file, dir)) {
			warnings.push(`${label}: ${url} lies outside the project folder`);
		}
		const st = await statOrNull(file);
		if (!st) {
			const link = await fs.lstat(file).catch(() => null);
			errors.push(`${label}: ${url} ${link?.isSymbolicLink() ? "is a broken symlink" : "does not exist"}`);
			return null;
		}
		if (kind === "file" && !st.isFile()) {
			errors.push(`${label}: ${url} is not a file`);
		} else if (kind === "dir" && !st.isDirectory()) {
			errors.push(`${label}: ${url} is not a folder`);
		}
		return file;
	};

	if (project.schemaVersion !== 1) {
		errors.push(`schemaVersion must be 1 (found ${JSON.stringify(project.schemaVersion)})`);
	}
	if (project.id !== id) {
		errors.push(`id "${project.id}" does not match the folder name "${id}"`);
	}
	if (typeof project.title !== "string" || project.title.trim() === "") {
		errors.push("title is missing");
	}
	if (project.crs && project.crs !== "local" && !(await lookupProj4(project.crs, project.crsDefs ?? {}).catch(() => null))) {
		errors.push(`crs ${project.crs} has no proj4 definition (crsDefs or built-in table)`);
	}

	await check(project.entry || "index.html", "entry", { kind: "file" });
	const previewName = project.preview || "preview.jpg";
	if (!isSafeRelativePath(previewName)) {
		errors.push(`preview: invalid file name ${JSON.stringify(previewName)}`);
	} else if (!(await statOrNull(path.join(dir, previewName)))) {
		warnings.push(`preview ${previewName} has not been rendered yet`);
	}

	if (!Array.isArray(project.pointclouds) || project.pointclouds.length === 0) {
		errors.push("pointclouds: at least one point cloud is required");
	}
	for (const [i, pc] of (project.pointclouds ?? []).entries()) {
		const file = await check(pc.url, `pointclouds[${i}].url`, { kind: "file" });
		if (file && path.basename(file) === "metadata.json") {
			for (const part of ["hierarchy.bin", "octree.bin"]) {
				if (!(await statOrNull(path.join(path.dirname(file), part)))) {
					errors.push(`pointclouds[${i}]: ${part} missing next to metadata.json`);
				}
			}
		}
	}

	const i360 = project.images360;
	if (i360) {
		const base = await check(i360.url, "images360.url", { kind: "dir" });
		if (base) {
			await check(`${i360.url.replace(/\/+$/, "")}/${i360.coordinatesFile || "coordinates.txt"}`, "images360.coordinatesFile", { kind: "file" });
		}
		for (const [i, set] of (i360.labelSets ?? []).entries()) {
			await check(set.url, `images360.labelSets[${i}] (${set.name ?? set.id})`, { kind: "dir" });
		}
	}

	for (const [i, vector] of (project.vectors ?? []).entries()) {
		if (vector.manifest) {
			const manifest = await check(vector.manifest, `vectors[${i}].manifest`, { kind: "file" });
			if (manifest) {
				try {
					const content = await readJson(manifest);
					for (const entry of content.files ?? []) {
						const rel = path.posix.join(path.posix.dirname(vector.manifest), entry.file);
						await check(rel, `vectors[${i}].manifest → ${entry.file}`, { kind: "file" });
					}
				} catch (err) {
					errors.push(`vectors[${i}].manifest is not valid JSON: ${err.message}`);
				}
			}
		} else {
			await check(vector.url, `vectors[${i}].url`, { kind: "file" });
		}
	}
	for (const [i, mesh] of (project.meshes ?? []).entries()) {
		await check(mesh.url, `meshes[${i}].url`, { kind: "file" });
	}
	return { id, errors, warnings };
}
