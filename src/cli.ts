#!/usr/bin/env bun
/**
 * Superhuman CLI
 *
 * Command-line interface for composing and sending emails via Superhuman.
 *
 * Usage:
 *   superhuman send --to <email> --subject <subject> --body <body>
 *   superhuman draft --to <email> --subject <subject> --body <body>
 *   superhuman status
 */

import {
  connectToSuperhuman,
  disconnect,
  disconnectChrome,
  connectToSuperhumanChrome,
  textToHtml,
  unescapeString,
  type SuperhumanConnection,
} from "./superhuman-api";
import { listInbox, searchInbox } from "./inbox";
import { listAccounts, listAccountsChrome, switchAccount, type Account } from "./accounts";
import { replyToThread, replyAllToThread, forwardThread } from "./reply";
import { archiveThread, deleteThread } from "./archive";
import { markAsRead, markAsUnread } from "./read-status";
import { listLabels, getThreadLabels, addLabel, removeLabel, starThread, unstarThread, listStarred } from "./labels";
import { parseSnoozeTime, snoozeThreadViaProvider, unsnoozeThreadViaProvider, listSnoozedViaProvider } from "./snooze";
import { listAttachments, downloadAttachment } from "./attachments";
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
import { sendEmailViaProvider, createDraftViaProvider, updateDraftViaProvider, sendDraftByIdViaProvider, deleteDraftViaProvider } from "./send-api";
import { createDraftWithUserInfo, getUserInfo, getUserInfoFromCache, sendDraftSuperhuman, updateDraftWithUserInfo, deleteDraftWithUserInfo, type Recipient, type UserInfo } from "./draft-api";
import { searchContacts, resolveRecipient, type Contact } from "./contacts";
import { listSnippets, findSnippet, applyVars, parseVars } from "./snippets";
import {
  getToken,
  saveTokensToDisk,
  loadTokensFromDisk,
  hasValidCachedTokens,
  getTokensFilePath,
  extractSuperhumanToken,
  askAI,
  askAISearch,
  getCachedToken,
  getCachedAccounts,
  hasCachedSuperhumanCredentials,
  getThreadInfoDirect,
  sendEmailDirect,
  getThreadMessages,
  listDraftsDirect,
  extractTokenChrome,
  type TokenInfo,
} from "./token-api";
import type { ConnectionProvider } from "./connection-provider";
import { CachedTokenProvider, CDPConnectionProvider, resolveProvider } from "./connection-provider";
import { DraftService, type Draft } from "./services/draft-service";
import { GmailDraftProvider } from "./providers/gmail-draft-provider";
import { OutlookDraftProvider } from "./providers/outlook-draft-provider";
import { SuperhumanDraftProvider } from "./providers/superhuman-draft-provider";

const VERSION = "0.13.0";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9400", 10);

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

