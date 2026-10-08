// Small shared helpers: HTTP errors, ids/slugs, HTML escaping, atomic writes.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/** Error carrying an HTTP status; the API turns it into `{error, details?}`. */
export class HttpError extends Error {
	constructor(status, message, details) {
		super(message);
		this.status = status;
		if (details !== undefined) {
			this.details = details;
		}
	}
}

export const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function isValidId(id) {
	return typeof id === "string" && ID_RE.test(id);
}

/** Lower-case ASCII slug ("Ollon — IDW" → "ollon-idw"), at most `maxLength` characters. */
export function slugify(text, maxLength = 63) {
	return String(text ?? "")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, maxLength)
		.replace(/-+$/, "");
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text) {
	return String(text ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export function nowIso() {
	return new Date().toISOString();
}

/** True when `child` is `parent` itself or lies below it (both absolute, normalised). */
export function isInside(child, parent) {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** A plain relative path without "..", absolute or empty segments (for names taken from requests). */
export function isSafeRelativePath(p) {
	if (typeof p !== "string" || p.length === 0 || p.length > 255 || path.isAbsolute(p) || p.includes("\0")) {
		return false;
	}
	return p.split(/[\\/]/).every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function formatBytes(bytes) {
	if (!Number.isFinite(bytes)) {
		return "?";
	}
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatCount(n) {
	return Number(n).toLocaleString("en-US");
}

/** Write a file via a hidden temporary sibling + rename, so readers never see a partial file. */
export async function writeFileAtomic(file, data) {
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
	try {
		await fs.writeFile(tmp, data);
		await fs.rename(tmp, file);
	} catch (err) {
		await fs.rm(tmp, { force: true });
		throw err;
	}
}

export async function writeJsonAtomic(file, value) {
	await writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

export async function readJson(file) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

/** fs.stat that returns null instead of throwing for missing paths. */
export async function statOrNull(p) {
	try {
		return await fs.stat(p);
	} catch (err) {
		if (err.code === "ENOENT" || err.code === "ENOTDIR" || err.code === "ELOOP") {
			return null;
		}
		throw err;
	}
}

export async function lstatOrNull(p) {
	try {
		return await fs.lstat(p);
	} catch (err) {
		if (err.code === "ENOENT" || err.code === "ENOTDIR") {
			return null;
		}
		throw err;
	}
}

/** Run `fn` over `items` with at most `limit` concurrent calls; results keep the input order. */
export async function mapLimit(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

/** Serialises async operations (e.g. registry rebuilds) so they never overlap. */
export function createMutex() {
	let tail = Promise.resolve();
	return function runExclusive(fn) {
		const result = tail.then(() => fn());
		tail = result.catch(() => {});
		return result;
	};
}

/**
 * Runs at most `max` async operations at a time. Up to `maxWaiting` further callers wait for a slot;
 * beyond that the call fails with 429. A waiting caller whose `signal` aborts leaves the queue.
 */
export function createLimiter(max, maxWaiting) {
	let active = 0;
	const waiting = [];
	function release() {
		const next = waiting.shift();
		if (next) {
			next.start(); // the slot passes directly to the next caller
		} else {
			active--;
		}
	}
	return async function runLimited(fn, signal) {
		signal?.throwIfAborted();
		if (active < max) {
			active++;
		} else {
			if (waiting.length >= maxWaiting) {
				throw new HttpError(429, "too many requests of this kind are in progress; try again shortly");
			}
			await new Promise((resolve, reject) => {
				const onAbort = () => {
					waiting.splice(waiting.indexOf(entry), 1);
					reject(signal.reason);
				};
				const entry = {
					start: () => {
						signal?.removeEventListener("abort", onAbort);
						resolve();
					},
				};
				signal?.addEventListener("abort", onAbort, { once: true });
				waiting.push(entry);
			});
		}
		try {
			return await fn();
		} finally {
			release();
		}
	};
}
