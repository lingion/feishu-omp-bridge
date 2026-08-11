/**
 * Feishu rich-text (post) handling, ported from Hermes adapter.py:
 *   - `_build_markdown_post_rows`: split a markdown reply into post rows so
 *     fenced code blocks don't swallow trailing prose.
 *   - `parse_feishu_post_payload`: flatten an inbound post into plain text for omp.
 *
 * Feishu "post" is an array of rows, each row an array of elements
 * ({tag:"text"|"a"|"at"|"md", text/unescape/key/...}). We normalize inbound to
 * plain text and render outbound markdown as post rows.
 */

const FENCE_OPEN_RE = /^\s*(```|~~~)/;
const FENCE_CLOSE_RE = /^\s*(```|~~~)/;

/** Build Feishu post rows from a markdown string, isolating fenced code blocks. */
export function buildMarkdownPostRows(content: string): Array<Array<Record<string, string>>> {
	if (!content) return [[{ tag: "md", text: "" }]];
	if (!content.includes("```") && !content.includes("~~~")) {
		return [[{ tag: "md", text: content }]];
	}
	const rows: Array<Array<Record<string, string>>> = [];
	let current: string[] = [];
	let inCode = false;

	const flush = (): void => {
		if (current.length === 0) return;
		const segment = current.join("\n");
		if (segment.trim()) rows.push([{ tag: "md", text: segment }]);
		current = [];
	};

	for (const line of content.split("\n")) {
		const stripped = line.trim();
		const re = inCode ? FENCE_CLOSE_RE : FENCE_OPEN_RE;
		if (re.test(stripped)) {
			if (!inCode) flush();
			current.push(line);
			inCode = !inCode;
			if (!inCode) flush();
			continue;
		}
		current.push(line);
	}
	flush();
	return rows.length > 0 ? rows : [[{ tag: "md", text: content }]];
}

/** Serialize rows into the post payload string (`{"zh_cn":{"content":[...]}}`). */
export function buildMarkdownPostPayload(content: string): string {
	return JSON.stringify({ zh_cn: { content: buildMarkdownPostRows(content) } }, (_k, v) =>
		v === undefined ? undefined : v,
	);
}

/** Flatten an inbound post payload (object or JSON string) into plain text. */
export function parsePostPayload(raw: unknown): string {
	let payload: Record<string, unknown>;
	try {
		payload =
			typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
	} catch {
		return "";
	}
	const post = (payload.post ?? payload) as
		| Record<string, { content?: unknown[][] }>
		| undefined;
	if (!post) return "";
	// post is { zh_cn: { content: [[{tag,text},...],...] } } — pick any locale.
	const locale = post.zh_cn ?? post.en_us ?? Object.values(post)[0];
	const rows = (locale?.content ?? []) as unknown[][];
	const lines: string[] = [];
	for (const row of rows) {
		if (!Array.isArray(row)) continue;
		const parts: string[] = [];
		for (const el of row as Array<Record<string, unknown>>) {
			const tag = el.tag as string | undefined;
			if (tag === "at") continue; // drop @mentions inline
			const text = (el.text as string) ?? (el.unescape as string) ?? "";
			if (text) parts.push(text);
		}
		if (parts.length) lines.push(parts.join(""));
	}
	return lines.join("\n");
}
