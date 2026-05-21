/** SessionSyncManager — owns the change-detection poll loop, re-entrancy guard,
 *  and status. Deliberately separate from ScheduledTaskManager (that runs LLM
 *  agent prompts on cron; sync is deterministic I/O). See plan §7.
 *
 *  Timing/gating live here; the actual probe + reconcile come from an injected
 *  SyncRunner, so this is unit-testable without fs/kernel and the same manager
 *  drives any runtime tier. */

import type { ReconcileResult } from "./engine/types";
import type { SessionSyncConfig } from "./config";

export interface SyncRunner {
	/** Cheap signature over the backfill window; reconcile only runs when it moves. */
	probe(): Promise<string>;
	/** Full reconcile pass. */
	reconcile(): Promise<ReconcileResult>;
}

export type SyncState = "idle" | "syncing" | "error" | "disabled";

export interface SyncStatus {
	state: SyncState;
	lastSyncAt?: number;
	lastResult?: ReconcileResult;
	lastError?: string;
	running: boolean;
}

export interface SessionSyncManagerDeps {
	getConfig: () => SessionSyncConfig;
	/** null when not an in-plugin reader tier or config is invalid (→ disabled). */
	getRunner: () => SyncRunner | null;
	onStatusChange?: (status: SyncStatus) => void;
	onSynced?: (result: ReconcileResult) => void | Promise<void>;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
	clearTimer?: (handle: ReturnType<typeof setInterval>) => void;
}

export class SessionSyncManager {
	private timer: ReturnType<typeof setInterval> | null = null;
	private lastSignature: string | null = null;
	private status: SyncStatus = { state: "idle", running: false };

	constructor(private readonly deps: SessionSyncManagerDeps) {}

	getStatus(): SyncStatus {
		return { ...this.status };
	}

	start(): void {
		if (this.timer) return;
		const intervalMs = Math.max(15, this.deps.getConfig().pollIntervalSec) * 1000;
		const set = this.deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
		this.timer = set(() => void this.tick(), intervalMs);
		void this.tick(); // run once immediately
	}

	stop(): void {
		if (!this.timer) return;
		(this.deps.clearTimer ?? clearInterval)(this.timer);
		this.timer = null;
	}

	/** Restart the timer to pick up a changed poll interval. */
	restart(): void {
		this.stop();
		this.start();
	}

	/** Manual sync: bypasses the probe gate and forces a full reconcile. */
	async syncNow(): Promise<ReconcileResult | undefined> {
		return this.tick(true);
	}

	private emit(): void {
		this.deps.onStatusChange?.(this.getStatus());
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	private async tick(force = false): Promise<ReconcileResult | undefined> {
		if (this.status.running) return undefined; // re-entrancy guard
		const config = this.deps.getConfig();
		if (!config.enabled) {
			this.status = { ...this.status, state: "disabled", running: false };
			this.emit();
			return undefined;
		}
		const runner = this.deps.getRunner();
		if (!runner) {
			this.status = { ...this.status, state: "disabled", running: false };
			this.emit();
			return undefined;
		}

		try {
			if (!force) {
				const signature = await runner.probe();
				if (signature === this.lastSignature) return undefined; // nothing changed
				this.lastSignature = signature;
			}

			this.status = { ...this.status, state: "syncing", running: true };
			this.emit();

			const result = await runner.reconcile();
			if (force) this.lastSignature = await runner.probe().catch(() => this.lastSignature);

			this.status = {
				state: result.errors.length > 0 ? "error" : "idle",
				lastSyncAt: this.now(),
				lastResult: result,
				lastError: result.errors[0],
				running: false,
			};
			this.emit();
			await this.deps.onSynced?.(result);
			return result;
		} catch (err) {
			this.status = { ...this.status, state: "error", lastError: String(err), running: false };
			this.emit();
			return undefined;
		}
	}
}
