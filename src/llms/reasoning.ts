import type { BaseMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
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
	// Pair the k-th assistant message in the outgoing request with the k-th AI
	// message in the LangChain source list. Robust to a leading system message
	// and interleaved human/tool messages — a strict index-by-index walk desyncs
	// (e.g. one AI turn with N tool_calls followed by N tool messages).
	const reasonings = sourceMessages
		.filter((m) => messageKind(m) === "ai")
		.map((m) => messageReasoning(m));
	if (reasonings.length === 0) return request;
	let aiIndex = 0;
	const nextMessages = request.messages.map((message) => {
		if (message?.role !== "assistant") return message;
		const reasoning = reasonings[aiIndex];
		aiIndex += 1;
		return reasoning ? { ...message, reasoning_content: reasoning } : message;
	});
	return {
		...request,
		messages: nextMessages,
	};
}

/* TEMP DEBUG: write reasoning round-trip diagnostics to <workspace>/temp so they
   can be inspected off the renderer console. Remove once the 400 is resolved. */
const __reasoningDebug: any[] = [];
function __flushReasoningDebug(): void {
	if (typeof window === "undefined") return; // renderer only; skip in node/test
	try {
		const path = "/data/storage/petal/siyuan-agent/sa-reasoning-debug.json";
		const blob = new Blob([JSON.stringify(__reasoningDebug.slice(-30), null, 2)], { type: "application/json" });
		const file = new File([blob], "sa-reasoning-debug.json");
		const fd = new FormData();
		fd.append("path", path);
		fd.append("file", file);
		fd.append("isDir", "false");
		fetch("/api/file/putFile", { method: "POST", body: fd }).catch(() => { /* ignore */ });
	} catch { /* ignore */ }
}
function __rec(event: string, extra?: Record<string, unknown>): void {
	__reasoningDebug.push({ ts: new Date().toISOString(), event, ...(extra || {}) });
	__flushReasoningDebug();
}

/**
 * Patch a `ChatOpenAI` instance so DeepSeek-style `reasoning_content` survives a
 * round-trip: captured from streamed deltas and the final message into
 * `additional_kwargs`, then echoed back onto assistant turns of the next request.
 *
 * Thinking-mode endpoints reject a follow-up call (e.g. after a tool result)
 * whose preceding assistant turn omits `reasoning_content` — this restores it.
 * No-op for responses that carry no reasoning, so it's safe whenever thinking
 * may be on. Reusable across the native DeepSeek model and OpenAI-compatible
 * endpoints that speak the same `reasoning_content` field.
 */
// The LangChain messages of the in-flight completions call. Set by the patched
// _generate / _streamResponseChunks just before the request is built, read by
// the patched completionWithRetry. Agent model calls are sequential, so a single
// shared slot is sufficient.
let __sourceMessages: BaseMessage[] | null = null;

export function patchReasoningRoundTrip(model: ChatOpenAI): void {
	const completions = (model as any)?.completions;
	if (!completions) return;
	// Patch the ChatOpenAICompletions PROTOTYPE, not the instance: LangChain's
	// createAgent rebinds the model (bindTools) onto a fresh instance, so an
	// instance-level patch is bypassed. The prototype is shared by every
	// instance — including rebound clones — so this survives.
	const proto = Object.getPrototypeOf(completions);
	if (!proto || (proto as any).__reasoningRoundTripPatched) {
		__rec("patched", { model: (model as any)?.model, already: true });
		return;
	}
	(proto as any).__reasoningRoundTripPatched = true;

	const origDelta = proto._convertCompletionsDeltaToBaseMessageChunk;
	proto._convertCompletionsDeltaToBaseMessageChunk = function (this: any, delta: any, raw: any, role: any) {
		const chunk = origDelta.call(this, delta, raw, role);
		if (delta?.reasoning_content != null) chunk.additional_kwargs.reasoning_content = delta.reasoning_content;
		return chunk;
	};

	const origMessage = proto._convertCompletionsMessageToBaseMessage;
	proto._convertCompletionsMessageToBaseMessage = function (this: any, message: any, raw: any) {
		const m = origMessage.call(this, message, raw);
		if (message?.reasoning_content != null) m.additional_kwargs.reasoning_content = message.reasoning_content;
		return m;
	};

	const origGenerate = proto._generate;
	proto._generate = function (this: any, messages: BaseMessage[], options: any, runManager?: any) {
		__sourceMessages = messages;
		__rec("_generate", { n: messages?.length });
		return origGenerate.call(this, messages, options, runManager);
	};

	const origStream = proto._streamResponseChunks;
	proto._streamResponseChunks = function (this: any, messages: BaseMessage[], options: any, runManager?: any) {
		__sourceMessages = messages;
		__rec("_stream", { n: messages?.length });
		return origStream.call(this, messages, options, runManager);
	};

	const origRetry = proto.completionWithRetry;
	proto.completionWithRetry = function (this: any, request: any, requestOptions?: any) {
		const patched = injectReasoningContent(request, __sourceMessages);
		__rec("completionWithRetry", {
			source: Array.isArray(__sourceMessages)
				? __sourceMessages.map((m) => ({ kind: messageKind(m), reasoningLen: messageReasoning(m).length }))
				: null,
			request: Array.isArray(patched?.messages)
				? patched.messages.map((m: any) => ({
					role: m?.role,
					hasReasoning: !!m?.reasoning_content,
					nToolCalls: Array.isArray(m?.tool_calls) ? m.tool_calls.length : 0,
				}))
				: null,
		});
		return origRetry.call(this, patched, requestOptions);
	};

	__rec("patched", { model: (model as any)?.model });
}
