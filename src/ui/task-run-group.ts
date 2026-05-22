import type { ToolUIEvent } from "../types";
import { messageKind, messageContent, messageToolCalls } from "../core/message-shape";

/**
 * Represents a single execution run within a scheduled task session.
 * Messages are split by human messages starting with the scheduled task prefix.
 */
export interface TaskRunGroup {
	/** Index of the first message in this run group (within the full messages array) */
	startIndex: number;
	/** Index of the last message in this run group (inclusive) */
	endIndex: number;
	/** Execution timestamp extracted from the prompt prefix */
	runAt?: string;
	/** Task title extracted from the prompt */
	taskTitle?: string;
	/** Messages belonging to this run */
	messages: any[];
	/** ToolUIEvents associated with this run's tool call indices */
	toolUIEvents: ToolUIEvent[];
	/** Inferred run status based on message content */
	status: "success" | "error" | "unknown";
}

const SCHEDULED_PREFIXES = ["定时任务执行时间：", "Scheduled task run time: "];
const TASK_TITLE_PREFIXES = ["任务名称：", "Task name: "];
const ERROR_MARKERS = ["定时任务执行失败", "Scheduled task execution failed"];

function isScheduledRunStart(m: any): boolean {
	return (messageKind(m) === "human" || messageKind(m) === "user") &&
		SCHEDULED_PREFIXES.some((prefix) => messageContent(m).startsWith(prefix));
}

function extractRunAt(content: string): string | undefined {
	const line = content.split("\n")[0];
	for (const prefix of SCHEDULED_PREFIXES) {
		if (line.startsWith(prefix)) {
			return line.slice(prefix.length).trim();
		}
	}
	return undefined;
}

function extractTaskTitle(content: string): string | undefined {
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		for (const prefix of TASK_TITLE_PREFIXES) {
			if (trimmed.startsWith(prefix)) {
				return trimmed.slice(prefix.length).trim();
			}
		}
	}
	return undefined;
}

function inferRunStatus(messages: any[]): "success" | "error" | "unknown" {
	for (const m of messages) {
		const content = messageContent(m);
		if (ERROR_MARKERS.some((marker) => content.includes(marker))) return "error";
	}
	const hasAi = messages.some((m) => messageKind(m) === "ai");
	return hasAi ? "success" : "unknown";
}

/**
 * Split a scheduled task session's messages into per-execution run groups.
 *
 * Each run starts with a human message whose content begins with a scheduled task run prefix.
 * If no such messages are found (legacy data), all messages are returned as a single group.
 */
export function groupTaskRuns(messages: any[], toolUIEvents: ToolUIEvent[]): TaskRunGroup[] {
	if (!messages || messages.length === 0) return [];

	// Find run boundaries
	const boundaries: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (isScheduledRunStart(messages[i])) {
			boundaries.push(i);
		}
	}

	// No scheduled prefix found → legacy fallback as single group
	if (boundaries.length === 0) {
		return [{
			startIndex: 0,
			endIndex: messages.length - 1,
			messages,
			toolUIEvents,
			status: inferRunStatus(messages),
		}];
	}

	// Build tool call index → run mapping
	let globalToolCallIdx = -1;
	const toolCallRunMap = new Map<number, number>();
	for (let i = 0; i < messages.length; i++) {
		const runIdx = findRunBoundary(i, boundaries);
		for (const _tc of messageToolCalls(messages[i])) {
			globalToolCallIdx++;
			toolCallRunMap.set(globalToolCallIdx, runIdx);
		}
	}

	const groups: TaskRunGroup[] = [];
	for (let b = 0; b < boundaries.length; b++) {
		const start = boundaries[b];
		const end = b + 1 < boundaries.length ? boundaries[b + 1] - 1 : messages.length - 1;
		const runMessages = messages.slice(start, end + 1);
		const content = messageContent(messages[start]);

		const runToolUIEvents = toolUIEvents.filter((ev) => toolCallRunMap.get(ev.toolCallIndex) === start);

		groups.push({
			startIndex: start,
			endIndex: end,
			runAt: extractRunAt(content),
			taskTitle: extractTaskTitle(content),
			messages: runMessages,
			toolUIEvents: runToolUIEvents,
			status: inferRunStatus(runMessages),
		});
	}

	return groups;
}

function findRunBoundary(msgIndex: number, boundaries: number[]): number {
	let result = boundaries[0];
	for (const b of boundaries) {
		if (b <= msgIndex) result = b;
		else break;
	}
	return result;
}
