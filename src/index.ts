import {
	Plugin,
	showMessage,
	Menu,
} from "siyuan";
import "./styles/index.scss";
import {
	AgentConfig,
	normalizeAgentConfig,
	resolveModelConfig,
} from "./types";
import { ChatPanel } from "./ui/chat-panel";
import { getDefaultTools, type DefaultToolsOptions } from "./core/tools";
import { SessionStore, createPluginStorage } from "./core/session-store";
import { ScheduledTaskManager } from "./core/scheduled-task-manager";
import { SessionSyncManager } from "./core/session-sync/manager";
import { buildSyncRunner } from "./core/session-sync/runner";
import { normalizeSessionSyncConfig, type SessionSyncConfig } from "./core/session-sync/config";
import { detectEnvironment, decideTier } from "./core/session-sync/env-probe";
import { createTitleProvider } from "./core/session-sync/adapters/title-provider";
import { createFsSource } from "./core/session-sync/adapters/fs-source";
import { getNodeRequire } from "./core/session-sync/node-require";
import type { SyncRunner } from "./core/session-sync/manager";
import { createModel, reasoningProviderOptions } from "./core/model";
import { McpManager } from "./core/mcp-client";
import { createTranslator, type Translator } from "./i18n";

const CONFIG_STORAGE = "agent-config";
const DOCK_TYPE = "agent-chat";
const DOCK_TITLE = "AI Agent";

export default class SiYuanAgent extends Plugin {

	private chatPanel: ChatPanel | null = null;
	private dockElement: Element | null = null;
	private dockWidthTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingContexts: string[] = [];
	private pendingDoc: { id: string; title: string } | null = null;
	private pendingView: "settings" | null = null;
	private sessionStore: SessionStore;
	private scheduledTaskManager: ScheduledTaskManager;
	private sessionSyncManager: SessionSyncManager;
	private mcpManager: McpManager = new McpManager();
	private translator: Translator;

