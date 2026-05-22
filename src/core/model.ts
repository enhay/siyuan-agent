/**
 * model — the model factory for the AI SDK v6 agent (replaces chat-model.ts).
 *
 * `createModel` resolves a project `ModelConfig` to an AI SDK `LanguageModel`.
 * Reasoning effort is no longer baked into the model: AI SDK takes it per-call
 * via `providerOptions`, so `reasoningProviderOptions` is exported separately for
 * the stream runtime (Wave 2) to spread into `streamText`/`generateText`.
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";
import type { AgentModel } from "./agent-types";
import type { ModelConfig, ReasoningEffort } from "../types";
import { DEEPSEEK_API_BASE_URL } from "../types";

/** Provider-name key for `providerOptions` on the OpenAI-compatible path. */
function compatProviderName(config: ModelConfig): string {
	return config.providerType ?? "openai-compatible";
}

/**
 * Resolve a ModelConfig to an AI SDK model.
 *
 * `dangerouslyAllowBrowser` is unnecessary — the AI SDK is built for the
 * browser/edge and talks to `globalThis.fetch` directly.
 */
export function createModel(config: ModelConfig): AgentModel {
	if (config.providerType === "deepseek") {
		// B5: DeepSeek-R1-class reasoning endpoints MUST use the native provider.
		// It filters reasoning_content per turn (R1 rejects prior reasoning on
		// follow-up calls — the 400 the old patchReasoningRoundTrip hack worked
		// around). The openai-compatible provider resends reasoning_content on
		// EVERY assistant turn unconditionally, so a proxied R1 reached through
		// createOpenAICompatible is UNSUPPORTED and would re-trigger that 400.
		const deepseek = createDeepSeek({
			apiKey: config.apiKey,
			baseURL: config.apiBaseURL || DEEPSEEK_API_BASE_URL,
		});
		return deepseek(config.model);
	}

	const provider = createOpenAICompatible({
		name: compatProviderName(config),
		apiKey: config.apiKey,
		baseURL: config.apiBaseURL,
	});
	let model: AgentModel = provider(config.model);

	// Endpoints that stream chain-of-thought inline as `<think>…</think>` text:
	// peel it into first-class reasoning parts. Replaces the hand-rolled
	// ChatDeepSeek.processStreamWithThinkTags state machine.
	if (config.reasoningTag) {
		model = wrapLanguageModel({
			model,
			middleware: extractReasoningMiddleware({ tagName: config.reasoningTag }),
		});
	}
	return model;
}

/**
 * Per-call `providerOptions` carrying the reasoning effort (Wave 2 spreads this
 * into the streamText/generateText call).
 *
 * B4: the object MUST be keyed by the provider NAME, not a hardcoded "openai" —
 * createOpenAICompatible reads its options under the `name` it was created with,
 * so `{ openai: { … } }` would be silently dropped for a non-"openai" provider.
 *
 * Behavior change (was: `thinking: { type: "enabled"|"disabled" }` baked into
 * modelKwargs): the compatible path now drives reasoning via `reasoning_effort`
 * (the openai-compatible provider maps `reasoningEffort` → `reasoning_effort`).
 * DeepSeek native reasoning is model-driven (deepseek-reasoner), so no per-call
 * effort is sent there.
 */
export function reasoningProviderOptions(
	effort: ReasoningEffort = "default",
	config: ModelConfig,
): Record<string, Record<string, unknown>> {
	if (config.providerType === "deepseek") return {};
	const mapped = mapEffort(effort);
	return mapped ? { [compatProviderName(config)]: { reasoningEffort: mapped } } : {};
}

/** Map the project's ReasoningEffort to an OpenAI-style `reasoning_effort`. */
function mapEffort(effort: ReasoningEffort): string | null {
	switch (effort) {
		case "off":
			return "minimal";
		case "low":
			return "low";
		case "high":
			return "high";
		default:
			return null; // "default" → let the endpoint decide
	}
}
