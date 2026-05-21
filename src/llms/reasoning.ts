import type { BaseMessage } from "@langchain/core/messages";
import { messageKind, messageReasoning } from "../core/message-shape";

export interface ModelProfile {
	maxInputTokens?: number;
	maxOutputTokens?: number;
	reasoningOutput?: boolean;
	toolCalling?: boolean;
	structuredOutput?: boolean;
}

export const DEEPSEEK_PROFILES: Record<string, ModelProfile> = {
	"deepseek-reasoner": {
		maxInputTokens: 128000,
		maxOutputTokens: 128000,
		reasoningOutput: true,
		toolCalling: true,
		structuredOutput: false,
	},
	"deepseek-chat": {
		maxInputTokens: 128000,
		maxOutputTokens: 8192,
		reasoningOutput: false,
		toolCalling: true,
		structuredOutput: false,
	},
};

export function injectReasoningContent<T extends { messages?: any[] }>(
	request: T,
	sourceMessages: BaseMessage[] | null | undefined,
): T {
	if (!Array.isArray(request.messages) || !Array.isArray(sourceMessages)) return request;
	const nextMessages = request.messages.map((message) => ({ ...message }));
	let requestIndex = 0;
	for (const sourceMessage of sourceMessages) {
		const requestMessage = nextMessages[requestIndex];
		requestIndex += 1;
		if (!requestMessage || requestMessage.role !== "assistant") continue;
		if (messageKind(sourceMessage) !== "ai") continue;
		const reasoning = messageReasoning(sourceMessage);
		if (reasoning) {
			requestMessage.reasoning_content = reasoning;
		}
	}
	return {
		...request,
		messages: nextMessages,
	};
}
