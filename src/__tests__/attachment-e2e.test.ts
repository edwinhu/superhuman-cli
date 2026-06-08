// src/__tests__/attachment-e2e.test.ts
// E2E tests for attachment upload across all --attach paths.
// Requires Superhuman running with --remote-debugging-port=9252.
// Skipped when CDP is unavailable or no valid token exists.
import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import CDP from "chrome-remote-interface";
import {
  createDraftWithUserInfo,
  uploadAttachmentSuperhuman,
  deleteDraftWithUserInfo,
  getUserInfoFromCache,
  type UserInfo,
} from "../draft-api";
import { readFileAsBase64 } from "../attachments";
import { resolveToken } from "../token-api";
import { join } from "path";
import { tmpdir } from "os";

const CDP_PORT = 9252;
const TEST_FILE_PATH = join(tmpdir(), "e2e-test-attach.txt");
const TEST_RECIPIENT = "xz2uy@virginia.edu";
const ACCOUNT_EMAIL = "ehu@law.virginia.edu";

let skip = false;
let cdpClient: CDP.Client | null = null;
let userInfo: UserInfo | null = null;
const createdDrafts: Array<{ draftId: string; threadId: string }> = [];

beforeAll(async () => {
  // 1. Try CDP connection
  try {
    cdpClient = await CDP({ port: CDP_PORT });
  } catch {
    skip = true;
    return;
  }

  // 2. Resolve token
  const token = await resolveToken(ACCOUNT_EMAIL);
  if (!token?.idToken || !token?.userId) {
    skip = true;
    return;
  }

  // 3. Build userInfo
  userInfo = getUserInfoFromCache(
    token.userId,
    token.email,
    token.idToken,
    undefined,
    token.userExternalId,
    token.deviceId
  );

  // 4. Create temp test file
  await Bun.write(TEST_FILE_PATH, "E2E test attachment content");
});

afterEach(async () => {
  if (!userInfo) return;
  // Clean up all drafts created during the test
  for (const draft of createdDrafts) {
    try {
      await deleteDraftWithUserInfo(userInfo, draft.threadId, draft.draftId);
    } catch {
      // Best-effort cleanup
    }
  }
  createdDrafts.length = 0;
});

afterAll(async () => {
  if (cdpClient) {
    try {
      await cdpClient.close();
    } catch {
      // ignore
    }
  }
  // Clean up temp file
  try {
    const { unlink } = await import("fs/promises");
    await unlink(TEST_FILE_PATH);
  } catch {
    // ignore
  }
});

describe("draft create --attach (E2E)", () => {
  test("upload returns 200 and metadata write returns 200", async () => {
    if (skip || !userInfo) return;

    // Create draft
    const draft = await createDraftWithUserInfo(userInfo, {
      to: [TEST_RECIPIENT],
      subject: `E2E attach test ${Date.now()}`,
      body: "<p>E2E attachment upload test</p>",
    });
    expect(draft.success).toBe(true);
    expect(draft.draftId).toBeDefined();
    expect(draft.threadId).toBeDefined();
    createdDrafts.push({ draftId: draft.draftId!, threadId: draft.threadId! });

    // Read file
    const fileData = await readFileAsBase64(TEST_FILE_PATH);
    expect(fileData.base64Data).toBeTruthy();

    // Upload attachment (throws on failure)
    const attachment = await uploadAttachmentSuperhuman(
      userInfo,
      draft.draftId!,
      draft.threadId!,
      fileData.filename,
      fileData.mimeType,
      fileData.base64Data
    );

    expect(attachment.uuid).toBeTruthy();
    expect(attachment.name).toBe(fileData.filename);
    expect(attachment.downloadUrl).toBeTruthy();
  });

  test("multiple attachments can be uploaded to same draft", async () => {
    if (skip || !userInfo) return;

    // Create draft
    const draft = await createDraftWithUserInfo(userInfo, {
      to: [TEST_RECIPIENT],
      subject: `E2E multi-attach ${Date.now()}`,
      body: "<p>Draft with multiple attachments</p>",
    });
    expect(draft.success).toBe(true);
    createdDrafts.push({ draftId: draft.draftId!, threadId: draft.threadId! });

    // Upload first attachment
    const fileData = await readFileAsBase64(TEST_FILE_PATH);
    const attach1 = await uploadAttachmentSuperhuman(
      userInfo,
      draft.draftId!,
      draft.threadId!,
      fileData.filename,
      fileData.mimeType,
      fileData.base64Data
    );

    expect(attach1.uuid).toBeTruthy();
    expect(attach1.downloadUrl).toBeTruthy();

    // Upload second attachment (same file, different uuid generated internally)
    const attach2 = await uploadAttachmentSuperhuman(
      userInfo,
      draft.draftId!,
      draft.threadId!,
      "second-file.txt",
      fileData.mimeType,
      fileData.base64Data
    );

    expect(attach2.uuid).toBeTruthy();
    expect(attach2.downloadUrl).toBeTruthy();

    // UUIDs should be different
    expect(attach1.uuid).not.toBe(attach2.uuid);
    // Download URLs should be different
    expect(attach1.downloadUrl).not.toBe(attach2.downloadUrl);
  });
});

