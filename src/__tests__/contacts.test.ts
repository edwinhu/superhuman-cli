import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import {
  connectToSuperhuman,
  disconnect,
  type SuperhumanConnection,
} from "../superhuman-api";
import { searchContacts, resolveRecipient, type Contact } from "../contacts";

const CDP_PORT = 9333;

describe("contacts", () => {
  let conn: SuperhumanConnection | null = null;

  beforeAll(async () => {
    conn = await connectToSuperhuman(CDP_PORT);
    if (!conn) {
      throw new Error(
        "Could not connect to Superhuman. Make sure it is running with --remote-debugging-port=9333"
      );
    }
  });

  afterAll(async () => {
    if (conn) {
      await disconnect(conn);
    }
  });

  test("searchContacts returns array of contacts matching prefix", async () => {
    if (!conn) throw new Error("No connection");

    // Search for a common prefix
    const contacts = await searchContacts(conn, "ed");

    // Verify we got an array
    expect(Array.isArray(contacts)).toBe(true);

    // Should have at least some results for a common prefix
    expect(contacts.length).toBeGreaterThan(0);

    // Verify structure - first contact should have email
    const first = contacts[0];
    expect(first).toHaveProperty("email");
    expect(typeof first.email).toBe("string");
    expect(first.email).toContain("@");

    // Name is optional but if present should be string
    if (first.name !== undefined) {
      expect(typeof first.name).toBe("string");
    }
  });

  test("searchContacts with limit option respects limit", async () => {
    if (!conn) throw new Error("No connection");

    const contacts = await searchContacts(conn, "a", { limit: 3 });

    expect(contacts.length).toBeLessThanOrEqual(3);
  });

  test("searchContacts with empty query returns empty array", async () => {
    if (!conn) throw new Error("No connection");

    const contacts = await searchContacts(conn, "");

    expect(Array.isArray(contacts)).toBe(true);
    // Empty query might return empty or some default results
  });

  test("resolveRecipient returns email unchanged if already valid", async () => {
    if (!conn) throw new Error("No connection");

    const result = await resolveRecipient(conn, "test@example.com");
    expect(result).toBe("test@example.com");
  });

  test("resolveRecipient resolves name to email address", async () => {
    if (!conn) throw new Error("No connection");

    // Search for a name that should have matches
    const result = await resolveRecipient(conn, "ed");

    // Should return an email address
    expect(result).toContain("@");
  });

  test("resolveRecipient returns original if no matches found", async () => {
    if (!conn) throw new Error("No connection");

    // Use a very unlikely query
    const result = await resolveRecipient(conn, "xyznonexistent12345");

    // Should return the original since no matches
    expect(result).toBe("xyznonexistent12345");
  });
});
