import { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { createSubAgentTool } from "../sub-agent";
import type { AgentConfig } from "../../types";
import type { ScheduledTaskManager } from "../scheduled-task-manager";
import { defaultTranslator, type Translator } from "../../i18n";

import { createListNotebooksTool, createListDocumentsTool, createRecentDocumentsTool } from "./notebook-tools";
import { createGetDocumentTool, createGetDocumentBlocksTool, createGetDocumentOutlineTool, createReadBlockTool, createSearchFulltextTool, createSearchDocumentsTool } from "./document-tools";
import { createEditBlocksTool, createAppendBlockTool, createCreateDocumentTool, createMoveDocumentTool, createRenameDocumentTool, createDeleteDocumentTool } from "./edit-tools";
import { writeTodosTool } from "./plan-tools";
import { createScheduledTaskTools } from "./scheduled-tools";

export { createDeleteDocumentTool } from "./edit-tools";
export { siyuanFetch, emitToolEvent, emitActivity } from "./siyuan-api";

export function getLookupTools(): StructuredToolInterface[] {
	return createLookupTools(defaultTranslator);
}

function createLookupTools(i18n: Translator): StructuredToolInterface[] {
	return [
		createListNotebooksTool(i18n),
		createListDocumentsTool(i18n),
		createRecentDocumentsTool(i18n),
		createGetDocumentTool(i18n),
		createGetDocumentBlocksTool(i18n),
		createGetDocumentOutlineTool(i18n),
		createReadBlockTool(i18n),
		createSearchFulltextTool(i18n),
		createSearchDocumentsTool(i18n),
	];
}

function createExploreNotesTool(
	getAgentConfig: () => AgentConfig | Promise<AgentConfig>,
	i18n: Translator,
): StructuredToolInterface {
	return createSubAgentTool({
		name: "explore_notes",
		description: i18n.t("tool.explore.description"),
		schema: z.object({
			query: z.string().describe(i18n.t("tool.explore.query")),
		}),
		toolset: () => createLookupTools(i18n),
		systemPrompt: i18n.t("tool.explore.systemPrompt"),
		getAgentConfig,
		i18n,
		recursionLimit: 12,
	});
}

export interface DefaultToolsOptions {
	/** Register delete_document. Off by default: it deletes a whole subtree and
	 * is not undoable in-app, so only the interactive chat (where the agent can
	 * confirm with the user) opts in. The autonomous scheduled-task toolset
	 * leaves it out — no user is present to confirm a deletion. */
	includeDeleteDocument?: boolean;
}

export function getDefaultTools(
	getAgentConfig: () => AgentConfig | Promise<AgentConfig>,
	getTaskManager: () => ScheduledTaskManager | null = () => null,
	i18n: Translator = defaultTranslator,
	opts: DefaultToolsOptions = {},
): StructuredToolInterface[] {
	const scheduledTaskTools = createScheduledTaskTools(getTaskManager, i18n);
	const defaultTools: StructuredToolInterface[] = [
		createListNotebooksTool(i18n),
		createListDocumentsTool(i18n),
		createRecentDocumentsTool(i18n),
		createGetDocumentTool(i18n),
		createGetDocumentBlocksTool(i18n),
		createGetDocumentOutlineTool(i18n),
		createReadBlockTool(i18n),
		createSearchFulltextTool(i18n),
		createExploreNotesTool(getAgentConfig, i18n),
		createAppendBlockTool(i18n),
		createEditBlocksTool(i18n),
		createCreateDocumentTool(i18n),
		createMoveDocumentTool(i18n),
		createRenameDocumentTool(i18n),
		createSearchDocumentsTool(i18n),
		writeTodosTool,
		scheduledTaskTools.createScheduledTaskTool,
		scheduledTaskTools.listScheduledTasksTool,
		scheduledTaskTools.updateScheduledTaskTool,
		scheduledTaskTools.deleteScheduledTaskTool,
	];
	if (opts.includeDeleteDocument) {
		defaultTools.push(createDeleteDocumentTool(i18n));
	}
	return defaultTools;
}
