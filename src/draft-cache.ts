/**
 * Local draft metadata cache.
 *
 * Stores to/subject/body/threadId for drafts created by forward/reply/compose
 * so that `draft send <id>` can send without requiring --to/--subject/--body.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

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
