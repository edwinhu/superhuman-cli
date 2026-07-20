# Outlook Web (OWA) backend — implementation spec

Goal: add an `outlook-web` backend to superhuman-cli so Microsoft (Exchange Online)
accounts are driven agentically **without any new OAuth grant**, by piggybacking the
already-authenticated Outlook Web session in the CDP browser (port 9222). This replaces
Superhuman for the UVA mailbox after UVA revoked Superhuman's tenant app.

Context: UVA requires admin consent for third-party mail apps (device-code test with the
Thunderbird client id returns "need admin approval"). The ONLY no-consent path is the live
OWA session's own first-party token. Feasibility is fully proven (read + write verified live).

## Architecture decision

There is **no clean verb-abstracting Provider interface** in this codebase. Verbs call
`portalInvoke` / `backendFetch` / `runtimeEvaluate` on `SuperhumanProvider`, or branch on
`token.isMicrosoft`. So we:

1. Add `OutlookWebProvider implements ConnectionProvider` (sibling to `SuperhumanProvider`).
   It carries the OWA email + an access-token getter, and exposes a single data primitive
   `owaFetch(method, path, body?)` → Outlook REST. No portal/runtimeEvaluate needed for
   verbs (REST is plain HTTPS + Bearer). CDP is used ONLY by the token broker.
2. Route Microsoft accounts to it in `connection-provider.ts` `providerFromToken()`:
   branch `if (token.isMicrosoft) return new OutlookWebProvider(email)` **before** the
   `superhumanToken` check (the stale MS entry in tokens.json also has a dead superhumanToken).
   Google accounts are untouched → still Superhuman.
3. Per-verb: branch `if (provider instanceof OutlookWebProvider)` at the top of each verb
   fn (mirrors the existing `instanceof SuperhumanProvider` / `isMicrosoft` pattern), calling
   an `owa*` data function that returns the SAME JSON shape the Superhuman path returns.

## Token broker — `src/owa-token.ts`

Reads the OWA session's own access token from the page's MSAL localStorage cache via CDP.
Uses `chrome-remote-interface` (already a dep). No network capture needed.

- Attach: `CDP.List({host, port:9222})`, pick the `page` target whose url host matches
  `outlook.cloud.microsoft` OR `outlook.office.com` (use `hostMatches` from cdp-endpoint.ts).
- Read token: `Runtime.evaluate` a fn that enumerates `localStorage`, JSON.parses each value,
  and returns the entry where `credentialType` starts with `"AccessToken"`, `target` includes
  `https://outlook.office.com/Mail.ReadWrite`. Entry schema (verified):
  ```
  { credentialType:"AccessToken", secret:"<JWT>", cachedAt:"<unixsec>",
    expiresOn:"<unixsec>", clientId:"9199bf20-a13f-4107-85dc-02114787ef48",
    realm:"<tenant>", homeAccountId:"<oid>.<tenant>", target:"<space-sep scopes>",
    tokenType:"Bearer" }
  ```
  Return `{ accessToken: secret, expiresOn: Number(expiresOn)*1000, upn }`.
  Derive `upn`/email by decoding the JWT payload (`upn` claim) — do NOT trust homeAccountId for email.
- Refresh: if `expiresOn` within 5 min of now (or past), `Page.reload` the OWA tab, wait for
  load (~4s) + re-read; OWA's MSAL silently re-mints on bootstrap. If still stale, throw a clear
  error telling the user to open/refresh Outlook Web in the browser.
- Disk cache: `${HOME}/.config/superhuman-cli/owa-tokens.json`, `{ [email]: {accessToken, expiresOn, upn} }`.
  In-memory + disk; validate exp with a 5-min buffer before returning; re-scrape on miss.
- Export: `getOwaToken(email?): Promise<{accessToken:string, email:string, expiresOn:number}>`.

## REST client — `src/outlook-rest-api.ts`

