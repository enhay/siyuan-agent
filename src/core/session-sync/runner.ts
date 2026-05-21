/** Assemble a SyncRunner from config for the in-plugin reader tier.
 *
 *  Returns null when this environment can't read locally (mobile/docker/no-Node)
 *  or the config is incomplete — the manager then reports `disabled` and the UI
 *  falls back to sidecar/viewer mode (see plan §4/§17). */

import { createFsSource } from "./adapters/fs-source";
import { createSiyuanWriter } from "./adapters/siyuan-writer";
import { createPluginStateStore, type DataPlugin } from "./adapters/state-store";
import { reconcileOnce } from "./engine/reconcile";
import { decideTier, detectEnvironment } from "./env-probe";
import type { SessionSyncConfig } from "./config";
import type { SyncRunner } from "./manager";
import type { TitleProvider } from "./engine/ports";

export function buildSyncRunner(
	config: SessionSyncConfig,
	plugin: DataPlugin,
	titleProvider?: TitleProvider,
): SyncRunner | null {
	if (!config.enabled || !config.notebookId) return null;
	if (decideTier(detectEnvironment()) !== "in-plugin") return null;

	let files;
	try {
		files = createFsSource({
			sources: config.sources,
			sourcePaths: config.sourcePaths,
			backfillDays: config.backfillDays,
			backfillLimit: config.backfillLimit,
		});
	} catch {
		return null; // Node fs unavailable
	}

	const aiTitleEnabled = config.aiTitle.enabled && !!titleProvider;
	const deps = {
		files,
		writer: createSiyuanWriter(),
		state: createPluginStateStore(plugin),
		notebookId: config.notebookId,
		rootPath: config.rootPath,
		titleProvider: aiTitleEnabled ? titleProvider : undefined,
		aiTitleEnabled,
	};

	return {
		probe: () => files.probe(),
		reconcile: () => reconcileOnce(deps),
	};
}