function warn(message: string) {
  console.log(`${colors.yellow}⚠${colors.reset} ${message}`);
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
  superhuman <command> [subcommand] [options]

${colors.bold}COMMANDS${colors.reset}
  ${colors.cyan}inbox${colors.reset}              List recent emails from inbox
  ${colors.cyan}search${colors.reset} <query>      Search emails
  ${colors.cyan}read${colors.reset} <id>           Read a specific email thread (requires --account)
  ${colors.cyan}reply${colors.reset} <id>          Reply to an email thread
  ${colors.cyan}reply-all${colors.reset} <id>      Reply-all to an email thread
  ${colors.cyan}forward${colors.reset} <id>        Forward an email thread
  ${colors.cyan}archive${colors.reset} <id>        Archive email thread(s)
  ${colors.cyan}delete${colors.reset} <id>         Delete (trash) email thread(s)
  ${colors.cyan}send${colors.reset}                Compose and send, or send an existing draft
  ${colors.cyan}ai${colors.reset} <query>          Ask AI to search, compose, or answer questions
  ${colors.cyan}ai${colors.reset} <id> <query>     Ask AI about a specific email thread
  ${colors.cyan}status${colors.reset}              Check Superhuman connection status
  ${colors.cyan}help${colors.reset}                Show this help message

${colors.bold}SUBCOMMAND GROUPS${colors.reset}
  ${colors.cyan}account${colors.reset}  list | switch <email|index> | auth
  ${colors.cyan}calendar${colors.reset} list | create | update | delete | free
  ${colors.cyan}draft${colors.reset}    list | create | update <id> | delete <id> | send <id>
  ${colors.cyan}label${colors.reset}    list | get <id> | add <id> | remove <id>
  ${colors.cyan}mark${colors.reset}     read <id> | unread <id>
  ${colors.cyan}star${colors.reset}     add <id> | remove <id> | list
  ${colors.cyan}snooze${colors.reset}   set <id> --until <time> | cancel <id> | list
  ${colors.cyan}attachment${colors.reset} list <id> | download <id>
  ${colors.cyan}snippet${colors.reset}  list | use <name>
  ${colors.cyan}contact${colors.reset}  search <query>

${colors.bold}OPTIONS${colors.reset}
  ${colors.cyan}--account <email>${colors.reset}  Account to operate on (default: current)
  --to <email|name>  Recipient email or name (names are resolved via contact search)
  --cc <email|name>  CC recipient (can be used multiple times)
  --bcc <email|name> BCC recipient (can be used multiple times)
  --subject <text>   Email subject
  --body <text>      Email body (plain text, converted to HTML)
  --html <text>      Email body as HTML
  --send             Send immediately instead of saving as draft (for reply/reply-all/forward)
  --vars <pairs>     Template variable substitution: "key1=val1,key2=val2" (for snippet use)
  --provider <type>  Draft API: "superhuman" (default), "gmail", or "outlook"
  --native           Use native Superhuman API for draft update (auto-detected for draft00... IDs)
  --draft <id>       Draft ID to send (for send command)
  --thread <id>      Thread ID for reply/forward drafts (for draft send)
  --delay <seconds>  Delay before sending in seconds (for draft send, default: 20)
  --label <id>       Label ID (for label add/remove)
  --until <time>     Snooze until: preset (tomorrow, next-week, weekend, evening) or ISO datetime
  --output <path>    Output directory or file path (for attachment download)
  --attachment <id>  Specific attachment ID (for attachment download)
  --message <id>     Message ID (required with --attachment)
  --limit <number>   Number of results (default: 10, for inbox/search)
  --include-done     Search all emails including archived/done (uses Gmail API directly)
  --context <number> Number of messages to show full body (default: all, for read)
  --json             Output as JSON
  --date <date>      Date for calendar (YYYY-MM-DD or "today", "tomorrow")
  --calendar <name>  Calendar name or ID (default: primary)
  --range <days>     Days to show for calendar (default: 1)
  --start <time>     Event start time (ISO datetime or natural: "2pm", "tomorrow 3pm")
  --end <time>       Event end time (ISO datetime, optional if --duration)
  --duration <mins>  Event duration in minutes (default: 30)
  --title <text>     Event title (for calendar create/update)
  --event <id>       Event ID (for calendar update/delete)
  --port <number>    CDP port (default: ${CDP_PORT})

${colors.bold}EXAMPLES${colors.reset}
  ${colors.dim}# Account management${colors.reset}
  superhuman account auth
  superhuman account list
  superhuman account list --json
  superhuman account switch 2
  superhuman account switch user@example.com

  ${colors.dim}# List recent emails${colors.reset}
  superhuman inbox
  superhuman inbox --limit 5 --json

  ${colors.dim}# Search emails${colors.reset}
  superhuman search "from:john subject:meeting"
  superhuman search "project update" --limit 20
  superhuman search "from:anthropic" --include-done

  ${colors.dim}# Read an email thread${colors.reset}
  superhuman read <thread-id> --account user@example.com
  superhuman read <thread-id> --account user@example.com --context 3
  superhuman read <thread-id> --account user@example.com --json

  ${colors.dim}# Reply to an email${colors.reset}
  superhuman reply <thread-id> --body "Thanks for the update!"
  superhuman reply <thread-id> --body "Got it!" --send

  ${colors.dim}# Reply-all / Forward${colors.reset}
  superhuman reply-all <thread-id> --body "Thanks everyone!"
  superhuman forward <thread-id> --to colleague@example.com --body "FYI" --send

  ${colors.dim}# Archive / Delete${colors.reset}
  superhuman archive <thread-id>
  superhuman delete <thread-id1> <thread-id2>

  ${colors.dim}# Mark as read/unread${colors.reset}
  superhuman mark read <thread-id>
  superhuman mark unread <thread-id1> <thread-id2>

  ${colors.dim}# Labels${colors.reset}
  superhuman label list
  superhuman label list --json
  superhuman label get <thread-id>
  superhuman label add <thread-id> --label Label_123
  superhuman label remove <thread-id> --label Label_123

  ${colors.dim}# Star / Unstar${colors.reset}
  superhuman star add <thread-id>
  superhuman star add <thread-id1> <thread-id2>
  superhuman star remove <thread-id>
  superhuman star list
  superhuman star list --json

  ${colors.dim}# Snooze / Unsnooze${colors.reset}
  superhuman snooze set <thread-id> --until tomorrow
  superhuman snooze set <thread-id> --until "2024-02-15T14:00:00Z"
  superhuman snooze cancel <thread-id>
  superhuman snooze list
  superhuman snooze list --json

  ${colors.dim}# Attachments${colors.reset}
  superhuman attachment list <thread-id>
  superhuman attachment list <thread-id> --json
  superhuman attachment download <thread-id>
  superhuman attachment download <thread-id> --output ./downloads
  superhuman attachment download --attachment <attachment-id> --message <message-id> --output ./file.pdf

  ${colors.dim}# Calendar${colors.reset}
  superhuman calendar list
  superhuman calendar list --date tomorrow --range 7 --json
  superhuman calendar create --title "Meeting" --start "2pm" --duration 30
  superhuman calendar create --title "All Day" --date 2026-02-05
  superhuman calendar update --event <event-id> --title "New Title"
  superhuman calendar delete --event <event-id>
  superhuman calendar free
  superhuman calendar free --date tomorrow --range 7

  ${colors.dim}# Contacts${colors.reset}
  superhuman contact search "john"
  superhuman contact search "john" --limit 5 --json

  ${colors.dim}# Snippets${colors.reset}
  superhuman snippet list
  superhuman snippet list --json
  superhuman snippet use "zoom link" --to user@example.com
  superhuman snippet use "share recordings" --to user@example.com --vars "date=Feb 5,student_name=Jane"
  superhuman snippet use "share recordings" --to user@example.com --vars "date=Feb 5" --send

  ${colors.dim}# Ask AI (search, compose, or ask about a thread)${colors.reset}
  superhuman ai "find emails about the Stanford cover letter"
  superhuman ai "what did John say about the deadline?"
  superhuman ai "Write an email inviting the team to a meeting"
  superhuman ai <thread-id> "summarize this thread"
  superhuman ai <thread-id> "what are the action items?"

  ${colors.dim}# Drafts${colors.reset}
  superhuman draft list [--limit N] [--offset N] [--account EMAIL]
  superhuman draft create --to user@example.com --subject "Hello" --body "Hi there!"
  superhuman draft create --provider=gmail --to user@example.com --subject "Hello" --body "Hi there!"
  superhuman draft update <draft-id> --body "Updated content"
  superhuman draft update <draft-id> --subject "New Subject" --to new@example.com
  superhuman draft update draft00abc --native --subject "New" ${colors.dim}# Native Superhuman draft${colors.reset}
  superhuman draft delete <draft-id>
  superhuman draft delete <draft-id1> <draft-id2> ${colors.dim}# Auto-detects native vs provider drafts${colors.reset}
  superhuman draft send <draft-id> --account=user@example.com --to=recipient@example.com --subject="Subject" --body="Body"
  superhuman draft send <draft-id> --thread=<thread-id> --account=... ${colors.dim}# For reply/forward drafts${colors.reset}


  ${colors.dim}# Send an email immediately${colors.reset}
  superhuman send --to user@example.com --subject "Quick note" --body "FYI"

  ${colors.dim}# Send an existing draft by ID${colors.reset}
  superhuman send --draft <draft-id>

${colors.bold}REQUIREMENTS${colors.reset}
  Superhuman must be running with remote debugging enabled:
  ${colors.dim}/Applications/Superhuman.app/Contents/MacOS/Superhuman --remote-debugging-port=${CDP_PORT}${colors.reset}
`);
}

// Commands that use noun+verb subcommand groups (e.g., "calendar create", "draft delete")
const GROUPED_COMMANDS = new Set([
  "calendar", "draft", "label", "star", "snooze", "mark",
  "attachment", "snippet", "account", "contact",
]);

interface CliOptions {
  command: string;
  subcommand: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  html: string;
  port: number;
  // inbox/search/read options
  limit: number;
  offset: number;
  query: string;
  threadId: string;
  threadIds: string[]; // for bulk operations (archive/delete)
  draftIds: string[]; // for delete-draft
  json: boolean;
  // account selection
  account: string; // email of account to use (optional, defaults to current)
  // account switching
  accountArg: string; // index or email for account command
  // reply/forward options
  send: boolean; // send immediately instead of saving as draft
  // draft update option
  updateDraftId: string; // draft ID to update (for draft command)
  // send draft option
  sendDraftId: string; // draft ID to send (for send command)
  // send-draft command options
  sendDraftDraftId: string; // draft ID for send-draft command
  sendDraftThreadId: string; // thread ID for reply/forward drafts (optional)
  sendDraftDelay: number; // delay in seconds for send-draft command (default: 20)
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
  contactsQuery: string; // search query for contacts
  // search options
  includeDone: boolean; // use direct Gmail API to search all emails including archived
  // ai options
  aiQuery: string; // question to ask the AI
  // snippet options
  snippetQuery: string; // snippet name for fuzzy matching
  vars: string; // template variable substitution: "key1=val1,key2=val2"
  // read options
  context: number; // number of messages to show full body for (0 = all)
  // draft provider option
  provider: "superhuman" | "gmail" | "outlook"; // which API to use for drafts (default: superhuman)
  // native draft flag
  native: boolean; // use native Superhuman draft operations (for update/delete)
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    command: "",
    subcommand: "",
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    html: "",
    port: CDP_PORT,
    limit: 10,
    offset: 0,
    query: "",
    threadId: "",
    threadIds: [],
    draftIds: [],
    json: false,
    account: "",
    accountArg: "",
    send: false,
    updateDraftId: "",
    sendDraftId: "",
    sendDraftDraftId: "",
    sendDraftThreadId: "",
    sendDraftDelay: 20,
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
    contactsQuery: "",
    includeDone: false,
    aiQuery: "",
    snippetQuery: "",
    vars: "",
    context: 0,
    provider: "superhuman",
    native: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      // Support both --key value and --key=value formats
      let key: string;
      let value: string | undefined;
      let usedEqualsFormat = false;
      const equalIndex = arg.indexOf("=");
      if (equalIndex !== -1) {
        key = arg.slice(2, equalIndex);
        value = arg.slice(equalIndex + 1);
        usedEqualsFormat = true;
      } else {
        key = arg.slice(2);
        value = args[i + 1];
      }
      // Helper to increment by correct amount based on format
      const inc = usedEqualsFormat ? 1 : 2;

      switch (key) {
        case "to":
          options.to.push(unescapeString(value));
          i += inc;
          break;
        case "cc":
          options.cc.push(unescapeString(value));
          i += inc;
          break;
        case "bcc":
          options.bcc.push(unescapeString(value));
          i += inc;
          break;
        case "subject":
          options.subject = unescapeString(value);
          i += inc;
          break;
        case "body":
          options.body = unescapeString(value);
          i += inc;
          break;
        case "html":
          options.html = unescapeString(value);
          i += inc;
          break;
        case "port":
          options.port = parseInt(value, 10);
          i += inc;
          break;
        case "help":
          options.command = "help";
          i += 1;
          break;
        case "limit":
          options.limit = parseInt(value, 10);
          i += inc;
          break;
        case "offset":
          options.offset = parseInt(value, 10);
          i += inc;
          break;
        case "query":
          options.query = unescapeString(value);
          i += inc;
          break;
        case "thread":
          options.threadId = unescapeString(value);
          i += inc;
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
          i += inc;
          break;
        case "draft":
          options.sendDraftId = unescapeString(value);
          i += inc;
          break;
        case "label":
          options.labelId = unescapeString(value);
          i += inc;
          break;
        case "until":
          options.snoozeUntil = unescapeString(value);
          i += inc;
          break;
        case "output":
          options.outputPath = unescapeString(value);
          i += inc;
          break;
        case "attachment":
          options.attachmentId = unescapeString(value);
          i += inc;
          break;
        case "message":
          options.messageId = unescapeString(value);
          i += inc;
          break;
        case "calendar":
          options.calendarArg = unescapeString(value);
          i += inc;
          break;
        case "date":
          options.calendarDate = unescapeString(value);
          i += inc;
          break;
        case "range":
          options.calendarRange = parseInt(value, 10);
          i += inc;
          break;
        case "context":
          options.context = parseInt(value, 10);
          i += inc;
          break;
        case "all-accounts":
          options.allAccounts = true;
          i++;
          break;
        case "start":
          options.eventStart = unescapeString(value);
          i += inc;
          break;
        case "end":
          options.eventEnd = unescapeString(value);
          i += inc;
          break;
        case "duration":
          options.eventDuration = parseInt(value, 10);
          i += inc;
          break;
        case "title":
          options.eventTitle = unescapeString(value);
          i += inc;
          break;
        case "event":
          options.eventId = unescapeString(value);
          i += inc;
          break;
        case "account":
          options.account = unescapeString(value);
          i += inc;
          break;
        case "include-done":
          options.includeDone = true;
          i += 1;
          break;
        case "vars":
          options.vars = unescapeString(value);
          i += inc;
          break;
        case "provider":
          if (value === "superhuman" || value === "gmail" || value === "outlook") {
            options.provider = value;
          } else {
            error(`Invalid provider: ${value}. Use 'superhuman', 'gmail', or 'outlook'`);
            process.exit(1);
          }
          i += inc;
          break;
        case "delay":
          options.sendDraftDelay = parseInt(value, 10);
          i += inc;
          break;
        case "thread":
          options.sendDraftThreadId = unescapeString(value);
          i += inc;
          break;
        case "native":
          options.native = true;
          i += 1;
          break;
        default:
          error(`Unknown option: ${arg}`);
          process.exit(1);
      }
    } else if (!options.command) {
      options.command = arg;
      i += 1;
    } else if (GROUPED_COMMANDS.has(options.command) && !options.subcommand) {
      // Second positional arg for grouped commands is the subcommand
      options.subcommand = arg;
      i += 1;
    } else if (options.command === "search" && !options.query) {
      options.query = unescapeString(arg);
      i += 1;
    } else if (options.command === "read" && !options.threadId) {
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "reply" && !options.threadId) {
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "reply-all" && !options.threadId) {
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "forward" && !options.threadId) {
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "ai" && !options.aiQuery) {
      // ai command: first positional arg could be a thread-id or the query.
      // If we don't have a threadId yet, check if the arg looks like one:
      //   - Gmail thread IDs are hex strings (e.g., 19c2fbf72ffde347)
      //   - MS Graph conversationIds start with "AAQ"
      // If it matches a thread-id pattern, store as threadId and expect query next.
      // Otherwise, treat it as the query (compose mode, no thread context).
      if (!options.threadId && (/^[0-9a-f]{10,}$/i.test(arg) || arg.startsWith("AAQ"))) {
        options.threadId = unescapeString(arg);
      } else {
        options.aiQuery = unescapeString(arg);
      }
      i += 1;
    } else if (options.command === "archive" || options.command === "delete") {
      // Collect multiple thread IDs for bulk top-level operations
      options.threadIds.push(unescapeString(arg));
      i += 1;
    } else if (options.command === "account" && options.subcommand === "switch" && !options.accountArg) {
      // account switch <email|index>
      options.accountArg = unescapeString(arg);
      i += 1;
    } else if (options.command === "mark" && (options.subcommand === "read" || options.subcommand === "unread")) {
      // mark read/unread <thread-id> [thread-id...]
      options.threadIds.push(unescapeString(arg));
      i += 1;
    } else if (options.command === "label" && options.subcommand === "get" && !options.threadId) {
      // label get <thread-id>
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "label" && (options.subcommand === "add" || options.subcommand === "remove")) {
      // label add/remove <thread-id> [thread-id...]
      options.threadIds.push(unescapeString(arg));
      i += 1;
    } else if (options.command === "star" && (options.subcommand === "add" || options.subcommand === "remove")) {
      // star add/remove <thread-id> [thread-id...]
      options.threadIds.push(unescapeString(arg));
      i += 1;
    } else if (options.command === "snooze" && options.subcommand === "set") {
      // snooze set <thread-id> [thread-id...]
      options.threadIds.push(unescapeString(arg));
      i += 1;
    } else if (options.command === "snooze" && options.subcommand === "cancel") {
      // snooze cancel <thread-id> [thread-id...]
      options.threadIds.push(unescapeString(arg));
      i += 1;
    } else if (options.command === "attachment" && options.subcommand === "list" && !options.threadId) {
      // attachment list <thread-id>
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "attachment" && options.subcommand === "download" && !options.threadId && !options.attachmentId) {
      // attachment download <thread-id>
      options.threadId = unescapeString(arg);
      i += 1;
    } else if (options.command === "contact" && options.subcommand === "search" && !options.contactsQuery) {
      // contact search <query>
      options.contactsQuery = unescapeString(arg);
      i += 1;
    } else if (options.command === "snippet" && options.subcommand === "use" && !options.snippetQuery) {
      // snippet use <name>
      options.snippetQuery = unescapeString(arg);
      i += 1;
    } else if (options.command === "draft" && options.subcommand === "update" && !options.updateDraftId) {
      // draft update <draft-id>
      options.updateDraftId = unescapeString(arg);
      i += 1;
    } else if (options.command === "draft" && options.subcommand === "delete") {
      // draft delete <draft-id> [draft-id...]
      options.draftIds.push(unescapeString(arg));
      i += 1;
    } else if (options.command === "draft" && options.subcommand === "send" && !options.sendDraftDraftId) {
      // draft send <draft-id>
      options.sendDraftDraftId = unescapeString(arg);
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
 * Get a ConnectionProvider, preferring cached tokens over CDP.
 * Exits with error message if neither is available.
 */
async function getProvider(options: CliOptions): Promise<ConnectionProvider> {
  const provider = await resolveProvider({ account: options.account, port: options.port });
  if (provider) {
    return provider;
  }
  // No cached tokens — fall back to CDP
  const conn = await checkConnection(options.port);
  if (!conn) {
    error("No cached tokens and could not connect to Superhuman");
    info("Run 'superhuman account auth' to authenticate, or start Superhuman with:");
    info(`  /Applications/Superhuman.app/Contents/MacOS/Superhuman --remote-debugging-port=${options.port}`);
    process.exit(1);
  }
  return new CDPConnectionProvider(conn);
}

/**
 * Resolve all recipients via ConnectionProvider.
 * Names without @ are looked up in contacts; emails are passed through unchanged.
 */
async function resolveAllRecipientsViaProvider(
  provider: ConnectionProvider,
  recipients: string[]
): Promise<string[]> {
  const resolved: string[] = [];
  for (const recipient of recipients) {
    const email = await resolveRecipient(provider, recipient);
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

  await disconnect(conn);
}

/**
 * Resolve UserInfo for Superhuman backend API calls.
 * Tries cached credentials first (by --account, then any cached account), falls back to CDP.
 */
async function resolveBackendUserInfo(
  options: CliOptions
): Promise<{ userInfo: UserInfo; email: string }> {
  await loadTokensFromDisk();

  if (options.account && (await hasCachedSuperhumanCredentials(options.account))) {
    const token = await getCachedToken(options.account);
    if (token?.idToken && token?.userId) {
      return {
        userInfo: getUserInfoFromCache(token.userId, token.email, token.idToken),
        email: token.email,
      };
    }
  }

  const accounts = getCachedAccounts();
  for (const email of accounts) {
    if (await hasCachedSuperhumanCredentials(email)) {
      const token = await getCachedToken(email);
      if (token?.idToken && token?.userId) {
        return {
          userInfo: getUserInfoFromCache(token.userId, token.email, token.idToken),
          email: token.email,
        };
      }
    }
  }

  // Fall back to CDP
  const conn = await checkConnection(options.port);
  if (!conn) process.exit(1);
  const userInfo = await getUserInfo(conn);
  await disconnect(conn);
  return { userInfo, email: userInfo.email };
}

/**
 * Resolve a cached Superhuman token with idToken + userId.
 * Tries --account first, then any cached account with Superhuman credentials.
 * Returns null if no valid cached credentials found.
 */
async function resolveSuperhumanToken(account?: string): Promise<TokenInfo | null> {
  await loadTokensFromDisk();

  if (account && await hasCachedSuperhumanCredentials(account)) {
    const token = await getCachedToken(account);
    if (token?.idToken && token?.userId) return token;
  }

  const accounts = getCachedAccounts();
  for (const email of accounts) {
    if (await hasCachedSuperhumanCredentials(email)) {
      const token = await getCachedToken(email);
      if (token?.idToken && token?.userId) return token;
    }
  }

  return null;
}

async function cmdSnippets(options: CliOptions) {
  const { userInfo } = await resolveBackendUserInfo(options);
  const snippets = await listSnippets(userInfo);

  if (options.json) {
    console.log(JSON.stringify(snippets, null, 2));
  } else {
    if (snippets.length === 0) {
      info("No snippets found");
    } else {
      console.log(
        `${colors.dim}${"Name".padEnd(35)} ${"Sends".padEnd(7)} ${"Last Used".padEnd(12)}${colors.reset}`
      );
      console.log(colors.dim + "─".repeat(56) + colors.reset);

      for (const s of snippets) {
        const name = truncate(s.name, 34);
        const sends = String(s.sends).padEnd(7);
        const lastUsed = s.lastSentAt ? formatDate(s.lastSentAt) : "never";
        console.log(`${name.padEnd(35)} ${sends} ${lastUsed}`);
      }

      log(`\n${colors.dim}${snippets.length} snippet(s)${colors.reset}`);
    }
  }
}

async function cmdSnippet(options: CliOptions) {
  if (!options.snippetQuery) {
    error("Snippet name is required");
    console.log(`Usage: superhuman snippet use <name> [--to <email>] [--vars "key=val,..."] [--send]`);
    process.exit(1);
  }

  const { userInfo, email: accountEmail } = await resolveBackendUserInfo(options);

  // Fetch snippets and fuzzy match
  const snippets = await listSnippets(userInfo);
  const snippet = findSnippet(snippets, options.snippetQuery);

  if (!snippet) {
    error(`No snippet matching "${options.snippetQuery}"`);
    if (snippets.length > 0) {
      log(`\n${colors.dim}Available snippets:${colors.reset}`);
      for (const s of snippets) {
        log(`  - ${s.name}`);
      }
    }
    process.exit(1);
  }

  info(`Using snippet: ${snippet.name}`);

  // Apply template variables
  const vars = options.vars ? parseVars(options.vars) : {};
  let body = snippet.body;
  let subject = snippet.subject;
  if (Object.keys(vars).length > 0) {
    body = applyVars(body, vars);
    subject = applyVars(subject, vars);
    info(`Applied variables: ${Object.keys(vars).join(", ")}`);
  }

  // Merge recipients: CLI args override/extend snippet defaults
  const to = options.to.length > 0 ? options.to : snippet.to;
  const cc = options.cc.length > 0 ? options.cc : snippet.cc.length > 0 ? snippet.cc : undefined;
  const bcc = options.bcc.length > 0 ? options.bcc : snippet.bcc.length > 0 ? snippet.bcc : undefined;

  if (options.send) {
    // Send immediately
    if (to.length === 0) {
      error("At least one recipient is required (--to or snippet default)");
      process.exit(1);
    }

    const toRecipients = to.map((email: string) => ({ email }));
    const ccRecipients = cc?.map((email: string) => ({ email }));
    const bccRecipients = bcc?.map((email: string) => ({ email }));

    // Create draft first, then send
    const draftResult = await createDraftWithUserInfo(userInfo, {
      to,
      cc,
      bcc,
      subject,
      body,
    });

    if (!draftResult.success || !draftResult.draftId || !draftResult.threadId) {
      error(`Failed to create draft: ${draftResult.error}`);
      process.exit(1);
    }

    const sendResult = await sendDraftSuperhuman(userInfo, {
      draftId: draftResult.draftId,
      threadId: draftResult.threadId,
      to: toRecipients,
      cc: ccRecipients,
      bcc: bccRecipients,
      subject,
      htmlBody: body,
      delay: 0,
    });

    if (sendResult.success) {
      success(`Sent using snippet "${snippet.name}"`);
      log(`  ${colors.dim}To: ${to.join(", ")}${colors.reset}`);
      if (subject) log(`  ${colors.dim}Subject: ${subject}${colors.reset}`);
    } else {
      error(`Failed to send: ${sendResult.error}`);
    }
  } else {
    // Create draft
    const result = await createDraftWithUserInfo(userInfo, {
      to,
      cc,
      bcc,
      subject,
      body,
    });

    if (result.success) {
      success(`Draft created from snippet "${snippet.name}"`);
      log(`  ${colors.dim}Draft ID: ${result.draftId}${colors.reset}`);
      if (to.length > 0) log(`  ${colors.dim}To: ${to.join(", ")}${colors.reset}`);
      if (subject) log(`  ${colors.dim}Subject: ${subject}${colors.reset}`);
      if (accountEmail) log(`  ${colors.dim}Account: ${accountEmail}${colors.reset}`);
    } else {
      error(`Failed to create draft: ${result.error}`);
    }
  }
}



async function cmdDraft(options: CliOptions) {
  // If updating an existing draft
  if (options.updateDraftId) {
    const draftId = options.updateDraftId;
    const isNativeDraft = draftId.startsWith("draft00");

    // Check for flag mismatch
    if (options.native && !isNativeDraft) {
      error("--native flag is only valid for native Superhuman draft IDs (starting with draft00)");
      error(`Draft ID ${draftId} appears to be a provider draft ID`);
      process.exit(1);
    }

    // Native draft update path
    if (options.native || isNativeDraft) {
      const token = await resolveSuperhumanToken(options.account);
      if (!token) {
        error("No cached Superhuman credentials found");
        error("Run 'superhuman account auth' first");
        process.exit(1);
      }

      const userInfo = getUserInfoFromCache(token.userId, token.email, token.idToken);

      // Use DraftService to get draft details for threadId
      const nativeProvider = new SuperhumanDraftProvider(token);
      const draftService = new DraftService([nativeProvider]);
      const drafts = await draftService.listDrafts();
      const draft = drafts.find(d => d.id === draftId);

      if (!draft) {
        error(`Draft ${draftId} not found`);
        process.exit(1);
      }

      // Use HTML body if provided, otherwise convert plain text to HTML (if body provided)
      const bodyContent = options.html || (options.body ? textToHtml(options.body) : undefined);

      info(`Updating native draft ${draftId}...`);
      const success = await updateDraftWithUserInfo(userInfo, draft.threadId, draftId, {
        to: options.to.length > 0 ? options.to : undefined,
        cc: options.cc.length > 0 ? options.cc : undefined,
        bcc: options.bcc.length > 0 ? options.bcc : undefined,
        subject: options.subject || undefined,
        body: bodyContent,
      });

      if (success) {
        log(`${colors.green}✓${colors.reset} Draft updated!`);
        log(`  ${colors.dim}Draft ID: ${draftId}${colors.reset}`);
        log(`  ${colors.dim}Account: ${token.email}${colors.reset}`);
      }
      return;
    }

    // Provider draft update path
    const provider = await getProvider(options);

    // Resolve names to emails
    const resolvedTo = options.to.length > 0 ? await resolveAllRecipientsViaProvider(provider, options.to) : undefined;
    const resolvedCc = options.cc.length > 0 ? await resolveAllRecipientsViaProvider(provider, options.cc) : undefined;
    const resolvedBcc = options.bcc.length > 0 ? await resolveAllRecipientsViaProvider(provider, options.bcc) : undefined;

    // Use HTML body if provided, otherwise convert plain text to HTML (if body provided)
    const bodyContent = options.html || (options.body ? textToHtml(options.body) : undefined);

    info(`Updating draft ${options.updateDraftId}...`);
    const result = await updateDraftViaProvider(provider, options.updateDraftId, {
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

    await provider.disconnect();
    return;
  }

  // Creating a new draft - requires at least one recipient
  if (options.to.length === 0) {
    error("At least one recipient is required (--to)");
    process.exit(1);
  }

  // Fast path: use cached Superhuman credentials (no CDP needed)
  if (options.provider === "superhuman") {
    const token = await resolveSuperhumanToken(options.account);
    if (token) {
      info("Creating draft via Superhuman API...");

      const userInfo = getUserInfoFromCache(
        token.userId,
        token.email,
        token.idToken
      );

      const bodyContent = options.html || textToHtml(options.body);
      const result = await createDraftWithUserInfo(userInfo, {
        to: options.to,
        cc: options.cc.length > 0 ? options.cc : undefined,
        bcc: options.bcc.length > 0 ? options.bcc : undefined,
        subject: options.subject || "",
        body: bodyContent,
      });

      if (result.success) {
        success("Draft created in Superhuman!");
        log(`  ${colors.dim}Draft ID: ${result.draftId}${colors.reset}`);
        log(`  ${colors.dim}Account: ${token.email}${colors.reset}`);
        log(`  ${colors.dim}Syncs to all devices automatically${colors.reset}`);
      } else {
        error(`Failed to create draft: ${result.error}`);
      }
      return;
    }
  }

  const provider = await getProvider(options);

  // Resolve names to emails
  const resolvedTo = await resolveAllRecipientsViaProvider(provider, options.to);
  const resolvedCc = options.cc.length > 0 ? await resolveAllRecipientsViaProvider(provider, options.cc) : undefined;
  const resolvedBcc = options.bcc.length > 0 ? await resolveAllRecipientsViaProvider(provider, options.bcc) : undefined;

  // Use HTML body if provided, otherwise convert plain text to HTML
  const bodyContent = options.html || textToHtml(options.body);

  if (options.provider === "superhuman") {
    // Fallback: Superhuman via CDP provider
    info("Creating draft via Superhuman API (CDP)...");

    const result = await createDraftViaProvider(provider, {
      to: resolvedTo,
      cc: resolvedCc,
      bcc: resolvedBcc,
      subject: options.subject || "",
      body: bodyContent,
    });

    if (result.success) {
      success("Draft created in Superhuman!");
      log(`  ${colors.dim}Draft ID: ${result.draftId}${colors.reset}`);
      log(`  ${colors.dim}Syncs to all devices automatically${colors.reset}`);
    } else {
      error(`Failed to create draft: ${result.error}`);
    }
  } else {
    // Direct API approach (Gmail/MS Graph)
    info("Creating draft via Gmail/MS Graph API...");
    const result = await createDraftViaProvider(provider, {
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
  }

  await provider.disconnect();
}

async function cmdDeleteDraft(options: CliOptions) {
  const draftIds = options.draftIds;

  if (draftIds.length === 0) {
    error("At least one draft ID is required");
    error("Usage: superhuman draft delete <draft-id> [draft-id...]");
    process.exit(1);
  }

  // Separate native drafts from provider drafts
  const nativeDraftIds = draftIds.filter(id => id.startsWith("draft00"));
  const providerDraftIds = draftIds.filter(id => !id.startsWith("draft00"));

  // Handle native drafts
  if (nativeDraftIds.length > 0) {
    const token = await resolveSuperhumanToken(options.account);
    if (!token) {
      error("No cached Superhuman credentials found for native draft deletion");
      error("Run 'superhuman account auth' first");
      process.exit(1);
    }

    const userInfo = getUserInfoFromCache(token.userId, token.email, token.idToken);

    // Use DraftService to get draft details for threadId
    const nativeProvider = new SuperhumanDraftProvider(token);
    const draftService = new DraftService([nativeProvider]);
    const drafts = await draftService.listDrafts();

    for (const draftId of nativeDraftIds) {
      const draft = drafts.find(d => d.id === draftId);

      if (!draft) {
        error(`Native draft ${draftId} not found`);
        continue;
      }

      info(`Deleting native draft ${draftId.slice(-15)}...`);
      try {
        await deleteDraftWithUserInfo(userInfo, draft.threadId, draftId);
        success(`Deleted native draft ${draftId.slice(-15)}`);
      } catch (err) {
        error(`Failed to delete native draft: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Handle provider drafts
  if (providerDraftIds.length > 0) {
    const provider = await getProvider(options);

    for (const draftId of providerDraftIds) {
      info(`Deleting draft ${draftId.slice(-15)}...`);
      const result = await deleteDraftViaProvider(provider, draftId);

      if (result.success) {
        success(`Deleted draft ${draftId.slice(-15)}`);
      } else {
        error(`Failed to delete draft: ${result.error}`);
      }
    }

    await provider.disconnect();
  }
}

