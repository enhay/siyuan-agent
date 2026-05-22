import { describe, expect, it } from "vitest";
import {
	messageKind,
	messageContent,
	messageReasoning,
	messageToolCallId,
	messageToolCalls,
	toolCallId,
	toModelMessages,
	genId,
	setMessageContent,
	setMessageToolCalls,
} from "../src/core/message-shape";

/* ── Wire-format builders ───────────────────────────────────────────────── */

/** lc:1 constructor dict (the messagesUi track). */
function lcDict(className: string, kwargs: Record<string, any>): Record<string, any> {
	return { lc: 1, type: "constructor", id: ["langchain_core", "messages", className], kwargs };
}

/** {type:...} simplified dict. */
function plainDict(type: string, rest: Record<string, any> = {}): Record<string, any> {
	return { type, ...rest };
}

describe("messageKind", () => {
	it.each([
		["lc HumanMessage", lcDict("HumanMessage", { content: "hi" }), "human"],
		["lc AIMessage", lcDict("AIMessage", { content: "y" }), "ai"],
		["lc AIMessageChunk → ai", lcDict("AIMessageChunk", { content: "y" }), "ai"],
		["lc SystemMessage", lcDict("SystemMessage", { content: "s" }), "system"],
		["lc ToolMessage", lcDict("ToolMessage", { content: "r", tool_call_id: "t" }), "tool"],
		["plain human", plainDict("human"), "human"],
		["plain user → human", plainDict("user"), "human"],
		["plain ai", plainDict("ai"), "ai"],
		["plain assistant → ai", plainDict("assistant"), "ai"],
		["plain system", plainDict("system"), "system"],
		["plain tool", plainDict("tool"), "tool"],
		["ModelMessage user → human", { role: "user", content: "hi" }, "human"],
		["ModelMessage assistant → ai", { role: "assistant", content: [{ type: "text", text: "a" }] }, "ai"],
		["ModelMessage tool", { role: "tool", content: [] }, "tool"],
	])("normalises %s", (_label, message, expected) => {
		expect(messageKind(message)).toBe(expected);
	});

	it("returns '' for unknown / nullish", () => {
		expect(messageKind(undefined)).toBe("");
		expect(messageKind(null)).toBe("");
		expect(messageKind({})).toBe("");
		expect(messageKind({ type: "weird" })).toBe("");
	});
});

describe("messageContent", () => {
	it.each([
		["lc", lcDict("AIMessage", { content: "hello" })],
		["plain", plainDict("ai", { content: "hello" })],
		["ModelMessage string", { role: "user", content: "hello" }],
	])("reads string content from %s", (_label, message) => {
		expect(messageContent(message)).toBe("hello");
	});

	it("joins text parts of a ModelMessage", () => {
		expect(messageContent({ role: "assistant", content: [{ type: "text", text: "he" }, { type: "text", text: "llo" }] })).toBe("hello");
		// non-text parts are ignored
		expect(messageContent({ content: [{ type: "tool-call" }, { type: "text", text: "x" }] })).toBe("x");
	});

	it("returns '' for missing content / nullish message", () => {
		expect(messageContent({})).toBe("");
		expect(messageContent(undefined)).toBe("");
		expect(messageContent(null)).toBe("");
	});
});

describe("messageReasoning", () => {
	it("reads kwargs.additional_kwargs.reasoning_content (lc dict path)", () => {
		const msg = lcDict("AIMessage", { content: "answer", additional_kwargs: { reasoning_content: "lc-think" } });
		expect(messageReasoning(msg)).toBe("lc-think");
	});

	it("reads additional_kwargs.reasoning_content (stream path)", () => {
		expect(messageReasoning({ additional_kwargs: { reasoning_content: "t" } })).toBe("t");
	});

	it("reads lc_kwargs.additional_kwargs.reasoning_content (persisted render path)", () => {
		expect(messageReasoning({ lc_kwargs: { additional_kwargs: { reasoning_content: "persisted-2" } } })).toBe("persisted-2");
	});

	it("reads a ModelMessage reasoning content part", () => {
		expect(messageReasoning({ role: "assistant", content: [{ type: "reasoning", text: "deep" }, { type: "text", text: "a" }] })).toBe("deep");
	});

	it("returns '' when no reasoning present", () => {
		expect(messageReasoning({})).toBe("");
		expect(messageReasoning(undefined)).toBe("");
	});
});

