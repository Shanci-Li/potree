// Project portal entry point: loads the registry (live from the project service when it answers,
// else the static registry.json), renders the searchable gallery, and wires the details drawer,
// the "New project" wizard, the path picker, the job tracker and the access token.

import { h, icon, setChildren, formatInt, formatCompact, relativeTime, fold, debounce, plural } from "./util.js";
import { createApi, resolveApiBase, fetchJson } from "./api.js";
import { Auth } from "./auth.js";
import { previewMedia } from "./placeholder.js";
import { badgeList, metaLine, statList } from "./present.js";
import { JobCenter } from "./jobs.js";
import { PathPicker } from "./picker.js";
import { Wizard } from "./wizard.js";
import { DetailsPanel } from "./details.js";

const REGISTRY_URL = "registry.json";
const TOP_KEYWORDS = 10;
const CARD_KEYWORDS = 5;
const SORTS = ["updated", "title", "points"];
const DEFAULT_SORT = "updated";

const $ = (id) => document.getElementById(id);

const state = {
	mode: "loading",        // loading | live | static
	health: null,           // last GET /health response
	registry: null,
	projects: [],
	loadError: null,
	query: "",
	keywords: new Set(),    // folded keyword keys
	sort: DEFAULT_SORT,
	showAllKeywords: false,
	highlight: null,        // project id to flash after creation
};

const auth = new Auth({ verify: (token) => api.verifyToken(token) });
const api = createApi(resolveApiBase(), auth);

/** "ok": projects can be created and edited; "unconfigured": the service has no access token set
 *  up, so writes are disabled; "offline": no service (static registry). */
function editState() {
	if (state.mode !== "live") return "offline";
	return auth.status === "unconfigured" ? "unconfigured" : "ok";
}

// ---------------------------------------------------------------------------------------------
// Toasts

const TOAST_ICON = { success: "check", error: "alert-circle", info: "info" };

function toast(message, { kind = "info", action = null, timeout = 7000 } = {}) {
	const host = $("toasts");
	let timer = 0;
	const dismiss = () => {
		clearTimeout(timer);
		el.classList.add("is-leaving");
		setTimeout(() => el.remove(), 200);
	};
	let actionEl = null;
	if (action?.href) actionEl = h("a", { class: "toast-action", href: action.href }, action.label);
	else if (action?.onClick) actionEl = h("button", { type: "button", class: "toast-action", onclick: () => { dismiss(); action.onClick(); } }, action.label);
	const el = h("div", { class: `toast toast-${kind}` },
		icon(TOAST_ICON[kind] || "info"),
		h("p", { text: message }),
		actionEl,
		h("button", { type: "button", class: "icon-btn sm", "aria-label": "Dismiss", onclick: dismiss }, icon("x")));
	host.append(el);
	timer = setTimeout(dismiss, timeout);
}

// ---------------------------------------------------------------------------------------------
// Components

const jobs = new JobCenter({
	api,
	onFinished: (job) => jobFinished(job),
	onRetry: (job) => wizard.retry(job.id),
	projectUrl: (job) => projectUrl(job),
	onSignIn: () => auth.prompt(),
});
const picker = new PathPicker(api);
const wizard = new Wizard({
	api, picker, jobs,
	getProjects: () => state.projects,
	getKeywords: () => keywordStats().map((k) => k.label),
	getHealth: () => state.health,
});
const details = new DetailsPanel({
	api, jobs,
	isLive: () => state.mode === "live",
	editState,
	ensureAccess: () => auth.ensure(),
	getHealth: () => state.health,
	getKeywords: () => keywordStats().map((k) => k.label),
	onKeyword: (keyword) => {
		state.keywords = new Set([fold(keyword)]);
		state.showAllKeywords = state.showAllKeywords || !keywordStats().slice(0, TOP_KEYWORDS).some((k) => k.key === fold(keyword));
		render();
		$("grid").focus({ preventScroll: true });
		$("keyword-chips").scrollIntoView({ block: "nearest" });
	},
	onUpdated: () => refreshRegistry(),
});

