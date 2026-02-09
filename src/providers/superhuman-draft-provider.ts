/**
 * Superhuman Native Draft Provider
 *
 * Fetches native drafts (draft00... IDs) from Superhuman's userdata.getThreads API.
 */

import type { Draft, IDraftProvider } from "../services/draft-service";
import type { TokenInfo } from "../token-api";
import {
  createDraftWithUserInfo,
  updateDraftWithUserInfo,
  deleteDraftWithUserInfo,
  getUserInfoFromCache,
} from "../draft-api";

const SUPERHUMAN_API = "https://mail.superhuman.com/~backend/v3";

/**
 * Superhuman API response types
 */
interface SuperhumanDraft {
  id: string;
  subject: string;
  to: string[];
  from: string;
  snippet: string;
  date: string;
}

interface SuperhumanMessage {
  draft: SuperhumanDraft;
}

interface SuperhumanThread {
  thread: {
    id: string;
    messages: Record<string, SuperhumanMessage>;
  };
}

interface SuperhumanGetThreadsResponse {
  threadList: SuperhumanThread[];
}

/**
 * Provider that fetches native Superhuman drafts from userdata.getThreads API
 */
export class SuperhumanDraftProvider implements IDraftProvider {
  readonly source: Draft["source"] = "native";
  private token: TokenInfo;
  private draftCache: Map<string, Draft> = new Map(); // Cache drafts by ID for update/delete

  constructor(token: TokenInfo) {
    this.token = token;
  }

  async listDrafts(limit: number = 50, offset: number = 0): Promise<Draft[]> {
    // Use Superhuman backend token (not OAuth accessToken)
    const authToken = this.token.superhumanToken?.token;
    if (!authToken) {
      // No Superhuman token available - can't fetch native drafts
      return [];
    }

    const response = await fetch(`${SUPERHUMAN_API}/userdata.getThreads`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: { type: "draft" },
        offset,
        limit,
      }),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as SuperhumanGetThreadsResponse;
    const drafts = this.parseThreadList(data.threadList || []);

    // Update cache with latest drafts
    for (const draft of drafts) {
      this.draftCache.set(draft.id, draft);
    }

    return drafts;
  }

  async updateDraft(draftId: string, updates: Partial<Draft>): Promise<boolean> {
    // 1. Try to get existing draft from cache first (avoids extra fetch)
    let existingDraft = this.draftCache.get(draftId);

    // If not in cache, fetch from API
    if (!existingDraft) {
      const drafts = await this.listDrafts();
      existingDraft = drafts.find((d) => d.id === draftId);
    }

    if (!existingDraft) {
      throw new Error(`Draft ${draftId} not found`);
    }

    // 2. Get user info from token
    const authToken = this.token.superhumanToken?.token;
    if (!authToken) {
      throw new Error("No Superhuman token available");
    }

    const userInfo = getUserInfoFromCache(
      this.token.userId,
      this.token.email,
      authToken,
      this.token.email.split("@")[0] // Use email prefix as display name
    );

    // 3. Merge updates with existing draft
    const mergedDraft = {
      to: updates.to || existingDraft.to,
      subject: updates.subject || existingDraft.subject,
      body: updates.preview || existingDraft.preview, // preview maps to body
    };

    // 4. Use the threadId from the existing draft (critical for correct path!)
    const threadId = existingDraft.threadId;
    if (!threadId) {
      throw new Error(`Draft ${draftId} missing threadId - cannot update`);
    }

    // 5. Call updateDraftWithUserInfo (reuses existing IDs - same endpoint as CREATE!)
    await updateDraftWithUserInfo(userInfo, threadId, draftId, mergedDraft);

    // 6. Update cache with merged draft
    this.draftCache.set(draftId, {
      ...existingDraft,
      ...updates,
    });

    return true;
  }

  async deleteDraft(draftId: string): Promise<boolean> {
    // 1. Try to get existing draft from cache first (avoids extra fetch)
    let existingDraft = this.draftCache.get(draftId);

    // If not in cache, fetch from API
    if (!existingDraft) {
      const drafts = await this.listDrafts();
      existingDraft = drafts.find((d) => d.id === draftId);
    }

    if (!existingDraft) {
      throw new Error(`Draft ${draftId} not found`);
    }

    // 2. Get user info from token
    const authToken = this.token.superhumanToken?.token;
    if (!authToken) {
      throw new Error("No Superhuman token available");
    }

    const userInfo = getUserInfoFromCache(
      this.token.userId,
      this.token.email,
      authToken,
      this.token.email.split("@")[0]
    );

    // 3. Use the threadId from the existing draft (critical for correct path!)
    const threadId = existingDraft.threadId;
    if (!threadId) {
      throw new Error(`Draft ${draftId} missing threadId - cannot delete`);
    }

    // 4. Call deleteDraftWithUserInfo
    await deleteDraftWithUserInfo(userInfo, threadId, draftId);

    // 5. Remove from cache
    this.draftCache.delete(draftId);

    return true;
  }

  private parseThreadList(threadList: SuperhumanThread[]): Draft[] {
    const drafts: Draft[] = [];

    for (const threadItem of threadList) {
      const threadId = threadItem.thread?.id;
      const messages = threadItem.thread?.messages || {};

      for (const [messageId, message] of Object.entries(messages)) {
        if (message.draft) {
          const draft = message.draft;
          drafts.push({
            id: draft.id,
            subject: draft.subject || "(no subject)",
            from: draft.from || "",
            to: draft.to || [],
            preview: draft.snippet || "",
            timestamp: draft.date || "",
            source: "native",
            threadId: threadId, // Capture threadId for update/delete operations
          });
        }
      }
    }

    return drafts;
  }
}
