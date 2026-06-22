import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleChat } from "./chat.js";
import { checkNewListingAlerts, notifyPriceDrop } from "./notifier.js";
import {
  clearAppointmentCalendarEvent,
  confirmAppointmentWithEvent,
  createConversation,
  getAppointment,
  getConversation,
  listAppointments,
  listConversations,
  listLeads,
  stats,
  updateAppointmentStatus,
  // Listings
  createListing,
  getListing,
  updateListing,
  deleteListing,
  listListings,
  // Property Tracks
  createPropertyTrack,
  listPropertyTracks,
  updatePropertyTrackStatus,
  deletePropertyTrack,
} from "./store.js";
import {
  checkConflicts,
  createCalendarEvent,
  deleteCalendarEvent,
  disconnect as disconnectGoogle,
  generateState,
  getAuthUrl,
  getConnectionStatus,
  handleOAuthCallback,
  isConfigured as isGoogleConfigured,
} from "./google.js";
import { handleInboundSms, isTwilioConfigured, validateTwilioSignature, sendReminder, sendConfirmationSms } from "./sms.js";
import { startSmsScheduler } from "./sms-scheduler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

const app = express();

const allowedOrigins = (process.env.WIDGET_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin:
      allowedOrigins.length === 0
        ? true
        : (origin, cb) => {
            if (!origin || allowedOrigins.includes(origin)) cb(null, true);
            else cb(new Error(`Origin not allowed: ${origin}`));
          },
    credentials: false,
  })
);

app.use(express.json({ limit: "256kb" }));
app.use(express.static(publicDir));

function configured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    chatbotConfigured: configured(),
    googleCalendar: getConnectionStatus(),
    smsConfigured: isTwilioConfigured(),
    stats: stats(),
    time: new Date().toISOString(),
  });
});

// ---- Chat (called by the embedded widget on visitor sites) ----

app.post("/api/chat/start", (req, res) => {
  const { lang } = req.body ?? {};
  const conv = createConversation({ lang: lang || "en" });
  res.json({ conversationId: conv.id, lang: conv.lang });
});

