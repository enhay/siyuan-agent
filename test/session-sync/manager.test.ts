import { describe, expect, it, vi } from "vitest";
import { SessionSyncManager, type SyncRunner } from "../../src/core/session-sync/manager";
import type { SessionSyncConfig } from "../../src/core/session-sync/config";
import type { ReconcileResult } from "../../src/core/session-sync/engine/types";

function cfg(over: Partial<SessionSyncConfig> = {}): SessionSyncConfig {
	return {
		enabled: true,
		sources: { codex: true, claude: true },
		sourcePaths: { codex: ["/c"], claude: ["/cl"] },
		rootPath: "/AI",
		pollIntervalSec: 60,
		backfillDays: 7,
		backfillLimit: 50,
		aiTitle: { enabled: false },
		...over,
	};
}

const ok = (): ReconcileResult => ({ updatedSessions: 1, newSessions: 1, errors: [] });

class FakeRunner implements SyncRunner {
	signature = "sig-1";
	probeCalls = 0;
	reconcileCalls = 0;
	result: ReconcileResult = ok();
	throwOnReconcile = false;
	async probe() {
		this.probeCalls++;
		return this.signature;
	}
	async reconcile() {
		this.reconcileCalls++;
		if (this.throwOnReconcile) throw new Error("boom");
		return this.result;
	}
}

function make(runner: SyncRunner | null, config = cfg()) {
	const statuses: string[] = [];
	const mgr = new SessionSyncManager({
		getConfig: () => config,
		getRunner: () => runner,
		onStatusChange: (s) => statuses.push(s.state),
		now: () => 1000,
	});
	return { mgr, statuses };
}

describe("SessionSyncManager", () => {
	it("disabled config → no reconcile, status disabled", async () => {
		const runner = new FakeRunner();
		const { mgr } = make(runner, cfg({ enabled: false }));
		await mgr.syncNow();
		expect(runner.reconcileCalls).toBe(0);
		expect(mgr.getStatus().state).toBe("disabled");
	});

	it("null runner (wrong tier) → disabled", async () => {
		const { mgr } = make(null);
		await mgr.syncNow();
		expect(mgr.getStatus().state).toBe("disabled");
	});

	it("unchanged signature → reconcile NOT called on a normal tick", async () => {
		const runner = new FakeRunner();
		const { mgr } = make(runner);
		await (mgr as unknown as { tick: (f?: boolean) => Promise<unknown> }).tick();
		expect(runner.reconcileCalls).toBe(1); // first run: lastSignature was null → changed
		await (mgr as unknown as { tick: (f?: boolean) => Promise<unknown> }).tick();
		expect(runner.reconcileCalls).toBe(1); // same signature → skipped
	});

	it("changed signature → reconcile runs again", async () => {
		const runner = new FakeRunner();
		const { mgr } = make(runner);
		await (mgr as unknown as { tick: () => Promise<unknown> }).tick();
		runner.signature = "sig-2";
		await (mgr as unknown as { tick: () => Promise<unknown> }).tick();
		expect(runner.reconcileCalls).toBe(2);
	});

	it("syncNow forces reconcile even when signature is unchanged", async () => {
		const runner = new FakeRunner();
		const { mgr } = make(runner);
		await (mgr as unknown as { tick: () => Promise<unknown> }).tick();
		expect(runner.reconcileCalls).toBe(1);
		await mgr.syncNow();
		expect(runner.reconcileCalls).toBe(2);
	});

	it("records result + lastSyncAt and emits idle on success", async () => {
		const runner = new FakeRunner();
		const { mgr, statuses } = make(runner);
		await mgr.syncNow();
		const st = mgr.getStatus();
		expect(st.state).toBe("idle");
		expect(st.lastSyncAt).toBe(1000);
		expect(st.lastResult).toEqual(ok());
		expect(statuses).toContain("syncing");
	});

	it("reconcile throwing → error status", async () => {
		const runner = new FakeRunner();
		runner.throwOnReconcile = true;
		const { mgr } = make(runner);
		await mgr.syncNow();
		expect(mgr.getStatus().state).toBe("error");
		expect(mgr.getStatus().lastError).toContain("boom");
	});

	it("errors in result → error status", async () => {
		const runner = new FakeRunner();
		runner.result = { updatedSessions: 0, newSessions: 0, errors: ["x failed"] };
		const { mgr } = make(runner);
		await mgr.syncNow();
		expect(mgr.getStatus().state).toBe("error");
	});

	it("start runs an immediate tick and registers a timer", async () => {
		const runner = new FakeRunner();
		const setTimer = vi.fn(() => 42 as unknown as ReturnType<typeof setInterval>);
		const clearTimer = vi.fn();
		const mgr = new SessionSyncManager({
			getConfig: () => cfg(),
			getRunner: () => runner,
			setTimer,
			clearTimer,
		});
		mgr.start();
		expect(setTimer).toHaveBeenCalledOnce();
		mgr.stop();
		expect(clearTimer).toHaveBeenCalledWith(42);
	});
});
