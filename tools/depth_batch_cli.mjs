#!/usr/bin/env node
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFile} from "node:child_process";
import {pipeline} from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function usage(){
	return `Usage:
  node tools/depth_batch_cli.mjs --pointcloud <metadata.json> --coordinates <coordinates.txt> --out <dir> [options]
  node tools/depth_batch_cli.mjs serve --out <dir> [--port 3100]

Options:
  --width <n>              Output width, default 8000
  --height <n>             Output height, default 4000
  --near <n>               Camera near plane, default 0.1
  --far <n>                Camera far plane, default 1000000
  --point-budget <n>       Potree point budget, default 10000000
  --warmup-frames <n>      Visibility warmup frames, default 8
  --point-size <n>         Point size, default 1
  --min-point-size <n>     Minimum point size, default 2
  --max-point-size <n>     Maximum point size, default 50
  --classifications <spec> Class filter, for example 2,6,9-12
  --start-index <n>        First coordinates row to render, default 0
  --end-index <n>          Last coordinates row to render, default last
  --gpus <ids>             NVIDIA GPU ids, for example 0,1. Defaults to nvidia-smi discovery.
  --workers-per-gpu <n>    Chromium workers per GPU, default 1
  --port <n>               Local coordinator port, default 3100
  --overwrite              Regenerate existing TIFFs
  --headed                 Launch visible Chromium windows for debugging
  --browser-executable <p> Use a system Chromium/Chrome executable instead of Playwright-managed Chromium
  --transform-lonlat       Transform x/y from WGS84 to point-cloud projection
  --legacy-potree-paths    Use legacy pano/coordinates.txt paths
`;
}

function parseArgs(argv){
	const args = {_: []};
	for(let i = 0; i < argv.length; i++){
		const arg = argv[i];
		if(!arg.startsWith("--")){
			args._.push(arg);
			continue;
		}

		const eq = arg.indexOf("=");
		const rawKey = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
		const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		if(eq >= 0){
			args[key] = arg.slice(eq + 1);
			continue;
		}

		const next = argv[i + 1];
		if(next && !next.startsWith("--")){
			args[key] = next;
			i++;
		}else{
			args[key] = true;
		}
	}
	return args;
}

function numeric(value, fallback){
	if(value === undefined || value === null || value === ""){
		return fallback;
	}
	const parsed = Number(value);
	if(!Number.isFinite(parsed)){
		throw new Error(`Invalid number: ${value}`);
	}
	return parsed;
}

function integer(value, fallback){
	return Math.trunc(numeric(value, fallback));
}

function isUrl(value){
	return /^https?:\/\//i.test(String(value || ""));
}

function joinUrl(base, relativePath){
	const b = String(base).replace(/\/+$/, "");
	const r = String(relativePath).replace(/\\/g, "/").replace(/^\/+/, "");
	return r ? `${b}/${r.split("/").map(encodeURIComponent).join("/")}` : b;
}