async function cmdSendDraft(options: CliOptions) {
  const draftId = options.sendDraftDraftId;

  // Validate draft ID is provided
  if (!draftId) {
    error("Draft ID is required");
    error("Usage: superhuman draft send <draft-id> --account=<email> --to=<recipient> --subject=<subject> --body=<body>");
    process.exit(1);
  }

  // Validate draft ID format
  if (!draftId.startsWith("draft00")) {
    error("Invalid draft ID. Must be a Superhuman draft ID (starts with draft00)");
    process.exit(1);
  }

  // Require --account flag (no CDP path for now)
  if (!options.account) {
    error("--account flag is required for send-draft");
    process.exit(1);
  }

  // Require --to flag
  if (options.to.length === 0) {
    error("--to flag is required (at least one recipient)");
    process.exit(1);
  }

  // Require --subject flag
  if (!options.subject) {
    error("--subject flag is required");
    process.exit(1);
  }

  // Require --body flag
  if (!options.body && !options.html) {
    error("--body flag is required");
    process.exit(1);
  }

  // Load cached credentials
  await loadTokensFromDisk();
  const token = await getCachedToken(options.account);
  if (!token?.idToken || !token?.userId) {
    error(`No cached credentials for ${options.account}. Run 'superhuman auth' first.`);
    process.exit(1);
  }

  // Build userInfo
  const userInfo = getUserInfoFromCache(token.userId, token.email, token.idToken);

  // Build recipients
  const toRecipients: Recipient[] = options.to.map((email) => ({ email }));
  const ccRecipients: Recipient[] | undefined =
    options.cc.length > 0 ? options.cc.map((email) => ({ email })) : undefined;
  const bccRecipients: Recipient[] | undefined =
    options.bcc.length > 0 ? options.bcc.map((email) => ({ email })) : undefined;

  // Get body content (HTML or convert plain text)
  const htmlBody = options.html || textToHtml(options.body);

  info(`Sending draft ${draftId.slice(-15)}...`);

  const result = await sendDraftSuperhuman(userInfo, {
    draftId,
    threadId: options.sendDraftThreadId || draftId, // Use --thread if provided (for reply/forward), otherwise draftId
    to: toRecipients,
    cc: ccRecipients,
    bcc: bccRecipients,
    subject: options.subject,
    htmlBody,
    delay: options.sendDraftDelay,
  });

  if (result.success) {
    success("Draft sent!");
    if (result.sendAt) {
      const sendTime = new Date(result.sendAt);
      log(`  ${colors.dim}Scheduled for: ${sendTime.toLocaleString()}${colors.reset}`);
    }
    log(`  ${colors.dim}Account: ${options.account}${colors.reset}`);

    // Auto-delete the native draft after successful send (matches Superhuman app behavior)
    try {
      const threadId = options.sendDraftThreadId || draftId;
      await deleteDraftWithUserInfo(userInfo, threadId, draftId);
    } catch {
      // Non-fatal: draft was sent successfully, cleanup failure is just cosmetic
    }
  } else {
    error(`Failed to send draft: ${result.error}`);
    process.exit(1);
  }
}

