import { test, expect, describe } from "bun:test";
import { parseCalendarDate, parseEventTime } from "../cli";

describe("parseCalendarDate", () => {
  test("YYYY-MM-DD string returns local midnight, not UTC midnight", () => {
    // The bug: new Date("2026-02-10") creates UTC midnight
    // which is Feb 9 7pm in EST. We need local midnight Feb 10.
    const result = parseCalendarDate("2026-02-10");

    // Should be Feb 10 in local timezone
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1); // 0-indexed, so 1 = February
    expect(result.getDate()).toBe(10);

    // Should be midnight local time
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    expect(result.getSeconds()).toBe(0);
  });

  test("today returns local midnight", () => {
    const result = parseCalendarDate("today");
    const now = new Date();
    expect(result.getDate()).toBe(now.getDate());
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    expect(result.getSeconds()).toBe(0);
  });

  test("tomorrow returns next day local midnight", () => {
    const result = parseCalendarDate("tomorrow");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(result.getDate()).toBe(tomorrow.getDate());
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    expect(result.getSeconds()).toBe(0);
  });

  test("various YYYY-MM-DD strings all return correct local date", () => {
    // Test several dates to rule out off-by-one edge cases
    const cases = [
      { input: "2026-01-01", year: 2026, month: 0, day: 1 },
      { input: "2026-12-31", year: 2026, month: 11, day: 31 },
      { input: "2026-03-15", year: 2026, month: 2, day: 15 },
    ];

    for (const { input, year, month, day } of cases) {
      const result = parseCalendarDate(input);
      expect(result.getFullYear()).toBe(year);
      expect(result.getMonth()).toBe(month);
      expect(result.getDate()).toBe(day);
      expect(result.getHours()).toBe(0);
    }
  });

  test("full ISO datetime string still parses normally", () => {
    // A full ISO string with time/timezone should still work via Date constructor
    const result = parseCalendarDate("2026-02-10T14:30:00");
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(10);
  });

  test("invalid date throws Error", () => {
    expect(() => parseCalendarDate("not-a-date")).toThrow("Invalid date: not-a-date");
  });
});

describe("parseEventTime", () => {
  test("parseEventTime handles date-only YYYY-MM-DD as local midnight", () => {
    const result = parseEventTime("2026-02-10");
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1); // Feb = 1 (0-indexed)
    expect(result.getDate()).toBe(10);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
  });

  test("ISO datetime without timezone parses as local time", () => {
    const result = parseEventTime("2026-02-10T00:00:00");
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(10);
    expect(result.getHours()).toBe(0);
  });

  test("ISO datetime with specific time parses correctly", () => {
    const result = parseEventTime("2026-02-10T14:30:00");
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(10);
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(30);
  });

  test("simple time like '2pm' parses to today at 2pm", () => {
    const result = parseEventTime("2pm");
    const now = new Date();
    expect(result.getDate()).toBe(now.getDate());
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(0);
  });

  test("'tomorrow 3pm' parses to tomorrow at 3pm", () => {
    const result = parseEventTime("tomorrow 3pm");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(result.getDate()).toBe(tomorrow.getDate());
    expect(result.getHours()).toBe(15);
    expect(result.getMinutes()).toBe(0);
  });

  test("invalid time throws Error", () => {
    expect(() => parseEventTime("not-a-time")).toThrow("Invalid time: not-a-time");
  });
});

describe("calendar list --start/--end CLI flags", () => {
  test("calendar list accepts --start and --end flags without error", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/cli.ts", "calendar", "list", "--start", "2026-02-10T00:00:00", "--end", "2026-02-10T23:59:59", "--account=test@example.com"],
      {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const stderr = await new Response(proc.stderr).text();
    // The flags should be accepted by the parser (no "unknown" flag errors).
    // The command may fail with credential errors, but that's expected --
    // we only verify the flags are recognized and not rejected.
    expect(stderr.toLowerCase()).not.toContain("unknown");
  });

  test("calendar list accepts --start without --end", async () => {
    const proc = Bun.spawn(
      [process.execPath, "src/cli.ts", "calendar", "list", "--start", "2026-02-10T00:00:00", "--account=test@example.com"],
      {
        cwd: import.meta.dir + "/../..",
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const stderr = await new Response(proc.stderr).text();
    expect(stderr.toLowerCase()).not.toContain("unknown");
  });
});
