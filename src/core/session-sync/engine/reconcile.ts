/** Incremental reconcile: discover → skip-unchanged → parse → render → upsert.
 *
 *  Pure orchestration over the ports (FileSource / SiyuanWriter / StateStore).
 *  Flat per-session upsert; sub-agent aggregation lands in Phase 5.
 *
 *  Dedup/identity is by docId + `custom-ai-session-key` (never by re-creating at
 *  a path — kernel `createDocWithMd` makes a sibling on path collision). Update
 *  overwrites the body via the writer's clear-children+append (kernel `updateBlock`
 *  only keeps FirstChild). See plan §8. */

import type { DiscoveredFile, FileSource, SiyuanWriter, StateStore, TitleProvider } from "./ports";
import type { NormalizedSession, ReconcileResult, SessionRecord, SyncState } from "./types";
import { parseCodexSession } from "./parse/codex";
import { parseClaudeSession } from "./parse/claude";
import {
	renderFullDoc,
	renderOverviewBlock,
	renderSummaryBlock,
	renderToolsBlock,
	renderWarningsBlock,
	renderDialogTail,
	buildIncrementalDialogItems,
	seedSubLabelCounts,
	cleanTurns,
	FOLDABLE_HEADING_PREFIXES,
} from "./render";
import { assetRelPath, buildDocName, buildSiyuanAttrs, buildSiyuanDocPath, contentHash, fileKey, firstSubstantiveUserMessage, inferTitle, sessionKey } from "./identity";
import { inferStatus } from "./status";
import { collectChildLinks, type ChildLink } from "./aggregate";

export interface ReconcileDeps {
	files: FileSource;
	writer: SiyuanWriter;
	state: StateStore;
	notebookId: string;
	rootPath: string;
	now?: () => number;
	/** When set with aiTitleEnabled, generate readable titles via the model registry. */
	titleProvider?: TitleProvider;
	aiTitleEnabled?: boolean;
	/** Pause between upserts (ms) so a large backfill doesn't starve SiYuan's
	 *  background indexing. 0/undefined for incremental syncs. */
	upsertDelayMs?: number;
	/** Defer writing a session until it's been idle this long (settle-gate). A live
	 *  session's file grows every poll; without this it would be re-rendered and
	 *  whole-doc-overwritten each tick (full FTS reindex). Writing only once it
	 *  settles makes each session cost one write per idle period. 0 disables. */
	settleMs?: number;
	/** When an incremental session's active part exceeds this many bytes of
	 *  appended dialog content, spill into a new SiYuan doc (linked by inline
	 *  navigation blocks). Caps the per-doc size SiYuan's kernel has to ingest +
	 *  index. 0 disables (single-part forever). Default 6 MB. */
	partMaxBytes?: number;
}

const DEFAULT_SETTLE_MS = 5 * 60 * 1000;
const DEFAULT_PART_MAX_BYTES = 6 * 1024 * 1024;

/** Title precedence: an existing AI title is sticky (never reverts on toggle-off);
 *  otherwise generate once when AI is enabled, falling back to the heuristic. */
async function resolveTitle(
	deps: ReconcileDeps,
	session: NormalizedSession,
	existing: SessionRecord | undefined,
): Promise<{ title: string; titleSource: "ai" | "heuristic" }> {
	if (existing?.titleSource === "ai" && existing.title) {
		return { title: existing.title, titleSource: "ai" };
	}
	// Seed the model with the first *substantive* user message (same basis as the
	// heuristic). No real content → skip the model entirely, so it can't echo the
	// instruction back as a junk title. Sub-agents stay heuristic: their title is
	// only inline link text in the parent, not worth an LLM call (×~1200 on backfill).
	const seed = firstSubstantiveUserMessage(session);
	if (deps.aiTitleEnabled && deps.titleProvider && seed && !session.isSubAgent) {
		const ai = await deps.titleProvider
			.generate({ title: inferTitle(session), firstUserMessage: seed })
			.catch(() => undefined);
		if (ai && ai.trim()) return { title: ai.trim(), titleSource: "ai" };
	}
	return { title: inferTitle(session), titleSource: "heuristic" };
}

function parseFile(file: DiscoveredFile, content: string): NormalizedSession {
	return file.source === "codex"
		? parseCodexSession(content, file.path)
		: parseClaudeSession(content, file.path);
}

