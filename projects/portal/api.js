// Thin client for the project service HTTP API (SPEC §5) plus a static JSON fetch helper.
// Protected endpoints (every write, /fs/*, /jobs) go through the access-token layer (auth.js).

export class ApiError extends Error {
	/**
	 * @param {string} message
	 * @param {object} [info]
	 * @param {number} [info.status]   HTTP status (0 = no response)
	 * @param {*} [info.details]       the server's `details`
	 * @param {string|null} [info.auth] the server's `auth` marker: "token" (401) or "unconfigured" (503)
	 */
	constructor(message, { status = 0, details = null, auth = null } = {}) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.details = details;
		this.auth = auth;
	}
}

/** API base URL from <meta name="potree-api" content="/api"> (default "/api"), without trailing slash. */
export function resolveApiBase(doc = document) {
	const raw = doc.querySelector('meta[name="potree-api"]')?.getAttribute("content")?.trim();
	return (raw || "/api").replace(/\/+$/, "");
}

/**
 * fetch() + JSON decoding with a timeout; errors become ApiError with the server's message.
 * With `withResponse` the result is `{ data, response }` so callers can read headers.
 */
export async function fetchJson(url, { method = "GET", body, headers: extraHeaders, timeout = 20000, withResponse = false } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);
	const headers = { Accept: "application/json", ...extraHeaders };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	let response, text;
	try {
		response = await fetch(url, {
			method, headers, cache: "no-store", signal: controller.signal,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		text = await response.text();
	} catch (err) {
		throw new ApiError(err?.name === "AbortError" ? "The request timed out." : "The server could not be reached.");
	} finally {
		clearTimeout(timer);
	}
	let data = null;
	if (text) {
		try { data = JSON.parse(text); } catch { /* handled below */ }
	}
	if (!response.ok) {
		const message = (data && typeof data.error === "string" && data.error) || `${response.status} ${response.statusText}`.trim();
		throw new ApiError(message, {
			status: response.status,
			details: data?.details ?? null,
			auth: typeof data?.auth === "string" ? data.auth : null,
		});
	}
	if (data === null) throw new ApiError("The server sent an unexpected (non-JSON) response.", { status: response.status });
	return withResponse ? { data, response } : data;
}

/** "a%20b; c" (X-Warnings header) → ["a b", "c"]. */
function parseWarnings(header) {
	if (!header) return [];
	let text = header;
	try { text = decodeURIComponent(header); } catch { /* not encoded */ }
	return text.split("; ").map((w) => w.trim()).filter(Boolean);
}

/**
 * @param {string} base  API base URL
 * @param {import("./auth.js").Auth} auth  access-token layer for the protected endpoints
 */
export function createApi(base, auth) {
	const url = (path, query) => {
		let out = base + path;
		if (query) {
			const params = new URLSearchParams();
			for (const [key, value] of Object.entries(query)) if (value != null && value !== "") params.set(key, value);
			const qs = params.toString();
			if (qs) out += `?${qs}`;
		}
		return out;
	};
	const id = encodeURIComponent;
	/**
	 * A protected call. `background` calls (job polling) never open the token dialog: without a
	 * valid token they fail with status 401 and the caller decides what to show.
	 */
	const guarded = (path, options = {}, { query, background = false } = {}) =>
		auth.request((headers) => fetchJson(url(path, query), { ...options, headers }), { background });

	return {
		base,
		// Open endpoints
		health: () => fetchJson(url("/health"), { timeout: 2500 }),
		projects: () => fetchJson(url("/projects")),
		project: (projectId) => fetchJson(url(`/projects/${id(projectId)}`)),
		crs: () => fetchJson(url("/crs")),
		// Protected endpoints
		createProject: (request) => guarded("/projects", { method: "POST", body: request }),
		/** PATCH metadata → `{ project, warnings }` (warnings: page/registry not regenerated, from X-Warnings). */
		updateProject: async (projectId, patch) => {
			const { data, response } = await guarded(`/projects/${id(projectId)}`, { method: "PATCH", body: patch, withResponse: true });
			return { project: data, warnings: parseWarnings(response.headers.get("X-Warnings")) };
		},
		renderPreview: (projectId) => guarded(`/projects/${id(projectId)}/preview`, { method: "POST", body: {} }),
		jobs: ({ background = true } = {}) => guarded("/jobs", {}, { background }),
		job: (jobId) => guarded(`/jobs/${id(jobId)}`, { timeout: 10000 }, { background: true }),
		/** `q`: case-insensitive name filter applied by the server before its 500-entry cap. */
		listDir: (path, ext, q) => guarded("/fs/list", {}, { query: { path, ext, q } }),
		inspect: (path, kind, extra = {}) => guarded("/fs/inspect", { timeout: 60000 }, { query: { path, kind, ...extra } }),
		/** Check a candidate token with a cheap protected request (used by the token dialog). */
		verifyToken: (token) => fetchJson(url("/jobs"), { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }),
	};
}