function projectUrl(job) {
	const project = state.projects.find((p) => p.id === job.projectId);
	if (project) return project.url;
	if (typeof job.data?.result?.url === "string") return job.data.result.url;
	return `${encodeURIComponent(job.projectId || "")}/`;
}

async function jobFinished(job) {
	const ok = job.data?.status === "succeeded";
	if (job.kind === "create") {
		wizard.jobFinished(job.id, ok);
		if (ok) {
			state.highlight = job.projectId;
			await refreshRegistry();
			toast(`“${job.title}” is ready.`, { kind: "success", action: { label: "Open project", href: projectUrl(job) } });
		} else {
			toast(`Creating “${job.title}” failed.`, { kind: "error", action: { label: "View log", onClick: () => jobs.open(job.id) } });
		}
	} else if (ok) {
		await refreshRegistry();
		toast(`Preview of “${job.title}” updated.`, { kind: "success" });
	} else {
		toast(`Preview of “${job.title}” failed.`, { kind: "error", action: { label: "View log", onClick: () => jobs.open(job.id) } });
	}
}

// ---------------------------------------------------------------------------------------------
// Loading

function normalise(registry) {
	const list = Array.isArray(registry?.projects) ? registry.projects : [];
	return list.filter((p) => p && typeof p.id === "string").map((p) => ({
		...p,
		title: p.title || p.id,
		keywords: Array.isArray(p.keywords) ? p.keywords.filter((k) => typeof k === "string") : [],
		url: p.url || `${p.id}/index.html`,
		stats: p.stats || {},
	}));
}

function applyRegistry(registry) {
	state.registry = registry;
	state.projects = normalise(registry);
	state.loadError = null;
	for (const p of state.projects) details.update(p);
	render();
}

async function loadStatic() {
	return fetchJson(REGISTRY_URL, { timeout: 15000 });
}

async function probe() {
	try {
		const health = await api.health();
		return health && health.ok !== false ? health : null;
	} catch {
		return null;
	}
}

/** Probe the service and load the registry; the static file renders first if it arrives first. */
async function connect() {
	state.mode = "loading";
	renderService();
	const staticLoad = loadStatic().then(
		(registry) => { if (state.mode !== "live") applyRegistry(registry); return registry; },
		(err) => { if (state.mode !== "live" && !state.registry) state.loadError = err; return null; });
	const health = await probe();
	state.health = health;
	state.mode = health ? "live" : "static";
	auth.setHealth(health); // re-renders the service state through the subscription below
	if (health) {
		try {
			applyRegistry(await api.projects());
		} catch (err) {
			// The service answers but cannot list projects: fall back to the static registry.
			const fallback = await staticLoad;
			if (fallback) applyRegistry(fallback);
			else if (!state.registry) state.loadError = err;
		}
		// Jobs still running on the server: only with a token (or when the service wants none);
		// a page load never opens the token dialog.
		if (auth.status === "signed-in" || auth.status === "open") jobs.restore();
	} else {
		await staticLoad;
	}
	render();
}

auth.subscribe((reason) => {
	renderService();
	if (reason === "signed-in") {
		jobs.resume();
		jobs.restore();
	} else if (reason === "rejected") {
		toast("The project service no longer accepts the stored access token.", {
			kind: "error", timeout: 15000, action: { label: "Sign in", onClick: () => auth.prompt() },
		});
	} else if (reason === "unconfigured" && details.openId && details.mode === "view") {
		details.render(); // drop the edit actions
	}
});

async function refreshRegistry() {
	try {
		applyRegistry(state.mode === "live" ? await api.projects() : await loadStatic());
	} catch (err) {
		toast(`Could not refresh the project list: ${err.message}`, { kind: "error" });
	}
}

