/**
 * Local draft metadata cache.
 *
 * Stores to/subject/body/threadId for drafts created by forward/reply/compose
 * so that `draft send <id>` can send without requiring --to/--subject/--body.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import type { SuperhumanAttachment } from "./draft-api";

/**
 * A previously-uploaded attachment, persisted so `draft send <id>` can re-include
 * it in the outgoing_message. It is the same shape `sendDraftSuperhuman` consumes
 * — sharing the type keeps the cache and send payload from drifting apart.
 */
export type DraftMetaAttachment = SuperhumanAttachment;

export interface DraftMeta {
  draftId: string;
  threadId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  htmlBody: string;
  inReplyTo?: string;
  references?: string[];
  createdAt: string;
  /** Attachments uploaded against this draft (so `draft send` can re-include them) */
  attachments?: DraftMetaAttachment[];
  /**
   * Provider (MS Graph item / Gmail) message id of the message being replied to.
   * Goes into outgoing_message.in_reply_to at send time (distinct from the rfc822
   * In-Reply-To header). Needed for the backend to thread + send a reply.
   */
  inReplyToItemId?: string;
  /**
   * Provider message ids of the prior messages in the thread. At send time the
   * draft id is appended to form outgoing_message.current_message_ids. Without
   * this a reply sent via `draft send` carries only [draftId] and fails delivery.
   */
  replyItemIds?: string[];
}

function getCacheFile(): string {
  const configDir =
    process.env.SUPERHUMAN_CLI_CONFIG_DIR ||
    join(homedir(), ".config/superhuman-cli");
  return join(configDir, "draft-cache.json");
}

function loadCache(): Record<string, DraftMeta> {
  try {
    return JSON.parse(readFileSync(getCacheFile(), "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, DraftMeta>): void {
  const file = getCacheFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cache, null, 2));
}

export function saveDraftMeta(meta: DraftMeta): void {
  const cache = loadCache();
  cache[meta.draftId] = meta;
  saveCache(cache);
}

export function loadDraftMeta(draftId: string): DraftMeta | null {
  return loadCache()[draftId] ?? null;
}

export function deleteDraftMeta(draftId: string): void {
  const cache = loadCache();
  if (draftId in cache) {
    delete cache[draftId];
    saveCache(cache);
  }
}
