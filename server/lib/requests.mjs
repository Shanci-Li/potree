// Validation and normalisation of request bodies (project metadata, viewer, material, view).

import { HttpError } from "./util.mjs";

export function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Optional trimmed string (null when absent or empty). */
export function optionalString(value, label, maxLength = 500) {
	if (value === undefined || value === null) {
		return null;
	}
	if (typeof value !== "string") {
		throw new HttpError(400, `${label} must be a string`);
	}
	const text = value.trim();
	if (text.length > maxLength) {
		throw new HttpError(400, `${label} is too long (max ${maxLength} characters)`);
	}
	return text === "" ? null : text;
}

export function requiredString(value, label, maxLength = 500) {
	const text = optionalString(value, label, maxLength);
	if (text === null) {
		throw new HttpError(400, `${label} is required`);
	}
	return text;
}

/** Keywords as an array of strings (a comma-separated string is accepted too), deduplicated. */
export function normalizeKeywords(value) {
	if (value === undefined || value === null) {
		return [];
	}
	const list = typeof value === "string" ? value.split(",") : value;
	if (!Array.isArray(list) || list.some((k) => typeof k !== "string")) {
		throw new HttpError(400, "keywords must be an array of strings");
	}
	const keywords = [...new Set(list.map((k) => k.trim()).filter(Boolean))];
	if (keywords.length > 30 || keywords.some((k) => k.length > 60)) {
		throw new HttpError(400, "keywords: at most 30 keywords of at most 60 characters");
	}
	return keywords;
}

export const METADATA_FIELDS = ["title", "description", "keywords", "location", "date", "source"];

/**
 * Normalise the editable metadata fields. With `partial`, only fields present in `body` are
 * returned (PATCH); otherwise all are returned with defaults and the title is required.
 */
export function normalizeMetadata(body, { partial = false } = {}) {
	const has = (key) => !partial || Object.hasOwn(body, key);
	const out = {};
	if (has("title")) {
		out.title = requiredString(body.title, "title", 200);
	}
	if (has("description")) {
		out.description = optionalString(body.description, "description", 10000) ?? "";
	}
	if (has("keywords")) {
		out.keywords = normalizeKeywords(body.keywords);
	}
	for (const key of ["location", "date", "source"]) {
		if (has(key)) {
			out[key] = optionalString(body[key], key, 200);
		}
	}
	return out;
}

function oneOf(value, allowed, label) {
	if (!allowed.includes(value)) {
		throw new HttpError(400, `${label} must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`);
	}
	return value;
}

function numberIn(value, min, max, label, { integer = false } = {}) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
		throw new HttpError(400, `${label} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`);
	}
	return value;
}

function booleanValue(value, label) {
	if (typeof value !== "boolean") {
		throw new HttpError(400, `${label} must be true or false`);
	}
	return value;
}

function matching(value, re, label) {
	if (typeof value !== "string" || !re.test(value)) {
		throw new HttpError(400, `${label} has an invalid value: ${JSON.stringify(value)}`);
	}
	return value;
}

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,63}$/;

const VIEWER_DEFAULTS = Object.freeze({
	pointBudget: 2_000_000,
	fov: 60,
	edl: true,
	controls: "earth",
	classificationScheme: null,
	language: "en",
	sidebar: true,
});

