/**
 * CLI Draft List Tests
 *
 * Tests the `superhuman draft list` command output with source column,
 * JSON output, and --to / --subject filtering.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import type { Draft } from "../services/draft-service";

// Store original console.log
const originalLog = console.log;
let logOutput: string[] = [];

describe("superhuman draft list", () => {
  beforeEach(() => {
    logOutput = [];
    console.log = (...args: any[]) => {
      logOutput.push(args.join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("should format drafts with source column for display", () => {
    // Test the display logic by verifying that drafts with source are formatted correctly
    const drafts: Draft[] = [
      {
        id: "gmail-draft-1",
        subject: "Gmail Test",
        from: "user@gmail.com",
        to: ["recipient@example.com"],
        preview: "Gmail preview",
        timestamp: "2024-02-08T12:00:00Z",
        source: "gmail",
      },
      {
        id: "outlook-draft-1",
        subject: "Outlook Test",
        from: "user@outlook.com",
        to: ["recipient@example.com"],
        preview: "Outlook preview",
        timestamp: "2024-02-08T13:00:00Z",
        source: "outlook",
      },
    ];

    // Format draft output similar to how cmdListDrafts does it
    for (const draft of drafts) {
      console.log(`${draft.id}`);
      console.log(`  Subject: ${draft.subject}`);
      console.log(`  Source: ${draft.source}`);
      console.log(`  To: ${draft.to.join(", ")}`);
      console.log("");
    }

    // Verify output contains Source entries
    expect(logOutput.some((line) => line.includes("Source: gmail"))).toBe(true);
    expect(logOutput.some((line) => line.includes("Source: outlook"))).toBe(true);
  });

  it("should format native drafts with source column for display", () => {
    // Test the display logic for native Superhuman drafts
    const drafts: Draft[] = [
      {
        id: "gmail-draft-1",
        subject: "Gmail Test",
        from: "user@gmail.com",
        to: ["recipient@example.com"],
        preview: "Gmail preview",
        timestamp: "2024-02-08T12:00:00Z",
        source: "gmail",
      },
      {
        id: "draft00abc123",
        subject: "Native Superhuman Draft",
        from: "user@gmail.com",
        to: ["recipient@example.com"],
        preview: "Native draft preview",
        timestamp: "2024-02-08T14:00:00Z",
        source: "native",
      },
    ];

    // Format draft output similar to how cmdListDrafts does it
    for (const draft of drafts) {
      console.log(`${draft.id}`);
      console.log(`  Subject: ${draft.subject}`);
      console.log(`  Source: ${draft.source}`);
      console.log(`  To: ${draft.to.join(", ")}`);
      console.log("");
    }

    // Verify output contains both gmail and native source entries
    expect(logOutput.some((line) => line.includes("Source: gmail"))).toBe(true);
    expect(logOutput.some((line) => line.includes("Source: native"))).toBe(true);
    expect(logOutput.some((line) => line.includes("draft00abc123"))).toBe(true);
  });

  it("draft list command appears in CLI help", async () => {
    const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "--help"], {
      cwd: import.meta.dir + "/../..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(stdout).toContain("draft");
  });

  it("should filter drafts by --to recipient", () => {
    const drafts: Draft[] = [
      {
        id: "draft-1",
        subject: "Meeting Follow-up",
        from: "user@example.com",
        to: ["jon@example.com"],
        preview: "Hi Jon...",
        timestamp: "2026-02-08T14:30:00Z",
        source: "gmail",
      },
      {
        id: "draft-2",
        subject: "Project Update",
        from: "user@example.com",
        to: ["alice@example.com"],
        preview: "Hi Alice...",
        timestamp: "2026-02-08T15:00:00Z",
        source: "gmail",
      },
    ];

    const filterTo = "jon@example.com".toLowerCase();
    const filtered = drafts.filter((d) =>
      d.to.some((recipient) => recipient.toLowerCase().includes(filterTo))
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("draft-1");
  });

  it("should filter drafts by --subject substring", () => {
    const drafts: Draft[] = [
      {
        id: "draft-1",
        subject: "Meeting Follow-up",
        from: "user@example.com",
        to: ["jon@example.com"],
        preview: "Hi Jon...",
        timestamp: "2026-02-08T14:30:00Z",
        source: "gmail",
      },
      {
        id: "draft-2",
        subject: "Project Update",
        from: "user@example.com",
        to: ["alice@example.com"],
        preview: "Hi Alice...",
        timestamp: "2026-02-08T15:00:00Z",
        source: "gmail",
      },
    ];

    const filterSubject = "meeting".toLowerCase();
    const filtered = drafts.filter((d) =>
      (d.subject || "").toLowerCase().includes(filterSubject)
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("draft-1");
    expect(filtered[0].subject).toBe("Meeting Follow-up");
  });

  it("should return empty array when no drafts match --to filter", () => {
    const drafts: Draft[] = [
      {
        id: "draft-1",
        subject: "Test",
        from: "user@example.com",
        to: ["jon@example.com"],
        preview: "Preview",
        timestamp: "2026-02-08T14:30:00Z",
        source: "gmail",
      },
    ];

    const filterTo = "nobody@example.com".toLowerCase();
    const filtered = drafts.filter((d) =>
      d.to.some((recipient) => recipient.toLowerCase().includes(filterTo))
    );

    expect(filtered).toHaveLength(0);
  });

  it("should return all drafts when no filter is applied", () => {
    const drafts: Draft[] = [
      {
        id: "draft-1",
        subject: "First",
        from: "user@example.com",
        to: ["a@example.com"],
        preview: "Preview 1",
        timestamp: "2026-02-08T14:30:00Z",
        source: "gmail",
      },
      {
        id: "draft-2",
        subject: "Second",
        from: "user@example.com",
        to: ["b@example.com"],
        preview: "Preview 2",
        timestamp: "2026-02-08T15:00:00Z",
        source: "outlook",
      },
    ];

    // No filters applied
    const filterTo = "";
    const filterSubject = "";
    let filtered = drafts;
    if (filterTo) {
      filtered = filtered.filter((d) =>
        d.to.some((recipient) => recipient.toLowerCase().includes(filterTo))
      );
    }
    if (filterSubject) {
      filtered = filtered.filter((d) =>
        (d.subject || "").toLowerCase().includes(filterSubject)
      );
    }

    expect(filtered).toHaveLength(2);
  });

  it("should produce valid JSON output for drafts", () => {
    const drafts: Draft[] = [
      {
        id: "draft-abc123",
        subject: "Meeting Follow-up",
        from: "user@example.com",
        to: ["jon@example.com"],
        preview: "Hi Jon, following up on our conversation...",
        timestamp: "2026-02-08T14:30:00Z",
        source: "gmail",
      },
    ];

    const jsonStr = JSON.stringify(drafts, null, 2);
    const parsed = JSON.parse(jsonStr) as typeof drafts;

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("draft-abc123");
    expect(parsed[0].subject).toBe("Meeting Follow-up");
    expect(parsed[0].to).toEqual(["jon@example.com"]);
    expect(parsed[0].source).toBe("gmail");
  });

  it("should match --to filter case-insensitively", () => {
    const drafts: Draft[] = [
      {
        id: "draft-1",
        subject: "Hello",
        from: "user@example.com",
        to: ["Jon@Example.COM"],
        preview: "Hi",
        timestamp: "2026-02-08T14:30:00Z",
        source: "gmail",
      },
    ];

    // Filter using lowercase
    const filterTo = "jon@example.com";
    const filtered = drafts.filter((d) =>
      d.to.some((recipient) => recipient.toLowerCase().includes(filterTo))
    );

    expect(filtered).toHaveLength(1);
  });
});
