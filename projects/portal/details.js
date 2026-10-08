// Project details drawer: full description, keywords, dataset facts and layers (read from the
// project's own project.json), links, and — when the project service is up — metadata editing
// (PATCH) and preview re-rendering (POST …/preview, followed through jobs.js).

import { h, icon, formatInt, formatCompact, formatDate, formatDateTime, relativeTime, crsLabel, wireDialog } from "./util.js";
import { fetchJson } from "./api.js";
import { previewMedia } from "./placeholder.js";
import { badgeList, metaLine } from "./present.js";
import { createChipInput, normalizeKeywords } from "./chip-input.js";

const isRemote = (url) => /^https?:\/\//i.test(String(url || ""));

function paragraphs(text, cls = "prose") {
	const parts = String(text || "").split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
	return h("div", { class: cls }, parts.map((t) => h("p", { text: t })));
}

function section(title, ...content) {
	return h("section", { class: "drawer-section" }, h("h3", { text: title }), ...content);
}

/** Display names of Potree.ClassificationScheme keys. */
const SCHEME_LABELS = { AI3D: "GridNet-HD", MAGIC3D: "MAGIC3D" };

export class DetailsPanel {
	/**
	 * @param {object} deps
	 * @param {object} deps.api
	 * @param {import("./jobs.js").JobCenter} deps.jobs
	 * @param {() => boolean} deps.isLive          project service reachable?
	 * @param {() => "ok"|"unconfigured"|"offline"} deps.editState  can metadata be edited here?
	 * @param {() => Promise<boolean>} deps.ensureAccess  ask for the access token if needed
	 * @param {() => object|null} deps.getHealth
	 * @param {() => string[]} deps.getKeywords
	 * @param {(keyword: string) => void} deps.onKeyword   filter the gallery by a keyword
	 * @param {(id: string) => Promise<void>} deps.onUpdated  reload the registry after a change
	 */
	constructor(deps) {
		Object.assign(this, deps);
		this.dialog = document.getElementById("details");
		this.frame = document.getElementById("details-frame");
		this.project = null;
		this.full = null;
		this.mode = "view";
		this.previewJobId = null;
		// Outcome of the last action, shown in the drawer itself: toasts would sit under this modal.
		this.notice = null; // { kind: "ok" | "warn" | "danger" | "info", title?, text }
		wireDialog(this.dialog, { lightDismiss: true });
		this.dialog.addEventListener("close", () => {
			this.project = null;
			this.full = null;
			this.notice = null;
		});
		this.dialog.addEventListener("cancel", (event) => {
			// Esc while editing returns to the details first.
			if (this.mode === "edit") {
				event.preventDefault();
				this.mode = "view";
				this.render();
			}
		});
		this.jobs.subscribe(() => this.renderPreviewJob());
		this.frame.addEventListener("scroll", () => this.syncTopBar(), { passive: true });
	}

	/** Solid top bar (with the title) once the preview image has scrolled away. */
	syncTopBar() {
		const hero = this.frame.querySelector(".drawer-hero");
		if (hero && !hero.offsetHeight) return; // not laid out yet (dialog still closed)
		const threshold = hero ? hero.offsetHeight - 58 : 8;
		this.frame.toggleAttribute("data-scrolled", this.frame.scrollTop > threshold);
	}

	topBar(title) {
		return h("div", { class: "drawer-top" },
			h("span", { class: "drawer-top-title", "aria-hidden": "true", text: title }),
			h("button", { type: "button", class: "icon-btn drawer-close", "data-close": "", "aria-label": "Close details" }, icon("x")));
	}

	get openId() {
		return this.dialog.open ? this.project?.id : null;
	}

	open(project) {
		this.project = project;
		this.full = null;
		this.mode = "view";
		this.notice = null;
		const previewJobs = [...this.jobs.jobs.values()].filter((j) => j.kind === "preview" && j.projectId === project.id);
		this.previewJobId = previewJobs.length ? previewJobs[previewJobs.length - 1].id : null;
		this.render();
		if (!this.dialog.open) this.dialog.showModal();
		this.frame.scrollTop = 0;
		this.syncTopBar();
		this.loadFull(project.id);
	}

	/** Registry entry changed (after an edit or a preview render): refresh what is shown. */
	update(project) {
		if (!this.dialog.open || this.project?.id !== project.id) return;
		this.project = project;
		if (this.mode === "view") {
			const scroll = this.frame.scrollTop;
			this.render();
			this.frame.scrollTop = scroll;
		}
	}

