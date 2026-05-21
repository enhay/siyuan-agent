import { describe, expect, it } from "vitest";
import {
	decideTier,
	defaultSourcePaths,
	detectEnvironment,
	wslSourcePathTemplate,
	type EnvInfo,
} from "../../src/core/session-sync/env-probe";
import { defaultSessionSyncConfig, normalizeSessionSyncConfig } from "../../src/core/session-sync/config";

const env = (over: Partial<EnvInfo> = {}): EnvInfo => ({
	os: "linux",
	container: "std",
	homeDir: "/home/z",
	hasNode: true,
	isDesktop: true,
	isMobile: false,
	...over,
});

describe("detectEnvironment", () => {
	it("maps system config + node flag", () => {
		const e = detectEnvironment({ os: "windows", container: "std", homeDir: "C:\\Users\\1" }, true);
		expect(e).toMatchObject({ os: "windows", container: "std", homeDir: "C:\\Users\\1", hasNode: true, isDesktop: true, isMobile: false });
	});
	it("flags mobile containers", () => {
		expect(detectEnvironment({ container: "android" }, false).isMobile).toBe(true);
		expect(detectEnvironment({ container: "ios" }, false).isMobile).toBe(true);
	});
	it("tolerates unknown/missing config", () => {
		const e = detectEnvironment({}, false);
		expect(e.os).toBe("unknown");
		expect(e.container).toBe("unknown");
		expect(e.isDesktop).toBe(false);
	});
});

describe("decideTier", () => {
	it("desktop + node → in-plugin", () => expect(decideTier(env())).toBe("in-plugin"));
	it("desktop without node → sidecar", () => expect(decideTier(env({ hasNode: false }))).toBe("sidecar"));
	it("docker → sidecar", () => expect(decideTier(env({ container: "docker", isDesktop: false }))).toBe("sidecar"));
	it("mobile → viewer", () => expect(decideTier(env({ container: "android", isDesktop: false, isMobile: true }))).toBe("viewer"));
});

describe("defaultSourcePaths", () => {
	it("uses POSIX separators on linux/mac", () => {
		expect(defaultSourcePaths(env({ os: "linux", homeDir: "/home/z" }))).toEqual({
			codex: ["/home/z/.codex/sessions"],
			claude: ["/home/z/.claude/projects"],
		});
	});
	it("uses backslashes on windows", () => {
		expect(defaultSourcePaths(env({ os: "windows", homeDir: "C:\\Users\\1" }))).toEqual({
			codex: ["C:\\Users\\1\\.codex\\sessions"],
			claude: ["C:\\Users\\1\\.claude\\projects"],
		});
	});
	it("wslSourcePathTemplate builds a UNC path", () => {
		expect(wslSourcePathTemplate("Ubuntu", "zhaohua").codex).toBe("\\\\wsl.localhost\\Ubuntu\\home\\zhaohua\\.codex\\sessions");
	});
});

describe("session-sync config", () => {
	it("defaults are sane and disabled", () => {
		const c = defaultSessionSyncConfig(env());
		expect(c.enabled).toBe(false);
		expect(c.rootPath).toBe("/AI 会话");
		expect(c.pollIntervalSec).toBe(60);
		expect(c.sources).toEqual({ codex: true, claude: true });
	});
	it("normalize fills missing fields and keeps provided ones", () => {
		const c = normalizeSessionSyncConfig(env(), { enabled: true, rootPath: "/X", sourcePaths: { codex: ["/custom"], claude: [] } });
		expect(c.enabled).toBe(true);
		expect(c.rootPath).toBe("/X");
		expect(c.sourcePaths.codex).toEqual(["/custom"]);
		expect(c.sourcePaths.claude).toEqual(["/home/z/.claude/projects"]); // empty → default
		expect(c.backfillDays).toBe(7); // missing → default
	});
});