async function cmdListDrafts(options: CliOptions) {
  const account = options.account;
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  // Load cached tokens from disk
  await loadTokensFromDisk();

  // Determine which account to use
  let email = account;
  if (!email) {
    const accounts = getCachedAccounts();
    if (accounts.length > 0) {
      email = accounts[0];
      info(`Using account: ${email}`);
    } else {
      error("No account specified. Use --account <email>");
      process.exit(1);
    }
  }

  info(`Fetching drafts from ${email}...`);

  try {
    // Get token for the account
    const token = await getCachedToken(email);
    if (!token) {
      error(`No cached token for ${email}. Run 'superhuman account auth' to authenticate.`);
      process.exit(1);
    }

    // Create providers based on account type
    // Include both email provider (Gmail/Outlook) and Superhuman native draft provider
    const emailProvider = token.isMicrosoft
      ? new OutlookDraftProvider(token)
      : new GmailDraftProvider(token);
    const nativeProvider = new SuperhumanDraftProvider(token);

    // Use DraftService to fetch drafts from all providers
    const service = new DraftService([emailProvider, nativeProvider]);
    const drafts = await service.listDrafts(limit, offset);

    if (drafts.length === 0) {
      log(`${colors.dim}No drafts found in ${email}.${colors.reset}`);
      return;
    }

    log(`\n${colors.cyan}${drafts.length} draft(s):${colors.reset}\n`);

    // Display drafts with source column
    for (const draft of drafts) {
      log(`${colors.blue}${draft.id}${colors.reset}`);
      log(`  Subject: ${draft.subject || "(no subject)"}`);
      log(`  Source: ${draft.source}`);
      log(`  To: ${draft.to.join(", ") || "(no recipients)"}`);
      if (draft.from) {
        log(`  From: ${draft.from}`);
      }
      if (draft.preview) {
        const preview = draft.preview.substring(0, 100).replace(/\n/g, " ");
        log(`  Preview: ${preview}${draft.preview.length > 100 ? "..." : ""}`);
      }
      const dateStr = new Date(draft.timestamp).toLocaleString();
      log(`  Date: ${dateStr}`);
      log("");
    }
  } catch (err) {
    error(`Failed to fetch drafts: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function cmdSend(options: CliOptions) {
  // If sending an existing draft by ID
  if (options.sendDraftId) {
    const provider = await getProvider(options);

    info(`Sending draft ${options.sendDraftId}...`);
    const result = await sendDraftByIdViaProvider(provider, options.sendDraftId);

    if (result.success) {
      success("Draft sent!");
      if (result.messageId) {
        log(`  ${colors.dim}Message ID: ${result.messageId}${colors.reset}`);
      }
    } else {
      error(`Failed to send draft: ${result.error}`);
    }

    await provider.disconnect();
    return;
  }

  // Composing and sending a new email - requires at least one recipient
  if (options.to.length === 0) {
    error("At least one recipient is required (--to)");
    process.exit(1);
  }

  const provider = await getProvider(options);

  // Resolve names to emails
  const resolvedTo = await resolveAllRecipientsViaProvider(provider, options.to);
  const resolvedCc = options.cc.length > 0 ? await resolveAllRecipientsViaProvider(provider, options.cc) : undefined;
  const resolvedBcc = options.bcc.length > 0 ? await resolveAllRecipientsViaProvider(provider, options.bcc) : undefined;

  // Use HTML body if provided, otherwise convert plain text to HTML
  const bodyContent = options.html || textToHtml(options.body);

  info("Sending email...");
  const result = await sendEmailViaProvider(provider, {
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

  await provider.disconnect();
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
  const provider = await getProvider(options);

  const threads = await listInbox(provider, { limit: options.limit });

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

  await provider.disconnect();
}

async function cmdSearch(options: CliOptions) {
  if (!options.query) {
    error("Search query is required");
    console.log(`Usage: superhuman search <query>`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  const threads = await searchInbox(provider, {
    query: options.query,
    limit: options.limit,
    includeDone: options.includeDone,
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

  await provider.disconnect();
}

const READ_USAGE = `Usage: superhuman read <thread-id> [--account <email>] [--context N]`;

async function cmdRead(options: CliOptions) {
  if (!options.threadId) {
    error("Thread ID is required");
    console.log(READ_USAGE);
    process.exit(1);
  }

  // Fast path: use cached credentials (no CDP needed) - same pattern as cmdReply
  const token = await resolveSuperhumanToken(options.account);
  if (!token) {
    error("No cached credentials found. Run 'superhuman account auth' first.");
    process.exit(1);
  }

  let messages;
  try {
    messages = await getThreadMessages(token, options.threadId);
  } catch (e) {
    error(`Failed to fetch thread: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(messages, null, 2));
    return;
  }

  if (messages.length === 0) {
    error("Thread not found or no messages");
    return;
  }

  const contextCount = options.context;
  const separator = "\n" + colors.dim + "─".repeat(60) + colors.reset + "\n";

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (i > 0) {
      console.log(separator);
    }
    console.log(`${colors.bold}${msg.subject}${colors.reset}`);
    console.log(`${colors.cyan}From:${colors.reset} ${msg.from.name} <${msg.from.email}>`);
    console.log(`${colors.cyan}To:${colors.reset} ${msg.to.map((r) => r.email).join(", ")}`);
    if (msg.cc.length > 0) {
      console.log(`${colors.cyan}Cc:${colors.reset} ${msg.cc.map((r) => r.email).join(", ")}`);
    }
    console.log(`${colors.cyan}Date:${colors.reset} ${new Date(msg.date).toLocaleString()}`);
    console.log();

    // When contextCount is 0 (default), show full body for all messages.
    // Otherwise, show full body only for the last N messages.
    const isWithinContext = contextCount === 0 || (messages.length - i) <= contextCount;
    if (isWithinContext && msg.body) {
      console.log(msg.body);
    } else {
      console.log(msg.snippet);
    }
  }
}

