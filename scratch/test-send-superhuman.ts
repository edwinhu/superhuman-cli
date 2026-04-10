#!/usr/bin/env bun
import { getUserInfoFromCache, createDraftWithUserInfo, sendDraftSuperhuman } from "./src/draft-api";
import { loadTokensFromDisk, getCachedAccounts, hasCachedSuperhumanCredentials, getCachedToken, getThreadInfoDirect } from "./src/token-api";
import { textToHtml } from "./src/superhuman-api";

async function main() {
  await loadTokensFromDisk();
  const accounts = getCachedAccounts();
  let token = null;
  for (const email of accounts) {
    if (await hasCachedSuperhumanCredentials(email)) {
      token = await getCachedToken(email);
      if (token?.idToken && token?.userId) break;
    }
  }
  if (!token) { console.error("No token"); process.exit(1); }

  const userInfo = getUserInfoFromCache(token.userId, token.email, token.idToken);
  const threadInfo = await getThreadInfoDirect(token, "19cc0013fecadcc5");
  if (!threadInfo) { console.error("No thread info"); process.exit(1); }

  const subject = threadInfo.subject.startsWith("Re:") ? threadInfo.subject : "Re: " + threadInfo.subject;

  // Create draft
  const draft = await createDraftWithUserInfo(userInfo, {
    to: [threadInfo.from],
    subject,
    body: textToHtml("Test send via sendDraftSuperhuman (no attachment)"),
    action: "reply",
    inReplyToThreadId: "19cc0013fecadcc5",
    inReplyToRfc822Id: threadInfo.messageId || undefined,
    references: threadInfo.references,
  });

  console.log("Draft created:", draft);

  // Try sending
  const result = await sendDraftSuperhuman(userInfo, {
    draftId: draft.draftId!,
    threadId: draft.threadId!,
    to: [{ email: threadInfo.from }],
    subject,
    htmlBody: textToHtml("Test send via sendDraftSuperhuman (no attachment)"),
    inReplyTo: threadInfo.messageId || undefined,
    references: threadInfo.references,
  });

  console.log("Send result:", result);
}

main().catch(console.error);
