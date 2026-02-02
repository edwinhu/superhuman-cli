---
name: superhuman
description: This skill should be used when the user asks to "check email", "read inbox", "send email", "reply to email", "search emails", "archive email", "snooze email", "star email", "add label", "forward email", "download attachment", "switch email account", "check calendar", "list events", "create event", "schedule meeting", "check availability", "free busy", or needs to interact with Superhuman email client or calendar.
---

# Superhuman Email & Calendar Automation

Automate Superhuman email client via CLI or MCP server using Chrome DevTools Protocol.

## Prerequisites

Superhuman must be running with remote debugging enabled. The CLI auto-launches it if needed:

```bash
/Applications/Superhuman.app/Contents/MacOS/Superhuman --remote-debugging-port=9333
```

## CLI Usage

The `superhuman` binary provides direct command-line access:

```bash
# Check connection
superhuman status

# List inbox
superhuman inbox
superhuman inbox --limit 20 --json

# Search emails
superhuman search "from:john subject:meeting"

# Read a thread
superhuman read <thread-id>
superhuman read <thread-id> --json

# Reply/forward
superhuman reply <thread-id> --body "Thanks!"
superhuman reply <thread-id> --body "Got it" --send
superhuman reply-all <thread-id> --body "Thanks everyone"
superhuman forward <thread-id> --to user@example.com --body "FYI"

# Compose/send
superhuman send --to user@example.com --subject "Hello" --body "Hi there"
superhuman draft --to user@example.com --subject "Hello" --body "Draft content"

# Organize
superhuman archive <thread-id>
superhuman delete <thread-id>
superhuman mark-read <thread-id>
superhuman mark-unread <thread-id>
superhuman star <thread-id>
superhuman unstar <thread-id>

# Labels
superhuman labels
superhuman get-labels <thread-id>
superhuman add-label <thread-id> --label Label_123
superhuman remove-label <thread-id> --label Label_123

# Snooze
superhuman snooze <thread-id> --until tomorrow
superhuman snooze <thread-id> --until next-week
superhuman snooze <thread-id> --until "2024-02-15T14:00:00Z"
superhuman unsnooze <thread-id>
superhuman snoozed

# Attachments
superhuman attachments <thread-id>
superhuman download <thread-id> --output ./downloads

# Accounts
superhuman accounts
superhuman account 2
superhuman account user@example.com

# Calendar
superhuman calendar                              # List today's events
superhuman calendar --date tomorrow              # List tomorrow's events
superhuman calendar --range 7 --json             # List next 7 days as JSON
superhuman calendar-create --title "Meeting" --start "2pm" --duration 30
superhuman calendar-create --title "All Day" --date 2026-02-05
superhuman calendar-update --event <event-id> --title "New Title"
superhuman calendar-delete --event <event-id>
superhuman calendar-free                         # Check today's availability
superhuman calendar-free --date tomorrow --range 7
```

## MCP Server Usage

Run as MCP server for Claude Code integration:

```bash
superhuman --mcp
# or
bun run mcp
```

Configure in Claude Code settings:

```json
{
  "mcpServers": {
    "superhuman": {
      "command": "superhuman",
      "args": ["--mcp"]
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `superhuman_inbox` | List recent inbox threads |
| `superhuman_search` | Search emails by query |
| `superhuman_read` | Read a specific thread |
| `superhuman_send` | Compose and send email |
| `superhuman_draft` | Create and save draft |
| `superhuman_reply` | Reply to thread |
| `superhuman_reply_all` | Reply-all to thread |
| `superhuman_forward` | Forward thread |
| `superhuman_archive` | Archive thread(s) |
| `superhuman_delete` | Delete (trash) thread(s) |
| `superhuman_mark_read` | Mark as read |
| `superhuman_mark_unread` | Mark as unread |
| `superhuman_labels` | List available labels |
| `superhuman_get_labels` | Get labels on thread |
| `superhuman_add_label` | Add label to thread(s) |
| `superhuman_remove_label` | Remove label from thread(s) |
| `superhuman_star` | Star thread(s) |
| `superhuman_unstar` | Unstar thread(s) |
| `superhuman_starred` | List starred threads |
| `superhuman_snooze` | Snooze until time |
| `superhuman_unsnooze` | Cancel snooze |
| `superhuman_snoozed` | List snoozed threads |
| `superhuman_attachments` | List attachments |
| `superhuman_download_attachment` | Download attachment |
| `superhuman_add_attachment` | Add attachment to draft |
| `superhuman_accounts` | List linked accounts |
| `superhuman_switch_account` | Switch active account |
| `superhuman_calendar_list` | List calendar events |
| `superhuman_calendar_create` | Create calendar event |
| `superhuman_calendar_update` | Update calendar event |
| `superhuman_calendar_delete` | Delete calendar event |
| `superhuman_calendar_free_busy` | Check availability |

## Common Workflows

### Triage Inbox

```bash
# Get recent emails
superhuman inbox --limit 20

# Read important ones
superhuman read <thread-id>

# Quick actions
superhuman archive <thread-id1> <thread-id2>
superhuman snooze <thread-id> --until tomorrow
superhuman star <thread-id>
```

### Reply to Email

```bash
# Read the thread first
superhuman read <thread-id>

# Draft a reply (saves without sending)
superhuman reply <thread-id> --body "Thanks for the update. I'll review and get back to you."

# Or send immediately
superhuman reply <thread-id> --body "Sounds good!" --send
```

### Search and Process

```bash
# Find emails from specific sender
superhuman search "from:boss@company.com" --limit 10

# Find unread emails with attachments
superhuman search "is:unread has:attachment"

# Archive old threads
superhuman search "older_than:30d" | xargs superhuman archive
```

### Multi-Account

```bash
# List accounts
superhuman accounts

# Switch to work account
superhuman account work@company.com

# Or by index
superhuman account 2
```

### Calendar Management

```bash
# Check today's schedule
superhuman calendar

# View the week ahead
superhuman calendar --range 7

# Check availability before scheduling
superhuman calendar-free --date tomorrow

# Create a meeting
superhuman calendar-create --title "Team Sync" --start "2pm" --duration 60

# Create all-day event
superhuman calendar-create --title "Conference" --date 2026-02-15

# Reschedule an event
superhuman calendar-update --event <event-id> --start "3pm"

# Cancel an event
superhuman calendar-delete --event <event-id>
```

## Snooze Presets

| Preset | When |
|--------|------|
| `tomorrow` | 9am next day |
| `next-week` | 9am next Monday |
| `weekend` | 9am Saturday |
| `evening` | 6pm today |
| ISO datetime | Exact time (e.g., `2024-02-15T14:00:00Z`) |

## Output Formats

Most commands support `--json` for structured output:

```bash
superhuman inbox --json | jq '.[] | {id, subject, from}'
```

## Troubleshooting

### Connection Failed

Superhuman auto-launches on first connection. If it fails:

1. Check if Superhuman is installed at `/Applications/Superhuman.app`
2. Manually launch with debugging: `/Applications/Superhuman.app/Contents/MacOS/Superhuman --remote-debugging-port=9333`
3. Verify connection: `superhuman status`

### Thread Not Found

Thread IDs come from inbox/search results. Use `--json` to get exact IDs:

```bash
superhuman inbox --json | jq '.[0].id'
```

### Account Not Switching

Ensure the email is linked in Superhuman. List available accounts:

```bash
superhuman accounts
```

