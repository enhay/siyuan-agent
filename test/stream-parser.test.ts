import { describe, expect, it } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import {
	createParserState,
	parseChunk,
	type ParseDeps,
} from "../src/core/stream-runtime";
import { UiMessageBuilder } from "../src/core/ui-message-builder";
import { isToolMessageUi } from "../src/types";
import type { AgentState, ToolMessageUi } from "../src/types";

function makeDeps(inputState: AgentState = {}): ParseDeps {
	return {
		parserState: createParserState(inputState),
		uiBuilder: new UiMessageBuilder(),
		streamReasoningBuffer: { value: "" },
	};
}

function toolMessages(ui: ReturnType<UiMessageBuilder["snapshot"]>): ToolMessageUi[] {
	return ui.filter((m): m is ToolMessageUi => isToolMessageUi(m));
}

describe("parseChunk — messages/ai", () => {
	it("buffers plain text and emits a text_delta event", () => {
		const deps = makeDeps();

		const events = parseChunk(deps, [
			"messages",
			[{ _getType: () => "ai", content: "Hello" }, {}],
		]);

		expect(events).toEqual([{ type: "text_delta", text: "Hello" }]);
		expect(deps.parserState.contentBuffer).toBe("Hello");

		/* Accumulates across chunks */
		const more = parseChunk(deps, [
			"messages",
			[{ _getType: () => "ai", content: " world" }, {}],
		]);
		expect(more).toEqual([{ type: "text_delta", text: " world" }]);
		expect(deps.parserState.contentBuffer).toBe("Hello world");

		/* AI dict pushed into the UI builder */
		const aiUi = deps.uiBuilder.snapshot().find((m) => !isToolMessageUi(m));
		expect((aiUi as any)?.kwargs?.content).toBe("Hello world");
	});

	it("registers tool_call_chunks, advances toolCallMap, emits tool_call_start, and starts ToolMessageUi after the AI dict", () => {
		const deps = makeDeps();

		const events = parseChunk(deps, [
			"messages",
			[{
				_getType: () => "ai",
				content: "Let me check. ",
				tool_call_chunks: [{ name: "search_fulltext", id: "call-1", args: { query: "foo" } }],
			}, {}],
		]);

		expect(events).toEqual([
			{ type: "text_delta", text: "Let me check. " },
			{
				type: "tool_call_start",
				toolName: "search_fulltext",
				toolCallIndex: 0,
				toolCallId: "call-1",
				args: { query: "foo" },
			},
		]);

		expect(deps.parserState.lastToolCallIndex).toBe(0);
		expect(deps.parserState.toolCallMap["call-1"]).toEqual({ index: 0, name: "search_fulltext" });
		expect(deps.parserState.pendingToolCalls).toEqual([
			{ name: "search_fulltext", args: { query: "foo" }, id: "call-1" },
		]);
		expect(deps.parserState.seenToolCallKeys).toEqual(["id:call-1"]);

		/* Ordering: AI message dict must precede the ToolMessageUi so the tool
		   call lives on the AI message. */
		const ui = deps.uiBuilder.snapshot();
		expect(ui).toHaveLength(2);
		expect(isToolMessageUi(ui[0])).toBe(false);
		expect(isToolMessageUi(ui[1])).toBe(true);
		expect((ui[1] as ToolMessageUi).toolCallId).toBe("call-1");
		expect((ui[1] as ToolMessageUi).status).toBe("running");
	});

	it("dedupes repeated tool_call_chunks by stable key", () => {
		const deps = makeDeps();

		parseChunk(deps, [
			"messages",
			[{
				_getType: () => "ai",
				content: "",
				tool_call_chunks: [{ name: "search_fulltext", id: "call-1", args: { query: "foo" } }],
			}, {}],
		]);
		const second = parseChunk(deps, [
			"messages",
			[{
				_getType: () => "ai",
				content: "",
				tool_call_chunks: [{ name: "search_fulltext", id: "call-1", args: { query: "foo" } }],
			}, {}],
		]);

		expect(second).toEqual([]);
		expect(deps.parserState.lastToolCallIndex).toBe(0);
		expect(deps.parserState.pendingToolCalls).toHaveLength(1);
	});

	it("advances BOTH reasoning buffers and emits the cumulative display total", () => {
		const deps = makeDeps();

		const first = parseChunk(deps, [
			"messages",
			[{
				_getType: () => "ai",
				content: "",
				additional_kwargs: { reasoning_content: "Need to search first." },
			}, {}],
		]);
		expect(first).toEqual([{ type: "reasoning_delta", text: "Need to search first." }]);
		expect(deps.streamReasoningBuffer.value).toBe("Need to search first.");
		expect(deps.parserState.reasoningBuffer).toBe("Need to search first.");

		/* Cumulative incoming chunk — only the delta is appended, the event
		   carries the full display total. */
		const second = parseChunk(deps, [
			"messages",
			[{
				_getType: () => "ai",
				content: "",
				additional_kwargs: { reasoning_content: "Need to search first. Then inspect." },
			}, {}],
		]);
		expect(second).toEqual([
			{ type: "reasoning_delta", text: "Need to search first. Then inspect." },
		]);
		expect(deps.streamReasoningBuffer.value).toBe("Need to search first. Then inspect.");
		expect(deps.parserState.reasoningBuffer).toBe("Need to search first. Then inspect.");
	});
});