/** Service pill, read-only notice and the "New project" button, from state.mode and auth. */
function renderService() {
	const mode = state.mode;
	const edit = editState();
	const pill = $("service-status");
	pill.dataset.state = mode === "live" ? "live" : mode === "static" ? "static" : "checking";
	const label = pill.querySelector(".service-label");
	const version = state.health?.version ? ` (v${state.health.version})` : "";
	label.textContent = mode === "live" ? "Service online" : mode === "static" ? "Read-only" : "Checking service…";
	pill.title = mode === "live" ? `Project service at ${api.base}${version}` : mode === "static" ? `Project service not reachable at ${api.base}` : "";

	const notice = $("readonly-notice");
	notice.hidden = mode === "loading" || edit === "ok";
	notice.dataset.kind = edit;
	$("notice-icon").querySelector("use").setAttribute("href", edit === "unconfigured" ? "#i-lock" : "#i-info");
	setChildren($("notice-text"), ...(edit === "unconfigured"
		? [h("strong", { text: "Editing is disabled." }), " The project service has no access token configured, so creating and editing projects is switched off. See ",
			h("code", { text: "deploy/README.md" }), " (API_TOKEN)."]
		: [h("strong", { text: "Read-only view." }), " Creating and editing projects needs the project service, which is not reachable from this page. See ",
			h("code", { text: "deploy/README.md" }), " to start it."]));

	const button = $("new-project");
	if (edit === "ok") {
		button.removeAttribute("aria-disabled");
		button.removeAttribute("title");
	} else {
		button.setAttribute("aria-disabled", "true");
		button.title = mode === "loading" ? "Checking the project service…"
			: edit === "unconfigured" ? "Creating projects is disabled: the service has no access token configured"
			: "Creating projects needs the project service";
	}
}

// ---------------------------------------------------------------------------------------------
// Filtering

function keywordStats() {
	const counts = new Map();
	for (const p of state.projects) {
		for (const k of new Set(p.keywords)) {
			const key = fold(k);
			const entry = counts.get(key) || { key, label: k, count: 0 };
			entry.count++;
			counts.set(key, entry);
		}
	}
	return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function visibleProjects() {
	const tokens = fold(state.query).split(/\s+/).filter(Boolean);
	const list = state.projects.filter((p) => {
		const keys = p.keywords.map(fold);
		for (const k of state.keywords) if (!keys.includes(k)) return false;
		if (!tokens.length) return true;
		const haystack = fold([p.title, p.description, p.location, p.source, p.id, ...p.keywords].filter(Boolean).join(" | "));
		return tokens.every((t) => haystack.includes(t));
	});
	const byTitle = (a, b) => a.title.localeCompare(b.title, "en", { sensitivity: "base" });
	const time = (p) => Date.parse(p.updatedAt) || 0;
	const sorters = {
		title: byTitle,
		updated: (a, b) => time(b) - time(a) || byTitle(a, b),
		points: (a, b) => (Number(b.stats.points) || 0) - (Number(a.stats.points) || 0) || byTitle(a, b),
	};
	return list.sort(sorters[state.sort] || byTitle);
}

function toggleKeyword(key) {
	if (state.keywords.has(key)) state.keywords.delete(key);
	else state.keywords.add(key);
	render();
}

function clearFilters() {
	state.query = "";
	state.keywords.clear();
	$("search").value = "";
	render();
}

function readUrl() {
	const params = new URLSearchParams(location.search);
	state.query = params.get("q") || "";
	state.keywords = new Set(params.getAll("kw").map(fold).filter(Boolean));
	const sort = params.get("sort");
	if (SORTS.includes(sort)) state.sort = sort;
	$("search").value = state.query;
	$("sort").value = state.sort;
}

function writeUrl() {
	const params = new URLSearchParams();
	if (state.query) params.set("q", state.query);
	for (const k of state.keywords) params.append("kw", k);
	if (state.sort !== DEFAULT_SORT) params.set("sort", state.sort);
	const qs = params.toString();
	const url = `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`;
	if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, "", url);
}

// ---------------------------------------------------------------------------------------------
// Rendering

function render() {
	renderTotals();
	renderKeywordChips();
	renderGrid();
	writeUrl();
}