function toRecord(
	session: NormalizedSession,
	ref: { docId?: string; assetPath?: string },
	path: string,
	hash: string,
	title: string,
	titleSource: "ai" | "heuristic",
	sizeBytes: number | undefined,
	now: number,
): SessionRecord {
	return {
		target: "siyuan",
		docId: ref.docId,
		assetPath: ref.assetPath,
		path,
		title,
		titleSource,
		contentHash: hash,
		source: session.source,
		sessionId: session.sessionId,
		parentSessionId: session.parentSessionId,
		agentId: session.agentId,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		cwd: session.cwd,
		model: session.model,
		agentNickname: session.agentNickname,
		agentRole: session.agentRole,
		messageCount: session.messages.length,
		toolCount: session.toolActivities.length,
		failedToolCount: session.toolActivities.filter((t) => t.status === "failure").length,
		lastSourceOffset: sizeBytes,
		lastWrittenAt: new Date(now).toISOString(),
	};
}

/** Route a main-session upsert to the right path:
 *  - legacy (existing doc without `incrementalEnabled`): keep old overwrite
 *    behavior — per migration choice, legacy docs aren't migrated in place
 *  - existing incremental (active part still alive): incremental update
 *  - everything else (new + recovered + active-part deleted): create fresh
 *    incremental */
async function upsertDoc(
	deps: ReconcileDeps,
	state: SyncState,
	session: NormalizedSession,
	file: DiscoveredFile,
	result: ReconcileResult,
	childLinks: ChildLink[],
): Promise<void> {
	const key = sessionKey(session);
	const existing = state.sessions[key];

	// Legacy session: still has a doc that was created under the old structure.
	// Keep updating it via clear-children + append. No migration in place.
	if (existing?.docId && !existing.incrementalEnabled && (await deps.writer.docExists(existing.docId))) {
		return upsertDocLegacy(deps, state, session, file, result, childLinks);
	}

	// Existing incremental session — try to update the active part in place.
	if (existing?.incrementalEnabled) {
		const partDocIds = existing.partDocIds ?? (existing.docId ? [existing.docId] : []);
		const activeDocId = partDocIds[partDocIds.length - 1];
		if (activeDocId && (await deps.writer.docExists(activeDocId))) {
			return upsertDocIncrementalUpdate(deps, state, session, file, result, childLinks);
		}
		// Active part vanished (user deleted it). Drop the record + fall through to
		// a fresh create. The findDocBySessionKey lookup inside upsertDocCreate
		// will catch any surviving primary part for state-loss recovery.
		delete state.sessions[key];
	}

	return upsertDocCreate(deps, state, session, file, result, childLinks);
}

/** Bytes counted toward an incremental part's size budget. Approximate; only used
 *  to decide when to spill into a new part. */
function approxByteLen(text: string): number {
	return text.length;
}

/** Render the meta sections (overview/summary/tools/warnings) joined for hashing.
 *  We hash the join to know whether ANY of them changed across ticks — a cheap
 *  guard against gratuitous replaceSection calls when only the cursor moved. */
async function computeMetaHash(
	session: NormalizedSession,
	options: { title?: string; status?: string; subAgents: ChildLink[] },
	turns: ReturnType<typeof cleanTurns>,
): Promise<{ overviewMd: string; summaryMd: string; toolsMd: string; warningsMd: string; hash: string }> {
	const overviewMd = renderOverviewBlock(session, options, options.subAgents);
	const summaryMd = renderSummaryBlock(session, turns);
	const toolsMd = renderToolsBlock(session);
	const warningsMd = renderWarningsBlock(session);
	const hash = await contentHash([overviewMd, summaryMd, toolsMd, warningsMd].join("\n\n"));
	return { overviewMd, summaryMd, toolsMd, warningsMd, hash };
}

/** Legacy update path — clear children + append the full render. Used for docs
 *  created before the incremental writer landed; keeping them on this path means
 *  zero migration pain (per the user's C4 migration choice). */
