/** Capability detection + smart defaults so session sync adapts across
 *  deployments (same-machine desktop / Windows+WSL / Docker / mobile).
 *
 *  Reads `window.siyuan.config.system` (container/os/homeDir) and whether a Node
 *  `require` is reachable, then picks one of three runtime tiers. Pure helpers are
 *  injectable for tests. See plan §4/§5/§17. */

export type Container = "std" | "docker" | "android" | "ios" | "harmony" | "unknown";
export type Os = "windows" | "darwin" | "linux" | "unknown";
export type SyncTier = "in-plugin" | "sidecar" | "viewer";

export interface SystemConfig {
	os?: string;
	container?: string;
	homeDir?: string;
}

export interface EnvInfo {
	os: Os;
	container: Container;
	homeDir: string;
	hasNode: boolean;
	isDesktop: boolean;
	isMobile: boolean;
}

function normOs(os?: string): Os {
	return os === "windows" || os === "darwin" || os === "linux" ? os : "unknown";
}

function normContainer(c?: string): Container {
	return c === "std" || c === "docker" || c === "android" || c === "ios" || c === "harmony" ? c : "unknown";
}

/** Read SiYuan's frontend system config; tolerant of being run outside SiYuan. */
export function readSystemConfig(): SystemConfig {
	const sys = (globalThis as { siyuan?: { config?: { system?: SystemConfig } } }).siyuan?.config?.system;
	return sys ?? {};
}

/** Whether an Electron-style `require` is reachable (desktop only). */
export function hasNodeRequire(): boolean {
	const g = globalThis as { require?: unknown };
	const w = typeof window !== "undefined" ? (window as { require?: unknown }) : undefined;
	return typeof g.require === "function" || typeof w?.require === "function";
}

export function detectEnvironment(
	sys: SystemConfig = readSystemConfig(),
	nodeAvailable: boolean = hasNodeRequire(),
): EnvInfo {
	const container = normContainer(sys.container);
	const isMobile = container === "android" || container === "ios" || container === "harmony";
	const isDesktop = container === "std";
	return {
		os: normOs(sys.os),
		container,
		homeDir: sys.homeDir ?? "",
		hasNode: nodeAvailable,
		isDesktop,
		isMobile,
	};
}

/** Pick the runtime tier from capabilities:
 *  - mobile → viewer (logs aren't on the device)
 *  - desktop with Node → in-plugin reader
 *  - everything else (docker/browser/no-Node) → external sidecar */
export function decideTier(env: EnvInfo): SyncTier {
	if (env.isMobile) return "viewer";
	if (env.isDesktop && env.hasNode) return "in-plugin";
	return "sidecar";
}

function joinNative(os: Os, base: string, ...parts: string[]): string {
	const sep = os === "windows" ? "\\" : "/";
	const trimmed = base.replace(/[\\/]+$/, "");
	return [trimmed, ...parts].join(sep);
}

/** Best-effort default source roots from the kernel's homeDir. ⚠ On Windows the
 *  homeDir is the *Windows* user (e.g. `C:\Users\1`); if the logs live in WSL the
 *  user must point these at a UNC path instead — see `wslSourcePathTemplate`. */
export function defaultSourcePaths(env: EnvInfo): { codex: string[]; claude: string[] } {
	const home = env.homeDir || (env.os === "windows" ? "C:\\Users" : "~");
	return {
		codex: [joinNative(env.os, home, ".codex", "sessions")],
		claude: [joinNative(env.os, home, ".claude", "projects")],
	};
}

/** UNC template for Windows-host SiYuan reading WSL logs. distro/user are
 *  user-supplied (enumerate distros via `wsl.exe -l -q` in the UI). */
export function wslSourcePathTemplate(distro = "Ubuntu", user = "USERNAME"): { codex: string; claude: string } {
	const base = `\\\\wsl.localhost\\${distro}\\home\\${user}`;
	return { codex: `${base}\\.codex\\sessions`, claude: `${base}\\.claude\\projects` };
}
