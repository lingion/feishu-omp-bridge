import type * as lark from "@larksuiteoapi/node-sdk";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

/** Attachment extracted from an inbound Feishu message. */
export type InboundAttachment = {
	type: "image" | "file";
	mimeType: string;
	/** Base64 data for forwarding to omp as an ImageAttachment. */
	data: string;
	fileName?: string;
};

export type MediaConfig = {
	mediaMaxMb: number;
	dataDir: string;
};

/** Typing indicator: a transient reaction using the OK emoji (Feishu emoji_type code). */
const TYPING_EMOJI = "OK";

export class FeishuMedia {
	private readonly client: lark.Client;
	private readonly cfg: MediaConfig;
	private readonly tmpDir: string;

	constructor(client: lark.Client, cfg: MediaConfig) {
		this.client = client;
		this.cfg = cfg;
		this.tmpDir = join(cfg.dataDir, "media-tmp");
	}

	/** Download an image/file referenced in an inbound message. */
	async download(
		messageId: string,
		fileKey: string,
		type: "image" | "file",
	): Promise<InboundAttachment> {
		const res = await this.client.im.v1.messageResource.get({
			params: { type },
			path: { message_id: messageId, file_key: fileKey },
		});
		const path = join(this.tmpDir, `${randomBytes(6).toString("hex")}-${fileKey}`);
		await mkdir(this.tmpDir, { recursive: true });
		await res.writeFile(path);
		const buf = await readFile(path);
		const data = buf.toString("base64");
		// messageResource doesn't return content-type; sniff from bytes / extension.
		const mimeType = sniffMime(fileKey, buf);
		return { type, mimeType, data, fileName: fileKey };
	}

	/**
	 * Download a resource to a persistent path under dataDir/incoming and return
	 * { path, fileName, mimeType } so omp's `read`/`file` tools can open it.
	 * Mirrors Hermes `_download_feishu_message_resource` (saved-attachment model).
	 */
	async downloadToPath(
		messageId: string,
		fileKey: string,
		type: "image" | "file",
		fileName?: string,
	): Promise<{ path: string; fileName: string; mimeType: string }> {
		const res = await this.client.im.v1.messageResource.get({
			params: { type },
			path: { message_id: messageId, file_key: fileKey },
		});
		const incomingDir = join(this.cfg.dataDir, "incoming");
		await mkdir(incomingDir, { recursive: true });
		const safeName = fileName || fileKey.replace(/[^a-zA-Z0-9._-]/g, "_");
		const path = join(incomingDir, `${randomBytes(4).toString("hex")}-${safeName}`);
		await res.writeFile(path);
		const buf = await readFile(path);
		return { path, fileName: safeName, mimeType: sniffMime(safeName, buf) };
	}

	/**
	 * Edit a previously sent text/post message (Hermes edit_message via
	 * im.v1.message.update). Falls back to plain text if a post payload is rejected.
	 */
	async editMessage(messageId: string, text: string): Promise<boolean> {
		try {
			const res = await this.client.im.v1.message.update({
				data: { content: JSON.stringify({ text }), msg_type: "text" },
				path: { message_id: messageId },
			});
			return res?.code === 0;
		} catch (err) {
			console.error("editMessage failed:", String(err).slice(0, 120));
			return false;
		}
	}

