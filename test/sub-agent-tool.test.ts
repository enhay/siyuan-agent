// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { createSubAgentTool, invokeSubAgent, invokeSubAgentSafe } from "../src/core/sub-agent";
import type { AgentConfig } from "../src/types";

vi.mock("siyuan", () => ({ fetchPost: vi.fn(), openTab: vi.fn() }));

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 }, totalTokens: { total: 2 } };

function createConfig(): AgentConfig {
	return { apiBaseURL: "https://example.com/v1", apiKey: "test-key", model: "test-model", customInstructions: "" };
}

/** A mock AgentRuntime whose model generates `text` (or throws `err`). */
function runtimeFor(text: string, err?: Error) {
	const model = new MockLanguageModelV3({
		doGenerate: async () => {
			if (err) throw err;
			return { content: text ? [{ type: "text", text }] : [], finishReason: "stop", usage, warnings: [] };
		},
	});
	return { model: model as any, system: "sys", tools: {}, providerOptions: {} };
}

const baseOptions = (over: Record<string, unknown> = {}) => ({
	name: "explore_notes",
	description: "x",
	schema: z.object({ query: z.string() }),
	toolset: [] as any[],
	systemPrompt: "prompt",
	getAgentConfig: createConfig,
	...over,
});

describe("invokeSubAgent", () => {
	it("filters the sub-agent's own tool, runs generateText, returns the text", async () => {
		const createAgent = vi.fn().mockReturnValue(runtimeFor("探索结果"));
		const options = baseOptions({
			toolset: [
				{ __toolName: "explore_notes" } as any,
				{ __toolName: "search_fulltext" } as any,
				{ __toolName: "edit_blocks" } as any,
			],
			createAgent,
		});

		const result = await invokeSubAgent(options as any, { query: "帮我看看最近在写什么" }, {});

		expect(result).toBe("探索结果");
		expect(createAgent).toHaveBeenCalledWith(
			createConfig(),
			[expect.objectContaining({ __toolName: "search_fulltext" }), expect.objectContaining({ __toolName: "edit_blocks" })],
			expect.objectContaining({ extraSystemPrompt: "prompt", guideContent: "" }),
		);
	});

	it("returns a readable fallback when the child produced no final text", async () => {
		const options = baseOptions({ createAgent: vi.fn().mockReturnValue(runtimeFor("")) });
		const result = await invokeSubAgent(options as any, { query: "没有答案时怎么办" }, {});
		expect(result).toBe("Explore sub-agent did not return a final text result.");
	});

	it("truncates excessively long sub-agent output", async () => {
		const options = baseOptions({ createAgent: vi.fn().mockReturnValue(runtimeFor("a".repeat(10000))) });
		const result = await invokeSubAgent(options as any, { query: "test" }, {});
		expect(result.length).toBeLessThan(8100);
		expect(result).toContain("...(truncated)");
	});
});

describe("invokeSubAgentSafe", () => {
	it("catches errors and returns a friendly message", async () => {
		const options = baseOptions({
			createAgent: vi.fn().mockReturnValue(runtimeFor("", new Error("API rate limit exceeded"))),
		});
		const result = await invokeSubAgentSafe(options as any, { query: "test" }, {});
		expect(result).toBe("[Sub-agent failed] Rate limit exceeded. Try again later.");
	});

	it("re-throws abort errors", async () => {
		const abortError = new Error("aborted");
		abortError.name = "AbortError";
		const options = baseOptions({ createAgent: vi.fn().mockReturnValue(runtimeFor("", abortError)) });
		await expect(invokeSubAgentSafe(options as any, { query: "test" }, {})).rejects.toThrow("aborted");
	});
});

describe("tool registry", () => {
	it("keeps lookup tools read-only and excludes explore_notes itself", async () => {
		const { getLookupTools } = await import("../src/core/tools");
		expect(getLookupTools().map((t: any) => t.__toolName)).toEqual([
			"list_notebooks",
			"list_documents",
			"recent_documents",
			"get_document",
			"get_document_blocks",
			"get_document_outline",
			"read_block",
			"search_fulltext",
			"search_documents",
		]);
	});

	it("registers explore_notes in the default tool set", async () => {
		const { getDefaultTools } = await import("../src/core/tools");
		const names = getDefaultTools(createConfig).map((t: any) => t.__toolName);
		expect(names).toContain("explore_notes");
		expect(names).toContain("append_block");
		expect(names).toContain("edit_blocks");
		expect(names).toContain("write_todos");
	});

	it("creates an AI SDK tool shell around the sub-agent helper", () => {
		const toolDef: any = createSubAgentTool({
			name: "explore_notes",
			description: "x",
			schema: z.object({ query: z.string() }),
			toolset: [],
			systemPrompt: "prompt",
			getAgentConfig: createConfig,
			createAgent: vi.fn(),
		});
		expect(toolDef.__toolName).toBe("explore_notes");
		expect(toolDef.description).toBe("x");
	});
});
