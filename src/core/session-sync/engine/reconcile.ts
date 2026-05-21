/** Incremental reconcile: discover → skip-unchanged → parse → render → upsert.
 *
 *  Pure orchestration over the ports (FileSource / SiyuanWriter / StateStore).
 *  Flat per-session upsert; sub-agent aggregation lands in Phase 5.
 *
 *  Dedup/identity is by docId + `custom-ai-session-key` (never by re-creating at
 *  a path — kernel `createDocWithMd` makes a sibling on path collision). Update
 *  overwrites the body via the writer's clear-children+append (kernel `updateBlock`
 *  only keeps FirstChild). See plan §8. */

import type { DiscoveredFile, FileSource, SiyuanWriter, StateStore } from "./ports";
import type { NormalizedSession, ReconcileResult, SessionRecord, SyncState } from "./types";
import { parseCodexSession } from "./parse/codex";
import { parseClaudeSession } from "./parse/claude";
import { renderSession } from "./render";
import { buildSiyuanAttrs, buildSiyuanDocPath, contentHash, fileKey, inferTitle, sessionKey } from "./identity";

export interface ReconcileDeps {
	files: FileSource;
	writer: SiyuanWriter;
	state: StateStore;
	notebookId: string;
	rootPath: string;
	now?: () => number;
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
	sizeBytes: number | undefined,
	now: number,
): SessionRecord {
	return {
		target: "siyuan",
		docId,
		path,
		title,
		titleSource: "heuristic",
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
): Promise<void> {
	const key = sessionKey(session);
	const stateKey = fileKey(file.source, file.path);
	const markdown = renderSession(session);
	const hash = await contentHash(markdown);
	const existing = state.sessions[key];

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

	const title = inferTitle(session);
	// Always set the readable title on a fresh doc (its file-tree name is the slug
	// path leaf until renamed); otherwise only when it actually changed (anti-churn).
	if (isNew || title !== existing?.title) await deps.writer.renameDoc({ docId, title });
	await deps.writer.setAttrs({ docId, attrs: buildSiyuanAttrs(session, { hash, title, titleSource: "heuristic" }) });

	const now = deps.now ? deps.now() : Date.now();
	state.sessions[key] = toRecord(session, docId, buildSiyuanDocPath(deps.rootPath, session), hash, title, file.sizeBytes, now);
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

	for (const file of discovered) {
		const stateKey = fileKey(file.source, file.path);
		const cursor = state.files[stateKey];
		const cached = cursor?.sessionKey ? state.sessions[cursor.sessionKey] : undefined;
		// Fast path: file size + mtime unchanged and we still have a doc → skip.
		// Only trust it when the source actually reported a signature, else a
		// degraded stat (both undefined) would skip a changed file forever.
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
			await upsert(deps, state, session, file, result);
		} catch (err) {
			result.errors.push(`failed to process ${file.path}: ${err}`);
		}
	}

	await deps.state.save(state);
	return result;
}