	onload() {
		this.translator = createTranslator(this.i18n);

		// Expose app instance for tools that need it (e.g., openTab)
		(globalThis as any).siyuanApp = this.app;

		const buildTools = (opts: DefaultToolsOptions = {}) => {
			const builtinTools = getDefaultTools(() => this.getConfig(), () => this.scheduledTaskManager, this.translator, opts);
			const mcpTools = this.mcpManager.getAllTools();
			return [...builtinTools, ...mcpTools];
		};
		// Interactive chat can confirm with the user, so it gets delete_document;
		// scheduled tasks run unattended, so theirs leaves it out.
		const getInteractiveTools = () => buildTools({ includeDeleteDocument: true });
		this.sessionStore = new SessionStore(createPluginStorage(this));
		this.scheduledTaskManager = new ScheduledTaskManager({
			store: this.sessionStore,
			getConfig: () => this.getConfig(),
			getTools: () => buildTools(),
			i18n: this.translator,
		});
		this.sessionSyncManager = new SessionSyncManager({
			getConfig: () => this.getSessionSyncConfig(),
			getRunner: () => this.buildSessionSyncRunner(),
			// lastSyncAt is persisted in the engine-owned sync state (not agent-config)
			// to avoid a lost-update race with the settings save path.
		});

		this.addIcons(`<symbol id="iconAgent" viewBox="0 0 24 24">
<rect width="24" height="24" rx="4" fill="#F2E6D8"/>
<path d="M3 8Q8 5 12 8v12Q8 17 3 20Z" fill="#D96C4A"/>
<path d="M21 8Q16 5 12 8v12q4-3 9 0Z" fill="#E89A6A"/>
<rect x="11.4" y="8" width="1.2" height="12" rx=".6" fill="#C85A3A"/>
<circle cx="12" cy="4.8" r="2.2" fill="#F4B942"/>
</symbol>`);

		this.eventBus.on("open-menu-content", (e) => {
			console.log("SiYuan Agent: open-menu-content event triggered", e.detail);
			const text = e.detail.range ? e.detail.range.toString().trim() : "";
			console.log("SiYuan Agent: selected text:", text);
			
			if (text) {
				e.detail.menu.addItem({
					icon: "iconAgent",
					label: this.translator.t("sendToChat"),
					accelerator: this.commands.find(c => c.langKey === "sendToChat")?.hotkey,
					click: () => {
						console.log("SiYuan Agent: Send to Chat clicked");
						this.sendContextToChat(text);
					}
				});
			}
		});

		// Live-track the user's focused document so the chat can attach it as
		// ambient context (a reference, not its content).
		this.eventBus.on("switch-protyle", (e) => this.trackActiveDoc(e.detail.protyle));
		this.eventBus.on("loaded-protyle-static", (e) => this.trackActiveDoc(e.detail.protyle));
		this.eventBus.on("loaded-protyle-dynamic", (e) => this.trackActiveDoc(e.detail.protyle));

		// One dock for both desktop and mobile: a dedicated, resizable side panel
		// that never mixes with document tabs. Initial width is restored from
		// config (SiYuan also persists dock size in its own layout).
		this.addDock({
			config: {
				position: "RightTop",
				size: { width: this.getConfig().dockWidth || 360, height: 0 },
				icon: "iconAgent",
				title: DOCK_TITLE,
				hotkey: "⌥⌘A",
				show: false,
			},
			data: {},
			type: DOCK_TYPE,
			init: (dock) => {
				// Guard against re-init without a paired destroy (workspace switch /
				// layout reload): tear down the previous panel so its document-level
				// listeners don't leak and fire on stale DOM.
				if (this.chatPanel) {
					this.chatPanel.destroy();
					this.chatPanel = null;
				}
				this.dockElement = dock.element;
				// Make the dock content a full-height flex column so the `.fn__flex-1`
				// body actually fills (giving .chat-panel a definite height). Without
				// this the flex chain has no height to distribute and the message area
				// collapses to its content — pushing the composer up to the top.
				const dockEl = dock.element as HTMLElement;
				dockEl.style.display = "flex";
				dockEl.style.flexDirection = "column";
				dockEl.style.height = "100%";
				dock.element.innerHTML = `<div class="toolbar toolbar--border toolbar--dark">
					<svg class="toolbar__icon"><use xlink:href="#iconAgent"></use></svg>
					<div class="toolbar__text">${DOCK_TITLE}</div>
				</div>
				<div class="fn__flex-1" style="overflow:hidden;min-height:0"></div>`;
				this.chatPanel = new ChatPanel(
					dock.element.querySelector<HTMLElement>(".fn__flex-1"),
					this,
					getInteractiveTools(),
					this.sessionStore,
					this.scheduledTaskManager,
					this.translator,
				);
				this.flushPendingContexts();
			},
			resize: () => this.recordDockWidth(),
			destroy: () => {
				this.chatPanel?.destroy();
				this.chatPanel = null;
				this.dockElement = null;
			},
		});

		/* --- Commands --- */
		this.addCommand({
			langKey: "sendToChat",
			hotkey: "⌥⌘L",
			editorCallback: (protyle) => {
				let text = "";
				const sel = window.getSelection();
				if (sel && sel.rangeCount > 0) {
					const range = sel.getRangeAt(0);
					const wysiwyg = protyle.wysiwyg?.element;
					if (wysiwyg && wysiwyg.contains(range.startContainer))
						text = range.toString().trim();
				}
				if (!text) {
					/* block-level selection: .protyle-wysiwyg--select */
					const selected = protyle.wysiwyg?.element
						?.querySelectorAll(".protyle-wysiwyg--select");
					if (selected && selected.length)
						text = Array.from(selected)
							.map(el => (el as HTMLElement).innerText)
							.join("\n").trim();
				}
				if (text)
					this.sendContextToChat(text);
				else
					showMessage(this.translator.t("noSelection"));
			},
		});

		this.addCommand({
			langKey: "syncSessionsNow",
			hotkey: "",
			callback: () => void this.runSessionSyncNow(),
		});
	}

	onLayoutReady() {
		void this.loadData(CONFIG_STORAGE).then(() => this.sessionSyncManager.start());
		void this.scheduledTaskManager.start();
		const topBarButton = this.addTopBar({
			icon: "iconAgent",
			title: DOCK_TITLE,
			position: "right",
			callback: () => {
				void this.toggleChatPanel();
			},
		});
		topBarButton?.addEventListener("contextmenu", (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			this.openTopBarMenu(event);
		});

		// Initialize MCP servers in background (non-blocking)
		this.initMcpServers();
	}

