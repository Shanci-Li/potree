// Access to the viewer's shared CRS table (projects/shared/crs.js) and proj4 validation.

import { pathToFileURL } from "node:url";
import proj4 from "proj4";
import { config } from "./config.mjs";
import { HttpError } from "./util.mjs";

let crsModulePromise = null;

async function getCrsModule() {
	// projects/shared/package.json marks the folder as ESM, so Node can import the browser module.
	crsModulePromise ??= import(pathToFileURL(config.crsModule).href).catch((err) => {
		crsModulePromise = null; // retry on the next call (the file may be added later)
		throw new HttpError(503, `CRS table not available (${config.crsModule}): ${err.message}`);
	});
	return crsModulePromise;
}

export async function getCrsList() {
	const { CRS_LIST } = await getCrsModule();
	return CRS_LIST;
}

/** Canonical spelling of a CRS name: "2056" and "epsg:2056" become "EPSG:2056". */
export function canonicalCrsName(name) {
	const text = String(name).trim();
	if (/^\d+$/.test(text)) {
		return `EPSG:${text}`;
	}
	const m = /^([a-z]+):(.+)$/i.exec(text);
	return m ? `${m[1].toUpperCase()}:${m[2]}` : text;
}

/** proj4 definition of a CRS name from `extraDefs` or the built-in table, else null. */
export async function lookupProj4(name, extraDefs = {}) {
	if (!name) {
		return null;
	}
	const { getProj4 } = await getCrsModule();
	return getProj4(name, extraDefs) ?? null;
}

/** Throws a 400 error unless `def` is a proj4 string that proj4 can parse and that is safe to embed. */
export function assertValidProj4(def, label) {
	if (typeof def !== "string" || def.trim() === "" || def.length > 2000) {
		throw new HttpError(400, `${label} must be a non-empty proj4 string`);
	}
	// PotreeConverter writes --projection verbatim between quotes into metadata.json.
	if (/["\\\r\n\t]/.test(def)) {
		throw new HttpError(400, `${label} must not contain quotes, backslashes or line breaks`);
	}
	if (/^\s*-/.test(def)) {
		throw new HttpError(400, `${label} must not start with "-"`);
	}
	try {
		proj4(def);
	} catch (err) {
		throw new HttpError(400, `${label} is not a valid proj4 definition${err?.message ? `: ${err.message}` : ""}`);
	}
	return def.trim();
}