async function upsertDocLegacy(
	deps: ReconcileDeps,
	state: SyncState,
	session: NormalizedSession,
	file: DiscoveredFile,
	result: ReconcileResult,
	childLinks: ChildLink[],
): Promise<void> {
	const key = sessionKey(session);
	const stateKey = fileKey(file.source, file.path);
	const existing = state.sessions[key];
	const now = deps.now ? deps.now() : Date.now();
	const status = inferStatus(session, now);
	const { title, titleSource } = await resolveTitle(deps, session, existing);
	const markdown = renderFullDoc(session, { title, status, subAgents: childLinks.length > 0 ? childLinks : undefined });
	const hash = await contentHash(markdown);

	const refreshCursor = () => {
		state.files[stateKey] = { offset: file.sizeBytes ?? 0, mtimeMs: file.mtimeMs, sessionKey: key };
	};

	if (existing?.docId && existing.contentHash === hash) {
		// Doc existence was already verified by the caller (upsertDoc router) — skip.
		refreshCursor();
		return;
	}

	const docId = existing!.docId!;
	await deps.writer.overwriteDoc({ docId, markdown });
	if (title !== existing?.title) await deps.writer.renameDoc({ docId, title: buildDocName(session, title) });
	await deps.writer.setAttrs({ docId, attrs: buildSiyuanAttrs(session, { hash, title, titleSource, status }) });
	await deps.writer.foldHeadings({ docId, headingPrefixes: FOLDABLE_HEADING_PREFIXES });

	state.sessions[key] = {
		...toRecord(session, { docId }, buildSiyuanDocPath(deps.rootPath, session), hash, title, titleSource, file.sizeBytes, now),
		// Carry forward any legacy fields we want to preserve.
		incrementalEnabled: false,
	};
	refreshCursor();
	result.updatedSessions++;
}

/** Create-fresh path for brand-new sessions (and state-loss recoveries where no
 *  doc was found in state but possibly exists in SiYuan). Always lays down the
 *  full incremental structure with section anchor attrs. */
async function upsertDocCreate(
	deps: ReconcileDeps,
	state: SyncState,
	session: NormalizedSession,
	file: DiscoveredFile,
	result: ReconcileResult,
	childLinks: ChildLink[],
): Promise<void> {
	const key = sessionKey(session);
	const stateKey = fileKey(file.source, file.path);
	const now = deps.now ? deps.now() : Date.now();
	const status = inferStatus(session, now);
	const { title, titleSource } = await resolveTitle(deps, session, state.sessions[key]);
	const subs = childLinks;
	const fullMd = renderFullDoc(session, { title, status, subAgents: subs.length > 0 ? subs : undefined });
	const hash = await contentHash(fullMd);

	// State-loss recovery: a doc with this session-key might exist from a prior
	// run we lost state for. If so, overwrite it (treat as a fresh structure) so
	// future ticks can find anchor blocks.
	let docId: string | undefined = await deps.writer.findDocBySessionKey(key);
	if (docId && !(await deps.writer.docExists(docId))) docId = undefined;
	let isNew = false;
	if (docId) {
		await deps.writer.overwriteDoc({ docId, markdown: fullMd });
	} else {
		const created = await deps.writer.createDoc({
			notebook: deps.notebookId,
			path: buildSiyuanDocPath(deps.rootPath, session),
			markdown: fullMd,
		});
		docId = created.id;
		isNew = true;
	}

	// Tag the section anchors so future ticks can do replaceSection / appendToSection.
	await deps.writer.tagSectionAnchors(docId);

	await deps.writer.renameDoc({ docId, title: buildDocName(session, title) });
	await deps.writer.setAttrs({
		docId,
		attrs: { ...buildSiyuanAttrs(session, { hash, title, titleSource, status }), "custom-ai-part": "1" },
	});
	await deps.writer.foldHeadings({ docId, headingPrefixes: FOLDABLE_HEADING_PREFIXES });

	const turns = cleanTurns(session);
	const { hash: metaHash } = await computeMetaHash(session, { title, status, subAgents: subs }, turns);

	state.sessions[key] = {
		...toRecord(session, { docId }, buildSiyuanDocPath(deps.rootPath, session), hash, title, titleSource, file.sizeBytes, now),
		incrementalEnabled: true,
		partDocIds: [docId],
		appendedMessageCount: session.messages.length,
		appendedToolCount: session.toolActivities.length,
		appendedSubAgentCount: subs.length,
		currentPartBytes: approxByteLen(fullMd),
		metaHash,
	};

	state.files[stateKey] = { offset: file.sizeBytes ?? 0, mtimeMs: file.mtimeMs, sessionKey: key };
	if (isNew) result.newSessions++;
	result.updatedSessions++;
}

