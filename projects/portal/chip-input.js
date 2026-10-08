// Keyword "chip" input: Enter or comma adds a chip, Backspace on an empty field removes the last one.
// The limits match the project service (at most 30 keywords of at most 60 characters). They only
// stop keywords the user adds: values loaded from a project are kept as they are, so saving a form
// never drops existing keywords.

import { h, icon, fold } from "./util.js";

const MAX_LENGTH = 60;
let datalistCounter = 0;

const clean = (part) => String(part ?? "").trim().replace(/\s+/g, " ");

/** Keywords as the input holds them when loaded: trimmed, no empty ones, exact duplicates dropped. */
export function normalizeKeywords(items) {
	const out = [];
	for (const value of (items || []).map(clean)) if (value && !out.includes(value)) out.push(value);
	return out;
}

/**
 * @param {HTMLElement} box   container (gets the chips and the text input); must already be in
 *                            the document tree, a limit message is inserted right after it
 * @param {object} options    { inputId, values, suggestions, placeholder, describedBy, max, onChange }
 *                            onChange() runs after the user adds or removes a chip
 * @returns {{ values: string[], setValues(list), setSuggestions(list), focus(), commit() }}
 */
export function createChipInput(box, { inputId, values = [], suggestions = [], placeholder = "Add keyword", describedBy, max = 30, onChange } = {}) {
	let chips = [];
	const listId = `chip-suggestions-${++datalistCounter}`;
	const noteId = `${inputId}-limit`;
	const list = h("ul", { class: "chip-list", role: "list" });
	const datalist = h("datalist", { id: listId });
	const input = h("input", {
		type: "text", id: inputId, class: "chip-text", placeholder, list: listId,
		"aria-describedby": [describedBy, noteId].filter(Boolean).join(" "), autocomplete: "off",
	});
	const note = h("p", { class: "field-error chip-note", id: noteId, hidden: true });
	box.replaceChildren(list, input, datalist);
	box.after(note);
	box.addEventListener("click", (event) => { if (event.target === box || event.target === list) input.focus(); });

	function showNote(message) {
		note.hidden = !message;
		note.replaceChildren(...(message ? [icon("alert-circle"), h("span", { text: message })] : []));
	}

	function render() {
		list.replaceChildren(...chips.map((value, index) => h("li", { class: "chip" },
			h("span", { class: "chip-label", text: value }),
			h("button", {
				type: "button", class: "chip-remove", "aria-label": `Remove ${value}`,
				onclick: () => { chips.splice(index, 1); showNote(""); render(); input.focus(); onChange?.(); },
			}, icon("x")),
		)));
		input.placeholder = chips.length ? "" : placeholder;
	}

	/** Values from a project: kept whole (only exact duplicates dropped, as the server does). */
	function load(items) {
		chips = normalizeKeywords(items);
		showNote("");
		render();
	}

	/** Add what the user typed; returns the parts that could not be added (over a limit). */
	function add(items) {
		const left = [];
		let message = "";
		let added = false;
		for (const value of items.map(clean)) {
			if (!value || chips.some((c) => fold(c) === fold(value))) continue;
			if (value.length > MAX_LENGTH) {
				message = `A keyword can have at most ${MAX_LENGTH} characters.`;
				left.push(value);
			} else if (chips.length >= max) {
				message = `At most ${max} keywords. Remove one to add another.`;
				left.push(value);
			} else {
				chips.push(value);
				added = true;
			}
		}
		showNote(message);
		if (added) {
			render();
			onChange?.();
		}
		return left;
	}

	/** Turn whatever is typed into chips (called before reading `values`); rejected text stays typed. */
	function commit() {
		if (!input.value.trim()) {
			input.value = "";
			return;
		}
		input.value = add(input.value.split(",")).join(", ");
	}

	input.addEventListener("keydown", (event) => {
		if ((event.key === "Enter" || event.key === ",") && input.value.trim()) {
			event.preventDefault();
			commit();
		} else if (event.key === "Enter") {
			event.preventDefault(); // never submit the surrounding form from an empty chip field
		} else if (event.key === "Backspace" && !input.value && chips.length) {
			chips.pop();
			showNote("");
			render();
			onChange?.();
		}
	});
	input.addEventListener("input", () => {
		// A datalist pick or a pasted "a, b, c" list arrives as an input event.
		if (input.value.includes(",")) commit();
	});
	input.addEventListener("change", () => {
		if (suggestions.some((s) => s === input.value)) commit();
	});
	input.addEventListener("blur", commit);

	function setSuggestions(next) {
		suggestions = next;
		datalist.replaceChildren(...next.map((value) => h("option", { value })));
	}

	setSuggestions(suggestions);
	load(values);

	return {
		get values() { commit(); return [...chips]; },
		setValues(next) { input.value = ""; load(next || []); },
		setSuggestions,
		focus: () => input.focus(),
		commit,
	};
}