function renderTotals() {
	const loaded = state.registry != null;
	const points = state.projects.reduce((sum, p) => sum + (Number(p.stats.points) || 0), 0);
	const panos = state.projects.reduce((sum, p) => sum + (Number(p.stats.images360) || 0), 0);
	$("total-projects").textContent = loaded ? formatInt(state.projects.length) : "–";
	$("total-points").textContent = loaded ? formatCompact(points) : "–";
	$("total-points").title = loaded ? `${formatInt(points)} points` : "";
	$("total-panos").textContent = loaded ? (panos < 100000 ? formatInt(panos) : formatCompact(panos)) : "–";
}

function renderKeywordChips() {
	const box = $("keyword-chips");
	const all = keywordStats();
	if (!all.length) {
		box.replaceChildren();
		box.hidden = true;
		return;
	}
	box.hidden = false;
	const shown = state.showAllKeywords ? all : all.slice(0, TOP_KEYWORDS);
	for (const key of state.keywords) {
		if (!shown.some((k) => k.key === key)) {
			const extra = all.find((k) => k.key === key);
			if (extra) shown.push(extra);
		}
	}
	const chips = shown.map((k) => h("button", {
		type: "button", class: "filter-chip", "aria-pressed": String(state.keywords.has(k.key)),
		onclick: () => toggleKeyword(k.key),
	}, h("span", { text: k.label }), h("span", { class: "chip-count", "aria-label": `${k.count} projects`, text: String(k.count) })));
	if (all.length > TOP_KEYWORDS) {
		chips.push(h("button", {
			type: "button", class: "link-btn more-chips", "aria-expanded": String(state.showAllKeywords),
			onclick: () => { state.showAllKeywords = !state.showAllKeywords; renderKeywordChips(); },
		}, state.showAllKeywords ? "Fewer" : `+${all.length - TOP_KEYWORDS} more`));
	}
	box.replaceChildren(...chips);
}

function renderGrid() {
	const grid = $("grid");
	const empty = $("empty");
	const line = $("result-line");
	if (!state.registry) {
		if (state.loadError) {
			grid.replaceChildren();
			line.textContent = "";
			showEmpty("alert-circle", "Could not load the project list", `${REGISTRY_URL}: ${state.loadError.message}`,
				h("button", { type: "button", class: "btn", onclick: () => { state.loadError = null; renderSkeleton(); connect(); } }, icon("refresh"), "Try again"));
		}
		return;
	}
	const list = visibleProjects();
	const filtered = state.query || state.keywords.size;
	setChildren(line,
		h("span", { text: filtered ? `Showing ${formatInt(list.length)} of ${plural(state.projects.length, "project")}` : plural(state.projects.length, "project") }),
		filtered ? h("button", { type: "button", class: "link-btn", onclick: clearFilters }, "Clear filters") : null);

	if (!state.projects.length) {
		grid.replaceChildren();
		const action = editState() === "ok"
			? h("button", { type: "button", class: "btn primary", onclick: () => openWizard() }, icon("plus"), "Create the first project")
			: null;
		showEmpty("layers", "No projects yet", state.mode === "live"
			? "Create a project from a LAS/LAZ point cloud on the server."
			: "Projects appear here once registry.json lists them.", action);
		return;
	}
	if (!list.length) {
		grid.replaceChildren();
		showEmpty("search", "No projects match", "Try other words, or remove some keyword filters.",
			h("button", { type: "button", class: "btn", onclick: clearFilters }, "Clear search and filters"));
		return;
	}
	empty.hidden = true;
	grid.removeAttribute("aria-busy");
	grid.replaceChildren(...list.map(card));
	if (state.highlight) {
		const el = grid.querySelector(`[data-id="${CSS.escape(state.highlight)}"]`);
		state.highlight = null;
		if (el) {
			el.classList.add("is-new");
			el.scrollIntoView({ block: "nearest", behavior: "smooth" });
		}
	}
}