	async loadFull(id) {
		let full = null;
		if (this.isLive()) {
			try { full = await this.api.project(id); } catch { /* fall back to the static file */ }
		}
		if (!full) {
			try { full = await fetchJson(`${encodeURIComponent(id)}/project.json`); } catch { full = null; }
		}
		if (this.project?.id !== id) return;
		this.full = full || false;
		if (this.mode === "view") this.renderExtras();
	}

	render() {
		if (this.mode === "edit") return this.renderEdit();
		const p = this.project;
		const editState = this.editState();
		const health = this.getHealth() || {};
		const previewUnavailable = health.preview?.available === false;
		const media = previewMedia(p, { eager: true, alt: `Preview of ${p.title}` });
		media.classList.add("drawer-media");

		const actions = [
			h("a", { class: "btn primary", href: p.url }, icon("arrow-right"), "Open project"),
			h("a", { class: "btn", href: `${encodeURIComponent(p.id)}/project.json`, target: "_blank", rel: "noopener" }, icon("code"), "project.json"),
		];
		if (editState === "ok") {
			actions.push(
				h("button", { type: "button", class: "btn", onclick: () => this.startEdit() }, icon("edit"), "Edit info"),
				h("button", {
					type: "button", class: "btn", id: "details-render",
					disabled: previewUnavailable,
					title: previewUnavailable ? "The preview renderer is not available on this server" : null,
					onclick: () => this.requestPreview(),
				}, icon("refresh"), "Re-render preview"));
		}
		const lockNote = editState === "unconfigured"
			? h("p", { class: "drawer-note" }, icon("lock"),
				h("span", { text: "Editing is disabled: the project service has no access token configured (see deploy/README.md)." }))
			: null;

		const keywords = (p.keywords || []).length
			? h("ul", { class: "chips" }, p.keywords.map((k) => h("li", null, h("button", {
				type: "button", class: "chip-btn", title: `Show projects tagged “${k}”`,
				onclick: () => { this.dialog.close(); this.onKeyword(k); },
			}, k))))
			: h("p", { class: "muted", text: "No keywords." });

		this.frame.classList.remove("is-edit");
		this.frame.replaceChildren(
			this.topBar(p.title),
			h("div", { class: "drawer-hero" }, media, badgeList(p, "badges on-media")),
			h("div", { class: "drawer-body" },
				h("header", { class: "drawer-header" },
					h("h2", { id: "details-title", text: p.title }),
					metaLine(p, "meta-line drawer-meta")),
				h("div", { class: "drawer-actions" }, actions),
				lockNote,
				this.renderNotice(),
				h("div", { class: "details-job", hidden: true, "aria-live": "polite" }),
				section("About", p.description ? paragraphs(p.description) : h("p", { class: "muted", text: "No description yet." })),
				section("Keywords", keywords),
				section("Dataset", this.facts()),
				h("div", { class: "drawer-extras" }, section("Layers", h("p", { class: "muted loading-line" }, h("span", { class: "spinner sm" }), "Reading project.json…")))));
		this.renderPreviewJob();
		if (this.full !== null) this.renderExtras();
		this.syncTopBar();
	}

	renderNotice() {
		const n = this.notice;
		if (!n) return null;
		const iconName = { ok: "check", warn: "alert", danger: "alert-circle", info: "info" }[n.kind] || "info";
		return h("div", { class: `form-alert ${n.kind} drawer-notice`, role: n.kind === "danger" ? "alert" : "status" },
			icon(iconName),
			h("p", null, n.title ? h("strong", { text: `${n.title} ` }) : null, n.text),
			h("button", {
				type: "button", class: "icon-btn sm", "aria-label": "Dismiss",
				onclick: () => { this.notice = null; this.frame.querySelector(".drawer-notice")?.remove(); },
			}, icon("x")));
	}

	/** Show an action's outcome in the drawer (view mode). */
	showNotice(notice) {
		this.notice = notice;
		if (this.mode !== "view" || !this.dialog.open) return;
		const current = this.frame.querySelector(".drawer-notice");
		const next = this.renderNotice();
		if (current) current.replaceWith(next);
		else this.frame.querySelector(".drawer-actions")?.after(next);
	}

