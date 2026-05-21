/**
 * agent-types — project-facing aliases for the framework-bound agent types.
 *
 * The rest of the codebase names `AgentTool` / `AgentModel`, never the raw
 * LangChain interfaces. A framework swap (e.g. to AI SDK) re-points these two
 * aliases here instead of editing every call site.
 */

import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/** A tool the agent can call. LangChain-bound; swap re-points this alias. */
export type AgentTool = StructuredToolInterface;

/** A chat model the agent runs on. LangChain-bound; swap re-points this alias. */
export type AgentModel = BaseChatModel;
