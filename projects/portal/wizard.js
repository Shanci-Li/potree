// "New project" wizard: one scrollable form in six sections with a section nav, inline validation,
// server path browsing/inspection, and submission to POST {api}/projects (then hands over to jobs.js).
//
// After a successful submission the form is cleared for the next project and the request is kept
// per job: "Edit & retry" on a failed job refills the form from it (asking first when the form
// holds another draft). A finished job never touches the form.

import { h, icon, setChildren, slugify, ID_PATTERN, basename, debounce, wireDialog, prefersReducedMotion } from "./util.js";
import { createChipInput } from "./chip-input.js";

const CUSTOM = "__custom";
const DEFAULT_CRS = "EPSG:2056";
// Same rule as the service (server/lib/requests.mjs NAME_RE), e.g. "gps-time", "img_label".
const ATTRIBUTE_RE = /^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,63}$/;
const IMPORT_MODE_LABEL = { copy: "Copy", symlink: "Symlink", move: "Move" };
const ENCODING_HINTS = {
	DEFAULT: "Uncompressed octree: fastest to convert and to stream. Recommended.",
	BROTLI: "Brotli-compressed octree: about half the size on disk, slower to convert.",
};

/** "label_cityscape" → "Cityscape", "sam-refined" → "Sam refined". */
function prettyName(folder) {
	const name = basename(folder).replace(/\.[a-z0-9]+$/i, "").replace(/^labels?[_-]?/i, "").replace(/[_-]+/g, " ").trim();
	return name ? name[0].toUpperCase() + name.slice(1) : "";
}

const isAbsolute = (p) => p.startsWith("/");

export class Wizard {
	/**
	 * @param {object} deps
	 * @param {object} deps.api
	 * @param {import("./picker.js").PathPicker} deps.picker
	 * @param {import("./jobs.js").JobCenter} deps.jobs
	 * @param {() => object[]} deps.getProjects   current registry projects (for id uniqueness)
	 * @param {() => string[]} deps.getKeywords   existing keywords (suggestions)
	 * @param {() => object|null} deps.getHealth  last /health response
	 */
	constructor({ api, picker, jobs, getProjects, getKeywords, getHealth }) {
		Object.assign(this, { api, picker, jobs, getProjects, getKeywords, getHealth });
		this.dialog = document.getElementById("wizard");
		this.form = document.getElementById("wizard-form");
		this.scroller = document.getElementById("wizard-scroll");
		this.idDirty = false;
		this.attempted = false;
		this.crsList = null;
		this.labelRows = [];
		this.vectorRows = [];
		this.rowSeq = 0;
		this.submitted = new Map();   // jobId → the request it was started with (for "Edit & retry")
		this.dirty = false;           // the user changed the form since it was last cleared or filled
		this.inspections = new Map(); // input element → { seq, ok, message }; ok === false blocks submit
		this.inspectSeq = 0;

		this.keywords = createChipInput(this.$("f-keywords-box"), {
			inputId: "f-keywords", describedBy: "f-keywords-hint", placeholder: "e.g. Mobile LiDAR",
			onChange: () => { this.dirty = true; },
		});
		this.bind();
		this.syncConditional();
	}

	$(id) {
		return document.getElementById(id);
	}

	radio(name) {
		return this.form.querySelector(`input[name="${name}"]:checked`)?.value;
	}

	// -----------------------------------------------------------------------------------------
	// Wiring

