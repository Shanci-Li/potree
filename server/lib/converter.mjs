// Runs PotreeConverter 2.x and parses its progress output.
//
// Facts from the converter source (Converter/src/main.cpp, indexer.cpp, include/Monitor.h):
// * `-i <files and/or directories>`: a directory contributes EVERY entry directly inside it whose name
//   ends in "las"/"laz" (case-insensitive, no dot required): dot-files such as macOS "._x.laz" and
//   sub-folders named "las" included. The service therefore always passes the exact files it validated
//   (see converterInputs). The first input's stem becomes metadata.json "name".
// * `-o <dir>` receives metadata.json, hierarchy.bin, octree.bin and log.txt (temporary chunks/
//   is removed at the end).
// * `--encoding BROTLI` compresses nodes; any other value (default "DEFAULT") stores them raw.
// * `-m poisson | poisson_average | random` selects the sampler.
// * `--projection <string>` is copied verbatim (between quotes, unescaped) into metadata.json
//   "projection"; Potree reads it as the point cloud's proj4 definition.
// * Every second it prints
//   `[<total>%, <time>s], [<PASS>: <pass>%, duration: <d>s, throughput: <t>MPs][RAM: ..., CPU: ...%]`
//   with passes COUNTING / DISTRIBUTING (chunking) and INDEXING (empty before the first pass);
//   numbers use ' as thousands separator.
// * Errors are printed as `ERROR(...)` and end the process with exit code 123.

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const NICE = "/usr/bin/nice";
const PROGRESS_RE = /^\[\s*(-?[\d']+(?:\.\d+)?)%,\s*([\d'.]+)s\],\s*\[([A-Z_]*):\s*(-?[\d']+(?:\.\d+)?)%/;
const PROGRESS_LOG_INTERVAL_MS = 15000;
// Input lists longer than this (bytes) are passed as a folder of symlinks instead of on the command
// line, far below Linux ARG_MAX (2 MiB here, shared with the environment).
const MAX_INPUT_ARG_BYTES = 256 * 1024;
// Non-progress output lines kept to explain a crash that printed no ERROR line.
const RECENT_LINES = 5;

const activeChildren = new Set();

/** Parse a converter progress line → {percent, pass, passPercent} (percent clamped to 0..100), or null. */
export function parseProgressLine(line) {
	const m = PROGRESS_RE.exec(line.trim());
	if (!m) {
		return null;
	}
	const num = (s) => Number.parseFloat(s.replace(/'/g, ""));
	const clamp = (v) => Math.max(0, Math.min(100, v));
	return { percent: clamp(num(m[1])), pass: m[3] || "STARTING", passPercent: clamp(num(m[4])) };
}

export function converterAvailable(converter) {
	try {
		fs.accessSync(converter, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Converter `-i` arguments for an explicit list of LAS/LAZ files: the files themselves, or, when the
 * list is too long for the command line, `linkDir` (created here) filled with one symlink per file.
 * The links are numbered and keep the file name, so the converter's "*las / *laz" match takes exactly
 * these files. The caller removes `linkDir` after the conversion; its name becomes metadata "name".
 */
export async function converterInputs(files, linkDir, maxArgBytes = MAX_INPUT_ARG_BYTES) {
	if (files.length === 0) {
		throw new Error("no point-cloud files to convert");
	}
	const argBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file) + 1, 0);
	if (argBytes <= maxArgBytes) {
		return files;
	}
	await fsp.mkdir(linkDir, { recursive: true });
	const width = String(files.length - 1).length;
	for (const [i, file] of files.entries()) {
		await fsp.symlink(file, path.join(linkDir, `${String(i).padStart(width, "0")}_${path.basename(file)}`));
	}
	return [linkDir];
}

/**
 * Run the converter (low CPU priority, no shell). Non-progress output goes to `onLine`; progress
 * lines go to `onProgress` and only every PROGRESS_LOG_INTERVAL_MS (or on a pass change) to `onLine`.
 * Aborting `signal` terminates the converter and rejects with the signal's reason.
 */
export function runConverter({ converter, inputs, outDir, encoding, method, projection, onLine, onProgress, signal }) {
	const args = ["-i", ...inputs, "-o", outDir, "--encoding", encoding, "-m", method];
	if (projection) {
		args.push("--projection", projection);
	}
	const useNice = fs.existsSync(NICE);
	const command = useNice ? NICE : converter;
	const commandArgs = useNice ? ["-n", "10", converter, ...args] : args;
	onLine(`$ ${[converter, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
		activeChildren.add(child);
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		const errorLines = [];
		const recentLines = [];
		let lastPass = null;
		let lastLogged = 0;

		const handleLine = (line) => {
			if (line.trim() === "") {
				return;
			}
			const progress = parseProgressLine(line);
			if (progress) {
				onProgress(progress);
				const now = Date.now();
				if (progress.pass !== lastPass || now - lastLogged >= PROGRESS_LOG_INTERVAL_MS) {
					lastPass = progress.pass;
					lastLogged = now;
					onLine(line.trim());
				}
				return;
			}
			if (/ERROR/i.test(line)) {
				errorLines.push(line.trim());
			}
			recentLines.push(line.trim());
			if (recentLines.length > RECENT_LINES) {
				recentLines.shift();
			}
			onLine(line);
		};
		readline.createInterface({ input: child.stdout }).on("line", handleLine);
		readline.createInterface({ input: child.stderr }).on("line", handleLine);

		const settle = () => {
			activeChildren.delete(child);
			signal?.removeEventListener("abort", onAbort);
		};
		child.on("error", (err) => {
			settle();
			reject(new Error(`cannot start PotreeConverter: ${err.message}`));
		});
		child.on("close", (code, killSignal) => {
			settle();
			if (code === 0) {
				resolve();
				return;
			}
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}
			const reason = killSignal ? `was killed by ${killSignal}` : `exited with code ${code}`;
			// ERROR lines when there are any, else the last output lines (e.g. "terminate called ...").
			const lines = (errorLines.length ? errorLines : recentLines).slice(-3);
			const detail = lines.length ? `: ${lines.join(" | ")}` : "";
			reject(new Error(`PotreeConverter ${reason}${detail}`));
		});
	});
}

/** Terminate running converters (server shutdown). */
export function killConverters() {
	for (const child of activeChildren) {
		child.kill("SIGTERM");
	}
}