app.post("/api/chat/message", async (req, res) => {
  const { conversationId, message } = req.body ?? {};
  if (!conversationId || typeof conversationId !== "string") {
    return res.status(400).json({ error: "'conversationId' is required." });
  }
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "'message' is required." });
  }
  const conv = getConversation(conversationId);
  if (!conv) {
    return res.status(404).json({ error: "Conversation not found." });
  }

  try {
    const result = await handleChat({
      conversationId,
      conversation: conv,
      userMessage: message.trim(),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[chat/message] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Broker dashboard read endpoints ----

app.get("/api/conversations", (_req, res) => {
  res.json({ conversations: listConversations() });
});

app.get("/api/conversations/:id", (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found." });
  res.json({ conversation: conv });
});

app.get("/api/leads", (_req, res) => {
  res.json({ leads: listLeads() });
});

app.get("/api/appointments", (_req, res) => {
  res.json({ appointments: listAppointments() });
});

app.post("/api/appointments/:id/status", async (req, res) => {
  const { status, startTime, endTime, title } = req.body ?? {};
  const id = req.params.id;

  if (!["pending", "confirmed", "declined", "cancelled"].includes(status)) {
    return res.status(400).json({ error: `Invalid status: ${status}` });
  }

  const existing = getAppointment(id);
  if (!existing) return res.status(404).json({ error: "Appointment not found." });

  try {
    if (status === "confirmed") {
      if (!startTime || !endTime) {
        return res
          .status(400)
          .json({ error: "'startTime' and 'endTime' are required when confirming." });
      }
      const startDate = new Date(startTime);
      const endDate = new Date(endTime);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return res.status(400).json({ error: "Invalid startTime or endTime." });
      }
      if (endDate <= startDate) {
        return res.status(400).json({ error: "endTime must be after startTime." });
      }

      let eventInfo = null;
      let calendarError = null;
      const gcal = getConnectionStatus();
      if (gcal.connected) {
        try {
          const summary =
            title?.trim() ||
            (existing.propertyRef
              ? `Showing: ${existing.propertyRef}`
              : `Consultation with ${existing.visitorName ?? "visitor"}`);
          const description = [
            "Property showing request via website chatbot.",
            "",
            `Visitor: ${existing.visitorName ?? "—"}`,
            `Contact: ${existing.visitorContact ?? "—"}`,
            `Property: ${existing.propertyRef ?? "—"}`,
            `Original time request: ${existing.requestedTime ?? "—"}`,
            existing.notes ? `Notes: ${existing.notes}` : null,
          ]
            .filter(Boolean)
            .join("\n");
          const attendeeEmail =
            existing.visitorContact && existing.visitorContact.includes("@")
              ? existing.visitorContact.trim()
              : null;
          eventInfo = await createCalendarEvent({
            summary,
            description,
            startIso: startDate.toISOString(),
            endIso: endDate.toISOString(),
            attendeeEmail,
          });
        } catch (err) {
          console.error("[appointments] calendar create failed:", err);
          calendarError = err.message;
        }
      }

      const appt = confirmAppointmentWithEvent(id, {
        confirmedStart: startDate.toISOString(),
        confirmedEnd: endDate.toISOString(),
        googleEventId: eventInfo?.id ?? null,
        calendarHtmlLink: eventInfo?.htmlLink ?? null,
      });

      // Send immediate confirmation SMS when broker approves manually
      try {
        await sendConfirmationSms(appt);
      } catch (err) {
        console.error("[sms] Failed to send SMS upon manual confirmation:", err);
      }

      return res.json({
        ok: true,
        appointment: appt,
        calendar: eventInfo
          ? { created: true, htmlLink: eventInfo.htmlLink }
          : { created: false, reason: gcal.connected ? "error" : "not_connected", error: calendarError },
      });
    }

    // For declined / cancelled / pending — delete any existing Calendar event so
    // the broker's calendar (and the visitor's invite) stays consistent.
    if ((status === "declined" || status === "cancelled") && existing.googleEventId) {
      try {
        await deleteCalendarEvent(existing.googleEventId);
      } catch (err) {
        console.warn("[appointments] calendar delete failed:", err.message);
      }
      clearAppointmentCalendarEvent(id);
    }

    const appt = updateAppointmentStatus(id, status);
    res.json({ ok: true, appointment: appt });
  } catch (err) {
    console.error("[appointments/status] error:", err);
    res.status(400).json({ error: err.message });
  }
});

// ---- Google Calendar OAuth + utilities ----

// Short-lived in-memory CSRF state store. Survives the OAuth round-trip but
// not server restarts — which is fine, the broker just retries connect.
const oauthStates = new Map(); // state -> expiresAt (ms)
const STATE_TTL_MS = 10 * 60 * 1000;

function pruneStates() {
  const now = Date.now();
  for (const [k, exp] of oauthStates) {
    if (exp < now) oauthStates.delete(k);
  }
}

app.get("/api/google/status", (_req, res) => {
  res.json(getConnectionStatus());
});

app.get("/api/google/oauth/start", (_req, res) => {
  if (!isGoogleConfigured()) {
    return res
      .status(503)
      .json({ error: "Google OAuth env vars missing. See .env.example." });
  }
  pruneStates();
  const state = generateState();
  oauthStates.set(state, Date.now() + STATE_TTL_MS);
  res.redirect(getAuthUrl(state));
});

app.get("/api/google/oauth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.redirect(`/?google=error&reason=${encodeURIComponent(String(error))}`);
  }
  if (!code || !state || !oauthStates.has(String(state))) {
    return res.redirect("/?google=error&reason=invalid_state");
  }
  oauthStates.delete(String(state));
  try {
    await handleOAuthCallback(String(code));
    res.redirect("/?google=connected");
  } catch (err) {
    console.error("[oauth/callback] error:", err);
    res.redirect(`/?google=error&reason=${encodeURIComponent(err.message)}`);
  }
});

app.post("/api/google/disconnect", (_req, res) => {
  disconnectGoogle();
  res.json({ ok: true });
});

