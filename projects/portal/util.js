// DOM and formatting helpers shared by the portal modules.
// Every piece of text coming from data goes through textContent / setAttribute — never innerHTML.

const PROPS = new Set(["value", "checked", "disabled", "hidden", "selected", "open", "indeterminate"]);
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Create an element. `props` keys: class, text, dataset, on<event> (function), boolean DOM
 * properties (value, checked, disabled, hidden…), anything else becomes an attribute.
 * Children may be nodes, strings (inserted as text), arrays, or null/false (skipped).
 */
export function h(tag, props, ...children) {
	const el = document.createElement(tag);
	if (props) {
		for (const [key, value] of Object.entries(props)) {
			if (value == null || value === false) continue;
			if (key === "class") el.className = value;
			else if (key === "text") el.textContent = value;
			else if (key === "dataset") Object.assign(el.dataset, value);
			else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
			else if (PROPS.has(key)) el[key] = value;
			else el.setAttribute(key, value === true ? "" : String(value));
		}
	}
	append(el, children);
	return el;
}

/** Append children (nodes, text, nested arrays) to `el`. */
export function append(el, children) {
	for (const child of children) {
		if (child == null || child === false || child === true) continue;
		if (Array.isArray(child)) append(el, child);
		else if (child instanceof Node) el.append(child);
		else el.append(document.createTextNode(String(child)));
	}
	return el;
}

/** Inline icon from the sprite in index.html. */
export function icon(name, cls = "") {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", cls ? `icon ${cls}` : "icon");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("focusable", "false");
	const use = document.createElementNS(SVG_NS, "use");
	use.setAttribute("href", `#i-${name}`);
	svg.append(use);
	return svg;
}

/** Replace the children of `el`; accepts the same child forms as h() (null/false are skipped). */
export function setChildren(el, ...children) {
	el.replaceChildren();
	return append(el, children);
}

// ---------------------------------------------------------------------------------------------
// Formatting

const intFormat = new Intl.NumberFormat("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dateTimeFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export const formatInt = (n) => intFormat.format(Math.round(Number(n) || 0));

/** 1697930008 → "1.7 B", 835118491 → "835 M", 6173 → "6.2 k". */
export function formatCompact(n) {
	n = Number(n);
	if (!Number.isFinite(n) || n <= 0) return "0";
	const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]];
	for (let i = 0; i < units.length; i++) {
		const [size, unit] = units[i];
		if (n < size) continue;
		const x = n / size;
		const text = x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, "");
		// 999.96 M rounds to "1000 M": promote to the next unit instead.
		if (Number(text) >= 1000 && i > 0) return `${(n / units[i - 1][0]).toFixed(1).replace(/\.0$/, "")} ${units[i - 1][1]}`;
		return `${text} ${unit}`;
	}
	return String(Math.round(n));
}

export function formatBytes(n) {
	n = Number(n);
	if (!Number.isFinite(n) || n < 0) return "";
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	let i = 0;
	while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
	return `${i === 0 ? n : n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/** "2025-12-10" → "10 Dec 2025", "2020-04" → "Apr 2020", anything else unchanged. */
export function formatDate(value) {
	if (value == null || value === "") return "";
	const s = String(value).trim();
	let m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s);
	if (m && +m[2] >= 1 && +m[2] <= 12) return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
	m = /^(\d{4})-(\d{2})$/.exec(s);
	if (m && +m[2] >= 1 && +m[2] <= 12) return `${MONTHS[+m[2] - 1]} ${m[1]}`;
	return s;
}

export function formatDateTime(iso) {
	const t = Date.parse(iso);
	return Number.isFinite(t) ? dateTimeFormat.format(t) : "";
}

/**
 * "3 minutes ago", "yesterday", "last month"… Timestamps in the future (server and browser clocks
 * that disagree, files touched by a skewed NFS client) are clamped: they read "just now".
 */
export function relativeTime(iso, now = Date.now()) {
	const t = typeof iso === "number" ? iso : Date.parse(iso);
	if (!Number.isFinite(t)) return "";
	const seconds = (t - now) / 1000;
	if (seconds > -45) return "just now";
	const steps = [[3600, 60, "minute"], [86400, 3600, "hour"], [604800, 86400, "day"],
		[2629800, 604800, "week"], [31557600, 2629800, "month"], [Infinity, 31557600, "year"]];
	for (const [limit, div, unit] of steps) {
		if (-seconds < limit) return relativeFormat.format(Math.min(-1, Math.round(seconds / div)), unit);
	}
	return "";
}

/** Milliseconds → "45 s", "3 min 12 s", "1 h 05 min". */
export function formatDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s} s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
	return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

export function crsLabel(crs) {
	if (crs == null || crs === "") return "No CRS";
	if (crs === "local") return "Local coordinates";
	return String(crs);
}

export function plural(n, one, many = `${one}s`) {
	return `${formatInt(n)} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------------------------
// Text

/** Lowercase and strip diacritics, for accent-insensitive search ("Neuchatel" finds "Neuchâtel"). */
export function fold(s) {
	return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function slugify(s) {
	return fold(s)
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
		.replace(/-+$/, "");
}

/** Two-letter monogram from a title: "Arolla — power line" → "AP". */
export function initials(title) {
	const words = String(title ?? "").split(/[\s—–,·:/()-]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
	return words.slice(0, 2).map((w) => [...w][0].toUpperCase()).join("") || "?";
}

/** Base name of a path ("/a/b/c.gpkg" → "c.gpkg"). */
export function basename(p) {
	return String(p ?? "").replace(/\/+$/, "").split("/").pop() || "";
}

/** 32-bit FNV-1a hash, used to seed deterministic placeholders. */
export function hashString(s) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

export function debounce(fn, ms) {
	let timer = 0;
	const wrapped = (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	};
	wrapped.cancel = () => clearTimeout(timer);
	return wrapped;
}

export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------------------------------------
// Dialogs

/**
 * Common <dialog> behaviour: [data-close] buttons close it, an optional backdrop click closes it
 * (only when both press and release happen on the backdrop, so text selection drags are safe).
 */
export function wireDialog(dialog, { lightDismiss = false } = {}) {
	dialog.addEventListener("click", (event) => {
		if (event.target.closest("[data-close]")) dialog.close();
	});
	if (lightDismiss) {
		let downOnBackdrop = false;
		dialog.addEventListener("pointerdown", (event) => { downOnBackdrop = event.target === dialog; });
		dialog.addEventListener("click", (event) => {
			if (downOnBackdrop && event.target === dialog) dialog.close();
			downOnBackdrop = false;
		});
	}
}
