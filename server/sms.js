// Twilio SMS wrapper.
// Sends appointment reminders and handles EVET/HAYIR (YES/NO) reply flow.
// All functions are no-ops when Twilio env vars are not configured,
// so the rest of the app works normally without SMS credentials.

import twilio from "twilio";
import {
  getSmsReminderByAppointment,
  createSmsReminder,
  updateSmsReminderStatus,
  getPendingRescheduleSms,
  updateSmsReminderRescheduleChoice,
} from "./store.js";

// ---------- Configuration ----------

export function isTwilioConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM_NUMBER
  );
}

function getClient() {
  if (!isTwilioConfigured()) {
    throw new Error("Twilio is not configured. See .env.example.");
  }
  return twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}

// ---------- Phone normalisation ----------
// Accepts: 5551234567, 555-123-4567, +15551234567, (555) 123-4567 etc.
// Outputs: E.164 with +1 prefix if no country code present.

export function normalisePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length > 7) return `+${digits}`; // international — pass through
  return null;
}

export function looksLikePhone(str) {
  if (!str) return false;
  const digits = str.replace(/\D/g, "");
  return digits.length >= 10;
}

// ---------- SMS content ----------

function reminderMessage(appt) {
  const when = appt.confirmedStart
    ? new Date(appt.confirmedStart).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : appt.requestedTime || "your scheduled time";

  const property = appt.propertyRef
    ? ` for ${appt.propertyRef}`
    : "";

  const name = appt.visitorName ? ` ${appt.visitorName.split(" ")[0]}` : "";

  const locationLink = appt.propertyRef 
    ? `\nLocation map: https://maps.google.com/?q=${encodeURIComponent(appt.propertyRef)}`
    : "";

  return (
    `Hi${name}! Reminder: you have a real estate appointment${property} on ${when}. ${locationLink}\n` +
    `Reply YES to confirm or NO to cancel and get alternative times. ` +
    `(Real Estate AI · Reply STOP to opt out)`
  );
}

function alternativeSlotsMessage(slots) {
  const lines = slots
    .map((s, i) => `${i + 1}) ${s.label}`)
    .join("\n");
  return (
    `No problem! Here are some alternative times:\n${lines}\n\n` +
    `Reply 1, 2, or 3 to pick a new time, or STOP to opt out.`
  );
}

function confirmationAckMessage(appt) {
  const name = appt.visitorName ? ` ${appt.visitorName.split(" ")[0]}` : "";
  return `Great${name}! Your appointment is confirmed. We look forward to seeing you soon.`;
}

function cancellationAckMessage() {
  return `Your appointment has been cancelled. We'll be in touch with new options shortly.`;
}

// ---------- Alternative slot generation ----------
// Proposes 3 slots: same time +2 days, +4 days, +7 days.
// Skips weekends for professional feel.

export function suggestAlternativeSlots(originalStartIso, count = 3) {
  const base = originalStartIso ? new Date(originalStartIso) : new Date();
  const slots = [];
  let day = new Date(base);
  let added = 0;
  let attempts = 0;

  while (added < count && attempts < 20) {
    day = new Date(day.getTime() + 2 * 24 * 60 * 60 * 1000);
    attempts++;
    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends

    const label = day.toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    slots.push({ iso: day.toISOString(), label });
    added++;
  }

  return slots;
}

// ---------- Send reminder ----------

/**
 * Send a 3-hour-before SMS reminder for the given appointment.
 * Creates a sms_reminders row to prevent duplicate sends.
 * Returns the reminder record, or null if skipped.
 */
export async function sendReminder(appt) {
  if (!isTwilioConfigured()) {
    console.warn("[sms] Twilio not configured — skipping reminder for", appt.id);
    return null;
  }

  const phone = normalisePhone(appt.visitorContact);
  if (!phone) {
    console.warn("[sms] No valid phone for appointment", appt.id, "— skipping");
    return null;
  }

  // Guard: already sent
  const existing = getSmsReminderByAppointment(appt.id);
  if (existing) {
    console.log("[sms] Reminder already sent for appointment", appt.id);
    return existing;
  }

  const body = reminderMessage(appt);

  let twilioSid = null;
  try {
    const client = getClient();
    const msg = await client.messages.create({
      body,
      from: process.env.TWILIO_FROM_NUMBER,
      to: phone,
    });
    twilioSid = msg.sid;
    console.log(`[sms] Sent reminder to ${phone} for appt ${appt.id} — SID ${twilioSid}`);
  } catch (err) {
    console.error("[sms] Failed to send reminder:", err.message);
    // Still record it as "failed" so we don't spam on next cron tick
  }

  return createSmsReminder({
    appointmentId: appt.id,
    phone,
    twilioSid,
    status: twilioSid ? "sent" : "failed",
    slots: [],
  });
}

