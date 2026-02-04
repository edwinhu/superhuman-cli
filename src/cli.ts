#!/usr/bin/env bun
/**
 * Superhuman CLI
 *
 * Command-line interface for composing and sending emails via Superhuman.
 *
 * Usage:
 *   superhuman compose --to <email> --subject <subject> --body <body>
 *   superhuman send --to <email> --subject <subject> --body <body>
 *   superhuman draft --to <email> --subject <subject> --body <body>
 *   superhuman status
 */

import {
  connectToSuperhuman,
  openCompose,
  getDraftState,
  setSubject,
  addRecipient,
  setBody,
  saveDraft,
  sendDraft,
  closeCompose,
  disconnect,
  textToHtml,
  unescapeString,
  type SuperhumanConnection,
} from "./superhuman-api";
import { listInbox, searchInbox } from "./inbox";
import { readThread } from "./read";
import { listAccounts, switchAccount, type Account } from "./accounts";
import { replyToThread, replyAllToThread, forwardThread } from "./reply";
import { archiveThread, deleteThread } from "./archive";
import { markAsRead, markAsUnread } from "./read-status";
import { listLabels, getThreadLabels, addLabel, removeLabel, starThread, unstarThread, listStarred } from "./labels";
import { snoozeThread, unsnoozeThread, listSnoozed, parseSnoozeTime } from "./snooze";
import { listAttachments, downloadAttachment, type Attachment } from "./attachments";
import {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent as deleteCalendarEvent,
  getFreeBusy,
  type CalendarEvent,
  type CreateEventInput,
  type UpdateEventInput,
} from "./calendar";
import { sendEmail, createDraft, updateDraft, sendDraftById, deleteDraft } from "./send-api";
import { searchContacts, resolveRecipient, type Contact } from "./contacts";

const VERSION = "0.3.0";
const CDP_PORT = 9333;

// ANSI colors
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function log(message: string) {
  console.log(message);
}