app.post("/api/google/check-conflicts", async (req, res) => {
  const { startTime, endTime } = req.body ?? {};
  if (!startTime || !endTime) {
    return res.status(400).json({ error: "'startTime' and 'endTime' are required." });
  }
  const startDate = new Date(startTime);
  const endDate = new Date(endTime);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return res.status(400).json({ error: "Invalid startTime or endTime." });
  }
  if (!getConnectionStatus().connected) {
    return res.json({ checked: false, hasConflict: false, conflicts: [] });
  }
  try {
    const result = await checkConflicts({
      startIso: startDate.toISOString(),
      endIso: endDate.toISOString(),
    });
    res.json({ checked: true, ...result });
  } catch (err) {
    console.error("[check-conflicts] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ──── Listings ────
// NOTE: the catch-all 404 handler must stay below every route. There was a
// duplicate handler here before that made all routes below this point dead.
app.get("/api/listings", (_req, res) => {
  res.json({ listings: listListings() });
});

app.post("/api/listings", (req, res) => {
  const { streetAddress, city, state } = req.body ?? {};
  if (!streetAddress || !city || !state) {
    return res.status(400).json({ error: "'streetAddress', 'city', and 'state' are required." });
  }
  try {
    const listing = createListing(req.body);
    // Fire notifications asynchronously in background
    checkNewListingAlerts(listing).catch((err) =>
      console.error("[alerts] new listing criteria check failed:", err.message)
    );
    res.status(201).json({ ok: true, listing });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/listings/:id", (req, res) => {
  const listing = getListing(req.params.id);
  if (!listing) return res.status(404).json({ error: "Listing not found." });
  res.json({ listing });
});

app.put("/api/listings/:id", (req, res) => {
  const oldListing = getListing(req.params.id);
  if (!oldListing) {
    return res.status(404).json({ error: "Listing not found." });
  }
  try {
    const listing = updateListing(req.params.id, req.body);
    
    // Check if price dropped
    if (oldListing.price && listing.price && listing.price < oldListing.price) {
      notifyPriceDrop(listing, oldListing.price, listing.price).catch((err) =>
        console.error("[alerts] price drop notification failed:", err.message)
      );
    }
    
    res.json({ ok: true, listing });
  } catch (err) {
    const status = err.message.startsWith("Unknown") ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

app.delete("/api/listings/:id", (req, res) => {
  const existing = getListing(req.params.id);
  if (!existing) return res.status(404).json({ error: "Listing not found." });
  deleteListing(req.params.id);
  res.json({ ok: true });
});

// ──── Property Tracking ────
app.get("/api/tracks", (_req, res) => {
  res.json({ tracks: listPropertyTracks() });
});

app.post("/api/tracks", (req, res) => {
  const { leadId, listingId, searchCriteria } = req.body ?? {};
  if (!leadId) {
    return res.status(400).json({ error: "'leadId' is required." });
  }
  try {
    const track = createPropertyTrack({ leadId, listingId, searchCriteria });
    res.status(201).json({ ok: true, track });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/tracks/:id/status", (req, res) => {
  const { status } = req.body ?? {};
  if (!["active", "paused", "triggered"].includes(status)) {
    return res.status(400).json({ error: `Invalid status: ${status}` });
  }
  try {
    const track = updatePropertyTrackStatus(req.params.id, status);
    res.json({ ok: true, track });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/tracks/:id", (req, res) => {
  try {
    deletePropertyTrack(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ──── SMS Webhook (Twilio inbound) ────
// Twilio sends POST with form-encoded body — need urlencoded parser for this route.
app.post("/api/sms/webhook",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    // Validate Twilio signature if base URL is configured
    if (!validateTwilioSignature(req)) {
      console.warn("[sms/webhook] Invalid Twilio signature — rejected");
      return res.status(403).send("Forbidden");
    }
    const from = req.body.From || "";
    const body = req.body.Body || "";
    console.log(`[sms/webhook] Incoming from ${from}: "${body}"`);
    try {
      const result = await handleInboundSms({ from, body });
      res.type("text/xml").send(result.twimlResponse);
    } catch (err) {
      console.error("[sms/webhook] error:", err);
      res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
    }
  }
);

// ──── SMS test send (broker-triggered from Settings) ────
app.post("/api/sms/test", async (req, res) => {
  const { appointmentId } = req.body ?? {};
  if (!appointmentId) return res.status(400).json({ error: "'appointmentId' is required." });
  const appt = getAppointment(appointmentId);
  if (!appt) return res.status(404).json({ error: "Appointment not found." });
  try {
    const reminder = await sendReminder(appt);
    res.json({ ok: true, reminder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

const port = Number(process.env.PORT) || 3000;
startSmsScheduler();
app.listen(port, () => {
  console.log(`Real Estate Automation server running at http://localhost:${port}`);
  console.log(`  Broker dashboard:  http://localhost:${port}/`);
  console.log(`  Embed snippet for broker sites:`);
  console.log(`    <script src="http://localhost:${port}/widget.js" async></script>`);
  if (!configured()) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set. Create a .env file from .env.example.");
  }
  if (!isGoogleConfigured()) {
    console.warn(
      "Warning: Google Calendar OAuth is not configured. Appointment scheduling will save " +
        "to the database but won't create calendar events. See .env.example."
    );
  }
});
