/** Ports the engine depends on; adapters implement them per runtime.
 *
 *  - Plugin runtime: FileSource = Node `fs` (native or `\\wsl.localhost\…` UNC),
 *    SiyuanWriter = same-origin `siyuanFetch`, StateStore = `plugin.saveData`.
 *  - CLI sidecar runtime: FileSource = native fs, SiyuanWriter = HTTP client,
 *    StateStore = json file.
 *
 *  Keeping these abstract is what lets one engine serve every deployment cell
 *  (same-machine desktop / WSL / Docker / remote) — see `docs/session-sync-plan.md` §4. */

import type { SessionSource, SyncState } from "./types";

/** A discovered session log file on disk. */
export interface DiscoveredFile {
	source: SessionSource;
	/** Absolute path (native or UNC). */
	path: string;
	mtimeMs?: number;
	sizeBytes?: number;
}

/** Reads session logs from wherever they live. */
export interface FileSource {
	/** List candidate session files for the enabled sources, already filtered to
	 *  the backfill window when applicable. */
	list(): Promise<DiscoveredFile[]>;
	/** Read a file's full content as UTF-8 text. */
	read(path: string): Promise<string>;
	/** Cheap change probe: a signature over the recent window (e.g. count + maxMtime).
	 *  Reconcile only runs a full pass when this changes. Must catch *appends* to an
	 *  active session, so it cannot be a directory mtime. See plan §7. */
	probe(): Promise<string>;
}

/** Writes generated session documents through SiYuan's kernel API. */
export interface SiyuanWriter {
	createDoc(input: { notebook: string; path: string; markdown: string }): Promise<{ id: string }>;
	/** Overwrite a doc's body while preserving its id + attrs: clear children, append.
	 *  (Kernel `updateBlock` only keeps FirstChild — see plan §8.) */
	overwriteDoc(input: { docId: string; markdown: string }): Promise<void>;
	setAttrs(input: { docId: string; attrs: Record<string, string> }): Promise<void>;
	renameDoc(input: { docId: string; title: string }): Promise<void>;
	moveUnder(input: { childIds: string[]; parentDocId: string }): Promise<void>;
	/** Look up a doc id by `custom-ai-session-key` for state-loss recovery. */
	findDocBySessionKey(sessionKey: string): Promise<string | undefined>;
	/** Whether a doc id still exists (user may have deleted it). */
	docExists(docId: string): Promise<boolean>;
}

/** Loads and atomically saves sync state. */
export interface StateStore {
	load(): Promise<SyncState>;
	save(state: SyncState): Promise<void>;
}
