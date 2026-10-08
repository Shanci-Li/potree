// Generated stand-in previews for projects without preview.jpg: a small synthetic point cloud
// (terrain, power line corridor or street canyon, picked from the project's keywords) drawn on a
// canvas, seeded by the project id so every card keeps its own stable picture.

import { h, icon, hashString, initials } from "./util.js";

export const PLACEHOLDER_WIDTH = 768;
export const PLACEHOLDER_HEIGHT = 432;

// Colour ramps (low → high) that read well on the dark viewer-like background.
const RAMPS = [
	["#23407a", "#2c7bb6", "#3fb59a", "#cfe16b", "#f2b84b"],
	["#173f5f", "#20639b", "#3caea3", "#a8d5a2", "#f6d55c"],
	["#2e1f5e", "#6a3d8f", "#b5517b", "#ec8a5b", "#f9cf7a"],
	["#1d3b5c", "#2f6f9f", "#61a5c2", "#a9d6e5", "#e8f4f8"],
	["#203a2c", "#2f6b46", "#5f9e4f", "#b9c96a", "#efe3a1"],
];

function mulberry32(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Smooth 2D value noise in [0, 1], fractal sum of four octaves. */
function makeNoise(rand) {
	const perm = new Uint8Array(512);
	const values = new Float32Array(256);
	const p = Array.from({ length: 256 }, (_, i) => i);
	for (let i = 255; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[p[i], p[j]] = [p[j], p[i]];
	}
	for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
	for (let i = 0; i < 256; i++) values[i] = rand();
	const lattice = (x, y) => values[perm[(perm[x & 255] + y) & 255]];
	const smooth = (t) => t * t * (3 - 2 * t);
	const noise = (x, y) => {
		const xi = Math.floor(x), yi = Math.floor(y);
		const u = smooth(x - xi), v = smooth(y - yi);
		const a = lattice(xi, yi), b = lattice(xi + 1, yi), c = lattice(xi, yi + 1), d = lattice(xi + 1, yi + 1);
		return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
	};
	return (x, y) => {
		let sum = 0, amp = 0.5, freq = 1, norm = 0;
		for (let o = 0; o < 4; o++) {
			sum += amp * noise(x * freq, y * freq);
			norm += amp;
			amp *= 0.5;
			freq *= 2.1;
		}
		return sum / norm;
	};
}

function hexToRgb(hex) {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rampColor(ramp, t) {
	t = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
	const i = Math.min(ramp.length - 2, Math.floor(t));
	const f = t - i;
	const a = ramp[i], b = ramp[i + 1];
	return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function sceneKind(project) {
	const text = [project.title, ...(project.keywords || [])].join(" ").toLowerCase();
	if (/power ?line|pylon|catenary|transmission/.test(text)) return "powerline";
	if (/mobile|street|road|panoram|360|mapping/.test(text)) return "street";
	return "terrain";
}

/**
 * Paint the placeholder for `project` into `canvas` (sized PLACEHOLDER_WIDTH × PLACEHOLDER_HEIGHT).
 * Points are collected first, then drawn far-to-near so nearer points cover farther ones.
 */
export function paintPlaceholder(canvas, project) {
	const W = PLACEHOLDER_WIDTH, H = PLACEHOLDER_HEIGHT;
	canvas.width = W;
	canvas.height = H;
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const seed = hashString(String(project.id || project.title || "project"));
	const rand = mulberry32(seed);
	const noise = makeNoise(rand);
	const ramp = RAMPS[seed % RAMPS.length].map(hexToRgb);
	const kind = sceneKind(project);

	// Background: the dark gradient of the Potree viewer, with a soft glow at the horizon.
	const bg = ctx.createLinearGradient(0, 0, 0, H);
	bg.addColorStop(0, "#0a111c");
	bg.addColorStop(1, "#1a2435");
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, W, H);
	const glow = ctx.createRadialGradient(W * 0.5, H * 0.42, 10, W * 0.5, H * 0.42, W * 0.6);
	glow.addColorStop(0, "rgba(120,150,200,0.16)");
	glow.addColorStop(1, "rgba(120,150,200,0)");
	ctx.fillStyle = glow;
	ctx.fillRect(0, 0, W, H);

	const points = []; // [depth, x, y, size, r, g, b, alpha]
	// Pinhole camera without pitch: a high horizon offset makes the drone views look down.
	const camera = kind === "street"
		? { y: 0.26, horizon: H * 0.46, focal: W * 0.62 }
		: { y: 1.5, horizon: -H * 0.06, focal: W * 0.62 };
	const fogColor = [26, 36, 53];
	const project3 = (x, y, z, rgb, sizeScale = 1, alphaScale = 1) => {
		if (z <= 0.05) return;
		const sx = W / 2 + (x / z) * camera.focal;
		const sy = camera.horizon + ((camera.y - y) / z) * camera.focal;
		if (sx < -4 || sx > W + 4 || sy < -4 || sy > H + 4) return;
		const fog = Math.min(1, Math.max(0, (z - 1) / 7));
		const r = rgb[0] + (fogColor[0] - rgb[0]) * fog * 0.5;
		const g = rgb[1] + (fogColor[1] - rgb[1]) * fog * 0.5;
		const b = rgb[2] + (fogColor[2] - rgb[2]) * fog * 0.5;
		const size = Math.min(3.6, Math.max(1.3, (3 / z) * sizeScale));
		points.push([z, sx, sy, size, r, g, b, (1 - fog * 0.4) * alphaScale]);
	};

	const ox = rand() * 50, oz = rand() * 50;
	const ground = (x, z) => (noise(x * 0.9 + ox, z * 0.9 + oz) - 0.5) * (kind === "powerline" ? 0.9 : 1.2);

	if (kind === "street") {
		buildStreet(project3, rand, noise, ramp, ox);
	} else {
		// Terrain seen from a drone: log-distributed depth keeps screen density roughly even;
		// a hillshade from the height gradient makes the relief readable.
		const count = 40000;
		const e = 0.02;
		for (let i = 0; i < count; i++) {
			const z = 0.5 * Math.pow(7 / 0.5, rand());
			const x = (rand() * 2 - 1) * (z * 0.7 + 0.25);
			const y = ground(x, z);
			const dx = (ground(x + e, z) - ground(x - e, z)) / (2 * e);
			const dz = (ground(x, z + e) - ground(x, z - e)) / (2 * e);
			const shade = Math.min(1.3, Math.max(0.55, 1 + dx * 0.5 - dz * 0.3)) * (0.9 + rand() * 0.2);
			const t = 0.28 + (y + 0.5) * 0.72;
			project3(x, y, z, rampColor(ramp, kind === "powerline" ? t * 0.85 : t).map((c) => Math.min(255, c * shade)), 1.1);
		}
		if (kind === "powerline") buildPowerLine(project3, ground, rand);
	}

	points.sort((a, b) => b[0] - a[0]);
	for (const [, x, y, size, r, g, b, alpha] of points) {
		ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${alpha.toFixed(3)})`;
		ctx.fillRect(x - size / 2, y - size / 2, size, size);
	}
}

/** Pylons with three sagging conductors across the terrain. */
function buildPowerLine(project3, ground, rand) {
	const steel = [226, 232, 242];
	const wire = [255, 206, 120];
	// The corridor crosses the view diagonally; direction and span count vary per project.
	const flip = rand() < 0.5 ? -1 : 1;
	const start = { x: flip * (1.3 + rand() * 0.5), z: 5.2 };
	const end = { x: -flip * (0.55 + rand() * 0.3), z: 1.9 };
	const spans = rand() < 0.5 ? 3 : 4;
	const pylons = Array.from({ length: spans + 1 }, (_, i) => {
		const t = i / spans;
		const x = start.x + (end.x - start.x) * t;
		const z = start.z + (end.z - start.z) * t;
		return { x, z, base: ground(x, z), height: 0.62 };
	});
	for (const p of pylons) {
		// Lattice tower: two converging legs, cross-bracing and a cross-arm near the top.
		for (let v = 0; v <= 1; v += 0.012) {
			const half = 0.07 * (1 - v) + 0.012;
			const y = p.base + v * p.height;
			project3(p.x - half, y, p.z, steel, 0.8);
			project3(p.x + half, y, p.z, steel, 0.8);
			if (Math.round(v * 83) % 9 === 0) {
				for (let u = -half; u <= half; u += 0.01) project3(p.x + u, y, p.z, steel, 0.7, 0.8);
			}
		}
		for (let u = -0.17; u <= 0.17; u += 0.006) project3(p.x + u, p.base + p.height * 0.86, p.z, steel, 0.8);
	}
	const offsets = [-0.16, 0, 0.16];
	for (let i = 0; i < pylons.length - 1; i++) {
		const a = pylons[i], b = pylons[i + 1];
		for (const off of offsets) {
			const ya = a.base + a.height * (off === 0 ? 1 : 0.86);
			const yb = b.base + b.height * (off === 0 ? 1 : 0.86);
			for (let t = 0; t <= 1; t += 0.004) {
				const x = a.x + (b.x - a.x) * t + off;
				const z = a.z + (b.z - a.z) * t;
				const y = ya + (yb - ya) * t - 0.12 * 4 * t * (1 - t);
				project3(x, y, z, wire, 0.7);
			}
		}
	}
}

/** Street canyon seen from a mapping vehicle: road with markings, facades, a few trees. */
function buildStreet(project3, rand, noise, ramp, seedOffset) {
	const zNear = 0.32, zFar = 9;
	const depth = () => zNear * Math.pow(zFar / zNear, rand());
	const road = [72, 80, 96];
	const marking = [236, 240, 245];
	// Road surface and sidewalks with a slight noise texture.
	for (let i = 0; i < 7000; i++) {
		const z = depth();
		const x = (rand() * 2 - 1) * 0.62;
		const shade = 0.85 + noise(x * 30 + seedOffset, z * 6) * 0.3;
		const sidewalk = Math.abs(x) > 0.42;
		const base = sidewalk ? [104, 112, 126] : road;
		project3(x, sidewalk ? 0.015 : 0, z, base.map((c) => c * shade), 0.9);
	}
	// Lane markings: dashed centre line, solid edge lines.
	for (let z = zNear; z < zFar; z += 0.012) {
		if (Math.floor(z * 2.2) % 2 === 0) project3(0, 0.001, z, marking, 0.9);
		project3(-0.4, 0.001, z, marking, 0.8, 0.8);
		project3(0.4, 0.001, z, marking, 0.8, 0.8);
	}
	// Facades: blocks of varying height on both sides, coloured by height with a per-block shift.
	for (const side of [-1, 1]) {
		let z = zNear;
		while (z < zFar) {
			const length = 0.35 + rand() * 0.7;
			const height = 0.45 + rand() * 0.75;
			const setback = 0.64 + rand() * 0.08;
			const shift = rand() * 0.25;
			const n = Math.round(2600 * length);
			for (let i = 0; i < n; i++) {
				const zz = z + rand() * length;
				const y = rand() * height;
				const t = 0.15 + (y / 1.25) * 0.6 + shift;
				// Window rows read as slightly brighter bands.
				const band = Math.floor(y * 14) % 3 === 1 ? 1.25 : 1.05;
				project3(side * setback, y, zz, rampColor(ramp, t).map((c) => Math.min(255, c * band)), 0.85);
			}
			z += length + 0.04;
		}
		// Trees along the sidewalk.
		for (let k = 0; k < 7; k++) {
			const tz = zNear + 0.3 + rand() * 4;
			const tx = side * (0.5 + rand() * 0.04);
			const crown = 0.1 + rand() * 0.05;
			for (let i = 0; i < 220; i++) {
				const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * crown;
				project3(tx + Math.cos(a) * r, 0.36 + Math.sin(a) * r * 0.9, tz + (rand() - 0.5) * crown, [96, 150, 88].map((c) => c * (0.8 + rand() * 0.4)), 0.8);
			}
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Card / drawer media: the preview image when there is one, else the generated placeholder.

const pending = new WeakMap();
const observer = "IntersectionObserver" in window
	? new IntersectionObserver((entries) => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			observer.unobserve(entry.target);
			const project = pending.get(entry.target);
			pending.delete(entry.target);
			if (project) paintPlaceholder(entry.target, project);
		}
	}, { rootMargin: "300px 0px" })
	: null;

function paintWhenVisible(canvas, project) {
	if (!observer) return paintPlaceholder(canvas, project);
	pending.set(canvas, project);
	observer.observe(canvas);
}

/**
 * 16:9 media box for a project. A missing or broken preview.jpg falls back to the placeholder.
 * @param {object} project registry entry
 * @param {{eager?: boolean, alt?: string}} options
 */
export function previewMedia(project, { eager = false, alt = "" } = {}) {
	const box = h("div", { class: "media" });
	const showPlaceholder = () => {
		const canvas = h("canvas", { class: "media-canvas", width: PLACEHOLDER_WIDTH, height: PLACEHOLDER_HEIGHT, "aria-hidden": "true" });
		box.dataset.kind = "placeholder";
		box.replaceChildren(canvas,
			h("span", { class: "media-monogram", "aria-hidden": "true", text: initials(project.title) }),
			h("span", { class: "media-tag" }, icon("image"), "Preview not rendered yet"));
		paintWhenVisible(canvas, project);
	};
	if (project.preview) {
		const img = h("img", { src: project.preview, alt, loading: eager ? "eager" : "lazy", decoding: "async", width: 1280, height: 720 });
		img.addEventListener("error", showPlaceholder, { once: true });
		img.addEventListener("load", () => { box.dataset.loaded = "true"; }, { once: true });
		box.dataset.kind = "image";
		box.append(img);
	} else {
		showPlaceholder();
	}
	return box;
}
