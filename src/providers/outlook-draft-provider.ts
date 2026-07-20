/**
 * Outlook Web Native Draft Provider
 *
 * Lists drafts from the Outlook Drafts folder via the Outlook REST backend
 * (the first-party OWA token), mapped to the unified Draft shape. Sibling to
 * SuperhumanDraftProvider for `draft list` on Microsoft accounts.
 */

import type { Draft, IDraftProvider } from "../services/draft-service";
import type { OutlookWebProvider } from "../outlook-web-provider";
import { owaListDrafts, owaDelete } from "../outlook-rest-api";

export class OutlookDraftProvider implements IDraftProvider {
  readonly source: Draft["source"] = "native";

  constructor(private provider: OutlookWebProvider) {}

  async listDrafts(limit: number = 50): Promise<Draft[]> {
    return owaListDrafts(this.provider.fetcher(), limit);
  }

  /** Delete a draft (move to Deleted Items — never a hard delete). */
  async deleteDraft(draftId: string): Promise<boolean> {
    await owaDelete(this.provider.fetcher(), [draftId]);
    return true;
  }
}
