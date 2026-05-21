/**
 * ToolUIEvent → DOM rendering.
 *
 * Extracted from chat-panel.ts (the former applyToolUIEvent /
 * renderToolActivitySummary / appendToolResultToElement / finalizeToolElement /
 * buildToolSummaryHtml block). Pure with respect to the DOM it is handed: every
 * side effect that reaches back into ChatPanel state is injected through the
 * explicit `ToolEventRenderCtx` seam, so the module is standalone and
 * jsdom-testable.
 */

import { openTab } from "siyuan";
import type { ToolUIEvent } from "../types";
import type { Translator } from "../i18n";
import type { ActivityBlockRefs } from "./chat-helpers";
import {
	escapeHtml,
	getToolCategory,
	getToolAction,
	getToolDisplayTitle,
} from "./chat-helpers";

/**
 * The narrow seam the renderer needs back into ChatPanel.
 *
 * Only render-relevant capabilities are exposed — never the whole panel.
 *  - `i18n` / `buildToolSummaryHtml` / `localizeToolResult`: pure-ish text
 *    transforms.
 *  - `getActivityBlock` / `refreshActivityBlock`: NOT pure — they re-layout
 *    sibling activity-block DOM owned by ChatPanel's activity lifecycle, so the
 *    implementations stay in ChatPanel and are passed here as callbacks.
 *  - `documentOpen`: wraps the SiYuan `openTab` call so tests can observe link
 *    clicks without a real app.
 */
export interface ToolEventRenderCtx {
	i18n: Translator;
	buildToolSummaryHtml: (toolName: string, contentHtml?: string, category?: "lookup" | "change") => string;
	localizeToolResult: (result: string) => string;
	getActivityBlock: (el: HTMLElement | null) => ActivityBlockRefs | null;
	refreshActivityBlock: (block: ActivityBlockRefs) => void;
	documentOpen: (id: string) => void;
}

/** Default `documentOpen` used by ChatPanel: opens the doc in a SiYuan tab. */
export function openDocumentTab(id: string): void {
	openTab({ app: (globalThis as any).siyuanApp, doc: { id } });
}

/** Build the inner HTML for a tool card summary (prefix badge + title + content). */
export function buildToolSummaryHtml(
	toolName: string,
	i18n: Translator,
	contentHtml = "",
	category?: "lookup" | "change",
): string {
	const resolvedCategory = category || getToolCategory(toolName);
	const badge = resolvedCategory === "change"
		? i18n.t("chat.tool.badge.change")
		: i18n.t("chat.tool.badge.lookup");
	return `<span class="chat-msg__tool-prefix"><span class="chat-msg__tool-dot" aria-hidden="true"></span>${escapeHtml(badge)}</span><span class="chat-msg__tool-title">${escapeHtml(getToolDisplayTitle(toolName, i18n))}</span>${contentHtml}`;
}

/** Apply a single ToolUIEvent to a tool card element. */
export function applyToolUIEvent(
	toolEl: HTMLElement,
	event: ToolUIEvent,
	ctx: ToolEventRenderCtx,
): void {
	const details = toolEl.querySelector("details");
	if (!details) return;
	toolEl.dataset.hasEvents = "true";
	const category = getToolCategory(event.toolName || toolEl.dataset.toolName, event.payload);
	toolEl.dataset.toolCategory = category;
	toolEl.dataset.toolAction = getToolAction(event.toolName || toolEl.dataset.toolName, event.payload);

	if (event.payload.type === "activity") {
		renderToolActivitySummary(toolEl, details, event, event.payload, ctx);
		return;
	}

	if (event.payload.type === "created_document") {
		renderToolActivitySummary(toolEl, details, event, {
			type: "activity",
			category: "change",
			action: "create",
			id: event.payload.id,
			path: event.payload.path,
			label: event.payload.path,
			meta: ctx.i18n.t("chat.tool.createdDocument"),
			open: true,
		}, ctx);
		return;
	}

	if (event.payload.type === "document_link") {
		renderToolActivitySummary(toolEl, details, event, {
			type: "activity",
			category: "lookup",
			action: "read",
			id: event.payload.id,
			path: event.payload.path,
			label: event.payload.label,
			meta: ctx.i18n.t("chat.tool.readDocument"),
			open: event.payload.open,
		}, ctx);
		return;
	}

	if (event.payload.type === "document_blocks") {
		renderToolActivitySummary(toolEl, details, event, {
			type: "activity",
			category: "lookup",
			action: "read",
			id: event.payload.id,
			path: event.payload.path,
			label: event.payload.path,
			meta: ctx.i18n.t("chat.tool.readBlocks", { count: event.payload.blockCount }),
			open: event.payload.open,
		}, ctx);
		return;
	}

	if (event.payload.type === "append_block") {
		renderToolActivitySummary(toolEl, details, event, {
			type: "activity",
			category: "change",
			action: "append",
			id: event.payload.parentID,
			path: event.payload.path,
			label: event.payload.path,
			meta: ctx.i18n.t("chat.tool.appendedBlocks", { count: event.payload.blockIDs.length || 0 }),
			open: event.payload.open,
		}, ctx);
		return;
	}

	if (event.payload.type === "edit_blocks") {
		renderToolActivitySummary(toolEl, details, event, {
			type: "activity",
			category: "change",
			action: "edit",
			id: event.payload.primaryDocumentID || event.payload.documentIDs[0],
			path: event.payload.path,
			label: event.payload.path,
			meta: ctx.i18n.t("chat.tool.editedBlocks", { count: event.payload.editedCount }),
			open: event.payload.open,
		}, ctx);
		return;
	}

	const line = document.createElement("div");
	line.className = "chat-msg__tool-progress";
	line.textContent = event.payload.type === "text"
		? event.payload.text
		: event.payload.raw;
	details.appendChild(line);
}