	/** Connect to configured MCP servers */
	private async initMcpServers(): Promise<void> {
		try {
			const config = await this.getConfig();
			const servers = config.mcpServers || [];
			if (servers.length > 0) {
				const statuses = await this.mcpManager.connectAll(servers);
				const connected = statuses.filter((s) => s.connected);
				if (connected.length > 0) {
					console.log(`SiYuan Agent: Connected to ${connected.length} MCP server(s), ${connected.reduce((n, s) => n + s.toolCount, 0)} tools available`);
				}
				const failed = statuses.filter((s) => !s.connected);
				if (failed.length > 0) {
					console.warn(`SiYuan Agent: Failed to connect to ${failed.length} MCP server(s):`, failed.map((s) => `${s.serverName}: ${s.error}`));
				}
			}
		} catch (err) {
			console.warn("SiYuan Agent: MCP initialization error:", err);
		}
	}

	onunload() {
		if (this.dockWidthTimer) { clearTimeout(this.dockWidthTimer); this.dockWidthTimer = null; }
		this.scheduledTaskManager?.stop();
		this.sessionSyncManager?.stop();
		this.chatPanel?.destroy();
		this.chatPanel = null;
		void this.mcpManager.disconnectAll();
	}

	private getSessionSyncConfig(): SessionSyncConfig {
		return normalizeSessionSyncConfig(detectEnvironment(), this.getConfig().sessionSync);
	}

	private buildSessionSyncRunner(): SyncRunner | null {
		const ss = this.getSessionSyncConfig();
		let titleProvider;
		if (ss.aiTitle.enabled) {
			try {
				// reasoningEffort "off": a 16-char title needs no chain-of-thought, and
				// leaving it on makes reasoning models (e.g. deepseek-v4) burn the token
				// budget on reasoning_content → empty title → heuristic fallback.
				const titleMc = resolveModelConfig(this.getConfig(), ss.aiTitle.modelId);
				titleProvider = createTitleProvider(createModel(titleMc), reasoningProviderOptions("off", titleMc));
			} catch {
				titleProvider = undefined; // model unavailable → heuristic titles
			}
		}
		return buildSyncRunner(ss, this, titleProvider);
	}

	/** One-line snapshot of why session sync may not be running. Logged + shown. */
	private sessionSyncDiagnostic(): string {
		const env = detectEnvironment();
		const ss = this.getSessionSyncConfig();
		const diag = `os=${env.os} container=${env.container} node=${env.hasNode} tier=${decideTier(env)} enabled=${ss.enabled} notebook=${ss.notebookId ? "set" : "none"} codexPaths=${ss.sourcePaths.codex.length} claudePaths=${ss.sourcePaths.claude.length}`;
		console.log("[session-sync] diagnostic:", diag, { sourcePaths: ss.sourcePaths });
		return diag;
	}

	async runSessionSyncNow(): Promise<void> {
		showMessage(this.translator.t("sessionSync.syncing"));
		const result = await this.sessionSyncManager.syncNow();
		if (!result) {
			const diag = this.sessionSyncDiagnostic();
			const status = this.sessionSyncManager.getStatus();
			let reason: string;
			if (status.running) {
				reason = "busy (another sync in progress)";
			} else if (status.lastError) {
				reason = `reconcile error: ${status.lastError}`;
			} else {
				reason = "runner=null";
				try {
					const r = getNodeRequire();
					if (!r) reason = "no native require";
					else {
						const fs = r("fs") as { promises?: unknown };
						reason = fs?.promises ? "fs OK → check enabled/notebook" : "require('fs') has no .promises";
					}
				} catch (e) {
					reason = `require('fs') threw: ${e instanceof Error ? e.message : String(e)}`;
				}
			}
			console.error("[session-sync] not executed:", reason, diag);
			showMessage(`同步未执行 / not run: ${reason} [${diag}]`, 14000, "error");
			return;
		}
		if (result.errors.length > 0) {
			console.error("[session-sync] sync errors:", result.errors);
			showMessage(this.translator.t("sessionSync.failed", { error: result.errors[0] }), 10000, "error");
			return;
		}
		showMessage(
			this.translator.t("sessionSync.done", { created: result.newSessions, updated: result.updatedSessions }),
		);
	}

	/** Probe whether the configured source paths are readable; report full diagnostic. */
	async testSessionSyncPaths(): Promise<void> {
		const diag = this.sessionSyncDiagnostic();
		const ss = this.getSessionSyncConfig();
		try {
			const files = await createFsSource({
				sources: ss.sources,
				sourcePaths: ss.sourcePaths,
				backfillDays: ss.backfillDays,
				backfillLimit: ss.backfillLimit,
			}).list();
			const codex = files.filter((f) => f.source === "codex").length;
			const claude = files.filter((f) => f.source === "claude").length;
			console.log(`[session-sync] read ok: codex=${codex} claude=${claude}`);
			showMessage(`${this.translator.t("sessionSync.testResult", { codex, claude })} [${diag}]`, 10000);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[session-sync] read failed:", e);
			showMessage(`读取失败 / read failed: ${msg} [${diag}]`, 12000, "error");
		}
	}