	facts() {
		const p = this.project;
		const s = p.stats || {};
		const rows = [];
		const row = (term, ...value) => rows.push(h("div", { class: "fact" }, h("dt", { text: term }), h("dd", null, ...value)));
		if (Number(s.points) > 0) row("Points", formatInt(s.points), h("span", { class: "muted", text: ` (${formatCompact(s.points)})` }));
		if (Number(s.pointclouds) > 1) row("Point clouds", formatInt(s.pointclouds));
		row("Coordinate system", crsLabel(p.crs));
		if (Number(s.images360) > 0) row("360° panoramas", formatInt(s.images360));
		if (Array.isArray(s.labelSets) && s.labelSets.length) row("Label sets", s.labelSets.join(", "));
		if (Number(s.vectors) > 0) row("Vector layers", formatInt(s.vectors));
		if (Number(s.meshes) > 0) row("Meshes", formatInt(s.meshes));
		if (p.date) row("Acquired", formatDate(p.date));
		if (p.source) row("Source", p.source);
		row("Viewer page", p.custom ? "Custom (hand-written)" : "Generated from project.json");
		if (p.updatedAt) row("Updated", relativeTime(p.updatedAt), h("span", { class: "muted", text: ` · ${formatDateTime(p.updatedAt)}` }));
		row("Project id", h("code", { text: p.id }));
		return h("dl", { class: "facts" }, rows);
	}

	/** Layers, notes, viewer defaults and conversion info — need the full project.json. */
	renderExtras() {
		const holder = this.frame.querySelector(".drawer-extras");
		if (!holder) return;
		const full = this.full;
		if (!full) {
			holder.replaceChildren(section("Layers", h("p", { class: "muted", text: "project.json could not be read." })));
			return;
		}
		const items = [];
		const layer = (iconName, name, detail, tags = []) => items.push(h("li", { class: "layer" },
			icon(iconName),
			h("div", { class: "layer-text" },
				h("span", { class: "layer-name", text: name }),
				detail ? h("span", { class: "layer-detail", text: detail }) : null),
			tags.length ? h("span", { class: "layer-tags" }, tags.map((t) => h("span", { class: "tag", text: t }))) : null));

		for (const pc of full.pointclouds || []) {
			const attr = pc.material?.activeAttribute;
			layer("points", pc.name || "Point cloud", attr ? `Coloured by ${attr}` : null, pc.visible === false ? ["hidden"] : []);
		}
		if (full.images360) {
			const sets = full.images360.labelSets || [];
			layer("pano", "360° panoramas", sets.length ? `Label sets: ${sets.map((s) => s.name || s.id).join(", ")}` : "No label sets",
				full.images360.crs ? [full.images360.crs] : []);
		}
		for (const v of full.vectors || []) {
			const tags = [];
			if (v.lazy || v.manifest) tags.push("on demand");
			if (isRemote(v.url)) tags.push("remote");
			if (v.visible === false) tags.push("hidden");
			if (v.crs) tags.push(v.crs);
			layer("vector", v.name || "Vector layer", v.manifest ? "GeoPackage manifest" : "GeoPackage", tags);
		}
		for (const m of full.meshes || []) {
			const tags = [];
			if (isRemote(m.url)) tags.push("remote");
			if (m.crs) tags.push(m.crs);
			layer("mesh", m.name || "Mesh", m.format ? m.format.toUpperCase() : null, tags);
		}

		const sections = [section("Layers", items.length ? h("ul", { class: "layers" }, items) : h("p", { class: "muted", text: "No layers listed." }))];

		const viewer = full.viewer || {};
		const viewerBits = [];
		if (viewer.controls) viewerBits.push(`${viewer.controls[0].toUpperCase()}${viewer.controls.slice(1)} controls`);
		if (viewer.pointBudget) viewerBits.push(`${formatCompact(viewer.pointBudget)} point budget`);
		if (viewer.classificationScheme) viewerBits.push(`${SCHEME_LABELS[viewer.classificationScheme] ?? viewer.classificationScheme} classes`);
		if (viewer.edl) viewerBits.push("Eye-dome lighting");
		if (full.view) viewerBits.push("Saved start view");
		if (viewerBits.length) sections.push(section("Viewer defaults", h("p", { class: "inline-list" }, viewerBits.map((b) => h("span", { text: b })))));

		if (full.notes) sections.push(section("Notes", paragraphs(full.notes)));

		const conv = full.conversion;
		if (conv && typeof conv === "object") {
			const rows = [];
			const row = (term, value) => { if (value) rows.push(h("div", { class: "fact" }, h("dt", { text: term }), h("dd", null, value))); };
			row("Input", conv.input ? h("code", { class: "path", text: String(conv.input) }) : null);
			row("Encoding", conv.encoding);
			row("Sampling", conv.method);
			row("Finished", conv.finishedAt ? formatDateTime(conv.finishedAt) : null);
			if (rows.length) sections.push(section("Conversion", h("dl", { class: "facts" }, rows)));
		}
		holder.replaceChildren(...sections);
	}