async function cmdReply(options: CliOptions) {
  if (!options.threadId) {
    error("Thread ID is required");
    console.log(`Usage: superhuman reply <thread-id> [--body "text"] [--send] [--account <email>]`);
    process.exit(1);
  }

  // Fast path: use cached Superhuman credentials (no CDP needed)
  {
    const token = await resolveSuperhumanToken(options.account);
    if (token) {
      const body = options.body || "";

      if (options.send) {
        info(`Sending reply to thread ${options.threadId} via direct API...`);

        const threadInfo = await getThreadInfoDirect(token, options.threadId);
        if (!threadInfo) {
          error("Could not get thread information");
          process.exit(1);
        }

        const subject = threadInfo.subject.startsWith("Re:")
          ? threadInfo.subject
          : `Re: ${threadInfo.subject}`;

        const result = await sendEmailDirect(token, {
          to: [threadInfo.from],
          subject,
          body: textToHtml(body),
          isHtml: true,
          threadId: options.threadId,
          inReplyTo: threadInfo.messageId || undefined,
          references: threadInfo.references,
        });

        if (result) {
          success("Reply sent!");
          log(`  ${colors.dim}Account: ${token.email}${colors.reset}`);
        } else {
          error("Failed to send reply");
        }
        return;
      } else {
        // Create Superhuman draft
        info(`Creating reply draft via Superhuman API...`);

        const threadInfo = await getThreadInfoDirect(token, options.threadId);
        if (!threadInfo) {
          error("Could not get thread information");
          process.exit(1);
        }

        const userInfo = getUserInfoFromCache(
          token.userId,
          token.email,
          token.idToken
        );

        const subject = threadInfo.subject.startsWith("Re:")
          ? threadInfo.subject
          : `Re: ${threadInfo.subject}`;

        const result = await createDraftWithUserInfo(userInfo, {
          to: [threadInfo.from],
          subject,
          body: textToHtml(body),
          action: "reply",
          inReplyToThreadId: options.threadId,
          inReplyToRfc822Id: threadInfo.messageId || undefined,
          references: threadInfo.references,
        });

        if (result.success) {
          success("Reply draft created in Superhuman!");
          log(`  ${colors.dim}Draft ID: ${result.draftId}${colors.reset}`);
          log(`  ${colors.dim}Account: ${token.email}${colors.reset}`);
          log(`  ${colors.dim}Syncs to all devices automatically${colors.reset}`);
        } else {
          error(`Failed to create reply draft: ${result.error}`);
        }
        return;
      }
    }
  }

  // CDP path (fallback)
  const provider = await getProvider(options);

  const body = options.body || "";
  const action = options.send ? "Sending" : "Creating draft for";
  info(`${action} reply to thread ${options.threadId}...`);

  const result = await replyToThread(provider, options.threadId, body, options.send);

  if (result.success) {
    if (options.send) {
      success("Reply sent!");
    } else {
      success(`Draft saved (${result.draftId})`);
    }
  } else {
    error(result.error || "Failed to create reply");
  }

  await provider.disconnect();
}