describe("parseChunk — messages/tool", () => {
	it("flushes the AI turn, enqueues a ToolMessage, finalises the ToolMessageUi, and emits tool_result", () => {
		const deps = makeDeps();

		/* Prime an AI turn with a tool call so flushCurrentAiTurn has work. */
		parseChunk(deps, [
			"messages",
			[{
				_getType: () => "ai",
				content: "checking",
				tool_call_chunks: [{ name: "search_fulltext", id: "call-1", args: { query: "foo" } }],
			}, {}],
		]);

		const events = parseChunk(deps, [
			"messages",
			[{ _getType: () => "tool", content: "42", tool_call_id: "call-1" }, {}],
		]);

		expect(events).toEqual([
			{ type: "tool_result", toolCallId: "call-1", result: "42" },
		]);

		/* AI turn flushed into pendingMessages, then the ToolMessage appended. */
		const pending = deps.parserState.pendingMessages;
		const toolMsg = pending[pending.length - 1];
		expect(toolMsg).toBeInstanceOf(ToolMessage);
		expect((toolMsg as ToolMessage).content).toBe("42");
		expect((toolMsg as ToolMessage).tool_call_id).toBe("call-1");

		/* flushCurrentAiTurn cleared the streaming buffers. */
		expect(deps.parserState.contentBuffer).toBe("");
		expect(deps.parserState.pendingToolCalls).toEqual([]);

		/* ToolMessageUi finalised as done (no longer pending). */
		const tmu = toolMessages(deps.uiBuilder.snapshot())[0];
		expect(tmu.status).toBe("done");
	});

	it("stringifies non-string tool content", () => {
		const deps = makeDeps();
		const events = parseChunk(deps, [
			"messages",
			[{ _getType: () => "tool", content: { a: 1 }, tool_call_id: "call-x" }, {}],
		]);
		expect(events).toEqual([
			{ type: "tool_result", toolCallId: "call-x", result: JSON.stringify({ a: 1 }) },
		]);
	});

	it.each([
		["Error: boom", true],
		["[子智能体执行失败] something", true],
		["[Sub-agent failed] something", true],
		["ToolError: bad", true],
		['{"error":"nope"}', true],
		["42", false],
	])("detects isError for %j → %s", (content, expected) => {
		const deps = makeDeps();
		/* Start a tool call so onToolResult has a pending entry to mark. */
		parseChunk(deps, [
			"messages",
			[{
				_getType: () => "ai",
				content: "",
				tool_call_chunks: [{ name: "t", id: "call-e", args: {} }],
			}, {}],
		]);
		parseChunk(deps, [
			"messages",
			[{ _getType: () => "tool", content, tool_call_id: "call-e" }, {}],
		]);

		const tmu = toolMessages(deps.uiBuilder.snapshot())[0];
		expect(tmu.status).toBe(expected ? "error" : "done");
	});
});

