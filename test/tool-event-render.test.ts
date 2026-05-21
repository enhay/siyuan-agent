// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	applyToolUIEvent,
	appendToolResultToElement,
	finalizeToolElement,
	buildToolSummaryHtml,
	openDocumentTab,
	type ToolEventRenderCtx,
} from "../src/ui/tool-event-render";
import { defaultTranslator } from "../src/i18n";
import type { ToolUIEvent, ToolUIEventPayload } from "../src/types";

/* ── Test scaffolding ─────────────────────────────────────────────────── */

/** Build a minimal tool card element, matching ChatPanel.createToolCallElement output. */
function makeToolCard(opts: { toolName?: string; toolCallIndex?: number; toolCallId?: string } = {}): HTMLElement {
	const el = document.createElement("div");
	el.className = "chat-msg__tool";
	if (opts.toolName) el.dataset.toolName = opts.toolName;
	if (typeof opts.toolCallIndex === "number") el.dataset.toolCallIndex = String(opts.toolCallIndex);
	if (opts.toolCallId) el.dataset.toolCallId = opts.toolCallId;
	const details = document.createElement("details");
	details.open = true;
	const summary = document.createElement("summary");
	details.appendChild(summary);
	el.appendChild(details);
	return el;
}

function makeEvent(payload: ToolUIEventPayload, overrides: Partial<ToolUIEvent> = {}): ToolUIEvent {
	return {
		id: "evt-1",
		source: "writer",
		toolCallIndex: 0,
		toolName: "get_document",
		payload,
		...overrides,
	};
}

function makeCtx(overrides: Partial<ToolEventRenderCtx> = {}): ToolEventRenderCtx {
	return {
		i18n: defaultTranslator,
		buildToolSummaryHtml: (toolName, contentHtml, category) =>
			buildToolSummaryHtml(toolName, defaultTranslator, contentHtml, category),
		localizeToolResult: (result) => result?.trim?.() || "",
		getActivityBlock: () => null,
		refreshActivityBlock: vi.fn(),
		documentOpen: vi.fn(),
		...overrides,
	};
}

describe("buildToolSummaryHtml", () => {
	it("renders lookup badge + title + content", () => {
		const html = buildToolSummaryHtml("get_document", defaultTranslator, "<span>x</span>");
		expect(html).toContain("chat-msg__tool-prefix");
		expect(html).toContain("chat-msg__tool-dot");
		expect(html).toContain("Lookup");
		expect(html).toContain("chat-msg__tool-title");
		expect(html).toContain("<span>x</span>");
	});

	it("uses the change badge for change tools", () => {
		const html = buildToolSummaryHtml("edit_blocks", defaultTranslator);
		expect(html).toContain("Change");
	});

	it("respects an explicit category override over the tool name default", () => {
		const html = buildToolSummaryHtml("get_document", defaultTranslator, "", "change");
		expect(html).toContain("Change");
	});

	it("escapes the resolved title", () => {
		const html = buildToolSummaryHtml("<script>", defaultTranslator);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});
});

describe("applyToolUIEvent — dataset bookkeeping", () => {
	it("marks the element as having events and stamps category/action", () => {
		const el = makeToolCard({ toolName: "edit_blocks" });
		const event = makeEvent(
			{ type: "edit_blocks", documentIDs: ["d1"], primaryDocumentID: "d1", path: "/a", editedCount: 2 },
			{ toolName: "edit_blocks" },
		);
		applyToolUIEvent(el, event, makeCtx());
		expect(el.dataset.hasEvents).toBe("true");
		expect(el.dataset.toolCategory).toBe("change");
		expect(el.dataset.toolAction).toBe("edit");
	});

	it("no-ops when the card has no <details>", () => {
		const el = document.createElement("div");
		expect(() => applyToolUIEvent(el, makeEvent({ type: "activity", category: "lookup", action: "read", id: "x" }), makeCtx())).not.toThrow();
	});
});