// ---------- Handle incoming reply ----------

/**
 * Process an inbound SMS from a visitor.
 * Called by the /api/sms/webhook route.
 *
 * @param {{ from: string, body: string }} msg
 * @returns {{ twimlResponse: string, action: string }}
 */
export async function handleInboundSms({ from, body }) {
  const normalised = body.trim().toUpperCase();
  const phone = normalisePhone(from) || from;

  // Find the most recent reminder for this phone number
  const reminder = getPendingRescheduleSms(phone) || (await findReminderByPhone(phone));

  // ── EVET / YES ───────────────────────────────────────────────────────────
  if (["EVET", "YES", "Y", "CONFIRM", "OK"].includes(normalised)) {
    if (reminder) {
      updateSmsReminderStatus(reminder.id, "confirmed");
      const appt = reminder._appt; // attached by store helper
      const ack = confirmationAckMessage(appt || {});
      await sendSms(phone, ack);
    }
    return { twimlResponse: buildTwiml(""), action: "confirmed" };
  }

  // ── HAYIR / NO ──────────────────────────────────────────────────────────
  if (["HAYIR", "NO", "N", "CANCEL", "IPTAL"].includes(normalised)) {
    if (reminder) {
      updateSmsReminderStatus(reminder.id, "rescheduling");
      const appt = reminder._appt;
      const slots = suggestAlternativeSlots(appt?.confirmedStart);
      // Store slots so we can map 1/2/3 replies
      updateSmsReminderRescheduleChoice(reminder.id, { slots });

      const slotsMsg = alternativeSlotsMessage(slots);
      await sendSms(phone, cancellationAckMessage());
      await sendSms(phone, slotsMsg);
    }
    return { twimlResponse: buildTwiml(""), action: "declined" };
  }

  // ── Numeric choice (1 / 2 / 3) after NO ─────────────────────────────────
  if (["1", "2", "3"].includes(normalised) && reminder) {
    const choice = parseInt(normalised, 10) - 1;
    const slots = reminder.slots || [];
    const picked = slots[choice];

    if (picked) {
      updateSmsReminderStatus(reminder.id, "rescheduled");
      const confirmMsg =
        `Got it! We'll suggest ${picked.label} to the broker. They'll confirm shortly.`;
      await sendSms(phone, confirmMsg);
      return { twimlResponse: buildTwiml(""), action: "rescheduled", slot: picked };
    }
  }

  // ── Unrecognised ────────────────────────────────────────────────────────
  return { twimlResponse: buildTwiml(""), action: "unknown" };
}

// ---------- Helpers ----------

async function sendSms(to, body) {
  if (!isTwilioConfigured()) return;
  try {
    const client = getClient();
    await client.messages.create({
      body,
      from: process.env.TWILIO_FROM_NUMBER,
      to,
    });
  } catch (err) {
    console.error("[sms] outbound error:", err.message);
  }
}

export async function sendConfirmationSms(appt) {
  const phone = normalisePhone(appt.visitorContact);
  if (!phone) return;
  await sendSms(phone, confirmationAckMessage(appt));
}

async function findReminderByPhone(phone) {
  // Fallback: look up the most recent 'sent' reminder for this phone
  // The store exposes this through getSmsReminderByPhone
  const { getSmsReminderByPhone } = await import("./store.js");
  return getSmsReminderByPhone(phone);
}

function buildTwiml(message) {
  // Twilio requires a TwiML XML response even if we send nothing
  if (message) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Validate that an inbound POST is genuinely from Twilio.
 * Requires TWILIO_WEBHOOK_BASE_URL in env.
 */
export function validateTwilioSignature(req) {
  if (!isTwilioConfigured()) return true; // skip validation if not configured
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (!baseUrl) return true; // no base URL configured — skip
  const url = `${baseUrl}/api/sms/webhook`;
  const signature = req.headers["x-twilio-signature"] || "";
  return twilio.validateRequest(authToken, signature, url, req.body || {});
}
