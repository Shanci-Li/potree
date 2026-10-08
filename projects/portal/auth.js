// Access token for the protected project-service endpoints (every write, /fs/*, /jobs).
// The token is kept per device (localStorage) or per tab (sessionStorage), asked for in a small
// dialog before the first protected call and again after a 401, and sent as
// "Authorization: Bearer <token>". The app bar gets a "Sign in" / "Signed in" control whose menu
// can forget the token.

import { h, icon, wireDialog } from "./util.js";
import { ApiError } from "./api.js";

const STORAGE_KEY = "potree.apiToken";
// Printable ASCII without spaces: what an "Authorization: Bearer <token>" header can carry (the
// service reads the token as one run of non-space characters).
const TOKEN_RE = /^[\x21-\x7e]+$/;

const UNCONFIGURED_MESSAGE = "The project service has no access token configured, so creating and editing projects is disabled. See deploy/README.md.";

function storageArea(name) {
	try { return window[name] || null; } catch { return null; } // access itself throws when blocked
}

/** Stored token: localStorage ("remember on this device") first, then this tab's sessionStorage. */
function readStored() {
	for (const [name, remember] of [["localStorage", true], ["sessionStorage", false]]) {
		try {
			const value = storageArea(name)?.getItem(STORAGE_KEY);
			if (value) return { token: value, remember };
		} catch { /* storage blocked */ }
	}
	return null;
}

/** Keep the token in exactly one place (or nowhere when `token` is null). */
function writeStored(token, remember) {
	for (const name of ["localStorage", "sessionStorage"]) {
		try {
			const area = storageArea(name);
			if (!area) continue;
			if (token && (name === "localStorage") === remember) area.setItem(STORAGE_KEY, token);
			else area.removeItem(STORAGE_KEY);
		} catch { /* storage blocked or full: the token then lives in memory for this page only */ }
	}
}

export const authRequiredError = () => new ApiError("An access token is needed for this action.", { status: 401, auth: "token" });
export const unconfiguredError = () => new ApiError(UNCONFIGURED_MESSAGE, { status: 503, auth: "unconfigured" });

export class Auth {
	/**
	 * @param {object} options
	 * @param {(token: string) => Promise<unknown>} options.verify  a protected request made with the
	 *        candidate token (rejects with an ApiError: 401 = wrong token)
	 */
	constructor({ verify }) {
		this.verify = verify;
		const stored = readStored();
		this.token = stored?.token || null;
		this.remember = stored ? stored.remember : true;
		this.required = false;   // health.auth.required, or learnt from a 401
		this.configured = null;  // false: the service has no API_TOKEN (writes disabled); null: unknown
		this.pending = null;     // the open token dialog, shared by every caller waiting for a token
		this.listeners = new Set();

		const $ = (id) => document.getElementById(id);
		this.el = {
			dialog: $("token-dialog"), form: $("token-form"), input: $("token-input"), reveal: $("token-reveal"),
			remember: $("token-remember"), error: $("token-err"), alert: $("token-alert"), submit: $("token-submit"),
			root: $("access"), button: $("access-btn"), label: $("access-label"), menu: $("access-menu"),
			where: $("access-where"), forget: $("access-forget"),
		};
		this.bindUi();
		// Another tab signed in or forgot the token.
		window.addEventListener("storage", (event) => {
			if (event.key !== STORAGE_KEY && event.key !== null) return;
			const next = readStored();
			if ((next?.token || null) === this.token) return;
			this.token = next?.token || null;
			if (next) this.remember = next.remember;
			this.emit(this.token ? "signed-in" : "signed-out");
		});
	}

	// -----------------------------------------------------------------------------------------
	// State

	/** "unconfigured" | "signed-in" | "signed-out" | "open" (the service needs no token) */
	get status() {
		if (this.configured === false) return "unconfigured";
		if (this.token) return "signed-in";
		return this.required ? "signed-out" : "open";
	}

	/** Apply GET /health (null when the service is unreachable). */
	setHealth(health) {
		const auth = health?.auth;
		this.required = auth?.required === true;
		this.configured = auth && typeof auth.configured === "boolean" ? auth.configured : null;
		this.emit("health");
	}