describe("applyToolUIEvent — payload variants", () => {
	it("activity: renders an openable doc link with meta", () => {
		const el = makeToolCard({ toolName: "get_document" });
		const event = makeEvent({
			type: "activity",
			category: "lookup",
			action: "read",
			id: "doc-123",
			path: "/notes/a",
			label: "Note A",
			meta: "extra",
			open: true,
		});
		applyToolUIEvent(el, event, makeCtx());
		const link = el.querySelector("a.chat-msg__doc-link");
		expect(link).not.toBeNull();
		expect(link!.classList.contains("chat-msg__doc-link--open")).toBe(true);
		expect(link!.getAttribute("data-id")).toBe("doc-123");
		expect(link!.textContent).toBe("Note A");
		expect(el.querySelector(".chat-msg__doc-meta")!.textContent).toBe("extra");
	});

	it("activity: open=false yields a muted, non-opening link", () => {
		const el = makeToolCard({ toolName: "get_document" });
		const documentOpen = vi.fn();
		const event = makeEvent({ type: "activity", category: "lookup", action: "read", id: "doc-9", open: false });
		applyToolUIEvent(el, event, makeCtx({ documentOpen }));
		const link = el.querySelector<HTMLElement>("a.chat-msg__doc-link")!;
		expect(link.classList.contains("chat-msg__doc-link--muted")).toBe(true);
		link.click();
		expect(documentOpen).not.toHaveBeenCalled();
	});

	it("activity without id: renders a plain label span, no link", () => {
		const el = makeToolCard({ toolName: "search_fulltext" });
		const event = makeEvent({ type: "activity", category: "lookup", action: "search", label: "query" });
		applyToolUIEvent(el, event, makeCtx());
		expect(el.querySelector("a.chat-msg__doc-link")).toBeNull();
		expect(el.querySelector(".chat-msg__doc-label")!.textContent).toBe("query");
	});

	it("created_document: renders an openable link labelled by path", () => {
		const el = makeToolCard({ toolName: "create_document" });
		const event = makeEvent({ type: "created_document", id: "new-1", path: "/created" }, { toolName: "create_document" });
		applyToolUIEvent(el, event, makeCtx());
		const link = el.querySelector<HTMLElement>("a.chat-msg__doc-link")!;
		expect(link.getAttribute("data-id")).toBe("new-1");
		expect(link.textContent).toBe("/created");
		expect(el.querySelector(".chat-msg__doc-meta")!.textContent).toBe("Created document");
		expect(el.dataset.toolCategory).toBe("change");
	});

	it("document_link: renders read link honouring open flag", () => {
		const el = makeToolCard({ toolName: "get_document" });
		const event = makeEvent({ type: "document_link", id: "dl-1", path: "/p", label: "Linked", open: true });
		applyToolUIEvent(el, event, makeCtx());
		const link = el.querySelector<HTMLElement>("a.chat-msg__doc-link")!;
		expect(link.textContent).toBe("Linked");
		expect(el.querySelector(".chat-msg__doc-meta")!.textContent).toBe("Read document");
	});

	it("document_blocks: meta reflects block count", () => {
		const el = makeToolCard({ toolName: "get_document_blocks" });
		const event = makeEvent({ type: "document_blocks", id: "db-1", path: "/p", blockCount: 7, open: true });
		applyToolUIEvent(el, event, makeCtx());
		expect(el.querySelector(".chat-msg__doc-meta")!.textContent).toContain("7");
		expect(el.dataset.toolCategory).toBe("lookup");
	});

	it("append_block: id is the parent, meta reflects appended count", () => {
		const el = makeToolCard({ toolName: "append_block" });
		const event = makeEvent(
			{ type: "append_block", parentID: "parent-1", path: "/p", blockIDs: ["a", "b"], open: true },
			{ toolName: "append_block" },
		);
		applyToolUIEvent(el, event, makeCtx());
		const link = el.querySelector<HTMLElement>("a.chat-msg__doc-link")!;
		expect(link.getAttribute("data-id")).toBe("parent-1");
		expect(el.querySelector(".chat-msg__doc-meta")!.textContent).toContain("2");
		expect(el.dataset.toolCategory).toBe("change");
		expect(el.dataset.toolAction).toBe("append");
	});

	it("edit_blocks: id falls back to first documentID when no primary", () => {
		const el = makeToolCard({ toolName: "edit_blocks" });
		const event = makeEvent(
			{ type: "edit_blocks", documentIDs: ["first", "second"], path: "/p", editedCount: 3 },
			{ toolName: "edit_blocks" },
		);
		applyToolUIEvent(el, event, makeCtx());
		const link = el.querySelector<HTMLElement>("a.chat-msg__doc-link")!;
		expect(link.getAttribute("data-id")).toBe("first");
		expect(el.querySelector(".chat-msg__doc-meta")!.textContent).toContain("3");
	});

	it("text payload: appends a progress line, no summary link", () => {
		const el = makeToolCard({ toolName: "get_document" });
		const event = makeEvent({ type: "text", text: "thinking..." });
		applyToolUIEvent(el, event, makeCtx());
		const progress = el.querySelector(".chat-msg__tool-progress");
		expect(progress).not.toBeNull();
		expect(progress!.textContent).toBe("thinking...");
	});

	it("unknown_structured payload: appends raw text as progress line", () => {
		const el = makeToolCard({ toolName: "get_document" });
		const event = makeEvent({ type: "unknown_structured", raw: "{\"x\":1}" });
		applyToolUIEvent(el, event, makeCtx());
		expect(el.querySelector(".chat-msg__tool-progress")!.textContent).toBe("{\"x\":1}");
	});
});

