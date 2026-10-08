// Jobs with named steps and a log, plus a persisted single-worker FIFO queue, and the lock that keeps
// one service instance per PROJECTS_DIR.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { readTailLines } from "./fsutil.mjs";
import { HttpError, nowIso, readJson, writeFileAtomic } from "./util.mjs";

const LOG_TAIL = 300;
const KEEP_JOBS = 200;
const SAVE_THROTTLE_MS = 1000;

function newJobId() {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	return `${stamp}-${crypto.randomBytes(3).toString("hex")}`.toLowerCase();
}

/**
 * A unit of work. `steps` is an ordered list of {key, label, weight}. Progress semantics:
 * `steps[].progress` is the fraction (0–1) of a step that is done; the job's `progress` is a
 * percentage (0–100), see updateProgress().
 */
export class Job {
	constructor({ id = newJobId(), type, projectId = null, steps = [], request = null, onChange = () => {}, onLog = () => {}, persist = async () => {} }) {
		this.id = id;
		this.type = type;
		this.projectId = projectId;
		this.status = "queued";
		this.progress = 0;
		this.steps = steps.map(({ key, label, weight = 1 }) => ({ key, label, weight, status: "pending", progress: 0, startedAt: null, endedAt: null, detail: null }));
		this.error = null;
		this.result = null;
		this.warnings = [];
		this.request = request;
		this.createdAt = nowIso();
		this.startedAt = null;
		this.finishedAt = null;
		// Server-side bookkeeping of a create job's staging folder ({dir, created, moved: [{from, to}]}).
		this.staging = null;
		// In-memory input of the runner (e.g. the validated create plan); not persisted.
		this.context = null;
		this.logTail = [];
		// Jobs restored from disk serve their log from the .log file (logTail only has new lines).
		this.logFromFile = false;
		this.onChange = onChange;
		this.onLog = onLog;
		// Awaitable save of the job state (used before irreversible actions such as moving data).
		this.persist = persist;
	}

	log(message) {
		const stamp = new Date().toISOString().slice(0, 19) + "Z";
		for (const line of String(message).split(/\r?\n/)) {
			const entry = `${stamp} ${line}`;
			this.logTail.push(entry);
			this.onLog(entry);
		}
		if (this.logTail.length > LOG_TAIL) {
			this.logTail.splice(0, this.logTail.length - LOG_TAIL);
		}
	}

	warn(message) {
		this.warnings.push(message);
		this.log(`WARNING: ${message}`);
		this.onChange(false);
	}

	getStep(key) {
		const step = this.steps.find((s) => s.key === key);
		if (!step) {
			throw new Error(`unknown step ${key}`);
		}
		return step;
	}

	/**
	 * Overall percentage (one decimal): the weighted share of the work done over the steps that apply
	 * (skipped steps excluded). Succeeded steps count fully; running and failed steps count with the
	 * fraction they reached, so a failed job keeps the progress it had made. A succeeded job is 100.
	 */
	updateProgress() {
		if (this.status === "succeeded") {
			this.progress = 100;
			return;
		}
		let total = 0;
		let done = 0;
		for (const step of this.steps) {
			if (step.status === "skipped") {
				continue;
			}
			total += step.weight;
			done += step.weight * (step.status === "succeeded" ? 1 : step.progress);
		}
		this.progress = total > 0 ? Math.round((1000 * done) / total) / 10 : 0;
	}

	/** Report progress (fraction 0..1) and/or a detail text for a running step. */
	stepProgress(key, fraction, detail) {
		const step = this.getStep(key);
		if (Number.isFinite(fraction)) {
			step.progress = Math.max(0, Math.min(1, fraction));
		}
		if (detail !== undefined) {
			step.detail = detail;
		}
		this.updateProgress();
		this.onChange(false);
	}

	skipStep(key, detail = null) {
		const step = this.getStep(key);
		step.status = "skipped";
		step.detail = detail;
		this.updateProgress();
		this.onChange(true);
	}