function success(message: string) {
  console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function error(message: string) {
  console.error(`${colors.red}✗${colors.reset} ${message}`);
}

function info(message: string) {
  console.log(`${colors.blue}ℹ${colors.reset} ${message}`);
}

/**
 * Format accounts list for human-readable output
 */
export function formatAccountsList(accounts: Account[]): string {
  if (accounts.length === 0) return "";

  return accounts
    .map((account, index) => {
      const marker = account.isCurrent ? "*" : " ";
      const suffix = account.isCurrent ? " (current)" : "";
      return `${marker} ${index + 1}. ${account.email}${suffix}`;
    })
    .join("\n");
}

/**
 * Format accounts list as JSON
 */
export function formatAccountsJson(accounts: Account[]): string {
  return JSON.stringify(accounts);
}

function printHelp() {
  console.log(`
${colors.bold}Superhuman CLI${colors.reset} v${VERSION}

${colors.bold}USAGE${colors.reset}
  superhuman <command> [options]

${colors.bold}COMMANDS${colors.reset}
  ${colors.cyan}accounts${colors.reset}   List all linked accounts
  ${colors.cyan}account${colors.reset}    Switch to a different account
  ${colors.cyan}inbox${colors.reset}      List recent emails from inbox
  ${colors.cyan}search${colors.reset}     Search emails
  ${colors.cyan}read${colors.reset}       Read a specific email thread
  ${colors.cyan}reply${colors.reset}      Reply to an email thread
  ${colors.cyan}reply-all${colors.reset}  Reply-all to an email thread
  ${colors.cyan}forward${colors.reset}    Forward an email thread
  ${colors.cyan}archive${colors.reset}    Archive email thread(s)
  ${colors.cyan}delete${colors.reset}     Delete (trash) email thread(s)
  ${colors.cyan}mark-read${colors.reset}  Mark thread(s) as read
  ${colors.cyan}mark-unread${colors.reset} Mark thread(s) as unread
  ${colors.cyan}labels${colors.reset}     List all available labels
  ${colors.cyan}get-labels${colors.reset} Get labels on a specific thread
  ${colors.cyan}add-label${colors.reset}  Add a label to thread(s)
  ${colors.cyan}remove-label${colors.reset} Remove a label from thread(s)
  ${colors.cyan}star${colors.reset}       Star thread(s)
  ${colors.cyan}unstar${colors.reset}     Unstar thread(s)
  ${colors.cyan}starred${colors.reset}    List all starred threads
  ${colors.cyan}snooze${colors.reset}     Snooze thread(s) until a specific time
  ${colors.cyan}unsnooze${colors.reset}   Unsnooze (cancel snooze) thread(s)
  ${colors.cyan}snoozed${colors.reset}    List all snoozed threads
  ${colors.cyan}attachments${colors.reset} List attachments for a thread
  ${colors.cyan}download${colors.reset}   Download attachments from a thread
  ${colors.cyan}calendar${colors.reset}   List calendar events
  ${colors.cyan}calendar-create${colors.reset} Create a calendar event
  ${colors.cyan}calendar-update${colors.reset} Update a calendar event
  ${colors.cyan}calendar-delete${colors.reset} Delete a calendar event
  ${colors.cyan}calendar-free${colors.reset} Check free/busy availability
  ${colors.cyan}contacts${colors.reset}   Search contacts by name
  ${colors.cyan}compose${colors.reset}    Open compose window and fill in email (keeps window open)
  ${colors.cyan}draft${colors.reset}      Create or update a draft
  ${colors.cyan}delete-draft${colors.reset} Delete draft(s) by ID
  ${colors.cyan}send${colors.reset}       Compose and send an email, or send an existing draft
  ${colors.cyan}status${colors.reset}     Check Superhuman connection status
  ${colors.cyan}help${colors.reset}       Show this help message

${colors.bold}OPTIONS${colors.reset}
  --to <email|name>  Recipient email or name (names are resolved via contact search)
  --cc <email|name>  CC recipient (can be used multiple times)
  --bcc <email|name> BCC recipient (can be used multiple times)
  --subject <text>   Email subject
  --body <text>      Email body (plain text, converted to HTML)
  --html <text>      Email body as HTML
  --send             Send immediately instead of saving as draft (for reply/reply-all/forward)
  --update <id>      Draft ID to update (for draft command)
  --draft <id>       Draft ID to send (for send command)
  --label <id>       Label ID to add or remove (for add-label/remove-label)
  --until <time>     Snooze until time: preset (tomorrow, next-week, weekend, evening) or ISO datetime
  --output <path>    Output directory or file path (for download)
  --attachment <id>  Specific attachment ID (for download)
  --message <id>     Message ID (required with --attachment)
  --limit <number>   Number of results (default: 10, for inbox/search)
  --json             Output as JSON (for inbox/search/read)
  --date <date>      Date for calendar (YYYY-MM-DD or "today", "tomorrow")
  --calendar <name>  Calendar name or ID (default: primary)
  --range <days>     Days to show for calendar (default: 1)
  --start <time>     Event start time (ISO datetime or natural: "2pm", "tomorrow 3pm")
  --end <time>       Event end time (ISO datetime, optional if --duration)
  --duration <mins>  Event duration in minutes (default: 30)
  --title <text>     Event title (for calendar-create/update)
  --event <id>       Event ID (for calendar-update/delete)
  --port <number>    CDP port (default: ${CDP_PORT})

${colors.bold}EXAMPLES${colors.reset}
  ${colors.dim}# List linked accounts${colors.reset}
  superhuman accounts
  superhuman accounts --json

  ${colors.dim}# Switch account${colors.reset}
  superhuman account 2
  superhuman account user@example.com

  ${colors.dim}# List recent emails${colors.reset}
  superhuman inbox
  superhuman inbox --limit 5 --json

  ${colors.dim}# Search emails${colors.reset}
  superhuman search "from:john subject:meeting"
  superhuman search "project update" --limit 20

  ${colors.dim}# Read an email thread${colors.reset}
  superhuman read <thread-id>
  superhuman read <thread-id> --json

  ${colors.dim}# Reply to an email${colors.reset}
  superhuman reply <thread-id> --body "Thanks for the update!"
  superhuman reply <thread-id> --body "Got it!" --send

  ${colors.dim}# Reply-all to an email${colors.reset}
  superhuman reply-all <thread-id> --body "Thanks everyone!"

  ${colors.dim}# Forward an email${colors.reset}
  superhuman forward <thread-id> --to colleague@example.com --body "FYI"
  superhuman forward <thread-id> --to colleague@example.com --send

  ${colors.dim}# Archive emails${colors.reset}
  superhuman archive <thread-id>
  superhuman archive <thread-id1> <thread-id2> <thread-id3>

  ${colors.dim}# Delete (trash) emails${colors.reset}
  superhuman delete <thread-id>
  superhuman delete <thread-id1> <thread-id2> <thread-id3>

  ${colors.dim}# Mark as read/unread${colors.reset}
  superhuman mark-read <thread-id>
  superhuman mark-unread <thread-id1> <thread-id2>

  ${colors.dim}# List all labels${colors.reset}
  superhuman labels
  superhuman labels --json

  ${colors.dim}# Get labels on a thread${colors.reset}
  superhuman get-labels <thread-id>
  superhuman get-labels <thread-id> --json

  ${colors.dim}# Add/remove labels${colors.reset}
  superhuman add-label <thread-id> --label Label_123
  superhuman remove-label <thread-id> --label Label_123

  ${colors.dim}# Star/unstar threads${colors.reset}
  superhuman star <thread-id>
  superhuman star <thread-id1> <thread-id2>
  superhuman unstar <thread-id>
  superhuman starred
  superhuman starred --json

  ${colors.dim}# Snooze/unsnooze threads${colors.reset}
  superhuman snooze <thread-id> --until tomorrow
  superhuman snooze <thread-id> --until next-week
  superhuman snooze <thread-id> --until "2024-02-15T14:00:00Z"
  superhuman unsnooze <thread-id>
  superhuman snoozed
  superhuman snoozed --json

  ${colors.dim}# List and download attachments${colors.reset}
  superhuman attachments <thread-id>
  superhuman attachments <thread-id> --json
  superhuman download <thread-id>
  superhuman download <thread-id> --output ./downloads
  superhuman download --attachment <attachment-id> --message <message-id> --output ./file.pdf

  ${colors.dim}# List calendar events${colors.reset}
  superhuman calendar
  superhuman calendar --date tomorrow
  superhuman calendar --range 7 --json

  ${colors.dim}# Create calendar event${colors.reset}
  superhuman calendar-create --title "Meeting" --start "2pm" --duration 30
  superhuman calendar-create --title "All Day" --date 2026-02-05

  ${colors.dim}# Update/delete calendar event${colors.reset}
  superhuman calendar-update --event <event-id> --title "New Title"
  superhuman calendar-delete --event <event-id>

  ${colors.dim}# Check availability${colors.reset}
  superhuman calendar-free
  superhuman calendar-free --date tomorrow --range 7

  ${colors.dim}# Search contacts by name${colors.reset}
  superhuman contacts search "john"
  superhuman contacts search "john" --limit 5 --json

  ${colors.dim}# Create a draft${colors.reset}
  superhuman draft --to user@example.com --subject "Hello" --body "Hi there!"

  ${colors.dim}# Update an existing draft${colors.reset}
  superhuman draft --update <draft-id> --body "Updated content"
  superhuman draft --update <draft-id> --subject "New Subject" --to new@example.com

  ${colors.dim}# Delete drafts${colors.reset}
  superhuman delete-draft <draft-id>
  superhuman delete-draft <draft-id1> <draft-id2>

  ${colors.dim}# Open compose window with pre-filled content${colors.reset}
  superhuman compose --to user@example.com --subject "Meeting"

  ${colors.dim}# Compose using contact name instead of email (auto-resolved)${colors.reset}
  superhuman compose --to "john" --subject "Meeting"
  superhuman draft --to "john" --cc "jane" --subject "Update"

  ${colors.dim}# Send an email immediately${colors.reset}
  superhuman send --to user@example.com --subject "Quick note" --body "FYI"

  ${colors.dim}# Send an existing draft by ID${colors.reset}
  superhuman send --draft <draft-id>

${colors.bold}REQUIREMENTS${colors.reset}
  Superhuman must be running with remote debugging enabled:
  ${colors.dim}/Applications/Superhuman.app/Contents/MacOS/Superhuman --remote-debugging-port=${CDP_PORT}${colors.reset}
`);
}

interface CliOptions {
  command: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  html: string;
  port: number;
  // inbox/search/read options
  limit: number;
  query: string;
  threadId: string;
  threadIds: string[]; // for bulk operations (archive/delete)
  draftIds: string[]; // for delete-draft
  json: boolean;
  // account switching
  accountArg: string; // index or email for account command
  // reply/forward options
  send: boolean; // send immediately instead of saving as draft
  // draft update option
  updateDraftId: string; // draft ID to update (for draft command)
  // send draft option
  sendDraftId: string; // draft ID to send (for send command)
  // label options
  labelId: string; // label ID for add-label/remove-label
  // snooze options
  snoozeUntil: string; // time to snooze until (preset or ISO datetime)
  // attachment options
  outputPath: string; // output directory or file path for downloads
  attachmentId: string; // specific attachment ID for single download
  messageId: string; // message ID for single attachment download
  // calendar options
  calendarArg: string; // calendar name or ID
  calendarDate: string; // date for calendar listing (YYYY-MM-DD or "today", "tomorrow")
  calendarRange: number; // number of days to show
  allAccounts: boolean; // query all accounts for calendar
  eventStart: string; // event start time
  eventEnd: string; // event end time
  eventDuration: number; // event duration in minutes
  eventTitle: string; // event title
  eventId: string; // event ID for update/delete
  // contacts options
  contactsSubcommand: string; // subcommand for contacts (search)
  contactsQuery: string; // search query for contacts
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    command: "",
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    html: "",
    port: CDP_PORT,
    limit: 10,
    query: "",
    threadId: "",
    threadIds: [],
    draftIds: [],
    json: false,
    accountArg: "",
    send: false,
    updateDraftId: "",
    sendDraftId: "",
    labelId: "",
    snoozeUntil: "",
    outputPath: "",
    attachmentId: "",
    messageId: "",
    calendarArg: "",
    calendarDate: "",
    calendarRange: 1,
    allAccounts: false,
    eventStart: "",
    eventEnd: "",
    eventDuration: 30,
    eventTitle: "",
    eventId: "",
    contactsSubcommand: "",
    contactsQuery: "",
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[i + 1];

      switch (key) {
        case "to":
          options.to.push(unescapeString(value));
          i += 2;
          break;
        case "cc":
          options.cc.push(unescapeString(value));
          i += 2;
          break;
        case "bcc":
          options.bcc.push(unescapeString(value));
          i += 2;
          break;
        case "subject":
          options.subject = unescapeString(value);
          i += 2;
          break;
        case "body":
          options.body = unescapeString(value);
          i += 2;
          break;
        case "html":
          options.html = unescapeString(value);
          i += 2;
          break;
        case "port":
          options.port = parseInt(value, 10);
          i += 2;
          break;
        case "help":
          options.command = "help";
          i += 1;
          break;
        case "limit":
          options.limit = parseInt(value, 10);
          i += 2;
          break;
        case "query":
          options.query = unescapeString(value);
          i += 2;
          break;
        case "thread":
          options.threadId = unescapeString(value);
          i += 2;
          break;
        case "json":
          options.json = true;
          i += 1;
          break;
        case "send":
          options.send = true;
          i += 1;
          break;
        case "update":
          options.updateDraftId = unescapeString(value);
          i += 2;
          break;
        case "draft":
          options.sendDraftId = unescapeString(value);
          i += 2;
          break;
        case "label":
          options.labelId = unescapeString(value);
          i += 2;
          break;
        case "until":
          options.snoozeUntil = unescapeString(value);
          i += 2;
          break;
        case "output":
          options.outputPath = unescapeString(value);
          i += 2;
          break;
        case "attachment":
          options.attachmentId = unescapeString(value);
          i += 2;
          break;
        case "message":
          options.messageId = unescapeString(value);
          i += 2;
          break;
        case "calendar":
          options.calendarArg = unescapeString(value);
          i += 2;
          break;
        case "date":
          options.calendarDate = unescapeString(value);
          i += 2;
          break;
        case "range":
          options.calendarRange = parseInt(value, 10);
          i += 2;
          break;
        case "all-accounts":
          options.allAccounts = true;
          i++;
          break;
        case "start":
          options.eventStart = unescapeString(value);
          i += 2;
          break;
        case "end":
          options.eventEnd = unescapeString(value);
          i += 2;
          break;
        case "duration":
          options.eventDuration = parseInt(value, 10);
          i += 2;
          break;
        case "title":
          options.eventTitle = unescapeString(value);
          i += 2;
          break;
        case "event":
          options.eventId = unescapeString(value);
          i += 2;
          break;
        default:
          error(`Unknown option: ${arg}`);
          process.exit(1);
      }
    } else if (!options.command) {
      options.command = arg;
      i += 1;
    } else if (options.command === "search" && !options.query) {
      // Allow search query as positional argument
      options.query = unescapeString(arg);
      i += 1;
    } else if (options.command === "read" && !options.threadId) {
      // Allow thread ID as positional argument
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "reply" && !options.threadId) {
      // Allow thread ID as positional argument for reply
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "reply-all" && !options.threadId) {
      // Allow thread ID as positional argument for reply-all
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "forward" && !options.threadId) {
      // Allow thread ID as positional argument for forward
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "account" && !options.accountArg) {
      // Allow account index or email as positional argument
      options.accountArg = unescapeString(arg);
      i += 1;
    } else if (
      options.command === "archive" ||
      options.command === "delete" ||
      options.command === "mark-read" ||
      options.command === "mark-unread" ||
      options.command === "add-label" ||
      options.command === "remove-label" ||
      options.command === "star" ||
      options.command === "unstar" ||
      options.command === "snooze" ||
      options.command === "unsnooze"
    ) {
      // Collect multiple thread IDs for bulk operations
      options.threadIds.push(unescapeString(arg));
      i += 1;
    } else if (options.command === "delete-draft") {
      // Collect multiple draft IDs for delete-draft
      options.draftIds.push(unescapeString(arg));
      i += 1;
    } else if (options.command === "get-labels" && !options.threadId) {
      // Allow thread ID as positional argument for get-labels
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "attachments" && !options.threadId) {
      // Allow thread ID as positional argument for attachments
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "download" && !options.threadId && !options.attachmentId) {
      // Allow thread ID as positional argument for download (when not using --attachment)
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "contacts" && !options.contactsSubcommand) {
      // First positional arg after 'contacts' is the subcommand (e.g., 'search')
      options.contactsSubcommand = arg;
      i += 1;
    } else if (options.command === "contacts" && options.contactsSubcommand === "search" && !options.contactsQuery) {
      // Allow search query as positional argument for contacts search
      options.contactsQuery = unescapeString(arg);
      i += 1;
    } else {
      error(`Unexpected argument: ${arg}`);
      process.exit(1);
    }
  }

  return options;
}