/** Append a raw tool result string (skipped when the tool already has rich UI events). */
export function appendToolResultToElement(
	toolEl: HTMLElement,
	result: string,
	ctx: ToolEventRenderCtx,
): void {
	const details = toolEl.querySelector("details");
	if (!details) return;

	// Skip raw result if the tool already has rich UI events
	if (toolEl.dataset.hasEvents === "true") return;

	// Skip empty or whitespace-only results
	const trimmed = ctx.localizeToolResult(result);
	if (!trimmed) return;

	const pre = document.createElement("pre");
	pre.className = "chat-msg__tool-result";
	pre.textContent = trimmed.length > 500 ? trimmed.slice(0, 500) + "..." : trimmed;
	details.appendChild(pre);
}

/** Mark a tool card as done, collapse it, and refresh its activity block. */
export function finalizeToolElement(
	toolEl: HTMLElement,
	ctx: ToolEventRenderCtx,
): void {
	if (toolEl.dataset.toolStatus === "done")
		return;
	toolEl.dataset.toolStatus = "done";
	const details = toolEl.querySelector("details");
	if (details)
		details.open = false;
	const block = ctx.getActivityBlock(toolEl.parentElement?.closest(".chat-msg__activity-block") as HTMLElement | null);
	if (block)
		ctx.refreshActivityBlock(block);
}

function renderToolActivitySummary(
	toolEl: HTMLElement,
	details: HTMLDetailsElement,
	event: ToolUIEvent,
	options: { id?: string; path?: string; label?: string; meta?: string; open?: boolean; category?: "lookup" | "change"; action?: string },
	ctx: ToolEventRenderCtx,
): void {
	const summary = details.querySelector("summary");
	if (!summary) return;

	const docId = options.id || "";
	const docTitle = escapeHtml(options.label || options.path || docId || ctx.i18n.t("chat.tool.defaultDocument"));
	const meta = options.meta ? `<span class="chat-msg__doc-meta">${escapeHtml(options.meta)}</span>` : "";
	const canOpen = Boolean(docId) && options.open !== false;
	const contentHtml = docId
		? `<a class="${canOpen ? "chat-msg__doc-link chat-msg__doc-link--open" : "chat-msg__doc-link chat-msg__doc-link--muted"}" data-id="${escapeHtml(docId)}" href="javascript:void(0)">${docTitle}</a>${meta}`
		: `<span class="chat-msg__doc-label">${docTitle}</span>${meta}`;
	summary.innerHTML = ctx.buildToolSummaryHtml(
		event.toolName || toolEl.dataset.toolName || "tool",
		contentHtml,
		(options.category || toolEl.dataset.toolCategory as "lookup" | "change")
	);

	const link = summary.querySelector<HTMLElement>(".chat-msg__doc-link");
	if (link && canOpen && docId) {
		link.addEventListener("click", () => {
			ctx.documentOpen(docId);
		});
	} else if (link) {
		link.addEventListener("click", (e) => {
			e.preventDefault();
		});
	}

	const block = ctx.getActivityBlock(toolEl.closest(".chat-msg__activity-block") as HTMLElement | null);
	if (block)
		ctx.refreshActivityBlock(block);
}
