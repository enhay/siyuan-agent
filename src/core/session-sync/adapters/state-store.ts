/** StateStore backed by the plugin's `saveData`/`loadData` (the workspace's
 *  plugin storage). One JSON blob keyed by `SESSION_SYNC_STATE`. */

import type { StateStore } from "../engine/ports";
import type { SyncState } from "../engine/types";

export const SESSION_SYNC_STATE = "session-sync-state";

export interface DataPlugin {
	loadData(key: string): Promise<unknown>;
	saveData(key: string, value: unknown): Promise<void>;
}

function isSyncState(value: unknown): value is SyncState {
	if (!value || typeof value !== "object") return false;
	const { files, sessions } = value as SyncState;
	return !!files && typeof files === "object" && !!sessions && typeof sessions === "object";
}

export function createPluginStateStore(plugin: DataPlugin, key = SESSION_SYNC_STATE): StateStore {
	return {
		async load() {
			const raw = await plugin.loadData(key);
			return isSyncState(raw) ? raw : { files: {}, sessions: {} };
		},
		async save(state) {
			await plugin.saveData(key, state);
		},
	};
}
