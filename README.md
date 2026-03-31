# superhuman-cli

CLI and MCP server to control [Superhuman](https://superhuman.com) email client via Chrome DevTools Protocol (CDP).

## Requirements

- [Bun](https://bun.sh) runtime
- Superhuman.app running with remote debugging enabled

## Setup

```bash
# Install dependencies
bun install

# Start Superhuman with CDP enabled
/Applications/Superhuman.app/Contents/MacOS/Superhuman --remote-debugging-port=9400
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

# Search emails
superhuman search "from:john subject:meeting"
superhuman search "project update" --limit 20
superhuman search "from:anthropic" --include-done    # Search all including archived
superhuman search "meeting" --json      # NDJSON streaming output

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

**How it works:** The CLI uses Superhuman's MCP server for all email operations. Run `superhuman account auth` once to set up authentication.

### Authentication

```bash
# Set up MCP authentication (required once)
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
superhuman calendar update --event <event-id> --title "New Title"
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
| `--include-done` | Search all emails including archived (for search) |
| `--context <number>` | Number of messages to show full body (default: all, for read) |
| `--date <date>` | Date for calendar (YYYY-MM-DD or "today", "tomorrow") |
| `--range <days>` | Days to show for calendar (default: 1) |
| `--start <time>` | Event start time (ISO datetime or natural: "2pm", "tomorrow 3pm") |
| `--end <time>` | Event end time (ISO datetime) |
| `--duration <mins>` | Event duration in minutes (default: 30) |
| `--title <text>` | Event title (for calendar create/update) |
| `--event <id>` | Event ID (for calendar update/delete) |
| `--calendar <name>` | Calendar name or ID (default: primary) |
| `--json` | Output as NDJSON: arrays print one object per line; single objects are pretty-printed |
| `--stream` / `--ndjson` | Alias for `--json` |
| `--port <number>` | CDP port (default: 9400) |

## MCP Server

Run as an MCP server for Claude integration:

```bash
bun src/index.ts --mcp
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `superhuman_inbox` | List recent emails from inbox |
| `superhuman_search` | Search emails |
| `superhuman_read` | Read a thread |
| `superhuman_draft` | Create an email draft |
| `superhuman_send` | Send an email |
| `superhuman_reply` | Reply to a thread |
| `superhuman_reply_all` | Reply-all to a thread |
| `superhuman_forward` | Forward a thread |
| `superhuman_archive` | Archive thread(s) |
| `superhuman_delete` | Delete thread(s) |
| `superhuman_mark_read` | Mark thread(s) as read |
| `superhuman_mark_unread` | Mark thread(s) as unread |
| `superhuman_labels` | List all labels |
| `superhuman_get_labels` | Get labels on a thread |
| `superhuman_add_label` | Add label to thread(s) |
| `superhuman_remove_label` | Remove label from thread(s) |
| `superhuman_star` | Star thread(s) |
| `superhuman_unstar` | Unstar thread(s) |
| `superhuman_starred` | List starred threads |
| `superhuman_snooze` | Snooze thread(s) |
| `superhuman_unsnooze` | Unsnooze thread(s) |
| `superhuman_snoozed` | List snoozed threads |
| `superhuman_attachments` | List attachments in a thread |
| `superhuman_download_attachment` | Download an attachment |
| `superhuman_snippets` | List all snippets |
| `superhuman_snippet` | Use a snippet to compose or send |
| `superhuman_accounts` | List linked accounts |
| `superhuman_switch_account` | Switch to a different account |
| `superhuman_calendar_list` | List calendar events |
| `superhuman_calendar_create` | Create calendar event |
| `superhuman_calendar_update` | Update calendar event |
| `superhuman_calendar_delete` | Delete calendar event |
| `superhuman_calendar_free_busy` | Check free/busy availability |
| `superhuman_ask_ai` | Ask AI to search emails, answer questions, or compose |

### Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "superhuman": {
      "command": "bun",
      "args": ["/path/to/superhuman-cli/src/index.ts", "--mcp"]
    }
  }
}
```

## How It Works

### MCP Provider (Primary)

All email operations use Superhuman's official MCP server (`https://mcp.mail.superhuman.com/mcp`):

| Operation | MCP Tool |
|-----------|----------|
| List inbox | `list_email` |
| Search | `query_email_and_calendar` |
| Read thread | `get_email_thread` |
| Send / Reply / Forward | `send_email` |
| Create draft | `draft_email` |
| Archive / Delete | `update_email` (mark_done / trash) |
| Labels / Star | `update_email` |
| Read status | `update_email` (mark_read / mark_unread) |
| Calendar events | `create_or_update_event` |
| Free/busy | `get_availability_calendar` |

### Superhuman Backend

Some operations use Superhuman's native backend API directly:

- **AI queries** — `ai.compose`, `ai.askAIProxy`
- **Snooze** — `reminders/create`, `reminders/cancel`
- **Native drafts** — `userdata.writeMessage`
- **Attachments** — `attachments.upload`
- **Send with undo** — `messages/send`
- **Snippets** — Superhuman backend API

### CDP (Setup Only)

Chrome DevTools Protocol is only needed for:

- `account auth` — One-time token extraction from Superhuman
- `status` — Check Superhuman connection

### Benefits

- **Simple auth**: Single MCP authentication, no provider OAuth management
- **Reliability**: No token refresh, no OAuth expiry issues
- **Speed**: No CDP round-trips for email operations
- **Multi-account**: Works with both Gmail and Microsoft/Outlook accounts

## License

MIT