Base: `https://outlook.office.com/api/v2.0/me`. Helper:
```ts
owaFetch(token, method, path, body?) // Authorization: Bearer, Content-Type application/json
  -> parsed JSON; throw on !ok with status+body; handle 204 (no content) -> null
```
Odata: use `$select`, `$top`, `$skip`, `$filter`, `$search`, `$orderby`. Threads: Outlook groups
by `ConversationId`; superhuman "thread" ≈ conversation. For inbox we list messages and can group
by ConversationId (or list latest per conversation via `$orderby=ReceivedDateTime desc`).

Per-verb data fns (return EXACT superhuman JSON shapes — see Output Contracts):

- `owaListInbox(token, {limit, needsReply, label, withBody})` → `InboxThread[]`
  GET `/mailfolders/inbox/messages?$top=&$select=Subject,From,ToRecipients,CcRecipients,ReceivedDateTime,BodyPreview,ConversationId,IsRead,Flag,Categories,InternetMessageId&$orderby=ReceivedDateTime desc`
  Map: id=Id, subject=Subject, from={email,name} from From.EmailAddress, to/cc arrays,
  date=ReceivedDateTime, snippet=BodyPreview, messageCount (count per ConversationId if grouping else 1),
  labelIds: derive `["UNREAD"]` if !IsRead, `["STARRED"]` if Flag.FlagStatus==="Flagged", plus Categories,
  isFromMe (From is the account), awaitingReply (=isFromMe? no: last msg not from me). withBody adds body (Body.Content) + latestMessage.
- `owaSearch(token, query, {limit, withBody})` → `InboxThread[]` via `$search="query"` on messages.
- `owaGetThread(token, id)` → `ThreadMessage[]` — resolve the message's ConversationId, then
  GET `/messages?$filter=ConversationId eq '<cid>'&$orderby=ReceivedDateTime asc&$select=...,Body`.
  Shape: {id,threadId=ConversationId,subject,from,to,cc,date,snippet=BodyPreview,body=Body.Content}.
- `owaCreateDraft(token, {to,cc,bcc,subject,body,html})` → POST `/messages` (creates in Drafts). returns Id.
- `owaReply(token, id, {body,html,all})` → POST `/messages/{id}/createReply` or `/createReplyAll`,
  then PATCH the returned draft body, OR use `/reply` (send). For DRAFT semantics use createReply→returns draft.
- `owaForward(token, id, {to,body})` → POST `/messages/{id}/createForward` → draft.
- `owaSendDraft(token, draftId)` → POST `/messages/{draftId}/send` (204).
- `owaSendNew(token, {to,cc,bcc,subject,body})` → POST `/sendmail` with {Message, SaveToSentItems:true} (202/204).
- `owaArchive(token, ids[])` → POST `/messages/{id}/move` {DestinationId:"archive"} each. (archive is a well-known folder name)
- `owaDelete(token, ids[])` → POST `/messages/{id}/move` {DestinationId:"deleteditems"} (trash) — NOT hard delete.
- `owaMarkRead(token, id, read:boolean)` → PATCH `/messages/{id}` {IsRead:read}.
- `owaFlag(token, id, on:boolean)` → PATCH `/messages/{id}` {Flag:{FlagStatus: on?"Flagged":"NotFlagged"}}. (star≈flag)
- `owaListStarred(token, {limit})` → `StarredThread[]` GET `/messages?$filter=Flag/FlagStatus eq 'Flagged'`.
- `owaListLabels(token)` → `Label[]` from GET `/messages?$select=Categories` distinct, OR the master
  categories list GET `/master​categories` — NOTE: correct path is `/me/outlook/masterCategories` on GRAPH;
  on Outlook REST v2.0 it 404s (verified). Use `/mailfolders` for folders as labels, or Categories. Map {id,name,type}.
