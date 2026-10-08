// Presentation helpers shared by the project cards and the details drawer.

import { h, icon, formatInt, formatCompact, formatDate, crsLabel } from "./util.js";

const stats = (p) => p.stats || {};

/** Feature badges shown over the preview: 360°, label sets. */
export function projectBadges(p) {
	const s = stats(p);
	const out = [];
	if (Number(s.images360) > 0) out.push({ text: "360°", title: `${formatInt(s.images360)} panoramas`, kind: "pano" });
	const labels = Array.isArray(s.labelSets) ? s.labelSets : [];
	if (labels.length) out.push({ text: labels.length > 1 ? `Labels ×${labels.length}` : "Labels", title: `Label sets: ${labels.join(", ")}`, kind: "labels" });
	return out;
}

export function badgeList(p, cls = "badges") {
	const items = projectBadges(p);
	if (!items.length) return null;
	return h("ul", { class: cls, "aria-label": "Features" },
		items.map((b) => h("li", { class: `badge badge-${b.kind}`, title: b.title, text: b.text })));
}

/** "Ollon, VD · 6 Nov 2025" parts (location, acquisition date). */
export function metaLine(p, cls = "meta-line") {
	const parts = [];
	if (p.location) parts.push(h("span", { class: "meta-item" }, icon("pin"), h("span", { text: p.location })));
	const date = formatDate(p.date);
	if (date) parts.push(h("span", { class: "meta-item" }, icon("calendar"), h("span", { text: date })));
	if (!parts.length && p.source) parts.push(h("span", { class: "meta-item", text: p.source }));
	if (!parts.length) return null;
	return h("p", { class: cls }, parts);
}

/** Compact stats for a card: points, CRS, panoramas, label sets, vector layers, meshes. */
export function statItems(p) {
	const s = stats(p);
	const items = [];
	if (Number(s.points) > 0) items.push({ icon: "points", text: `${formatCompact(s.points)} pts`, label: `${formatInt(s.points)} points` });
	if (p.crs !== undefined) items.push({ icon: "globe", text: p.crs === "local" ? "Local" : crsLabel(p.crs), label: `Coordinate system: ${crsLabel(p.crs)}` });
	if (Number(s.images360) > 0) items.push({ icon: "pano", text: `${formatInt(s.images360)} panos`, label: `${formatInt(s.images360)} 360° panoramas` });
	const labels = Array.isArray(s.labelSets) ? s.labelSets : [];
	if (labels.length) items.push({ icon: "labels", text: labels.join(", "), label: `Label sets: ${labels.join(", ")}`, wide: true });
	if (Number(s.vectors) > 0) items.push({ icon: "vector", text: `${s.vectors} vector${s.vectors === 1 ? "" : "s"}`, label: `${s.vectors} vector layer${s.vectors === 1 ? "" : "s"}` });
	if (Number(s.meshes) > 0) items.push({ icon: "mesh", text: `${s.meshes} mesh${s.meshes === 1 ? "" : "es"}`, label: `${s.meshes} mesh${s.meshes === 1 ? "" : "es"}` });
	return items;
}

export function statList(p) {
	return h("ul", { class: "stats", "aria-label": "Dataset" }, statItems(p).map((item) =>
		h("li", { class: item.wide ? "stat stat-wide" : "stat", title: item.label },
			icon(item.icon),
			h("span", { class: "stat-text", "aria-hidden": "true", text: item.text }),
			h("span", { class: "visually-hidden", text: item.label }))));
}