	/**
	 * Run one step: marks it running, then succeeded with the returned detail (string), or failed
	 * (and rethrows). With `{fatal: false}` a failure is recorded as a warning and swallowed.
	 */
	async runStep(key, fn, { fatal = true } = {}) {
		const step = this.getStep(key);
		step.status = "running";
		step.startedAt = nowIso();
		step.progress = 0;
		this.log(`[${key}] ${step.label}`);
		this.updateProgress();
		this.onChange(true);
		try {
			const detail = await fn();
			step.status = "succeeded";
			step.progress = 1;
			if (typeof detail === "string") {
				step.detail = detail;
			}
			return detail;
		} catch (err) {
			step.status = "failed";
			step.detail = err.message;
			if (fatal) {
				throw err;
			}
			this.warn(`${step.label} failed: ${err.message}`);
			return undefined;
		} finally {
			step.endedAt = nowIso();
			this.updateProgress();
			this.onChange(true);
		}
	}

	summary() {
		return {
			id: this.id,
			type: this.type,
			projectId: this.projectId,
			status: this.status,
			progress: this.progress,
			currentStep: this.steps.find((s) => s.status === "running")?.key ?? null,
			error: this.error,
			createdAt: this.createdAt,
			startedAt: this.startedAt,
			finishedAt: this.finishedAt,
		};
	}

	/** Persisted / API representation (the log tail is added by the caller). */
	toJSON() {
		return {
			...this.summary(),
			steps: this.steps,
			warnings: this.warnings,
			result: this.result,
			request: this.request,
			staging: this.staging,
		};
	}

	static fromJSON(data, hooks) {
		const job = new Job({ id: data.id, type: data.type, projectId: data.projectId, steps: [], request: data.request, ...hooks });
		Object.assign(job, {
			status: data.status,
			progress: data.progress ?? 0,
			steps: data.steps ?? [],
			error: data.error ?? null,
			result: data.result ?? null,
			warnings: data.warnings ?? [],
			createdAt: data.createdAt,
			startedAt: data.startedAt ?? null,
			finishedAt: data.finishedAt ?? null,
			staging: data.staging ?? null,
			logFromFile: true,
		});
		return job;
	}
}

// --- Single instance per PROJECTS_DIR -------------------------------------------------------------
// Restart recovery marks the jobs found on disk as interrupted and deletes their staging folders, so it
// must never run while another service instance works on the same folder. <jobsDir>/server.lock holds
// the owner's identity (pid, host, boot id and process start time, so reused pids and reboots are
// recognised as stale locks).

const LOCK_FILE = "server.lock";

/** Kernel boot id (Linux); null elsewhere. */
function bootId() {
	try {
		return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		return null;
	}
}

/** Start time of a process in clock ticks since boot (Linux); null elsewhere or when it does not exist. */
function processStartTime(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// The command name (field 2) may contain spaces; field 3 follows its closing ")", starttime is field 22.
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
	} catch {
		return null;
	}
}

/** {raw, info} of a lock file (info null when unparsable), or null when there is none. */
function readLock(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") {
			return null;
		}
		throw err;
	}
	let info = null;
	try {
		info = JSON.parse(raw);
	} catch {
		// unparsable: treated as stale
	}
	return { raw, info: Number.isInteger(info?.pid) && info.pid > 0 ? info : null };
}

/** Whether the process that wrote the lock `info` is still running. */
function lockOwnerAlive(info) {
	if (!info || info.pid === process.pid) {
		return false; // garbage, or written by an earlier process that had our (reused) pid
	}
	if (info.host && info.host !== os.hostname()) {
		return true; // written on another machine: cannot be checked, assume it is alive
	}
	const boot = bootId();
	if (info.bootId && boot && info.bootId !== boot) {
		return false; // written before the last reboot
	}
	try {
		process.kill(info.pid, 0);
	} catch (err) {
		if (err.code === "ESRCH") {
			return false;
		}
		// EPERM: the process exists but belongs to another user.
	}
	const startTime = processStartTime(info.pid);
	return !(info.startTime && startTime && info.startTime !== startTime); // else: pid reused by another process
}

