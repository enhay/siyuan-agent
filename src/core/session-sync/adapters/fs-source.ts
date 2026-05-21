/** FileSource backed by Node `fs` (desktop Electron renderer via `window.require`).
 *
 *  Reads codex/claude logs from configurable roots — native paths on same-machine
 *  setups, or `\\wsl.localhost\<distro>\…` UNC when SiYuan runs on Windows and the
 *  logs live in WSL. No native FS events over UNC, so the manager polls; `probe()`
 *  returns a cheap signature (count + max mtime over the backfill window) that
 *  catches appends to active sessions. See plan §4/§7.
 *
 *  `fs` is injectable for tests. */

import type { DiscoveredFile, FileSource } from "../engine/ports";
import type { SessionSource } from "../engine/types";

export interface FsPromisesLike {
	readdir(path: string, opts: { withFileTypes: true }): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>;
	readFile(path: string, encoding: "utf-8"): Promise<string>;
	stat(path: string): Promise<{ size: number; mtimeMs: number }>;
}

export interface FsSourceConfig {
	sources: { codex: boolean; claude: boolean };
	sourcePaths: { codex: string[]; claude: string[] };
	backfillDays: number;
	backfillLimit: number;
}

interface Gathered {
	source: SessionSource;
	path: string;
	mtimeMs: number;
	sizeBytes: number;
}

function defaultFsPromises(): FsPromisesLike {
	const req =
		(globalThis as unknown as { require?: (m: string) => unknown }).require ??
		(typeof window !== "undefined" ? (window as unknown as { require?: (m: string) => unknown }).require : undefined);
	if (typeof req !== "function") {
		throw new Error("Node fs unavailable — session sync in-plugin reader is desktop-only");
	}
	return (req("fs") as { promises: FsPromisesLike }).promises;
}

function joinPath(base: string, name: string): string {
	const sep = base.includes("\\") ? "\\" : "/";
	return base.endsWith(sep) ? base + name : base + sep + name;
}

async function walkJsonl(fs: FsPromisesLike, dir: string, out: string[]): Promise<void> {
	let entries: Awaited<ReturnType<FsPromisesLike["readdir"]>>;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return; // missing/unreadable root (e.g. WSL down) → no-op, not an error
	}
	for (const entry of entries) {
		const full = joinPath(dir, entry.name);
		if (entry.isDirectory()) await walkJsonl(fs, full, out);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
	}
}

export function createFsSource(config: FsSourceConfig, fs: FsPromisesLike = defaultFsPromises()): FileSource {
	async function gather(): Promise<Gathered[]> {
		const cutoff = Date.now() - config.backfillDays * 24 * 60 * 60 * 1000;
		const all: Gathered[] = [];
		const roots: Array<{ source: SessionSource; root: string }> = [];
		if (config.sources.codex) for (const r of config.sourcePaths.codex) roots.push({ source: "codex", root: r });
		if (config.sources.claude) for (const r of config.sourcePaths.claude) roots.push({ source: "claude", root: r });

		for (const { source, root } of roots) {
			const paths: string[] = [];
			await walkJsonl(fs, root, paths);
			const stats = await Promise.all(
				paths.map(async (path) => {
					try {
						const s = await fs.stat(path);
						return { source, path, mtimeMs: s.mtimeMs, sizeBytes: s.size };
					} catch {
						return undefined;
					}
				}),
			);
			for (const s of stats) if (s && s.mtimeMs >= cutoff) all.push(s);
		}

		all.sort((a, b) => b.mtimeMs - a.mtimeMs);
		return all.slice(0, config.backfillLimit);
	}

	return {
		async list(): Promise<DiscoveredFile[]> {
			return (await gather()).map((g) => ({
				source: g.source,
				path: g.path,
				mtimeMs: g.mtimeMs,
				sizeBytes: g.sizeBytes,
			}));
		},
		async read(path: string): Promise<string> {
			return fs.readFile(path, "utf-8");
		},
		async probe(): Promise<string> {
			const files = await gather();
			let maxMtime = 0;
			let totalSize = 0;
			for (const f of files) {
				if (f.mtimeMs > maxMtime) maxMtime = f.mtimeMs;
				totalSize += f.sizeBytes;
			}
			return `${files.length}:${maxMtime}:${totalSize}`;
		},
	};
}