describe("applyToolUIEvent — interaction", () => {
	it("clicking an openable link invokes the documentOpen ctx callback with the doc id", () => {
		const el = makeToolCard({ toolName: "get_document" });
		const documentOpen = vi.fn();
		const event = makeEvent({ type: "document_link", id: "open-me", path: "/p", label: "L", open: true });
		applyToolUIEvent(el, event, makeCtx({ documentOpen }));
		el.querySelector<HTMLElement>("a.chat-msg__doc-link")!.click();
		expect(documentOpen).toHaveBeenCalledTimes(1);
		expect(documentOpen).toHaveBeenCalledWith("open-me");
	});

	it("refreshes the activity block when one is attached", () => {
		const el = makeToolCard({ toolName: "get_document" });
		const block = document.createElement("div");
		block.className = "chat-msg__activity-block";
		block.appendChild(el);
		const refs = { sentinel: true } as any;
		const refreshActivityBlock = vi.fn();
		const getActivityBlock = vi.fn(() => refs);
		const event = makeEvent({ type: "activity", category: "lookup", action: "read", id: "x" });
		applyToolUIEvent(el, event, makeCtx({ getActivityBlock, refreshActivityBlock }));
		expect(getActivityBlock).toHaveBeenCalled();
		expect(refreshActivityBlock).toHaveBeenCalledWith(refs);
	});
});

describe("appendToolResultToElement", () => {
	it("appends a <pre> with localized result text", () => {
		const el = makeToolCard({ toolName: "get_document" });
		appendToolResultToElement(el, "  hello  ", makeCtx());
		const pre = el.querySelector("pre.chat-msg__tool-result");
		expect(pre).not.toBeNull();
		expect(pre!.textContent).toBe("hello");
	});

	it("skips when the card already has rich events", () => {
		const el = makeToolCard({ toolName: "get_document" });
		el.dataset.hasEvents = "true";
		appendToolResultToElement(el, "ignored", makeCtx());
		expect(el.querySelector("pre.chat-msg__tool-result")).toBeNull();
	});

	it("skips empty/whitespace-only results", () => {
		const el = makeToolCard({ toolName: "get_document" });
		appendToolResultToElement(el, "   ", makeCtx());
		expect(el.querySelector("pre.chat-msg__tool-result")).toBeNull();
	});

	it("truncates long results to 500 chars plus ellipsis", () => {
		const el = makeToolCard({ toolName: "get_document" });
		appendToolResultToElement(el, "a".repeat(600), makeCtx());
		const pre = el.querySelector("pre.chat-msg__tool-result")!;
		expect(pre.textContent).toBe("a".repeat(500) + "...");
	});
});

describe("finalizeToolElement", () => {
	it("marks done, collapses details, and refreshes the block", () => {
		const el = makeToolCard({ toolName: "get_document" });
		const block = document.createElement("div");
		block.className = "chat-msg__activity-block";
		const inner = document.createElement("div");
		inner.appendChild(el);
		block.appendChild(inner);
		const refs = {} as any;
		const refreshActivityBlock = vi.fn();
		finalizeToolElement(el, makeCtx({ getActivityBlock: () => refs, refreshActivityBlock }));
		expect(el.dataset.toolStatus).toBe("done");
		expect(el.querySelector("details")!.open).toBe(false);
		expect(refreshActivityBlock).toHaveBeenCalledWith(refs);
	});

	it("is idempotent once done", () => {
		const el = makeToolCard({ toolName: "get_document" });
		el.dataset.toolStatus = "done";
		const refreshActivityBlock = vi.fn();
		finalizeToolElement(el, makeCtx({ refreshActivityBlock }));
		expect(refreshActivityBlock).not.toHaveBeenCalled();
	});
});

describe("openDocumentTab", () => {
	beforeEach(() => {
		(globalThis as any).siyuanApp = { id: "app" };
	});

	it("delegates to siyuan openTab with the app and doc id", async () => {
		const siyuan = await import("siyuan");
		const spy = vi.spyOn(siyuan, "openTab");
		openDocumentTab("doc-xyz");
		expect(spy).toHaveBeenCalledWith({ app: { id: "app" }, doc: { id: "doc-xyz" } });
		spy.mockRestore();
	});
});
