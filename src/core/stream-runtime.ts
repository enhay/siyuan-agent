/**
 * stream-runtime — the streaming engine, on AI SDK v6 `streamText`.
 *
 * `runAgentStream` runs the agent loop and translates `result.fullStream` parts
 * into the stable {@link AgentStreamUiEvent} contract the UI renders live, and
 * builds the persisted state: a single `messages` track (AI SDK `ModelMessage[]`)
 * plus `toolUIEvents` (the rich tool cards, keyed by toolCallId). Tool custom UI
 * events arrive out-of-band via `experimental_context.emit` (see define-tool.ts).
 */

import { streamText, stepCountIs, type ModelMessage } from "ai";
import type {
	AgentModel,
	AgentState,
	AgentStreamUiEvent,
	AgentToolSet,
	RunAgentStreamResult,
	TodoList,
	ToolUIEvent,
	ToolUIEventPayload,
} from "../types";
import { genId, toModelMessages } from "./message-shape";

/** Parse a tool writer payload (already an object) into a typed ToolUIEvent. */
function normalizeToolUIEvent(parsed: any, raw: string, toolCallIndex: number, toolName?: string): ToolUIEvent {
	let payload: ToolUIEventPayload;
	if (parsed?.__tool_type === "activity") {
		payload = {
			type: "activity",
			category: parsed.category === "change" || parsed.category === "other" ? parsed.category : "lookup",
			action: typeof parsed.action === "string" ? parsed.action : "other",
			id: parsed.id ? String(parsed.id) : undefined,
			path: parsed.path ? String(parsed.path) : undefined,
			label: parsed.label ? String(parsed.label) : undefined,
			meta: parsed.meta ? String(parsed.meta) : undefined,
			open: parsed.open === undefined ? undefined : Boolean(parsed.open),
		};
	} else if (parsed?.__tool_type === "created_document" && parsed.id) {
		payload = { type: "created_document", id: String(parsed.id), path: parsed.path ? String(parsed.path) : undefined };
	} else if (parsed?.__tool_type === "document_link" && parsed.id) {
		payload = {
			type: "document_link",
			id: String(parsed.id),
			path: parsed.path ? String(parsed.path) : undefined,
			label: parsed.label ? String(parsed.label) : undefined,
			open: Boolean(parsed.open),
		};
	} else if (parsed?.__tool_type === "document_blocks" && parsed.id) {
		payload = {
			type: "document_blocks",
			id: String(parsed.id),
			path: parsed.path ? String(parsed.path) : undefined,
			blockCount: Number(parsed.blockCount) || 0,
			open: Boolean(parsed.open),
		};
	} else if (parsed?.__tool_type === "append_block" && parsed.parentID) {
		payload = {
			type: "append_block",
			parentID: String(parsed.parentID),
			path: parsed.path ? String(parsed.path) : undefined,
			blockIDs: Array.isArray(parsed.blockIDs) ? parsed.blockIDs.map(String) : [],
			open: Boolean(parsed.open),
		};
	} else if (parsed?.__tool_type === "edit_blocks") {
		payload = {
			type: "edit_blocks",
			documentIDs: Array.isArray(parsed.documentIDs) ? parsed.documentIDs.map(String) : [],
			primaryDocumentID: parsed.primaryDocumentID ? String(parsed.primaryDocumentID) : undefined,
			path: parsed.path ? String(parsed.path) : undefined,
			editedCount: Number(parsed.editedCount) || 0,
			open: Boolean(parsed.open),
		};
	} else if (parsed && typeof parsed === "object") {
		payload = { type: "unknown_structured", raw, payload: parsed };
	} else {
		payload = { type: "text", text: raw };
	}

	return {
		id: genId(),
		source: "writer",
		toolCallIndex,
		toolCallId: parsed?.toolCallId ? String(parsed.toolCallId) : undefined,
		toolName: typeof parsed?.toolName === "string" ? parsed.toolName : toolName,
		payload,
	};
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	if (!error || typeof error !== "object") return false;
	return "name" in error && (error as { name?: unknown }).name === "AbortError";
}

/** Merge a saved session state with new user input into a runnable input. */
export function mergeState(
	savedState: Record<string, any> | null,
	inputMsgStr?: string,
): { messages: ModelMessage[]; compaction?: any; todos?: TodoList } {
	const messages = toModelMessages(savedState?.messages ?? []);
	if (inputMsgStr) messages.push({ role: "user", content: inputMsgStr });
	return {
		messages,
		compaction: savedState?.compaction ? { ...savedState.compaction } : undefined,
		todos: savedState?.todos,
	};
}

/** Fold the compaction summary + pinned plan into the system prompt for this run. */
function augmentSystem(system: string, compaction?: any, todos?: TodoList): string {
	let out = system;
	if (compaction?.summary) {
		out += `\n\n[Conversation summary from earlier turns]\n${compaction.summary}`;
	}
	if (todos && todos.items.length > 0) {
		const icon = (s: string) => (s === "completed" ? "✅" : s === "in_progress" ? "🔄" : "⬜");
		const lines = todos.items.map((i) => `- ${icon(i.status)} [${i.status}] ${i.content}`);
		out += `\n\n[Current task plan]\nGoal: ${todos.goal}\n${lines.join("\n")}`;
	}
	return out;
}

export interface RunAgentStreamParams {
	model: AgentModel;
	system: string;
	tools: AgentToolSet;
	providerOptions?: Record<string, Record<string, unknown>>;
	input: { messages: ModelMessage[]; compaction?: any; todos?: TodoList };
	signal?: AbortSignal;
	recursionLimit?: number;
	existingToolUIEvents?: ToolUIEvent[];
	onUiEvent?: (event: AgentStreamUiEvent) => void;
}