/** Update an existing incremental session in place:
 *  - dialog: append-only tail to the active part (spill into a new part doc
 *    when the active part exceeds `partMaxBytes`)
 *  - overview / summary / tools / warnings: section-replace on the PRIMARY part
 *    (only when their joined hash actually moved — most ticks no-op those) */
async function upsertDocIncrementalUpdate(
	deps: ReconcileDeps,
	state: SyncState,
	session: NormalizedSession,
	file: DiscoveredFile,
	result: ReconcileResult,
	childLinks: ChildLink[],
): Promise<void> {
	const key = sessionKey(session);
	const stateKey = fileKey(file.source, file.path);
	const existing = state.sessions[key]!;
	const now = deps.now ? deps.now() : Date.now();
	const status = inferStatus(session, now);
	const { title, titleSource } = await resolveTitle(deps, session, existing);
	const subs = childLinks;
	const partDocIds = existing.partDocIds ?? (existing.docId ? [existing.docId] : []);
	const primaryDocId = partDocIds[0];
	let activeDocId = partDocIds[partDocIds.length - 1];

	const appendedMsgs = existing.appendedMessageCount ?? 0;
	const appendedTools = existing.appendedToolCount ?? 0;
	const appendedSubs = existing.appendedSubAgentCount ?? 0;
	const newMessages = session.messages.slice(appendedMsgs);
	const newTools = session.toolActivities.slice(appendedTools);
	const newSubs = subs.slice(appendedSubs);

	const dialogueChange = newMessages.length > 0 || newTools.length > 0 || newSubs.length > 0;

	// Meta hash gate — saves O(1 SQL + 4 replaceSection) per tick on a session
	// that hasn't visibly changed since last write.
	const turns = cleanTurns(session);
	const meta = await computeMetaHash(session, { title, status, subAgents: subs }, turns);
	const metaChange = meta.hash !== existing.metaHash;

	if (!dialogueChange && !metaChange) {
		state.files[stateKey] = { offset: file.sizeBytes ?? 0, mtimeMs: file.mtimeMs, sessionKey: key };
		return;
	}

	// Update meta sections on the PRIMARY part (only it carries them; new parts
	// only have a navigation header + their own dialog section).
	if (metaChange) {
		await deps.writer.replaceSection(primaryDocId, "overview", meta.overviewMd);
		await deps.writer.replaceSection(primaryDocId, "summary", meta.summaryMd);
		await deps.writer.replaceSection(primaryDocId, "tools", meta.toolsMd);
		await deps.writer.replaceSection(primaryDocId, "warnings", meta.warningsMd);
	}

	// Compute new dialog items (tail) and append.
	const seenSubs = seedSubLabelCounts(subs.slice(0, appendedSubs));
	const newItems = buildIncrementalDialogItems(session, newMessages, newTools, newSubs, seenSubs);
	const tailMd = newItems.length > 0 ? renderDialogTail(newItems, null) : "";
	const addBytes = approxByteLen(tailMd);

	const partMaxBytes = deps.partMaxBytes ?? DEFAULT_PART_MAX_BYTES;
	const currentBytes = existing.currentPartBytes ?? 0;
	let newCurrentPartBytes = currentBytes;
	let newPartDocIds = partDocIds;

	if (tailMd.length > 0 && partMaxBytes > 0 && currentBytes + addBytes > partMaxBytes) {
		// Spill into a new part doc. The new part is a self-contained continuation:
		// nav header pointing back to the previous part + a fresh dialog section.
		const newPartIdx = partDocIds.length + 1;
		const previousTitle = buildDocName(session, title);
		const newPartTitle = `${title} · 续 (${newPartIdx})`;
		const newPartLabel = buildDocName(session, newPartTitle);
		const scaffold = [
			`> ← 上一卷 ((${activeDocId} "${previousTitle.replace(/"/g, "''")}"))`,
			"",
			"## 💬 对话",
			"",
			tailMd,
		].join("\n");

		const created = await deps.writer.createDoc({
			notebook: deps.notebookId,
			path: `${buildSiyuanDocPath(deps.rootPath, session)}-p${newPartIdx}`,
			markdown: scaffold,
		});
		const newPartId = created.id;
		await deps.writer.tagSectionAnchors(newPartId);
		await deps.writer.renameDoc({ docId: newPartId, title: newPartLabel });
		await deps.writer.setAttrs({
			docId: newPartId,
			attrs: {
				"custom-ai-source": session.source,
				"custom-ai-session-id": session.sessionId,
				"custom-ai-session-key": key,
				"custom-ai-part": String(newPartIdx),
				"custom-ai-title": title,
			},
		});

		// Footer on the old active part — link forward.
		const footerMd = `> 续 → 下一卷 ((${newPartId} "${newPartLabel.replace(/"/g, "''")}"))`;
		await deps.writer.appendToSection(activeDocId, "dialog", footerMd);

		newPartDocIds = [...partDocIds, newPartId];
		activeDocId = newPartId;
		newCurrentPartBytes = approxByteLen(scaffold);
	} else if (tailMd.length > 0) {
		await deps.writer.appendToSection(activeDocId, "dialog", tailMd);
		newCurrentPartBytes = currentBytes + addBytes;
	}

	// Refresh top-level doc attrs on the primary so search counters stay current.
	if (metaChange || dialogueChange) {
		// Pass a fresh hash over the full doc structure approximation — used for
		// `custom-ai-content-hash` only. We don't keep the full markdown around;
		// the meta hash is a reasonable proxy.
		await deps.writer.setAttrs({
			docId: primaryDocId,
			attrs: buildSiyuanAttrs(session, { hash: meta.hash, title, titleSource, status }),
		});
	}

	state.sessions[key] = {
		...existing,
		docId: activeDocId,
		partDocIds: newPartDocIds,
		appendedMessageCount: session.messages.length,
		appendedToolCount: session.toolActivities.length,
		appendedSubAgentCount: subs.length,
		currentPartBytes: newCurrentPartBytes,
		metaHash: meta.hash,
		contentHash: meta.hash,
		messageCount: session.messages.length,
		toolCount: session.toolActivities.length,
		failedToolCount: session.toolActivities.filter((t) => t.status === "failure").length,
		updatedAt: session.updatedAt,
		title,
		titleSource,
		lastSourceOffset: file.sizeBytes,
		lastWrittenAt: new Date(now).toISOString(),
	};

	state.files[stateKey] = { offset: file.sizeBytes ?? 0, mtimeMs: file.mtimeMs, sessionKey: key };
	result.updatedSessions++;
}