describe("messageToolCallId", () => {
	it.each([
		["lc", lcDict("ToolMessage", { content: "r", tool_call_id: "call_1" })],
		["plain", plainDict("tool", { tool_call_id: "call_1" })],
		["ModelMessage tool-result part", { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1" }] }],
	])("reads tool_call_id from %s", (_label, message) => {
		expect(messageToolCallId(message)).toBe("call_1");
	});

	it("returns '' when absent", () => {
		expect(messageToolCallId({})).toBe("");
		expect(messageToolCallId(undefined)).toBe("");
	});
});

describe("messageToolCalls", () => {
	const calls = [{ id: "a", name: "tool_a", args: {} }];

	it.each([
		["lc", lcDict("AIMessage", { content: "", tool_calls: calls })],
		["plain", plainDict("ai", { tool_calls: calls })],
	])("reads tool_calls array from %s", (_label, message) => {
		expect(messageToolCalls(message)).toHaveLength(1);
		expect(messageToolCalls(message)[0].name).toBe("tool_a");
	});

	it("reads tool-call content parts of a ModelMessage as {id,name,args}", () => {
		const msg = { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "tool_a", input: { q: 1 } }] };
		const out = messageToolCalls(msg);
		expect(out).toHaveLength(1);
		expect(out[0]).toEqual({ id: "a", name: "tool_a", args: { q: 1 } });
	});

	it("returns [] when absent or non-array", () => {
		expect(messageToolCalls({})).toEqual([]);
		expect(messageToolCalls({ tool_calls: "nope" })).toEqual([]);
		expect(messageToolCalls(undefined)).toEqual([]);
	});
});

describe("toolCallId", () => {
	it("reads id then tool_call_id then toolCallId", () => {
		expect(toolCallId({ id: "x" })).toBe("x");
		expect(toolCallId({ tool_call_id: "y" })).toBe("y");
		expect(toolCallId({ toolCallId: "z" })).toBe("z");
		expect(toolCallId({ id: "x", tool_call_id: "y" })).toBe("x");
	});

	it("returns '' when absent or non-string", () => {
		expect(toolCallId({})).toBe("");
		expect(toolCallId({ id: 5 })).toBe("");
		expect(toolCallId(undefined)).toBe("");
	});
});

describe("toModelMessages", () => {
	it("passes through ModelMessages unchanged", () => {
		const mm = [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "yo" }] }];
		expect(toModelMessages(mm)).toEqual(mm);
	});

	it("converts lc:1 dicts to ModelMessages", () => {
		const out = toModelMessages([
			lcDict("HumanMessage", { content: "hi" }),
			lcDict("AIMessage", {
				content: "answer",
				tool_calls: [{ id: "c1", name: "search", args: { q: 1 } }],
				additional_kwargs: { reasoning_content: "think" },
			}),
			lcDict("ToolMessage", { content: "result", tool_call_id: "c1" }),
		]);
		expect(out[0]).toEqual({ role: "user", content: "hi" });
		expect(out[1].role).toBe("assistant");
		expect(out[1].content).toEqual([
			{ type: "reasoning", text: "think" },
			{ type: "text", text: "answer" },
			{ type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: 1 } },
		]);
		expect(out[2].role).toBe("tool");
		expect((out[2].content as any)[0]).toMatchObject({ type: "tool-result", toolCallId: "c1" });
	});
});

describe("genId", () => {
	it("produces unique non-empty short ids", () => {
		const a = genId();
		const b = genId();
		expect(a).toBeTruthy();
		expect(typeof a).toBe("string");
		expect(a).not.toBe(b);
	});
});

describe("setMessageContent / setMessageToolCalls", () => {
	it("writes content into lc:1 kwargs", () => {
		const m = lcDict("AIMessage", { content: "old" });
		setMessageContent(m, "new");
		expect(m.kwargs.content).toBe("new");
	});

	it("writes tool_calls into lc:1 kwargs", () => {
		const m = lcDict("AIMessage", { content: "x" });
		setMessageToolCalls(m, [{ id: "a", name: "t", args: {} }]);
		expect(m.kwargs.tool_calls).toHaveLength(1);
	});
});
