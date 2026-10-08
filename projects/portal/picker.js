// Server-side path picker over GET {api}/fs/list: breadcrumb, folders first, extension filter,
// full keyboard navigation (listbox with aria-activedescendant).
//
// The service lists at most 500 entries per folder. In a bigger folder the filter box searches the
// whole folder on the server (`q`), and a file asked for by name (a typed path, or the path already
// in the wizard field) is looked up the same way. A name that cannot be found is reported and never
// replaced by another entry.

import { h, icon, formatBytes, formatInt, relativeTime, basename, wireDialog, debounce } from "./util.js";

const SEARCH_DELAY = 250;

const looksLikeFile = (p) => /\/[^/]+\.[A-Za-z0-9]{2,6}$/.test(p);
const parentOf = (p) => {
	const trimmed = p.replace(/\/+$/, "");
	const i = trimmed.lastIndexOf("/");
	return i <= 0 ? "/" : trimmed.slice(0, i);
};

export class PathPicker {
	constructor(api) {
		this.api = api;
		const $ = (id) => document.getElementById(id);
		this.el = {
			dialog: $("picker"), title: $("picker-title"), sub: $("picker-sub"), up: $("picker-up"),
			crumbs: $("picker-crumbs"), path: $("picker-path"), filter: $("picker-filter"), note: $("picker-note"),
			list: $("picker-list"), state: $("picker-state"), selection: $("picker-selection"), choose: $("picker-choose"),
			rootWrap: $("picker-root-wrap"), root: $("picker-root"),
		};
		this.base = null;       // listing of the current folder without a name filter
		this.listing = null;    // what the list shows: `base`, or a server search inside it ({…, query})
		this.visible = [];      // entries after the client-side filter
		this.active = -1;       // index into `visible`
		this.missing = null;    // a requested file name that is not in the folder (blocks "Select")
		this.searching = false; // a server search for the filter text is pending
		this.loading = false;   // a folder listing is on its way
		this.searchSeq = 0;
		this.options = {};
		this.result = null;
		this.resolve = null;
		this.requestSeq = 0;
		this.lastPath = "";
		this.roots = new Set(); // listings whose parent is null are roots of the allowed area
		this.typeahead = { text: "", time: 0 };
		this.bindUi();
	}

