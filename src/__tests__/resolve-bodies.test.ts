/**
 * Tests for resolveBodies — the FTS body-lookup join used by --with-body.
 * Builds an in-memory fixture mirroring Superhuman's schema (messages +
 * thread_search_content) and verifies resolution by both thread_id and the
 * latest-message id.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { resolveBodies } from "../sqlite-search";

function makeDb(): Database {
  const db = new Database(":memory:");
  // Minimal shadow of Superhuman's FTS content table + messages table.
  db.run(`CREATE TABLE thread_search_content (
    c0thread_id TEXT, c1subject TEXT, c2content TEXT
  )`);
  db.run(`CREATE TABLE messages (id TEXT, thread_id TEXT, timestamp INTEGER, is_sent INTEGER)`);

  // Thread A: single message — thread_id == message id.
  db.run(`INSERT INTO thread_search_content VALUES ('tA', 'Hi', 'Body of thread A')`);
  db.run(`INSERT INTO messages VALUES ('tA', 'tA', 100, 0)`);

  // Thread B: multi-message — latest message id ('mB2') differs from thread_id ('tB').
  db.run(`INSERT INTO thread_search_content VALUES ('tB', 'Re: x', 'oldest … newest of thread B')`);
  db.run(`INSERT INTO messages VALUES ('mB1', 'tB', 200, 1)`);
  db.run(`INSERT INTO messages VALUES ('mB2', 'tB', 300, 0)`);
  return db;
}

describe("resolveBodies", () => {
  let db: Database;
  beforeEach(() => { db = makeDb(); });

  test("resolves body by thread_id directly (single-message thread)", () => {
    const m = resolveBodies(db, ["tA"]);
    expect(m.get("tA")).toBe("Body of thread A");
  });

  test("resolves body by latest-message id via the messages hop", () => {
    const m = resolveBodies(db, ["mB2"]);
    expect(m.get("mB2")).toBe("oldest … newest of thread B");
  });

  test("batch: mixed ids, and misses are simply absent", () => {
    const m = resolveBodies(db, ["tA", "mB2", "does-not-exist"]);
    expect(m.get("tA")).toBe("Body of thread A");
    expect(m.get("mB2")).toBe("oldest … newest of thread B");
    expect(m.has("does-not-exist")).toBe(false);
    expect(m.size).toBe(2);
  });

  test("empty id list returns empty map", () => {
    expect(resolveBodies(db, []).size).toBe(0);
  });
});