async function checkConnection(port: number): Promise<SuperhumanConnection | null> {
  try {
    const conn = await connectToSuperhuman(port, true); // auto-launch enabled
    if (!conn) {
      error("Could not connect to Superhuman");
      info("Superhuman may not be installed or failed to launch");
      return null;
    }
    return conn;
  } catch (e) {
    error(`Connection failed: ${(e as Error).message}`);
    info("Superhuman may not be installed at /Applications/Superhuman.app");
    return null;
  }
}

/**
 * Resolve all recipients in arrays (to, cc, bcc) from names to email addresses.
 * Names without @ are looked up in contacts; emails are passed through unchanged.
 */
async function resolveAllRecipients(
  conn: SuperhumanConnection,
  recipients: string[]
): Promise<string[]> {
  const resolved: string[] = [];
  for (const recipient of recipients) {
    const email = await resolveRecipient(conn, recipient);
    if (email !== recipient && !recipient.includes("@")) {
      info(`Resolved "${recipient}" to ${email}`);
    }
    resolved.push(email);
  }
  return resolved;
}

async function cmdStatus(options: CliOptions) {
  info(`Checking connection to Superhuman on port ${options.port}...`);

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  success("Connected to Superhuman");

  // Get current state
  const state = await getDraftState(conn);
  if (state) {
    log(`\n${colors.bold}Current compose state:${colors.reset}`);
    log(`  Draft ID: ${state.id}`);
    log(`  From: ${state.from}`);
    log(`  To: ${state.to.join(", ") || "(none)"}`);
    log(`  Subject: ${state.subject || "(none)"}`);
    log(`  Dirty: ${state.isDirty}`);
  } else {
    log("\nNo active compose window");
  }

  await disconnect(conn);
}