	bindUi() {
		const { dialog, up, path, filter, list, choose } = this.el;
		wireDialog(dialog, { lightDismiss: true });
		dialog.addEventListener("close", () => {
			this.resolve?.(this.result);
			this.resolve = null;
		});
		up.addEventListener("click", () => this.goUp());
		this.el.root.addEventListener("change", () => this.navigate(this.el.root.value));
		choose.addEventListener("click", () => this.choose());
		path.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				const value = path.value.trim();
				if (value) this.navigate(value, { fromInput: true });
			}
		});
		const searchLater = debounce(() => this.search(), SEARCH_DELAY);
		filter.addEventListener("input", () => {
			if (!this.base || this.loading) return; // applied when the folder has loaded
			if (this.missing) {
				this.missing = null;
				this.showNote();
			}
			const q = filter.value.trim();
			// Back to the whole folder unless the new text only narrows the last search.
			if (this.listing !== this.base && !(this.listing.query && q.toLowerCase().includes(this.listing.query.toLowerCase()))) this.listing = this.base;
			this.searching = this.needsSearch(q);
			this.applyFilter();
			if (this.searching) searchLater();
			else searchLater.cancel();
		});
		filter.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown" || event.key === "Enter") {
				event.preventDefault();
				if (this.visible.length) {
					if (this.active < 0) this.setActive(0);
					list.focus();
				}
			}
		});
		list.addEventListener("keydown", (event) => this.onListKey(event));
		list.addEventListener("click", (event) => {
			const row = event.target.closest("[data-index]");
			if (row) this.setActive(Number(row.dataset.index));
		});
		list.addEventListener("dblclick", (event) => {
			const row = event.target.closest("[data-index]");
			if (row) this.activate(this.visible[Number(row.dataset.index)]);
		});
	}

	/**
	 * @param {object} options
	 * @param {string} options.title
	 * @param {string} [options.description]
	 * @param {"file"|"dir"|"any"} options.mode  what may be selected
	 * @param {string} [options.ext]           comma-separated extensions for files, e.g. "las,laz"
	 * @param {string} [options.start]         initial path (a file path opens its folder and selects it)
	 * @returns {Promise<string|null>}
	 */
	open(options) {
		this.options = { mode: "file", ext: "", ...options };
		this.result = null;
		const { title, sub, filter, path } = this.el;
		title.textContent = options.title || "Choose a path";
		const exts = this.options.ext ? this.options.ext.split(",").map((e) => `.${e.trim()}`).join(", ") : "";
		sub.textContent = options.description
			|| (this.options.mode === "dir" ? "Pick a folder on the server." : exts ? `Pick a ${exts} file on the server.` : "Pick a file on the server.");
		filter.value = "";
		path.value = "";
		this.el.dialog.showModal();

		let start = (options.start || "").trim() || this.lastPath;
		let select = null;
		if (start && looksLikeFile(start)) {
			select = basename(start);
			start = parentOf(start);
		}
		this.navigate(start, { select, fallback: true });
		return new Promise((resolve) => { this.resolve = resolve; });
	}

	async navigate(target, { select = null, fallback = false, fromInput = false, keepNote = false } = {}) {
		const seq = ++this.requestSeq;
		this.missing = null;
		this.searching = false;
		this.loading = true;
		// A new folder starts unfiltered; whatever is typed while it loads is applied afterwards.
		this.el.filter.value = "";
		this.showState("loading");
		let listing;
		try {
			listing = await this.api.listDir(target, this.options.ext);
		} catch (err) {
			if (seq !== this.requestSeq) return;
			this.loading = false;
			if (fromInput && looksLikeFile(target)) {
				// A typed file path: open its folder and select the file.
				return this.navigate(parentOf(target), { select: basename(target) });
			}
			if (fallback && target) {
				this.showNote(`Could not open ${target}: ${err.message}`, "warn");
				return this.navigate("", { keepNote: true });
			}
			this.showState("error", err.message);
			return;
		}
		if (seq !== this.requestSeq) return;
		this.loading = false;
		this.base = {
			path: listing.path ?? target,
			parent: listing.parent ?? null,
			...this.entriesOf(listing),
			query: "",
		};
		this.listing = this.base;
		// The service lists its allowed roots; without that list, a folder without parent is a root.
		if (Array.isArray(listing.roots) && listing.roots.length) this.roots = new Set(listing.roots);
		else if (this.base.parent == null && this.base.path) this.roots.add(this.base.path);
		this.renderRoots();
		if (this.base.path) this.lastPath = this.base.path;
		this.el.path.value = this.base.path || "";
		if (!keepNote) this.showNote();
		this.renderCrumbs();
		this.searching = !select && this.needsSearch(this.el.filter.value.trim());
		this.applyFilter(select);
		if (this.searching) await this.search();
		if (select && this.active < 0 && this.base.truncated) {
			// Probably past the server's cap: look the name up in the whole folder.
			this.el.filter.value = select;
			this.searching = true;
			this.applyFilter();
			await this.search(select);
			if (seq !== this.requestSeq) return;
			if (this.active < 0) {
				this.el.filter.value = "";
				this.listing = this.base;
				this.applyFilter();
			}
		}
		if (select && this.active < 0) {
			this.missing = select;
			const exts = this.options.ext ? ` (or it is not a .${this.options.ext.split(",").join("/.")} file)` : "";
			this.showNote(`“${select}” was not found in this folder${exts}.`, "warn");
			this.updateSelection();
		}
		this.el.list.focus({ preventScroll: true });
	}

	/** Entries (folders first; the server already sorts this way) and the truncation info of a response. */
	entriesOf(response) {
		const entries = Array.isArray(response.entries) ? response.entries : [];
		return {
			entries: [...entries].sort((a, b) => Number(!this.isDir(a)) - Number(!this.isDir(b))),
			truncated: !!response.truncated,
			total: Number(response.total) || entries.length,
		};
	}

	/** Does the filter text need a server search? Only when the loaded entries may not hold all matches. */
	needsSearch(q) {
		if (!q || !this.base?.truncated) return false;
		const l = this.listing;
		return !(l.query && !l.truncated && q.toLowerCase().includes(l.query.toLowerCase()));
	}

	/** Search the current folder on the server for the filter text; optionally select an exact name. */
	async search(selectName = null) {
		const base = this.base;
		const q = this.el.filter.value.trim();
		if (!base || !this.needsSearch(q)) {
			if (this.searching) {
				this.searching = false;
				this.applyFilter(selectName);
			}
			return;
		}
		const seq = ++this.searchSeq;
		const navSeq = this.requestSeq;
		this.searching = true;
		this.renderListNote(q);
		let response = null;
		let error = null;
		try {
			response = await this.api.listDir(base.path, this.options.ext, q);
		} catch (err) {
			error = err;
		}
		if (seq !== this.searchSeq || navSeq !== this.requestSeq || this.el.filter.value.trim() !== q) return;
		this.searching = false;
		if (response) this.listing = { ...base, ...this.entriesOf(response), query: q };
		this.applyFilter(selectName);
		if (error) this.showNote(`Could not search the whole folder (${error.message}). Only the loaded entries were filtered.`, "warn");
	}

	/** Location switcher, shown only when the server allows more than one root. */
	renderRoots() {
		const roots = [...this.roots];
		const { rootWrap, root } = this.el;
		rootWrap.hidden = roots.length < 2;
		if (roots.length < 2) return;
		const current = this.base?.path || "";
		const active = roots.filter((r) => current === r || current.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0] || "";
		root.replaceChildren(...roots.map((r) => h("option", { value: r, text: r })));
		root.value = active;
	}

	goUp() {
		if (this.base?.parent != null) this.navigate(this.base.parent, { select: basename(this.base.path) });
	}

	renderCrumbs() {
		const { path } = this.base;
		const crumbs = this.el.crumbs;
		this.el.up.disabled = this.base.parent == null;
		if (!path) {
			crumbs.replaceChildren(h("span", { class: "crumb current" }, icon("drive"), "Allowed locations"));
			return;
		}
		const parts = path.split("/").filter(Boolean);
		const items = [];
		let prefix = "";
		const rootLength = Math.min(...[...this.roots].filter((r) => path === r || path.startsWith(`${r}/`)).map((r) => r.length), Infinity);
		parts.forEach((part, i) => {
			prefix += `/${part}`;
			const target = prefix;
			const last = i === parts.length - 1;
			const reachable = !Number.isFinite(rootLength) || target.length >= rootLength;
			if (i > 0) items.push(h("span", { class: "crumb-sep", "aria-hidden": "true" }, icon("chevron-right")));
			if (last) items.push(h("span", { class: "crumb current", "aria-current": "location", text: part }));
			else if (reachable) items.push(h("button", { type: "button", class: "crumb", text: part, onclick: () => this.navigate(target) }));
			else items.push(h("span", { class: "crumb muted", text: part }));
		});
		crumbs.replaceChildren(h("span", { class: "crumb-root" }, icon("drive")), ...items);
		// Keep the deepest folder in view on narrow screens.
		crumbs.scrollLeft = crumbs.scrollWidth;
	}

	applyFilter(selectName = null) {
		const query = this.el.filter.value.trim().toLowerCase();
		const entries = this.listing?.entries || [];
		this.visible = query ? entries.filter((e) => String(e.name).toLowerCase().includes(query)) : entries;
		this.renderList();
		const index = selectName ? this.visible.findIndex((e) => e.name === selectName) : -1;
		this.active = -1;
		if (index >= 0) this.setActive(index);
		else this.updateSelection();
		this.renderListNote(query);
	}

	renderList() {
		const { list } = this.el;
		list.removeAttribute("aria-activedescendant");
		list.setAttribute("aria-busy", "false");
		if (!this.visible.length) {
			list.replaceChildren();
			if (this.searching) {
				this.showState("loading", "Searching the whole folder…");
				return;
			}
			const filtered = this.el.filter.value.trim();
			const exts = this.options.ext ? ` matching .${this.options.ext.split(",").join(", .")}` : "";
			this.showState("empty", filtered ? "No entries match the filter." : `This folder has no subfolders or files${exts}.`);
			return;
		}
		this.el.state.hidden = true;
		list.replaceChildren(...this.visible.map((entry, index) => {
			const isDir = entry.type === "dir" || entry.type === "directory";
			const meta = isDir ? "Folder" : formatBytes(entry.size);
			const when = entry.mtime ? relativeTime(entry.mtime) : "";
			return h("li", {
				id: `picker-opt-${index}`, role: "option", class: `picker-item${isDir ? " is-dir" : ""}`,
				"aria-selected": "false", dataset: { index: String(index) }, title: entry.path || entry.name,
			},
			icon(isDir ? "folder" : "file", "picker-icon"),
			h("span", { class: "picker-name", text: entry.name }),
			h("span", { class: "picker-meta" }, h("span", { text: meta }), when ? h("span", { class: "picker-when", text: when }) : null),
			isDir ? icon("chevron-right", "picker-go") : null);
		}));
	}

	renderListNote(query) {
		const { base, listing } = this;
		if (!listing || this.missing) return;
		let text = "";
		if (base.truncated) {
			const all = formatInt(base.total);
			if (!query) text = `Showing the first ${formatInt(base.entries.length)} of ${all} entries. Type in the filter to search all of them.`;
			else if (this.searching) text = `Searching all ${all} entries…`;
			else if (listing.query && listing.truncated) text = `Showing ${formatInt(listing.entries.length)} of ${formatInt(listing.total)} matches among ${all} entries. Type more to narrow them down.`;
			else if (listing.query) text = `Searched all ${all} entries.`;
		}
		if (text) this.showNote(text, "info");
		else if (this.el.note.dataset.kind === "info") this.showNote();
	}

	showNote(text = "", kind = "") {
		const note = this.el.note;
		note.hidden = !text;
		note.dataset.kind = text ? kind : "";
		note.replaceChildren(...(text ? [icon(kind === "warn" ? "alert" : "info"), h("span", { text })] : []));
	}

	showState(kind, message = "") {
		const { state, list } = this.el;
		if (kind === "loading") {
			list.setAttribute("aria-busy", "true");
			list.replaceChildren();
			state.hidden = false;
			state.dataset.kind = kind;
			state.replaceChildren(h("span", { class: "spinner" }), h("span", { text: message || "Loading…" }));
			this.el.choose.disabled = true;
			return;
		}
		state.hidden = false;
		const nodes = [icon(kind === "error" ? "alert-circle" : "folder"), h("span", { text: message })];
		if (kind === "error") {
			list.replaceChildren();
			list.setAttribute("aria-busy", "false");
			if (this.base) nodes.push(h("button", { type: "button", class: "link-btn", text: "Back", onclick: () => this.navigate(this.base.path) }));
			else nodes.push(h("button", { type: "button", class: "link-btn", text: "Go to default location", onclick: () => this.navigate("") }));
			this.el.choose.disabled = true;
		}
		state.dataset.kind = kind;
		state.replaceChildren(...nodes);
	}

	setActive(index) {
		const { list } = this.el;
		const previous = list.querySelector('[aria-selected="true"]');
		if (previous) previous.setAttribute("aria-selected", "false");
		this.active = Math.max(-1, Math.min(this.visible.length - 1, index));
		if (this.active >= 0) {
			if (this.missing) {
				this.missing = null;
				this.showNote();
				this.renderListNote(this.el.filter.value.trim());
			}
			const row = document.getElementById(`picker-opt-${this.active}`);
			row.setAttribute("aria-selected", "true");
			list.setAttribute("aria-activedescendant", row.id);
			row.scrollIntoView({ block: "nearest" });
		} else {
			list.removeAttribute("aria-activedescendant");
		}
		this.updateSelection();
	}

	isDir(entry) {
		return entry && (entry.type === "dir" || entry.type === "directory");
	}

	/**
	 * What "Select" would return right now, or null. While a requested file is missing, or while
	 * the list is filtered, the folder itself is not offered: someone looking for one entry must
	 * not end up with the whole folder (e.g. all 937 tiles of a survey) by accident.
	 */
	candidate() {
		const { mode } = this.options;
		const entry = this.visible[this.active];
		if (entry) {
			if (this.isDir(entry) && mode !== "file") return { path: entry.path, label: "Select folder" };
			if (!this.isDir(entry) && mode !== "dir") return { path: entry.path, label: "Select file" };
		}
		if (this.missing || this.el.filter.value.trim()) return null;
		if (mode !== "file" && this.base?.path) return { path: this.base.path, label: "Select this folder" };
		return null;
	}

	updateSelection() {
		const pick = this.candidate();
		const { choose, selection } = this.el;
		choose.disabled = !pick;
		choose.textContent = pick ? pick.label : "Select";
		const filtered = this.el.filter.value.trim() && this.options.mode !== "file";
		const hint = this.missing ? `“${this.missing}” was not found. Choose an entry.`
			: filtered ? "Choose an entry, or clear the filter to select this folder."
			: this.options.mode === "file" ? "Select a file." : "";
		selection.replaceChildren(...(pick
			? [h("span", { class: "muted", text: "Selected " }), h("code", { text: pick.path })]
			: [h("span", { class: "muted", text: hint })]));
	}

	activate(entry) {
		if (!entry) return;
		if (this.isDir(entry)) this.navigate(entry.path);
		else if (this.options.mode !== "dir") this.choose(entry.path);
	}

	choose(path = this.candidate()?.path) {
		if (!path) return;
		this.result = path;
		this.el.dialog.close();
	}

	onListKey(event) {
		const n = this.visible.length;
		const page = Math.max(1, Math.floor(this.el.list.clientHeight / 44) - 1);
		const keys = {
			ArrowDown: () => this.setActive(this.active < 0 ? 0 : Math.min(n - 1, this.active + 1)),
			ArrowUp: () => this.setActive(Math.max(0, this.active - 1)),
			Home: () => this.setActive(0),
			End: () => this.setActive(n - 1),
			PageDown: () => this.setActive(Math.min(n - 1, Math.max(0, this.active) + page)),
			PageUp: () => this.setActive(Math.max(0, this.active - page)),
			Enter: () => this.activate(this.visible[this.active]),
			ArrowRight: () => { const e = this.visible[this.active]; if (this.isDir(e)) this.navigate(e.path); },
			ArrowLeft: () => this.goUp(),
			Backspace: () => this.goUp(),
		};
		if (event.key in keys && !event.altKey && !event.ctrlKey && !event.metaKey) {
			event.preventDefault();
			if (n || ["ArrowLeft", "Backspace"].includes(event.key)) keys[event.key]();
			return;
		}
		if (event.altKey && event.key === "ArrowUp") {
			event.preventDefault();
			this.goUp();
			return;
		}
		// Type-ahead: jump to the next entry starting with the typed characters.
		if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && n) {
			const now = Date.now();
			this.typeahead.text = now - this.typeahead.time < 700 ? this.typeahead.text + event.key.toLowerCase() : event.key.toLowerCase();
			this.typeahead.time = now;
			const startAt = this.typeahead.text.length === 1 ? this.active + 1 : Math.max(0, this.active);
			for (let k = 0; k < n; k++) {
				const i = (startAt + k) % n;
				if (String(this.visible[i].name).toLowerCase().startsWith(this.typeahead.text)) {
					this.setActive(i);
					break;
				}
			}
		}
	}
}
