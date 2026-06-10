/**
 * Per-account Superhuman signature resolution + send-time body assembly.
 *
 * How the app stores signatures (reverse-engineered from the web bundle's
 * `getSignature({email})`, 2026-06-10):
 *
 *  - Google accounts: the signature HTML is the `signature` field of the
 *    matching Gmail sendAs alias — synced into account settings under
 *    `aliases.list[].sendAs.signature`. Superhuman never edits it (the
 *    settings dialog links to Gmail settings).
 *  - Microsoft accounts: the signature lives in a hidden draft with
 *    `action: "signature"`. Its ids are recorded in the `signatures`
 *    settings key ({microsoftSignatureThreadID, microsoftSignatureDraftID})
 *    and the body is fetched from userdata. Legacy fallback: the
 *    `microsoftSignature` settings key holds the raw HTML.
 *
 * Both the settings JSON and the flags (`skipSuperhumanSignature`,
 * `includeSignatureOnReplies`) are read from the local SQLite mirror
 * (`general` table, key "settings") — no extra backend call for Google.
 *
 * The app appends the signature to the outgoing html_body AT SEND TIME
 * (OutgoingMessage.fromDraft → BodyContent.generateForOutgoingMessage)
 * whenever the draft's quoted content is NOT inlined into the body. CLI
 * drafts always write `quotedContentInlined: false`, so the desktop/mobile
 * apps add the signature themselves when they send a CLI draft — which is
 * exactly why the CLI must do the same in its own send path, and why the
 * signature must NOT be baked into the stored draft body (the app would
 * then add a second copy).
 */

import { Database } from "bun:sqlite";
import { findOPFSBlob, extractSQLite } from "./sqlite-search";
import type { UserInfo } from "./draft-api";

const SUPERHUMAN_BACKEND = "https://mail.superhuman.com/~backend";

export interface SignatureInfo {
  /** Raw signature HTML ("" when the account has none configured). */
  content: string;
  /** true = omit the "Sent via Superhuman" promo footer. */
  skipSuperhumanSignature: boolean;
  /** false = the signature content is omitted on replies and forwards. */
  includeSignatureOnReplies: boolean;
}

/** Parsed shape of the relevant account-settings keys. */
interface AccountSettings {
  aliases?: { list?: Array<{ sendAs?: { sendAsEmail?: string; isDefault?: boolean; signature?: string } }> };
  signatures?: { microsoftSignatureThreadID?: string; microsoftSignatureDraftID?: string };
  microsoftSignature?: string;
  skipSuperhumanSignature?: boolean;
  includeSignatureOnReplies?: boolean;
}

/**
 * Read the account settings JSON from the local SQLite mirror
 * (`general` table, key "settings"). Returns null when the OPFS blob or the
 * settings row can't be located — callers treat that as "no signature".
 */
export function readAccountSettings(accountEmail: string): AccountSettings | null {
  try {
    const blobPath = findOPFSBlob(accountEmail);
    if (!blobPath) return null;
    const dbPath = extractSQLite(blobPath);
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query(`SELECT json FROM general WHERE key = 'settings'`)
        .get() as { json: string } | null;
      if (!row?.json) return null;
      return JSON.parse(row.json) as AccountSettings;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Pick the signature HTML for a Google account from the alias list: exact
 * sendAs match on the from-address first, then the default alias.
 */
export function gmailAliasSignature(settings: AccountSettings, fromEmail: string): string {
  const list = settings.aliases?.list ?? [];
  const wanted = fromEmail.toLowerCase();
  const exact = list.find((a) => a.sendAs?.sendAsEmail?.toLowerCase() === wanted);
  if (exact?.sendAs?.signature) return exact.sendAs.signature;
  const def = list.find((a) => a.sendAs?.isDefault);
  return def?.sendAs?.signature ?? "";
}

/**
 * Fetch the Microsoft signature draft's body from userdata. The signature is
 * a hidden draft (action: "signature"); userdata.getThreads has no by-id
 * lookup, so page through the draft set and match the message id.
 */
async function fetchMicrosoftSignatureBody(
  userInfo: UserInfo,
  signatureDraftId: string
): Promise<string | null> {
  const PAGE = 100;
  const MAX_DRAFTS = 1000;
  for (let offset = 0; offset < MAX_DRAFTS; offset += PAGE) {
    const response = await fetch(`${SUPERHUMAN_BACKEND}/v3/userdata.getThreads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userInfo.token}`,
      },
      body: JSON.stringify({ filter: { type: "draft" }, offset, limit: PAGE }),
    });
    if (!response.ok) return null;
    const data: any = await response.json();
    const list: any[] = data.threadList || [];
    for (const th of list) {
      const draft = th?.thread?.messages?.[signatureDraftId]?.draft;
      if (draft?.body) return draft.body as string;
    }
    if (list.length < PAGE) break;
  }
  return null;
}

