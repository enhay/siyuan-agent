import { z } from "zod";
import { defineTool } from "./define-tool";
import { emitActivity } from "./siyuan-api";
import { defaultTranslator, type Translator } from "../../i18n";

/** Normalize an asset reference to a workspace path for /api/file/getFile.
 *  Accepts "assets/…", "/assets/…", or an already-workspace "/data/assets/…". */
function toWorkspacePath(p: string): string {
	if (p.startsWith("/data/")) return p;
	if (p.startsWith("/assets/")) return `/data${p}`;
	if (p.startsWith("assets/")) return `/data/${p}`;
	return p;
}

/** read_attachment — let the agent read a synced session attachment (a sub-agent
 *  transcript `.md` under assets/). Sub-agents are stored as attachments rather
 *  than indexed documents; the parent session doc links to them. getFile returns
 *  the raw file content (not a JSON envelope), so this calls it directly. */
export function createReadAttachmentTool(i18n: Translator = defaultTranslator) {
	return defineTool(
		async ({ path }, ctx) => {
			const wsPath = toWorkspacePath(path.trim());
			let resp: Response;
			try {
				resp = await fetch("/api/file/getFile", { method: "POST", body: JSON.stringify({ path: wsPath }) });
			} catch (e) {
				return JSON.stringify({ error: `read failed: ${e instanceof Error ? e.message : String(e)}` });
			}
			if (!resp.ok) return JSON.stringify({ error: i18n.t("tool.error.attachmentNotFound", { path }, `attachment not found: ${path}`) });
			const text = await resp.text();
			// On failure SiYuan returns a JSON error envelope instead of file bytes.
			if (text.startsWith("{") && text.includes('"code"')) {
				try {
					const j = JSON.parse(text);
					if (typeof j.code === "number" && j.code !== 0) {
						return JSON.stringify({ error: i18n.t("tool.error.attachmentNotFound", { path }, `attachment not found: ${path}`) });
					}
				} catch {
					/* genuine JSON-looking markdown — fall through */
				}
			}
			emitActivity(ctx, { category: "lookup", action: "read", path, label: path.split("/").pop() || path });
			const MAX = 200_000;
			return text.length > MAX ? `${text.slice(0, MAX)}\n\n…(truncated ${text.length - MAX} chars)` : text;
		},
		{
			name: "read_attachment",
			description:
				"Read a synced AI-session attachment — a sub-agent transcript stored as a .md asset (sub-agents are attachments, not indexed documents). Pass the asset path from a session document's 🧩 子代理 link, e.g. 'assets/session-sync/codex-xxxx.md'. Returns the markdown for analysis.",
			schema: z.object({
				path: z.string().describe("Asset path, e.g. assets/session-sync/codex-xxxx.md"),
			}),
		},
	);
}

export const readAttachmentTool = createReadAttachmentTool();