describe("draft update --attach (E2E)", () => {
  test("attachment added to existing draft", async () => {
    if (skip || !userInfo) return;

    // Create draft without attachment first
    const draft = await createDraftWithUserInfo(userInfo, {
      to: [TEST_RECIPIENT],
      subject: `E2E update attach ${Date.now()}`,
      body: "<p>Draft to update with attachment</p>",
    });
    expect(draft.success).toBe(true);
    createdDrafts.push({ draftId: draft.draftId!, threadId: draft.threadId! });

    // Now upload attachment to the existing draft
    const fileData = await readFileAsBase64(TEST_FILE_PATH);
    const attachment = await uploadAttachmentSuperhuman(
      userInfo,
      draft.draftId!,
      draft.threadId!,
      fileData.filename,
      fileData.mimeType,
      fileData.base64Data
    );

    expect(attachment.uuid).toBeTruthy();
    expect(attachment.name).toBe(fileData.filename);
    expect(attachment.downloadUrl).toBeTruthy();
  });
});

describe("reply --attach (E2E)", () => {
  test("reply draft gets attachment", async () => {
    if (skip || !userInfo) return;

    // Create an initial draft to get a threadId to reply to
    const original = await createDraftWithUserInfo(userInfo, {
      to: [TEST_RECIPIENT],
      subject: `E2E reply attach original ${Date.now()}`,
      body: "<p>Original message for reply test</p>",
    });
    expect(original.success).toBe(true);
    createdDrafts.push({ draftId: original.draftId!, threadId: original.threadId! });

    // Create a reply draft
    const reply = await createDraftWithUserInfo(userInfo, {
      to: [TEST_RECIPIENT],
      subject: `Re: E2E reply attach original ${Date.now()}`,
      body: "<p>Reply with attachment</p>",
      action: "reply",
      inReplyToThreadId: original.threadId!,
    });
    expect(reply.success).toBe(true);
    createdDrafts.push({ draftId: reply.draftId!, threadId: reply.threadId! });

    // Upload attachment to the reply
    const fileData = await readFileAsBase64(TEST_FILE_PATH);
    const attachment = await uploadAttachmentSuperhuman(
      userInfo,
      reply.draftId!,
      reply.threadId!,
      fileData.filename,
      fileData.mimeType,
      fileData.base64Data
    );

    expect(attachment.uuid).toBeTruthy();
    expect(attachment.name).toBe(fileData.filename);
    expect(attachment.downloadUrl).toBeTruthy();
  });
});

describe("reply-all --attach (E2E)", () => {
  test("reply-all draft gets attachment", async () => {
    if (skip || !userInfo) return;

    // Create an initial draft with multiple recipients
    const original = await createDraftWithUserInfo(userInfo, {
      to: [TEST_RECIPIENT],
      cc: ["eddyhu@gmail.com"],
      subject: `E2E reply-all attach ${Date.now()}`,
      body: "<p>Original for reply-all test</p>",
    });
    expect(original.success).toBe(true);
    createdDrafts.push({ draftId: original.draftId!, threadId: original.threadId! });

    // Create a reply-all draft
    const replyAll = await createDraftWithUserInfo(userInfo, {
      to: [TEST_RECIPIENT],
      cc: ["eddyhu@gmail.com"],
      subject: `Re: E2E reply-all attach ${Date.now()}`,
      body: "<p>Reply-all with attachment</p>",
      action: "reply",
      inReplyToThreadId: original.threadId!,
    });
    expect(replyAll.success).toBe(true);
    createdDrafts.push({ draftId: replyAll.draftId!, threadId: replyAll.threadId! });

    // Upload attachment
    const fileData = await readFileAsBase64(TEST_FILE_PATH);
    const attachment = await uploadAttachmentSuperhuman(
      userInfo,
      replyAll.draftId!,
      replyAll.threadId!,
      fileData.filename,
      fileData.mimeType,
      fileData.base64Data
    );

    expect(attachment.uuid).toBeTruthy();
    expect(attachment.name).toBe(fileData.filename);
    expect(attachment.downloadUrl).toBeTruthy();
  });
});

describe("forward --attach (E2E)", () => {
  test("forward draft gets attachment", async () => {
    if (skip || !userInfo) return;

    // Create a forward draft (new thread, action: forward)
    const forward = await createDraftWithUserInfo(userInfo, {
      to: [TEST_RECIPIENT],
      subject: `Fwd: E2E forward attach ${Date.now()}`,
      body: "<p>Forwarded message with attachment</p>",
      action: "forward",
    });
    expect(forward.success).toBe(true);
    createdDrafts.push({ draftId: forward.draftId!, threadId: forward.threadId! });

    // Upload attachment
    const fileData = await readFileAsBase64(TEST_FILE_PATH);
    const attachment = await uploadAttachmentSuperhuman(
      userInfo,
      forward.draftId!,
      forward.threadId!,
      fileData.filename,
      fileData.mimeType,
      fileData.base64Data
    );

    expect(attachment.uuid).toBeTruthy();
    expect(attachment.name).toBe(fileData.filename);
    expect(attachment.downloadUrl).toBeTruthy();
  });
});
