/** TitleProvider backed by a LangChain chat model from the plugin's registry.
 *
 *  Kept decoupled from AgentConfig: caller supplies a model exposing `.invoke`.
 *  Failures surface as undefined so the engine falls back to the heuristic title
 *  (plan §11/§12). Only the first user message is sent — no raw tool output. */

import type { TitleProvider } from "../engine/ports";

export interface InvokableModel {
	invoke(input: Array<{ role: string; content: string }>): Promise<{ content: unknown }>;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text?: unknown }).text ?? "") : "")).join("");
	}
	return "";
}

export function createTitleProvider(model: InvokableModel): TitleProvider {
	return {
		async generate({ title, firstUserMessage }) {
			const seed = (firstUserMessage ?? title).replace(/\s+/g, " ").trim().slice(0, 600);
			if (!seed) return undefined;
			const prompt =
				"用不超过 16 个字、概括这次 AI 编码会话主题，作为文档标题。只输出标题本身，不要引号或句末标点。\n\n会话首条消息：\n" +
				seed;
			const res = await model.invoke([{ role: "user", content: prompt }]);
			const text = extractText(res.content)
				.replace(/\s+/g, " ")
				.trim()
				.replace(/^["'「『《]+|["'」』》。.]+$/g, "")
				.trim();
			return text ? text.slice(0, 80) : undefined;
		},
	};
}
