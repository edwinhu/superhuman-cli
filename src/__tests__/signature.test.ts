import { test, expect, beforeEach } from "bun:test";
import {
  renderSignatureBlock,
  hasExistingSignature,
  insertSignatureIntoBody,
  gmailAliasSignature,
  buildSignedBody,
  clearSignatureCache,
  type SignatureInfo,
} from "../signature";
import type { UserInfo } from "../draft-api";

const SIG = `<div class="sh-signature">Edwin Hu<br>Associate Professor of Law</div>`;

function info(overrides: Partial<SignatureInfo> = {}): SignatureInfo {
  return {
    content: SIG,
    skipSuperhumanSignature: true,
    includeSignatureOnReplies: true,
    ...overrides,
  };
}

beforeEach(() => clearSignatureCache());

// ---------------------------------------------------------------------------
// renderSignatureBlock — must match the app's Signature.render() markup
// ---------------------------------------------------------------------------

test("renders signature content without promo footer when skipSuperhumanSignature", () => {
  const block = renderSignatureBlock(info());
  expect(block).toBe(`<div class="gmail_signature"><div>${SIG}</div><br></div>`);
});

test("renders promo footer when skipSuperhumanSignature is false", () => {
  const block = renderSignatureBlock(info({ skipSuperhumanSignature: false }));
  expect(block).toContain("Sent via");
  expect(block).toContain("superhuman.com");
  // content, then <br>, then footer
  expect(block.indexOf(SIG)).toBeLessThan(block.indexOf("Sent via"));
});

test("returns empty string when no content and footer disabled", () => {
  expect(renderSignatureBlock(info({ content: "" }))).toBe("");
});

test("renders footer-only block when no content but footer enabled", () => {
  const block = renderSignatureBlock(info({ content: "", skipSuperhumanSignature: false }));
  expect(block).toContain("Sent via");
  expect(block).not.toContain("sh-signature");
});

test("omits content on replies when includeSignatureOnReplies is false", () => {
  const block = renderSignatureBlock(info({ includeSignatureOnReplies: false }), {
    isReply: true,
  });
  expect(block).toBe(""); // skip=true + no content -> nothing to render
});

test("includes content on replies when includeSignatureOnReplies is true", () => {
  const block = renderSignatureBlock(info(), { isReply: true });
  expect(block).toContain(SIG);
});

// ---------------------------------------------------------------------------
// hasExistingSignature — dedupe guard for app-composed drafts
// ---------------------------------------------------------------------------

test("detects app-composed bodies that already carry a signature", () => {
  expect(hasExistingSignature(`<div class="gmail_signature"><div>x</div></div>`)).toBe(true);
  expect(hasExistingSignature(`<div data-signature-draft-id="draft00ab">x</div>`)).toBe(true);
  expect(hasExistingSignature(`<div class="sh-signature">x</div>`)).toBe(true);
  expect(hasExistingSignature(`<div>plain body</div>`)).toBe(false);
});

// ---------------------------------------------------------------------------
// insertSignatureIntoBody — placement (after body, before forwarded content)
// ---------------------------------------------------------------------------

test("appends signature after a plain body", () => {
  const out = insertSignatureIntoBody("<div>hello</div>", "<SIG>");
  expect(out).toBe("<div><div>hello</div><br><SIG></div>");
});

test("inserts signature BEFORE forwarded content", () => {
  const marker = "<div>---------- Forwarded message ---------</div>";
  const body = `typed text<br><br>${marker}<br><div>original</div>`;
  const out = insertSignatureIntoBody(body, "<SIG>");
  expect(out.indexOf("<SIG>")).toBeGreaterThan(out.indexOf("typed text"));
  expect(out.indexOf("<SIG>")).toBeLessThan(out.indexOf(marker));
});

test("no-op when signature block is empty", () => {
  expect(insertSignatureIntoBody("<div>hello</div>", "")).toBe("<div>hello</div>");
});

// ---------------------------------------------------------------------------
// gmailAliasSignature — alias resolution from settings
// ---------------------------------------------------------------------------

const settings = {
  aliases: {
    list: [
      { sendAs: { sendAsEmail: "main@gmail.com", isDefault: true, signature: "<p>main sig</p>" } },
      { sendAs: { sendAsEmail: "alias@example.com", signature: "<p>alias sig</p>" } },
      { sendAs: { sendAsEmail: "nosig@example.com" } },
    ],
  },
};

test("picks the exact alias signature for the from address", () => {
  expect(gmailAliasSignature(settings, "alias@example.com")).toBe("<p>alias sig</p>");
  expect(gmailAliasSignature(settings, "ALIAS@EXAMPLE.COM")).toBe("<p>alias sig</p>");
});

test("falls back to the default alias signature", () => {
  expect(gmailAliasSignature(settings, "unknown@nowhere.com")).toBe("<p>main sig</p>");
});

test("returns empty string when the alias has no signature and no default exists", () => {
  expect(gmailAliasSignature({ aliases: { list: [] } }, "x@y.com")).toBe("");
  // exact alias without signature still falls back to default
  expect(gmailAliasSignature(settings, "nosig@example.com")).toBe("<p>main sig</p>");
});

// ---------------------------------------------------------------------------
// buildSignedBody — end-to-end no-ops
// ---------------------------------------------------------------------------

const fakeUser: UserInfo = {
  userId: "u",
  email: "no-such-account@example.com",
  token: "t",
  timeZone: "America/New_York",
};

test("passes body through unchanged when account settings are unavailable", async () => {
  const out = await buildSignedBody(fakeUser, "<div>hello</div>");
  expect(out.didAddSignature).toBe(false);
  expect(out.htmlBody).toBe("<div>hello</div>");
});

test("never double-appends when body already has a signature", async () => {
  const body = `<div>hi</div><div class="gmail_signature"><div>sig</div></div>`;
  const out = await buildSignedBody(fakeUser, body);
  expect(out.didAddSignature).toBe(false);
  expect(out.htmlBody).toBe(body);
});