/** project.json "viewer" from the request (unknown keys rejected, defaults filled in). */
export function normalizeViewer(input) {
	if (input !== undefined && input !== null && !isPlainObject(input)) {
		throw new HttpError(400, "viewer must be an object");
	}
	const v = input ?? {};
	const out = { ...VIEWER_DEFAULTS };
	const validators = {
		pointBudget: (x) => numberIn(x, 10_000, 100_000_000, "viewer.pointBudget", { integer: true }),
		fov: (x) => numberIn(x, 10, 150, "viewer.fov"),
		edl: (x) => booleanValue(x, "viewer.edl"),
		controls: (x) => oneOf(x, ["earth", "orbit", "fly"], "viewer.controls"),
		classificationScheme: (x) => (x === null ? null : matching(x, NAME_RE, "viewer.classificationScheme")),
		background: (x) => (x === null ? null : oneOf(x, ["gradient", "skybox", "black", "white"], "viewer.background")),
		language: (x) => matching(x, /^[a-z]{2}(-[A-Za-z]{2})?$/, "viewer.language"),
		openMenus: (x) => {
			if (!Array.isArray(x) || x.length > 20) {
				throw new HttpError(400, "viewer.openMenus must be an array of menu names");
			}
			return x.map((m) => matching(m, /^[a-z_]{1,32}$/, "viewer.openMenus[]"));
		},
		sidebar: (x) => booleanValue(x, "viewer.sidebar"),
		description: (x) => optionalString(x, "viewer.description", 5000) ?? "",
	};
	for (const [key, value] of Object.entries(v)) {
		// Own keys only: "constructor", "__proto__" etc. must not reach inherited Object members.
		if (!Object.hasOwn(validators, key)) {
			throw new HttpError(400, `unknown viewer option: ${key}`);
		}
		if (value !== undefined) {
			out[key] = validators[key](value);
		}
	}
	return out;
}

const MATERIAL_DEFAULTS = Object.freeze({
	activeAttribute: "rgba",
	size: 0.7,
	pointSizeType: "ADAPTIVE",
	shape: "SQUARE",
});

/** pointclouds[0].material from the request (unknown keys rejected, defaults filled in). */
export function normalizeMaterial(input) {
	if (input !== undefined && input !== null && !isPlainObject(input)) {
		throw new HttpError(400, "material must be an object");
	}
	const m = input ?? {};
	const out = { ...MATERIAL_DEFAULTS };
	const attributeMap = (x, label, valueFn) => {
		if (!isPlainObject(x)) {
			throw new HttpError(400, `${label} must be an object keyed by attribute name`);
		}
		return Object.fromEntries(Object.entries(x).map(([attr, val]) => [matching(attr, NAME_RE, `${label} key`), valueFn(val, `${label}.${attr}`)]));
	};
	const validators = {
		activeAttribute: (x) => matching(x, NAME_RE, "material.activeAttribute"),
		gradient: (x) => (x === null ? null : matching(x, /^[A-Za-z0-9_]{1,32}$/, "material.gradient")),
		size: (x) => numberIn(x, 0.01, 20, "material.size"),
		minSize: (x) => numberIn(x, 0, 20, "material.minSize"),
		pointSizeType: (x) => oneOf(x, ["FIXED", "ATTENUATED", "ADAPTIVE"], "material.pointSizeType"),
		shape: (x) => oneOf(x, ["SQUARE", "CIRCLE", "PARABOLOID"], "material.shape"),
		ranges: (x) => attributeMap(x, "material.ranges", (r, label) => {
			if (!Array.isArray(r) || r.length !== 2 || !r.every(Number.isFinite)) {
				throw new HttpError(400, `${label} must be [min, max]`);
			}
			return r;
		}),
		gradients: (x) => attributeMap(x, "material.gradients", (g, label) => matching(g, /^[A-Za-z0-9_]{1,32}$/, label)),
	};
	for (const [key, value] of Object.entries(m)) {
		if (!Object.hasOwn(validators, key)) {
			throw new HttpError(400, `unknown material option: ${key}`);
		}
		if (value !== undefined) {
			out[key] = validators[key](value);
		}
	}
	if (out.gradient === null) {
		delete out.gradient;
	}
	return out;
}

/** {position, target} with three finite numbers each, or null (fit to screen). `label` names the field. */
export function normalizeView(input, label = "view") {
	if (input === undefined || input === null) {
		return null;
	}
	const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
	if (!isPlainObject(input) || !isVec3(input.position) || !isVec3(input.target)) {
		throw new HttpError(400, `${label} must be null or {position: [x, y, z], target: [x, y, z]}`);
	}
	return { position: input.position, target: input.target };
}
