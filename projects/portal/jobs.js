// Job tracking: polls GET {api}/jobs/:id, drives the job dialog (steps, progress, log tail) and the
// small "jobs" indicator in the app bar. Closing the dialog never cancels anything — the job keeps
// running on the server and can be reopened from the indicator.
//
// Only a 404 means a job is gone. Any other failure (proxy reload, network drop, laptop asleep, a
// token that is no longer accepted) only makes the job "stale": it keeps being polled, more slowly,
// and picks up where it was as soon as the service answers again.

import { h, icon, formatDuration, wireDialog } from "./util.js";

const POLL_MS = 1500;
const STALE_POLL_MS = 15000;
const FINISHED = new Set(["succeeded", "failed"]);
const MAX_POLL_FAILURES = 5; // consecutive failures before a job is shown as "reconnecting"

const KIND_LABEL = { create: "Creating project", preview: "Rendering preview" };
const STATUS_LABEL = { queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed", lost: "Unavailable" };

/** Map the server's step status vocabulary onto pending | running | done | failed | skipped. */
function stepState(status) {
	const s = String(status || "").toLowerCase();
	if (["done", "succeeded", "success", "ok", "completed", "complete", "finished"].includes(s)) return "done";
	if (["running", "active", "started", "in_progress", "in-progress"].includes(s)) return "running";
	if (["failed", "error", "errored"].includes(s)) return "failed";
	if (["skipped", "skip", "cancelled", "canceled"].includes(s)) return "skipped";
	return "pending";
}

function logLines(log) {
	if (Array.isArray(log)) return log.map((line) => String(line));
	if (typeof log === "string") return log.split("\n");
	return [];
}

export class JobCenter {
	/**
	 * @param {object} options
	 * @param {object} options.api           API client (api.js)
	 * @param {(job) => void} options.onFinished  called once when a tracked job succeeds or fails
	 * @param {(job) => void} options.onRetry     "Edit & retry" on a failed create job
	 * @param {(job) => string} options.projectUrl URL of the project a job produced
	 * @param {() => void} options.onSignIn        ask for the access token (jobs that got a 401)
	 */
	constructor({ api, onFinished, onRetry, projectUrl, onSignIn }) {
		this.api = api;
		this.onFinished = onFinished;
		this.onRetry = onRetry;
		this.projectUrl = projectUrl;
		this.onSignIn = onSignIn;
		this.jobs = new Map();
		this.listeners = new Set();
		this.timer = 0;
		this.polling = false;
		this.openId = null;
		this.logStick = true; // keep the log scrolled to its newest line unless the user scrolls up

		const $ = (id) => document.getElementById(id);
		this.el = {
			root: $("jobs"), button: $("jobs-btn"), label: $("jobs-label"), menu: $("jobs-menu"),
			list: $("jobs-list"), clearButton: $("jobs-clear"),
			dialog: $("job-dialog"), kind: $("job-kind"), title: $("job-title"), status: $("job-status"),
			meta: $("job-meta"), percent: $("job-percent"), progress: $("job-progress"), error: $("job-error"), warnings: $("job-warnings"),
			steps: $("job-steps"), log: $("job-log"), logCount: $("job-log-count"),
			retry: $("job-retry"), open: $("job-open"), footNote: $("job-foot-note"),
		};
		this.bindUi();
	}

	bindUi() {
		const { button, menu, clearButton, dialog, retry } = this.el;
		wireDialog(dialog, { lightDismiss: true });
		dialog.addEventListener("close", () => { this.openId = null; });
		const log = this.el.log;
		log.addEventListener("scroll", () => { this.logStick = log.scrollHeight - log.scrollTop - log.clientHeight < 24; }, { passive: true });
		button.addEventListener("click", () => this.toggleMenu(menu.hidden));
		clearButton.addEventListener("click", () => {
			for (const job of [...this.jobs.values()]) if (!this.isActive(job)) this.jobs.delete(job.id);
			this.changed();
			if (!this.jobs.size) this.toggleMenu(false);
		});
		document.addEventListener("pointerdown", (event) => {
			if (!menu.hidden && !this.el.root.contains(event.target)) this.toggleMenu(false);
		});
		this.el.root.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && !menu.hidden) {
				this.toggleMenu(false);
				button.focus();
			}
		});
		retry.addEventListener("click", () => {
			const job = this.jobs.get(this.openId);
			dialog.close();
			if (job) this.onRetry?.(job);
		});
	}

	toggleMenu(show) {
		this.el.menu.hidden = !show;
		this.el.button.setAttribute("aria-expanded", String(show));
		if (show) this.el.list.querySelector("button")?.focus();
	}

	/** Start following a job; `kind` is "create" or "preview". */
	track({ jobId, kind = "create", projectId = null, title = null }) {
		if (!jobId) return;
		if (!this.jobs.has(jobId)) {
			this.jobs.set(jobId, {
				id: jobId, kind, projectId, title: title || projectId || "Job", data: null, addedAt: Date.now(),
				failures: 0,      // consecutive failed polls
				stale: false,     // the service did not answer lately (or wants a token): polled slowly
				staleReason: null,
				needsAuth: false, // the last poll got a 401
				lost: false,      // the server answered 404: the job is gone for good
				lostReason: null,
				nextAt: 0,        // when the job is polled next (ms since epoch)
			});
		}
		this.changed();
		this.schedule();
	}

	/** Pick up jobs still running on the server (e.g. after a page reload or signing in). */
	async restore() {
		let list;
		try { list = await this.api.jobs(); } catch { return; }
		const jobs = Array.isArray(list) ? list : Array.isArray(list?.jobs) ? list.jobs : [];
		for (const job of jobs) {
			if (!job?.id) continue;
			const known = this.jobs.get(job.id);
			if (known) {
				// The service lists it again: whatever made us give up on it is over.
				if (known.lost || known.stale) Object.assign(known, { lost: false, stale: false, needsAuth: false, failures: 0, nextAt: 0 });
			} else if (!FINISHED.has(job.status)) {
				this.track({ jobId: job.id, kind: job.type || "create", projectId: job.projectId, title: job.title || job.projectId });
			}
		}
		this.changed();
		this.schedule();
	}

	/** Poll stale jobs right away (the service is back, or a token was just entered). */
	resume() {
		for (const job of this.jobs.values()) if (job.stale) job.nextAt = 0;
		this.schedule();
	}

	subscribe(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	get(jobId) {
		return this.jobs.get(jobId);
	}

	isActive(job) {
		return !job.lost && !FINISHED.has(job.data?.status);
	}

	/** A stale job keeps the last status the server reported. */
	statusOf(job) {
		if (job.lost) return "lost";
		return job.data?.status in STATUS_LABEL ? job.data.status : "queued";
	}

	/** Overall progress in percent (the server reports 0–100; steps are the fallback). */
	progressOf(job) {
		const data = job.data;
		if (!data) return 0;
		if (data.status === "succeeded") return 100;
		const p = Number(data.progress);
		if (data.progress != null && Number.isFinite(p)) return Math.max(0, Math.min(100, p));
		const steps = Array.isArray(data.steps) ? data.steps : [];
		if (!steps.length) return 0;
		return (steps.filter((s) => ["done", "skipped"].includes(stepState(s.status))).length / steps.length) * 100;
	}

	/** (Re)arm the timer for the earliest job that is due; a running poll re-arms when it ends. */
	schedule() {
		clearTimeout(this.timer);
		this.timer = 0;
		if (this.polling) return;
		const due = [...this.jobs.values()].filter((job) => this.isActive(job)).map((job) => job.nextAt);
		if (!due.length) return;
		this.timer = setTimeout(() => this.poll(), Math.max(0, Math.min(...due) - Date.now()));
	}

	async poll() {
		this.timer = 0;
		this.polling = true;
		const finished = [];
		const now = Date.now();
		const due = [...this.jobs.values()].filter((job) => this.isActive(job) && job.nextAt <= now + 50);
		await Promise.all(due.map(async (job) => {
			try {
				const data = await this.api.job(job.id);
				Object.assign(job, { data, failures: 0, stale: false, staleReason: null, needsAuth: false });
				if (data.projectId && !job.projectId) job.projectId = data.projectId;
				if (FINISHED.has(data.status)) finished.push(job);
			} catch (err) {
				job.failures++;
				job.needsAuth = err.status === 401;
				if (err.status === 404) {
					job.lost = true;
					job.lostReason = "The server no longer knows this job (it may have been restarted).";
				} else if (job.needsAuth) {
					job.stale = true;
					job.staleReason = "The project service wants the access token again. The job keeps running on the server; sign in to follow it.";
				} else if (job.failures >= MAX_POLL_FAILURES) {
					job.stale = true;
					job.staleReason = `No answer from the project service (${err.message}). The job keeps running on the server; retrying every ${STALE_POLL_MS / 1000} s.`;
				}
			}
			job.nextAt = Date.now() + (job.stale ? STALE_POLL_MS : POLL_MS);
		}));
		this.polling = false;
		this.changed();
		for (const job of finished) this.onFinished?.(job);
		this.schedule();
	}

	changed() {
		this.renderIndicator();
		if (this.openId) this.renderDialog();
		for (const fn of this.listeners) fn();
	}

	renderIndicator() {
		const jobs = [...this.jobs.values()];
		const { root, label, list } = this.el;
		root.hidden = jobs.length === 0;
		const running = jobs.filter((job) => this.isActive(job)).length;
		const failed = jobs.some((job) => ["failed", "lost"].includes(this.statusOf(job)));
		root.dataset.state = running ? "running" : failed ? "failed" : "done";
		label.textContent = running ? `${running} running` : jobs.length === 1 ? "1 job" : `${jobs.length} jobs`;
		list.replaceChildren(...jobs.slice().reverse().map((job) => {
			const status = this.statusOf(job);
			const pct = Math.round(this.progressOf(job));
			return h("li", null, h("button", {
				type: "button", class: "job-item",
				onclick: () => { this.toggleMenu(false); this.open(job.id); },
			},
			h("span", { class: "job-item-title", text: job.title }),
			h("span", { class: "job-item-meta" },
				h("span", { class: "status-pill sm", dataset: { status }, text: STATUS_LABEL[status] }),
				h("span", { text: KIND_LABEL[job.kind] || job.kind }),
				this.isActive(job) ? h("span", { class: "tabular", text: job.stale ? (job.needsAuth ? "sign in to follow" : "reconnecting…") : `${pct}%` }) : null),
			));
		}));
	}

	open(jobId) {
		if (!this.jobs.has(jobId)) return;
		this.openId = jobId;
		this.logStick = true;
		this.renderDialog();
		if (!this.el.dialog.open) this.el.dialog.showModal();
		this.el.log.scrollTop = this.el.log.scrollHeight;
	}

	renderDialog() {
		const job = this.jobs.get(this.openId);
		if (!job) return;
		const el = this.el;
		const data = job.data || {};
		const status = this.statusOf(job);
		const pct = this.progressOf(job);
		const steps = Array.isArray(data.steps) ? data.steps : [];

		el.kind.textContent = KIND_LABEL[job.kind] || "Job";
		el.title.textContent = job.title;
		el.status.dataset.status = status;
		el.status.textContent = STATUS_LABEL[status];
		// A failed job's percentage only says how far it got before failing: show the state instead.
		const ended = status === "lost" || status === "failed";
		el.percent.textContent = ended ? "" : `${Math.round(pct)}%`;
		el.progress.setAttribute("aria-valuenow", String(Math.round(ended ? 0 : pct)));
		el.progress.style.setProperty("--progress", `${ended ? 100 : pct}%`);
		el.progress.dataset.state = status === "queued" && !job.data ? "indeterminate" : status;

		const starts = steps.map((s) => Date.parse(s.startedAt)).filter(Number.isFinite);
		const ends = steps.map((s) => Date.parse(s.endedAt)).filter(Number.isFinite);
		const startedAt = starts.length ? Math.min(...starts) : null;
		if (startedAt && FINISHED.has(status) && ends.length) el.meta.textContent = `Took ${formatDuration(Math.max(...ends) - startedAt)}`;
		else if (startedAt && this.isActive(job)) el.meta.textContent = `Elapsed ${formatDuration(Date.now() - startedAt)}`;
		else if (!job.data && !job.lost) el.meta.textContent = "Waiting for the server…";
		else el.meta.textContent = "";

		el.steps.replaceChildren(...steps.map((step) => {
			const state = stepState(step.status);
			const t0 = Date.parse(step.startedAt), t1 = Date.parse(step.endedAt);
			const duration = Number.isFinite(t0) ? formatDuration((Number.isFinite(t1) ? t1 : Date.now()) - t0) : "";
			// steps[].progress is a 0–1 fraction (server/lib/jobs.mjs); the job's own progress is 0–100.
			const fraction = Math.max(0, Math.min(1, Number(step.progress) || 0));
			const stepPct = state === "running" && fraction > 0 ? `${Math.round(fraction * 100)}% · ` : "";
			return h("li", { class: `step is-${state}` },
				h("span", { class: "step-icon", "aria-hidden": "true" },
					state === "done" ? icon("check") : state === "failed" ? icon("x") : state === "running" ? h("span", { class: "spinner" }) : null),
				h("span", { class: "step-text" },
					h("span", { class: "step-label", text: step.label || step.key || "Step" }),
					h("span", { class: "visually-hidden", text: ` (${state})` }),
					step.detail ? h("span", { class: "step-detail", text: String(step.detail) }) : null),
				duration && state !== "pending" ? h("span", { class: "step-time tabular", text: `${stepPct}${duration}` }) : null);
		}));

		// One alert: why the job failed or is gone (danger), or why it is not updating (warning).
		const error = job.lost ? job.lostReason : data.status === "failed" ? (data.error || "The job failed. See the log for details.") : "";
		const notice = !error && job.stale ? job.staleReason : "";
		el.error.hidden = !error && !notice;
		el.error.className = `form-alert ${error ? "danger" : "warn"}`;
		el.error.replaceChildren(...(error ? [icon("alert-circle"), h("p", { text: String(error) })]
			: notice ? [icon("alert"), h("div", null,
				h("p", { text: notice }),
				job.needsAuth && this.onSignIn ? h("button", { type: "button", class: "btn sm alert-action", onclick: () => this.onSignIn() }, icon("key"), "Sign in") : null)]
			: []));

		const warnings = Array.isArray(data.warnings) ? data.warnings : [];
		el.warnings.hidden = !warnings.length;
		el.warnings.replaceChildren(...(warnings.length ? [icon("alert"), h("div", null,
			h("p", null, h("strong", { text: warnings.length === 1 ? "1 warning" : `${warnings.length} warnings` })),
			h("ul", null, warnings.map((w) => h("li", { text: String(w) }))))] : []));

		const succeeded = status === "succeeded";
		el.open.hidden = !(succeeded && job.kind === "create");
		if (succeeded && job.kind === "create") el.open.href = this.projectUrl(job);
		// Only a failure reported by the server: a job we lost contact with may still be running.
		el.retry.hidden = !(job.kind === "create" && status === "failed");
		el.footNote.textContent = this.isActive(job) ? "Closing this window does not stop the job." : "";

		// Last, so the layout above is final when the log is scrolled to its newest line.
		const lines = logLines(data.log);
		const text = lines.join("\n") || (job.data ? "No output yet." : "");
		if (el.log.textContent !== text) el.log.textContent = text;
		el.logCount.textContent = lines.length ? `last ${lines.length} line${lines.length === 1 ? "" : "s"}` : "";
		if (this.logStick) el.log.scrollTop = el.log.scrollHeight;
	}
}
