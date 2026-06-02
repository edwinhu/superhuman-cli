import { test, expect, describe } from "bun:test";
import { buildFtsMatchExpr } from "../sqlite-search";

describe("buildFtsMatchExpr — Gmail-style operators -> FTS3", () => {
  test("bare keyword is a quoted phrase token", () => {
    expect(buildFtsMatchExpr("leak")).toBe(`"leak"`);
  });

  test("multiple bare words AND together as separate phrase tokens", () => {
    expect(buildFtsMatchExpr("dock pro")).toBe(`"dock" "pro"`);
  });

  test("quoted phrase stays a single FTS phrase", () => {
    expect(buildFtsMatchExpr(`"dock pro"`)).toBe(`"dock pro"`);
  });

  test("subject: maps to the subject column (no quoting)", () => {
    expect(buildFtsMatchExpr("subject:Leak")).toBe("subject:Leak");
  });

  test("from:/to: map to their columns", () => {
    expect(buildFtsMatchExpr("from:taniza")).toBe("from:taniza");
    // Dotted values split into per-token column filters (porter tokenizes on '.')
    expect(buildFtsMatchExpr("to:sleep.me")).toBe("to:sleep to:me");
  });

  test("body: maps to the content column", () => {
    expect(buildFtsMatchExpr("body:refund")).toBe("content:refund");
  });

  test("is:starred -> labels:STARRED", () => {
    expect(buildFtsMatchExpr("is:starred")).toBe("labels:STARRED");
  });

  test("in:sent -> labels:SENT", () => {
    expect(buildFtsMatchExpr("in:sent")).toBe("labels:SENT");
  });

  test("in:<arbitrary> upper-cases to a label token", () => {
    expect(buildFtsMatchExpr("in:promotions")).toBe("labels:PROMOTIONS");
  });

  test("label: maps to the labels column, upper-cased", () => {
    expect(buildFtsMatchExpr("label:important")).toBe("labels:IMPORTANT");
  });

  test("combines operators with bare terms (implicit AND)", () => {
    expect(buildFtsMatchExpr("subject:leak is:starred")).toBe(
      "subject:leak labels:STARRED"
    );
    expect(buildFtsMatchExpr("leak from:sleep")).toBe(`"leak" from:sleep`);
  });

  test("multi-word operator value emits one col:token per word", () => {
    expect(buildFtsMatchExpr(`subject:"dock pro"`)).toBe(
      "subject:dock subject:pro"
    );
  });

  test("leading - negates with binary NOT (needs a positive side)", () => {
    expect(buildFtsMatchExpr("project -newsletter")).toBe(`"project" NOT "newsletter"`);
    expect(buildFtsMatchExpr("leak -is:starred")).toBe(`"leak" NOT labels:STARRED`);
  });

  test("negation-only query drops the NOT (FTS3 NOT is binary) and falls back", () => {
    // No positive side -> the lone negative cannot anchor a NOT; we fall back to
    // a plain phrase match of the whole query rather than emit invalid SQL.
    const expr = buildFtsMatchExpr("-newsletter");
    expect(expr).not.toContain("NOT");
  });

  test("unknown operators (has:) are dropped, not matched literally", () => {
    // has:attachment is unsupported; it must not become the literal token
    // "has:attachment" (which matches nothing). The bare term survives.
    expect(buildFtsMatchExpr("has:attachment leak")).toBe(`"leak"`);
  });

  test("internal double-quotes in a bare term are escaped", () => {
    expect(buildFtsMatchExpr(`say "hi"`)).toBe(`"say" "hi"`);
  });

  test("empty query falls back to an empty phrase token", () => {
    expect(buildFtsMatchExpr("   ")).toBe(`""`);
  });

  // --- injection / malformed-MATCH safety (operator values are unquotable) ---

  test("operator value with unbalanced paren is sanitized into safe tokens", () => {
    // Was: subject:foo(bar -> SQLite "malformed MATCH expression" crash.
    expect(buildFtsMatchExpr("subject:foo(bar")).toBe("subject:foo subject:bar");
  });

  test("operator value with embedded quote is sanitized", () => {
    expect(buildFtsMatchExpr('from:a"b')).toBe("from:a from:b");
  });

  test("FTS bareword operators inside an operator value are dropped", () => {
    // OR/NOT/NEAR embedded in an operator value would otherwise act as operators.
    expect(buildFtsMatchExpr("subject:foo OR bar")).toBe(
      `subject:foo "OR" "bar"`
    ); // the standalone OR becomes a safe quoted bare token, not an operator
    expect(buildFtsMatchExpr('subject:"foo OR bar"')).toBe("subject:foo subject:bar"); // OR dropped inside the value
  });

  test("label operator value keeps only label-safe chars", () => {
    expect(buildFtsMatchExpr("in:foo(bar")).toBe("labels:FOOBAR");
    expect(buildFtsMatchExpr('is:"* NEAR 5"')).toBe("labels:NEAR5");
  });

  test("operator value that sanitizes to nothing is dropped, not malformed", () => {
    // subject:( -> operator value sanitizes to empty -> dropped; fallback is the
    // sanitized keyword phrase of the whole query ("subject"), never raw "(".
    expect(buildFtsMatchExpr("subject:(")).toBe(`"subject"`);
    expect(buildFtsMatchExpr("subject:( leak")).toBe(`"leak"`);
  });

  test("none of the sanitized outputs contain raw FTS metacharacters", () => {
    for (const q of [
      "subject:foo(bar",
      'from:a"b',
      "to:x*",
      "in:foo)bar",
      "label:a:b",
      "subject:a-b",
    ]) {
      const expr = buildFtsMatchExpr(q);
      expect(expr).not.toMatch(/[()"*]/);
    }
  });
});