/** Sub-agent session → a `.md` attachment under data/assets/ (not a document, not
 *  indexed). The parent links to it inline. Deterministic path → overwrite in place. */
async function upsertAttachment(
	deps: ReconcileDeps,
	state: SyncState,
	session: NormalizedSession,
	file: DiscoveredFile,
	result: ReconcileResult,
	childLinks: ChildLink[],
): Promise<void> {
	const key = sessionKey(session);
	const stateKey = fileKey(file.source, file.path);
	const existing = state.sessions[key];
	const now = deps.now ? deps.now() : Date.now();
	const status = inferStatus(session, now);
	const { title, titleSource } = await resolveTitle(deps, session, existing);
	const markdown = renderFullDoc(session, { title, status, subAgents: childLinks.length > 0 ? childLinks : undefined });
	const hash = await contentHash(markdown);

	const refreshCursor = () => {
		state.files[stateKey] = { offset: file.sizeBytes ?? 0, mtimeMs: file.mtimeMs, sessionKey: key };
	};

	if (existing?.assetPath && existing.contentHash === hash) {
		refreshCursor();
		return;
	}

	const assetPath = await deps.writer.putAsset({ relPath: assetRelPath(session), content: markdown });
	state.sessions[key] = toRecord(session, { assetPath }, assetPath, hash, title, titleSource, file.sizeBytes, now);
	refreshCursor();
	if (!existing) result.newSessions++;
	result.updatedSessions++;
}