async function cmdCompose(options: CliOptions, keepOpen = true) {
  if (options.to.length === 0) {
    error("At least one recipient is required (--to)");
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  // Resolve names to emails
  const resolvedTo = await resolveAllRecipients(conn, options.to);

  info("Opening compose window...");
  const draftKey = await openCompose(conn);
  if (!draftKey) {
    error("Failed to open compose window");
    await disconnect(conn);
    process.exit(1);
  }
  success(`Compose opened (${draftKey})`);

  // Add recipients
  for (const email of resolvedTo) {
    info(`Adding recipient: ${email}`);
    const added = await addRecipient(conn, email, undefined, draftKey);
    if (added) {
      success(`Added: ${email}`);
    } else {
      error(`Failed to add: ${email}`);
    }
  }

  // Set subject
  if (options.subject) {
    info(`Setting subject: ${options.subject}`);
    await setSubject(conn, options.subject, draftKey);
    success("Subject set");
  }

  // Set body
  const bodyContent = options.html || options.body;
  if (bodyContent) {
    info("Setting body...");
    await setBody(conn, textToHtml(bodyContent), draftKey);
    success("Body set");
  }

  // Get final state
  const state = await getDraftState(conn);
  if (state) {
    log(`\n${colors.bold}Draft:${colors.reset}`);
    log(`  To: ${state.to.join(", ")}`);
    log(`  Subject: ${state.subject}`);
    log(`  Body: ${state.body.substring(0, 100)}${state.body.length > 100 ? "..." : ""}`);
  }

  if (!keepOpen) {
    await closeCompose(conn);
  }

  await disconnect(conn);
  return state;
}

async function cmdDraft(options: CliOptions) {
  // If updating an existing draft
  if (options.updateDraftId) {
    const conn = await checkConnection(options.port);
    if (!conn) {
      process.exit(1);
    }

    // Resolve names to emails
    const resolvedTo = options.to.length > 0 ? await resolveAllRecipients(conn, options.to) : undefined;
    const resolvedCc = options.cc.length > 0 ? await resolveAllRecipients(conn, options.cc) : undefined;
    const resolvedBcc = options.bcc.length > 0 ? await resolveAllRecipients(conn, options.bcc) : undefined;

    // Use HTML body if provided, otherwise convert plain text to HTML (if body provided)
    const bodyContent = options.html || (options.body ? textToHtml(options.body) : undefined);

    info(`Updating draft ${options.updateDraftId}...`);
    const result = await updateDraft(conn, options.updateDraftId, {
      to: resolvedTo,
      cc: resolvedCc,
      bcc: resolvedBcc,
      subject: options.subject || undefined,
      body: bodyContent,
      isHtml: true,
    });

    if (result.success) {
      success("Draft updated!");
      if (result.draftId) {
        log(`  ${colors.dim}Draft ID: ${result.draftId}${colors.reset}`);
      }
    } else {
      error(`Failed to update draft: ${result.error}`);
    }

    await disconnect(conn);
    return;
  }

  // Creating a new draft - requires at least one recipient
  if (options.to.length === 0) {
    error("At least one recipient is required (--to)");
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  // Resolve names to emails
  const resolvedTo = await resolveAllRecipients(conn, options.to);
  const resolvedCc = options.cc.length > 0 ? await resolveAllRecipients(conn, options.cc) : undefined;
  const resolvedBcc = options.bcc.length > 0 ? await resolveAllRecipients(conn, options.bcc) : undefined;

  // Use HTML body if provided, otherwise convert plain text to HTML
  const bodyContent = options.html || textToHtml(options.body);

  info("Creating draft...");
  const result = await createDraft(conn, {
    to: resolvedTo,
    cc: resolvedCc,
    bcc: resolvedBcc,
    subject: options.subject || "",
    body: bodyContent,
    isHtml: true,
  });

  if (result.success) {
    success("Draft created!");
    if (result.draftId) {
      log(`  ${colors.dim}Draft ID: ${result.draftId}${colors.reset}`);
    }
  } else {
    error(`Failed to create draft: ${result.error}`);
  }

  await disconnect(conn);
}

async function cmdDeleteDraft(options: CliOptions) {
  const draftIds = options.draftIds;

  if (draftIds.length === 0) {
    error("At least one draft ID is required");
    error("Usage: superhuman delete-draft <draft-id> [draft-id...]");
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  for (const draftId of draftIds) {
    info(`Deleting draft ${draftId.slice(-15)}...`);
    const result = await deleteDraft(conn, draftId);

    if (result.success) {
      success(`Deleted draft ${draftId.slice(-15)}`);
    } else {
      error(`Failed to delete draft: ${result.error}`);
    }
  }

  await disconnect(conn);
}

async function cmdSend(options: CliOptions) {
  // If sending an existing draft by ID
  if (options.sendDraftId) {
    const conn = await checkConnection(options.port);
    if (!conn) {
      process.exit(1);
    }

    info(`Sending draft ${options.sendDraftId}...`);
    const result = await sendDraftById(conn, options.sendDraftId);

    if (result.success) {
      success("Draft sent!");
      if (result.messageId) {
        log(`  ${colors.dim}Message ID: ${result.messageId}${colors.reset}`);
      }
    } else {
      error(`Failed to send draft: ${result.error}`);
    }

    await disconnect(conn);
    return;
  }

  // Composing and sending a new email - requires at least one recipient
  if (options.to.length === 0) {
    error("At least one recipient is required (--to)");
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  // Resolve names to emails
  const resolvedTo = await resolveAllRecipients(conn, options.to);
  const resolvedCc = options.cc.length > 0 ? await resolveAllRecipients(conn, options.cc) : undefined;
  const resolvedBcc = options.bcc.length > 0 ? await resolveAllRecipients(conn, options.bcc) : undefined;

  // Use HTML body if provided, otherwise convert plain text to HTML
  const bodyContent = options.html || textToHtml(options.body);

  info("Sending email...");
  const result = await sendEmail(conn, {
    to: resolvedTo,
    cc: resolvedCc,
    bcc: resolvedBcc,
    subject: options.subject || "",
    body: bodyContent,
    isHtml: true,
  });

  if (result.success) {
    success("Email sent!");
    if (result.messageId) {
      log(`  ${colors.dim}Message ID: ${result.messageId}${colors.reset}`);
    }
  } else {
    error(`Failed to send: ${result.error}`);
  }

  await disconnect(conn);
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

async function cmdInbox(options: CliOptions) {
  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const threads = await listInbox(conn, { limit: options.limit });

  if (options.json) {
    console.log(JSON.stringify(threads, null, 2));
  } else {
    if (threads.length === 0) {
      info("No emails in inbox");
    } else {
      // Print header
      console.log(
        `${colors.dim}${"From".padEnd(25)} ${"Subject".padEnd(40)} ${"Date".padEnd(10)}${colors.reset}`
      );
      console.log(colors.dim + "─".repeat(78) + colors.reset);

      for (const thread of threads) {
        const from = truncate(thread.from.name || thread.from.email, 24);
        const subject = truncate(thread.subject, 39);
        const date = formatDate(thread.date);
        console.log(`${from.padEnd(25)} ${subject.padEnd(40)} ${date}`);
      }
    }
  }

  await disconnect(conn);
}

async function cmdSearch(options: CliOptions) {
  if (!options.query) {
    error("Search query is required");
    console.log(`Usage: superhuman search <query>`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const threads = await searchInbox(conn, {
    query: options.query,
    limit: options.limit,
  });

  if (options.json) {
    console.log(JSON.stringify(threads, null, 2));
  } else {
    if (threads.length === 0) {
      info(`No results for "${options.query}"`);
    } else {
      info(`Found ${threads.length} result(s) for "${options.query}":\n`);
      console.log(
        `${colors.dim}${"From".padEnd(25)} ${"Subject".padEnd(40)} ${"Date".padEnd(10)}${colors.reset}`
      );
      console.log(colors.dim + "─".repeat(78) + colors.reset);

      for (const thread of threads) {
        const from = truncate(thread.from.name || thread.from.email, 24);
        const subject = truncate(thread.subject, 39);
        const date = formatDate(thread.date);
        console.log(`${from.padEnd(25)} ${subject.padEnd(40)} ${date}`);
      }
    }
  }

  await disconnect(conn);
}

async function cmdRead(options: CliOptions) {
  if (!options.threadId) {
    error("Thread ID is required");
    console.log(`Usage: superhuman read <thread-id>`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const messages = await readThread(conn, options.threadId);

  if (options.json) {
    console.log(JSON.stringify(messages, null, 2));
  } else {
    if (messages.length === 0) {
      error("Thread not found or no messages");
    } else {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (i > 0) {
          console.log("\n" + colors.dim + "─".repeat(60) + colors.reset + "\n");
        }
        console.log(`${colors.bold}${msg.subject}${colors.reset}`);
        console.log(`${colors.cyan}From:${colors.reset} ${msg.from.name} <${msg.from.email}>`);
        console.log(
          `${colors.cyan}To:${colors.reset} ${msg.to.map((r) => r.email).join(", ")}`
        );
        if (msg.cc.length > 0) {
          console.log(
            `${colors.cyan}Cc:${colors.reset} ${msg.cc.map((r) => r.email).join(", ")}`
          );
        }
        console.log(`${colors.cyan}Date:${colors.reset} ${new Date(msg.date).toLocaleString()}`);
        console.log();
        console.log(msg.snippet);
      }
    }
  }

  await disconnect(conn);
}

async function cmdReply(options: CliOptions) {
  if (!options.threadId) {
    error("Thread ID is required");
    console.log(`Usage: superhuman reply <thread-id> [--body "text"] [--send]`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const body = options.body || "";
  const action = options.send ? "Sending" : "Creating draft for";
  info(`${action} reply to thread ${options.threadId}...`);

  const result = await replyToThread(conn, options.threadId, body, options.send);

  if (result.success) {
    if (options.send) {
      success("Reply sent!");
    } else {
      success(`Draft saved (${result.draftId})`);
    }
  } else {
    error(result.error || "Failed to create reply");
  }

  await disconnect(conn);
}

async function cmdReplyAll(options: CliOptions) {
  if (!options.threadId) {
    error("Thread ID is required");
    console.log(`Usage: superhuman reply-all <thread-id> [--body "text"] [--send]`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const body = options.body || "";
  const action = options.send ? "Sending" : "Creating draft for";
  info(`${action} reply-all to thread ${options.threadId}...`);

  const result = await replyAllToThread(conn, options.threadId, body, options.send);

  if (result.success) {
    if (options.send) {
      success("Reply-all sent!");
    } else {
      success(`Draft saved (${result.draftId})`);
    }
  } else {
    error(result.error || "Failed to create reply-all");
  }

  await disconnect(conn);
}

async function cmdForward(options: CliOptions) {
  if (!options.threadId) {
    error("Thread ID is required");
    console.log(`Usage: superhuman forward <thread-id> --to <email> [--body "text"] [--send]`);
    process.exit(1);
  }

  if (options.to.length === 0) {
    error("Recipient is required (--to)");
    console.log(`Usage: superhuman forward <thread-id> --to <email> [--body "text"] [--send]`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  // Resolve name to email
  const resolvedTo = await resolveAllRecipients(conn, options.to);
  const toEmail = resolvedTo[0]; // Use first recipient for forward

  const body = options.body || "";
  const action = options.send ? "Sending" : "Creating draft for";
  info(`${action} forward to ${toEmail}...`);

  const result = await forwardThread(conn, options.threadId, toEmail, body, options.send);

  if (result.success) {
    if (options.send) {
      success("Forward sent!");
    } else {
      success(`Draft saved (${result.draftId})`);
    }
  } else {
    error(result.error || "Failed to create forward");
  }

  await disconnect(conn);
}

async function cmdArchive(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman archive <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await archiveThread(conn, threadId);
    if (result.success) {
      success(`Archived: ${threadId}`);
      successCount++;
    } else {
      error(`Failed to archive: ${threadId}`);
      failCount++;
    }
  }

  if (options.threadIds.length > 1) {
    log(`\n${successCount} archived, ${failCount} failed`);
  }

  await disconnect(conn);
}

async function cmdDelete(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman delete <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await deleteThread(conn, threadId);
    if (result.success) {
      success(`Deleted: ${threadId}`);
      successCount++;
    } else {
      error(`Failed to delete: ${threadId}`);
      failCount++;
    }
  }

  if (options.threadIds.length > 1) {
    log(`\n${successCount} deleted, ${failCount} failed`);
  }

  await disconnect(conn);
}

async function cmdMarkRead(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman mark-read <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await markAsRead(conn, threadId);
    if (result.success) {
      success(`Marked as read: ${threadId}`);
      successCount++;
    } else {
      error(`Failed to mark as read: ${threadId}${result.error ? ` (${result.error})` : ""}`);
      failCount++;
    }
  }

  if (options.threadIds.length > 1) {
    log(`\n${successCount} marked as read, ${failCount} failed`);
  }

  await disconnect(conn);
}

async function cmdMarkUnread(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman mark-unread <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await markAsUnread(conn, threadId);
    if (result.success) {
      success(`Marked as unread: ${threadId}`);
      successCount++;
    } else {
      error(`Failed to mark as unread: ${threadId}${result.error ? ` (${result.error})` : ""}`);
      failCount++;
    }
  }

  if (options.threadIds.length > 1) {
    log(`\n${successCount} marked as unread, ${failCount} failed`);
  }

  await disconnect(conn);
}

async function cmdLabels(options: CliOptions) {
  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const labels = await listLabels(conn);

  if (options.json) {
    console.log(JSON.stringify(labels, null, 2));
  } else {
    if (labels.length === 0) {
      info("No labels found");
    } else {
      console.log(`${colors.bold}Labels:${colors.reset}\n`);
      for (const label of labels) {
        const typeInfo = label.type ? ` ${colors.dim}(${label.type})${colors.reset}` : "";
        console.log(`  ${label.name}${typeInfo}`);
        console.log(`    ${colors.dim}ID: ${label.id}${colors.reset}`);
      }
    }
  }

  await disconnect(conn);
}

async function cmdGetLabels(options: CliOptions) {
  if (!options.threadId) {
    error("Thread ID is required");
    console.log(`Usage: superhuman get-labels <thread-id>`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const labels = await getThreadLabels(conn, options.threadId);

  if (options.json) {
    console.log(JSON.stringify(labels, null, 2));
  } else {
    if (labels.length === 0) {
      info("No labels on this thread");
    } else {
      console.log(`${colors.bold}Labels on thread:${colors.reset}\n`);
      for (const label of labels) {
        const typeInfo = label.type ? ` ${colors.dim}(${label.type})${colors.reset}` : "";
        console.log(`  ${label.name}${typeInfo}`);
        console.log(`    ${colors.dim}ID: ${label.id}${colors.reset}`);
      }
    }
  }

  await disconnect(conn);
}

async function cmdAddLabel(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman add-label <thread-id> [thread-id...] --label <label-id>`);
    process.exit(1);
  }

  if (!options.labelId) {
    error("Label ID is required (--label)");
    console.log(`Usage: superhuman add-label <thread-id> [thread-id...] --label <label-id>`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await addLabel(conn, threadId, options.labelId);
    if (result.success) {
      success(`Added label to: ${threadId}`);
      successCount++;
    } else {
      error(`Failed to add label to: ${threadId}${result.error ? ` (${result.error})` : ""}`);
      failCount++;
    }
  }

  if (options.threadIds.length > 1) {
    log(`\n${successCount} labeled, ${failCount} failed`);
  }

  await disconnect(conn);
}

async function cmdRemoveLabel(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman remove-label <thread-id> [thread-id...] --label <label-id>`);
    process.exit(1);
  }

  if (!options.labelId) {
    error("Label ID is required (--label)");
    console.log(`Usage: superhuman remove-label <thread-id> [thread-id...] --label <label-id>`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await removeLabel(conn, threadId, options.labelId);
    if (result.success) {
      success(`Removed label from: ${threadId}`);
      successCount++;
    } else {
      error(`Failed to remove label from: ${threadId}${result.error ? ` (${result.error})` : ""}`);
      failCount++;
    }
  }

  if (options.threadIds.length > 1) {
    log(`\n${successCount} updated, ${failCount} failed`);
  }

  await disconnect(conn);
}

async function cmdStar(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman star <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await starThread(conn, threadId);
    if (result.success) {
      success(`Starred thread: ${threadId}`);
      successCount++;
    } else {
      error(`Failed to star thread: ${threadId}${result.error ? ` (${result.error})` : ""}`);
      failCount++;
    }
  }

  if (options.threadIds.length > 1) {
    log(`\n${successCount} starred, ${failCount} failed`);
  }

  await disconnect(conn);
}

async function cmdUnstar(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman unstar <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await unstarThread(conn, threadId);
    if (result.success) {
      success(`Unstarred thread: ${threadId}`);
      successCount++;
    } else {
      error(`Failed to unstar thread: ${threadId}${result.error ? ` (${result.error})` : ""}`);
      failCount++;
    }
  }

  if (options.threadIds.length > 1) {
    log(`\n${successCount} unstarred, ${failCount} failed`);
  }

  await disconnect(conn);
}

async function cmdStarred(options: CliOptions) {
  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const threads = await listStarred(conn, options.limit);

  if (options.json) {
    console.log(JSON.stringify(threads, null, 2));
  } else {
    if (threads.length === 0) {
      info("No starred threads");
    } else {
      console.log(`${colors.bold}Starred threads:${colors.reset}\n`);
      for (const thread of threads) {
        console.log(`  ${thread.id}`);
      }
    }
  }

  await disconnect(conn);
}

async function cmdSnooze(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman snooze <thread-id> [thread-id...] --until <time>`);
    process.exit(1);
  }

  if (!options.snoozeUntil) {
    error("Snooze time is required (--until)");
    console.log(`Usage: superhuman snooze <thread-id> --until <time>`);
    console.log(`  Presets: tomorrow, next-week, weekend, evening`);
    console.log(`  Or use ISO datetime: 2024-02-15T14:00:00Z`);
    process.exit(1);
  }

  let snoozeTime: Date;
  try {
    snoozeTime = parseSnoozeTime(options.snoozeUntil);
  } catch (e) {
    error(`Invalid snooze time: ${options.snoozeUntil}`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await snoozeThread(conn, threadId, snoozeTime);
    if (result.success) {
      success(`Snoozed thread: ${threadId} until ${snoozeTime.toLocaleString()}`);
      successCount++;
    } else {
      error(`Failed to snooze thread: ${threadId}${result.error ? ` (${result.error})` : ""}`);
      failCount++;
    }
  }

  if (options.threadIds.length > 1) {
    log(`\n${successCount} snoozed, ${failCount} failed`);
  }

  await disconnect(conn);
}

async function cmdUnsnooze(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman unsnooze <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await unsnoozeThread(conn, threadId);
    if (result.success) {
      success(`Unsnoozed thread: ${threadId}`);
      successCount++;
    } else {
      error(`Failed to unsnooze thread: ${threadId}${result.error ? ` (${result.error})` : ""}`);
      failCount++;
    }
  }

  if (options.threadIds.length > 1) {
    log(`\n${successCount} unsnoozed, ${failCount} failed`);
  }

  await disconnect(conn);
}

async function cmdSnoozed(options: CliOptions) {
  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const threads = await listSnoozed(conn, options.limit);

  if (options.json) {
    console.log(JSON.stringify(threads, null, 2));
  } else {
    if (threads.length === 0) {
      info("No snoozed threads");
    } else {
      console.log(`${colors.bold}Snoozed threads:${colors.reset}\n`);
      for (const thread of threads) {
        const untilStr = thread.snoozeUntil
          ? ` (until ${new Date(thread.snoozeUntil).toLocaleString()})`
          : "";
        console.log(`  ${thread.id}${untilStr}`);
      }
    }
  }

  await disconnect(conn);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function cmdAttachments(options: CliOptions) {
  if (!options.threadId) {
    error("Thread ID is required");
    console.log(`Usage: superhuman attachments <thread-id>`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const attachments = await listAttachments(conn, options.threadId);

  if (options.json) {
    console.log(JSON.stringify(attachments, null, 2));
  } else {
    if (attachments.length === 0) {
      info("No attachments in this thread");
    } else {
      console.log(`${colors.bold}Attachments:${colors.reset}\n`);
      for (const att of attachments) {
        console.log(`  ${colors.cyan}${att.name}${colors.reset}`);
        console.log(`    ${colors.dim}Type: ${att.mimeType}${colors.reset}`);
        console.log(`    ${colors.dim}Attachment ID: ${att.attachmentId}${colors.reset}`);
        console.log(`    ${colors.dim}Message ID: ${att.messageId}${colors.reset}`);
      }
    }
  }

  await disconnect(conn);
}

async function cmdDownload(options: CliOptions) {
  // Mode 1: Download specific attachment with --attachment and --message
  if (options.attachmentId) {
    if (!options.messageId) {
      error("Message ID is required when using --attachment");
      console.log(`Usage: superhuman download --attachment <attachment-id> --message <message-id> --output <path>`);
      process.exit(1);
    }

    const conn = await checkConnection(options.port);
    if (!conn) {
      process.exit(1);
    }

    try {
      info(`Downloading attachment ${options.attachmentId}...`);
      const content = await downloadAttachment(conn, options.messageId, options.attachmentId);
      const outputPath = options.outputPath || `attachment-${options.attachmentId}`;
      await Bun.write(outputPath, Buffer.from(content.data, "base64"));
      success(`Downloaded: ${outputPath} (${formatFileSize(content.size)})`);
    } catch (e) {
      error(`Failed to download: ${(e as Error).message}`);
    }

    await disconnect(conn);
    return;
  }

  // Mode 2: Download all attachments from a thread
  if (!options.threadId) {
    error("Thread ID is required, or use --attachment with --message");
    console.log(`Usage: superhuman download <thread-id> [--output <dir>]`);
    console.log(`       superhuman download --attachment <id> --message <id> --output <path>`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const attachments = await listAttachments(conn, options.threadId);

  if (attachments.length === 0) {
    info("No attachments in this thread");
    await disconnect(conn);
    return;
  }

  const outputDir = options.outputPath || ".";
  let successCount = 0;
  let failCount = 0;

  for (const att of attachments) {
    try {
      info(`Downloading ${att.name}...`);
      const content = await downloadAttachment(
        conn,
        att.messageId,
        att.attachmentId,
        att.threadId,
        att.mimeType
      );
      const outputPath = `${outputDir}/${att.name}`;
      await Bun.write(outputPath, Buffer.from(content.data, "base64"));
      success(`Downloaded: ${outputPath} (${formatFileSize(content.size)})`);
      successCount++;
    } catch (e) {
      error(`Failed to download ${att.name}: ${(e as Error).message}`);
      failCount++;
    }
  }

  if (attachments.length > 1) {
    log(`\n${successCount} downloaded, ${failCount} failed`);
  }

  await disconnect(conn);
}

async function cmdAccounts(options: CliOptions) {
  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const accounts = await listAccounts(conn);

  if (options.json) {
    console.log(formatAccountsJson(accounts));
  } else {
    if (accounts.length === 0) {
      info("No linked accounts found");
    } else {
      console.log(formatAccountsList(accounts));
    }
  }

  await disconnect(conn);
}

async function cmdAccount(options: CliOptions) {
  if (!options.accountArg) {
    error("Account index or email is required");
    console.log(`Usage: superhuman account <index|email>`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const accounts = await listAccounts(conn);

  // Determine target email: either by index (1-based) or by email
  let targetEmail: string | undefined;

  const indexMatch = options.accountArg.match(/^\d+$/);
  if (indexMatch) {
    const index = parseInt(options.accountArg, 10);
    if (index < 1 || index > accounts.length) {
      error(`Invalid account index: ${index}. Valid range: 1-${accounts.length}`);
      await disconnect(conn);
      process.exit(1);
    }
    targetEmail = accounts[index - 1].email;
  } else {
    // Treat as email
    const found = accounts.find(
      (a) => a.email.toLowerCase() === options.accountArg.toLowerCase()
    );
    if (!found) {
      error(`Account not found: ${options.accountArg}`);
      info("Available accounts:");
      console.log(formatAccountsList(accounts));
      await disconnect(conn);
      process.exit(1);
    }
    targetEmail = found.email;
  }

  // Check if already on this account
  const currentAccount = accounts.find((a) => a.isCurrent);
  if (currentAccount && currentAccount.email === targetEmail) {
    info(`Already on account: ${targetEmail}`);
    await disconnect(conn);
    return;
  }

  // Switch to the target account
  const result = await switchAccount(conn, targetEmail);

  if (result.success) {
    success(`Switched to ${result.email}`);
  } else {
    error(`Failed to switch to ${targetEmail}`);
    if (result.email) {
      info(`Current account: ${result.email}`);
    }
  }

  await disconnect(conn);
}

/**
 * Parse a date string into a Date object
 * Supports: "today", "tomorrow", ISO date (YYYY-MM-DD), or any Date.parse-able string
 */
function parseCalendarDate(dateStr: string): Date {
  const now = new Date();
  const lowerDate = dateStr.toLowerCase();

  if (lowerDate === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (lowerDate === "tomorrow") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  }

  // Try parsing as-is
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  throw new Error(`Invalid date: ${dateStr}`);
}

/**
 * Parse a time string into a Date object
 * Supports: ISO datetime, or simple times like "2pm", "14:00", "tomorrow 3pm"
 */
function parseEventTime(timeStr: string): Date {
  const now = new Date();

  // Try ISO format first
  const iso = new Date(timeStr);
  if (!isNaN(iso.getTime())) {
    return iso;
  }

  // Simple time patterns
  const lowerTime = timeStr.toLowerCase();

  // Check for "tomorrow" prefix
  let baseDate = now;
  let timePart = lowerTime;
  if (lowerTime.startsWith("tomorrow")) {
    baseDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    timePart = lowerTime.replace("tomorrow", "").trim();
  }

  // Parse time like "2pm", "14:00", "3:30pm"
  const timeMatch = timePart.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = timeMatch[3]?.toLowerCase();

    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;

    return new Date(
      baseDate.getFullYear(),
      baseDate.getMonth(),
      baseDate.getDate(),
      hours,
      minutes
    );
  }

  throw new Error(`Invalid time: ${timeStr}`);
}

/**
 * Format a calendar event for display
 */
function formatCalendarEvent(event: CalendarEvent & { account?: string }, showAccount = false): string {
  const lines: string[] = [];

  // Time
  let timeStr = "";
  if (event.allDay || event.start.date) {
    timeStr = "All Day";
  } else if (event.start.dateTime) {
    const start = new Date(event.start.dateTime);
    const end = event.end.dateTime ? new Date(event.end.dateTime) : null;
    timeStr = start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (end) {
      timeStr += ` - ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    }
  }

  // Account indicator (shortened)
  let accountTag = "";
  if (showAccount && event.account) {
    const shortAccount = event.account.split("@")[0].slice(0, 8);
    accountTag = ` ${colors.magenta}[${shortAccount}]${colors.reset}`;
  }

  lines.push(`${colors.cyan}${timeStr}${colors.reset} ${colors.bold}${event.summary || "(No title)"}${colors.reset}${accountTag}`);

  if (event.description) {
    lines.push(`  ${colors.dim}${event.description.substring(0, 80)}${event.description.length > 80 ? "..." : ""}${colors.reset}`);
  }

  if (event.attendees && event.attendees.length > 0) {
    const attendeeStr = event.attendees.map(a => a.email).slice(0, 3).join(", ");
    const more = event.attendees.length > 3 ? ` +${event.attendees.length - 3} more` : "";
    lines.push(`  ${colors.dim}With: ${attendeeStr}${more}${colors.reset}`);
  }

  lines.push(`  ${colors.dim}ID: ${event.id}${colors.reset}`);

  return lines.join("\n");
}

/**
 * Resolve a calendar name or ID to a calendar ID
 */
async function resolveCalendarId(conn: SuperhumanConnection, arg: string): Promise<string | null> {
  if (!arg) return null;

  const result = await conn.Runtime.evaluate({
    expression: `
      (async () => {
        try {
          const arg = ${JSON.stringify(arg)};
          const ga = window.GoogleAccount;
          const di = ga?.di;
          const accountEmail = ga?.emailAddress;
          const isMicrosoft = di.get?.('isMicrosoft');

          if (isMicrosoft) {
            const msgraph = di.get?.('msgraph');
            const calendars = await msgraph.getCalendars(accountEmail);
            const found = calendars?.find(c => 
              c.id === arg || 
              c.name?.toLowerCase() === arg.toLowerCase() ||
              c.displayName?.toLowerCase() === arg.toLowerCase()
            );
            return found?.id || arg;
          } else {
            const gcal = di.get?.('gcal');
            const list = await gcal._getAsync(
              'https://www.googleapis.com/calendar/v3/users/me/calendarList',
              {},
              { calendarAccountEmail: accountEmail, endpoint: 'gcal.calendarList.list', allowCachedResponses: true }
            );
            const found = list?.items?.find(c => 
              c.id === arg || 
              c.summary?.toLowerCase() === arg.toLowerCase() ||
              c.summaryOverride?.toLowerCase() === arg.toLowerCase()
            );
            return found?.id || arg;
          }
        } catch (e) {
          return null;
        }
      })()
    `,
    returnByValue: true,
    awaitPromise: true
  });

  return result.result.value as string | null;
}

async function cmdCalendar(options: CliOptions) {
  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  // Parse date range
  let timeMin: Date;
  let timeMax: Date;

  if (options.calendarDate) {
    timeMin = parseCalendarDate(options.calendarDate);
  } else {
    timeMin = new Date();
    timeMin.setHours(0, 0, 0, 0);
  }

  timeMax = new Date(timeMin);
  timeMax.setDate(timeMax.getDate() + options.calendarRange);
  timeMax.setHours(23, 59, 59, 999);

  // Resolve calendar ID if provided
  const calendarId = await resolveCalendarId(conn, options.calendarArg);

  let allEvents: CalendarEvent[] = [];

  if (options.allAccounts) {
    // Get all accounts and query each
    const accounts = await listAccounts(conn);
    const originalAccount = accounts.find(a => a.current)?.email;

    for (const account of accounts) {
      // Switch to this account
      await switchAccount(conn, account.email);
      // Small delay for account switch to take effect
      await new Promise(r => setTimeout(r, 300));

      const events = await listEvents(conn, { timeMin, timeMax });
      // Tag events with account info
      for (const event of events) {
        (event as CalendarEvent & { account?: string }).account = account.email;
      }
      allEvents.push(...events);
    }

    // Switch back to original account
    if (originalAccount) {
      await switchAccount(conn, originalAccount);
    }
  } else {
    allEvents = await listEvents(conn, { timeMin, timeMax, calendarId: calendarId || undefined });
  }

  // Sort all events by start time
  allEvents.sort((a, b) => {
    const aTime = a.start.dateTime || a.start.date || "";
    const bTime = b.start.dateTime || b.start.date || "";
    return aTime.localeCompare(bTime);
  });

  if (options.json) {
    console.log(JSON.stringify(allEvents, null, 2));
  } else {
    if (allEvents.length === 0) {
      info("No events found for the specified date range");
    } else {
      // Group events by date
      const byDate = new Map<string, CalendarEvent[]>();
      for (const event of allEvents) {
        const dateStr = event.start.date || (event.start.dateTime ? new Date(event.start.dateTime).toDateString() : "Unknown");
        if (!byDate.has(dateStr)) {
          byDate.set(dateStr, []);
        }
        byDate.get(dateStr)!.push(event);
      }

      for (const [date, dayEvents] of byDate) {
        console.log(`\n${colors.bold}${date}${colors.reset}`);
        for (const event of dayEvents) {
          console.log(formatCalendarEvent(event, options.allAccounts));
        }
      }
    }
  }

  await disconnect(conn);
}

async function cmdCalendarCreate(options: CliOptions) {
  if (!options.eventTitle && !options.subject) {
    error("Event title is required (--title)");
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const title = options.eventTitle || options.subject;
  let startTime: Date;
  let endTime: Date;

  // Resolve calendar ID if provided
  const calendarId = await resolveCalendarId(conn, options.calendarArg);

  // Determine if this is an all-day event
  const isAllDay = options.calendarDate && !options.eventStart;

  if (isAllDay) {
    startTime = parseCalendarDate(options.calendarDate);
    endTime = new Date(startTime);
    endTime.setDate(endTime.getDate() + 1);
  } else {
    if (!options.eventStart) {
      error("Event start time is required (--start) or use --date for all-day event");
      await disconnect(conn);
      process.exit(1);
    }

    startTime = parseEventTime(options.eventStart);

    if (options.eventEnd) {
      endTime = parseEventTime(options.eventEnd);
    } else {
      endTime = new Date(startTime.getTime() + options.eventDuration * 60 * 1000);
    }
  }

  const eventInput: CreateEventInput = {
    calendarId: calendarId || undefined,
    summary: title,
    description: options.body || undefined,
    start: isAllDay
      ? { date: startTime.toISOString().split("T")[0] }
      : { dateTime: startTime.toISOString() },
    end: isAllDay
      ? { date: endTime.toISOString().split("T")[0] }
      : { dateTime: endTime.toISOString() },
  };

  // Add attendees from --to option (resolve names to emails)
  if (options.to.length > 0) {
    const resolvedAttendees = await resolveAllRecipients(conn, options.to);
    eventInput.attendees = resolvedAttendees.map(email => ({ email }));
  }

  const result = await createEvent(conn, eventInput);

  if (result.success) {
    success(`Event created: ${result.eventId}`);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    }
  } else {
    error(`Failed to create event: ${result.error}`);
    if (result.error?.includes("no-auth")) {
      info("Calendar write access may not be authorized in Superhuman");
    }
  }

  await disconnect(conn);
}

async function cmdCalendarUpdate(options: CliOptions) {
  if (!options.eventId) {
    error("Event ID is required (--event)");
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const updates: UpdateEventInput = {};

  if (options.eventTitle || options.subject) {
    updates.summary = options.eventTitle || options.subject;
  }
  if (options.body) {
    updates.description = options.body;
  }
  if (options.eventStart) {
    const startTime = parseEventTime(options.eventStart);
    updates.start = { dateTime: startTime.toISOString() };

    // Also update end if not specified
    if (!options.eventEnd) {
      const endTime = new Date(startTime.getTime() + options.eventDuration * 60 * 1000);
      updates.end = { dateTime: endTime.toISOString() };
    }
  }
  if (options.eventEnd) {
    const endTime = parseEventTime(options.eventEnd);
    updates.end = { dateTime: endTime.toISOString() };
  }
  if (options.to.length > 0) {
    const resolvedAttendees = await resolveAllRecipients(conn, options.to);
    updates.attendees = resolvedAttendees.map(email => ({ email }));
  }

  if (Object.keys(updates).length === 0) {
    error("No updates specified. Use --title, --start, --end, --body, or --to");
    await disconnect(conn);
    process.exit(1);
  }

  const result = await updateEvent(conn, options.eventId, updates);

  if (result.success) {
    success(`Event updated: ${result.eventId}`);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    }
  } else {
    error(`Failed to update event: ${result.error}`);
    if (result.error?.includes("no-auth")) {
      info("Calendar write access may not be authorized in Superhuman");
    }
  }

  await disconnect(conn);
}

async function cmdCalendarDelete(options: CliOptions) {
  if (!options.eventId) {
    error("Event ID is required (--event)");
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const result = await deleteCalendarEvent(conn, options.eventId);

  if (result.success) {
    success(`Event deleted: ${options.eventId}`);
  } else {
    error(`Failed to delete event: ${result.error}`);
    if (result.error?.includes("no-auth")) {
      info("Calendar write access may not be authorized in Superhuman");
    }
  }

  await disconnect(conn);
}

/**
 * Format a contact for display in RFC 5322 style: "Name <email>"
 */
function formatContact(contact: Contact): string {
  if (contact.name) {
    return `${contact.name} <${contact.email}>`;
  }
  return contact.email;
}

async function cmdContacts(options: CliOptions) {
  if (options.contactsSubcommand !== "search") {
    error("Unknown contacts subcommand: " + (options.contactsSubcommand || "(none)"));
    console.log(`Usage: superhuman contacts search <query>`);
    process.exit(1);
  }

  if (!options.contactsQuery) {
    error("Search query is required");
    console.log(`Usage: superhuman contacts search <query>`);
    process.exit(1);
  }

  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  const contacts = await searchContacts(conn, options.contactsQuery, { limit: options.limit });

  if (options.json) {
    console.log(JSON.stringify(contacts, null, 2));
  } else {
    if (contacts.length === 0) {
      info(`No contacts found for "${options.contactsQuery}"`);
    } else {
      for (const contact of contacts) {
        console.log(formatContact(contact));
      }
    }
  }

  await disconnect(conn);
}

async function cmdCalendarFree(options: CliOptions) {
  const conn = await checkConnection(options.port);
  if (!conn) {
    process.exit(1);
  }

  // Parse date range
  let timeMin: Date;
  let timeMax: Date;

  if (options.calendarDate) {
    timeMin = parseCalendarDate(options.calendarDate);
  } else {
    timeMin = new Date();
  }

  timeMax = new Date(timeMin);
  timeMax.setDate(timeMax.getDate() + options.calendarRange);

  const result = await getFreeBusy(conn, { timeMin, timeMax });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.busy.length === 0) {
      success("You are free for the specified time range!");
    } else {
      console.log(`\n${colors.bold}Busy times:${colors.reset}`);
      for (const slot of result.busy) {
        const start = new Date(slot.start);
        const end = new Date(slot.end);
        console.log(`  ${colors.red}●${colors.reset} ${start.toLocaleString()} - ${end.toLocaleTimeString()}`);
      }
    }
  }

  await disconnect(conn);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const options = parseArgs(args);

  switch (options.command) {
    case "help":
    case "":
      printHelp();
      break;

    case "status":
      await cmdStatus(options);
      break;

    case "accounts":
      await cmdAccounts(options);
      break;

    case "account":
      await cmdAccount(options);
      break;

    case "inbox":
      await cmdInbox(options);
      break;

    case "search":
      await cmdSearch(options);
      break;

    case "read":
      await cmdRead(options);
      break;

    case "reply":
      await cmdReply(options);
      break;

    case "reply-all":
      await cmdReplyAll(options);
      break;

    case "forward":
      await cmdForward(options);
      break;

    case "archive":
      await cmdArchive(options);
      break;

    case "delete":
      await cmdDelete(options);
      break;

    case "mark-read":
      await cmdMarkRead(options);
      break;

    case "mark-unread":
      await cmdMarkUnread(options);
      break;

    case "labels":
      await cmdLabels(options);
      break;

    case "get-labels":
      await cmdGetLabels(options);
      break;

    case "add-label":
      await cmdAddLabel(options);
      break;

    case "remove-label":
      await cmdRemoveLabel(options);
      break;

    case "star":
      await cmdStar(options);
      break;

    case "unstar":
      await cmdUnstar(options);
      break;

    case "starred":
      await cmdStarred(options);
      break;

    case "snooze":
      await cmdSnooze(options);
      break;

    case "unsnooze":
      await cmdUnsnooze(options);
      break;

    case "snoozed":
      await cmdSnoozed(options);
      break;

    case "attachments":
      await cmdAttachments(options);
      break;

    case "download":
      await cmdDownload(options);
      break;

    case "calendar":
      await cmdCalendar(options);
      break;

    case "calendar-create":
      await cmdCalendarCreate(options);
      break;

    case "calendar-update":
      await cmdCalendarUpdate(options);
      break;

    case "calendar-delete":
      await cmdCalendarDelete(options);
      break;

    case "calendar-free":
      await cmdCalendarFree(options);
      break;

    case "contacts":
      await cmdContacts(options);
      break;

    case "compose":
      await cmdCompose(options, true);
      log(`\n${colors.dim}Compose window left open for editing${colors.reset}`);
      break;

    case "draft":
      await cmdDraft(options);
      break;

    case "delete-draft":
      await cmdDeleteDraft(options);
      break;

    case "send":
      await cmdSend(options);
      break;

    default:
      error(`Unknown command: ${options.command}`);
      printHelp();
      process.exit(1);
  }
}

// Only run main when executed directly (not when imported for testing)
if (import.meta.main) {
  main().catch((e) => {
    error(`Fatal error: ${e.message}`);
    process.exit(1);
  });
}
