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
import type { SectionKind } from "./render";

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
	/** Read a file as UTF-8 text. When `fromOffset` is provided, only the bytes
	 *  at or after that offset are returned (an opaque byte cursor matched to
	 *  what `list()` reports as `sizeBytes`). Used by the incremental reconciler
	 *  to read only the appended bytes of a growing JSONL — caps memory at the
	 *  size of the delta, not the whole-file size. */
	read(path: string, fromOffset?: number): Promise<string>;
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
	/** Collapse (fold) top-level headings whose text starts with one of the prefixes. */
	foldHeadings(input: { docId: string; headingPrefixes: string[] }): Promise<void>;
	/** Write a `.md` attachment under data/assets/<relPath> (deterministic, overwrites
	 *  in place) and return its `assets/<relPath>` link. Used for sub-agent transcripts. */
	putAsset(input: { relPath: string; content: string }): Promise<string>;
	/** Look up a doc id by `custom-ai-session-key` for state-loss recovery. */
	findDocBySessionKey(sessionKey: string): Promise<string | undefined>;
	/** Whether a doc id still exists (user may have deleted it). */
	docExists(docId: string): Promise<boolean>;

	// ── Incremental-update API (Phase 2) ─────────────────────────────────────

	/** Walk a freshly-created doc's top-level blocks, identify each section's
	 *  anchor block (heading or summary callout) by content, and set
	 *  `custom-section` attr so later updates can find it. Returns the discovered
	 *  anchor id per section kind. Idempotent. */
	tagSectionAnchors(docId: string): Promise<Partial<Record<SectionKind, string>>>;
	/** Locate a single section's anchor by attr; undefined if not tagged. */
	findSectionBlock(docId: string, kind: SectionKind): Promise<string | undefined>;
	/** Replace a whole section (anchor block + body blocks until the next section
	 *  anchor or doc end) with new markdown. The replacement's first block gets
	 *  the `custom-section` attr. If `markdown` is empty the section is removed.
	 *  Returns the new anchor id (or undefined when emptied). */
	replaceSection(
		docId: string,
		kind: SectionKind,
		markdown: string,
	): Promise<{ anchorId: string | undefined }>;
	/** Append blocks at the end of a section's body — just before the next
	 *  section anchor, or at doc end if there's no next section. Returns ids of
	 *  the newly inserted top-level blocks. */
	appendToSection(
		docId: string,
		kind: SectionKind,
		markdown: string,
	): Promise<{ ids: string[] }>;
}

/** Loads and atomically saves sync state. */
export interface StateStore {
	load(): Promise<SyncState>;
	save(state: SyncState): Promise<void>;
}

/** Optional AI title generator (backed by the plugin's model registry). Returns
 *  undefined on failure/unavailable so the engine falls back to the heuristic. */
export interface TitleProvider {
	generate(input: { title: string; firstUserMessage?: string; summary?: string }): Promise<string | undefined>;
}
