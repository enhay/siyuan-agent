// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { mergeState, runAgentStream } from "../src/core/stream-runtime";
import { defineTool } from "../src/core/tools/define-tool";
import { toolSetFromArray } from "../src/core/agent";
import { messageContent, messageReasoning, messageKind } from "../src/core/message-shape";
import type { AgentStreamUiEvent } from "../src/types";

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 }, totalTokens: { total: 2 } };

/** A model that streams the given provider-level part arrays, one per step. */
function mockModel(steps: any[][]) {
	let i = 0;
	return new MockLanguageModelV3({
		doStream: async () => ({ stream: simulateReadableStream({ chunks: (steps[Math.min(i++, steps.length - 1)]) as any }) }),
	}) as any;
}

const lcHuman = (content: string) => ({
	lc: 1, type: "constructor", id: ["langchain_core", "messages", "HumanMessage"], kwargs: { content },
});

describe("mergeState", () => {
	it("converts saved lc:1 messages to ModelMessage[] and appends the new human turn", () => {
		const out = mergeState({ messages: [lcHuman("earlier")] }, "now");
		expect(out.messages).toEqual([
			{ role: "user", content: "earlier" },
			{ role: "user", content: "now" },
		]);
	});

	it("handles a null state", () => {
		const out = mergeState(null, "hi");
		expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
	});
});

describe("runAgentStream", () => {
	it("maps fullStream parts to the AgentStreamUiEvent contract", async () => {
		const events: AgentStreamUiEvent[] = [];
		const model = mockModel([[
			{ type: "stream-start", warnings: [] },
			{ type: "reasoning-start", id: "r" },
			{ type: "reasoning-delta", id: "r", delta: "Think " },
			{ type: "reasoning-delta", id: "r", delta: "more." },
			{ type: "reasoning-end", id: "r" },
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: "Hello" },
			{ type: "text-delta", id: "t", delta: " world" },
			{ type: "text-end", id: "t" },
			{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
		]]);

		const result = await runAgentStream({
			model,
			system: "sys",
			tools: {},
			input: mergeState(null, "hi"),
			onUiEvent: (e) => events.push(e),
		});

		// reasoning_delta carries the cumulative text; text_delta carries increments
		expect(events.filter((e) => e.type === "reasoning_delta").map((e: any) => e.text)).toEqual([
			"Think ",
			"Think more.",
		]);
		expect(events.filter((e) => e.type === "text_delta").map((e: any) => e.text)).toEqual(["Hello", " world"]);
		expect(result.completed).toBe(true);
		// single message track: user turn + assistant response
		expect(result.lastState.messages?.[0]).toEqual({ role: "user", content: "hi" });
		const assistant = (result.lastState.messages || []).find((m: any) => messageKind(m) === "ai");
		expect(messageContent(assistant)).toBe("Hello world");
		expect(messageReasoning(assistant)).toBe("Think more.");
	});

	it("runs the tool loop, surfaces tool_call/tool_result + custom tool_ui bound to the toolCallId", async () => {
		const searchTool = defineTool(
			async (_args, ctx) => {
				ctx.emit({ __tool_type: "activity", category: "lookup", action: "search", label: "foo" });
				return "42";
			},
			{ name: "search_fulltext", description: "search the notes", schema: z.object({ query: z.string() }) },
		);
		const events: AgentStreamUiEvent[] = [];
		const model = mockModel([
			[
				{ type: "stream-start", warnings: [] },
				{ type: "tool-call", toolCallId: "call-1", toolName: "search_fulltext", input: JSON.stringify({ query: "foo" }) },
				{ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
			],
			[
				{ type: "stream-start", warnings: [] },
				{ type: "text-start", id: "t" },
				{ type: "text-delta", id: "t", delta: "The answer is 42" },
				{ type: "text-end", id: "t" },
				{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
			],
		]);

		const result = await runAgentStream({
			model,
			system: "sys",
			tools: toolSetFromArray([searchTool]),
			input: mergeState(null, "search foo"),
			onUiEvent: (e) => events.push(e),
		});

		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "tool_call_start", toolCallIndex: 0, toolCallId: "call-1", toolName: "search_fulltext" }),
				expect.objectContaining({ type: "tool_ui", event: expect.objectContaining({ toolCallId: "call-1", toolCallIndex: 0 }) }),
				expect.objectContaining({ type: "tool_result", toolCallId: "call-1", result: "42" }),
			]),
		);
		expect(result.lastState.toolUIEvents).toEqual([
			expect.objectContaining({ toolCallId: "call-1", toolCallIndex: 0, toolName: "search_fulltext" }),
		]);
		// the message track carries the tool turn (assistant tool-call + tool result + final text)
		const kinds = (result.lastState.messages || []).map((m: any) => messageKind(m));
		expect(kinds).toContain("tool");
		expect(kinds.filter((k: string) => k === "ai").length).toBeGreaterThanOrEqual(1);
	});

	it("intercepts write_todos emits into a todos_update event + lastState.todos", async () => {
		const todoTool = defineTool(
			async (_args, ctx) => {
				ctx.emit({ __tool_type: "write_todos", todos: { goal: "g", items: [{ content: "a", status: "pending" }], updatedAt: 1 } });
				return "ok";
			},
			{ name: "write_todos", description: "plan", schema: z.object({ goal: z.string() }) },
		);
		const events: AgentStreamUiEvent[] = [];
		const model = mockModel([
			[
				{ type: "stream-start", warnings: [] },
				{ type: "tool-call", toolCallId: "c", toolName: "write_todos", input: JSON.stringify({ goal: "g" }) },
				{ type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
			],
			[
				{ type: "stream-start", warnings: [] },
				{ type: "text-start", id: "t" },
				{ type: "text-delta", id: "t", delta: "planned" },
				{ type: "text-end", id: "t" },
				{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
			],
		]);

		const result = await runAgentStream({
			model,
			system: "sys",
			tools: toolSetFromArray([todoTool]),
			input: mergeState(null, "make a plan"),
			onUiEvent: (e) => events.push(e),
		});

		const todoEvent = events.find((e) => e.type === "todos_update") as any;
		expect(todoEvent?.todos?.goal).toBe("g");
		expect((result.lastState.todos as any)?.items).toHaveLength(1);
	});
});
