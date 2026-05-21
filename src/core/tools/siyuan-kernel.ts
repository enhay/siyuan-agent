import { siyuanFetch } from "./siyuan-api";

/** A fetcher matches the `siyuanFetch` signature: POST a kernel API, return `resp.data`. */
export type KernelFetcher = (url: string, data: unknown) => Promise<any>;

/** Quote and escape a string value for safe inline use in SQL.
 *  `sqlValue("O'Brien")` → `'O''Brien'`. */
export function sqlValue(v: string): string {
	return `'${v.replace(/'/g, "''")}'`;
}

/** Named SiYuan REST operations bound to a single fetcher.
 *
 *  This is the one place that knows SiYuan's URLs, payload shapes, and
 *  implicit defaults (e.g. `dataType: "markdown"`). Tools call named
 *  operations; nothing else hardcodes `/api/...`. */
export interface SiyuanKernel {
	blocks: {
		getKramdowns: (ids: string[]) => Promise<Record<string, string>>;
		getTreeInfos: (ids: string[]) => Promise<Record<string, any>>;
		getChildren: (id: string) => Promise<any[]>;
		insert: (req: { data: string; previousID?: string; parentID?: string; dataType?: string }) => Promise<any>;
		prepend: (req: { data: string; parentID: string; dataType?: string }) => Promise<any>;
		append: (req: { data: string; parentID: string; dataType?: string }) => Promise<any>;
		delete: (id: string) => Promise<any>;
	};
	filetree: {
		createDocWithMd: (req: { notebook: string; path: string; markdown: string }) => Promise<string>;
		moveDocsByID: (fromIDs: string[], toID: string) => Promise<any>;
		renameDocByID: (id: string, title: string) => Promise<any>;
		removeDocByID: (id: string) => Promise<any>;
		getIDsByHPath: (notebook: string, path: string) => Promise<string[]>;
		getPathByID: (id: string) => Promise<{ notebook?: string; path?: string }>;
		listDocsByPath: (req: { notebook: string; path: string; maxListCount: number }) => Promise<{ files?: any[] }>;
		getHPathByID: (id: string) => Promise<string>;
	};
	notebooks: {
		list: () => Promise<{ notebooks?: any[] }>;
		create: (name: string) => Promise<{ notebook?: { id: string; name: string; closed?: boolean } }>;
		open: (notebook: string) => Promise<any>;
	};
	exportApi: {
		mdContent: (id: string) => Promise<{ content?: string; hPath?: string }>;
	};
	search: {
		fullText: (req: {
			query: string;
			page: number;
			pageSize: number;
			types: Record<string, boolean>;
			method: number;
			orderBy: number;
			groupBy: number;
		}) => Promise<any>;
	};
	/** Typed SQL query. Interpolate string values via `sqlValue`. */
	sql: <T = any>(stmt: string) => Promise<T[]>;
}

/** Build a kernel bound to a fetcher (defaults to the real `siyuanFetch`).
 *  Pass an injected fetcher to keep dependency-injection testability. */
export function makeKernel(fetch: KernelFetcher = siyuanFetch): SiyuanKernel {
	return {
		blocks: {
			getKramdowns: (ids) => fetch("/api/block/getBlockKramdowns", { ids }),
			getTreeInfos: (ids) => fetch("/api/block/getBlockTreeInfos", { ids }),
			getChildren: (id) => fetch("/api/block/getChildBlocks", { id }),
			insert: ({ dataType = "markdown", ...rest }) =>
				fetch("/api/block/insertBlock", { dataType, ...rest }),
			prepend: ({ dataType = "markdown", ...rest }) =>
				fetch("/api/block/prependBlock", { dataType, ...rest }),
			append: ({ dataType = "markdown", ...rest }) =>
				fetch("/api/block/appendBlock", { dataType, ...rest }),
			delete: (id) => fetch("/api/block/deleteBlock", { id }),
		},
		filetree: {
			createDocWithMd: ({ notebook, path, markdown }) =>
				fetch("/api/filetree/createDocWithMd", { notebook, path, markdown }),
			moveDocsByID: (fromIDs, toID) =>
				fetch("/api/filetree/moveDocsByID", { fromIDs, toID }),
			renameDocByID: (id, title) =>
				fetch("/api/filetree/renameDocByID", { id, title }),
			removeDocByID: (id) =>
				fetch("/api/filetree/removeDocByID", { id }),
			getIDsByHPath: (notebook, path) =>
				fetch("/api/filetree/getIDsByHPath", { notebook, path }),
			getPathByID: (id) =>
				fetch("/api/filetree/getPathByID", { id }),
			listDocsByPath: ({ notebook, path, maxListCount }) =>
				fetch("/api/filetree/listDocsByPath", { notebook, path, maxListCount, ignoreMaxListHint: true }),
			getHPathByID: (id) =>
				fetch("/api/filetree/getHPathByID", { id }),
		},
		notebooks: {
			list: () => fetch("/api/notebook/lsNotebooks", {}),
			create: (name) => fetch("/api/notebook/createNotebook", { name }),
			open: (notebook) => fetch("/api/notebook/openNotebook", { notebook }),
		},
		exportApi: {
			mdContent: (id) => fetch("/api/export/exportMdContent", { id }),
		},
		search: {
			fullText: (req) => fetch("/api/search/fullTextSearchBlock", req),
		},
		sql: (stmt) => fetch("/api/query/sql", { stmt }),
	};
}

/** The default kernel backed by the real `siyuanFetch`. */
export const kernel = makeKernel();