function serviceLockPath(jobsDir) {
	return path.join(jobsDir, LOCK_FILE);
}

/** Identity ({pid, host, startedAt, ...}) of the live service holding the lock of `config.jobsDir`, or null. */
export function serviceLockOwner(config) {
	const lock = readLock(serviceLockPath(config.jobsDir));
	return lock && lockOwnerAlive(lock.info) ? lock.info : null;
}

/** Whether a project service is running on this PROJECTS_DIR (synchronous; the CLI refuses to create then). */
export function isServiceRunning(config) {
	return serviceLockOwner(config) !== null;
}

/**
 * Take the exclusive service lock of `jobsDir` (synchronous). Throws an error with code
 * "ESERVICELOCKED" while a live service holds it; a stale lock is replaced. Returns a function that
 * releases the lock (only while it is still ours).
 */
export function acquireServiceLock(jobsDir) {
	fs.mkdirSync(jobsDir, { recursive: true });
	const file = serviceLockPath(jobsDir);
	const content = JSON.stringify({ pid: process.pid, host: os.hostname(), bootId: bootId(), startTime: processStartTime(process.pid), startedAt: nowIso() }) + "\n";
	// The lock is written under a temporary name and hard-linked into place: link() fails when the lock
	// exists, and the lock never appears without its content.
	const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
	fs.writeFileSync(tmp, content);
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				fs.linkSync(tmp, file);
				let released = false;
				return function releaseServiceLock() {
					if (!released) {
						released = true;
						if (readLock(file)?.raw === content) {
							fs.rmSync(file, { force: true });
						}
					}
				};
			} catch (err) {
				if (err.code !== "EEXIST") {
					throw err;
				}
			}
			const lock = readLock(file);
			if (lock && lockOwnerAlive(lock.info)) {
				const { pid, host, startedAt } = lock.info;
				const err = new Error(`another project service (pid ${pid}${host ? ` on ${host}` : ""}, started ${startedAt ?? "at an unknown time"}) is using ${path.dirname(jobsDir)}; stop it, or give this instance its own PROJECTS_DIR. If no such service is running, delete ${file}.`);
				err.code = "ESERVICELOCKED";
				throw err;
			}
			// Stale lock: remove it unless another starting instance has replaced it meanwhile, then retry.
			if (lock && readLock(file)?.raw === lock.raw) {
				fs.rmSync(file, { force: true });
			}
		}
		throw new Error(`cannot take the service lock ${file}`);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/**
 * Persisted single-worker FIFO queue. Each job is saved to <jobsDir>/<id>.json and logs to
 * <jobsDir>/<id>.log. `runners[type](job)` performs a job and returns its result.
 * The queue holds the service lock of `jobsDir` from lock() (or init()) until close().
 */
export class JobQueue {
	constructor({ jobsDir, runners, onInterrupted = async () => {}, onIdle = async () => {} }) {
		this.jobsDir = jobsDir;
		this.runners = runners;
		this.onInterrupted = onInterrupted;
		this.onIdle = onIdle;
		this.jobs = new Map();
		this.queue = [];
		this.running = null;
		this.saveTimers = new Map();
		// Per job: promise of its latest state write (writes of one job are chained, see save()).
		this.saveChains = new Map();
		this.logStreams = new Map();
		this.releaseLock = null;
	}

	/** Take the single-instance lock of the jobs folder (throws code "ESERVICELOCKED" when another service holds it). */
	lock() {
		if (!this.releaseLock) {
			this.releaseLock = acquireServiceLock(this.jobsDir);
			process.on("exit", this.releaseLock);
		}
	}

	unlock() {
		if (this.releaseLock) {
			process.off("exit", this.releaseLock);
			this.releaseLock();
			this.releaseLock = null;
		}
	}

