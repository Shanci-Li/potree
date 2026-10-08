// Headless preview renderer (Playwright Chromium) and the static file server it can use.
//
// Project pages honour the preview contract (SPEC §3): with ?preview=1 they hide the GUI and set
// window.__projectReady (and window.__projectError on fatal errors) once the scene has settled.
// Custom pages have no such hook; they get the load event plus a fixed delay.

import fs from "node:fs";
import path from "node:path";
import express from "express";
import { config } from "./config.mjs";
import { isSafeRelativePath, writeFileAtomic } from "./util.mjs";

const VIEWPORT = { width: 1280, height: 720 };
const READY_TIMEOUT_MS = 150_000;
const CUSTOM_PAGE_DELAY_MS = 20_000;
const GOTO_TIMEOUT_MS = 60_000;
const JPEG_QUALITY = 85;

const GPU_ARGS = ["--use-gl=angle", "--use-angle=gl-egl", "--ignore-gpu-blocklist", "--enable-gpu"];
const SWIFTSHADER_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

let playwrightPromise = null;

function loadPlaywright() {
	playwrightPromise ??= import("playwright").then((m) => m.default ?? m);
	return playwrightPromise;
}

/** Whether Playwright and its Chromium build are installed. */
export async function previewAvailability() {
	try {
		const { chromium } = await loadPlaywright();
		const executable = chromium.executablePath();
		return fs.existsSync(executable) ? { available: true } : { available: false, reason: `Chromium not installed (${executable})` };
	} catch (err) {
		return { available: false, reason: `playwright not loadable: ${err.message}` };
	}
}

/** Express middleware serving POTREE_ROOT (dot files and dot folders are denied). */
export function staticRootMiddleware() {
	return express.static(config.potreeRoot, { dotfiles: "deny", index: ["index.html"], fallthrough: true });
}

/** Start a temporary static server for POTREE_ROOT on 127.0.0.1 (random port). */
export async function startStaticServer() {
	const app = express();
	app.use(staticRootMiddleware());
	const server = await new Promise((resolve, reject) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s)).on("error", reject);
	});
	return {
		baseUrl: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise((resolve) => {
			server.closeAllConnections?.();
			server.close(() => resolve());
		}),
	};
}

function previewPageUrl(baseUrl, id, project) {
	const entry = project.entry || "index.html";
	return `${baseUrl}${config.projectsUrlPath}/${encodeURIComponent(id)}/${encodeURIComponent(entry)}?preview=1`;
}

/**
 * Renders project previews with one browser per batch: the browser is launched on first use
 * (GPU WebGL, else SwiftShader) and kept until close().
 */
export class PreviewRenderer {
	constructor({ baseUrl }) {
		this.baseUrl = baseUrl;
		this.browserPromise = null;
		this.rendererInfo = null;
	}

	async launch() {
		const { chromium } = await loadPlaywright();
		const attempts = [["GPU", GPU_ARGS], ["SwiftShader", SWIFTSHADER_ARGS]];
		const failures = [];
		for (const [name, args] of attempts) {
			let browser = null;
			try {
				browser = await chromium.launch({ args });
				const page = await browser.newPage();
				const gl = await page.evaluate(() => {
					const canvas = document.createElement("canvas");
					const ctx = canvas.getContext("webgl2") || canvas.getContext("webgl");
					if (!ctx) {
						return null;
					}
					const ext = ctx.getExtension("WEBGL_debug_renderer_info");
					return ext ? ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER);
				});
				await page.close();
				if (gl) {
					this.rendererInfo = `${name}: ${gl}`;
					return browser;
				}
				failures.push(`${name}: no WebGL context`);
			} catch (err) {
				failures.push(`${name}: ${err.message.split("\n")[0]}`);
			}
			await browser?.close().catch(() => {});
		}
		throw new Error(`cannot start a WebGL-capable headless Chromium (${failures.join("; ")})`);
	}

	browser() {
		this.browserPromise ??= this.launch().catch((err) => {
			this.browserPromise = null;
			throw err;
		});
		return this.browserPromise;
	}

	/**
	 * Render projects/<id>/<preview> from its page in preview mode. `log(line)` receives progress and
	 * page console errors. Returns {file, ms, renderer}.
	 */
	async render(id, project, log = () => {}) {
		const previewName = project.preview || "preview.jpg";
		if (!isSafeRelativePath(previewName) || !/\.jpe?g$/i.test(previewName)) {
			throw new Error(`unsupported preview file name: ${previewName}`);
		}
		const browser = await this.browser();
		const url = previewPageUrl(this.baseUrl, id, project);
		const started = Date.now();
		log(`rendering ${url} (${this.rendererInfo})`);
		const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
		try {
			const page = await context.newPage();
			page.on("console", (msg) => {
				if (msg.type() === "error") {
					log(`[page console.error] ${msg.text()}`);
				}
			});
			page.on("pageerror", (err) => log(`[page error] ${err.message}`));
			page.on("requestfailed", (req) => {
				const reason = req.failure()?.errorText ?? "";
				if (!reason.includes("ERR_ABORTED")) {
					log(`[request failed] ${req.url()} ${reason}`);
				}
			});

			const response = await page.goto(url, { waitUntil: "load", timeout: GOTO_TIMEOUT_MS });
			if (response && !response.ok()) {
				throw new Error(`page responded with HTTP ${response.status()}`);
			}
			if (project.custom === true) {
				log(`custom page: waiting ${CUSTOM_PAGE_DELAY_MS / 1000} s after load`);
				await page.waitForTimeout(CUSTOM_PAGE_DELAY_MS);
			} else {
				try {
					await page.waitForFunction(() => window.__projectReady === true, null, { timeout: READY_TIMEOUT_MS, polling: 500 });
				} catch {
					throw new Error(`page did not signal window.__projectReady within ${READY_TIMEOUT_MS / 1000} s`);
				}
				const pageError = await page.evaluate(() => window.__projectError || null);
				if (pageError) {
					throw new Error(`page reported an error: ${pageError}`);
				}
			}
			const jpeg = await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY });
			const file = path.join(config.projectsDir, id, previewName);
			await writeFileAtomic(file, jpeg);
			const ms = Date.now() - started;
			log(`preview written: ${file} (${Math.round(jpeg.length / 1024)} KB, ${(ms / 1000).toFixed(1)} s)`);
			return { file, ms, renderer: this.rendererInfo };
		} finally {
			await context.close().catch(() => {});
		}
	}

	async close() {
		const pending = this.browserPromise;
		this.browserPromise = null;
		if (pending) {
			const browser = await pending.catch(() => null);
			await browser?.close().catch(() => {});
		}
	}
}
