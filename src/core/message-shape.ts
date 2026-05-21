/**
 * message-shape — the single seam that knows how LangChain messages are wire-encoded.
 *
 * A message can arrive in three wire formats:
 *   1. `lc:1` constructor dict: `{ lc:1, type:"constructor", id:[...,"AIMessage"], kwargs:{...} }`
 *   2. simplified dict: `{ type:"ai"|"human"|"tool"|... , content, ... }`
 *   3. a live `BaseMessage` instance (has `_getType()`).
 *
 * Every consumer reads messages through these accessors. A LangChain upgrade
 * touches this file only.
 */

import {
	AIMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
	type BaseMessage,
} from "@langchain/core/messages";

export type MessageKind = "human" | "ai" | "system" | "tool" | "";

/** Short random id. */
export function genId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Any wire format → canonical kind. AIMessageChunk normalises to "ai". */
export function messageKind(message: any): MessageKind {
	if (typeof message?._getType === "function") {
		const t = message._getType();
		return t === "AIMessageChunk" ? "ai" : (t as MessageKind);
	}
	if (message?.lc === 1 && Array.isArray(message.id)) {
		const className = message.id[message.id.length - 1] as string;
		if (className === "HumanMessage") return "human";
		if (className === "AIMessage" || className === "AIMessageChunk") return "ai";
		if (className === "SystemMessage") return "system";
		if (className === "ToolMessage") return "tool";
	}
	const raw = message?.type ?? message?.role ?? "";
	if (raw === "user") return "human";
	if (raw === "assistant" || raw === "AIMessageChunk") return "ai";
	if (raw === "human" || raw === "ai" || raw === "system" || raw === "tool") return raw;
	return "";
}

/** Text content; non-string content (incl. missing) → "". */
export function messageContent(message: any): string {
	const content = message?.kwargs?.content ?? message?.content;
	return typeof content === "string" ? content : "";
}

/**
 * DeepSeek chain-of-thought reasoning_content; "" if absent.
 *
 * Union of every fallback path used across the codebase:
 *   - kwargs.additional_kwargs.reasoning_content        (stream-runtime / reasoning.ts)
 *   - additional_kwargs.reasoning_content               (stream-runtime / reasoning.ts)
 *   - kwargs.lc_kwargs.additional_kwargs.reasoning_content   (chat-helpers — persisted render)
 *   - lc_kwargs.additional_kwargs.reasoning_content          (chat-helpers — persisted render)
 */
export function messageReasoning(message: any): string {
	const reasoning = message?.kwargs?.additional_kwargs?.reasoning_content
		?? message?.additional_kwargs?.reasoning_content
		?? message?.kwargs?.lc_kwargs?.additional_kwargs?.reasoning_content
		?? message?.lc_kwargs?.additional_kwargs?.reasoning_content;
	return typeof reasoning === "string" ? reasoning : "";
}

/** ToolMessage's tool_call_id; "" if absent. */
export function messageToolCallId(message: any): string {
	const id = message?.kwargs?.tool_call_id ?? message?.tool_call_id;
	return typeof id === "string" ? id : "";
}

/** tool_calls array on an AI message; [] if absent. */
export function messageToolCalls(message: any): any[] {
	const toolCalls = message?.kwargs?.tool_calls ?? message?.tool_calls;
	return Array.isArray(toolCalls) ? toolCalls : [];
}

/** A single tool_call / tool_call_chunk's id; "" if absent. */
export function toolCallId(raw: any): string {
	const id = raw?.id ?? raw?.tool_call_id;
	return typeof id === "string" ? id : "";
}

/** Dict → live BaseMessage (deserialisation). */
export function messageFromDict(raw: Record<string, any>): BaseMessage {
	if (raw.lc === 1 && raw.type === "constructor" && Array.isArray(raw.id)) {
		const className = raw.id[raw.id.length - 1] as string;
		const kwargs = raw.kwargs ?? {};
		if (className === "HumanMessage") return new HumanMessage(kwargs);
		if (className === "AIMessage") return new AIMessage(kwargs);
		if (className === "AIMessageChunk") return new AIMessage(kwargs);
		if (className === "SystemMessage") return new SystemMessage(kwargs);
		if (className === "ToolMessage") return new ToolMessage({ tool_call_id: "", ...kwargs });
		throw new Error(`Unknown LangChain message class: ${className}`);
	}

	const { type, ...rest } = raw;
	if (type === "human" || type === "user") return new HumanMessage(rest);
	if (type === "ai" || type === "assistant") return new AIMessage(rest);
	if (type === "system") return new SystemMessage(rest);
	if (type === "tool") return new ToolMessage({ tool_call_id: "", ...rest });
	throw new Error(`Unknown message type: ${type}`);
}

export function messagesFromDict(messages: Record<string, any>[]): BaseMessage[] {
	return messages.map(messageFromDict);
}

/* ── Writers ───────────────────────────────────────────────────────────── */

export function setMessageContent(raw: Record<string, any>, content: string): void {
	if (raw.kwargs && "content" in raw.kwargs) {
		raw.kwargs.content = content;
	} else {
		raw.content = content;
	}
}

export function setMessageToolCalls(raw: Record<string, any>, toolCalls: any[]): void {
	if (raw.kwargs && ("tool_calls" in raw.kwargs || raw.lc === 1)) {
		raw.kwargs = raw.kwargs || {};
		raw.kwargs.tool_calls = toolCalls;
	} else {
		raw.tool_calls = toolCalls;
	}
}
