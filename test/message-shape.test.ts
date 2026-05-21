import { describe, expect, it } from "vitest";
import {
	AIMessage,
	AIMessageChunk,
	HumanMessage,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import {
	messageKind,
	messageContent,
	messageReasoning,
	messageToolCallId,
	messageToolCalls,
	toolCallId,
	messageFromDict,
	messagesFromDict,
	genId,
	setMessageContent,
	setMessageToolCalls,
} from "../src/core/message-shape";

/* ── Wire-format builders ───────────────────────────────────────────────── */

/** lc:1 constructor dict. */
function lcDict(className: string, kwargs: Record<string, any>): Record<string, any> {
	return {
		lc: 1,
		type: "constructor",
		id: ["langchain_core", "messages", className],
		kwargs,
	};
}

/** {type:...} simplified dict. */
function plainDict(type: string, rest: Record<string, any> = {}): Record<string, any> {
	return { type, ...rest };
}

describe("messageKind", () => {
	it.each([
		["live HumanMessage", new HumanMessage({ content: "hi" }), "human"],
		["live AIMessage", new AIMessage({ content: "yo" }), "ai"],
		["live SystemMessage", new SystemMessage({ content: "sys" }), "system"],
		["live ToolMessage", new ToolMessage({ content: "r", tool_call_id: "t1" }), "tool"],
		["live AIMessageChunk → ai", new AIMessageChunk({ content: "c" }), "ai"],
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
	])("normalises %s", (_label, message, expected) => {
		expect(messageKind(message)).toBe(expected);
	});

	it("returns '' for unknown / nullish", () => {
		expect(messageKind(undefined)).toBe("");
		expect(messageKind(null)).toBe("");
		expect(messageKind({})).toBe("");
		expect(messageKind({ type: "weird" })).toBe("");
	});

	it("recognises SystemMessage across all three formats", () => {
		expect(messageKind(new SystemMessage({ content: "s" }))).toBe("system");
		expect(messageKind(lcDict("SystemMessage", { content: "s" }))).toBe("system");
		expect(messageKind(plainDict("system"))).toBe("system");
	});
});

describe("messageContent", () => {
	it.each([
		["live", new AIMessage({ content: "hello" })],
		["lc", lcDict("AIMessage", { content: "hello" })],
		["plain", plainDict("ai", { content: "hello" })],
	])("reads string content from %s", (_label, message) => {
		expect(messageContent(message)).toBe("hello");
	});

	it("returns '' for non-string content (array)", () => {
		expect(messageContent({ content: [{ type: "text", text: "x" }] })).toBe("");
		expect(messageContent(lcDict("AIMessage", { content: [{ type: "text" }] }))).toBe("");
	});

	it("returns '' for missing content / nullish message", () => {
		expect(messageContent({})).toBe("");
		expect(messageContent(undefined)).toBe("");
		expect(messageContent(null)).toBe("");
	});

	it("contract: empty content → '' (not null)", () => {
		const result = messageContent(new AIMessage({ content: "" }));
		expect(result).toBe("");
		expect(result).not.toBeNull();
	});
});

describe("messageReasoning", () => {
	it("reads additional_kwargs.reasoning_content (live / stream path)", () => {
		const msg = new AIMessage({
			content: "answer",
			additional_kwargs: { reasoning_content: "thinking..." },
		});
		expect(messageReasoning(msg)).toBe("thinking...");
	});

	it("reads kwargs.additional_kwargs.reasoning_content (lc dict path)", () => {
		const msg = lcDict("AIMessage", {
			content: "answer",
			additional_kwargs: { reasoning_content: "lc-think" },
		});
		expect(messageReasoning(msg)).toBe("lc-think");
	});

	it("reads kwargs.lc_kwargs.additional_kwargs.reasoning_content (persisted render path)", () => {
		const msg = {
			kwargs: { lc_kwargs: { additional_kwargs: { reasoning_content: "persisted-1" } } },
		};
		expect(messageReasoning(msg)).toBe("persisted-1");
	});

	it("reads lc_kwargs.additional_kwargs.reasoning_content (persisted render path)", () => {
		const msg = {
			lc_kwargs: { additional_kwargs: { reasoning_content: "persisted-2" } },
		};
		expect(messageReasoning(msg)).toBe("persisted-2");
	});

	it("returns '' when no reasoning present", () => {
		expect(messageReasoning(new AIMessage({ content: "x" }))).toBe("");
		expect(messageReasoning({})).toBe("");
		expect(messageReasoning(undefined)).toBe("");
	});
});

describe("messageToolCallId", () => {
	it.each([
		["live", new ToolMessage({ content: "r", tool_call_id: "call_1" })],
		["lc", lcDict("ToolMessage", { content: "r", tool_call_id: "call_1" })],
		["plain", plainDict("tool", { tool_call_id: "call_1" })],
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
		["live", new AIMessage({ content: "", tool_calls: calls as any })],
		["lc", lcDict("AIMessage", { content: "", tool_calls: calls })],
		["plain", plainDict("ai", { tool_calls: calls })],
	])("reads tool_calls array from %s", (_label, message) => {
		expect(messageToolCalls(message)).toHaveLength(1);
		expect(messageToolCalls(message)[0].name).toBe("tool_a");
	});

	it("returns [] when absent or non-array", () => {
		expect(messageToolCalls({})).toEqual([]);
		expect(messageToolCalls({ tool_calls: "nope" })).toEqual([]);
		expect(messageToolCalls(undefined)).toEqual([]);
	});
});

describe("toolCallId", () => {
	it("reads id then tool_call_id", () => {
		expect(toolCallId({ id: "x" })).toBe("x");
		expect(toolCallId({ tool_call_id: "y" })).toBe("y");
		expect(toolCallId({ id: "x", tool_call_id: "y" })).toBe("x");
	});

	it("returns '' when absent or non-string", () => {
		expect(toolCallId({})).toBe("");
		expect(toolCallId({ id: 5 })).toBe("");
		expect(toolCallId(undefined)).toBe("");
	});
});

describe("messageFromDict / messagesFromDict", () => {
	it("deserialises lc:1 constructor dicts to live instances", () => {
		expect(messageKind(messageFromDict(lcDict("HumanMessage", { content: "h" })))).toBe("human");
		expect(messageKind(messageFromDict(lcDict("AIMessage", { content: "a" })))).toBe("ai");
		expect(messageKind(messageFromDict(lcDict("AIMessageChunk", { content: "a" })))).toBe("ai");
		expect(messageKind(messageFromDict(lcDict("SystemMessage", { content: "s" })))).toBe("system");
		expect(messageKind(messageFromDict(lcDict("ToolMessage", { content: "t", tool_call_id: "x" })))).toBe("tool");
	});

	it("deserialises simplified {type} dicts", () => {
		expect(messageKind(messageFromDict(plainDict("human", { content: "h" })))).toBe("human");
		expect(messageKind(messageFromDict(plainDict("user", { content: "h" })))).toBe("human");
		expect(messageKind(messageFromDict(plainDict("ai", { content: "a" })))).toBe("ai");
		expect(messageKind(messageFromDict(plainDict("assistant", { content: "a" })))).toBe("ai");
		expect(messageKind(messageFromDict(plainDict("system", { content: "s" })))).toBe("system");
		expect(messageKind(messageFromDict(plainDict("tool", { tool_call_id: "x" })))).toBe("tool");
	});

	it("defaults missing ToolMessage tool_call_id to ''", () => {
		const msg = messageFromDict(lcDict("ToolMessage", { content: "r" }));
		expect(messageToolCallId(msg)).toBe("");
	});

	it("throws on unknown class / type", () => {
		expect(() => messageFromDict(lcDict("MysteryMessage", {}))).toThrow();
		expect(() => messageFromDict(plainDict("mystery"))).toThrow();
	});

	it("messagesFromDict maps a list", () => {
		const out = messagesFromDict([
			lcDict("HumanMessage", { content: "h" }),
			plainDict("ai", { content: "a" }),
		]);
		expect(out).toHaveLength(2);
		expect(messageKind(out[0])).toBe("human");
		expect(messageKind(out[1])).toBe("ai");
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

describe("writers: setMessageContent / setMessageToolCalls", () => {
	it("writes content into kwargs when present", () => {
		const raw: Record<string, any> = { kwargs: { content: "old" } };
		setMessageContent(raw, "new");
		expect(raw.kwargs.content).toBe("new");
	});

	it("writes content at top level when no kwargs", () => {
		const raw: Record<string, any> = { content: "old" };
		setMessageContent(raw, "new");
		expect(raw.content).toBe("new");
	});

	it("writes tool_calls into kwargs for lc:1 dicts", () => {
		const raw: Record<string, any> = { lc: 1, kwargs: {} };
		setMessageToolCalls(raw, [{ id: "a" }]);
		expect(raw.kwargs.tool_calls).toEqual([{ id: "a" }]);
	});

	it("writes tool_calls at top level for plain dicts", () => {
		const raw: Record<string, any> = {};
		setMessageToolCalls(raw, [{ id: "b" }]);
		expect(raw.tool_calls).toEqual([{ id: "b" }]);
	});
});
