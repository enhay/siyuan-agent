import { describe, expect, it } from "vitest";
import {
	parseTime,
	formatTime,
	presetToSchedule,
	scheduleToPreset,
	DEFAULT_TIME,
	type PresetForm,
} from "../src/core/schedule-presets";

function form(overrides: Partial<PresetForm>): PresetForm {
	return { preset: "daily", time: "09:00", weekday: 1, cron: "", ...overrides };
}

describe("parseTime / formatTime", () => {
	it("parses HH:MM", () => {
		expect(parseTime("18:30")).toEqual({ h: 18, m: 30 });
		expect(parseTime("00:00")).toEqual({ h: 0, m: 0 });
	});
	it("falls back to 09:00 on garbage", () => {
		expect(parseTime(undefined)).toEqual({ h: 9, m: 0 });
		expect(parseTime("nonsense")).toEqual({ h: 9, m: 0 });
		expect(parseTime("99:99")).toEqual({ h: 9, m: 0 });
	});
	it("zero-pads on format", () => {
		expect(formatTime(9, 5)).toBe("09:05");
		expect(formatTime(18, 30)).toBe("18:30");
	});
});

describe("presetToSchedule", () => {
	it("daily → cron at the chosen time, every day", () => {
		expect(presetToSchedule(form({ preset: "daily", time: "09:05" }))).toEqual({
			scheduleType: "recurring",
			cron: "5 9 * * *",
		});
	});
	it("weekdays → Mon-Fri", () => {
		expect(presetToSchedule(form({ preset: "weekdays", time: "18:00" }))).toEqual({
			scheduleType: "recurring",
			cron: "0 18 * * 1-5",
		});
	});
	it("weekly → single weekday", () => {
		expect(presetToSchedule(form({ preset: "weekly", time: "08:00", weekday: 3 }))).toEqual({
			scheduleType: "recurring",
			cron: "0 8 * * 3",
		});
	});
	it("once → triggerAt, no cron", () => {
		expect(presetToSchedule(form({ preset: "once", triggerAt: 123456 }))).toEqual({
			scheduleType: "once",
			triggerAt: 123456,
		});
	});
	it("custom → passes the raw cron through (trimmed)", () => {
		expect(presetToSchedule(form({ preset: "custom", cron: "  */15 * * * *  " }))).toEqual({
			scheduleType: "recurring",
			cron: "*/15 * * * *",
		});
	});
});

describe("scheduleToPreset (round-trip + detection)", () => {
	it("round-trips daily / weekdays / weekly", () => {
		for (const f of [
			form({ preset: "daily", time: "09:05" }),
			form({ preset: "weekdays", time: "18:00" }),
			form({ preset: "weekly", time: "08:00", weekday: 3 }),
		]) {
			const spec = presetToSchedule(f);
			const back = scheduleToPreset(spec);
			expect(back.preset).toBe(f.preset);
			expect(back.time).toBe(f.time);
			if (f.preset === "weekly") expect(back.weekday).toBe(f.weekday);
		}
	});

	it("once maps back to once with triggerAt", () => {
		expect(scheduleToPreset({ scheduleType: "once", triggerAt: 999 })).toMatchObject({
			preset: "once",
			triggerAt: 999,
		});
	});

	it("non-matching cron falls back to custom with the raw cron preserved", () => {
		const back = scheduleToPreset({ scheduleType: "recurring", cron: "*/15 9 1 * *" });
		expect(back.preset).toBe("custom");
		expect(back.cron).toBe("*/15 9 1 * *");
	});

	it("malformed cron → custom, default time", () => {
		const back = scheduleToPreset({ scheduleType: "recurring", cron: "not a cron" });
		expect(back.preset).toBe("custom");
		expect(back.time).toBe(DEFAULT_TIME);
	});
});
