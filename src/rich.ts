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

/** Read a first non-empty string from candidate fields (Hermes _first_non_empty_text). */
function firstNonEmpty(obj: Record<string, unknown>, keys: string[]): string {
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return "";
}

/** Collect text entries from a merge-forward payload (Hermes _collect_forward_entries). */
function collectForwardEntries(payload: Record<string, unknown>): string[] {
	const candidates: unknown[] = [];
	for (const key of ["messages", "items", "message_list", "records", "content"]) {
		const v = payload[key];
		if (Array.isArray(v)) candidates.push(...v);
	}
	const entries: string[] = [];
	for (const item of candidates) {
		if (typeof item !== "object" || item === null) {
			const t = String(item ?? "").trim();
			if (t) entries.push(`- ${t}`);
			continue;
		}
		const o = item as Record<string, unknown>;
		const sender = firstNonEmpty(o, ["sender_name", "user_name", "sender", "name"]);
		const nestedType = String(o.message_type ?? o.msg_type ?? "").toLowerCase();
		let body: string;
		if (nestedType === "post") {
			body = parsePostPayload(o.content);
		} else {
			body = firstNonEmpty(o, ["text", "summary", "preview", "content"]);
		}
		body = body.trim();
		if (sender && body) entries.push(`- ${sender}: ${body}`);
		else if (body) entries.push(`- ${body}`);
	}
	return Array.from(new Set(entries));
}

/** Parse a forwarded / merge-forward message into readable text (Hermes _normalize_merge_forward_message). */
export function parseForwardPayload(raw: unknown): string {
	let payload: Record<string, unknown>;
	try {
		payload = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
	} catch {
		return "";
	}
	const title = firstNonEmpty(payload, ["title", "summary", "preview", "description"]);
	const entries = collectForwardEntries(payload).slice(0, 8);
	const lines = [title, ...entries].filter(Boolean);
	return lines.join("\n").trim() || "[forwarded message]";
}

/** Parse a share_chat (shared group) message into text (Hermes _normalize_share_chat_message). */
export function parseShareChatPayload(raw: unknown): string {
	let payload: Record<string, unknown>;
	try {
		payload = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
	} catch {
		return "";
	}
	const chatName = firstNonEmpty(payload, ["chat_name", "name", "title"]);
	const shareId = firstNonEmpty(payload, ["chat_id", "open_chat_id", "share_chat_id"]);
	const lines: string[] = [];
	lines.push(chatName ? `Shared chat: ${chatName}` : "[shared chat]");
	if (shareId) lines.push(`Chat ID: ${shareId}`);
	return lines.join("\n");
}