	bind() {
		wireDialog(this.dialog);
		this.form.addEventListener("submit", (event) => {
			event.preventDefault();
			this.submit();
		});
		// Enter in a single-line field must not submit the whole form.
		this.form.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type !== "submit") event.preventDefault();
		});
		for (const type of ["input", "change"]) {
			this.form.addEventListener(type, () => {
				this.dirty = true;
				if (this.attempted) this.showErrors(this.validate());
			});
		}

		const title = this.$("f-title"), id = this.$("f-id");
		title.addEventListener("input", () => {
			if (!this.idDirty) id.value = slugify(title.value);
			this.validateIdLive();
		});
		id.addEventListener("input", () => {
			this.idDirty = id.value.trim() !== "";
			if (!this.idDirty) id.value = slugify(title.value);
			this.validateIdLive();
		});

		this.$("f-crs").addEventListener("change", () => this.syncConditional());
		this.$("f-attr").addEventListener("change", () => this.syncConditional());
		this.$("f-pano-enabled").addEventListener("change", () => this.syncConditional());
		this.form.addEventListener("change", (event) => { if (event.target.name === "encoding") this.syncConditional(); });

		this.bindPath(this.$("f-pc-path"), this.$("f-pc-browse"), this.$("f-pc-inspect"), "pointcloud", () => ({
			title: "Choose the point cloud", mode: "any", ext: "las,laz",
			description: "Pick a .las/.laz file, or select a folder to convert all LAS/LAZ files in it.",
		}));
		this.bindPath(this.$("f-pano-path"), this.$("f-pano-browse"), this.$("f-pano-inspect"), "images360", () => ({
			title: "Choose the panorama folder", mode: "dir",
			description: "The folder that contains the panoramas and the coordinates file.",
		}));
		// The panorama check reads the coordinates file, so re-run it when the name changes.
		this.$("f-pano-coords").addEventListener("change", () => this.inspect(this.$("f-pano-path"), this.$("f-pano-inspect"), "images360"));

		this.$("f-label-add").addEventListener("click", () => {
			this.dirty = true;
			this.addLabelRow().name.focus();
		});
		this.$("f-vector-add").addEventListener("click", () => {
			this.dirty = true;
			this.addVectorRow().path.focus();
		});

		// Section nav: smooth scroll + scroll-spy.
		const nav = this.dialog.querySelector(".wizard-nav");
		nav.addEventListener("click", (event) => {
			const link = event.target.closest("a[data-section]");
			if (!link) return;
			event.preventDefault();
			const section = this.$(link.dataset.section);
			if (link.dataset.section === "wz-viewer") this.$("f-advanced").open = true;
			section.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
			section.querySelector("input, select, textarea, summary")?.focus({ preventScroll: true });
		});
		const links = [...nav.querySelectorAll("a[data-section]")];
		const spy = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				for (const link of links) {
					if (link.dataset.section === entry.target.id) link.setAttribute("aria-current", "step");
					else link.removeAttribute("aria-current");
				}
			}
		}, { root: this.scroller, rootMargin: "-8% 0px -75% 0px" });
		for (const link of links) spy.observe(this.$(link.dataset.section));

		// Two-step "Clear form" so a stray click does not wipe the draft.
		const reset = this.$("wizard-reset");
		let armed = 0;
		reset.addEventListener("click", () => {
			if (armed) {
				clearTimeout(armed);
				armed = 0;
				reset.textContent = "Clear form";
				this.reset();
				this.$("f-title").focus();
				return;
			}
			reset.textContent = "Click again to clear";
			armed = setTimeout(() => { armed = 0; reset.textContent = "Clear form"; }, 3000);
		});
	}

	/** Text field + "Browse…" button + live inspection summary below it. */
	bindPath(input, button, inspectEl, kind, pickerOptions, onPicked) {
		const run = () => this.inspect(input, inspectEl, kind);
		const later = debounce(run, 700);
		input.addEventListener("input", () => {
			this.inspections.delete(input);
			if (input.value.trim()) later();
			else { later.cancel(); inspectEl.hidden = true; }
		});
		input.addEventListener("change", () => { later.cancel(); run(); });
		button.addEventListener("click", async () => {
			const path = await this.picker.open({ ...pickerOptions(), start: input.value.trim() });
			button.focus();
			if (!path) return;
			input.value = path;
			onPicked?.(path);
			// Let the form's own listeners see the new value, then inspect right away.
			input.dispatchEvent(new Event("input", { bubbles: true }));
			later.cancel();
			run();
		});
	}

	async inspect(input, el, kind) {
		const path = input.value.trim();
		if (!path || !isAbsolute(path)) {
			el.hidden = true;
			return;
		}
		const seq = ++this.inspectSeq;
		this.inspections.set(input, { seq, ok: null });
		el.hidden = false;
		el.dataset.state = "loading";
		el.replaceChildren(h("span", { class: "spinner sm" }), h("span", { text: "Inspecting…" }));
		let state, message, warnings = [], usable = true;
		try {
			const extra = kind === "images360" ? { coordinatesFile: this.$("f-pano-coords").value.trim() } : {};
			const result = await this.api.inspect(path, kind, extra);
			usable = result.ok !== false;
			state = !usable ? "error" : (result.warnings?.length ? "warn" : "ok");
			warnings = Array.isArray(result.warnings) ? result.warnings.map(String) : [];
			// The service sends summary as {text, …counts}; accept a plain string too.
			const text = typeof result.summary === "string" ? result.summary : result.summary?.text;
			message = text || (usable ? "Looks good." : warnings.shift() || "This path cannot be used.");
		} catch (err) {
			// A 4xx means the server rejected the path; anything else (timeout, 5xx, no access
			// token) only means we could not check it, which must not block the submission.
			usable = !(err.status >= 400 && err.status < 500) || err.status === 401;
			state = usable ? "warn" : "error";
			message = usable ? `Could not inspect this path: ${err.message}` : err.message;
		}
		if (this.inspections.get(input)?.seq !== seq || input.value.trim() !== path) return;
		this.inspections.set(input, { seq, ok: usable, message });
		el.dataset.state = state;
		el.replaceChildren(
			icon(state === "error" ? "alert-circle" : state === "warn" ? "alert" : "check"),
			h("div", { class: "inspect-text" },
				h("span", { class: "inspect-summary", text: message }),
				warnings.length ? h("ul", { class: "inspect-warnings" }, warnings.map((w) => h("li", { text: String(w) }))) : null));
		if (this.attempted) this.showErrors(this.validate());
	}

	// -----------------------------------------------------------------------------------------
	// Opening, CRS list, conditional parts

	async open() {
		this.keywords.setSuggestions(this.getKeywords());
		this.renderServiceNote();
		if (!this.dialog.open) this.dialog.showModal();
		if (!this.$("f-title").value) this.$("f-title").focus();
		if (!this.crsList) await this.loadCrs();
		this.validateIdLive();
	}

	/** "Edit & retry" on a failed create job: reopen the wizard with the request it was started with. */
	async retry(jobId) {
		const request = this.submitted.get(jobId);
		await this.open();
		if (!request) return; // started before this page was loaded: nothing to refill
		if (!this.dirty) {
			this.fill(request);
			this.$("f-title").focus();
			return;
		}
		// The form holds another draft: replace it only when asked to.
		const alert = this.$("wizard-alert");
		const load = h("button", { type: "button", class: "btn sm alert-action" }, icon("refresh"), "Load its settings");
		load.addEventListener("click", () => {
			this.fill(request);
			this.$("f-title").focus();
		});
		alert.hidden = false;
		alert.dataset.kind = "retry";
		alert.className = "form-alert warn";
		alert.replaceChildren(icon("alert"), h("div", null,
			h("p", null, h("strong", { text: `Retry “${request.title}”?` }),
				" This form holds another draft. Loading the settings of the failed project replaces it."),
			load));
		this.scroller.scrollTop = 0;
	}

	/** Put a CreateRequest back into the form (the inverse of buildRequest). */
	fill(r) {
		this.reset();
		const set = (id, value) => { this.$(id).value = value ?? ""; };
		set("f-title", r.title);
		set("f-id", r.id);
		this.idDirty = !!r.id && r.id !== slugify(r.title || "");
		set("f-location", r.location);
		set("f-date", r.date);
		set("f-source", r.source);
		set("f-description", r.description);
		this.keywords.setValues(r.keywords || []);

		const pc = r.pointcloud || {};
		set("f-pc-path", pc.path);
		const crsSelect = this.$("f-crs");
		const known = [...crsSelect.options].some((o) => o.value && o.value !== CUSTOM && o.value === pc.crs);
		if (pc.proj4 || (pc.crs && !known)) {
			crsSelect.value = CUSTOM;
			set("f-crs-name", pc.crs);
			set("f-crs-proj4", pc.proj4);
		} else {
			crsSelect.value = pc.crs || "";
		}
		this.setRadio("encoding", r.conversion?.encoding);
		this.setRadio("method", r.conversion?.method);

		const pano = r.images360 || null;
		this.$("f-pano-enabled").checked = !!pano;
		if (pano) {
			set("f-pano-path", pano.path);
			set("f-pano-coords", pano.coordinatesFile || "coordinates.txt");
			this.$("f-pano-crs").value = pano.crs || "";
			for (const labelSet of r.labelSets || []) this.addLabelRow({ name: labelSet.name, path: labelSet.path });
		}
		for (const v of r.vectors || []) this.addVectorRow({ path: v.path, name: v.name }).crs.value = v.crs || "";
		this.setRadio("importMode", r.importMode);

		const attr = r.material?.activeAttribute || "rgba";
		const attrSelect = this.$("f-attr");
		if ([...attrSelect.options].some((o) => o.value === attr && o.value !== CUSTOM)) attrSelect.value = attr;
		else {
			attrSelect.value = CUSTOM;
			set("f-attr-custom", attr);
		}
		this.$("f-scheme").value = r.viewer?.classificationScheme || "";
		set("f-budget", r.viewer?.pointBudget ?? 2000000);
		set("f-size", r.material?.size ?? 0.7);
		if (r.material?.pointSizeType) this.$("f-sizetype").value = r.material.pointSizeType;
		if (r.viewer?.controls) this.$("f-controls").value = r.viewer.controls;
		this.$("f-edl").checked = r.viewer?.edl !== false;
		const preview = this.$("f-preview");
		preview.checked = r.renderPreview !== false && !preview.disabled;

		this.syncConditional();
		this.applyImportModes();
		this.validateIdLive();
		this.dirty = false;
		// Show what the paths hold now (the reason of the failure may be visible there).
		const paths = [[this.$("f-pc-path"), this.$("f-pc-inspect"), "pointcloud"]];
		if (pano) paths.push([this.$("f-pano-path"), this.$("f-pano-inspect"), "images360"]);
		for (const row of this.labelRows) paths.push([row.path, row.inspect, "labels"]);
		for (const row of this.vectorRows) paths.push([row.path, row.inspect, "vector"]);
		for (const [input, el, kind] of paths) if (input.value.trim()) this.inspect(input, el, kind);
	}

	setRadio(name, value) {
		const input = this.form.querySelector(`input[name="${name}"][value="${CSS.escape(String(value ?? ""))}"]`);
		if (input && !input.disabled) input.checked = true;
	}

	renderServiceNote() {
		const health = this.getHealth() || {};
		const note = this.$("wizard-service-note");
		const items = [];
		const converter = health.converter;
		if (converter) {
			items.push(h("li", { class: converter.exists ? "ok" : "warn" },
				icon(converter.exists ? "check" : "alert"),
				h("span", { text: converter.exists ? "PotreeConverter ready" : "PotreeConverter not found" })));
		}
		const preview = health.preview?.available;
		if (preview != null) {
			items.push(h("li", { class: preview ? "ok" : "warn", title: health.preview.reason || null }, icon(preview ? "check" : "alert"),
				h("span", { text: preview ? "Preview renderer ready" : "Preview renderer unavailable" })));
		}
		const queue = health.queue;
		if (queue && (queue.running || queue.queued)) {
			items.push(h("li", { class: "info" }, icon("clock"), h("span", { text: `${queue.running || 0} running, ${queue.queued || 0} queued` })));
		}
		note.replaceChildren(...(items.length ? [h("p", { class: "nav-note-title", text: "Server" }), h("ul", null, items)] : []));

		const previewBox = this.$("f-preview");
		const unavailable = preview === false;
		previewBox.disabled = unavailable;
		if (unavailable) previewBox.checked = false;
		this.$("f-preview-note").textContent = unavailable ? "— not available on this server" : "— shown on the project card";
		this.applyImportModes();

		const alert = this.$("wizard-alert");
		if (converter && !converter.exists && alert.dataset.kind !== "submit") {
			alert.hidden = false;
			alert.dataset.kind = "converter";
			alert.className = "form-alert warn";
			alert.replaceChildren(icon("alert"), h("div", null,
				h("p", null, h("strong", { text: "PotreeConverter was not found on the server." }),
					" Conversion will fail until it is installed", converter.path ? " at " : ".",
					converter.path ? h("code", { text: converter.path }) : null, converter.path ? "." : null)));
		} else if (alert.dataset.kind === "converter") {
			alert.hidden = true;
			alert.dataset.kind = "";
		}
	}

	/**
	 * Offer only the import modes the service accepts (health.importModes; "move" needs MOVE_ROOTS).
	 * An older service that does not say keeps all three.
	 */
	applyImportModes() {
		const health = this.getHealth() || {};
		const modes = Array.isArray(health.importModes) ? health.importModes : null;
		const roots = Array.isArray(health.moveRoots) ? health.moveRoots.filter((r) => typeof r === "string") : [];
		for (const input of this.form.querySelectorAll('input[name="importMode"]')) {
			const offered = !modes || modes.includes(input.value);
			const card = input.closest(".radio-card");
			let note = card.querySelector(".rc-note");
			let text = "";
			if (!offered) {
				text = input.value === "move"
					? "Not available: moving is switched off on this server (it needs MOVE_ROOTS, see deploy/README.md)."
					: `Not available on this server.`;
			} else if (input.value === "move" && roots.length) {
				text = `Only for sources inside ${roots.join(", ")}.`;
			}
			input.disabled = !offered;
			card.classList.toggle("is-disabled", !offered);
			if (text && !note) {
				note = h("span", { class: "rc-note", id: `f-import-${input.value}-note` });
				card.append(note);
				input.setAttribute("aria-describedby", note.id);
			}
			if (note) {
				note.hidden = !text;
				note.replaceChildren(...(text ? [icon(offered ? "info" : "lock"), h("span", { text })] : []));
			}
		}
		const checked = this.form.querySelector('input[name="importMode"]:checked');
		if (!checked || checked.disabled) this.form.querySelector('input[name="importMode"][value="copy"]').checked = true;
	}

	async loadCrs() {
		let list = [];
		let error = null;
		try {
			const data = await this.api.crs();
			list = (Array.isArray(data) ? data : data?.crs || []).filter((c) => c && c.name);
		} catch (err) {
			error = err.message;
		}
		this.crsList = error ? null : list;
		const main = this.$("f-crs");
		const keep = main.value;
		// Without a list the user must choose explicitly (custom or local) rather than get a silent default.
		const preferred = list.some((c) => c.name === DEFAULT_CRS) ? DEFAULT_CRS : list[0]?.name || "";
		const option = (value, text, isDefault = false) => {
			const o = h("option", { value, text });
			o.defaultSelected = isDefault;
			return o;
		};
		setChildren(main,
			option("", "Select a coordinate system…"),
			list.length ? h("optgroup", { label: "Known systems" }, list.map((c) => option(c.name, c.title ? `${c.name} — ${c.title}` : c.name, c.name === preferred))) : null,
			h("optgroup", { label: "Other" },
				option("local", "Local coordinates (not georeferenced)"),
				option(CUSTOM, "Custom proj4 definition…")),
		);
		main.value = keep && [...main.options].some((o) => o.value === keep) ? keep : preferred;
		this.fillCrsSelect(this.$("f-pano-crs"));
		for (const row of this.vectorRows) this.fillCrsSelect(row.crs);
		const err = this.$("f-crs-err");
		if (error) {
			err.hidden = false;
			err.replaceChildren(icon("alert-circle"), h("span", { text: `Could not load the CRS list (${error}). Choose “Custom proj4” or try again later.` }));
		}
		this.syncConditional();
	}

	/** "Same as point cloud" + the known systems, keeping the current choice. */
	fillCrsSelect(select) {
		const keep = select.value;
		const same = h("option", { value: "", text: "Same as point cloud" });
		same.defaultSelected = true;
		select.replaceChildren(same, ...(this.crsList || []).map((c) => h("option", { value: c.name, text: c.title ? `${c.name} — ${c.title}` : c.name })));
		select.value = [...select.options].some((o) => o.value === keep) ? keep : "";
	}

	syncConditional() {
		this.$("f-crs-custom").hidden = this.$("f-crs").value !== CUSTOM;
		this.$("f-attr-custom-field").hidden = this.$("f-attr").value !== CUSTOM;
		const pano = this.$("f-pano-enabled").checked;
		this.$("f-pano-body").hidden = !pano;
		this.form.querySelector('[data-hint-for="encoding"]').textContent = ENCODING_HINTS[this.radio("encoding")] || "";
	}

	// -----------------------------------------------------------------------------------------
	// Repeatable rows

	addLabelRow({ name = "", path = "" } = {}) {
		const n = ++this.rowSeq;
		const row = {
			name: h("input", { type: "text", id: `f-label-name-${n}`, value: name, maxlength: 60, placeholder: "e.g. Cityscapes", "aria-describedby": `f-label-name-${n}-err` }),
			path: h("input", { type: "text", id: `f-label-path-${n}`, class: "mono", value: path, spellcheck: "false", autocapitalize: "off", placeholder: "/mnt/Data2/…/label_cityscape", "aria-describedby": `f-label-path-${n}-err f-label-inspect-${n}` }),
			inspect: h("div", { class: "inspect", id: `f-label-inspect-${n}`, hidden: true, "aria-live": "polite" }),
		};
		const browse = h("button", { type: "button", class: "btn" }, icon("folder"), "Browse…");
		const remove = h("button", { type: "button", class: "icon-btn", "aria-label": "Remove this label set", title: "Remove" }, icon("trash"));
		row.el = h("li", { class: "row-card" },
			h("div", { class: "row-grid label-row" },
				h("div", { class: "field" },
					h("label", { for: row.name.id, text: "Name" }), row.name,
					h("p", { class: "field-error", id: `f-label-name-${n}-err`, hidden: true })),
				h("div", { class: "field" },
					h("label", { for: row.path.id, text: "Label folder" }),
					h("div", { class: "path-field" }, row.path, browse),
					h("p", { class: "field-error", id: `f-label-path-${n}-err`, hidden: true }),
					row.inspect),
				h("div", { class: "row-remove" }, remove)));
		this.bindPath(row.path, browse, row.inspect, "labels", () => ({
			title: "Choose a label folder", mode: "dir",
			description: "Label images with the same file names as the panoramas.",
		}), (picked) => { if (!row.name.value.trim()) row.name.value = prettyName(picked); });
		remove.addEventListener("click", () => {
			this.dirty = true;
			row.el.remove();
			this.labelRows = this.labelRows.filter((r) => r !== row);
			this.$("f-label-add").focus();
			if (this.attempted) this.showErrors(this.validate());
		});
		this.labelRows.push(row);
		this.$("f-label-rows").append(row.el);
		return row;
	}

	addVectorRow({ path = "", name = "" } = {}) {
		const n = ++this.rowSeq;
		const row = {
			path: h("input", { type: "text", id: `f-vec-path-${n}`, class: "mono", value: path, spellcheck: "false", autocapitalize: "off", placeholder: "/mnt/Data2/…/layers.gpkg", "aria-describedby": `f-vec-path-${n}-err f-vec-inspect-${n}` }),
			name: h("input", { type: "text", id: `f-vec-name-${n}`, value: name, maxlength: 80, placeholder: "Defaults to the file name" }),
			crs: h("select", { id: `f-vec-crs-${n}` }),
			inspect: h("div", { class: "inspect", id: `f-vec-inspect-${n}`, hidden: true, "aria-live": "polite" }),
		};
		this.fillCrsSelect(row.crs);
		const browse = h("button", { type: "button", class: "btn" }, icon("file"), "Browse…");
		const remove = h("button", { type: "button", class: "icon-btn", "aria-label": "Remove this GeoPackage", title: "Remove" }, icon("trash"));
		row.el = h("li", { class: "row-card" },
			h("div", { class: "row-grid vector-row" },
				h("div", { class: "field span-2" },
					h("label", { for: row.path.id, text: "GeoPackage file" }),
					h("div", { class: "path-field" }, row.path, browse),
					h("p", { class: "field-error", id: `f-vec-path-${n}-err`, hidden: true }),
					row.inspect),
				h("div", { class: "row-remove" }, remove),
				h("div", { class: "field" }, h("label", { for: row.name.id, text: "Display name" }), row.name),
				h("div", { class: "field" }, h("label", { for: row.crs.id, text: "CRS" }), row.crs)));
		this.bindPath(row.path, browse, row.inspect, "vector", () => ({
			title: "Choose a GeoPackage", mode: "file", ext: "gpkg",
		}));
		row.path.addEventListener("change", () => {
			if (!row.name.value.trim() && row.path.value.trim()) row.name.placeholder = basename(row.path.value.trim()).replace(/\.gpkg$/i, "");
		});
		remove.addEventListener("click", () => {
			this.dirty = true;
			row.el.remove();
			this.vectorRows = this.vectorRows.filter((r) => r !== row);
			this.$("f-vector-add").focus();
			if (this.attempted) this.showErrors(this.validate());
		});
		this.vectorRows.push(row);
		this.$("f-vector-rows").append(row.el);
		return row;
	}

	// -----------------------------------------------------------------------------------------
	// Validation

	existingIds() {
		return new Set(this.getProjects().map((p) => p.id));
	}

	idError() {
		const id = this.$("f-id").value.trim();
		if (!id) return "Enter a project id.";
		if (!ID_PATTERN.test(id)) {
			if (id.length < 2) return "Use at least 2 characters.";
			if (/^-/.test(id)) return "Start with a letter or digit.";
			return "Use lowercase letters, digits and dashes only (max 63 characters).";
		}
		if (this.existingIds().has(id)) return "A project with this id already exists.";
		return null;
	}

	/** The id gets live feedback (it is generated as you type the title). */
	validateIdLive() {
		const input = this.$("f-id");
		const message = input.value.trim() || this.attempted ? this.idError() : null;
		this.setFieldError(input, this.$("f-id-err"), message);
		this.$("f-id-hint").hidden = !!message;
	}

	/** @returns {{input: HTMLElement, errEl: HTMLElement, message: string}[]} */
	validate() {
		const errors = [];
		const v = (id) => this.$(id).value.trim();
		const fail = (input, errEl, message) => errors.push({ input, errEl, message });
		const pathError = (input, label) => {
			const value = input.value.trim();
			if (!value) return `Enter the ${label}.`;
			if (!isAbsolute(value)) return "Use an absolute server path (starting with /).";
			const inspection = this.inspections.get(input);
			if (inspection && inspection.ok === false) return inspection.message ? `Not usable: ${inspection.message}` : "This path cannot be used.";
			return null;
		};

		if (!v("f-title")) fail(this.$("f-title"), this.$("f-title-err"), "Enter a title.");
		const idMessage = this.idError();
		if (idMessage) fail(this.$("f-id"), this.$("f-id-err"), idMessage);

		const pcMessage = pathError(this.$("f-pc-path"), "path of the point cloud");
		if (pcMessage) fail(this.$("f-pc-path"), this.$("f-pc-path-err"), pcMessage);

		const crs = this.$("f-crs").value;
		if (!crs) fail(this.$("f-crs"), this.$("f-crs-err"), "Choose the coordinate system of the point cloud.");
		if (crs === CUSTOM) {
			const name = v("f-crs-name");
			if (!name) fail(this.$("f-crs-name"), this.$("f-crs-name-err"), "Give the custom CRS a name, e.g. EPSG:31467.");
			else if (/\s/.test(name)) fail(this.$("f-crs-name"), this.$("f-crs-name-err"), "Names cannot contain spaces.");
			if (!/\+proj=/.test(v("f-crs-proj4"))) fail(this.$("f-crs-proj4"), this.$("f-crs-proj4-err"), "Enter a proj4 definition (it starts with +proj=).");
		}

		if (this.$("f-pano-enabled").checked) {
			const panoMessage = pathError(this.$("f-pano-path"), "panorama folder");
			if (panoMessage) fail(this.$("f-pano-path"), this.$("f-pano-path-err"), panoMessage);
			const coords = v("f-pano-coords");
			if (!coords) fail(this.$("f-pano-coords"), this.$("f-pano-coords-err"), "Enter the coordinates file name.");
			else if (isAbsolute(coords) || coords.includes("..")) fail(this.$("f-pano-coords"), this.$("f-pano-coords-err"), "Give a file name inside the panorama folder.");
			const seen = new Set();
			for (const row of this.labelRows) {
				const name = row.name.value.trim();
				const nameErr = this.$(`${row.name.id}-err`);
				if (!name) fail(row.name, nameErr, "Name this label set.");
				else if (seen.has(name.toLowerCase())) fail(row.name, nameErr, "Label set names must be unique.");
				seen.add(name.toLowerCase());
				const message = pathError(row.path, "label folder");
				if (message) fail(row.path, this.$(`${row.path.id}-err`), message);
			}
		}

		for (const row of this.vectorRows) {
			let message = pathError(row.path, "GeoPackage path");
			if (!message && !/\.gpkg$/i.test(row.path.value.trim())) message = "Expected a GeoPackage (.gpkg) file.";
			if (message) fail(row.path, this.$(`${row.path.id}-err`), message);
		}

		if (this.$("f-attr").value === CUSTOM && !ATTRIBUTE_RE.test(v("f-attr-custom"))) {
			fail(this.$("f-attr-custom"), this.$("f-attr-custom-err"), "Enter the attribute name: letters, digits, _, -, . or spaces, at most 64 characters (e.g. gps-time).");
		}
		const budget = Number(v("f-budget"));
		if (!Number.isInteger(budget) || budget < 100000 || budget > 20000000) {
			fail(this.$("f-budget"), this.$("f-budget-err"), "Use a whole number between 100,000 and 20,000,000.");
		}
		const size = Number(v("f-size"));
		if (!(size >= 0.1 && size <= 10)) fail(this.$("f-size"), this.$("f-size-err"), "Use a value between 0.1 and 10.");
		return errors;
	}

	setFieldError(input, errEl, message) {
		if (!errEl) return;
		if (message) {
			input.setAttribute("aria-invalid", "true");
			errEl.hidden = false;
			errEl.replaceChildren(icon("alert-circle"), h("span", { text: message }));
		} else {
			input.removeAttribute("aria-invalid");
			errEl.hidden = true;
			errEl.replaceChildren();
		}
	}

	showErrors(errors) {
		const crsErr = this.$("f-crs-err");
		const keepCrsLoadError = !this.crsList && !crsErr.hidden && !errors.some((e) => e.errEl === crsErr);
		for (const el of this.form.querySelectorAll(".field-error")) {
			if (el === crsErr && keepCrsLoadError) continue;
			el.hidden = true;
			el.replaceChildren();
		}
		for (const el of this.form.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
		for (const { input, errEl, message } of errors) this.setFieldError(input, errEl, message);
		this.$("f-id-hint").hidden = errors.some((e) => e.input.id === "f-id");

		const sections = new Set(errors.map((e) => e.input.closest(".form-section")?.id));
		for (const link of this.dialog.querySelectorAll(".wizard-nav a[data-section]")) {
			link.toggleAttribute("data-error", sections.has(link.dataset.section));
		}
		const status = this.$("wizard-status");
		status.dataset.kind = errors.length ? "error" : "";
		status.replaceChildren(...(errors.length
			? [icon("alert-circle"), h("span", { text: errors.length === 1 ? "1 field needs attention" : `${errors.length} fields need attention` })]
			: []));
	}

	// -----------------------------------------------------------------------------------------
	// Submit

	buildRequest() {
		const v = (id) => this.$(id).value.trim();
		const crs = this.$("f-crs").value;
		const pointcloud = { path: v("f-pc-path"), crs: crs === CUSTOM ? v("f-crs-name") : crs };
		if (crs === CUSTOM) pointcloud.proj4 = v("f-crs-proj4");
		const pano = this.$("f-pano-enabled").checked;
		const preview = this.$("f-preview");
		return {
			id: v("f-id"),
			title: v("f-title"),
			description: v("f-description"),
			keywords: this.keywords.values,
			location: v("f-location"),
			date: v("f-date"),
			source: v("f-source"),
			pointcloud,
			conversion: { encoding: this.radio("encoding"), method: this.radio("method") },
			images360: pano ? { path: v("f-pano-path"), coordinatesFile: v("f-pano-coords"), crs: this.$("f-pano-crs").value || null } : null,
			labelSets: pano ? this.labelRows.map((r) => ({ name: r.name.value.trim(), path: r.path.value.trim() })) : [],
			vectors: this.vectorRows.map((r) => {
				const path = r.path.value.trim();
				return { path, name: r.name.value.trim() || basename(path).replace(/\.gpkg$/i, ""), crs: r.crs.value || null };
			}),
			importMode: this.radio("importMode"),
			viewer: {
				pointBudget: Number(v("f-budget")),
				classificationScheme: this.$("f-scheme").value || null,
				controls: this.$("f-controls").value,
				edl: this.$("f-edl").checked,
				fov: 60,
			},
			material: {
				activeAttribute: this.$("f-attr").value === CUSTOM ? v("f-attr-custom") : this.$("f-attr").value,
				gradient: null,
				size: Number(v("f-size")),
				pointSizeType: this.$("f-sizetype").value,
				shape: "SQUARE",
			},
			view: null,
			renderPreview: preview.checked && !preview.disabled,
		};
	}

	async submit() {
		this.attempted = true;
		this.keywords.commit();
		const errors = this.validate();
		this.showErrors(errors);
		this.validateIdLive();
		if (errors.length) {
			const first = errors[0].input;
			const details = first.closest("details");
			if (details) details.open = true;
			first.focus({ preventScroll: true });
			first.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
			return;
		}
		const request = this.buildRequest();
		const submit = this.$("wizard-submit");
		const alert = this.$("wizard-alert");
		submit.disabled = true;
		submit.replaceChildren(h("span", { class: "spinner sm on-accent" }), "Starting…");
		try {
			const response = await this.api.createProject(request);
			if (!response?.jobId) throw new Error("The server did not return a job id.");
			alert.hidden = true;
			alert.dataset.kind = "";
			this.submitted.set(response.jobId, request);
			this.jobs.track({ jobId: response.jobId, projectId: response.projectId || request.id, title: request.title, kind: "create" });
			this.dialog.close();
			// The project is on its way: the form is free for the next one.
			this.reset();
			this.jobs.open(response.jobId);
		} catch (err) {
			if (err.status === 409) this.setFieldError(this.$("f-id"), this.$("f-id-err"), err.message);
			alert.hidden = false;
			alert.dataset.kind = "submit";
			alert.className = "form-alert danger";
			const details = err.details;
			const lines = Array.isArray(details) ? details.map(String)
				: details && typeof details === "object" ? Object.entries(details).map(([k, val]) => `${k}: ${typeof val === "string" ? val : JSON.stringify(val)}`)
				: typeof details === "string" ? [details] : [];
			alert.replaceChildren(icon("alert-circle"), h("div", null,
				h("p", null, h("strong", { text: "The project could not be started." }), " ", err.message),
				lines.length ? h("ul", null, lines.map((line) => h("li", { text: line }))) : null));
			this.scroller.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
		} finally {
			submit.disabled = false;
			submit.replaceChildren(icon("check"), "Create project");
		}
	}

	/** Called by the portal when a create job ends; a succeeded job needs no retry. */
	jobFinished(jobId, succeeded) {
		if (succeeded) this.submitted.delete(jobId);
	}

	reset() {
		this.form.reset();
		this.keywords.setValues([]);
		for (const row of [...this.labelRows, ...this.vectorRows]) row.el.remove();
		this.labelRows = [];
		this.vectorRows = [];
		this.inspections.clear();
		for (const el of this.form.querySelectorAll(".inspect")) el.hidden = true;
		this.idDirty = false;
		this.attempted = false;
		this.$("f-advanced").open = false;
		const alert = this.$("wizard-alert");
		if (["submit", "retry"].includes(alert.dataset.kind)) { alert.hidden = true; alert.dataset.kind = ""; }
		this.showErrors([]);
		this.$("f-id-hint").hidden = false;
		this.renderServiceNote();
		this.syncConditional();
		this.scroller.scrollTop = 0;
		this.dirty = false;
	}
}
