// SQLite-backed persistence. Survives server restarts.
// Same exported API as the previous in-memory version, so callers don't change.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = process.env.DATA_DB_PATH || path.join(__dirname, "data.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    lang TEXT NOT NULL,
    visitor_meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    name TEXT,
    email TEXT,
    phone TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);

  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    visitor_name TEXT,
    visitor_contact TEXT,
    property_ref TEXT,
    requested_time TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_appointments_created ON appointments(created_at DESC);

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    broker_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'google',
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    scope TEXT,
    account_email TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS listings (
    id             TEXT PRIMARY KEY,
    mls_number     TEXT,
    list_type      TEXT NOT NULL DEFAULT 'for_sale',
    status         TEXT NOT NULL DEFAULT 'active',
    street_address TEXT NOT NULL,
    city           TEXT NOT NULL,
    state          TEXT NOT NULL,
    zip_code       TEXT,
    price          REAL,
    bedrooms       REAL,
    bathrooms      REAL,
    area_sqft      REAL,
    lot_size_sqft  REAL,
    description    TEXT,
    features       TEXT NOT NULL DEFAULT '[]',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, list_type);

  CREATE TABLE IF NOT EXISTS sms_reminders (
    id              TEXT PRIMARY KEY,
    appointment_id  TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    phone           TEXT NOT NULL,
    sent_at         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'sent',
    twilio_sid      TEXT,
    slots           TEXT NOT NULL DEFAULT '[]',
    reply_received_at TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sms_appt ON sms_reminders(appointment_id);
  CREATE INDEX IF NOT EXISTS idx_sms_phone ON sms_reminders(phone);

  CREATE TABLE IF NOT EXISTS property_tracks (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    listing_id TEXT REFERENCES listings(id) ON DELETE CASCADE,
    search_criteria TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tracks_lead ON property_tracks(lead_id);
  CREATE INDEX IF NOT EXISTS idx_tracks_listing ON property_tracks(listing_id);

  CREATE TABLE IF NOT EXISTS lead_scores (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
    score INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'cold',
    has_budget INTEGER DEFAULT 0,
    has_timeline INTEGER DEFAULT 0,
    has_phone INTEGER DEFAULT 0,
    booked_appointment INTEGER DEFAULT 0,
    property_interest_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lead_scores_tier ON lead_scores(tier);
  CREATE INDEX IF NOT EXISTS idx_lead_scores_score ON lead_scores(score DESC);

  CREATE TABLE IF NOT EXISTS follow_ups (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    message_type TEXT NOT NULL,
    message_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    scheduled_for TEXT NOT NULL,
    sent_at TEXT,
    no_reply_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_follow_ups_lead ON follow_ups(lead_id);
  CREATE INDEX IF NOT EXISTS idx_follow_ups_status ON follow_ups(status, scheduled_for);
`);

// Lightweight migrations for columns added after the initial schema. SQLite
// CREATE TABLE IF NOT EXISTS does not retroactively add columns to existing tables.
const appointmentCols = new Set(
  db.prepare("PRAGMA table_info(appointments)").all().map((c) => c.name)
);
for (const [col, ddl] of [
  ["confirmed_start", "TEXT"],
  ["confirmed_end", "TEXT"],
  ["google_event_id", "TEXT"],
  ["calendar_html_link", "TEXT"],
]) {
  if (!appointmentCols.has(col)) {
    db.exec(`ALTER TABLE appointments ADD COLUMN ${col} ${ddl}`);
  }
}

function now() {
  return new Date().toISOString();
}

const stmts = {
  insertConversation: db.prepare(
    `INSERT INTO conversations (id, lang, visitor_meta, created_at, last_activity_at)
     VALUES (@id, @lang, @visitor_meta, @created_at, @last_activity_at)`
  ),
  selectConversation: db.prepare(
    `SELECT id, lang, visitor_meta, created_at, last_activity_at
       FROM conversations WHERE id = ?`
  ),
  selectAllConversations: db.prepare(
    `SELECT id, lang, visitor_meta, created_at, last_activity_at
       FROM conversations ORDER BY last_activity_at DESC`
  ),
  updateConversationActivity: db.prepare(
    `UPDATE conversations SET last_activity_at = ? WHERE id = ?`
  ),
  updateConversationMeta: db.prepare(
    `UPDATE conversations SET visitor_meta = ?, last_activity_at = ? WHERE id = ?`
  ),
  insertMessage: db.prepare(
    `INSERT INTO messages (conversation_id, role, content, at)
     VALUES (?, ?, ?, ?)`
  ),
  selectMessages: db.prepare(
    `SELECT role, content, at FROM messages WHERE conversation_id = ? ORDER BY id ASC`
  ),
  countMessages: db.prepare(
    `SELECT conversation_id, COUNT(*) AS n FROM messages GROUP BY conversation_id`
  ),
  insertLead: db.prepare(
    `INSERT INTO leads (id, conversation_id, name, email, phone, notes, created_at)
     VALUES (@id, @conversation_id, @name, @email, @phone, @notes, @created_at)`
  ),
  selectAllLeads: db.prepare(
    `SELECT id, conversation_id, name, email, phone, notes, created_at
       FROM leads ORDER BY created_at DESC`
  ),
  insertAppointment: db.prepare(
    `INSERT INTO appointments
       (id, conversation_id, visitor_name, visitor_contact, property_ref,
        requested_time, notes, status, created_at, updated_at)
     VALUES
       (@id, @conversation_id, @visitor_name, @visitor_contact, @property_ref,
        @requested_time, @notes, @status, @created_at, @updated_at)`
  ),
  selectAppointment: db.prepare(`SELECT * FROM appointments WHERE id = ?`),
  selectAllAppointments: db.prepare(
    `SELECT id, conversation_id, visitor_name, visitor_contact, property_ref,
            requested_time, notes, status, confirmed_start, confirmed_end,
            google_event_id, calendar_html_link, created_at, updated_at
       FROM appointments ORDER BY created_at DESC`
  ),
  updateAppointmentStatus: db.prepare(
    `UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?`
  ),
  updateAppointmentConfirmed: db.prepare(
    `UPDATE appointments
        SET status = 'confirmed',
            confirmed_start = @confirmed_start,
            confirmed_end = @confirmed_end,
            google_event_id = @google_event_id,
            calendar_html_link = @calendar_html_link,
            updated_at = @updated_at
      WHERE id = @id`
  ),
  clearAppointmentEvent: db.prepare(
    `UPDATE appointments
        SET google_event_id = NULL, calendar_html_link = NULL, updated_at = ?
      WHERE id = ?`
  ),
  selectOAuthTokens: db.prepare(
    `SELECT broker_id, provider, access_token, refresh_token, expires_at,
            scope, account_email, created_at, updated_at
       FROM oauth_tokens WHERE broker_id = ?`
  ),
  upsertOAuthTokens: db.prepare(
    `INSERT INTO oauth_tokens
       (broker_id, provider, access_token, refresh_token, expires_at, scope,
        account_email, created_at, updated_at)
     VALUES
       (@broker_id, @provider, @access_token, @refresh_token, @expires_at,
        @scope, @account_email, @created_at, @updated_at)
     ON CONFLICT(broker_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       account_email = COALESCE(excluded.account_email, oauth_tokens.account_email),
       updated_at = excluded.updated_at`
  ),
  deleteOAuthTokens: db.prepare(`DELETE FROM oauth_tokens WHERE broker_id = ?`),
  countConversations: db.prepare(`SELECT COUNT(*) AS n FROM conversations`),
  countLeads: db.prepare(`SELECT COUNT(*) AS n FROM leads`),
  countAppointments: db.prepare(`SELECT COUNT(*) AS n FROM appointments`),
  countListings: db.prepare(`SELECT COUNT(*) AS n FROM listings WHERE status = 'active'`),
  countPropertyTracks: db.prepare(`SELECT COUNT(*) AS n FROM property_tracks`),

  // Property Tracking
  insertPropertyTrack: db.prepare(
    `INSERT INTO property_tracks
       (id, lead_id, listing_id, search_criteria, status, created_at, updated_at)
     VALUES
       (@id, @lead_id, @listing_id, @search_criteria, @status, @created_at, @updated_at)`
  ),
  selectPropertyTrack: db.prepare(`SELECT * FROM property_tracks WHERE id = ?`),
  selectAllPropertyTracks: db.prepare(
    `SELECT t.*, l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email,
            lst.street_address, lst.city, lst.state, lst.price, lst.list_type
       FROM property_tracks t
       JOIN leads l ON l.id = t.lead_id
       LEFT JOIN listings lst ON lst.id = t.listing_id
      ORDER BY t.created_at DESC`
  ),
  selectPropertyTracksByLead: db.prepare(
    `SELECT * FROM property_tracks WHERE lead_id = ? ORDER BY created_at DESC`
  ),
  selectPropertyTracksByListing: db.prepare(
    `SELECT t.*, l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email
       FROM property_tracks t
       JOIN leads l ON l.id = t.lead_id
      WHERE t.listing_id = ? AND t.status = 'active'`
  ),
  selectActiveKriterTracks: db.prepare(
    `SELECT t.*, l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email
       FROM property_tracks t
       JOIN leads l ON l.id = t.lead_id
      WHERE t.listing_id IS NULL AND t.status = 'active'`
  ),
  updatePropertyTrackStatus: db.prepare(
    `UPDATE property_tracks SET status = ?, updated_at = ? WHERE id = ?`
  ),
  deletePropertyTrack: db.prepare(`DELETE FROM property_tracks WHERE id = ?`),

  // Listings
  insertListing: db.prepare(
    `INSERT INTO listings
       (id, mls_number, list_type, status, street_address, city, state, zip_code,
        price, bedrooms, bathrooms, area_sqft, lot_size_sqft, description, features,
        created_at, updated_at)
     VALUES
       (@id, @mls_number, @list_type, @status, @street_address, @city, @state, @zip_code,
        @price, @bedrooms, @bathrooms, @area_sqft, @lot_size_sqft, @description, @features,
        @created_at, @updated_at)`
  ),
  selectListing: db.prepare(`SELECT * FROM listings WHERE id = ?`),
  selectAllListings: db.prepare(
    `SELECT * FROM listings ORDER BY created_at DESC`
  ),
  selectActiveListings: db.prepare(
    `SELECT * FROM listings WHERE status = 'active' ORDER BY created_at DESC`
  ),
  updateListing: db.prepare(
    `UPDATE listings SET
       mls_number=@mls_number, list_type=@list_type, status=@status,
       street_address=@street_address, city=@city, state=@state, zip_code=@zip_code,
       price=@price, bedrooms=@bedrooms, bathrooms=@bathrooms,
       area_sqft=@area_sqft, lot_size_sqft=@lot_size_sqft,
       description=@description, features=@features, updated_at=@updated_at
     WHERE id=@id`
  ),
  deleteListing: db.prepare(`DELETE FROM listings WHERE id = ?`),

  // SMS reminders
  insertSmsReminder: db.prepare(
    `INSERT INTO sms_reminders
       (id, appointment_id, phone, sent_at, status, twilio_sid, slots, created_at)
     VALUES
       (@id, @appointment_id, @phone, @sent_at, @status, @twilio_sid, @slots, @created_at)`
  ),
  selectSmsReminderByAppt: db.prepare(
    `SELECT * FROM sms_reminders WHERE appointment_id = ? ORDER BY created_at DESC LIMIT 1`
  ),
  selectSmsReminderByPhone: db.prepare(
    `SELECT r.*, a.visitor_name, a.visitor_contact, a.property_ref,
            a.confirmed_start, a.confirmed_end, a.requested_time
       FROM sms_reminders r
       JOIN appointments a ON a.id = r.appointment_id
      WHERE r.phone = ?
        AND r.status IN ('sent','rescheduling')
      ORDER BY r.created_at DESC LIMIT 1`
  ),
  selectPendingRescheduleSms: db.prepare(
    `SELECT r.*, a.visitor_name, a.visitor_contact, a.property_ref,
            a.confirmed_start, a.confirmed_end, a.requested_time
       FROM sms_reminders r
       JOIN appointments a ON a.id = r.appointment_id
      WHERE r.phone = ? AND r.status = 'rescheduling'
      ORDER BY r.created_at DESC LIMIT 1`
  ),
  updateSmsReminderStatus: db.prepare(
    `UPDATE sms_reminders SET status=?, reply_received_at=? WHERE id=?`
  ),
  updateSmsReminderSlots: db.prepare(
    `UPDATE sms_reminders SET slots=?, status='rescheduling' WHERE id=?`
  ),
  selectConfirmedAppointmentsInWindow: db.prepare(
    `SELECT * FROM appointments
      WHERE status = 'confirmed'
        AND confirmed_start >= ?
        AND confirmed_start < ?
      ORDER BY confirmed_start ASC`
  ),

  // Lead Scores
  upsertLeadScore: db.prepare(
    `INSERT INTO lead_scores
       (id, lead_id, score, tier, has_budget, has_timeline, has_phone,
        booked_appointment, property_interest_count, created_at, updated_at)
     VALUES
       (@id, @lead_id, @score, @tier, @has_budget, @has_timeline, @has_phone,
        @booked_appointment, @property_interest_count, @created_at, @updated_at)
     ON CONFLICT(lead_id) DO UPDATE SET
       score = excluded.score,
       tier = excluded.tier,
       has_budget = excluded.has_budget,
       has_timeline = excluded.has_timeline,
       has_phone = excluded.has_phone,
       booked_appointment = excluded.booked_appointment,
       property_interest_count = excluded.property_interest_count,
       updated_at = excluded.updated_at`
  ),
  selectLeadScoreByLeadId: db.prepare(
    `SELECT * FROM lead_scores WHERE lead_id = ?`
  ),
  selectAllLeadScores: db.prepare(
    `SELECT ls.*, l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email,
            l.conversation_id, l.created_at AS lead_created_at
       FROM lead_scores ls
       JOIN leads l ON l.id = ls.lead_id
      ORDER BY ls.score DESC`
  ),
  countLeadScoresByTier: db.prepare(
    `SELECT tier, COUNT(*) AS n FROM lead_scores GROUP BY tier`
  ),

  // Follow-ups
  insertFollowUp: db.prepare(
    `INSERT INTO follow_ups
       (id, lead_id, phone, message_type, message_text, status, scheduled_for, no_reply_count, created_at)
     VALUES
       (@id, @lead_id, @phone, @message_type, @message_text, @status, @scheduled_for, 0, @created_at)`
  ),
  selectDueFollowUps: db.prepare(
    `SELECT f.*, l.name AS lead_name
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
      WHERE f.status = 'scheduled'
        AND f.scheduled_for <= ?
      ORDER BY f.scheduled_for ASC
      LIMIT 50`
  ),
  selectFollowUpsByLead: db.prepare(
    `SELECT * FROM follow_ups WHERE lead_id = ? ORDER BY scheduled_for ASC`
  ),
  selectAllFollowUps: db.prepare(
    `SELECT f.*, l.name AS lead_name, l.phone AS lead_phone
       FROM follow_ups f
       JOIN leads l ON l.id = f.lead_id
      ORDER BY f.scheduled_for DESC
      LIMIT 200`
  ),
  updateFollowUpStatus: db.prepare(
    `UPDATE follow_ups SET status = ?, sent_at = ? WHERE id = ?`
  ),
  updateFollowUpNoReply: db.prepare(
    `UPDATE follow_ups SET no_reply_count = no_reply_count + 1 WHERE id = ?`
  ),
  stopFollowUpsForLead: db.prepare(
    `UPDATE follow_ups SET status = 'stopped' WHERE lead_id = ? AND status = 'scheduled'`
  ),
  resetNoReplyForLead: db.prepare(
    `UPDATE follow_ups SET no_reply_count = 0 WHERE lead_id = ? AND status = 'scheduled'`
  ),
  countFollowUpsByStatus: db.prepare(
    `SELECT status, COUNT(*) AS n FROM follow_ups GROUP BY status`
  ),
};

function rowToConversation(row, messages) {
  return {
    id: row.id,
    lang: row.lang,
    visitorMeta: JSON.parse(row.visitor_meta || "{}"),
    messages,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
}

function rowToLead(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function rowToAppointment(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    visitorName: row.visitor_name,
    visitorContact: row.visitor_contact,
    propertyRef: row.property_ref,
    requestedTime: row.requested_time,
    notes: row.notes,
    status: row.status,
    confirmedStart: row.confirmed_start ?? null,
    confirmedEnd: row.confirmed_end ?? null,
    googleEventId: row.google_event_id ?? null,
    calendarHtmlLink: row.calendar_html_link ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToOAuthTokens(row) {
  return {
    brokerId: row.broker_id,
    provider: row.provider,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
    scope: row.scope,
    accountEmail: row.account_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createConversation({ lang = "en", visitorMeta = {} } = {}) {
  const id = randomUUID();
  const t = now();
  stmts.insertConversation.run({
    id,
    lang,
    visitor_meta: JSON.stringify(visitorMeta),
    created_at: t,
    last_activity_at: t,
  });
  return {
    id,
    lang,
    visitorMeta,
    messages: [],
    createdAt: t,
    lastActivityAt: t,
  };
}

export function getConversation(id) {
  const row = stmts.selectConversation.get(id);
  if (!row) return null;
  const messages = stmts.selectMessages.all(id);
  return rowToConversation(row, messages);
}

export function appendMessage(conversationId, { role, content }) {
  const exists = stmts.selectConversation.get(conversationId);
  if (!exists) throw new Error(`Unknown conversation: ${conversationId}`);
  const at = now();
  stmts.insertMessage.run(conversationId, role, content, at);
  stmts.updateConversationActivity.run(at, conversationId);
  return { role, content, at };
}

export function updateConversationMeta(conversationId, patch) {
  const row = stmts.selectConversation.get(conversationId);
  if (!row) throw new Error(`Unknown conversation: ${conversationId}`);
  const merged = { ...JSON.parse(row.visitor_meta || "{}"), ...patch };
  const t = now();
  stmts.updateConversationMeta.run(JSON.stringify(merged), t, conversationId);
  return {
    id: row.id,
    lang: row.lang,
    visitorMeta: merged,
    messages: stmts.selectMessages.all(conversationId),
    createdAt: row.created_at,
    lastActivityAt: t,
  };
}

export function listConversations() {
  const rows = stmts.selectAllConversations.all();
  if (rows.length === 0) return [];
  const messagesByConv = new Map();
  for (const row of rows) {
    messagesByConv.set(row.id, stmts.selectMessages.all(row.id));
  }
  return rows.map((row) => rowToConversation(row, messagesByConv.get(row.id)));
}

export function createLead({ conversationId, name, email, phone, notes }) {
  const id = randomUUID();
  const created_at = now();
  stmts.insertLead.run({
    id,
    conversation_id: conversationId ?? null,
    name: name ?? null,
    email: email ?? null,
    phone: phone ?? null,
    notes: notes ?? null,
    created_at,
  });
  return {
    id,
    conversationId: conversationId ?? null,
    name: name ?? null,
    email: email ?? null,
    phone: phone ?? null,
    notes: notes ?? null,
    createdAt: created_at,
  };
}

export function listLeads() {
  return stmts.selectAllLeads.all().map(rowToLead);
}

export function createAppointment({
  conversationId,
  visitorName,
  visitorContact,
  propertyRef,
  requestedTime,
  notes,
}) {
  const id = randomUUID();
  const t = now();
  stmts.insertAppointment.run({
    id,
    conversation_id: conversationId ?? null,
    visitor_name: visitorName ?? null,
    visitor_contact: visitorContact ?? null,
    property_ref: propertyRef ?? null,
    requested_time: requestedTime ?? null,
    notes: notes ?? null,
    status: "pending",
    created_at: t,
    updated_at: t,
  });
  return {
    id,
    conversationId: conversationId ?? null,
    visitorName: visitorName ?? null,
    visitorContact: visitorContact ?? null,
    propertyRef: propertyRef ?? null,
    requestedTime: requestedTime ?? null,
    notes: notes ?? null,
    status: "pending",
    createdAt: t,
    updatedAt: t,
  };
}

export function getAppointment(id) {
  const row = stmts.selectAppointment.get(id);
  return row ? rowToAppointment(row) : null;
}

export function updateAppointmentStatus(id, status) {
  const allowed = ["pending", "confirmed", "declined", "cancelled"];
  if (!allowed.includes(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const existing = stmts.selectAppointment.get(id);
  if (!existing) throw new Error(`Unknown appointment: ${id}`);
  const t = now();
  stmts.updateAppointmentStatus.run(status, t, id);
  return rowToAppointment(stmts.selectAppointment.get(id));
}

export function confirmAppointmentWithEvent(id, {
  confirmedStart,
  confirmedEnd,
  googleEventId,
  calendarHtmlLink,
}) {
  const existing = stmts.selectAppointment.get(id);
  if (!existing) throw new Error(`Unknown appointment: ${id}`);
  stmts.updateAppointmentConfirmed.run({
    id,
    confirmed_start: confirmedStart ?? null,
    confirmed_end: confirmedEnd ?? null,
    google_event_id: googleEventId ?? null,
    calendar_html_link: calendarHtmlLink ?? null,
    updated_at: now(),
  });
  return rowToAppointment(stmts.selectAppointment.get(id));
}

export function clearAppointmentCalendarEvent(id) {
  stmts.clearAppointmentEvent.run(now(), id);
}

export function listAppointments() {
  return stmts.selectAllAppointments.all().map(rowToAppointment);
}

export function getOAuthTokens(brokerId) {
  const row = stmts.selectOAuthTokens.get(brokerId);
  return row ? rowToOAuthTokens(row) : null;
}

export function saveOAuthTokens({
  brokerId,
  provider = "google",
  accessToken,
  refreshToken,
  expiresAt,
  scope,
  accountEmail,
}) {
  const t = now();
  stmts.upsertOAuthTokens.run({
    broker_id: brokerId,
    provider,
    access_token: accessToken ?? null,
    refresh_token: refreshToken ?? null,
    expires_at: expiresAt ?? null,
    scope: scope ?? null,
    account_email: accountEmail ?? null,
    created_at: t,
    updated_at: t,
  });
  return rowToOAuthTokens(stmts.selectOAuthTokens.get(brokerId));
}

export function clearOAuthTokens(brokerId) {
  stmts.deleteOAuthTokens.run(brokerId);
}

export function stats() {
  return {
    conversations: stmts.countConversations.get().n,
    leads: stmts.countLeads.get().n,
    appointments: stmts.countAppointments.get().n,
    listings: stmts.countListings.get().n,
    propertyTracks: stmts.countPropertyTracks.get().n,
  };
}

// ─────────────────────────────────────────────
// Listings
// ─────────────────────────────────────────────

function rowToListing(row) {
  return {
    id: row.id,
    mlsNumber: row.mls_number ?? null,
    listType: row.list_type,
    status: row.status,
    streetAddress: row.street_address,
    city: row.city,
    state: row.state,
    zipCode: row.zip_code ?? null,
    price: row.price ?? null,
    bedrooms: row.bedrooms ?? null,
    bathrooms: row.bathrooms ?? null,
    areaSqft: row.area_sqft ?? null,
    lotSizeSqft: row.lot_size_sqft ?? null,
    description: row.description ?? null,
    features: JSON.parse(row.features || "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createListing(data) {
  const id = randomUUID();
  const t = now();
  stmts.insertListing.run({
    id,
    mls_number: data.mlsNumber ?? null,
    list_type: data.listType ?? "for_sale",
    status: data.status ?? "active",
    street_address: data.streetAddress,
    city: data.city,
    state: data.state,
    zip_code: data.zipCode ?? null,
    price: data.price ?? null,
    bedrooms: data.bedrooms ?? null,
    bathrooms: data.bathrooms ?? null,
    area_sqft: data.areaSqft ?? null,
    lot_size_sqft: data.lotSizeSqft ?? null,
    description: data.description ?? null,
    features: JSON.stringify(data.features ?? []),
    created_at: t,
    updated_at: t,
  });
  return rowToListing(stmts.selectListing.get(id));
}

export function getListing(id) {
  const row = stmts.selectListing.get(id);
  return row ? rowToListing(row) : null;
}

export function updateListing(id, patch) {
  const existing = stmts.selectListing.get(id);
  if (!existing) throw new Error(`Unknown listing: ${id}`);
  const merged = { ...existing, ...patch };
  stmts.updateListing.run({
    id,
    mls_number: merged.mls_number ?? patch.mlsNumber ?? null,
    list_type: merged.list_type ?? patch.listType ?? "for_sale",
    status: merged.status ?? patch.status ?? "active",
    street_address: merged.street_address ?? patch.streetAddress,
    city: merged.city ?? patch.city,
    state: merged.state ?? patch.state,
    zip_code: merged.zip_code ?? patch.zipCode ?? null,
    price: merged.price ?? patch.price ?? null,
    bedrooms: merged.bedrooms ?? patch.bedrooms ?? null,
    bathrooms: merged.bathrooms ?? patch.bathrooms ?? null,
    area_sqft: merged.area_sqft ?? patch.areaSqft ?? null,
    lot_size_sqft: merged.lot_size_sqft ?? patch.lotSizeSqft ?? null,
    description: merged.description ?? patch.description ?? null,
    features: JSON.stringify(
      patch.features ?? JSON.parse(merged.features || "[]")
    ),
    updated_at: now(),
  });
  return rowToListing(stmts.selectListing.get(id));
}

export function deleteListing(id) {
  stmts.deleteListing.run(id);
}

export function listListings() {
  return stmts.selectAllListings.all().map(rowToListing);
}

/** Returns only active listings — used by the matcher. */
export function searchListings() {
  return stmts.selectActiveListings.all().map(rowToListing);
}

// ─────────────────────────────────────────────
// SMS Reminders
// ─────────────────────────────────────────────

function rowToSmsReminder(row) {
  const reminder = {
    id: row.id,
    appointmentId: row.appointment_id,
    phone: row.phone,
    sentAt: row.sent_at,
    status: row.status,
    twilioSid: row.twilio_sid ?? null,
    slots: JSON.parse(row.slots || "[]"),
    replyReceivedAt: row.reply_received_at ?? null,
    createdAt: row.created_at,
  };
  // Attach appointment data if present (from JOIN queries)
  if (row.visitor_name !== undefined) {
    reminder._appt = {
      visitorName: row.visitor_name,
      visitorContact: row.visitor_contact,
      propertyRef: row.property_ref,
      confirmedStart: row.confirmed_start ?? null,
      confirmedEnd: row.confirmed_end ?? null,
      requestedTime: row.requested_time ?? null,
    };
  }
  return reminder;
}

export function createSmsReminder({ appointmentId, phone, twilioSid, status, slots }) {
  const id = randomUUID();
  const t = now();
  stmts.insertSmsReminder.run({
    id,
    appointment_id: appointmentId,
    phone,
    sent_at: t,
    status: status ?? "sent",
    twilio_sid: twilioSid ?? null,
    slots: JSON.stringify(slots ?? []),
    created_at: t,
  });
  return rowToSmsReminder(stmts.selectSmsReminderByAppt.get(appointmentId));
}

export function getSmsReminderByAppointment(appointmentId) {
  const row = stmts.selectSmsReminderByAppt.get(appointmentId);
  return row ? rowToSmsReminder(row) : null;
}

export function getSmsReminderByPhone(phone) {
  const row = stmts.selectSmsReminderByPhone.get(phone);
  return row ? rowToSmsReminder(row) : null;
}

export function getPendingRescheduleSms(phone) {
  const row = stmts.selectPendingRescheduleSms.get(phone);
  return row ? rowToSmsReminder(row) : null;
}

export function updateSmsReminderStatus(id, status) {
  stmts.updateSmsReminderStatus.run(status, now(), id);
}

export function updateSmsReminderRescheduleChoice(id, { slots }) {
  stmts.updateSmsReminderSlots.run(JSON.stringify(slots ?? []), id);
}

/** Used by the cron scheduler to find appointments needing reminders. */
export function listConfirmedAppointmentsInWindow(startIso, endIso) {
  return stmts.selectConfirmedAppointmentsInWindow
    .all(startIso, endIso)
    .map(rowToAppointment);
}

// ─────────────────────────────────────────────
// Property Tracking
// ─────────────────────────────────────────────

function rowToPropertyTrack(row) {
  return {
    id: row.id,
    leadId: row.lead_id,
    listingId: row.listing_id ?? null,
    searchCriteria: JSON.parse(row.search_criteria || "{}"),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    leadName: row.lead_name ?? null,
    leadPhone: row.lead_phone ?? null,
    leadEmail: row.lead_email ?? null,
    streetAddress: row.street_address ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    price: row.price ?? null,
    listType: row.list_type ?? null,
  };
}

export function createPropertyTrack({ leadId, listingId, searchCriteria = {}, status = "active" }) {
  const id = randomUUID();
  const t = now();
  stmts.insertPropertyTrack.run({
    id,
    lead_id: leadId,
    listing_id: listingId ?? null,
    search_criteria: JSON.stringify(searchCriteria),
    status,
    created_at: t,
    updated_at: t,
  });
  return getPropertyTrack(id);
}

export function getPropertyTrack(id) {
  const row = stmts.selectPropertyTrack.get(id);
  if (!row) return null;
  return rowToPropertyTrack(row);
}

export function listPropertyTracks() {
  return stmts.selectAllPropertyTracks.all().map(rowToPropertyTrack);
}

export function listPropertyTracksByLead(leadId) {
  return stmts.selectPropertyTracksByLead.all(leadId).map(rowToPropertyTrack);
}

export function listPropertyTracksByListing(listingId) {
  return stmts.selectPropertyTracksByListing.all(listingId).map(rowToPropertyTrack);
}

export function listActiveKriterTracks() {
  return stmts.selectActiveKriterTracks.all().map(rowToPropertyTrack);
}

export function updatePropertyTrackStatus(id, status) {
  const t = now();
  stmts.updatePropertyTrackStatus.run(status, t, id);
  return getPropertyTrack(id);
}

export function deletePropertyTrack(id) {
  stmts.deletePropertyTrack.run(id);
}

// ─────────────────────────────────────────────
// Lead Scores
// ─────────────────────────────────────────────

function rowToLeadScore(row) {
  return {
    id: row.id,
    leadId: row.lead_id,
    score: row.score,
    tier: row.tier,
    hasBudget: row.has_budget,
    hasTimeline: row.has_timeline,
    hasPhone: row.has_phone,
    bookedAppointment: row.booked_appointment,
    propertyInterestCount: row.property_interest_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Joined fields (if present)
    leadName: row.lead_name ?? null,
    leadPhone: row.lead_phone ?? null,
    leadEmail: row.lead_email ?? null,
    conversationId: row.conversation_id ?? null,
    leadCreatedAt: row.lead_created_at ?? null,
  };
}

export function upsertLeadScore({
  leadId, score, tier, hasBudget = 0, hasTimeline = 0,
  hasPhone = 0, bookedAppointment = 0, propertyInterestCount = 0,
}) {
  const id = randomUUID();
  const t = now();
  stmts.upsertLeadScore.run({
    id,
    lead_id: leadId,
    score,
    tier,
    has_budget: hasBudget,
    has_timeline: hasTimeline,
    has_phone: hasPhone,
    booked_appointment: bookedAppointment,
    property_interest_count: propertyInterestCount,
    created_at: t,
    updated_at: t,
  });
  return getLeadScoreByLeadId(leadId);
}

export function getLeadScoreByLeadId(leadId) {
  const row = stmts.selectLeadScoreByLeadId.get(leadId);
  return row ? rowToLeadScore(row) : null;
}

export function listLeadScoresWithLeads() {
  return stmts.selectAllLeadScores.all().map(rowToLeadScore);
}

export function getLeadScoreStats() {
  const rows = stmts.countLeadScoresByTier.all();
  const result = { hot: 0, warm: 0, cold: 0 };
  for (const row of rows) {
    result[row.tier] = row.n;
  }
  return result;
}

// ─────────────────────────────────────────────
// Follow-Ups
// ─────────────────────────────────────────────

function rowToFollowUp(row) {
  return {
    id: row.id,
    leadId: row.lead_id,
    phone: row.phone,
    messageType: row.message_type,
    messageText: row.message_text,
    status: row.status,
    scheduledFor: row.scheduled_for,
    sentAt: row.sent_at ?? null,
    noReplyCount: row.no_reply_count ?? 0,
    createdAt: row.created_at,
    leadName: row.lead_name ?? null,
    leadPhone: row.lead_phone ?? null,
  };
}

export function createFollowUp({ leadId, phone, messageType, messageText, scheduledFor }) {
  const id = randomUUID();
  const t = now();
  stmts.insertFollowUp.run({
    id,
    lead_id: leadId,
    phone,
    message_type: messageType,
    message_text: messageText,
    status: "scheduled",
    scheduled_for: scheduledFor,
    created_at: t,
  });
  return { id, leadId, phone, messageType, messageText, status: "scheduled", scheduledFor, createdAt: t };
}

export function listDueFollowUps(beforeIso) {
  return stmts.selectDueFollowUps.all(beforeIso).map(rowToFollowUp);
}

export function listFollowUpsByLead(leadId) {
  return stmts.selectFollowUpsByLead.all(leadId).map(rowToFollowUp);
}

export function listAllFollowUps() {
  return stmts.selectAllFollowUps.all().map(rowToFollowUp);
}

export function markFollowUpSent(id) {
  stmts.updateFollowUpStatus.run("sent", now(), id);
}

export function markFollowUpFailed(id) {
  stmts.updateFollowUpStatus.run("failed", now(), id);
}

export function incrementNoReplyCount(id) {
  stmts.updateFollowUpNoReply.run(id);
}

export function stopFollowUpsForLead(leadId) {
  stmts.stopFollowUpsForLead.run(leadId);
}

export function resetNoReplyForLead(leadId) {
  stmts.resetNoReplyForLead.run(leadId);
}

export function getFollowUpStats() {
  const rows = stmts.countFollowUpsByStatus.all();
  const result = { scheduled: 0, sent: 0, failed: 0, stopped: 0 };
  for (const row of rows) {
    result[row.status] = row.n;
  }
  return result;
}
