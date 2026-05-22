/** TitleProvider backed by an AI SDK chat model from the plugin's registry.
 *
 *  Kept decoupled from AgentConfig: caller supplies a model + optional
 *  providerOptions (e.g. reasoning effort "off"). Failures surface as undefined
 *  so the engine falls back to the heuristic title (plan §11/§12). Only the
 *  first user message is sent — no raw tool output. */

import { generateText, type LanguageModel } from "ai";
import type { TitleProvider } from "../engine/ports";

export function createTitleProvider(
	model: LanguageModel,
	providerOptions?: Record<string, Record<string, unknown>>,
): TitleProvider {
	return {
		async generate({ title, firstUserMessage }) {
			const seed = (firstUserMessage ?? title).replace(/\s+/g, " ").trim().slice(0, 600);
			if (!seed) return undefined;
			const prompt =
				"为下面这段编程对话起一个简短中文标题（不超过 16 字），直接概括任务或主题。" +
				"只输出标题本身：不要引号或标点，不要出现“会话”“主题”“AI”“编码”等字样。\n\n首条消息：\n" +
				seed;
			const { text: raw } = await generateText({
				model,
				prompt,
				...(providerOptions ? { providerOptions } : {}),
			});
			const text = (raw ?? "")
				.replace(/\s+/g, " ")
				.trim()
				.replace(/^["'「『《]+|["'」』》。.]+$/g, "")
				.trim();
			return text ? text.slice(0, 80) : undefined;
		},
	};
}
