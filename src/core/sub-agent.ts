import { HumanMessage } from "@langchain/core/messages";
import { tool, type StructuredToolInterface, type ToolRuntime } from "@langchain/core/tools";
import type { ZodTypeAny } from "zod";
import { makeAgent, fetchGuideDoc, type MakeAgentOptions } from "./agent";
import { messageKind, messageContent } from "./message-shape";
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

type AgentLike = {
	invoke: (input: { messages: HumanMessage[] }, options?: Record<string, unknown>) => Promise<any>;
};

type ToolsetResolver = StructuredToolInterface[] | (() => StructuredToolInterface[]);

type CreateAgentFn = (
	config: AgentConfig,
	tools: StructuredToolInterface[],
	opts?: MakeAgentOptions,
) => AgentLike | Promise<AgentLike>;

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

function resolveToolset(toolset: ToolsetResolver): StructuredToolInterface[] {
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

export function extractLastAiMessageContent(result: any): string {
	const messages = Array.isArray(result?.messages) ? result.messages : [];
	for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
		if (messageKind(messages[idx]) !== "ai") continue;
		const content = messageContent(messages[idx]);
		if (content) return content;
	}
	return defaultTranslator.t("subAgent.noFinal");
}

export async function invokeSubAgent<TSchema extends ZodTypeAny>(
	options: SubAgentToolOptions<TSchema>,
	input: unknown,
	runtime: ToolRuntime,
): Promise<string> {
	const extractResult = options.extractResult ?? extractLastAiMessageContent;
	const createChildAgent = options.createAgent ?? makeAgent;
	const recursionLimit = options.recursionLimit ?? 12;
	const config = await options.getAgentConfig();
	const subAgentModel = resolveSubAgentModelConfig(config);
	const childTools = resolveToolset(options.toolset)
		.filter((toolDef) => toolDef.name !== options.name);
	const i18n = options.i18n || defaultTranslator;
	const guideContent = await resolveGuideContent(options, config);
	const childAgent = await createChildAgent(config, childTools, {
		extraSystemPrompt: options.systemPrompt,
		modelOverride: subAgentModel,
		i18n,
		guideContent,
	});
	const prompt = inputToPrompt(input);
	const invokeOptions: Record<string, unknown> = {
		recursionLimit,
		signal: runtime.signal,
	};
	if (runtime.context !== undefined) {
		invokeOptions.context = runtime.context;
	}
	if (runtime.config?.callbacks) {
		invokeOptions.callbacks = runtime.config.callbacks;
	}
	const result = await childAgent.invoke({
		messages: [new HumanMessage({ content: prompt })],
	}, invokeOptions);
	const text = extractResult(result);
	// Guard against empty or excessively long sub-agent output
	if (!text || !text.trim()) return i18n.t("subAgent.noResult");
	if (text.length > 8000) return text.slice(0, 8000) + i18n.t("subAgent.truncated");
	return text;
}

export async function invokeSubAgentSafe<TSchema extends ZodTypeAny>(
	options: SubAgentToolOptions<TSchema>,
	input: unknown,
	runtime: ToolRuntime,
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
): StructuredToolInterface {
	return tool(
		async (input: unknown, runtime: ToolRuntime) => invokeSubAgentSafe(options, input, runtime),
		{
			name: options.name,
			description: options.description,
			schema: options.schema,
		},
	);
}
