// Generates projects/<id>/index.html from server/templates/project.html (SPEC §6).

import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.mjs";
import { escapeHtml, writeFileAtomic } from "./util.mjs";

/** Fill the template placeholders ({{TITLE}}, {{DESCRIPTION}}, {{PROJECT_ID}}), HTML-escaped. */
export async function renderProjectPage(id, project) {
	let template;
	try {
		template = await fs.readFile(config.templateFile, "utf8");
	} catch (err) {
		throw new Error(`page template not readable (${config.templateFile}): ${err.code || err.message}`);
	}
	const values = {
		TITLE: project.title || id,
		DESCRIPTION: project.description || "",
		PROJECT_ID: id,
	};
	return template.replace(/\{\{(TITLE|DESCRIPTION|PROJECT_ID)\}\}/g, (_, key) => escapeHtml(values[key]));
}

/**
 * (Re)write the entry page of a non-custom project in `dir` (the project folder, or its staging folder).
 * Returns the written file; custom projects are refused because their page is hand-written.
 */
export async function writeProjectPage(dir, id, project) {
	if (project.custom === true) {
		throw new Error(`${id} is a custom project; its page is hand-written and never regenerated`);
	}
	const entry = project.entry || "index.html";
	if (entry.includes("/") || entry.includes("\\") || !entry.endsWith(".html")) {
		throw new Error(`${id}: unsupported entry "${entry}" (expected a file name ending in .html)`);
	}
	const file = path.join(dir, entry);
	await writeFileAtomic(file, await renderProjectPage(id, project));
	return file;
}
