import { describe, expect, it } from "vitest";
import { runtimeToEmitContext } from "../src/core/tools/define-tool";
import { emitActivity, emitToolEvent } from "../src/core/tools/siyuan-api";

describe("runtimeToEmitContext", () => {
	it("canEmit is false and emit is a no-op when no writer is attached", () => {
		const ctx = runtimeToEmitContext({});
		expect(ctx.canEmit).toBe(false);
		// Must not throw — tools invoked without a UI consumer (e.g. bare .invoke())
		// rely on this silent no-op.
		expect(() => ctx.emit({ __tool_type: "activity" })).not.toThrow();
	});

	it("canEmit is true and emit writes the exact JSON with the tool-call id appended last", () => {
		const writes: unknown[] = [];
		const ctx = runtimeToEmitContext({ writer: (c) => writes.push(c), toolCallId: "tc-1" });
		expect(ctx.canEmit).toBe(true);

		ctx.emit({ __tool_type: "write_todos", todos: { goal: "g" } });

		expect(writes).toEqual([
			JSON.stringify({ __tool_type: "write_todos", todos: { goal: "g" }, toolCallId: "tc-1" }),
		]);
	});
});

describe("emit helpers produce the byte-identical writer payload", () => {
	function captureCtx(toolCallId: string) {
		const writes: string[] = [];
		const ctx = runtimeToEmitContext({ writer: (c) => writes.push(c as string), toolCallId });
		return { ctx, writes };
	}

	it("emitActivity wraps the payload under __tool_type:activity and appends toolCallId", () => {
		const { ctx, writes } = captureCtx("tc-2");
		emitActivity(ctx, { category: "lookup", action: "read", id: "x", label: "L" });
		expect(writes[0]).toBe(
			JSON.stringify({
				__tool_type: "activity",
				category: "lookup",
				action: "read",
				id: "x",
				label: "L",
				toolCallId: "tc-2",
			}),
		);
	});

	it("emitToolEvent passes the payload through verbatim with toolCallId appended", () => {
		const { ctx, writes } = captureCtx("tc-3");
		emitToolEvent(ctx, { __tool_type: "edit_blocks", results: [] });
		expect(writes[0]).toBe(
			JSON.stringify({ __tool_type: "edit_blocks", results: [], toolCallId: "tc-3" }),
		);
	});
});
