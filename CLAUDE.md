
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## Architecture: Superhuman API Strategy

**HARD RULE: Always reverse-engineer and call Superhuman backend API endpoints directly. Never rely on browser automation, Gmail API, or MS Graph API.**

Reason: managing three separate token lifetimes (Superhuman JWT + Gmail OAuth + MS Graph OAuth) is error-prone and has caused bugs. Superhuman's backend proxies the underlying provider — use that proxy instead.

The correct approach for any Superhuman operation:
1. **Use CDP/Network monitoring to discover the API endpoint** — capture the request/response by intercepting network traffic in the Superhuman background page
2. **Call the endpoint directly** from the CLI using the JWT token obtained via CDP
3. **Provider APIs are a last resort** — only use Gmail API or MS Graph API when a Superhuman endpoint is confirmed impossible from CLI context AND there is no alternative. Document the exception in CLAUDE.md.

Known confirmed exceptions:
- `userdata.getThreads` — use SQLite direct search (`sqlite-search.ts`) instead
- `attachment download` (`attachments.ts`) — no Superhuman backend download proxy exists for received emails; uses Gmail API (`gmail.googleapis.com`) for Gmail accounts and MS Graph (`graph.microsoft.com`) for Microsoft accounts, with the stored OAuth `accessToken` from tokens.json. Listing uses SQLite local DB (no API call). This is the ONLY remaining use of provider APIs for a read operation.

**Local-first data strategy (2026-04-09):** `read`, `inbox list`, and `mark read` now use the local SQLite database (OPFS blob) as the primary data path, falling back to portal RPC / backend API only when SQLite lookup fails. The `sqlite-search.ts` module provides shared helpers: `readThreadFromDB()`, `listInboxFromDB()`, `findOPFSBlob()`, `extractSQLite()`. The `mark read/unread` operations also have a backend API fallback via `userdata.writeMessage` when portal RPC (`threadInternal.modifyLabels`) fails.

**Iframe credential refresh (2026-05-22):** Token refresh now uses `src/background-page-refresh.ts`, which connects to the Electron app's hidden `background_page.html` target and calls `window.background.di.get("credential").getIDTokenAsync()` + `getAccessTokenAsync()` inside each per-account iframe's execution context. Per-account iframes are children of the background_page, each named after a linked email. Refreshes are silent — there is no Page to bring to front so focus stealing is structurally impossible. `refreshTokenViaCDP()` keeps the legacy `switchAccount → Page.navigate` path only as a last-resort fallback when the background_page target isn't reachable (e.g. Superhuman.app not launched with `--remote-debugging-port`). `refreshAllTokens()` bulk-refreshes every cached account in a single CDP connection. The `userExternalId` / `userPrefix` lives at `bg.di.get("settings")._cache.userId` in the iframe context (NOT `bg.labels._settings._cache.userId` — labels has its own settings via DI).

**Resolved (2026-04-15):** Attachment upload now works for all commands (`draft create`, `draft update`, `reply`, `reply-all`, `forward`). Three fixes were needed: (1) calling `uploadAttachmentSuperhuman()` from `cmdDraft()` (was missing entirely), (2) writing attachment metadata via `userdata.writeMessage` at path `threads/{threadId}/messages/{draftId}/attachments/{uuid}` after the blob upload, and (3) fixing the metadata payload schema to match the real Superhuman app format — captured via CDP network monitoring. Key schema differences: `source.type` must be `"upload-firebase"` (not `"upload"`), fields use camelCase (`threadId`/`messageId`), `source.url` (not `download_url`), `cid` must be a separate UUID, and required fields include `fixedPartId`, `messageId`, `threadId`, `discardedAt`, `createdAt`, `size`. When sending with `--send`, the `SuperhumanAttachment[]` results are passed to `sendDraftSuperhuman()` for inclusion in `outgoing_message.attachments[]`. E2E tests in `attachment-e2e.test.ts` cover all paths.

**Resolved (2026-04-07):** `messages/send` now works natively with JWT only. The fix was using object format `{email, name}` for `from`/`to`/`cc`/`bcc` fields in the `outgoing_message` payload (not string format `"Name <email>"`). Gmail API send (`sendViaGmailApi`) is no longer needed for Gmail accounts — `sendDraftSuperhuman` works for both Gmail and MS accounts.

### Debugging send-delivery failures (process)

`messages/send` returning HTTP 200 means **queue-accepted, NOT delivered.** A reply can be accepted then silently dropped by the provider. Follow this process before concluding a send "worked" or diagnosing why it didn't:

