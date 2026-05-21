/**
 * Schedule presets — a friendly layer over the raw (scheduleType, cron, triggerAt)
 * task fields. The automation editor speaks presets (Daily / Weekdays / Weekly /
 * Once / Custom); this module converts to and from the stored schedule so cron
 * stays hidden behind "Custom".
 */

export type SchedulePreset = "daily" | "weekdays" | "weekly" | "once" | "custom";

/** Editor-facing form state. */
export interface PresetForm {
	preset: SchedulePreset;
	/** "HH:MM" for daily / weekdays / weekly. */
	time: string;
	/** 0–6 (Sun–Sat) for weekly. */
	weekday: number;
	/** Raw cron for custom. */
	cron: string;
	/** Epoch ms for once. */
	triggerAt?: number;
}

/** Stored schedule fields on ScheduledTaskMeta. */
export interface ScheduleSpec {
	scheduleType: "once" | "recurring";
	cron?: string;
	triggerAt?: number;
}

export const DEFAULT_TIME = "09:00";

/** Parse "HH:MM" → {h, m}; tolerant of missing/garbage, falls back to 09:00. */
export function parseTime(time: string | undefined): { h: number; m: number } {
	const [hRaw, mRaw] = String(time ?? "").split(":");
	let h = Number.parseInt(hRaw, 10);
	let m = Number.parseInt(mRaw, 10);
	if (!Number.isInteger(h) || h < 0 || h > 23) h = 9;
	if (!Number.isInteger(m) || m < 0 || m > 59) m = 0;
	return { h, m };
}

/** Format {h, m} → zero-padded "HH:MM". */
export function formatTime(h: number, m: number): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(h)}:${pad(m)}`;
}

/** Build the stored schedule from an editor form. */
export function presetToSchedule(form: PresetForm): ScheduleSpec {
	if (form.preset === "once") {
		return { scheduleType: "once", triggerAt: form.triggerAt };
	}
	if (form.preset === "custom") {
		return { scheduleType: "recurring", cron: form.cron.trim() };
	}
	const { h, m } = parseTime(form.time);
	const dow =
		form.preset === "daily" ? "*" :
		form.preset === "weekdays" ? "1-5" :
		String(form.weekday);
	return { scheduleType: "recurring", cron: `${m} ${h} * * ${dow}` };
}

/** Recover an editor form from stored schedule fields (for editing). */
export function scheduleToPreset(task: ScheduleSpec): PresetForm {
	const base: PresetForm = { preset: "custom", time: DEFAULT_TIME, weekday: 1, cron: task.cron ?? "", triggerAt: task.triggerAt };
	if (task.scheduleType === "once") {
		return { ...base, preset: "once" };
	}
	const cron = (task.cron ?? "").trim();
	const parts = cron.split(/\s+/);
	if (parts.length !== 5) return base;
	const [min, hour, dom, mon, dow] = parts;
	const m = Number.parseInt(min, 10);
	const h = Number.parseInt(hour, 10);
	// Only the simple "every-day-at-time" family maps back to a friendly preset.
	const simpleTime = Number.isInteger(m) && Number.isInteger(h) && dom === "*" && mon === "*";
	if (!simpleTime) return base;
	const time = formatTime(h, m);
	if (dow === "*") return { ...base, preset: "daily", time };
	if (dow === "1-5") return { ...base, preset: "weekdays", time };
	if (/^[0-6]$/.test(dow)) return { ...base, preset: "weekly", time, weekday: Number.parseInt(dow, 10) };
	return base;
}
