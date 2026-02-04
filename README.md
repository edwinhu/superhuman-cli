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
/Applications/Superhuman.app/Contents/MacOS/Superhuman --remote-debugging-port=9333
```

## CLI Usage

```bash
# Check connection status
bun src/cli.ts status

# List linked accounts
bun src/cli.ts accounts

# Switch account
bun src/cli.ts account 2
bun src/cli.ts account user@example.com
```

### Reading Email

```bash
# List recent inbox emails
bun src/cli.ts inbox
bun src/cli.ts inbox --limit 20 --json

# Search emails
bun src/cli.ts search "from:john subject:meeting"
bun src/cli.ts search "project update" --limit 20

# Read a specific thread
bun src/cli.ts read <thread-id>
bun src/cli.ts read <thread-id> --json
```

### Contacts

```bash
# Search contacts by name
bun src/cli.ts contacts search "john"
bun src/cli.ts contacts search "john" --limit 5 --json
```

### Composing Email

Recipients can be specified as email addresses or contact names. Names are automatically resolved to email addresses via contact search.

```bash
# Create a draft (using email or name)
bun src/cli.ts draft --to user@example.com --subject "Hello" --body "Hi there!"
bun src/cli.ts draft --to "john" --subject "Hello" --body "Hi there!"

# Open compose window (keeps it open for editing)
bun src/cli.ts compose --to user@example.com --subject "Meeting"
bun src/cli.ts compose --to "john" --cc "jane" --subject "Meeting"

# Send an email
bun src/cli.ts send --to user@example.com --subject "Quick note" --body "FYI"

# Reply to a thread
bun src/cli.ts reply <thread-id> --body "Thanks!"
bun src/cli.ts reply <thread-id> --body "Thanks!" --send

# Reply-all
bun src/cli.ts reply-all <thread-id> --body "Thanks everyone!"

# Forward
bun src/cli.ts forward <thread-id> --to colleague@example.com --body "FYI"

# Update a draft
bun src/cli.ts draft --update <draft-id> --body "Updated content"

# Delete drafts
bun src/cli.ts delete-draft <draft-id>
bun src/cli.ts delete-draft <draft-id1> <draft-id2>

# Send a draft by ID
bun src/cli.ts send --draft <draft-id>
```

#### Drafts Limitation

Drafts are created via **native Gmail/Outlook APIs**, not Superhuman's proprietary draft system. This means:

| Where | Visible? |
|-------|----------|
| Native Gmail/Outlook web | ✓ Yes |
| Native mobile apps | ✓ Yes |
| Superhuman UI | ✗ No |

This is acceptable for CLI workflows where you iterate on drafts with LLMs and send via `--send` flag. If you need to edit in Superhuman UI, open the draft in native Gmail/Outlook first.

### Managing Threads

```bash
# Archive
bun src/cli.ts archive <thread-id>
bun src/cli.ts archive <thread-id1> <thread-id2>

# Delete (trash)
bun src/cli.ts delete <thread-id>

# Mark as read/unread
bun src/cli.ts mark-read <thread-id>
bun src/cli.ts mark-unread <thread-id>

# Star/unstar
bun src/cli.ts star <thread-id>
bun src/cli.ts unstar <thread-id>
bun src/cli.ts starred

# Snooze/unsnooze
bun src/cli.ts snooze <thread-id> --until tomorrow
bun src/cli.ts snooze <thread-id> --until next-week
bun src/cli.ts snooze <thread-id> --until "2024-02-15T14:00:00Z"
bun src/cli.ts unsnooze <thread-id>
bun src/cli.ts snoozed
```

### Labels

```bash
# List all labels
bun src/cli.ts labels

# Get labels on a thread
bun src/cli.ts get-labels <thread-id>

# Add/remove labels
bun src/cli.ts add-label <thread-id> --label Label_123
bun src/cli.ts remove-label <thread-id> --label Label_123
```

### Attachments

```bash
# List attachments in a thread
bun src/cli.ts attachments <thread-id>

# Download all attachments from a thread
bun src/cli.ts download <thread-id>
bun src/cli.ts download <thread-id> --output ./downloads

# Download specific attachment
bun src/cli.ts download --attachment <attachment-id> --message <message-id> --output ./file.pdf
```

### Options

| Option | Description |
|--------|-------------|
| `--to <email\|name>` | Recipient email or name (names auto-resolved via contacts) |
| `--cc <email\|name>` | CC recipient (can be used multiple times) |
| `--bcc <email\|name>` | BCC recipient (can be used multiple times) |
| `--subject <text>` | Email subject |
| `--body <text>` | Email body (plain text, converted to HTML) |
| `--html <text>` | Email body as raw HTML |
| `--send` | Send immediately instead of saving draft (for reply/reply-all/forward) |
| `--update <id>` | Draft ID to update (for draft command) |
| `--draft <id>` | Draft ID to send (for send command) |
| `--label <id>` | Label ID (for add-label/remove-label) |
| `--until <time>` | Snooze until time: preset or ISO datetime |
| `--output <path>` | Output path for downloads |
| `--attachment <id>` | Specific attachment ID |
| `--message <id>` | Message ID (required with --attachment) |
| `--limit <number>` | Number of results (default: 10) |
| `--json` | Output as JSON |
| `--port <number>` | CDP port (default: 9333) |

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
| `superhuman_add_attachment` | Add attachment to current draft |
| `superhuman_accounts` | List linked accounts |
| `superhuman_switch_account` | Switch to a different account |

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

This tool uses Chrome DevTools Protocol (CDP) to connect to Superhuman's Electron renderer process and interact with its internal React state:

- `window.ViewState._composeFormController` - Access compose form controllers
- `window.GoogleAccount.portal` - Invoke internal APIs (threadInternal, gmail, msgraph)
- `window.GoogleAccount.threads.identityMap` - Access cached thread models

This approach is more reliable than DOM/keyboard automation because it uses Superhuman's internal APIs directly.

Supports both Gmail and Microsoft/Outlook accounts.

## License

MIT