1. **Verify delivery against the provider's Sent folder — the only ground truth.** NOT the CLI's `✓ queued` (queue-accept ≠ delivery), NOT the local SQLite `read`/`inbox` (the OPFS blob lags a just-sent message by minutes). Use MS Graph `GET /me/mailFolders/SentItems/messages?$top=6&$orderby=sentDateTime desc` (Microsoft) or the Gmail Sent label, with the stored OAuth `accessToken` from tokens.json. If the message isn't there, it did not send.
2. **Check the inbox for Superhuman's failure notice.** A failed queued send injects an email from `meagan@superhuman.com` (subject "An email failed to send from Superhuman") ~10 min later, with a link to the affected thread. Its body is a generic customer notice (no protocol error), but its presence + timestamp confirm which send failed.
3. **Capture the exact wire payload.** `SH_DEBUG=1` dumps the `messages/send` request body (`outgoing_message`) right before the POST — inspect `from`/`to`/`cc`, `in_reply_to`, `current_message_ids`, `thread_id`, `attachments[].source`.

**There are THREE distinct send code paths — do not assume a fix to one covers the others:**
- `draft send <id>` / `reply --send` / `reply-all --send` → native `sendDraftSuperhuman` (`draft-api.ts`). Two-step `draft send` parses recipients correctly via `parseRecipient`; the **one-step `reply-all/forward --send` paths build `{email: "Name <addr>"}` (the whole formatted string in the `email` field) → mangled to/cc → silent non-delivery** (`cli.ts` ~2302/2453). Fix: use `parseRecipient` everywhere.
- `superhuman send` (compose) → **legacy provider abstraction** `getProvider()`/`sendEmailViaProvider` (`cli.ts:1658`), a *different* path that can fail independently (observed HTTP 400).
- **MS replies:** `in_reply_to` and `current_message_ids` must be real **message item-ids**, not the conversation/thread id. `resolveReplyItemId` (`cli.ts`) returns `gmailMessageId` for Gmail (correct) but falls back to the conversation `threadId` for Microsoft → the backend accepts (200) then silently fails to deliver. The correct value must be **captured from the app**, not guessed (Graph item-id formats differ from Superhuman's stored ids).

**Capturing the app's correct send payload (capture-don't-guess):** monitor `messages/send` on the `background_page` target while the app sends, then diff against the CLI's `SH_DEBUG` payload. **Blind CDP keystroke automation (`Input.dispatchKeyEvent`) does NOT work — Electron ignores synthetic key events unless the window is focused**, so you cannot drive a send headlessly. To capture safely without a human at the keyboard, draft **self-addressed** test emails (to the user's own address) so a driven/triggered send has zero outward risk — but the actual send still needs the app window focused (i.e. the user present), so for an away user the capture must wait until they're at a desktop. `switchAccount()` (account switch via `Page.navigate`) DOES work headlessly and is needed first when the target draft is on a non-current account (`ViewState.account` is single-account per page).

**Do NOT:**
- Automate browser UI clicks to perform actions
- Use Playwright/Puppeteer/CDP `Runtime.evaluate` to trigger Superhuman app functions
- Reach for Gmail API or MS Graph API without first exhausting Superhuman endpoint options
- Assume an operation can't be done via Superhuman API without first investigating network traffic

**Investigation pattern:** Use `src/api-investigation/` scripts + CDP network monitoring to discover new endpoints before implementing any feature.

## Chrome DevTools Protocol (CDP)

When connecting to Superhuman via CDP, **always monitor BOTH the background page AND the main UI page** to capture all API calls:

```typescript
import CDP from "chrome-remote-interface";

// 1. List all available pages
const targets = await CDP.List({ port: 9400 });

// 2. Find the background page (where API calls happen)
const backgroundPage = targets.find(t => 
  t.url.includes("background_page.html")
);

// 3. Find the main UI page (optional, for UI interactions)
const mainPage = targets.find(t => 
  t.url.includes("mail.superhuman.com") && t.type === "page"
);

// 4. Connect to background page for network monitoring
const bgClient = await CDP({ port: 9400, target: backgroundPage.id });
const { Network } = bgClient;
await Network.enable();

// Network events will now capture backend API calls
```

**Why both pages matter:**
- **Background page** (`background_page.html`): All API calls to Superhuman backend (`userdata.*`, `messages.*`, etc.)
- **Main UI page** (`mail.superhuman.com`): User interactions, UI state changes

**Always check page list first:**
```bash
bun src/api-investigation/list-cdp-pages.ts
```

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
