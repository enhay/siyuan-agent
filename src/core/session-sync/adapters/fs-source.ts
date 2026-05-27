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
import { getNodeRequire } from "../node-require";

export interface FsPromisesLike {
	readdir(path: string, opts: { withFileTypes: true }): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>;
	readFile(path: string, encoding: "utf-8"): Promise<string>;
	stat(path: string): Promise<{ size: number; mtimeMs: number }>;
	/** Open a file for random-access read. Optional — when missing,
	 *  `read(path, fromOffset)` falls back to a full readFile + slice. The plugin
	 *  injects the real `fs.promises.open`; tests can omit it. */
	open?(path: string, flags: string): Promise<FsFileHandleLike>;
}

/** Subset of Node's `FileHandle` we use for offset reads. */
export interface FsFileHandleLike {
	stat(): Promise<{ size: number }>;
	read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
	close(): Promise<void>;
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
	const req = getNodeRequire();
	if (!req) {
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
		const t0 = Date.now();
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
		const kept = all.slice(0, config.backfillLimit);
		console.log(`[session-sync] scan: ${all.length} in-window files in ${Date.now() - t0}ms, kept ${kept.length}`);
		return kept;
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
		async read(path: string, fromOffset?: number): Promise<string> {
			// Full read: avoid the open/close overhead and use a single syscall.
			if (!fromOffset || fromOffset <= 0) {
				return fs.readFile(path, "utf-8");
			}
			// Random-access incremental read: only the bytes at/after `fromOffset`.
			// Caps memory at the size of the delta, not the whole-file size —
			// matters when a single jsonl is 100s of MB.
			if (fs.open) {
				const handle = await fs.open(path, "r");
				try {
					const st = await handle.stat();
					const remaining = st.size - fromOffset;
					if (remaining <= 0) return "";
					const buf = new Uint8Array(remaining);
					await handle.read(buf, 0, remaining, fromOffset);
					return new TextDecoder("utf-8").decode(buf);
				} finally {
					await handle.close().catch(() => undefined);
				}
			}
			// Fallback: full read then slice. Loses the memory benefit but keeps
			// behavior correct against in-memory test doubles that don't implement open.
			const whole = await fs.readFile(path, "utf-8");
			// Slice by bytes: encode + offset + decode. UTF-8 boundary safe because
			// JSONL lines end at "\n" which is a single ASCII byte.
			const bytes = new TextEncoder().encode(whole);
			return new TextDecoder("utf-8").decode(bytes.subarray(fromOffset));
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
