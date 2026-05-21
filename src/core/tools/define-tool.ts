/**
 * define-tool — the single adapter between project tool handlers and the
 * agent framework's tool runtime.
 *
 * A tool handler is a pure `(args, ctx) => Promise<string>` that never names a
 * framework type. `defineTool` wraps it with LangChain's `tool()` and maps the
 * `ToolRuntime` into a framework-agnostic `ToolEmitContext`. A framework swap
 * rewrites this one file, not the ~20 tools.
 *
 * The call shape mirrors `tool(handler, config)` so the handler keeps its
 * Zod-inferred `args` type via the same deferred inference LangChain relies on.
 */

import { tool, type ToolRuntime } from "@langchain/core/tools";
import type { z } from "zod";
import type { AgentTool } from "../agent-types";

/**
 * What a tool handler may do with the surrounding run, framework-agnostic.
 *
 * - `emit(payload)` — push a structured UI event to the stream. The current
 *   tool-call id is attached automatically. No-op when nobody is listening.
 * - `canEmit` — whether a UI consumer is attached. Use it to skip work that
 *   only exists to produce a UI event (e.g. an extra lookup for a card label).
 */
export interface ToolEmitContext {
	emit(payload: Record<string, unknown>): void;
	canEmit: boolean;
}

export interface DefineToolConfig<TSchema extends z.ZodTypeAny> {
	name: string;
	description: string;
	schema: TSchema;
}

/**
 * Map a tool runtime to a framework-agnostic ToolEmitContext. The only place
 * the writer wire-format lives — kept exported so it can be tested directly
 * without standing up a LangChain stream.
 */
export function runtimeToEmitContext(
	runtime: { writer?: (chunk: unknown) => void; toolCallId?: string },
): ToolEmitContext {
	return {
		canEmit: !!runtime.writer,
		emit: (payload) =>
			runtime.writer?.(JSON.stringify({ ...payload, toolCallId: runtime.toolCallId })),
	};
}

/** Wrap a pure handler as an agent tool, mapping the runtime to ToolEmitContext. */
export function defineTool<TSchema extends z.ZodTypeAny>(
	handler: (args: z.infer<TSchema>, ctx: ToolEmitContext) => Promise<string> | string,
	config: DefineToolConfig<TSchema>,
): AgentTool {
	return tool(
		async (args: z.infer<TSchema>, runtime: ToolRuntime) =>
			handler(args, runtimeToEmitContext(runtime)),
		{
			name: config.name,
			description: config.description,
			schema: config.schema,
		},
	);
}