function sanitizePathSegment(segment){
	return String(segment || "")
		.replace(/[<>:"|?*\x00-\x1f]/g, "_")
		.replace(/^\.+$/, "_")
		.trim() || "_";
}

function safeOutputPath(root, relativePath){
	const raw = String(relativePath || "").replace(/"/g, "").replace(/\\/g, "/").split(/[?#]/)[0];
	const noDrive = raw.replace(/^[a-zA-Z]:/, "").replace(/^\/+/, "");
	const parts = noDrive.split("/")
		.filter(part => part && part !== "." && part !== "..")
		.map(sanitizePathSegment);
	if(parts.length === 0){
		throw new Error("Output path is empty");
	}

	const target = path.resolve(root, ...parts);
	const normalizedRoot = path.resolve(root);
	if(target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${path.sep}`)){
		throw new Error(`Unsafe output path: ${relativePath}`);
	}
	return target;
}

async function pathExists(filePath){
	try{
		await fsp.access(filePath);
		return true;
	}catch(error){
		return false;
	}
}

function execFileText(command, args){
	return new Promise((resolve, reject) => {
		execFile(command, args, {encoding: "utf8"}, (error, stdout, stderr) => {
			if(error){
				error.stderr = stderr;
				reject(error);
			}else{
				resolve(stdout);
			}
		});
	});
}

async function discoverNvidiaGpus(){
	try{
		const stdout = await execFileText("nvidia-smi", ["--query-gpu=index", "--format=csv,noheader"]);
		const ids = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
		return ids.length > 0 ? ids : [null];
	}catch(error){
		console.warn("nvidia-smi discovery failed; using one default GPU/browser worker");
		return [null];
	}
}

function parseGpuIds(value){
	if(value === undefined || value === null || value === ""){
		return null;
	}
	const ids = String(value).split(",").map(id => id.trim()).filter(Boolean);
	return ids.length > 0 ? ids : null;
}

function normalizeConfig(args){
	return {
		pointcloud: args.pointcloud,
		coordinates: args.coordinates,
		out: args.out,
		width: integer(args.width, 8000),
		height: integer(args.height, 4000),
		near: numeric(args.near, 0.1),
		far: numeric(args.far, 1000000),
		pointBudget: integer(args.pointBudget, 10000000),
		warmupFrames: integer(args.warmupFrames, 8),
		pointSize: numeric(args.pointSize, 1),
		minPointSize: numeric(args.minPointSize, 2),
		maxPointSize: numeric(args.maxPointSize, 50),
		classifications: args.classifications || args.classification || "",
		startIndex: args.startIndex === undefined ? undefined : integer(args.startIndex, 0),
		endIndex: args.endIndex === undefined ? undefined : integer(args.endIndex, 0),
		overwrite: !!args.overwrite,
		headed: !!args.headed,
		transformCoordinates: !!(args.transformLonlat || args.transformCoordinates),
		legacyPotreePaths: !!args.legacyPotreePaths,
		gpus: args.gpus,
		workersPerGpu: Math.max(1, integer(args.workersPerGpu, 1)),
		port: integer(args.port, 3100),
		browserExecutable: args.browserExecutable || "",
	};
}

async function readCoordinatesText(input){
	if(!input){
		throw new Error("--coordinates is required");
	}
	if(isUrl(input)){
		const response = await fetch(input);
		if(!response.ok){
			throw new Error(`Coordinates request failed with HTTP ${response.status}`);
		}
		return response.text();
	}
	return fsp.readFile(path.resolve(process.cwd(), input), "utf8");
}

async function createCoordinatorServer(config = {}){
	const app = express();
	const mounts = new Map();
	const defaultOutputRoot = path.resolve(process.cwd(), config.out || ".");
	const jobOutputRoots = new Map();
	await fsp.mkdir(defaultOutputRoot, {recursive: true});

	const outputRootForRequest = (req) => {
		const jobId = req.query.jobId || (req.body && req.body.jobId);
		return jobOutputRoots.get(jobId) || defaultOutputRoot;
	};

	app.use((req, res, next) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");
		if(req.method === "OPTIONS"){
			res.status(204).end();
			return;
		}
		next();
	});

	app.get("/api/depth-batch/health", (req, res) => {
		res.json({ok: true, root: ROOT, out: defaultOutputRoot});
	});

	app.get("/api/depth-batch/exists", async (req, res, next) => {
		try{
			const outputRoot = outputRootForRequest(req);
			const target = safeOutputPath(outputRoot, req.query.path);
			res.json({exists: await pathExists(target)});
		}catch(error){
			next(error);
		}
	});

	app.post("/api/depth-batch/write", async (req, res, next) => {
		try{
			const outputRoot = outputRootForRequest(req);
			const target = safeOutputPath(outputRoot, req.query.path);
			const overwrite = req.query.overwrite === "1" || req.query.overwrite === "true";
			if(!overwrite && await pathExists(target)){
				req.resume();
				res.json({skipped: true, path: path.relative(outputRoot, target)});
				return;
			}

			await fsp.mkdir(path.dirname(target), {recursive: true});
			const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
			await pipeline(req, fs.createWriteStream(tmp));
			await fsp.rename(tmp, target);
			res.json({skipped: false, path: path.relative(outputRoot, target)});
		}catch(error){
			next(error);
		}
	});

	app.post("/api/depth-batch/run", express.json({limit: "100mb"}), async (req, res, next) => {
		try{
			const runConfig = normalizeConfig({...req.body, out: req.body.out || defaultOutputRoot, port: serverInfo.port});
			if(req.body.rows){
				runConfig.rows = req.body.rows;
			}
			if(req.body.coordinatesText){
				runConfig.coordinatesText = req.body.coordinatesText;
			}
			const summary = await runBatchJob(runConfig, serverInfo);
			res.json(summary);
		}catch(error){
			next(error);
		}
	});

	app.use("/__depth_batch__/mount/:id", (req, res, next) => {
		const dir = mounts.get(req.params.id);
		if(!dir){
			res.status(404).send("Unknown mount");
			return;
		}
		const rel = decodeURIComponent(req.path || "/").replace(/^\/+/, "");
		const target = path.resolve(dir, rel);
		if(target !== dir && !target.startsWith(`${dir}${path.sep}`)){
			res.status(403).send("Unsafe path");
			return;
		}
		res.sendFile(target, error => {
			if(error){
				next(error);
			}
		});
	});

	app.use(express.static(ROOT));

	app.use((error, req, res, next) => {
		console.error(error);
		res.status(500).send(error.message || String(error));
	});

	const server = await new Promise(resolve => {
		const s = app.listen(config.port || 3100, "127.0.0.1", () => resolve(s));
	});

	const address = server.address();
	const serverInfo = {
		app,
		server,
		port: address.port,
		baseUrl: `http://127.0.0.1:${address.port}`,
		out: defaultOutputRoot,
		registerJob(jobId, outDir){
			const outputRoot = path.resolve(process.cwd(), outDir || defaultOutputRoot);
			jobOutputRoots.set(jobId, outputRoot);
			this.out = outputRoot;
			return outputRoot;
		},
		addLocalDirectory(dir){
			const id = String(mounts.size + 1);
			const absolute = path.resolve(dir);
			mounts.set(id, absolute);
			return `${this.baseUrl}/__depth_batch__/mount/${id}`;
		},
		close(){
			return new Promise(resolve => server.close(resolve));
		},
	};

	return serverInfo;
}

async function resolvePointcloudUrl(pointcloud, serverInfo){
	if(!pointcloud){
		throw new Error("--pointcloud is required");
	}
	if(isUrl(pointcloud)){
		return pointcloud;
	}

	const absolute = path.resolve(process.cwd(), pointcloud);
	const base = serverInfo.addLocalDirectory(path.dirname(absolute));
	return joinUrl(base, path.basename(absolute));
}

async function loadPlaywright(){
	try{
		return await import("playwright");
	}catch(error){
		throw new Error("Playwright is required. Run `npm install` after adding the project dependency, then retry the CLI.");
	}
}

function chromiumArgs(){
	return [
		"--enable-gpu",
		"--ignore-gpu-blocklist",
		"--enable-webgl",
		"--use-gl=desktop",
		"--disable-dev-shm-usage",
		"--no-sandbox",
	];
}

async function setupWorker({workerIndex, gpuId, config, serverInfo, playwright, pointcloudUrl, coordinatesText, rows}){
	const env = {...process.env};
	if(gpuId !== null && gpuId !== undefined){
		env.CUDA_VISIBLE_DEVICES = String(gpuId);
		env.NVIDIA_VISIBLE_DEVICES = String(gpuId);
	}

	const launchOptions = {
		headless: !config.headed,
		env,
		args: chromiumArgs(),
	};
	if(config.browserExecutable){
		launchOptions.executablePath = config.browserExecutable;
	}

	const browser = await playwright.chromium.launch(launchOptions);
	const page = await browser.newPage({viewport: {width: 1280, height: 720}});
	page.setDefaultTimeout(0);
	page.on("console", message => {
		const text = message.text();
		if(message.type() === "error"){
			console.error(`[worker ${workerIndex}] ${text}`);
		}
	});

	await page.goto(`${serverInfo.baseUrl}/examples/depth_rendering.html?batch=1`, {waitUntil: "domcontentloaded"});
	await page.waitForFunction("window.depthBatch && window.Potree");
	await page.evaluate(batchConfig => window.depthBatch.configure(batchConfig), config);
	await page.evaluate(url => window.depthBatch.loadPointCloud(url), pointcloudUrl);

	let count;
	if(coordinatesText !== null && coordinatesText !== undefined){
		const result = await page.evaluate(text => window.depthBatch.loadCoordinatesText(text), coordinatesText);
		count = result.count;
	}else{
		const result = await page.evaluate(inputRows => window.depthBatch.loadRows(inputRows), rows || []);
		count = result.count;
	}

	if(config.classifications){
		await page.evaluate(spec => window.depthBatch.setClassifications(spec), config.classifications);
	}

	return {browser, page, count, workerIndex, gpuId};
}

function mergeSummary(target, source){
	target.rendered += source.rendered || 0;
	target.skipped += source.skipped || 0;
	target.failed += source.failed || 0;
	if(source.canceled){
		target.canceled = true;
	}
	for(const row of source.rows || []){
		target.rows.push(row);
	}
}

async function runBatchJob(config, existingServerInfo = null){
	if(!config.out){
		throw new Error("--out is required");
	}

	const serverInfo = existingServerInfo || await createCoordinatorServer(config);
	const shouldCloseServer = !existingServerInfo;
	const playwright = await loadPlaywright();
	const pointcloudUrl = await resolvePointcloudUrl(config.pointcloud, serverInfo);
	const coordinatesText = config.coordinatesText !== undefined
		? config.coordinatesText
		: (config.rows ? null : await readCoordinatesText(config.coordinates));
	const rows = config.rows || null;
	const explicitGpus = parseGpuIds(config.gpus);
	const gpuIds = explicitGpus || await discoverNvidiaGpus();
	const workerSpecs = [];
	for(const gpuId of gpuIds){
		for(let i = 0; i < config.workersPerGpu; i++){
			workerSpecs.push({gpuId, workerIndex: workerSpecs.length});
		}
	}
	if(workerSpecs.length === 0){
		workerSpecs.push({gpuId: null, workerIndex: 0});
	}

	const jobId = `depth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const jobOutputRoot = serverInfo.registerJob
		? serverInfo.registerJob(jobId, config.out)
		: path.resolve(process.cwd(), config.out);
	await fsp.mkdir(jobOutputRoot, {recursive: true});
	const workers = [];
	try{
		console.log(`Coordinator: ${serverInfo.baseUrl}`);
		console.log(`Output: ${jobOutputRoot}`);
		console.log(`Point cloud: ${pointcloudUrl}`);
		console.log(`Workers: ${workerSpecs.length} (${workerSpecs.map(w => w.gpuId ?? "default").join(", ")})`);

		const first = await setupWorker({workerIndex: workerSpecs[0].workerIndex, gpuId: workerSpecs[0].gpuId, config, serverInfo, playwright, pointcloudUrl, coordinatesText, rows});
		workers.push(first);
		const rowCount = first.count;
		if(rowCount === 0){
			throw new Error("No coordinate rows loaded");
		}

		const startIndex = config.startIndex === undefined ? 0 : config.startIndex;
		const endIndex = config.endIndex === undefined ? rowCount - 1 : config.endIndex;
		if(startIndex < 0 || endIndex < startIndex || endIndex >= rowCount){
			throw new Error(`Invalid row range ${startIndex} to ${endIndex} for ${rowCount} rows`);
		}

		const remainingWorkers = await Promise.all(workerSpecs.slice(1).map(spec => setupWorker({
			workerIndex: spec.workerIndex,
			gpuId: spec.gpuId,
			config,
			serverInfo,
			playwright,
			pointcloudUrl,
			coordinatesText,
			rows,
		})));
		workers.push(...remainingWorkers);

		let nextIndex = startIndex;
		const summary = {total: endIndex - startIndex + 1, rendered: 0, skipped: 0, failed: 0, canceled: false, rows: []};

		async function workerLoop(worker){
			while(true){
				const index = nextIndex++;
				if(index > endIndex){
					break;
				}

				console.log(`[worker ${worker.workerIndex} gpu ${worker.gpuId ?? "default"}] row ${index}`);
				try{
					const result = await worker.page.evaluate(({index, endpoint, jobId, overwrite}) => {
						return window.depthBatch.runBatch({
							startIndex: index,
							endIndex: index,
							overwrite,
							updatePreview: false,
							outputMode: {type: "coordinator", endpoint, jobId},
						});
					}, {index, endpoint: serverInfo.baseUrl, jobId, overwrite: config.overwrite});
					mergeSummary(summary, result);
				}catch(error){
					console.error(`[worker ${worker.workerIndex}] row ${index} failed: ${error.message || error}`);
					summary.failed++;
					summary.rows.push({index, status: "failed", error: error.message || String(error)});
				}
			}
		}

		await Promise.all(workers.map(workerLoop));
		summary.rows.sort((a, b) => a.index - b.index);
		const summaryPath = path.join(jobOutputRoot, "batch_summary.json");
		await fsp.writeFile(summaryPath, JSON.stringify({
			settings: {
				pointcloud: config.pointcloud,
				coordinates: config.coordinates || null,
				width: config.width,
				height: config.height,
				classifications: config.classifications || "",
				gpus: gpuIds,
				workersPerGpu: config.workersPerGpu,
			},
			...summary,
		}, null, 2));
		console.log(`Summary: ${summaryPath}`);
		console.log(`Rendered ${summary.rendered}, skipped ${summary.skipped}, failed ${summary.failed}`);
		return summary;
	}finally{
		await Promise.all(workers.map(worker => worker.browser.close().catch(() => {})));
		if(shouldCloseServer){
			await serverInfo.close();
		}
	}
}

async function main(){
	const args = parseArgs(process.argv.slice(2));
	if(args.help || args.h){
		console.log(usage());
		return;
	}

	const mode = args._[0] || "run";
	const config = normalizeConfig(args);

	if(mode === "serve"){
		if(!config.out){
			throw new Error("serve mode requires --out");
		}
		const serverInfo = await createCoordinatorServer(config);
		console.log(`Depth batch coordinator listening at ${serverInfo.baseUrl}`);
		console.log(`Output root: ${serverInfo.out}`);
		return;
	}

	if(!config.pointcloud || !config.coordinates || !config.out){
		console.error(usage());
		throw new Error("--pointcloud, --coordinates, and --out are required");
	}

	await runBatchJob(config);
}

main().catch(error => {
	console.error(error.message || error);
	process.exitCode = 1;
});
