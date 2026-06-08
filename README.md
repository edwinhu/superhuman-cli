# superhuman-cli

CLI to control [Superhuman](https://superhuman.com) email client via Chrome DevTools Protocol (CDP) and Superhuman's backend API.

## Requirements

- [Bun](https://bun.sh) runtime
- Superhuman.app running with remote debugging enabled

## Setup

```bash
# Install dependencies
bun install

# Start Superhuman with CDP enabled (9252 is the default the CLI looks for)
/Applications/Superhuman.app/Contents/MacOS/Superhuman --remote-debugging-port=9252
```

> On macOS this is best done via a LaunchAgent so the app always starts with CDP
> enabled at login — see `com.user.superhuman-cdp.plist`. The CLI also auto-probes
> 9252 → 9250 → 9222 when neither `--port` nor `CDP_PORT` is set.

## Building & Installing

Compile a standalone binary and put it on your `PATH`:

```bash
# Compile to ./superhuman
bun run build   # bun build --compile src/cli.ts --outfile superhuman

# Install to ~/.local/bin (or anywhere on your PATH)
cp superhuman ~/.local/bin/superhuman
```

### macOS gotcha: re-sign after copying (exit 137 / SIGKILL)

On macOS, copying a freshly `--compile`d Bun binary **invalidates its code
signature**, and Gatekeeper then `SIGKILL`s it on launch. The symptom is
confusing: the binary exits with code **137** and **zero output**, which looks
like a broken build but isn't. Re-sign the installed copy after every rebuild:

```bash
xattr -c ~/.local/bin/superhuman                       # strip quarantine/extended attrs
codesign --force --sign - ~/.local/bin/superhuman      # ad-hoc re-sign
```

Tip: fold this into your install step so future rebuilds don't trip on it:

```bash
bun run build \
  && cp superhuman ~/.local/bin/superhuman \
  && xattr -c ~/.local/bin/superhuman \
  && codesign --force --sign - ~/.local/bin/superhuman \
  && superhuman --version   # confirm it runs
```

## CLI Usage

```bash
# Check connection status
superhuman status

# Account management
superhuman account auth
superhuman account list
superhuman account switch 2
superhuman account switch user@example.com
```

### Reading Email

```bash
# List recent inbox emails (★ marks starred/flagged threads)
superhuman inbox
superhuman inbox --limit 20
superhuman inbox --limit 20 --json      # NDJSON: one thread per line as fetched

# Filter inbox
superhuman inbox --focused              # Important/primary only
superhuman inbox --needs-reply           # Exclude threads where you were last sender
superhuman inbox --unread                # Unread only
superhuman inbox --exclude "newsletter,noreply@,statuspage"  # Exclude by from/subject pattern

# Combine filters
superhuman inbox --focused --needs-reply --exclude "statuspage,reminder@" --limit 20

# Search emails (keyword FTS via local SQLite index — all categories including Social/Promotions)
superhuman search "from:john subject:meeting"
superhuman search "project update" --limit 20
superhuman search "invoice" --json      # NDJSON: one thread per line with IDs

# Search all emails including archived/done (server-side AI search)
superhuman search "uber trip" --include-done

# AI-powered semantic search (natural language, also server-side)
superhuman search "emails about contract renewals last month" --ai
superhuman search "what did John say about the deadline?" --ai --json

# Read a specific thread (requires --account)
superhuman read <thread-id> --account user@gmail.com
superhuman read <thread-id> --account user@gmail.com --context 3   # Full body for last 3 only
superhuman read <thread-id> --account user@gmail.com --json
```

### Ask AI

Use Superhuman's AI to search emails, answer questions, or ask about specific threads:

```bash
# Search emails with natural language
superhuman ai "find emails about the Stanford cover letter"
superhuman ai "what did John say about the deadline?"

# Compose with AI
superhuman ai "Write an email inviting the team to a planning meeting"

# Ask about a specific thread
superhuman ai <thread-id> "summarize this thread"
superhuman ai <thread-id> "what are the action items?"
superhuman ai <thread-id> "draft a professional reply"
```

The AI automatically determines whether to search, compose, or answer based on your prompt.

### Contacts

```bash
# Search contacts by name
superhuman contact search "john"
superhuman contact search "john" --limit 5 --json

# Search contacts in a specific account (without switching UI)
superhuman contact search "john" --account user@gmail.com
```

### Multi-Account Support

The `--account` flag allows operations on any linked account without switching the Superhuman UI:

```bash
# Search contacts in a specific account
superhuman contact search "john" --account user@gmail.com

# Works with both Gmail and Microsoft/Outlook accounts
superhuman contact search "john" --account user@company.com
```

**How it works:** The CLI uses Superhuman's backend API (JWT auth) and Portal RPC (CDP). Run `superhuman account auth` once to extract and cache credentials.

### Authentication

```bash
# Extract JWT from running Superhuman app (required once)
superhuman account auth

# Tokens are cached to ~/.config/superhuman-cli/tokens.json
# Re-run 'account auth' if tokens expire
```

### Composing Email

Recipients can be specified as email addresses or contact names. Names are automatically resolved to email addresses via contact search.

```bash
# Create a draft (using email or name)
superhuman draft create --to user@example.com --subject "Hello" --body "Hi there!"
superhuman draft create --to "john" --subject "Hello" --body "Hi there!"
superhuman draft create --to user@example.com --subject "Report" --body "See attached" --attach ./report.pdf

# List drafts
superhuman draft list
superhuman draft list --account user@example.com
superhuman draft list --to jon@example.com        # Filter by recipient
superhuman draft list --subject "Meeting notes"   # Filter by subject
superhuman draft list --json                      # JSON output for scripting

# Send an email
superhuman send --to user@example.com --subject "Quick note" --body "FYI"

# Reply to a thread
superhuman reply <thread-id> --body "Thanks!"
superhuman reply <thread-id> --body "Thanks!" --send

# Reply-all
superhuman reply-all <thread-id> --body "Thanks everyone!"

# Forward
superhuman forward <thread-id> --to colleague@example.com --body "FYI"

# Update a draft
superhuman draft update <draft-id> --body "Updated content"
superhuman draft update <draft-id> --attach ./document.pdf

# Delete drafts
superhuman draft delete <draft-id>
superhuman draft delete <draft-id1> <draft-id2>

# Send a draft by ID
superhuman send --draft <draft-id>

# Send a Superhuman draft with content
superhuman draft send <draft-id> --account=user@example.com --to=recipient@example.com --subject="Subject" --body="Body"
```

#### Drafts

Drafts are created via Superhuman's native API and exist only in Superhuman. Use `draft list` to see all drafts, and `draft send` or `--send` flag to send them.

### Managing Threads

```bash
# Archive
superhuman archive <thread-id>
superhuman archive <thread-id1> <thread-id2>

# Delete (trash)
superhuman delete <thread-id>

# Mark as read/unread
superhuman mark read <thread-id>
superhuman mark unread <thread-id>

# Star / Unstar
superhuman star add <thread-id>
superhuman star remove <thread-id>
superhuman star list

# Snooze / Unsnooze
superhuman snooze set <thread-id> --until tomorrow
superhuman snooze set <thread-id> --until next-week
superhuman snooze set <thread-id> --until "2024-02-15T14:00:00Z"
superhuman snooze cancel <thread-id>
superhuman snooze list
```

### Snippets

Reusable email templates stored in Superhuman. Snippets support template variables like `{first_name}`.

```bash
# List all snippets
superhuman snippet list
superhuman snippet list --json

# Use a snippet to create a draft (fuzzy name matching)
superhuman snippet use "zoom link" --to user@example.com

# Substitute template variables
superhuman snippet use "share recordings" --to user@example.com --vars "date=Feb 5,student_name=Jane"

# Send immediately using a snippet
superhuman snippet use "share recordings" --to user@example.com --vars "date=Feb 5" --send
```

### Labels

```bash
# List all labels
superhuman label list

# Get labels on a thread
superhuman label get <thread-id>

# Add/remove labels
superhuman label add <thread-id> --label Label_123
superhuman label remove <thread-id> --label Label_123
```

### Attachments

```bash
# List attachments in a thread
superhuman attachment list <thread-id>

# Download all attachments from a thread
superhuman attachment download <thread-id>
superhuman attachment download <thread-id> --output ./downloads

# Download specific attachment
superhuman attachment download --attachment <attachment-id> --message <message-id> --output ./file.pdf
```

### Calendar

Superhuman has built-in calendar support, but prefer `morgen` CLI for calendar operations — it supports proper calendar filtering. See the `morgen` skill.

```bash
# List events
superhuman calendar list
superhuman calendar list --date tomorrow --range 7 --json

# Create event
superhuman calendar create --title "Meeting" --start "2pm" --duration 30
superhuman calendar create --title "All Day" --date 2026-02-05

# Update/delete event
superhuman calendar update --event <event-id> --title "New Title" --location "Room 101"
superhuman calendar delete --event <event-id>

# Check availability
superhuman calendar free
superhuman calendar free --date tomorrow --range 7
```

### Options

| Option | Description |
|--------|-------------|
| `--account <email>` | Account to operate on (default: current account) |
| `--to <email\|name>` | Recipient email or name (names auto-resolved via contacts) |
| `--cc <email\|name>` | CC recipient (can be used multiple times) |
| `--bcc <email\|name>` | BCC recipient (can be used multiple times) |
| `--subject <text>` | Email subject |
| `--body <text>` | Email body (plain text, converted to HTML) |
| `--html <text>` | Email body as raw HTML |
| `--send` | Send immediately instead of saving draft (for reply/reply-all/forward/snippet) |
| `--vars <pairs>` | Template variable substitution: `"key1=val1,key2=val2"` (for snippet use) |
| `--draft <id>` | Draft ID to send (for send command) |
| `--label <id>` | Label ID (for label add/remove) |
| `--until <time>` | Snooze until time: preset or ISO datetime |
| `--output <path>` | Output path for downloads |
| `--attachment <id>` | Specific attachment ID |
| `--message <id>` | Message ID (required with --attachment) |
| `--limit <number>` | Number of results (default: 10) |
| `--focused` | Only show important/primary emails (Gmail: category:personal, Outlook: Focused) |
| `--needs-reply` | Exclude threads where you were the last sender |
| `--unread` | Only show unread emails |
| `--exclude <patterns>` | Exclude threads matching patterns (comma-separated, matches from/subject) |
| `--ai` | Use AI-powered search instead of keyword FTS (for search) |
| `--include-done` | Search all emails including archived (for search) |
| `--context <number>` | Number of messages to show full body (default: all, for read) |
| `--date <date>` | Date for calendar (YYYY-MM-DD or "today", "tomorrow") |
| `--range <days>` | Days to show for calendar (default: 1) |
| `--start <time>` | Event start time (ISO datetime or natural: "2pm", "tomorrow 3pm") |
| `--end <time>` | Event end time (ISO datetime) |
| `--duration <mins>` | Event duration in minutes (default: 30) |
| `--title <text>` | Event title (for calendar create/update) |
| `--event <id>` | Event ID (for calendar update/delete) |
| `--location <text>` | Event location (for calendar create/update) |
| `--calendar <name>` | Calendar name or ID (default: primary) |
| `--json` | Output as NDJSON: arrays print one object per line; single objects are pretty-printed |
| `--stream` / `--ndjson` | Alias for `--json` |
| `--port <number>` | CDP port (default: 9252; auto-discovered if unset) |

## How It Works

### Two API Layers

**Layer 1: Backend HTTP API** (`superhumanFetch` with JWT)

Works with cached JWT token — no Superhuman app needed after initial auth.

| Operation | Endpoint |
|-----------|----------|
| List inbox | Portal RPC `threadInternal.listAsync` |
| Search (FTS) | Portal RPC `searchTable.query` (SQLite FTS3) |
| Search (AI) | `POST /v3/ai.askAIProxy` (semantic, with `--ai`) |
| Send email | `POST /messages/send` |
| Drafts | `POST /v3/userdata.writeMessage` |
| AI compose | `POST /v3/ai.compose` |
| Snooze | `POST /reminders/create`, `POST /reminders/cancel` |
| Attachments (upload) | `POST /v3/attachments.upload` |
| Attachments (list) | Local SQLite OPFS blob (no API call) |
| Attachments (download) | Gmail API / MS Graph (stored OAuth token) |
| Snippets | Superhuman backend API |

**Layer 2: Portal RPC** (`portal.invoke` via CDP `Runtime.evaluate`)

Requires Superhuman app running. Proxies through the app's own OAuth session.

| Operation | Portal Service |
|-----------|---------------|
| Inbox listing | `threadInternal.listAsync` |
| Read thread | `threadInternal.listAsync` |
| Archive / Delete | `threadInternal.modifyLabels` |
| Labels / Star | `threadInternal.listAsync` (STARRED), `runtimeEvaluate` (labels) |
| Read status | `threadInternal.modifyLabels` |
| Calendar (Google) | `gcal.*` (list, create, update, delete, free/busy) |
| Calendar (Microsoft) | `backend.requestMicrosoftCalendar` (MS Graph proxy) |

### Graceful Degradation

- **Containers / headless**: Send, AI search, AI compose, drafts, snooze, attachments, snippets via cached JWT
- **With Superhuman app running**: Full features including inbox listing, labels, star, archive, calendar

### CDP

Chrome DevTools Protocol is used for:

- `account auth` — One-time JWT extraction from Superhuman
- `status` — Check Superhuman connection
- Portal RPC — Runtime.evaluate for search, labels, calendar operations

### Benefits

- **Simple auth**: Single Superhuman JWT, no OAuth token management
- **On-demand refresh**: Tokens auto-refresh via CDP when expired
- **No external dependencies**: No MCP server, minimal provider API use (attachment download only)
- **Multi-account**: Works with both Gmail and Microsoft/Outlook accounts

## Superhuman's Official MCP Server

Superhuman ships an official MCP server ([`@superhuman/mcp-mail`](https://github.com/superhuman/mcp-mail)) at `mcp.mail.superhuman.com`. It's a remote MCP (HTTP transport via `mcp-remote`) — no local binary needed.

### Official MCP Tools (v1.0.2, March 2026)

| Tool | Description |
|------|-------------|
| `list_threads` | Search threads with structured filters (from, to, subject, labels, date) |
| `query_email_and_calendar` | Natural language / semantic search over email and calendar |
| `create_or_update_draft` | Create or edit a draft using your voice and tone |
| `send_draft` | Send email (Smart Send, Scheduled Send, Undo Send) |
| `create_or_update_event` | Create and update calendar events |
| `update_preferences_email_and_calendar` | Update writing style, event preferences, drafting facts |

### What This CLI Adds

| Capability | Official MCP | This CLI |
|------------|:---:|:---:|
| Search (keyword FTS + AI) | ✓ | ✓ |
| Read full thread content | — | ✓ |
| Reply / Reply-all / Forward | — | ✓ |
| Archive / Delete / Trash | — | ✓ |
| Mark read / unread | — | ✓ |
| Star / Unstar | — | ✓ |
| Snooze / Unsnooze | — | ✓ |
| Labels (list, add, remove) | — | ✓ |
| Attachments (upload, list, download) | — | ✓ |
| Snippets (list, use, send) | — | ✓ |
| Drafts (create, list, update, delete, send) | partial | ✓ |
| Calendar (list, create, update, delete, free/busy) | partial | ✓ |
| AI compose / Ask AI | — | ✓ |
| Contact search | — | ✓ |
| Multi-account switching | — | ✓ |
| Headless / container mode | — | ✓ |

The official MCP is worth tracking — if Superhuman adds read, reply, and thread management, it could replace the backend API layer here. Monitor progress at [superhuman/mcp-mail](https://github.com/superhuman/mcp-mail).

## License

MIT
