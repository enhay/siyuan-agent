/** Persisted session-sync settings (stored on `AgentConfig.sessionSync`) and a
 *  factory that seeds sensible defaults from the detected environment. */

import { type EnvInfo, defaultSourcePaths } from "./env-probe";

export interface SessionSyncConfig {
	enabled: boolean;
	sources: { codex: boolean; claude: boolean };
	sourcePaths: { codex: string[]; claude: string[] };
	notebookId?: string;
	rootPath: string;
	pollIntervalSec: number;
	backfillDays: number;
	backfillLimit: number;
	aiTitle: { enabled: boolean; modelId?: string };
	/** Status only; set after each successful sync. */
	lastSyncAt?: number;
}

export function defaultSessionSyncConfig(env: EnvInfo): SessionSyncConfig {
	return {
		enabled: false,
		sources: { codex: true, claude: true },
		sourcePaths: defaultSourcePaths(env),
		rootPath: "/AI 会话",
		pollIntervalSec: 60,
		backfillDays: 7,
		backfillLimit: 50,
		aiTitle: { enabled: false },
	};
}

/** Fill any missing fields on a persisted (possibly partial/legacy) config. */
export function normalizeSessionSyncConfig(env: EnvInfo, raw?: Partial<SessionSyncConfig>): SessionSyncConfig {
	const base = defaultSessionSyncConfig(env);
	if (!raw) return base;
	return {
		enabled: raw.enabled ?? base.enabled,
		sources: { codex: raw.sources?.codex ?? base.sources.codex, claude: raw.sources?.claude ?? base.sources.claude },
		sourcePaths: {
			codex: raw.sourcePaths?.codex?.length ? raw.sourcePaths.codex : base.sourcePaths.codex,
			claude: raw.sourcePaths?.claude?.length ? raw.sourcePaths.claude : base.sourcePaths.claude,
		},
		notebookId: raw.notebookId ?? base.notebookId,
		rootPath: raw.rootPath || base.rootPath,
		pollIntervalSec: raw.pollIntervalSec ?? base.pollIntervalSec,
		backfillDays: raw.backfillDays ?? base.backfillDays,
		backfillLimit: raw.backfillLimit ?? base.backfillLimit,
		aiTitle: { enabled: raw.aiTitle?.enabled ?? base.aiTitle.enabled, modelId: raw.aiTitle?.modelId },
		lastSyncAt: raw.lastSyncAt,
	};
}
