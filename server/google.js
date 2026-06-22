// Google Calendar OAuth + event management.
//
// Single-tenant for now: one broker per deployment, keyed by DEFAULT_BROKER_ID.
// When multi-broker support lands, swap the constant for the authenticated
// broker's id and the rest of the module keeps working.

import crypto from "node:crypto";
import { google } from "googleapis";
import {
  clearOAuthTokens,
  getOAuthTokens,
  saveOAuthTokens,
} from "./store.js";

const DEFAULT_BROKER_ID = "default";

// Minimal scope: calendar.events covers create/delete events AND listing them
// for conflict detection. No userinfo scope — keeps the consent screen short.
const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// ---------- Encryption (AES-256-GCM) ----------

function getEncryptionKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a 64-char hex string (32 bytes).");
  }
  return key;
}

function encrypt(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), ct.toString("base64"), tag.toString("base64")].join(":");
}

function decrypt(packed) {
  if (packed == null) return null;
  const parts = packed.split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted token");
  const [ivB64, ctB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// ---------- OAuth client setup ----------

export function isConfigured() {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_OAUTH_REDIRECT_URI &&
      process.env.TOKEN_ENCRYPTION_KEY
  );
}

function makeOAuthClient() {
  if (!isConfigured()) {
    throw new Error("Google OAuth env vars missing. See .env.example.");
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI
  );
}

// ---------- OAuth flow ----------

// Generate a one-time state token. Caller stores it (e.g. in a short-lived
// in-memory set) and verifies it on the callback to prevent CSRF.
export function generateState() {
  return crypto.randomBytes(24).toString("hex");
}

export function getAuthUrl(state) {
  const oauth = makeOAuthClient();
  return oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force refresh_token even on subsequent grants
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export async function handleOAuthCallback(code) {
  const oauth = makeOAuthClient();
  const { tokens } = await oauth.getToken(code);

  saveOAuthTokens({
    brokerId: DEFAULT_BROKER_ID,
    accessToken: encrypt(tokens.access_token ?? null),
    refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
    expiresAt: tokens.expiry_date ?? null,
    scope: tokens.scope ?? SCOPES.join(" "),
    accountEmail: null,
  });

  return { ok: true };
}

export function getConnectionStatus() {
  if (!isConfigured()) {
    return { configured: false, connected: false };
  }
  const tok = getOAuthTokens(DEFAULT_BROKER_ID);
  if (!tok) return { configured: true, connected: false };
  return {
    configured: true,
    connected: true,
    accountEmail: tok.accountEmail ?? null,
    connectedAt: tok.createdAt,
  };
}

export function disconnect() {
  clearOAuthTokens(DEFAULT_BROKER_ID);
}

async function getAuthorizedClient() {
  const tok = getOAuthTokens(DEFAULT_BROKER_ID);
  if (!tok) throw new Error("Google Calendar is not connected.");
  const oauth = makeOAuthClient();
  oauth.setCredentials({
    access_token: tok.accessToken ? decrypt(tok.accessToken) : null,
    refresh_token: tok.refreshToken ? decrypt(tok.refreshToken) : null,
    expiry_date: tok.expiresAt,
    scope: tok.scope,
  });

  // Persist refreshed tokens so the next call doesn't refresh again.
  oauth.on("tokens", (newTokens) => {
    try {
      saveOAuthTokens({
        brokerId: DEFAULT_BROKER_ID,
        accessToken: newTokens.access_token
          ? encrypt(newTokens.access_token)
          : tok.accessToken,
        refreshToken: newTokens.refresh_token
          ? encrypt(newTokens.refresh_token)
          : null, // upsert COALESCEs to keep the existing refresh token
        expiresAt: newTokens.expiry_date ?? tok.expiresAt,
        scope: newTokens.scope ?? tok.scope,
        accountEmail: tok.accountEmail,
      });
    } catch (err) {
      console.warn("[google] failed to persist refreshed tokens:", err.message);
    }
  });

  return oauth;
}

// ---------- Calendar operations ----------

// Conflict detection via events.list (works with calendar.events scope).
// Filters out events the broker has marked as "free" (transparency=transparent)
// and all-day events that span the full day without truly blocking the slot.
export async function checkConflicts({ startIso, endIso }) {
  const auth = await getAuthorizedClient();
  const cal = google.calendar({ version: "v3", auth });
  const res = await cal.events.list({
    calendarId: "primary",
    timeMin: startIso,
    timeMax: endIso,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
    showDeleted: false,
  });
  const items = (res.data.items ?? []).filter(
    (ev) => ev.status !== "cancelled" && ev.transparency !== "transparent"
  );
  return {
    hasConflict: items.length > 0,
    conflicts: items.map((ev) => ({
      summary: ev.summary ?? null,
      start: ev.start?.dateTime ?? ev.start?.date ?? null,
      end: ev.end?.dateTime ?? ev.end?.date ?? null,
    })),
  };
}

export async function createCalendarEvent({
  summary,
  description,
  startIso,
  endIso,
  attendeeEmail,
}) {
  const auth = await getAuthorizedClient();
  const cal = google.calendar({ version: "v3", auth });

  const event = {
    summary,
    description,
    start: { dateTime: startIso },
    end: { dateTime: endIso },
  };
  if (attendeeEmail) {
    event.attendees = [{ email: attendeeEmail }];
  }

  const res = await cal.events.insert({
    calendarId: "primary",
    sendUpdates: attendeeEmail ? "all" : "none",
    requestBody: event,
  });

  return {
    id: res.data.id,
    htmlLink: res.data.htmlLink ?? null,
  };
}

export async function deleteCalendarEvent(eventId) {
  if (!eventId) return;
  const auth = await getAuthorizedClient();
  const cal = google.calendar({ version: "v3", auth });
  await cal.events.delete({
    calendarId: "primary",
    eventId,
    sendUpdates: "all",
  });
}