	/**
	 * Take the lock (unless held already), then load persisted jobs; jobs that were queued or running
	 * when the service stopped are marked failed.
	 */
	async init() {
		this.lock();
		const files = (await fsp.readdir(this.jobsDir)).filter((f) => f.endsWith(".json") && !f.startsWith("."));
		const loaded = [];
		for (const file of files) {
			try {
				loaded.push(Job.fromJSON(await readJson(path.join(this.jobsDir, file)), this.hooksFor(file.slice(0, -5))));
			} catch (err) {
				console.warn(`[jobs] ignoring unreadable job file ${file}: ${err.message}`);
			}
		}
		loaded.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		for (const job of loaded) {
			this.jobs.set(job.id, job);
			if (job.status === "running" || job.status === "queued") {
				const wasRunning = job.status === "running";
				job.status = "failed";
				job.error = wasRunning ? "interrupted by server restart" : "interrupted by server restart (job had not started)";
				job.finishedAt = nowIso();
				for (const step of job.steps) {
					if (step.status === "running") {
						step.status = "failed";
						step.endedAt = job.finishedAt;
						step.detail = "interrupted by server restart";
					}
				}
				job.updateProgress();
				try {
					await this.onInterrupted(job);
				} catch (err) {
					job.log(`cleanup after interruption failed: ${err.message}`);
				}
				job.log(`job marked failed: ${job.error}`);
				await this.save(job);
				this.closeLog(job);
			}
		}
		await this.prune();
	}

	hooksFor(id) {
		return {
			onChange: (immediate) => this.scheduleSave(id, immediate),
			onLog: (line) => this.appendLog(id, line),
			persist: () => this.save(this.jobs.get(id)),
		};
	}

	/**
	 * Create a job, persist it and append it to the queue. `context` is handed to the runner as job.context.
	 * With `exclusiveProject`, it fails with 409 (code "EPROJECTBUSY") while another queued or running job
	 * of the same type targets `projectId`. That check and the job's registration (which reserves the id)
	 * run synchronously when enqueue() is called, before its first await, so concurrent requests can never
	 * reserve the same project id twice.
	 */
	async enqueue({ type, projectId, steps, request, context = null, exclusiveProject = false }) {
		if (!this.runners[type]) {
			throw new Error(`no runner for job type ${type}`);
		}
		if (exclusiveProject && projectId && this.activeProjectIds(type).has(projectId)) {
			const err = new HttpError(409, `a project with id "${projectId}" already exists or is being created`);
			err.code = "EPROJECTBUSY";
			throw err;
		}
		const id = newJobId();
		const job = new Job({ id, type, projectId, steps, request, ...this.hooksFor(id) });
		job.context = context;
		this.jobs.set(id, job);
		job.log(`queued ${type} job${projectId ? ` for ${projectId}` : ""}`);
		try {
			await this.save(job);
		} catch (err) {
			// Not persisted: withdraw the job, so it does not run although the caller got an error.
			this.jobs.delete(id);
			this.closeLog(job);
			throw err;
		}
		this.queue.push(job);
		this.pump();
		return job;
	}

	get(id) {
		return this.jobs.get(id) ?? null;
	}

	/** Job summaries, newest first. */
	list(limit = 50) {
		return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((job) => job.summary());
	}

	/** Project ids of queued or running jobs of a type (to reserve ids of projects being created). */
	activeProjectIds(type) {
		const ids = new Set();
		for (const job of this.jobs.values()) {
			if (job.type === type && (job.status === "queued" || job.status === "running") && job.projectId) {
				ids.add(job.projectId);
			}
		}
		return ids;
	}

	stats() {
		return { running: this.running ? 1 : 0, queued: this.queue.length, current: this.running?.id ?? null };
	}

	/** Full job object for the API, including the last lines of its log. */
	async describe(id) {
		const job = this.get(id);
		if (!job) {
			return null;
		}
		const log = job.logFromFile ? await readTailLines(path.join(this.jobsDir, `${id}.log`), LOG_TAIL) : job.logTail;
		return { ...job.toJSON(), log };
	}

