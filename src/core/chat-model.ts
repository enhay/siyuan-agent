import { ChatOpenAI } from "@langchain/openai";
import type { AgentModel } from "./agent-types";
import type { ModelConfig, ReasoningEffort } from "../types";
import { ChatDeepSeek } from "../llms/deepseek";
import { injectReasoningContent, patchReasoningRoundTrip } from "../llms/reasoning";

export { injectReasoningContent };

export interface CreateChatModelOptions {
	streaming?: boolean;
	temperature?: number;
	reasoningEffort?: ReasoningEffort;
}

export function getOpenAICompatibleModelKwargs(reasoningEffort: ReasoningEffort = "default"): Record<string, any> {
	if (reasoningEffort === "off") {
		return {
			thinking: { type: "disabled" },
		};
	}
	if (reasoningEffort === "low" || reasoningEffort === "high") {
		return {
			thinking: { type: "enabled" },
		};
	}
	return {};
}

export function createChatModel(
	config: ModelConfig,
	options: CreateChatModelOptions = {},
): AgentModel {
	const temperature = options.temperature ?? config.temperature ?? 0;
	const streaming = options.streaming ?? false;
	if (config.providerType === "deepseek") {
		return new ChatDeepSeek({
			model: config.model,
			temperature,
			streaming,
			apiKey: config.apiKey,
			modelKwargs: ChatDeepSeek.getModelKwargs(options.reasoningEffort),
			configuration: {
				dangerouslyAllowBrowser: true,
				baseURL: config.apiBaseURL || "https://api.deepseek.com",
			},
		}) as unknown as AgentModel;
	}
	const compatKwargs = getOpenAICompatibleModelKwargs(options.reasoningEffort);
	const model = new ChatOpenAI({
		model: config.model,
		temperature,
		streaming,
		apiKey: config.apiKey,
		modelKwargs: compatKwargs,
		configuration: {
			dangerouslyAllowBrowser: true,
			baseURL: config.apiBaseURL,
		},
	});
	// Thinking-mode compatible endpoints reject follow-up calls whose assistant
	// turn omits reasoning_content; patch the round-trip only when thinking is on.
	if ((compatKwargs as { thinking?: { type?: string } }).thinking?.type === "enabled") {
		patchReasoningRoundTrip(model);
	}
	return model;
}
