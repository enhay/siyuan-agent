import type { AgentModel, AgentTool, AgentToolSet } from "./agent-types";
import { buildSystemPrompt, resolveModelConfig, type AgentConfig, type ModelConfig, type ReasoningEffort } from "../types";
import { defaultTranslator, type Translator } from "../i18n";
import { createModel, reasoningProviderOptions } from "./model";
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

/** Build the keyed ToolSet that `streamText`/`generateText` expects from our AgentTool[]. */
export function toolSetFromArray(tools: AgentTool[]): AgentToolSet {
	const set: Record<string, AgentTool> = {};
	for (const t of tools) {
		const name = (t as { __toolName?: string }).__toolName;
		if (name) set[name] = t;
	}
	return set as AgentToolSet;
}

export interface MakeAgentOptions {
	extraSystemPrompt?: string | null;
	modelOverride?: ModelConfig | null;
	i18n?: Translator;
	reasoningEffort?: ReasoningEffort;
	guideContent?: string;
}

/** Materials for a single agent run: model, system prompt, keyed tools, per-call options. */
export interface AgentRuntime {
	model: AgentModel;
	system: string;
	tools: AgentToolSet;
	providerOptions: Record<string, Record<string, unknown>>;
}

/** Assemble the agent run materials. No fetch: guideContent must be supplied by the caller. */
export function makeAgent(
	config: AgentConfig,
	tools: AgentTool[],
	opts: MakeAgentOptions = {},
): AgentRuntime {
	const { extraSystemPrompt, modelOverride, i18n = defaultTranslator, reasoningEffort = "default", guideContent = "" } = opts;
	const mc = modelOverride || resolveModelConfig(config);
	return {
		model: createModel(mc),
		system: buildAgentSystemPrompt(config, guideContent, i18n, extraSystemPrompt),
		tools: toolSetFromArray(tools),
		providerOptions: reasoningProviderOptions(reasoningEffort, mc),
	};
}
