import { describe, expect, it } from "vitest";
import { emitContextFrom } from "../src/core/tools/define-tool";
import { emitActivity, emitToolEvent } from "../src/core/tools/siyuan-api";

describe("emitContextFrom", () => {
	it("canEmit is false and emit is a no-op when no sink is attached", () => {
		const ctx = emitContextFrom(undefined, "tc-1");
		expect(ctx.canEmit).toBe(false);
		// Must not throw — tools run without a UI consumer rely on this silent no-op.
		expect(() => ctx.emit({ __tool_type: "activity" })).not.toThrow();
	});

	it("canEmit is true and emit curries the tool-call id into the sink", () => {
		const calls: Array<[string, any]> = [];
		const ctx = emitContextFrom({ emit: (id, p) => calls.push([id, p]) }, "tc-1");
		expect(ctx.canEmit).toBe(true);

		ctx.emit({ __tool_type: "write_todos", todos: { goal: "g" } });

		expect(calls).toEqual([["tc-1", { __tool_type: "write_todos", todos: { goal: "g" } }]]);
	});
});

describe("emit helpers route through ctx.emit (toolCallId curried by the context)", () => {
	function captureCtx(toolCallId: string) {
		const calls: Array<[string, any]> = [];
		const ctx = emitContextFrom({ emit: (id, p) => calls.push([id, p]) }, toolCallId);
		return { ctx, calls };
	}

	it("emitActivity wraps the payload under __tool_type:activity", () => {
		const { ctx, calls } = captureCtx("tc-2");
		emitActivity(ctx, { category: "lookup", action: "read", id: "x", label: "L" });
		expect(calls[0]).toEqual([
			"tc-2",
			{ __tool_type: "activity", category: "lookup", action: "read", id: "x", label: "L" },
		]);
	});

	it("emitToolEvent passes the payload through verbatim", () => {
		const { ctx, calls } = captureCtx("tc-3");
		emitToolEvent(ctx, { __tool_type: "edit_blocks", results: [] });
		expect(calls[0]).toEqual(["tc-3", { __tool_type: "edit_blocks", results: [] }]);
	});
});