- `owaAddLabel/owaRemoveLabel(token, id, name)` → PATCH `/messages/{id}` {Categories:[...]}.
- `owaSnooze*` → Outlook has no native snooze via REST; emulate with a Deferred/Postpone? If no clean
  mapping, return "snooze not supported on outlook-web" (graceful). (Confirm during impl.)
- `owaListEvents/create/update/delete/free` → `/calendarview?startDateTime=&endDateTime=`, `/events`,
  `/getSchedule` (free/busy). Map to CalendarEvent shape.
- `owaListAttachments(token, msgId)` → GET `/messages/{id}/attachments`. download → GET `.../attachments/{aid}/$value`.
- `owaExportEml(token, id)` → GET `/messages/{id}/$value` (MIME) → write file.
- `owaContacts(token, q)` → GET `/me/contacts?$search` or `/people` (People API) → {email,name,score}.
- Snippets / ai: NOT supported on OWA → verbs print a clear "not available on outlook-web accounts".

## Output contracts (match verbatim — from arch map §3)

- InboxThread: `{id, subject, from:{email,name}, to?, cc?, date, snippet, labelIds:string[], messageCount, isFromMe, awaitingReply}` (+body,latestMessage with --with-body)
- ThreadMessage: `{id, threadId, subject, from:{email,name}, to:[{email,name}], cc:[{email,name}], date, snippet, body?}`
- StarredThread: `{id, subject?, from?:{email,name}, date?, snippet?, labelIds?}`
- Label: `{id, name, type?}`  · Draft: `{id, subject, from:string, to:string[], cc:string[], bcc:string[], preview, timestamp, source:"native", threadId?}`
- CalendarEvent: `{id, summary, description, start, end, location, attendees:string[], organizer, isAllDay, status, calendarId}`
- Attachment: `{id, attachmentId, name, mimeType, extension, messageId, threadId, inline}`
- Contact: `{email, name?, score?}`
- Mutation verbs (reply/forward/send/archive/delete/mark/star add-remove/label add-remove/draft
  create-update-send-delete/calendar delete): **text output only**, ignore --json. Match `{success,error?}` semantics.
- Formatter: arrays → NDJSON (one JSON per line), single object → pretty. `--json/--stream/--ndjson` are aliases.

## Files
- NEW: `src/owa-token.ts`, `src/outlook-rest-api.ts`, `src/outlook-web-provider.ts`
- EDIT: `src/connection-provider.ts` (route microsoft→OWA in providerFromToken; import OutlookWebProvider)
- EDIT: verb modules to branch on `provider instanceof OutlookWebProvider`: inbox.ts, read.ts,
  (search in cli.ts/inbox), archive.ts, read-status.ts, labels.ts, snooze.ts, calendar.ts,
  attachments.ts, contacts.ts; compose path (cli.ts cmdSend/cmdReply + draft-api.ts) — branch on
  token.isMicrosoft to route to owa send/draft fns; DraftService: add OutlookDraftProvider for `draft list`.
- EDIT: cdp-endpoint.ts — add `isOutlookTarget(url)` (hostMatches outlook.cloud.microsoft / outlook.office.com)
  and export a helper to find the OWA target (used by owa-token.ts).

## Testing (bun test)
Mirror `src/__tests__/inbox-backend.test.ts`: construct `OutlookWebProvider`, monkeypatch
`owaFetch` with a mock returning raw OWA REST fixtures, call the verb fn, assert emitted objects
match the exact field names above AND assert the REST path/method/body via mock.calls.
Add `outlook-token.test.ts` (localStorage entry parsing), `outlook-rest-api.test.ts` (shape mapping),
`outlook-web-provider.test.ts` (routing: microsoft→OWA). Keep google→Superhuman routing green.

## Constraints
- NEVER hard-delete mail (delete = move to Deleted Items).
- NEVER send without the same confirmation semantics the CLI already enforces.
- Do not regress the Google/Superhuman path — all existing tests must stay green.
- Token/secret never logged.
