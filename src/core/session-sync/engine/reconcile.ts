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
import { renderSession, FOLDABLE_HEADING_PREFIXES } from "./render";
import { buildSiyuanAttrs, buildSiyuanDocPath, contentHash, fileKey, inferTitle, sessionKey } from "./identity";
import { inferStatus } from "./status";
import { collectChildLinks, pendingChildMoves, pendingBacklinks, type ChildLink } from "./aggregate";

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
}

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
	if (deps.aiTitleEnabled && deps.titleProvider) {
		const ai = await deps.titleProvider
			.generate({ title: inferTitle(session), firstUserMessage: session.messages.find((m) => m.role === "user")?.text })
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
	docId: string,
	path: string,
	hash: string,
	title: string,
	titleSource: "ai" | "heuristic",
	sizeBytes: number | undefined,
	now: number,
): SessionRecord {
	return {
		target: "siyuan",
		docId,
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

async function upsert(
	deps: ReconcileDeps,
	state: SyncState,
	session: NormalizedSession,
	file: DiscoveredFile,
	result: ReconcileResult,
	childLinks: ChildLink[] = [],
): Promise<void> {
	const key = sessionKey(session);
	const stateKey = fileKey(file.source, file.path);
	const existing = state.sessions[key];
	const now = deps.now ? deps.now() : Date.now();
	const status = inferStatus(session, now);
	const { title, titleSource } = await resolveTitle(deps, session, existing);
	const markdown = renderSession(session, { title, status, subAgents: childLinks.length > 0 ? childLinks : undefined });
	const hash = await contentHash(markdown);

	const refreshCursor = () => {
		state.files[stateKey] = { offset: file.sizeBytes ?? 0, mtimeMs: file.mtimeMs, sessionKey: key };
	};

	// Content unchanged → only advance the file cursor, no kernel writes.
	if (existing?.docId && existing.contentHash === hash && (await deps.writer.docExists(existing.docId))) {
		refreshCursor();
		return;
	}

	let docId = existing?.docId;
	if (docId && !(await deps.writer.docExists(docId))) docId = undefined; // user deleted it
	if (!docId) docId = await deps.writer.findDocBySessionKey(key); // state-loss recovery
	let isNew = false;

	if (docId) {
		await deps.writer.overwriteDoc({ docId, markdown });
	} else {
		const created = await deps.writer.createDoc({
			notebook: deps.notebookId,
			path: buildSiyuanDocPath(deps.rootPath, session),
			markdown,
		});
		docId = created.id;
		isNew = true;
	}

	// Always set the readable title on a fresh doc (its file-tree name is the slug
	// path leaf until renamed); otherwise only when it actually changed (anti-churn).
	if (isNew || title !== existing?.title) await deps.writer.renameDoc({ docId, title });
	await deps.writer.setAttrs({ docId, attrs: buildSiyuanAttrs(session, { hash, title, titleSource, status }) });
	// Collapse tool/warning sections by default (heading fold attr).
	await deps.writer.foldHeadings({ docId, headingPrefixes: FOLDABLE_HEADING_PREFIXES });

	const record = toRecord(session, docId, buildSiyuanDocPath(deps.rootPath, session), hash, title, titleSource, file.sizeBytes, now);
	record.movedUnderParent = existing?.movedUnderParent; // preserve aggregation flag
	state.sessions[key] = record;
	refreshCursor();
	if (isNew) result.newSessions++;
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
			cached?.docId
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
	let processed = 0;
	for (const { file, session } of ordered) {
		try {
			await upsert(deps, state, session, file, result, collectChildLinks(state, session.source, session.sessionId));
		} catch (err) {
			result.errors.push(`failed to upsert ${file.path}: ${err}`);
		}
		if (++processed % 25 === 0) console.log(`[session-sync] ${processed}/${ordered.length} (new ${result.newSessions}, err ${result.errors.length})`);
	}

	// 3. Nest children under their parent docs (idempotent via movedUnderParent).
	for (const move of pendingChildMoves(state)) {
		try {
			await deps.writer.moveUnder({ childIds: [move.childDocId], parentDocId: move.parentDocId });
			const rec = state.sessions[move.childSessionKey];
			if (rec) rec.movedUnderParent = move.parentDocId;
		} catch (err) {
			result.errors.push(`failed to nest ${move.childSessionKey}: ${err}`);
		}
	}

	// 4. Back-link each child to its parent doc (idempotent via backLinkedTo).
	for (const link of pendingBacklinks(state)) {
		try {
			await deps.writer.prependBacklink({ childDocId: link.childDocId, parentDocId: link.parentDocId, parentTitle: link.parentTitle });
			const rec = state.sessions[link.childSessionKey];
			if (rec) rec.backLinkedTo = link.parentDocId;
		} catch (err) {
			result.errors.push(`failed to back-link ${link.childSessionKey}: ${err}`);
		}
	}

	state.lastSyncAt = deps.now ? deps.now() : Date.now();
	await deps.state.save(state);
	return result;
}