	/** Upload a local image and send it as an image message. Returns message_id. */
	async sendImage(chatId: string, imagePath: string): Promise<string | undefined> {
		const imageKey = await this.uploadImage(imagePath);
		const res = await this.client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: {
				receive_id: chatId,
				content: JSON.stringify({ image_key: imageKey }),
				msg_type: "image",
			},
		});
		return res.data?.message_id;
	}

	/** Upload + send a file. Returns message_id. */
	async sendFile(chatId: string, filePath: string, fileName: string): Promise<string | undefined> {
		const fileKey = await this.uploadFile(filePath, fileName);
		const res = await this.client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: {
				receive_id: chatId,
				content: JSON.stringify({ file_key: fileKey }),
				msg_type: "file",
			},
		});
		return res.data?.message_id;
	}

	/** Upload + send an audio message (opus required for native voice bubble). Returns message_id. */
	async sendAudio(chatId: string, audioPath: string, durationMs?: number): Promise<string | undefined> {
		const fileKey = await this.uploadFile(audioPath, "voice.opus");
		const res = await this.client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: {
				receive_id: chatId,
				content: JSON.stringify({ file_key: fileKey, duration: durationMs ?? 0 }),
				msg_type: "audio",
			},
		});
		return res.data?.message_id;
	}

	/** Upload + send a video (mp4). file_type must be mp4 for native video bubble. */
	async sendVideo(chatId: string, videoPath: string, fileName = "clip.mp4"): Promise<string | undefined> {
		const fileKey = await this.uploadTypedFile(videoPath, fileName, "mp4");
		const res = await this.client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: {
				receive_id: chatId,
				content: JSON.stringify({ file_key: fileKey }),
				msg_type: "video",
			},
		});
		return res.data?.message_id;
	}

	/** Drop a transient "typing" reaction on an inbound message. */
	async typing(messageId: string): Promise<void> {
		try {
			await this.client.im.v1.messageReaction.create({
				data: { reaction_type: { emoji_type: TYPING_EMOJI } },
				path: { message_id: messageId },
			});
		} catch {
			// Non-fatal: typing indicator is best-effort.
		}
	}

	/** Remove the typing reaction once the turn completes. */
	async clearTyping(messageId: string): Promise<void> {
		// List reactions, find our 👀, delete it. Simplified: try by listing.
		try {
			const list = await this.client.im.v1.messageReaction.list({
				params: { page_size: 50, reaction_type: TYPING_EMOJI },
				path: { message_id: messageId },
			});
			const items = (list.data?.items ?? []) as Array<{ reaction_id?: string }>;
			await Promise.all(
				items.map((it) =>
					it.reaction_id
						? this.client.im.v1.messageReaction.delete({
								path: {
									message_id: messageId,
									reaction_id: it.reaction_id,
								},
							})
						: Promise.resolve(),
				),
			);
		} catch {
			// best-effort
		}
	}

	private async uploadImage(path: string): Promise<string> {
		const file = await readFile(path);
		const res = await this.client.im.v1.image.create({
			data: { image_type: "message", image: file },
		});
		const key = res?.image_key;
		if (!key) throw new Error("image upload returned no image_key");
		return key;
	}

	private async uploadFile(path: string, fileName: string): Promise<string> {
		const file = await readFile(path);
		const res = await this.client.im.v1.file.create({
			data: { file_type: "stream", file_name: fileName, file },
		});
		const key = res?.file_key;
		if (!key) throw new Error("file upload returned no file_key");
		return key;
	}

	/** Upload with an explicit file_type (opus/mp4/pdf/doc/...) for native bubbles. */
	private async uploadTypedFile(
		path: string,
		fileName: string,
		fileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream",
	): Promise<string> {
		const file = await readFile(path);
		const res = await this.client.im.v1.file.create({
			data: { file_type: fileType, file_name: fileName, file },
		});
		const key = res?.file_key;
		if (!key) throw new Error("file upload returned no file_key");
		return key;
	}
}

/** Sniff a mime type from extension / magic bytes when Feishu omits it. */
function sniffMime(name: string, buf: Buffer): string {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	const byExt: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		bmp: "image/bmp",
		pdf: "application/pdf",
		zip: "application/zip",
		txt: "text/plain",
		json: "application/json",
	};
	if (byExt[ext]) return byExt[ext];
	// Magic bytes
	if (buf.length >= 4) {
		const sig = buf.subarray(0, 4).toString("hex");
		if (sig.startsWith("89504e47")) return "image/png";
		if (sig.startsWith("ffd8ff")) return "image/jpeg";
		if (sig.startsWith("474946")) return "image/gif";
		if (sig.startsWith("25504446")) return "application/pdf";
	}
	return "application/octet-stream";
}
