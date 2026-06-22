// SMS appointment reminder scheduler.
// Runs every minute via node-cron and sends Twilio SMS to visitors
// whose confirmed appointments start within the reminder window.
//
// Only runs when Twilio is configured; otherwise it is a safe no-op.

import cron from "node-cron";
import { listConfirmedAppointmentsInWindow, getSmsReminderByAppointment } from "./store.js";
import { sendReminder, isTwilioConfigured, looksLikePhone } from "./sms.js";

const REMINDER_HOURS_BEFORE = Number(process.env.SMS_REMINDER_HOURS_BEFORE) || 2;
// We check a 5-minute window each tick so no appointment is missed
// between cron runs (cron fires every minute, window is 1 min + 4 min buffer).
const WINDOW_MINUTES = 5;

let isRunning = false; // prevent concurrent runs

async function checkAndSend() {
  if (!isTwilioConfigured()) return;
  if (isRunning) return;
  isRunning = true;

  try {
    const now = new Date();
    const windowStart = new Date(now.getTime() + REMINDER_HOURS_BEFORE * 60 * 60 * 1000);
    const windowEnd = new Date(windowStart.getTime() + WINDOW_MINUTES * 60 * 1000);

    const appointments = listConfirmedAppointmentsInWindow(
      windowStart.toISOString(),
      windowEnd.toISOString()
    );

    for (const appt of appointments) {
      // Skip if contact is not a phone number
      if (!looksLikePhone(appt.visitorContact)) continue;

      // Skip if reminder already sent
      const existing = getSmsReminderByAppointment(appt.id);
      if (existing) continue;

      try {
        await sendReminder(appt);
      } catch (err) {
        console.error(`[sms-scheduler] Failed to send reminder for appt ${appt.id}:`, err.message);
      }
    }
  } finally {
    isRunning = false;
  }
}

export function startSmsScheduler() {
  if (!isTwilioConfigured()) {
    console.log("[sms-scheduler] Twilio not configured — scheduler inactive.");
    return;
  }

  console.log(
    `[sms-scheduler] Started. Will send SMS ${REMINDER_HOURS_BEFORE}h before confirmed appointments.`
  );

  // Run every minute
  cron.schedule("* * * * *", () => {
    checkAndSend().catch((err) =>
      console.error("[sms-scheduler] Unexpected error:", err)
    );
  });
}
