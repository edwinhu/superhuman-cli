/**
 * MCP Token Relay Server
 *
 * Runs on the host and serves fresh MCP access tokens to containers.
 * Owns the canonical refresh token — containers never touch it.
 *
 * Usage:
 *   bun src/token-relay.ts                # default port 9401
 *   bun src/token-relay.ts --port 9402
 *
 * Endpoints:
 *   GET /token  → { access_token, expires_at }
 *   GET /health → { ok: true, has_token: bool }
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const MCP_SERVER_URL = "https://mcp.mail.superhuman.com/mcp";
const MCP_AUTH_BASE = join(process.env.HOME || "~", ".mcp-auth");
const SERVER_URL_HASH = createHash("md5").update(MCP_SERVER_URL).digest("hex");
const TOKEN_ENDPOINT = "https://mcp.auth.mail.superhuman.com/oauth2/token";

// Refresh 60s before expiry to avoid serving nearly-expired tokens
const REFRESH_BUFFER_MS = 60_000;
// Proactive refresh interval: check every 60s
const REFRESH_INTERVAL_MS = 60_000;

interface TokenState {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms
}

let state: TokenState | null = null;

async function findMcpRemoteDir(): Promise<string | null> {
  try {
    const entries = await readdir(MCP_AUTH_BASE);
    const mcpDirs = entries.filter((e) => e.startsWith("mcp-remote-")).sort().reverse();
    return mcpDirs.length > 0 ? join(MCP_AUTH_BASE, mcpDirs[0]) : null;
  } catch {
    return null;
  }
}

async function loadTokensFromDisk(): Promise<TokenState | null> {
  const dir = await findMcpRemoteDir();
  if (!dir) return null;
  try {
    const content = await readFile(join(dir, `${SERVER_URL_HASH}_tokens.json`), "utf-8");
    const tokens = JSON.parse(content);
    if (!tokens.access_token || !tokens.refresh_token) return null;
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at || Date.now() + (tokens.expires_in || 300) * 1000,
    };
  } catch {
    return null;
  }
}

async function loadClientId(): Promise<string | null> {
  const dir = await findMcpRemoteDir();
  if (!dir) return null;
  try {
    const content = await readFile(join(dir, `${SERVER_URL_HASH}_client_info.json`), "utf-8");
    return JSON.parse(content).client_id || null;
  } catch {
    return null;
  }
}

async function saveToDisk(tokens: TokenState): Promise<void> {
  const dir = await findMcpRemoteDir();
  if (!dir) return;
  await writeFile(
    join(dir, `${SERVER_URL_HASH}_tokens.json`),
    JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: "bearer",
      expires_in: Math.max(0, Math.floor((tokens.expires_at - Date.now()) / 1000)),
      expires_at: tokens.expires_at,
    }, null, 2)
  );
}

async function refreshToken(): Promise<boolean> {
  if (!state?.refresh_token) return false;
  const clientId = await loadClientId();
  if (!clientId) {
    console.error("[relay] No client_id found");
    return false;
  }

  try {
    const resp = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: state.refresh_token,
        client_id: clientId,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[relay] Refresh failed (${resp.status}): ${text}`);
      return false;
    }

    const data = await resp.json() as any;
    state = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 300) * 1000,
    };

    await saveToDisk(state);
    const expiresIn = Math.floor((state.expires_at - Date.now()) / 1000);
    console.log(`[relay] Token refreshed, expires in ${expiresIn}s`);
    return true;
  } catch (e: any) {
    console.error(`[relay] Refresh error: ${e.message}`);
    return false;
  }
}

async function ensureFreshToken(): Promise<TokenState | null> {
  if (!state) {
    state = await loadTokensFromDisk();
    if (!state) return null;
  }

  if (Date.now() > state.expires_at - REFRESH_BUFFER_MS) {
    const ok = await refreshToken();
    if (!ok) return null;
  }

  return state;
}

// Parse --port flag
const portArg = process.argv.find((a) => a.startsWith("--port"));
const port = portArg ? parseInt(portArg.split("=")[1] || process.argv[process.argv.indexOf(portArg) + 1]) : 9401;

// Load initial tokens
state = await loadTokensFromDisk();
if (state) {
  console.log(`[relay] Loaded tokens (expires in ${Math.floor((state.expires_at - Date.now()) / 1000)}s)`);
  // Refresh immediately if expired
  if (Date.now() > state.expires_at - REFRESH_BUFFER_MS) {
    await refreshToken();
  }
} else {
  console.error("[relay] No MCP tokens found. Run 'superhuman account auth' first.");
}

// Proactive refresh loop
setInterval(async () => {
  if (state && Date.now() > state.expires_at - REFRESH_BUFFER_MS) {
    await refreshToken();
  }
}, REFRESH_INTERVAL_MS);

Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/token") {
      if (!state?.access_token) {
        return Response.json({ error: "no_token" }, { status: 503 });
      }
      return Response.json({
        access_token: state.access_token,
        expires_at: state.expires_at,
      });
    }

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        has_token: !!state?.access_token,
        expires_in: state ? Math.max(0, Math.floor((state.expires_at - Date.now()) / 1000)) : 0,
      });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

console.log(`[relay] Token relay listening on http://localhost:${port}`);
