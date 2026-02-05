# Investigation: Superhuman Drafts API Discovery

**Date:** 2026-02-05
**Objective:** Discover Superhuman's backend API for draft operations

## Summary

**Finding:** Superhuman DOES have a backend drafts API. The `/v3/userdata.sync` endpoint syncs drafts (and other user data) to Superhuman's backend. This enables cross-device sync including mobile.

**Key Discovery:** The sync traffic happens through the **background page**, not the renderer page. Monitoring the wrong CDP target initially led to incorrect conclusions.

## The Sync Endpoint

### `/v3/userdata.sync`

**URL:** `https://mail.superhuman.com/~backend/v3/userdata.sync`
**Method:** POST
**Purpose:** Bidirectional sync of user data including drafts

**Request:**
```json
{"startHistoryId": 94737}
```

**Response (abbreviated):**
```json
{
  "history": {
    "threads": {
      "draft00641f5e43725704": {
        "historyId": 94738,
        "messages": {
          "draft001cf2c9586ed3f3": {
            "draft": {
              "schemaVersion": 3,
              "id": "draft001cf2c9586ed3f3",
              "action": "compose",
              "from": "Eddy Hu <eddyhu@gmail.com>",
              "to": ["Eddy Hu <ehu@law.virginia.edu>"],
              "body": "",
              "subject": "test",
              "labelIds": ["DRAFT"],
              "threadId": "draft00641f5e43725704"
            }
          }
        }
      }
    }
  }
}
```

### Draft Object Structure

| Field | Description |
|-------|-------------|
| `schemaVersion` | Draft schema version (currently 3) |
| `id` | Unique draft ID (e.g., `draft001cf2c9586ed3f3`) |
| `action` | Draft type: `compose`, `reply`, `forward` |
| `from` | Sender address |
| `to` | Array of recipient addresses |
| `cc` | Array of CC addresses |
| `bcc` | Array of BCC addresses |
| `subject` | Email subject |
| `body` | HTML body content |
| `labelIds` | Always includes `["DRAFT"]` |
| `threadId` | Thread ID (draft-prefixed for new compositions) |

## Methodology

### Initial Approach (Incorrect)
1. Connected CDP to renderer page
2. Monitored `Network.requestWillBeSent`
3. Created draft, observed no sync traffic
4. **Incorrectly concluded** no backend API exists

### Corrected Approach
1. Listed all CDP targets via `CDP.List()`
2. Identified **background page** (`background_page.html`)
3. Connected CDP to background page
4. Monitored network traffic
5. **Discovered** `/v3/userdata.sync` endpoint with full draft data

### Key Insight

Superhuman uses a Chrome extension architecture with separate processes:
- **Renderer page:** Handles UI, compose form, user interaction
- **Background page:** Handles sync, API calls, cross-tab communication

Draft saves in the renderer trigger sync in the background page via inter-process messaging.

## How Superhuman Drafts Work

```
┌─────────────────────────────────────────────────────────────────┐
│                        Renderer Page                             │
│  ┌─────────────────┐    ┌──────────────────┐                    │
│  │ ComposeFormCtrl │───▶│ _saveDraftAsync()│                    │
│  └─────────────────┘    └────────┬─────────┘                    │
│                                  │                               │
│                          LocalStorage/SQLite                     │
└──────────────────────────────────│──────────────────────────────┘
                                   │ (message via portal)
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Background Page                            │
│  ┌─────────────────┐    ┌──────────────────┐                    │
│  │   Sync Service  │───▶│ /v3/userdata.sync│──────▶ Backend     │
│  └─────────────────┘    └──────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                            ┌─────────────┐
                            │Mobile/Other │
                            │   Devices   │
                            └─────────────┘
```

1. **UI Layer:** `ComposeFormController` manages draft state
2. **Save:** `_saveDraftAsync()` persists to local storage
3. **Sync:** Background page detects changes, calls `/v3/userdata.sync`
4. **History:** Uses `historyId` for incremental sync
5. **Cross-device:** Other devices poll with their `startHistoryId`

## CDP Implementation

The current implementation uses CDP to manipulate the compose form, which triggers the normal save/sync flow:

| Function | Purpose |
|----------|---------|
| `openCompose()` | Opens compose window, returns draft key |
| `setSubject(conn, subject, draftKey)` | Sets draft subject |
| `addRecipient(conn, email, name, draftKey)` | Adds To recipient |
| `addCcRecipient(conn, email, name, draftKey)` | Adds Cc recipient |
| `setBody(conn, html, draftKey)` | Sets draft body |
| `saveDraft(conn, draftKey)` | Triggers `_saveDraftAsync()` |
| `sendDraft(conn, draftKey)` | Sends the draft |
| `closeCompose(conn)` | Closes compose window |

**Why this works:** Calling `saveDraft()` via CDP triggers the same internal flow as the user pressing Cmd+S, which eventually syncs to backend via `/v3/userdata.sync`.

## CLI Integration

The `--provider` flag controls draft creation strategy:

```bash
# Default: Create through Superhuman UI (syncs to backend)
superhuman draft --to "user@example.com" --subject "Test" --body "Hello"

# Fallback: Direct Gmail/MS Graph API
superhuman draft --provider=gmail --to "user@example.com" --subject "Test" --body "Hello"
```

### Provider Comparison

| Aspect | `--provider=superhuman` (default) | `--provider=gmail` |
|--------|-----------------------------------|-------------------|
| API | CDP → Superhuman UI | Direct Gmail/MS Graph |
| Sync | Yes (via `/v3/userdata.sync`) | No (until Superhuman polls) |
| Mobile | Immediate | Delayed |
| AI features | Yes | Limited |
| Requires Superhuman | Yes | No |

## Related Files

- `src/superhuman-api.ts`: CDP-based draft operations
- `src/send-api.ts`: Direct Gmail/MS Graph draft operations
- `src/cli.ts`: `--provider` flag implementation
- `scratch/capture-userdata-sync.ts`: Background page network capture
- `scratch/monitor-background.ts`: Background page monitoring

## Appendix: Background Page Capture Script

```typescript
import CDP from "chrome-remote-interface";

async function main() {
  const targets = await CDP.List({ port: 9333 });
  const bgPage = targets.find(t => t.url.includes('background_page'));

  const client = await CDP({ target: bgPage.id, port: 9333 });
  const { Network } = client;

  await Network.enable();

  Network.requestWillBeSent((params) => {
    if (params.request.url.includes('userdata.sync')) {
      console.log(`[REQ] ${params.request.postData}`);
    }
  });

  Network.responseReceived(async (params) => {
    if (params.response.url.includes('userdata.sync')) {
      const body = await Network.getResponseBody({ requestId: params.requestId });
      console.log(`[RES] ${body.body}`);
    }
  });

  await new Promise(r => setTimeout(r, 30000));
  await client.close();
}

main().catch(console.error);
```

## Future Enhancements

Potential direct API integration (bypassing CDP):
1. Extract auth tokens from Superhuman session
2. Call `/v3/userdata.sync` directly to push draft updates
3. Would be faster and not require compose window

This would require reverse-engineering the full sync protocol including history ID management.