describe("parseChunk — values", () => {
	it("replaces currentState and resets pending recovery", () => {
		const deps = makeDeps();

		/* Pollute the recovery buffers. */
		parseChunk(deps, [
			"messages",
			[{ _getType: () => "ai", content: "partial" }, {}],
		]);
		expect(deps.parserState.contentBuffer).toBe("partial");

		const snapshot = { messages: [], marker: 7 } as AgentState;
		const events = parseChunk(deps, ["values", snapshot]);

		expect(events).toEqual([]);
		expect(deps.parserState.currentState).toBe(snapshot);
		expect(deps.parserState.contentBuffer).toBe("");
		expect(deps.parserState.reasoningBuffer).toBe("");
		expect(deps.parserState.pendingMessages).toEqual([]);
		expect(deps.parserState.pendingToolCalls).toEqual([]);
	});
});

describe("parseChunk — custom", () => {
	it("intercepts write_todos and persists the plan into state", () => {
		const inputState: AgentState = {};
		const deps = makeDeps(inputState);
		const todos = { goal: "ship", items: [{ content: "do it", status: "pending" }] } as any;

		const events = parseChunk(deps, [
			"custom",
			JSON.stringify({ __tool_type: "write_todos", todos }),
		]);

		/* todos_update event emitted, plus the normalized tool_ui event. */
		expect(events[0]).toEqual({ type: "todos_update", todos });
		expect(deps.parserState.inputState.todos).toEqual(todos);
	});

	it("normalizes a writer event and backfills toolCallIndex/toolName from toolCallMap", () => {
		const deps = makeDeps();

		/* Establish a tool call so toolCallMap has call-1 → index 0. */
		parseChunk(deps, [
			"messages",
			[{
				_getType: () => "ai",
				content: "",
				tool_call_chunks: [{ name: "search_fulltext", id: "call-1", args: { query: "foo" } }],
			}, {}],
		]);

		const events = parseChunk(deps, [
			"custom",
			JSON.stringify({
				__tool_type: "activity",
				toolCallId: "call-1",
				category: "lookup",
				action: "search",
				label: "foo",
			}),
		]);

		const tuiEvent = events.find((e) => e.type === "tool_ui");
		expect(tuiEvent).toBeDefined();
		expect((tuiEvent as any).event).toEqual(
			expect.objectContaining({
				toolCallId: "call-1",
				toolCallIndex: 0,
				toolName: "search_fulltext",
			}),
		);

		/* Recorded in parserState and routed to the matching ToolMessageUi. */
		expect(deps.parserState.toolUIEvents).toHaveLength(1);
		expect(deps.parserState.toolUIEvents[0].toolCallId).toBe("call-1");

		const tmu = toolMessages(deps.uiBuilder.snapshot())
			.find((m) => m.toolCallId === "call-1");
		expect(tmu?.events).toHaveLength(1);
	});

	it("falls back to lastToolCallIndex when the writer event has no known toolCallId", () => {
		const deps = makeDeps();
		const events = parseChunk(deps, [
			"custom",
			JSON.stringify({ __tool_type: "activity", category: "lookup", action: "search" }),
		]);
		const tuiEvent = events.find((e) => e.type === "tool_ui");
		expect((tuiEvent as any).event.toolCallIndex).toBe(deps.parserState.lastToolCallIndex);
		expect(deps.parserState.lastToolCallIndex).toBe(-1);
	});
});
