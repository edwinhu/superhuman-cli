
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

**Resolved (2026-04-15):** Attachment upload now works for all commands (`draft create`, `draft update`, `reply`, `reply-all`, `forward`). The fix required two parts: (1) calling `uploadAttachmentSuperhuman()` from `cmdDraft()` (was missing entirely), and (2) writing attachment metadata via `userdata.writeMessage` at path `threads/{threadId}/messages/{draftId}/attachments/{uuid}` after the blob upload — without this metadata write, the draft has no record of the attachment. When sending with `--send`, the `SuperhumanAttachment[]` results are passed to `sendDraftSuperhuman()` for inclusion in `outgoing_message.attachments[]`.

**Resolved (2026-04-07):** `messages/send` now works natively with JWT only. The fix was using object format `{email, name}` for `from`/`to`/`cc`/`bcc` fields in the `outgoing_message` payload (not string format `"Name <email>"`). Gmail API send (`sendViaGmailApi`) is no longer needed for Gmail accounts — `sendDraftSuperhuman` works for both Gmail and MS accounts.

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
