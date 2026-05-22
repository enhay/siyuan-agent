/**
 * message-shape — the single seam that knows how messages are wire-encoded.
 *
 * Two shapes coexist after the AI SDK migration:
 *   - `messagesUi` entries: `lc:1` constructor dicts (plain JSON, NOT LangChain
 *     instances) and `ToolMessageUi` — the persisted/rendered UI track.
 *   - `state.messages` entries: AI SDK `ModelMessage` (role + string|parts) —
 *     the LLM context track fed to `streamText`/`generateText`.
 *
 * Every consumer reads messages through these accessors, which transparently
 * handle lc:1 dicts, simplified `{type|role, content}` dicts, and ModelMessage
 * (string content or a `parts` array). A wire-format change touches this file.
 */

import type { ModelMessage } from "ai";

export type MessageKind = "human" | "ai" | "system" | "tool" | "";

/** Short random id. */
export function genId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Content parts of a ModelMessage, or [] for string/scalar content. */
function contentParts(message: any): any[] {
	const content = message?.kwargs?.content ?? message?.content;
	return Array.isArray(content) ? content : [];
}

/** Any wire format → canonical kind. */
export function messageKind(message: any): MessageKind {
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

/** Text content; joins text parts of a ModelMessage; "" if none. */
export function messageContent(message: any): string {
	const content = message?.kwargs?.content ?? message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p) => p?.type === "text" && typeof p.text === "string")
			.map((p) => p.text)
			.join("");
	}
	return "";
}

/**
 * Chain-of-thought reasoning; "" if absent. Handles:
 *   - lc:1 dict additional_kwargs.reasoning_content (UI track)
 *   - lc_kwargs.additional_kwargs.reasoning_content (persisted render)
 *   - ModelMessage `reasoning` content part (LLM track)
 */
export function messageReasoning(message: any): string {
	const reasoning = message?.kwargs?.additional_kwargs?.reasoning_content
		?? message?.additional_kwargs?.reasoning_content
		?? message?.kwargs?.lc_kwargs?.additional_kwargs?.reasoning_content
		?? message?.lc_kwargs?.additional_kwargs?.reasoning_content;
	if (typeof reasoning === "string") return reasoning;
	const part = contentParts(message).find((p) => p?.type === "reasoning" && typeof p.text === "string");
	return part ? part.text : "";
}

/** ToolMessage's tool_call_id; reads a ModelMessage tool-result part too. */
export function messageToolCallId(message: any): string {
	const id = message?.kwargs?.tool_call_id ?? message?.tool_call_id;
	if (typeof id === "string") return id;
	const part = contentParts(message).find((p) => p?.type === "tool-result" && typeof p.toolCallId === "string");
	return part ? part.toolCallId : "";
}

/**
 * tool_calls on an AI message, normalised to `{ id, name, args }[]`.
 * Reads lc:1 dicts and ModelMessage `tool-call` content parts.
 */
export function messageToolCalls(message: any): any[] {
	const toolCalls = message?.kwargs?.tool_calls ?? message?.tool_calls;
	if (Array.isArray(toolCalls)) return toolCalls;
	const parts = contentParts(message).filter((p) => p?.type === "tool-call");
	return parts.map((p) => ({ id: p.toolCallId, name: p.toolName, args: p.input }));
}

/** A single tool_call / tool_call_chunk's id; "" if absent. */
export function toolCallId(raw: any): string {
	const id = raw?.id ?? raw?.tool_call_id ?? raw?.toolCallId;
	return typeof id === "string" ? id : "";
}

/**
 * Convert persisted messages to AI SDK `ModelMessage[]` for the LLM context.
 *
 * New sessions persist `state.messages` as ModelMessage already (passed through);
 * lc:1 / simplified dicts from older sessions are converted best-effort.
 */
export function toModelMessages(messages: any[]): ModelMessage[] {
	const out: ModelMessage[] = [];
	for (const m of messages || []) {
		// Already a ModelMessage (has a role and no lc:1 marker) → pass through.
		if (m?.role && m?.lc !== 1 && !Array.isArray(m?.id)) {
			out.push(m as ModelMessage);
			continue;
		}
		const kind = messageKind(m);
		const text = messageContent(m);
		if (kind === "human") {
			out.push({ role: "user", content: text });
		} else if (kind === "system") {
			out.push({ role: "system", content: text });
		} else if (kind === "ai") {
			const reasoning = messageReasoning(m);
			const calls = messageToolCalls(m);
			const parts: any[] = [];
			if (reasoning) parts.push({ type: "reasoning", text: reasoning });
			if (text) parts.push({ type: "text", text });
			for (const tc of calls) {
				parts.push({ type: "tool-call", toolCallId: toolCallId(tc), toolName: tc.name, input: tc.args });
			}
			out.push({ role: "assistant", content: parts.length ? parts : text });
		} else if (kind === "tool") {
			out.push({
				role: "tool",
				content: [{
					type: "tool-result",
					toolCallId: messageToolCallId(m),
					toolName: m?.name ?? m?.kwargs?.name ?? "",
					output: { type: "text", value: text },
				}],
			});
		}
	}
	return out;
}

/* ── Writers (lc:1 UI-track dicts) ─────────────────────────────────────── */

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