function showEmpty(iconName, title, text, action) {
	const empty = $("empty");
	empty.hidden = false;
	$("grid").removeAttribute("aria-busy");
	setChildren(empty,
		h("div", { class: "empty-icon" }, icon(iconName)),
		h("h2", { text: title }),
		h("p", { text }),
		action);
}

function card(p) {
	const keywords = p.keywords.slice(0, CARD_KEYWORDS);
	const more = p.keywords.length - keywords.length;
	return h("li", { class: "card", dataset: { id: p.id } },
		h("div", { class: "card-media" }, previewMedia(p), badgeList(p, "badges on-media")),
		h("div", { class: "card-body" },
			h("h2", { class: "card-title" }, h("a", { class: "card-link", href: p.url, text: p.title })),
			metaLine(p),
			p.description ? h("p", { class: "card-desc", text: p.description }) : null,
			keywords.length ? h("ul", { class: "chips card-chips", "aria-label": "Keywords" },
				keywords.map((k) => h("li", null, h("button", {
					type: "button", class: "chip-btn", "aria-pressed": String(state.keywords.has(fold(k))),
					title: `Filter by “${k}”`, onclick: () => toggleKeyword(fold(k)),
				}, k))),
				more > 0 ? h("li", { class: "chip-more", title: p.keywords.slice(CARD_KEYWORDS).join(", "), text: `+${more}` }) : null) : null),
		h("div", { class: "card-foot" },
			statList(p),
			h("button", {
				type: "button", class: "btn sm card-details", "aria-label": `Details: ${p.title}`,
				onclick: () => details.open(p),
			}, icon("info"), "Details")));
}

function renderSkeleton() {
	const grid = $("grid");
	$("empty").hidden = true;
	grid.setAttribute("aria-busy", "true");
	grid.replaceChildren(...Array.from({ length: 8 }, () => h("li", { class: "card skeleton", "aria-hidden": "true" },
		h("div", { class: "card-media" }, h("div", { class: "media" })),
		h("div", { class: "card-body" },
			h("span", { class: "sk sk-title" }), h("span", { class: "sk sk-line" }), h("span", { class: "sk sk-line short" })))));
}


// ---------------------------------------------------------------------------------------------
// Toolbar & shortcuts

/** The wizard needs the access token for browsing, inspecting and submitting: ask first. */
async function openWizard() {
	if (await auth.ensure()) wizard.open();
	else if (editState() !== "ok") renderService();
}

function bindUi() {
	const search = $("search");
	// The full hint does not fit on phones.
	const narrow = window.matchMedia("(max-width: 520px)");
	const syncPlaceholder = () => { search.placeholder = narrow.matches ? "Search projects" : "Search title, description, keywords, location"; };
	narrow.addEventListener("change", syncPlaceholder);
	syncPlaceholder();
	const onSearch = debounce(() => { state.query = search.value.trim(); render(); }, 120);
	search.addEventListener("input", onSearch);
	search.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && search.value) {
			event.preventDefault();
			search.value = "";
			onSearch.cancel();
			state.query = "";
			render();
		}
	});
	$("sort").addEventListener("change", (event) => {
		state.sort = SORTS.includes(event.target.value) ? event.target.value : DEFAULT_SORT;
		render();
	});
	$("new-project").addEventListener("click", () => {
		if (editState() === "ok") {
			openWizard();
			return;
		}
		const notice = $("readonly-notice");
		if (!notice.hidden) {
			notice.classList.remove("flash");
			void notice.offsetWidth; // restart the animation
			notice.classList.add("flash");
			notice.scrollIntoView({ block: "nearest", behavior: "smooth" });
		}
	});
	$("retry-service").addEventListener("click", () => connect());
	document.addEventListener("keydown", (event) => {
		if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
		const target = event.target;
		if (target.closest?.("input, textarea, select, [contenteditable], dialog[open]")) return;
		if (document.querySelector("dialog[open]")) return;
		event.preventDefault();
		search.focus();
		search.select();
	});
}

readUrl();
bindUi();
renderSkeleton();
connect();
