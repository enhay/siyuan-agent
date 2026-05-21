import { extractDocumentSummary, type SiyuanApiFetcher } from "./list-documents";
import { makeKernel, type SiyuanKernel } from "./tools/siyuan-kernel";

export interface RecentDocumentsInput {
	limit?: number;
}

export interface RecentDocumentsItem {
	id: string;
	title: string;
	hpath: string;
	summary?: string;
}

export interface RecentDocumentsResult {
	limit: number;
	total: number;
	items: RecentDocumentsItem[];
}

interface RecentDocumentIdRow {
	id: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.floor(value as number)));
}

function isRecentDocumentIdRow(value: any): value is RecentDocumentIdRow {
	return "string" === typeof value?.id && value.id.length > 0;
}

function buildRecentDocumentsSql(limit: number): string {
	// `limit` is an already-clamped integer; interpolate as a bare number
	// (not via sqlValue, which would wrongly quote it).
	return [
		"SELECT id",
		"FROM blocks",
		"WHERE type = 'd'",
		"ORDER BY updated DESC",
		`LIMIT ${Number(limit)}`,
	].join(" ");
}

function getTitleFromHPath(hpath: string, fallbackId: string): string {
	const trimmed = hpath.trim();
	if (!trimmed) {
		return fallbackId;
	}

	const segments = trimmed.split("/").filter(Boolean);
	return segments[segments.length - 1] || fallbackId;
}

async function fetchRecentDocumentItem(
	id: string,
	kernel: SiyuanKernel,
): Promise<RecentDocumentsItem> {
	const data = await kernel.exportApi.mdContent(id);
	const hpath = "string" === typeof data?.hPath ? data.hPath : "";
	const content = "string" === typeof data?.content ? data.content : "";
	const item: RecentDocumentsItem = {
		id,
		title: getTitleFromHPath(hpath, id),
		hpath,
	};

	const summary = extractDocumentSummary(content);
	if (summary) {
		item.summary = summary;
	}

	return item;
}

export async function recentDocumentsViaApi(
	input: RecentDocumentsInput,
	fetcher: SiyuanApiFetcher,
): Promise<RecentDocumentsResult> {
	const kernel = makeKernel(fetcher);
	const limit = clampInteger(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
	const stmt = buildRecentDocumentsSql(limit);
	const data = await kernel.sql(stmt);
	const rows = Array.isArray(data) ? data.filter(isRecentDocumentIdRow) : [];
	const items = await Promise.all(rows.map((row) => fetchRecentDocumentItem(row.id, kernel)));

	return {
		limit,
		total: items.length,
		items,
	};
}
