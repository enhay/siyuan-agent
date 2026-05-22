import { generateText, stepCountIs, tool } from "ai";
import type { AgentTool } from "./agent-types";
import type { ZodTypeAny } from "zod";
import { makeAgent, fetchGuideDoc, type AgentRuntime, type MakeAgentOptions } from "./agent";
import { resolveSubAgentModelConfig, type AgentConfig } from "../types";
import { defaultTranslator, localizeErrorMessage, type Translator } from "../i18n";

function resolveGuideContent(
	options: { guideContent?: string },
	config: AgentConfig,
): string | Promise<string> {
	if (options.guideContent !== undefined) return options.guideContent;
	const docId = config.guideDoc?.id;
	if (!docId) return "";
	return fetchGuideDoc(docId);
}

type ToolsetResolver = AgentTool[] | (() => AgentTool[]);

type CreateAgentFn = (
	config: AgentConfig,
	tools: AgentTool[],
	opts?: MakeAgentOptions,
) => AgentRuntime | Promise<AgentRuntime>;

export interface SubAgentToolOptions<TSchema extends ZodTypeAny = ZodTypeAny> {
	name: string;
	description: string;
	schema: TSchema;
	toolset: ToolsetResolver;
	systemPrompt: string;
	getAgentConfig: () => AgentConfig | Promise<AgentConfig>;
	extractResult?: (result: any) => string;
	recursionLimit?: number;
	createAgent?: CreateAgentFn;
	i18n?: Translator;
	/** Guide doc body already fetched by the parent; reused so the sub-agent never re-fetches. */
	guideContent?: string;
}

function resolveToolset(toolset: ToolsetResolver): AgentTool[] {
	return typeof toolset === "function" ? toolset() : toolset;
}

function inputToPrompt(input: unknown): string {
	if (input && typeof input === "object" && "query" in input) {
		const query = (input as { query?: unknown }).query;
		if (typeof query === "string") return query;
	}
	if (typeof input === "string") return input;
	return JSON.stringify(input, null, 2);
}

/** Default result extractor: the final text of a generateText run. */
export function extractLastAiMessageContent(result: any): string {
	if (typeof result?.text === "string" && result.text) return result.text;
	return defaultTranslator.t("subAgent.noFinal");
}

export async function invokeSubAgent<TSchema extends ZodTypeAny>(
	options: SubAgentToolOptions<TSchema>,
	input: unknown,
	runtime: { signal?: AbortSignal },
): Promise<string> {
	const extractResult = options.extractResult ?? extractLastAiMessageContent;
	const createChildAgent = options.createAgent ?? makeAgent;
	const recursionLimit = options.recursionLimit ?? 12;
	const config = await options.getAgentConfig();
	const subAgentModel = resolveSubAgentModelConfig(config);
	const childTools = resolveToolset(options.toolset)
		.filter((toolDef) => (toolDef as { __toolName?: string }).__toolName !== options.name);
	const i18n = options.i18n || defaultTranslator;
	const guideContent = await resolveGuideContent(options, config);
	const agent = await createChildAgent(config, childTools, {
		extraSystemPrompt: options.systemPrompt,
		modelOverride: subAgentModel,
		i18n,
		guideContent,
	});
	const prompt = inputToPrompt(input);
	const result = await generateText({
		model: agent.model,
		system: agent.system,
		tools: agent.tools,
		messages: [{ role: "user", content: prompt }],
		stopWhen: stepCountIs(recursionLimit),
		abortSignal: runtime.signal,
		...(agent.providerOptions ? { providerOptions: agent.providerOptions } : {}),
	});
	const text = extractResult(result);
	// Guard against empty or excessively long sub-agent output
	if (!text || !text.trim()) return i18n.t("subAgent.noResult");
	if (text.length > 8000) return text.slice(0, 8000) + i18n.t("subAgent.truncated");
	return text;
}

export async function invokeSubAgentSafe<TSchema extends ZodTypeAny>(
	options: SubAgentToolOptions<TSchema>,
	input: unknown,
	runtime: { signal?: AbortSignal },
): Promise<string> {
	try {
		return await invokeSubAgent(options, input, runtime);
	} catch (err: any) {
		const i18n = options.i18n || defaultTranslator;
		const msg = localizeErrorMessage(err, i18n);
		// Don't propagate abort errors as tool results
		if (err?.name === "AbortError" || msg.includes("abort")) throw err;
		return i18n.t("subAgent.failed", { error: msg });
	}
}

export function createSubAgentTool<TSchema extends ZodTypeAny>(
	options: SubAgentToolOptions<TSchema>,
): AgentTool {
	const t = tool({
		description: options.description,
		inputSchema: options.schema,
		execute: async (input: unknown, { abortSignal }) =>
			invokeSubAgentSafe(options, input, { signal: abortSignal }),
	});
	(t as AgentTool & { __toolName: string }).__toolName = options.name;
	return t as AgentTool;
}