export async function reconcileOnce(deps: ReconcileDeps): Promise<ReconcileResult> {
	const state = await deps.state.load();
	const result: ReconcileResult = { updatedSessions: 0, newSessions: 0, errors: [] };

	let discovered: DiscoveredFile[];
	try {
		discovered = await deps.files.list();
	} catch (err) {
		result.errors.push(`discovery failed: ${err}`);
		return result;
	}

	// 1. Parse changed files (cursor fast-path skips unchanged ones).
	const entries: Array<{ file: DiscoveredFile; session: NormalizedSession }> = [];
	for (const file of discovered) {
		const stateKey = fileKey(file.source, file.path);
		const cursor = state.files[stateKey];
		const cached = cursor?.sessionKey ? state.sessions[cursor.sessionKey] : undefined;
		// Only trust the fast-path when the source actually reported size+mtime,
		// else a degraded stat (both undefined) would skip a changed file forever.
		if (
			cursor &&
			file.sizeBytes !== undefined &&
			file.mtimeMs !== undefined &&
			cursor.offset === file.sizeBytes &&
			cursor.mtimeMs === file.mtimeMs &&
			(cached?.docId || cached?.assetPath)
		) {
			continue;
		}
		try {
			const content = await deps.files.read(file.path);
			const session = parseFile(file, content);
			if (!session.sessionId) continue;
			entries.push({ file, session });
		} catch (err) {
			result.errors.push(`failed to process ${file.path}: ${err}`);
		}
	}

	// 2. Upsert children first so their docIds exist, then parents rendered with
	//    child links (so a parent re-synced after its children shows them).
	// Upsert deepest-first (leaves before parents) so a node's in-run descendants
	// are already in state when it renders its `## 子代理` links — handles chains
	// A→B→C where B is both a child of A and a parent of C.
	const inSet = new Map<string, { file: DiscoveredFile; session: NormalizedSession }>();
	for (const e of entries) inSet.set(sessionKey(e.session), e);
	const depth = new Map<string, number>();
	const depthOf = (key: string, seen: Set<string> = new Set()): number => {
		if (depth.has(key)) return depth.get(key)!;
		if (seen.has(key)) return 0; // cycle guard
		seen.add(key);
		const e = inSet.get(key)!;
		const pk = e.session.parentSessionId ? `${e.session.source}:${e.session.parentSessionId}` : undefined;
		const d = pk && inSet.has(pk) ? 1 + depthOf(pk, seen) : 0;
		depth.set(key, d);
		return d;
	};
	const ordered = [...entries].sort((a, b) => depthOf(sessionKey(b.session)) - depthOf(sessionKey(a.session)));
	if (ordered.length > 0) console.log(`[session-sync] processing ${ordered.length} changed sessions…`);
	// Settle-gate: skip sessions still being actively written; they get written
	// once they go idle. We deliberately do NOT refresh their cursor, so the next
	// tick re-evaluates them as the clock advances past the settle window (even if
	// the file stops changing). A re-activated session re-enters here and defers
	// again until it re-settles, then overwrites its existing doc (same docId).
	const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
	const nowTs = deps.now ? deps.now() : Date.now();
	let processed = 0;
	let deferred = 0;
	for (const { file, session } of ordered) {
		const updated = Date.parse(session.updatedAt);
		if (settleMs > 0 && !Number.isNaN(updated) && nowTs - updated < settleMs) {
			deferred++;
			continue;
		}
		try {
			const childLinks = collectChildLinks(state, session.source, session.sessionId);
			if (session.isSubAgent) {
				await upsertAttachment(deps, state, session, file, result, childLinks);
			} else {
				await upsertDoc(deps, state, session, file, result, childLinks);
			}
		} catch (err) {
			result.errors.push(`failed to upsert ${file.path}: ${err}`);
		}
		if (++processed % 25 === 0) console.log(`[session-sync] ${processed}/${ordered.length} (new ${result.newSessions}, err ${result.errors.length})`);
		if (deps.upsertDelayMs && processed < ordered.length) await new Promise((r) => setTimeout(r, deps.upsertDelayMs));
	}

	if (deferred > 0) console.log(`[session-sync] deferred ${deferred} still-active session(s) (settle <${Math.round(settleMs / 60000)}min)`);
	state.lastSyncAt = deps.now ? deps.now() : Date.now();
	await deps.state.save(state);
	return result;
}