	subscribe(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	emit(reason) {
		this.render();
		for (const fn of this.listeners) fn(reason);
	}

	store(token, remember) {
		this.token = token;
		this.remember = remember;
		writeStored(token, remember);
		this.emit("signed-in");
	}

	/** Forget the token. `reason` "rejected" means the service refused it during background work. */
	forget(reason = "signed-out") {
		this.token = null;
		writeStored(null);
		this.emit(reason);
	}

	// -----------------------------------------------------------------------------------------
	// Requests

	/**
	 * Run a protected request. `send(headers)` performs it. Interactive calls ask for a token when
	 * none is stored and after a 401 (then retry); `background` calls never open the dialog.
	 */
	async request(send, { background = false } = {}) {
		let rejected = false; // the last attempt sent a token and got a 401
		for (;;) {
			if (this.configured === false) throw unconfiguredError();
			let token = this.token;
			if (!token && this.required) {
				if (background) throw authRequiredError();
				token = await this.prompt({ rejected });
				if (!token) throw authRequiredError();
			}
			try {
				return await send(token ? { Authorization: `Bearer ${token}` } : {});
			} catch (err) {
				if (err.status === 401) {
					if (!this.required) {
						// An older /health that said nothing about auth: now we know.
						this.required = true;
						this.emit("required");
					}
					// A 401 without a token only means one is needed; with one, that token is wrong.
					rejected = !!token;
					if (token && token === this.token) this.forget(background ? "rejected" : "signed-out");
					if (background) throw err;
					continue;
				}
				if (err.status === 503 && err.auth === "unconfigured") this.markUnconfigured();
				throw err;
			}
		}
	}

	markUnconfigured() {
		if (this.configured === false) return;
		this.configured = false;
		this.emit("unconfigured");
	}

	/** Before a user action that needs the service: true when calls can go ahead. */
	async ensure() {
		if (this.configured === false) return false;
		if (this.token || !this.required) return true;
		return !!(await this.prompt());
	}

	/** Show the token dialog (once, however many callers wait); resolves to the token or null. */
	prompt({ rejected = false } = {}) {
		this.pending ??= this.openDialog({ rejected }).finally(() => { this.pending = null; });
		return this.pending;
	}

	// -----------------------------------------------------------------------------------------
	// Dialog

	bindUi() {
		const { dialog, input, reveal, button, menu, forget, root } = this.el;
		wireDialog(dialog);
		reveal.addEventListener("click", () => this.setRevealed(input.type === "password"));
		input.addEventListener("input", () => this.fieldError(""));

		button.addEventListener("click", () => {
			if (this.token) this.toggleMenu(menu.hidden);
			else this.prompt();
		});
		forget.addEventListener("click", () => {
			this.toggleMenu(false);
			this.forget();
			button.focus();
		});
		document.addEventListener("pointerdown", (event) => {
			if (!menu.hidden && !root.contains(event.target)) this.toggleMenu(false);
		});
		root.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && !menu.hidden) {
				this.toggleMenu(false);
				button.focus();
			}
		});
		this.render();
	}

	setRevealed(show) {
		const { input, reveal } = this.el;
		input.type = show ? "text" : "password";
		reveal.setAttribute("aria-pressed", String(show));
		reveal.setAttribute("aria-label", show ? "Hide token" : "Show token");
		reveal.title = show ? "Hide token" : "Show token";
		reveal.replaceChildren(icon(show ? "eye-off" : "eye"));
	}

	fieldError(message) {
		const { input, error } = this.el;
		error.hidden = !message;
		error.replaceChildren(...(message ? [icon("alert-circle"), h("span", { text: message })] : []));
		if (message) input.setAttribute("aria-invalid", "true");
		else input.removeAttribute("aria-invalid");
	}

	openDialog({ rejected }) {
		const { dialog, form, input, remember, alert, submit } = this.el;
		return new Promise((resolve) => {
			const returnFocus = document.activeElement;
			let result = null;
			let busy = false;
			let closed = false;
			input.value = "";
			this.setRevealed(false);
			this.fieldError("");
			remember.checked = this.remember;
			alert.hidden = !rejected;
			alert.replaceChildren(...(rejected ? [icon("alert-circle"), h("p", null,
				h("strong", { text: "The stored token was not accepted." }), " It may have been changed on the server. Enter the current one.")] : []));

			const setBusy = (on) => {
				busy = on;
				submit.disabled = on;
				submit.replaceChildren(...(on ? [h("span", { class: "spinner sm on-accent" }), "Checking…"] : [icon("check"), "Continue"]));
			};
			const onSubmit = async (event) => {
				event.preventDefault();
				if (busy) return;
				const token = input.value.trim();
				if (!token) return this.fieldError("Enter the access token.");
				if (!TOKEN_RE.test(token)) return this.fieldError("A token is one word of letters, digits and symbols: no spaces or accented characters.");
				setBusy(true);
				let outcome = "ok";
				try {
					await this.verify(token);
				} catch (err) {
					if (err.status === 401) outcome = "rejected";
					else if (err.status === 503 && err.auth === "unconfigured") outcome = "unconfigured";
					// Anything else (service unreachable, timeout) proves nothing about the token: keep
					// it; the request that needed it reports the real problem.
				}
				setBusy(false);
				if (closed) return;
				if (outcome === "rejected") {
					this.fieldError("This token was not accepted by the project service.");
					input.select();
					return;
				}
				if (outcome === "unconfigured") {
					this.markUnconfigured();
				} else {
					this.store(token, remember.checked);
					result = token;
				}
				dialog.close();
			};
			form.addEventListener("submit", onSubmit);
			dialog.addEventListener("close", () => {
				closed = true;
				form.removeEventListener("submit", onSubmit);
				input.value = "";
				setBusy(false);
				if (returnFocus?.isConnected && typeof returnFocus.focus === "function") returnFocus.focus({ preventScroll: true });
				resolve(result);
			}, { once: true });
			dialog.showModal();
			input.focus();
		});
	}

	// -----------------------------------------------------------------------------------------
	// App bar control

	toggleMenu(show) {
		this.el.menu.hidden = !show;
		this.el.button.setAttribute("aria-expanded", String(show));
		if (show) this.el.forget.focus();
	}

	render() {
		const { root, button, label, where } = this.el;
		const status = this.status;
		root.hidden = status !== "signed-in" && status !== "signed-out";
		root.dataset.state = status;
		const signedIn = status === "signed-in";
		label.textContent = signedIn ? "Signed in" : "Sign in";
		button.title = signedIn ? "Editing is unlocked with an access token" : "Enter the access token to create and edit projects";
		// Signed in: a disclosure for the small menu; signed out: the button opens the token dialog.
		if (signedIn) {
			button.removeAttribute("aria-haspopup");
			button.setAttribute("aria-controls", "access-menu");
			button.setAttribute("aria-expanded", String(!this.el.menu.hidden));
		} else {
			button.setAttribute("aria-haspopup", "dialog");
			button.removeAttribute("aria-controls");
			button.removeAttribute("aria-expanded");
			this.el.menu.hidden = true;
		}
		where.textContent = this.remember ? "The access token is remembered on this device." : "The access token is kept until this tab is closed.";
	}
}