const signatureCache = new Map<string, SignatureInfo>();

/** Test hook: clear the per-process signature cache. */
export function clearSignatureCache(): void {
  signatureCache.clear();
}

/**
 * Resolve the account's signature + flags. Returns null when the local
 * settings mirror can't be read at all (send proceeds unsigned).
 */
export async function getSignatureInfo(userInfo: UserInfo): Promise<SignatureInfo | null> {
  const cached = signatureCache.get(userInfo.email);
  if (cached) return cached;

  const settings = readAccountSettings(userInfo.email);
  if (!settings) return null;

  let content = "";
  const msDraftId = settings.signatures?.microsoftSignatureDraftID;
  if (msDraftId) {
    try {
      content =
        (await fetchMicrosoftSignatureBody(userInfo, msDraftId)) ??
        settings.microsoftSignature ??
        "";
    } catch {
      content = settings.microsoftSignature ?? "";
    }
  } else {
    content = gmailAliasSignature(settings, userInfo.email);
  }

  const info: SignatureInfo = {
    content,
    skipSuperhumanSignature: settings.skipSuperhumanSignature ?? false,
    includeSignatureOnReplies: settings.includeSignatureOnReplies ?? true,
  };
  signatureCache.set(userInfo.email, info);
  return info;
}

/**
 * Render the signature block exactly like the app's Signature.render():
 *
 *   <div class="gmail_signature">
 *     [<div>{content}</div>]          ← only if includeSignatureContent
 *     [<br>]                          ← only between content and footer
 *     [Sent via Superhuman footer]    ← only if !skipSuperhumanSignature
 *     <br>
 *   </div>
 *
 * Returns "" when there is nothing to render (no content and the promo
 * footer is disabled).
 */
export function renderSignatureBlock(
  info: SignatureInfo,
  opts: { isReply?: boolean } = {}
): string {
  const includeContent = !opts.isReply || info.includeSignatureOnReplies;
  const content = includeContent ? info.content : "";
  if (!content && info.skipSuperhumanSignature) return "";

  const footer = info.skipSuperhumanSignature
    ? ""
    : `<div style="clear:both">Sent via <a href="https://superhuman.com/products/mail" target="_blank">Superhuman</a></div>`;
  const parts = [
    content ? `<div>${content}</div>` : "",
    content && footer ? "<br>" : "",
    footer,
    "<br>",
  ].join("");
  return `<div class="gmail_signature">${parts}</div>`;
}

/**
 * True when the body already carries a signature (e.g. a draft composed in
 * the official app, whose body embeds the signature with
 * data-signature-draft-id markers) — appending another would duplicate it.
 */
export function hasExistingSignature(htmlBody: string): boolean {
  return /gmail_signature|sh-signature|data-signature-draft-id/.test(htmlBody);
}

/** CLI forward bodies inline the forwarded message under this header. */
const FORWARD_MARKER = "<div>---------- Forwarded message ---------</div>";

/**
 * Insert the signature block into an outgoing body with the app's placement:
 * after the typed text, BEFORE any quoted/forwarded content. CLI forward
 * bodies inline the forwarded message (the app keeps it in quotedContent),
 * so split on the forwarded-message header when present.
 */
export function insertSignatureIntoBody(htmlBody: string, signatureBlock: string): string {
  if (!signatureBlock) return htmlBody;
  const idx = htmlBody.indexOf(FORWARD_MARKER);
  if (idx >= 0) {
    return `<div>${htmlBody.slice(0, idx)}<br>${signatureBlock}${htmlBody.slice(idx)}</div>`;
  }
  return `<div>${htmlBody}<br>${signatureBlock}</div>`;
}

export interface SignedBodyResult {
  htmlBody: string;
  didAddSignature: boolean;
}

/**
 * Append the account signature to an outgoing html body (no-op when the
 * body already has one, when nothing is configured, or when settings are
 * unreadable). This is the single entry point used by sendDraftSuperhuman.
 */
export async function buildSignedBody(
  userInfo: UserInfo,
  htmlBody: string,
  opts: { isReply?: boolean } = {}
): Promise<SignedBodyResult> {
  if (hasExistingSignature(htmlBody)) {
    return { htmlBody, didAddSignature: false };
  }
  const info = await getSignatureInfo(userInfo);
  if (!info) return { htmlBody, didAddSignature: false };
  // Forwards count as replies for includeSignatureOnReplies (the app's
  // checkbox reads "Include signature on replies and forwards"). Forward
  // sends carry no inReplyTo, so detect them by the inlined forward header.
  const isReply = opts.isReply || htmlBody.includes(FORWARD_MARKER);
  const block = renderSignatureBlock(info, { isReply });
  if (!block) return { htmlBody, didAddSignature: false };
  return { htmlBody: insertSignatureIntoBody(htmlBody, block), didAddSignature: true };
}