async function cmdReplyAll(options: CliOptions) {
  if (!options.threadId) {
    error("Thread ID is required");
    console.log(`Usage: superhuman reply-all <thread-id> [--body "text"] [--send] [--account <email>]`);
    process.exit(1);
  }

  // Fast path: use cached Superhuman credentials (no CDP needed)
  {
    const token = await resolveSuperhumanToken(options.account);
    if (token) {
      const body = options.body || "";

      if (options.send) {
        info(`Sending reply-all to thread ${options.threadId} via direct API...`);

        const threadInfo = await getThreadInfoDirect(token, options.threadId);
        if (!threadInfo) {
          error("Could not get thread information");
          process.exit(1);
        }

        const subject = threadInfo.subject.startsWith("Re:")
          ? threadInfo.subject
          : `Re: ${threadInfo.subject}`;

        // Build reply-all recipients (all participants except self)
        const allRecipients = [
          threadInfo.from,
          ...threadInfo.to,
          ...threadInfo.cc,
        ].filter(email => email && email.toLowerCase() !== token.email.toLowerCase());

        // Deduplicate recipients
        const uniqueRecipients = [...new Set(allRecipients.map(e => e.toLowerCase()))];

        const result = await sendEmailDirect(token, {
          to: uniqueRecipients,
          subject,
          body: textToHtml(body),
          isHtml: true,
          threadId: options.threadId,
          inReplyTo: threadInfo.messageId || undefined,
          references: threadInfo.references,
        });

        if (result) {
          success("Reply-all sent!");
          log(`  ${colors.dim}Account: ${token.email}${colors.reset}`);
        } else {
          error("Failed to send reply-all");
        }
        return;
      } else {
        // Create Superhuman draft
        info(`Creating reply-all draft via Superhuman API...`);

        const threadInfo = await getThreadInfoDirect(token, options.threadId);
        if (!threadInfo) {
          error("Could not get thread information");
          process.exit(1);
        }

        const userInfo = getUserInfoFromCache(
          token.userId,
          token.email,
          token.idToken
        );

        const subject = threadInfo.subject.startsWith("Re:")
          ? threadInfo.subject
          : `Re: ${threadInfo.subject}`;

        // Build reply-all recipients (all participants except self)
        const allRecipients = [
          threadInfo.from,
          ...threadInfo.to,
          ...threadInfo.cc,
        ].filter(email => email && email.toLowerCase() !== token.email.toLowerCase());

        // Deduplicate recipients
        const uniqueRecipients = [...new Set(allRecipients.map(e => e.toLowerCase()))];

        const result = await createDraftWithUserInfo(userInfo, {
          to: uniqueRecipients,
          subject,
          body: textToHtml(body),
          action: "reply" as const,  // reply-all uses reply action
          inReplyToThreadId: options.threadId,
          inReplyToRfc822Id: threadInfo.messageId || undefined,
          references: threadInfo.references,
        });

        if (result.success) {
          success("Reply-all draft created in Superhuman!");
          log(`  ${colors.dim}Draft ID: ${result.draftId}${colors.reset}`);
          log(`  ${colors.dim}Account: ${token.email}${colors.reset}`);
          log(`  ${colors.dim}Syncs to all devices automatically${colors.reset}`);
        } else {
          error(`Failed to create reply-all draft: ${result.error}`);
        }
        return;
      }
    }
  }

  // CDP path (fallback)
  const provider = await getProvider(options);

  const body = options.body || "";
  const action = options.send ? "Sending" : "Creating draft for";
  info(`${action} reply-all to thread ${options.threadId}...`);

  const result = await replyAllToThread(provider, options.threadId, body, options.send);

  if (result.success) {
    if (options.send) {
      success("Reply-all sent!");
    } else {
      success(`Draft saved (${result.draftId})`);
    }
  } else {
    error(result.error || "Failed to create reply-all");
  }

  await provider.disconnect();
}

async function cmdForward(options: CliOptions) {
  if (!options.threadId) {
    error("Thread ID is required");
    console.log(`Usage: superhuman forward <thread-id> --to <email> [--body "text"] [--send] [--account <email>]`);
    process.exit(1);
  }

  if (options.to.length === 0) {
    error("Recipient is required (--to)");
    console.log(`Usage: superhuman forward <thread-id> --to <email> [--body "text"] [--send] [--account <email>]`);
    process.exit(1);
  }

  // Fast path: use cached Superhuman credentials (no CDP needed)
  {
    const token = await resolveSuperhumanToken(options.account);
    if (token) {
      const body = options.body || "";

      if (options.send) {
        info(`Forwarding thread ${options.threadId} via direct API...`);

        const threadInfo = await getThreadInfoDirect(token, options.threadId);
        if (!threadInfo) {
          error("Could not get thread information");
          process.exit(1);
        }

        const subject = threadInfo.subject.startsWith("Fwd:")
          ? threadInfo.subject
          : `Fwd: ${threadInfo.subject}`;

        const result = await sendEmailDirect(token, {
          to: options.to,
          subject,
          body: textToHtml(body),
          isHtml: true,
          // Note: forwards don't need inReplyTo/references - they're new threads
        });

        if (result) {
          success("Forward sent!");
          log(`  ${colors.dim}Account: ${token.email}${colors.reset}`);
        } else {
          error("Failed to send forward");
        }
        return;
      } else {
        // Create Superhuman forward draft
        info(`Creating forward draft via Superhuman API...`);

        const threadInfo = await getThreadInfoDirect(token, options.threadId);
        if (!threadInfo) {
          error("Could not get thread information");
          process.exit(1);
        }

        const userInfo = getUserInfoFromCache(
          token.userId,
          token.email,
          token.idToken
        );

        const subject = threadInfo.subject.startsWith("Fwd:")
          ? threadInfo.subject
          : `Fwd: ${threadInfo.subject}`;

        const result = await createDraftWithUserInfo(userInfo, {
          to: options.to,
          subject,
          body: textToHtml(body),
          action: "forward",
          inReplyToThreadId: options.threadId,
        });

        if (result.success) {
          success("Forward draft created in Superhuman!");
          log(`  ${colors.dim}Draft ID: ${result.draftId}${colors.reset}`);
          log(`  ${colors.dim}Account: ${token.email}${colors.reset}`);
          log(`  ${colors.dim}Syncs to all devices automatically${colors.reset}`);
        } else {
          error(`Failed to create forward draft: ${result.error}`);
        }
        return;
      }
    }
  }

  // CDP path (fallback)
  const provider = await getProvider(options);

  // Resolve name to email
  const resolvedTo = await resolveAllRecipientsViaProvider(provider, options.to);
  const toEmail = resolvedTo[0]; // Use first recipient for forward

  const body = options.body || "";
  const action = options.send ? "Sending" : "Creating draft for";
  info(`${action} forward to ${toEmail}...`);

  const result = await forwardThread(provider, options.threadId, toEmail, body, options.send);

  if (result.success) {
    if (options.send) {
      success("Forward sent!");
    } else {
      success(`Draft saved (${result.draftId})`);
    }
  } else {
    error(result.error || "Failed to create forward");
  }

  await provider.disconnect();
}

async function cmdArchive(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman archive <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await archiveThread(provider, threadId);
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

  await provider.disconnect();
}

async function cmdDelete(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman delete <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await deleteThread(provider, threadId);
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

  await provider.disconnect();
}

async function cmdMarkRead(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman mark read <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await markAsRead(provider, threadId);
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

  await provider.disconnect();
}

async function cmdMarkUnread(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman mark unread <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await markAsUnread(provider, threadId);
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

  await provider.disconnect();
}

async function cmdLabels(options: CliOptions) {
  const provider = await getProvider(options);

  const labels = await listLabels(provider);

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

  await provider.disconnect();
}