	// -----------------------------------------------------------------------------------------
	// Preview re-rendering

	async requestPreview() {
		const p = this.project;
		const button = this.frame.querySelector("#details-render");
		if (button) button.disabled = true;
		try {
			const response = await this.api.renderPreview(p.id);
			if (!response?.jobId) throw new Error("The server did not return a job id.");
			this.previewJobId = response.jobId;
			this.jobs.track({ jobId: response.jobId, kind: "preview", projectId: p.id, title: p.title });
		} catch (err) {
			this.showNotice({ kind: "danger", title: "Could not start the preview.", text: err.message });
			if (button) button.disabled = false;
		}
	}

	renderPreviewJob() {
		const box = this.frame.querySelector(".details-job");
		if (!box || !this.project) return;
		const job = this.previewJobId ? this.jobs.get(this.previewJobId) : null;
		const button = this.frame.querySelector("#details-render");
		if (!job || job.projectId !== this.project.id) {
			box.hidden = true;
			return;
		}
		const status = this.jobs.statusOf(job);
		const active = this.jobs.isActive(job);
		const pct = Math.round(this.jobs.progressOf(job));
		if (button) button.disabled = active || this.getHealth()?.preview?.available === false;
		box.hidden = false;
		box.dataset.status = status;
		const text = active && job.stale ? (job.needsAuth ? "Rendering preview… sign in to follow it." : `Rendering preview… ${pct}% (reconnecting to the service)`)
			: active ? `Rendering preview… ${pct}%`
			: status === "succeeded" ? "Preview updated."
			: status === "failed" ? `Preview failed: ${job.data?.error || "see the log"}`
			: "Lost track of the preview job.";
		box.replaceChildren(
			active ? h("span", { class: "spinner sm" }) : icon(status === "succeeded" ? "check" : "alert-circle"),
			h("div", { class: "details-job-text" },
				h("span", { text }),
				active ? h("span", { class: "progress sm", role: "progressbar", "aria-label": "Preview progress", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), style: `--progress:${pct}%` }, h("span", { class: "progress-bar" })) : null),
			h("button", { type: "button", class: "link-btn", onclick: () => this.jobs.open(job.id) }, "View log"));
	}

	// -----------------------------------------------------------------------------------------
	// Metadata editing

	async startEdit() {
		if (!(await this.ensureAccess()) || !this.dialog.open) return;
		this.mode = "edit";
		this.render();
	}

	renderEdit() {
		const p = this.full && this.full.id === this.project.id ? { ...this.project, ...this.full } : this.project;
		const field = (id, label, control, hint) => h("div", { class: "field" },
			h("label", { for: id, text: label }), control,
			hint ? h("p", { class: "field-hint", text: hint }) : null,
			h("p", { class: "field-error", id: `${id}-err`, hidden: true }));
		const title = h("input", { id: "e-title", type: "text", value: p.title || "", maxlength: 160, required: true, "aria-describedby": "e-title-err" });
		const location = h("input", { id: "e-location", type: "text", value: p.location || "", maxlength: 120 });
		const date = h("input", { id: "e-date", type: "text", value: p.date || "", maxlength: 40, placeholder: "YYYY-MM-DD" });
		const source = h("input", { id: "e-source", type: "text", value: p.source || "", maxlength: 120 });
		const description = h("textarea", { id: "e-description", rows: 7, maxlength: 4000 });
		description.value = p.description || "";
		const keywordBox = h("div", { class: "chip-input" });
		const alert = h("div", { class: "form-alert danger", role: "alert", hidden: true });
		const save = h("button", { type: "submit", class: "btn primary" }, icon("check"), "Save changes");

		const form = h("form", { class: "edit-form", novalidate: true },
			h("header", { class: "drawer-header" },
				h("h2", { id: "details-title", text: p.title })),
			h("p", { class: "muted", text: "Changes the listing only. Data, layers and viewer settings stay as they are." }),
			alert,
			field("e-title", "Title", title),
			h("div", { class: "field-row" }, field("e-location", "Location", location), field("e-date", "Acquisition date", date)),
			field("e-source", "Source / credit", source),
			field("e-description", "Description", description, "Plain text. Leave an empty line between paragraphs."),
			h("div", { class: "field" }, h("label", { for: "e-keywords", text: "Keywords" }), keywordBox),
			h("div", { class: "edit-actions" },
				h("button", { type: "button", class: "btn", onclick: () => { this.mode = "view"; this.render(); } }, "Cancel"),
				save));
		const keywords = createChipInput(keywordBox, { inputId: "e-keywords", values: p.keywords || [], suggestions: this.getKeywords() });
		const inputs = { title, description, location, date, source };
		// Send only what changed, plus the updatedAt the form was loaded from: the service answers
		// 409 when someone else saved the project in between (and writes nothing).
		const norm = (value) => String(value ?? "").trim();
		let original;
		let expectedUpdatedAt;
		const loadedFrom = (project) => {
			original = { keywords: JSON.stringify(normalizeKeywords(project.keywords)) };
			for (const key of Object.keys(inputs)) original[key] = norm(project[key]);
			expectedUpdatedAt = project.updatedAt ?? null;
		};
		loadedFrom(p);
		/** After a 409: show their version of every field this form did not change, keep the rest. */
		const mergeLatest = (latest) => {
			for (const [key, input] of Object.entries(inputs)) {
				if (norm(input.value) === original[key]) input.value = latest[key] ?? "";
			}
			if (JSON.stringify(keywords.values) === original.keywords) keywords.setValues(latest.keywords || []);
			loadedFrom(latest);
			if (latest.id === this.project.id) this.full = latest;
		};
		form.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
		});
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			const err = form.querySelector("#e-title-err");
			if (!title.value.trim()) {
				title.setAttribute("aria-invalid", "true");
				err.hidden = false;
				err.replaceChildren(icon("alert-circle"), h("span", { text: "Enter a title." }));
				title.focus();
				return;
			}
			title.removeAttribute("aria-invalid");
			err.hidden = true;
			const patch = {};
			for (const [key, input] of Object.entries(inputs)) {
				const value = norm(input.value);
				if (value !== original[key]) patch[key] = value || (key === "title" || key === "description" ? value : null);
			}
			const nextKeywords = keywords.values;
			if (JSON.stringify(nextKeywords) !== original.keywords) patch.keywords = nextKeywords;
			if (!Object.keys(patch).length) {
				this.mode = "view";
				this.notice = { kind: "info", text: "Nothing changed." };
				this.render();
				return;
			}
			patch.expectedUpdatedAt = expectedUpdatedAt;
			save.disabled = true;
			save.replaceChildren(h("span", { class: "spinner sm on-accent" }), "Saving…");
			try {
				const { project: updated, warnings } = await this.api.updateProject(this.project.id, patch);
				delete patch.expectedUpdatedAt;
				if (updated && updated.id === this.project.id) this.full = updated;
				Object.assign(this.project, patch);
				this.mode = "view";
				// Saved, but the server may not have rewritten the page or registry.json (X-Warnings).
				this.notice = warnings.length
					? { kind: "warn", title: "Saved, with problems:", text: `${warnings.join("; ")}. The project page and the static project list may still show the old info.` }
					: { kind: "ok", text: "Project info saved." };
				this.render();
				await this.onUpdated(this.project.id);
			} catch (error) {
				let latest = null;
				if (error.status === 409) {
					try { latest = await this.api.project(this.project.id); } catch { /* keep the plain error */ }
				}
				alert.hidden = false;
				if (latest) {
					mergeLatest(latest);
					alert.className = "form-alert warn";
					alert.replaceChildren(icon("alert"), h("p", null, h("strong", { text: "Someone else saved this project meanwhile. " }),
						"Fields you did not edit now show their version; your edits are kept. Check them, then save again."));
				} else {
					alert.className = "form-alert danger";
					alert.replaceChildren(icon("alert-circle"), h("p", null, h("strong", { text: "Not saved. " }), error.message));
				}
				save.disabled = false;
				save.replaceChildren(icon("check"), "Save changes");
			}
		});
		this.frame.classList.add("is-edit");
		this.frame.replaceChildren(this.topBar("Edit project info"), h("div", { class: "drawer-body" }, form));
		this.frame.scrollTop = 0;
		this.syncTopBar();
		title.focus();
	}
}
