import { createAgent, summarizationMiddleware } from "langchain";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { Client } from "langsmith";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { buildSystemPrompt, resolveModelConfig, type AgentConfig, type ModelConfig, type ReasoningEffort } from "../types";
import { defaultTranslator, type Translator } from "../i18n";
import { createChatModel } from "./chat-model";
import { kernel } from "./tools/siyuan-kernel";

/** Fetch the guide doc body; returns "" on failure. Kept exported so callers fetch it once and pass it in. */
export async function fetchGuideDoc(docId: string): Promise<string> {
	try {
		const { content } = await kernel.exportApi.mdContent(docId);
		return (content || "").trim();
	} catch {
		return "";
	}
}

/**
 * Pure assembly of the agent system prompt. No I/O.
 * Order: base → guide (only when guideContent non-empty) → defaultNotebook → customInstructions → extraSystemPrompt.
 */
export function buildAgentSystemPrompt(
	config: AgentConfig,
	guideContent: string,
	i18n: Translator = defaultTranslator,
	extraSystemPrompt?: string | null,
): string {
	let systemPrompt = buildSystemPrompt(i18n);
	if (guideContent) {
		systemPrompt += `\n\n---\n${i18n.t("agent.guideDocHeader")}\n${guideContent}\n---`;
	}
	if (config.defaultNotebook?.id) {
		systemPrompt += `\n\n${i18n.t("agent.defaultNotebook", {
			name: config.defaultNotebook.name,
			id: config.defaultNotebook.id,
		})}`;
	}
	if (config.customInstructions?.trim()) {
		systemPrompt += `\n\n${i18n.t("agent.customInstructions", {
			instructions: config.customInstructions.trim(),
		})}`;
	}
	if (extraSystemPrompt) {
		systemPrompt += `\n\n${extraSystemPrompt}`;
	}
	return systemPrompt;
}

export interface MakeAgentOptions {
	extraSystemPrompt?: string | null;
	modelOverride?: ModelConfig | null;
	i18n?: Translator;
	reasoningEffort?: ReasoningEffort;
	guideContent?: string;
}

/** Builds the agent. No fetch: guideContent must be supplied by the caller. */
export function makeAgent(
	config: AgentConfig,
	tools: StructuredToolInterface[],
	opts: MakeAgentOptions = {},
) {
	const { extraSystemPrompt, modelOverride, i18n = defaultTranslator, reasoningEffort = "default", guideContent = "" } = opts;
	const mc = modelOverride || resolveModelConfig(config);
	const model = createChatModel(mc, { streaming: true, reasoningEffort });

	const systemPrompt = buildAgentSystemPrompt(config, guideContent, i18n, extraSystemPrompt);

	const middleware = [
		summarizationMiddleware({
			model,
			trigger: { messages: 30 },
			keep: { messages: 12 },
		}),
	] as const;

	return createAgent({
		model,
		tools,
		systemPrompt,
		middleware,
	});
}

export function makeTracer(config: AgentConfig): LangChainTracer | null {
	if (!config.langSmithEnabled || !config.langSmithApiKey) return null;

	const client = new Client({
		apiKey: config.langSmithApiKey,
		apiUrl: config.langSmithEndpoint || "https://api.smith.langchain.com",
	});

	return new LangChainTracer({
		projectName: config.langSmithProject || "SiYuan-Agent",
		client,
	});
}
