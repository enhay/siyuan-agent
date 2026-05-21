import { describe, expect, it, vi } from "vitest";
import { buildAgentSystemPrompt } from "../src/core/agent";
import { buildSystemPrompt, type AgentConfig } from "../src/types";
import { defaultTranslator } from "../src/i18n";

vi.mock("siyuan", () => ({
	fetchPost: vi.fn(),
	openTab: vi.fn(),
}));

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		apiBaseURL: "https://example.com/v1",
		apiKey: "test-key",
		model: "test-model",
		customInstructions: "",
		...overrides,
	};
}

const BASE = buildSystemPrompt(defaultTranslator);
const GUIDE_HEADER = defaultTranslator.t("agent.guideDocHeader");

describe("buildAgentSystemPrompt", () => {
	it("returns only the base prompt when nothing extra is supplied", () => {
		const prompt = buildAgentSystemPrompt(baseConfig(), "");
		expect(prompt).toBe(BASE);
		expect(prompt).not.toContain(`---\n${GUIDE_HEADER}`);
	});

	it("appends the guide block (wrapped in ---) when guideContent is non-empty", () => {
		const prompt = buildAgentSystemPrompt(baseConfig(), "GUIDE BODY");
		expect(prompt).toContain(`---\n${GUIDE_HEADER}\nGUIDE BODY\n---`);
		expect(prompt.startsWith(BASE)).toBe(true);
	});

	it("emits NO --- wrapper when guideContent is an empty string", () => {
		const prompt = buildAgentSystemPrompt(baseConfig(), "");
		expect(prompt).not.toContain(`---\n${GUIDE_HEADER}`);
		expect(prompt).not.toContain(GUIDE_HEADER);
	});

	it("appends the default notebook block only when defaultNotebook.id is present", () => {
		const without = buildAgentSystemPrompt(baseConfig(), "");
		expect(without).not.toContain("MyBook");

		const withNb = buildAgentSystemPrompt(
			baseConfig({ defaultNotebook: { id: "nb-1", name: "MyBook" } }),
			"",
		);
		const expectedNb = defaultTranslator.t("agent.defaultNotebook", { name: "MyBook", id: "nb-1" });
		expect(withNb).toContain(expectedNb);
		expect(withNb).toBe(`${BASE}\n\n${expectedNb}`);
	});

	it("appends custom instructions only when non-blank", () => {
		const blank = buildAgentSystemPrompt(baseConfig({ customInstructions: "   " }), "");
		expect(blank).toBe(BASE);

		const withCustom = buildAgentSystemPrompt(
			baseConfig({ customInstructions: "Be terse." }),
			"",
		);
		const expectedCustom = defaultTranslator.t("agent.customInstructions", { instructions: "Be terse." });
		expect(withCustom).toContain(expectedCustom);
		expect(withCustom).toBe(`${BASE}\n\n${expectedCustom}`);
	});

	it("appends extraSystemPrompt only when truthy", () => {
		const none = buildAgentSystemPrompt(baseConfig(), "", defaultTranslator, null);
		expect(none).toBe(BASE);

		const withExtra = buildAgentSystemPrompt(baseConfig(), "", defaultTranslator, "SUB AGENT PROMPT");
		expect(withExtra).toBe(`${BASE}\n\nSUB AGENT PROMPT`);
	});

	it("preserves ordering: base -> guide -> defaultNotebook -> customInstructions -> extra", () => {
		const config = baseConfig({
			defaultNotebook: { id: "nb-1", name: "MyBook" },
			customInstructions: "Be terse.",
		});
		const prompt = buildAgentSystemPrompt(config, "GUIDE BODY", defaultTranslator, "EXTRA");

		const guideBlock = `\n\n---\n${GUIDE_HEADER}\nGUIDE BODY\n---`;
		const nbBlock = `\n\n${defaultTranslator.t("agent.defaultNotebook", { name: "MyBook", id: "nb-1" })}`;
		const customBlock = `\n\n${defaultTranslator.t("agent.customInstructions", { instructions: "Be terse." })}`;
		const extraBlock = "\n\nEXTRA";

		expect(prompt).toBe(`${BASE}${guideBlock}${nbBlock}${customBlock}${extraBlock}`);

		const idxGuide = prompt.indexOf(GUIDE_HEADER);
		const idxNb = prompt.indexOf("MyBook");
		const idxCustom = prompt.indexOf("Be terse.");
		const idxExtra = prompt.indexOf("EXTRA");
		expect(idxGuide).toBeGreaterThan(BASE.length - 1);
		expect(idxNb).toBeGreaterThan(idxGuide);
		expect(idxCustom).toBeGreaterThan(idxNb);
		expect(idxExtra).toBeGreaterThan(idxCustom);
	});
});