async function cmdGetLabels(options: CliOptions) {
  if (!options.threadId) {
    error("Thread ID is required");
    console.log(`Usage: superhuman label get <thread-id>`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  const labels = await getThreadLabels(provider, options.threadId);

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

  await provider.disconnect();
}

async function cmdAddLabel(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman label add <thread-id> [thread-id...] --label <label-id>`);
    process.exit(1);
  }

  if (!options.labelId) {
    error("Label ID is required (--label)");
    console.log(`Usage: superhuman label add <thread-id> [thread-id...] --label <label-id>`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await addLabel(provider, threadId, options.labelId);
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

  await provider.disconnect();
}

async function cmdRemoveLabel(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman label remove <thread-id> [thread-id...] --label <label-id>`);
    process.exit(1);
  }

  if (!options.labelId) {
    error("Label ID is required (--label)");
    console.log(`Usage: superhuman label remove <thread-id> [thread-id...] --label <label-id>`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await removeLabel(provider, threadId, options.labelId);
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

  await provider.disconnect();
}

async function cmdStar(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman star add <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await starThread(provider, threadId);
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

  await provider.disconnect();
}

async function cmdUnstar(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman star remove <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  let successCount = 0;
  let failCount = 0;

  for (const threadId of options.threadIds) {
    const result = await unstarThread(provider, threadId);
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

  await provider.disconnect();
}

async function cmdStarred(options: CliOptions) {
  const provider = await getProvider(options);

  const threads = await listStarred(provider, options.limit);

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

  await provider.disconnect();
}

async function cmdSnooze(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman snooze set <thread-id> [thread-id...] --until <time>`);
    process.exit(1);
  }

  if (!options.snoozeUntil) {
    error("Snooze time is required (--until)");
    console.log(`Usage: superhuman snooze set <thread-id> --until <time>`);
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

  const provider = await getProvider(options);

  let successCount = 0;
  let failCount = 0;

  const results = await snoozeThreadViaProvider(provider, options.threadIds, snoozeTime);
  for (let i = 0; i < options.threadIds.length; i++) {
    const threadId = options.threadIds[i];
    const result = results[i];
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

  await provider.disconnect();
}

async function cmdUnsnooze(options: CliOptions) {
  if (options.threadIds.length === 0) {
    error("At least one thread ID is required");
    console.log(`Usage: superhuman snooze cancel <thread-id> [thread-id...]`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  let successCount = 0;
  let failCount = 0;

  const results = await unsnoozeThreadViaProvider(provider, options.threadIds);
  for (let i = 0; i < options.threadIds.length; i++) {
    const threadId = options.threadIds[i];
    const result = results[i];
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

  await provider.disconnect();
}

async function cmdSnoozed(options: CliOptions) {
  const provider = await getProvider(options);

  const threads = await listSnoozedViaProvider(provider, options.limit);

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

  await provider.disconnect();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function cmdAttachments(options: CliOptions) {
  if (!options.threadId) {
    error("Thread ID is required");
    console.log(`Usage: superhuman attachment list <thread-id>`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  const attachments = await listAttachments(provider, options.threadId);

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

  await provider.disconnect();
}

async function cmdDownload(options: CliOptions) {
  // Mode 1: Download specific attachment with --attachment and --message
  if (options.attachmentId) {
    if (!options.messageId) {
      error("Message ID is required when using --attachment");
      console.log(`Usage: superhuman attachment download --attachment <attachment-id> --message <message-id> --output <path>`);
      process.exit(1);
    }

    const provider = await getProvider(options);

    try {
      info(`Downloading attachment ${options.attachmentId}...`);
      const content = await downloadAttachment(provider, options.messageId, options.attachmentId);
      const outputPath = options.outputPath || `attachment-${options.attachmentId}`;
      await Bun.write(outputPath, Buffer.from(content.data, "base64"));
      success(`Downloaded: ${outputPath} (${formatFileSize(content.size)})`);
    } catch (e) {
      error(`Failed to download: ${(e as Error).message}`);
    }

    await provider.disconnect();
    return;
  }

  // Mode 2: Download all attachments from a thread
  if (!options.threadId) {
    error("Thread ID is required, or use --attachment with --message");
    console.log(`Usage: superhuman attachment download <thread-id> [--output <dir>]`);
    console.log(`       superhuman attachment download --attachment <id> --message <id> --output <path>`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  const attachments = await listAttachments(provider, options.threadId);

  if (attachments.length === 0) {
    info("No attachments in this thread");
    await provider.disconnect();
    return;
  }

  const outputDir = options.outputPath || ".";
  let successCount = 0;
  let failCount = 0;

  for (const att of attachments) {
    try {
      info(`Downloading ${att.name}...`);
      const content = await downloadAttachment(
        provider,
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

  await provider.disconnect();
}

/**
 * Extract OAuth tokens for all accounts and save to disk.
 *
 * This enables CLI operations without needing Superhuman running,
 * as long as tokens haven't expired (typically ~1 hour).
 */
async function cmdAuth(options: CliOptions) {
  log("Connecting to Superhuman...");
  const conn = await checkConnection(options.port);

  if (conn) {
    try {
      const accounts = await listAccounts(conn);

      if (accounts.length > 0) {
        // Electron app path
        log(`Found ${accounts.length} account(s) (Electron app)`);
        for (const account of accounts) {
          log(`Extracting token for ${account.email}...`);
          await getToken(conn, account.email);
        }
        await saveTokensToDisk();
        success(`Tokens saved to ${getTokensFilePath()}`);
        log("");
        info("You can now use superhuman-cli without Superhuman running.");
        info("Tokens are valid for ~1 hour. Run 'superhuman auth' again to refresh.");
        return;
      }
      // 0 accounts from Electron path — try Chrome extension
      await disconnect(conn);
    } catch {
      await disconnect(conn);
    }
  }

  // Chrome extension path
  log("Trying Chrome extension path...");
  const chromeConn = await connectToSuperhumanChrome(options.port);
  if (!chromeConn) {
    error("Cannot connect to Superhuman. Make sure it is running with CDP enabled.");
    log(`  Chrome: launch with --remote-debugging-port=${options.port}`);
    log(`  Electron: /Applications/Superhuman.app/Contents/MacOS/Superhuman --remote-debugging-port=${options.port}`);
    process.exit(1);
  }

  try {
    const accounts = await listAccountsChrome(chromeConn);
    log(`Found ${accounts.length} account(s) (Chrome extension)`);

    for (const account of accounts) {
      log(`Extracting token for ${account.email}...`);
      try {
        await extractTokenChrome(chromeConn, account.email);
        success(`  ${account.email} OK`);
      } catch (e) {
        error(`  ${account.email} failed: ${(e as Error).message}`);
      }
    }

    await saveTokensToDisk();
    success(`Tokens saved to ${getTokensFilePath()}`);
    log("");
    info("You can now use superhuman-cli without Superhuman running.");
    info("Tokens are valid for ~1 hour. Run 'superhuman auth' again to refresh.");
  } finally {
    await disconnectChrome(chromeConn);
  }
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
    console.log(`Usage: superhuman account switch <index|email>`);
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
export function parseCalendarDate(dateStr: string): Date {
  const now = new Date();
  const lowerDate = dateStr.toLowerCase();

  if (lowerDate === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (lowerDate === "tomorrow") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  }

  // Parse YYYY-MM-DD as local midnight (not UTC)
  // new Date("2026-02-10") per ECMAScript spec parses as UTC midnight,
  // which becomes the previous day in timezones west of UTC (e.g. EST).
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
  }

  // Try parsing as-is (for other formats like full ISO datetime with timezone)
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
export function parseEventTime(timeStr: string): Date {
  const now = new Date();

  // Parse YYYY-MM-DD as local midnight (not UTC)
  // new Date("2026-02-10") per ECMAScript spec parses as UTC midnight,
  // which becomes the previous day in timezones west of UTC (e.g. EST).
  const dateMatch = timeStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateMatch) {
    return new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]));
  }

  // Try ISO format (datetime strings with time component)
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
  const provider = await getProvider(options);

  // Parse date range
  let timeMin: Date;
  let timeMax: Date;

  if (options.eventStart) {
    // --start/--end flags take precedence over --date/--range
    timeMin = parseEventTime(options.eventStart);
    if (options.eventEnd) {
      timeMax = parseEventTime(options.eventEnd);
      // If end is same as or before start (e.g. both are date-only midnight),
      // extend to end of that day
      if (timeMax <= timeMin) {
        timeMax.setHours(23, 59, 59, 999);
      }
    } else {
      // Default: end of same day as start
      timeMax = new Date(timeMin);
      timeMax.setHours(23, 59, 59, 999);
    }
  } else if (options.calendarDate) {
    timeMin = parseCalendarDate(options.calendarDate);
    timeMax = new Date(timeMin);
    timeMax.setDate(timeMax.getDate() + options.calendarRange);
    timeMax.setHours(23, 59, 59, 999);
  } else {
    timeMin = new Date();
    timeMin.setHours(0, 0, 0, 0);
    timeMax = new Date(timeMin);
    timeMax.setDate(timeMax.getDate() + options.calendarRange);
    timeMax.setHours(23, 59, 59, 999);
  }

  // Resolve calendar ID if provided (requires CDP for name resolution)
  let calendarId: string | null = null;
  if (options.calendarArg && provider instanceof CDPConnectionProvider) {
    calendarId = await resolveCalendarId(provider.getConnection(), options.calendarArg);
  } else if (options.calendarArg) {
    // Without CDP, use the arg as-is (must be an ID)
    calendarId = options.calendarArg;
  }

  let allEvents: CalendarEvent[] = [];

  if (options.allAccounts) {
    // All-accounts mode requires CDP for account switching
    if (!(provider instanceof CDPConnectionProvider)) {
      error("--all-accounts requires Superhuman running with CDP");
      await provider.disconnect();
      process.exit(1);
    }
    const conn = provider.getConnection();
    const accounts = await listAccounts(conn);
    const originalAccount = accounts.find(a => a.isCurrent)?.email;

    for (const account of accounts) {
      // Switch to this account
      await switchAccount(conn, account.email);
      // Small delay for account switch to take effect
      await new Promise(r => setTimeout(r, 300));

      const events = await listEvents(provider, { timeMin, timeMax });
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
    allEvents = await listEvents(provider, { timeMin, timeMax, calendarId: calendarId || undefined });
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

  await provider.disconnect();
}

async function cmdCalendarCreate(options: CliOptions) {
  if (!options.eventTitle && !options.subject) {
    error("Event title is required (--title)");
    process.exit(1);
  }

  const provider = await getProvider(options);

  const title = options.eventTitle || options.subject;
  let startTime: Date;
  let endTime: Date;

  // Resolve calendar ID if provided (requires CDP for name resolution)
  let calendarId: string | null = null;
  if (options.calendarArg && provider instanceof CDPConnectionProvider) {
    calendarId = await resolveCalendarId(provider.getConnection(), options.calendarArg);
  } else if (options.calendarArg) {
    calendarId = options.calendarArg;
  }

  // Determine if this is an all-day event
  const isAllDay = options.calendarDate && !options.eventStart;

  if (isAllDay) {
    startTime = parseCalendarDate(options.calendarDate);
    endTime = new Date(startTime);
    endTime.setDate(endTime.getDate() + 1);
  } else {
    if (!options.eventStart) {
      error("Event start time is required (--start) or use --date for all-day event");
      await provider.disconnect();
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
    const resolvedAttendees = await resolveAllRecipientsViaProvider(provider, options.to);
    eventInput.attendees = resolvedAttendees.map(email => ({ email }));
  }

  const result = await createEvent(provider, eventInput);

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

  await provider.disconnect();
}

async function cmdCalendarUpdate(options: CliOptions) {
  if (!options.eventId) {
    error("Event ID is required (--event)");
    process.exit(1);
  }

  const provider = await getProvider(options);

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
    const resolvedAttendees = await resolveAllRecipientsViaProvider(provider, options.to);
    updates.attendees = resolvedAttendees.map(email => ({ email }));
  }

  if (Object.keys(updates).length === 0) {
    error("No updates specified. Use --title, --start, --end, --body, or --to");
    await provider.disconnect();
    process.exit(1);
  }

  const result = await updateEvent(provider, options.eventId, updates);

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

  await provider.disconnect();
}

async function cmdCalendarDelete(options: CliOptions) {
  if (!options.eventId) {
    error("Event ID is required (--event)");
    process.exit(1);
  }

  const provider = await getProvider(options);

  const result = await deleteCalendarEvent(provider, options.eventId);

  if (result.success) {
    success(`Event deleted: ${options.eventId}`);
  } else {
    error(`Failed to delete event: ${result.error}`);
    if (result.error?.includes("no-auth")) {
      info("Calendar write access may not be authorized in Superhuman");
    }
  }

  await provider.disconnect();
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
  if (options.subcommand !== "search") {
    error("Unknown subcommand: contact " + (options.subcommand || "(none)"));
    console.log(`Usage: superhuman contact search <query>`);
    process.exit(1);
  }

  if (!options.contactsQuery) {
    error("Search query is required");
    console.log(`Usage: superhuman contact search <query>`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  try {
    let contacts: Contact[];

    if (options.account) {
      // Use direct API with specified account
      const { searchContactsDirect } = await import("./token-api");
      const token = await provider.getToken(options.account);
      contacts = await searchContactsDirect(token, options.contactsQuery, options.limit);
      info(`Searching contacts in account: ${options.account}`);
    } else {
      // Use existing DI-based approach (current account)
      contacts = await searchContacts(provider, options.contactsQuery, { limit: options.limit });
    }

    if (options.json) {
      console.log(JSON.stringify(contacts, null, 2));
    } else {
      if (contacts.length === 0) {
        info("No contacts found");
      } else {
        for (const contact of contacts) {
          console.log(formatContact(contact));
        }
      }
    }
  } finally {
    await provider.disconnect();
  }
}

async function cmdAi(options: CliOptions) {
  if (!options.aiQuery) {
    error("Prompt is required");
    console.log(`Usage: superhuman ai "prompt"                    (ask AI / search emails)`);
    console.log(`       superhuman ai <thread-id> "prompt"        (ask about a specific thread)`);
    console.log(`\nExamples:`);
    console.log(`  superhuman ai "find emails about the Stanford cover letter"`);
    console.log(`  superhuman ai "what did John say about the deadline?"`);
    console.log(`  superhuman ai "Write an email inviting the team to a planning meeting"`);
    console.log(`  superhuman ai <thread-id> "summarize this thread"`);
    console.log(`  superhuman ai <thread-id> "draft a reply"`);
    process.exit(1);
  }

  const provider = await getProvider(options);

  try {
    // Get OAuth token
    if (options.threadId) {
      info(`Fetching thread context...`);
    }
    const oauthToken = await provider.getToken();

    // Get Superhuman backend token for AI API
    // Try cached idToken first, fall back to CDP extraction
    let superhumanToken: string;
    if (oauthToken.idToken) {
      superhumanToken = oauthToken.idToken;
    } else if (provider instanceof CDPConnectionProvider) {
      info(`Connecting to Superhuman AI...`);
      const shToken = await extractSuperhumanToken(provider.getConnection(), oauthToken.email);
      superhumanToken = shToken.token;
    } else {
      error("Superhuman backend credentials required for AI. Run 'superhuman account auth'.");
      await provider.disconnect();
      process.exit(1);
    }

    // Use askAISearch (askAIProxy) for all queries — it supports search, compose, and thread Q&A.
    // With a thread ID, it provides thread context. Without, it can search or compose.
    info(`Asking AI: "${options.aiQuery}"`);
    const result = await askAISearch(
      superhumanToken,
      oauthToken,
      options.aiQuery,
      { threadId: options.threadId },
    );

    // Display the response
    console.log(`\n${colors.bold}AI Response:${colors.reset}\n`);
    console.log(result.response);
    console.log(`\n${colors.dim}Session: ${result.sessionId}${colors.reset}`);
  } catch (e) {
    error(`AI query failed: ${(e as Error).message}`);
    await provider.disconnect();
    process.exit(1);
  }

  await provider.disconnect();
}

async function cmdCalendarFree(options: CliOptions) {
  const provider = await getProvider(options);

  // Parse date range
  let timeMin: Date;
  let timeMax: Date;

  if (options.eventStart) {
    // --start/--end flags take precedence over --date/--range
    timeMin = parseEventTime(options.eventStart);
    if (options.eventEnd) {
      timeMax = parseEventTime(options.eventEnd);
    } else {
      // Default: end of same day as start
      timeMax = new Date(timeMin);
      timeMax.setDate(timeMax.getDate() + options.calendarRange);
    }
  } else if (options.calendarDate) {
    timeMin = parseCalendarDate(options.calendarDate);
    timeMax = new Date(timeMin);
    timeMax.setDate(timeMax.getDate() + options.calendarRange);
  } else {
    timeMin = new Date();
    timeMax = new Date(timeMin);
    timeMax.setDate(timeMax.getDate() + options.calendarRange);
  }

  const result = await getFreeBusy(provider, { timeMin, timeMax });

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

  await provider.disconnect();
}

async function main() {
  const args = process.argv.slice(2);

  // Handle --version / -v early before parsing
  if (args.includes("--version") || args.includes("-v")) {
    console.log(`superhuman-cli ${VERSION}`);
    process.exit(0);
  }

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

    // account list|switch|auth
    case "account":
      switch (options.subcommand) {
        case "list":
          await cmdAccounts(options);
          break;
        case "switch":
          await cmdAccount(options);
          break;
        case "auth":
          await cmdAuth(options);
          break;
        default:
          error(`Unknown subcommand: account ${options.subcommand || "(none)"}`);
          log(`Usage: superhuman account list|switch|auth`);
          process.exit(1);
      }
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

    // mark read|unread
    case "mark":
      switch (options.subcommand) {
        case "read":
          await cmdMarkRead(options);
          break;
        case "unread":
          await cmdMarkUnread(options);
          break;
        default:
          error(`Unknown subcommand: mark ${options.subcommand || "(none)"}`);
          log(`Usage: superhuman mark read|unread <thread-id>`);
          process.exit(1);
      }
      break;

    // label list|get|add|remove
    case "label":
      switch (options.subcommand) {
        case "list":
          await cmdLabels(options);
          break;
        case "get":
          await cmdGetLabels(options);
          break;
        case "add":
          await cmdAddLabel(options);
          break;
        case "remove":
          await cmdRemoveLabel(options);
          break;
        default:
          error(`Unknown subcommand: label ${options.subcommand || "(none)"}`);
          log(`Usage: superhuman label list|get|add|remove`);
          process.exit(1);
      }
      break;

    // star add|remove|list
    case "star":
      switch (options.subcommand) {
        case "add":
          await cmdStar(options);
          break;
        case "remove":
          await cmdUnstar(options);
          break;
        case "list":
          await cmdStarred(options);
          break;
        default:
          error(`Unknown subcommand: star ${options.subcommand || "(none)"}`);
          log(`Usage: superhuman star add|remove|list`);
          process.exit(1);
      }
      break;

    // snooze set|cancel|list
    case "snooze":
      switch (options.subcommand) {
        case "set":
          await cmdSnooze(options);
          break;
        case "cancel":
          await cmdUnsnooze(options);
          break;
        case "list":
          await cmdSnoozed(options);
          break;
        default:
          error(`Unknown subcommand: snooze ${options.subcommand || "(none)"}`);
          log(`Usage: superhuman snooze set|cancel|list`);
          process.exit(1);
      }
      break;

    // attachment list|download
    case "attachment":
      switch (options.subcommand) {
        case "list":
          await cmdAttachments(options);
          break;
        case "download":
          await cmdDownload(options);
          break;
        default:
          error(`Unknown subcommand: attachment ${options.subcommand || "(none)"}`);
          log(`Usage: superhuman attachment list|download`);
          process.exit(1);
      }
      break;

    // calendar list|create|update|delete|free
    case "calendar":
      switch (options.subcommand) {
        case "list":
        case "":
          await cmdCalendar(options);
          break;
        case "create":
          await cmdCalendarCreate(options);
          break;
        case "update":
          await cmdCalendarUpdate(options);
          break;
        case "delete":
          await cmdCalendarDelete(options);
          break;
        case "free":
          await cmdCalendarFree(options);
          break;
        default:
          error(`Unknown subcommand: calendar ${options.subcommand}`);
          log(`Usage: superhuman calendar list|create|update|delete|free`);
          process.exit(1);
      }
      break;

    // contact search
    case "contact":
      switch (options.subcommand) {
        case "search":
          await cmdContacts(options);
          break;
        default:
          error(`Unknown subcommand: contact ${options.subcommand || "(none)"}`);
          log(`Usage: superhuman contact search <query>`);
          process.exit(1);
      }
      break;

    case "ai":
      await cmdAi(options);
      break;

    // snippet list|use
    case "snippet":
      switch (options.subcommand) {
        case "list":
          await cmdSnippets(options);
          break;
        case "use":
          await cmdSnippet(options);
          break;
        default:
          error(`Unknown subcommand: snippet ${options.subcommand || "(none)"}`);
          log(`Usage: superhuman snippet list|use`);
          process.exit(1);
      }
      break;


    // draft create|update|delete|send
    case "draft":
      switch (options.subcommand) {
        case "create":
          await cmdDraft(options);
          break;
        case "update":
          await cmdDraft(options);
          break;
        case "delete":
          await cmdDeleteDraft(options);
          break;
        case "send":
          await cmdSendDraft(options);
          break;
        case "list":
          await cmdListDrafts(options);
          break;
        default:
          error(`Unknown subcommand: draft ${options.subcommand || "(none)"}`);
          log(`Usage: superhuman draft create|update|delete|send|list`);
          process.exit(1);
      }
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
