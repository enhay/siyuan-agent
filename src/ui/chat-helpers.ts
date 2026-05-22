/**
 * Pure helper functions and shared interfaces for chat-panel.
 * Extracted from chat-panel.ts for maintainability.
 */

import type { AgentState, ToolUIEventPayload } from "../types";
import type { ModelServiceConfig, McpServerConfig } from "../types";
import { defaultTranslator, type Translator } from "../i18n";
import { messageKind, messageContent } from "../core/message-shape";

/* ── Interfaces ──────────────────────────────────────────────────────── */

export interface AssistantMessageShell {
	el: HTMLElement;
	contentEl: HTMLElement;
	stackEl: HTMLElement;
}

export interface ActivityBlockRefs {
	el: HTMLElement;
	category: "lookup" | "change";
	currentEl: HTMLElement;
	archiveEl: HTMLDetailsElement;
	archiveListEl: HTMLElement;
}

export type SettingsSection = "general" | "model-services" | "default-models" | "mcp" | "session-sync";

export interface ComposerKeyEvent {
	key: string;
	shiftKey: boolean;
	isComposing?: boolean;
	keyCode?: number;
}

export interface SettingsDraft {
	customInstructions: string;
	guideDoc: { id: string; title: string } | null;
	defaultNotebook: { id: string; name: string } | null;
	modelServices: ModelServiceConfig[];
	defaultModelId: string;
	subAgentModelId: string;
	mcpServers: McpServerConfig[];
	notebookOptions: Array<{ id: string; name: string }>;
	sessionSync: import("../core/session-sync/config").SessionSyncConfig;
}

/* ── Pure functions ──────────────────────────────────────────────────── */

export function shouldSendComposerOnKeydown(e: ComposerKeyEvent): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	if (e.isComposing || e.keyCode === 229) return false;
	return true;
}

export function sessionTitle(state: AgentState): string {
	const msgs = state?.messages || [];
	const first = msgs.find((m: any) => {
		const t = messageKind(m);
		return t === "human" || t === "user";
	});
	if (!first) return "New Chat";
	const text = messageContent(first).replace(/^>.*\n\n/s, "").trim();
	return text.length > 30 ? text.slice(0, 30) + "..." : text;
}

export function escapeHtml(text: string): string {
	const map: Record<string, string> = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#039;",
	};
	return text.replace(/[&<>"']/g, (m) => map[m] || m);
}

/* ── Tool display helpers ────────────────────────────────────────────── */

export function getToolCategory(toolName?: string, payload?: ToolUIEventPayload): "lookup" | "change" {
	if (payload && "category" in payload) {
		return payload.category === "change" ? "change" : "lookup";
	}
	const changeTools = ["edit_blocks", "append_block", "create_document", "move_document", "rename_document", "delete_document", "toggle_todo", "create_scheduled_task", "update_scheduled_task", "delete_scheduled_task"];
	return changeTools.includes(toolName || "") ? "change" : "lookup";
}

export function getToolAction(toolName?: string, payload?: ToolUIEventPayload): string {
	if (payload && "action" in payload) return (payload as any).action;
	const map: Record<string, string> = {
		list_notebooks: "list",
		list_documents: "list",
		recent_documents: "list",
		get_document: "read",
		get_document_blocks: "read",
		get_document_outline: "read",
		read_block: "read",
		search_fulltext: "search",
		search_documents: "search",
		search_todos: "search",
		get_todo_stats: "search",
		explore_notes: "search",
		append_block: "append",
		edit_blocks: "edit",
		create_document: "create",
		move_document: "move",
		rename_document: "rename",
		delete_document: "delete",
		toggle_todo: "edit",
		create_scheduled_task: "create",
		list_scheduled_tasks: "list",
		update_scheduled_task: "edit",
		delete_scheduled_task: "delete",
	};
	return map[toolName || ""] || "other";
}

export function getToolDisplayTitle(toolName: string, i18n: Translator = defaultTranslator): string {
	return i18n.t(`chat.toolTitle.${toolName}`, undefined, toolName);
}

export function getActionLabel(action: string, i18n: Translator = defaultTranslator): string {
	return i18n.t(`chat.action.${action}`, undefined, action === "other" ? "" : action);
}
