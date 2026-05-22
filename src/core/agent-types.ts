/**
 * agent-types — project-facing aliases for the framework-bound agent types.
 *
 * The rest of the codebase names `AgentTool` / `AgentModel`, never the raw
 * framework interfaces. The LangChain→AI SDK swap re-points these aliases here
 * instead of editing every call site (Wave 0 of the v6 migration).
 */

import type { LanguageModel, Tool, ToolSet } from "ai";

/**
 * A single tool the agent can call. AI SDK-bound.
 *
 * GOTCHA (vs LangChain): an AI SDK `Tool` carries **no name** — the name is the
 * key in the {@link AgentToolSet} record passed to `streamText`/`Agent`. So
 * `defineTool` must return a named wrapper (or the toolset must be assembled
 * from a name→tool map) for the agent to address tools by name.
 */
export type AgentTool = Tool<any, any>;

/** The keyed tool collection handed to `streamText`/`Agent` (name → tool). */
export type AgentToolSet = ToolSet;

/** A chat model the agent runs on. AI SDK-bound (string id | LanguageModelV2/V3). */
export type AgentModel = LanguageModel;