	uninstall() {
		const sessionStore = this.sessionStore ?? new SessionStore(createPluginStorage(this));
		void Promise.allSettled([
			this.removeData(CONFIG_STORAGE),
			sessionStore.clearPersistedData(),
		]).then((results) => {
			results.forEach((result, index) => {
				if (result.status !== "rejected") return;
				const target = index === 0 ? CONFIG_STORAGE : "session-storage";
				console.warn(`SiYuan Agent: failed to remove data [${target}]:`, result.reason);
			});
		});
	}

	openSetting(): void {
		void this.openCustomSettings();
	}

	private openTopBarMenu(event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem({
			icon: "iconSettings",
			label: this.translator.t("settings"),
			click: () => {
				void this.openCustomSettings();
			},
		});
		menu.open({
			x: event.clientX,
			y: event.clientY,
		});
	}

	private getConfig(): AgentConfig {
		return normalizeAgentConfig(this.data[CONFIG_STORAGE] || {});
	}

	/** Persist the current dock width (debounced) so it is restored next launch. */
	private recordDockWidth(): void {
		const width = this.dockElement?.clientWidth;
		if (!width || width < 120) return;
		if (this.dockWidthTimer) clearTimeout(this.dockWidthTimer);
		this.dockWidthTimer = setTimeout(() => {
			const next: AgentConfig = { ...this.getConfig(), dockWidth: width };
			this.data[CONFIG_STORAGE] = next;
			void this.saveData(CONFIG_STORAGE, next);
		}, 500);
	}

	/** Push the active editor's document to the chat as ambient context. */
	private trackActiveDoc(protyle: any): void {
		if (!protyle || this.getConfig().autoAttachCurrentDoc === false) return;
		const id: string = protyle.block?.rootID || "";
		if (!id) return;
		const title: string = (protyle.title?.editElement?.textContent || "").trim();
		const doc = { id, title };
		if (this.chatPanel) this.chatPanel.setCurrentDoc(doc);
		else this.pendingDoc = doc;
	}

	private sendContextToChat(text: string): void {
		if (!text) {
			return;
		}
		if (this.chatPanel) {
			this.chatPanel.addContext(text);
			return;
		}
		this.pendingContexts.push(text);
		void this.ensureChatVisible();
	}

	private flushPendingContexts(): void {
		if (!this.chatPanel) {
			return;
		}
		if (this.pendingDoc) {
			this.chatPanel.setCurrentDoc(this.pendingDoc);
			this.pendingDoc = null;
		}
		if (this.pendingView === "settings") {
			this.chatPanel.openSettingsView();
			this.pendingView = null;
		}
		if (this.pendingContexts.length === 0) {
			return;
		}
		const pending = [...this.pendingContexts];
		this.pendingContexts = [];
		pending.forEach((text) => this.chatPanel?.addContext(text));
	}

	private async openCustomSettings(): Promise<void> {
		if (this.chatPanel) {
			this.chatPanel.openSettingsView();
			return;
		}
		this.pendingView = "settings";
		await this.ensureChatVisible();
		if (this.chatPanel) {
			this.chatPanel.openSettingsView();
			this.pendingView = null;
		}
	}

	private async toggleChatPanel(): Promise<void> {
		this.toggleChatDock();
	}

	private async ensureChatVisible(): Promise<void> {
		this.openChatDock();
	}

	private openChatDock(): void {
		const dockType = `${this.name}${DOCK_TYPE}`;
		const dockButton = document.querySelector(`.dock__item[data-type="${dockType}"]`) as HTMLElement | null;
		const layout = (window as any).siyuan?.layout;
		const dockController = dockButton?.closest("#dockLeft, #dockRight, #dockBottom")?.id === "dockLeft"
			? layout?.leftDock
			: dockButton?.closest("#dockLeft, #dockRight, #dockBottom")?.id === "dockBottom"
				? layout?.bottomDock
				: layout?.rightDock;

		dockController?.toggleModel?.(dockType, true, false, false, false);
	}

	private toggleChatDock(): void {
		const dockType = `${this.name}${DOCK_TYPE}`;
		const dockButton = document.querySelector(`.dock__item[data-type="${dockType}"]`) as HTMLElement | null;
		dockButton?.click();
	}

}
