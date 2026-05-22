/**
 * define-tool — the single adapter between project tool handlers and the
 * agent framework's tool runtime.
 *
 * A tool handler is a pure `(args, ctx) => Promise<string>` that never names a
 * framework type. `defineTool` wraps it with the AI SDK's `tool()` and maps the
 * call's `experimental_context` + `toolCallId` into a framework-agnostic
 * `ToolEmitContext`. A framework swap rewrites this one file, not the ~20 tools.
 *
 * The call shape stays `defineTool(handler, config)` so the handler keeps its
 * Zod-inferred `args` type via the same deferred inference the SDK relies on.
 */

import { tool } from "ai";
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

/** The emit sink the stream runtime (Wave 2) installs on `experimental_context`. */
interface ToolEventSink {
	emit?: (toolCallId: string, payload: Record<string, unknown>) => void;
}

/**
 * Map the AI SDK call context to a framework-agnostic ToolEmitContext. The only
 * place the writer wiring lives — kept exported so it can be tested directly
 * without standing up a stream.
 *
 * The runtime sets `experimental_context = { emit(toolCallId, payload) }`; here
 * we curry the `toolCallId` so handlers still call `ctx.emit(payload)`.
 */
export function emitContextFrom(
	experimentalContext: ToolEventSink | undefined,
	toolCallId: string,
): ToolEmitContext {
	const sink = experimentalContext?.emit;
	return {
		canEmit: typeof sink === "function",
		emit: (payload) => sink?.(toolCallId, payload),
	};
}

/** Wrap a pure handler as an agent tool, mapping the call context to ToolEmitContext. */
export function defineTool<TSchema extends z.ZodTypeAny>(
	handler: (args: z.infer<TSchema>, ctx: ToolEmitContext) => Promise<string> | string,
	config: DefineToolConfig<TSchema>,
): AgentTool {
	const t = tool({
		description: config.description,
		inputSchema: config.schema,
		execute: async (args: z.infer<TSchema>, { toolCallId, experimental_context }) =>
			handler(args, emitContextFrom(experimental_context as ToolEventSink | undefined, toolCallId)),
	});
	// AI SDK tools carry no name — the name is the key in the ToolSet record
	// passed to streamText/Agent (see `AgentToolSet` in agent-types.ts). Stash it
	// so Wave 2 can build the record via
	//   Object.fromEntries(tools.map(t => [t.__toolName, t]))
	// and so sub-agent.ts can keep filtering tools by name (`__toolName`).
	(t as AgentTool & { __toolName: string }).__toolName = config.name;
	return t as AgentTool;
}