	pump() {
		if (this.running || this.queue.length === 0) {
			return;
		}
		const job = this.queue.shift();
		this.running = job;
		this.execute(job)
			.catch((err) => console.error(`[jobs] ${job.id}: ${err.message}`))
			.finally(async () => {
				this.running = null;
				if (this.queue.length > 0) {
					this.pump();
				} else {
					await this.onIdle().catch((err) => console.warn(`[jobs] idle hook failed: ${err.message}`));
					this.pump(); // a job may have been queued while the idle hook ran
				}
			});
	}

	async execute(job) {
		job.status = "running";
		job.startedAt = nowIso();
		try {
			await this.save(job);
			job.result = (await this.runners[job.type](job)) ?? null;
			job.status = "succeeded";
			job.log(`job succeeded${job.warnings.length ? ` with ${job.warnings.length} warning(s)` : ""}`);
		} catch (err) {
			job.status = "failed";
			job.error = err.message;
			job.log(`job failed: ${err.message}`);
			if (err.stack && !err.status) {
				console.error(`[jobs] ${job.id} failed:`, err);
			}
		} finally {
			job.finishedAt = nowIso();
			job.updateProgress();
			await this.save(job).catch((err) => console.warn(`[jobs] cannot save ${job.id}: ${err.message}`));
			this.closeLog(job);
		}
	}

	scheduleSave(id, immediate) {
		const job = this.jobs.get(id);
		if (!job) {
			return;
		}
		if (immediate) {
			this.save(job).catch((err) => console.warn(`[jobs] cannot save ${id}: ${err.message}`));
			return;
		}
		if (!this.saveTimers.has(id)) {
			this.saveTimers.set(id, setTimeout(() => {
				this.save(job).catch((err) => console.warn(`[jobs] cannot save ${id}: ${err.message}`));
			}, SAVE_THROTTLE_MS));
		}
	}

	/**
	 * Save a snapshot of the job taken now. Writes of one job are chained, so they land in call order and
	 * the file always ends up with the newest snapshot; the returned promise settles once this write (and
	 * every earlier one) has landed, which makes `await job.persist()` a real guarantee.
	 */
	save(job) {
		clearTimeout(this.saveTimers.get(job.id));
		this.saveTimers.delete(job.id);
		const file = path.join(this.jobsDir, `${job.id}.json`);
		const data = JSON.stringify(job.toJSON(), null, 2) + "\n";
		const write = (this.saveChains.get(job.id) ?? Promise.resolve())
			.catch(() => {}) // a failed earlier write does not stop this one
			.then(() => writeFileAtomic(file, data));
		this.saveChains.set(job.id, write);
		write.catch(() => {}).finally(() => {
			if (this.saveChains.get(job.id) === write) {
				this.saveChains.delete(job.id);
			}
		});
		return write;
	}

	appendLog(id, line) {
		let stream = this.logStreams.get(id);
		if (!stream) {
			stream = fs.createWriteStream(path.join(this.jobsDir, `${id}.log`), { flags: "a" });
			stream.on("error", (err) => console.warn(`[jobs] log write failed for ${id}: ${err.message}`));
			this.logStreams.set(id, stream);
		}
		stream.write(line + "\n");
	}

	closeLog(job) {
		this.logStreams.get(job.id)?.end();
		this.logStreams.delete(job.id);
	}

	/** Keep the newest KEEP_JOBS finished jobs on disk. */
	async prune() {
		const finished = [...this.jobs.values()]
			.filter((j) => j.status === "succeeded" || j.status === "failed")
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		for (const job of finished.slice(KEEP_JOBS)) {
			this.jobs.delete(job.id);
			await fsp.rm(path.join(this.jobsDir, `${job.id}.json`), { force: true });
			await fsp.rm(path.join(this.jobsDir, `${job.id}.log`), { force: true });
		}
	}

	/** On shutdown: write throttled saves, wait for all pending writes, close log files, release the lock. */
	async close() {
		for (const id of [...this.saveTimers.keys()]) {
			const job = this.jobs.get(id);
			if (job) {
				this.save(job);
			}
		}
		await Promise.allSettled([...this.saveChains.values()]);
		for (const stream of this.logStreams.values()) {
			stream.end();
		}
		this.logStreams.clear();
		this.unlock();
	}
}