export async function runAgentStream({
	model,
	system,
	tools,
	providerOptions,
	input,
	signal,
	recursionLimit = 100,
	existingToolUIEvents = [],
	onUiEvent,
}: RunAgentStreamParams): Promise<RunAgentStreamResult> {
	const toolUIEvents: ToolUIEvent[] = [...existingToolUIEvents];
	const toolCallMap: Record<string, { index: number; name?: string }> = {};
	let lastToolCallIndex = -1;
	let latestTodos: TodoList | undefined;
	let reasoningTotal = ""; // reasoning_delta carries the cumulative text

	// Tool custom UI events arrive via experimental_context.emit(toolCallId, payload).
	// streamText runs tool execute() eagerly, so an emit can fire BEFORE this loop
	// has processed the matching `tool-call` part. Buffer such early emits and flush
	// them once the tool call is registered (so they bind to the right card).
	const pendingEmits: Record<string, Array<Record<string, unknown>>> = {};

	const flushToolEvent = (toolCallId: string, payload: Record<string, unknown>) => {
		const enriched = { ...payload, toolCallId };
		const event = normalizeToolUIEvent(enriched, JSON.stringify(enriched), lastToolCallIndex);
		const mapped = toolCallMap[toolCallId];
		if (mapped) {
			event.toolCallIndex = mapped.index;
			event.toolName = event.toolName || mapped.name;
		}
		toolUIEvents.push(event);
		onUiEvent?.({ type: "tool_ui", event });
	};

	const emit = (toolCallId: string, payload: Record<string, unknown>) => {
		if ((payload as any)?.__tool_type === "write_todos" && (payload as any).todos) {
			latestTodos = (payload as any).todos as TodoList;
			onUiEvent?.({ type: "todos_update", todos: latestTodos });
			return;
		}
		if (toolCallMap[toolCallId]) {
			flushToolEvent(toolCallId, payload);
		} else {
			(pendingEmits[toolCallId] ??= []).push(payload);
		}
	};

	let aborted = false;
	let error: unknown;
	const IDLE_TIMEOUT_MS = 120_000;

	const result = streamText({
		model,
		system: augmentSystem(system, input.compaction, input.todos),
		messages: input.messages,
		tools,
		stopWhen: stepCountIs(recursionLimit),
		abortSignal: signal,
		...(providerOptions ? { providerOptions } : {}),
		experimental_context: { emit },
	});

	try {
		// Per-part idle timeout: if no part arrives for 120s, treat the stream as hung.
		let idleTimer: ReturnType<typeof setTimeout> | null = null;
		const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
		const withTimeout = async function* () {
			const iter = result.fullStream[Symbol.asyncIterator]();
			while (true) {
				const next = iter.next();
				const timeout = new Promise<never>((_, reject) => {
					idleTimer = setTimeout(() => reject(new Error("Stream idle timeout: no data received for 120s")), IDLE_TIMEOUT_MS);
				});
				try {
					const r = await Promise.race([next, timeout]);
					clearIdle();
					if (r.done) break;
					yield r.value;
				} catch (e) {
					clearIdle();
					throw e;
				}
			}
		};

		for await (const part of withTimeout()) {
			switch (part.type) {
				case "reasoning-delta": {
					const text = (part as any).text ?? "";
					if (!text) break;
					reasoningTotal += text;
					onUiEvent?.({ type: "reasoning_delta", text: reasoningTotal });
					break;
				}
				case "text-delta": {
					const text = (part as any).text ?? "";
					if (!text) break;
					onUiEvent?.({ type: "text_delta", text });
					break;
				}
				case "tool-call": {
					const tc = part as any;
					lastToolCallIndex += 1;
					toolCallMap[tc.toolCallId] = { index: lastToolCallIndex, name: tc.toolName };
					onUiEvent?.({
						type: "tool_call_start",
						toolName: tc.toolName,
						toolCallIndex: lastToolCallIndex,
						toolCallId: tc.toolCallId,
						args: tc.input,
					});
					const buffered = pendingEmits[tc.toolCallId];
					if (buffered) {
						delete pendingEmits[tc.toolCallId];
						for (const p of buffered) flushToolEvent(tc.toolCallId, p);
					}
					break;
				}
				case "tool-result": {
					const tc = part as any;
					const out = typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output);
					onUiEvent?.({ type: "tool_result", toolCallId: tc.toolCallId, result: out });
					break;
				}
				case "tool-error": {
					const tc = part as any;
					const msg = tc.error instanceof Error ? tc.error.message : String(tc.error);
					onUiEvent?.({ type: "tool_result", toolCallId: tc.toolCallId, result: msg });
					break;
				}
				case "abort":
					aborted = true;
					break;
				case "error":
					error = (part as any).error;
					break;
				default:
					break;
			}
		}
	} catch (err) {
		aborted = isAbortError(err, signal);
		if (!aborted) error = err;
	}

	// Flush any tool UI events whose `tool-call` part never arrived (best-effort).
	for (const [id, payloads] of Object.entries(pendingEmits)) {
		for (const p of payloads) flushToolEvent(id, p);
	}

	// Single persisted track: prior context + this turn's generated messages.
	let responseMessages: ModelMessage[] = [];
	try {
		responseMessages = ((await result.response).messages as ModelMessage[]) ?? [];
	} catch {
		// Aborted/failed before a full response — keep prior context only.
	}

	const lastState: AgentState = {};
	lastState.messages = [...input.messages, ...responseMessages];
	lastState.toolUIEvents = toolUIEvents;
	lastState.compaction = input.compaction;
	lastState.todos = latestTodos ?? input.todos;

	return { lastState, aborted, completed: !aborted && !error, error };
}
