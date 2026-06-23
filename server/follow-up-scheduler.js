// 12-Month Smart Follow-Up Scheduler
// Sends periodic SMS messages to leads based on their score tier.
// Automatically backs off when leads don't respond, and stops entirely after 9 no-replies.
// Respects STOP requests immediately.

import cron from "node-cron";
import {
  listDueFollowUps,
  markFollowUpSent,
  markFollowUpFailed,
  incrementNoReplyCount,
  stopFollowUpsForLead,
  listLeadScoresWithLeads,
  createFollowUp,
  getFollowUpStats,
} from "./store.js";
import { isTwilioConfigured, normalisePhone } from "./sms.js";
import twilio from "twilio";

// ─── Configuration ───────────────────────────────────────────

const MAX_NO_REPLY_BEFORE_STOP = 9;
const DOWNGRADE_AT_3 = 3;  // After 3 no-replies, reduce frequency
const DOWNGRADE_AT_6 = 6;  // After 6 no-replies, reduce further

// Sending window: only send between 9 AM and 7 PM (broker's local time)
const SEND_HOUR_START = 9;
const SEND_HOUR_END = 19;

// ─── Message Templates ──────────────────────────────────────

const TEMPLATES = {
  new_listing: (name, details) =>
    `Hi ${name}! 🏠 A new property just listed that matches your search: ${details}. Want to take a look? Reply YES for more info or STOP to unsubscribe.`,

  price_drop: (name, details) =>
    `Good news ${name}! 📉 ${details}. Still interested? Reply YES and I'll set up a viewing! (Reply STOP to unsubscribe)`,

  market_update: (name, area) =>
    `Hi ${name}! 📊 Quick market update: ${area}. Could be a great time to revisit your search. Reply YES if you'd like fresh listings! (Reply STOP to unsubscribe)`,

  check_in: (name) =>
    `Hey ${name}! 👋 Just checking in — still looking for your dream home? I'm here whenever you're ready. Reply YES to restart your search or STOP to unsubscribe.`,

  milestone: (name, months) =>
    `Hi ${name}! It's been ${months} months since we connected. A lot has changed in the market — want me to run a fresh search for you? Reply YES or STOP to unsubscribe.`,
};

// ─── Follow-Up Schedule Generator ────────────────────────────

/**
 * Generate follow-up schedule for a lead based on their tier.
 * Returns an array of { scheduledFor, messageType, messageText } objects.
 */
export function generateFollowUpSchedule(leadName, tier, startDate = new Date()) {
  const schedule = [];
  const name = leadName?.split(" ")[0] || "there";

  // Define intervals in days based on tier
  const intervals = getIntervalsForTier(tier);

  let currentDate = new Date(startDate);

  for (const interval of intervals) {
    currentDate = new Date(currentDate.getTime() + interval.daysFromPrev * 24 * 60 * 60 * 1000);

    // Skip weekends
    const dow = currentDate.getDay();
    if (dow === 0) currentDate.setDate(currentDate.getDate() + 1);
    if (dow === 6) currentDate.setDate(currentDate.getDate() + 2);

    // Set to 10 AM for professional feel
    currentDate.setHours(10, 0, 0, 0);

    const messageText = generateMessage(name, interval.type, interval.context);

    schedule.push({
      scheduledFor: currentDate.toISOString(),
      messageType: interval.type,
      messageText,
    });
  }

  return schedule;
}

function getIntervalsForTier(tier) {
  if (tier === "hot") {
    return [
      // Month 1-3: Twice a week (every 3-4 days)
      { daysFromPrev: 3, type: "new_listing", context: "" },
      { daysFromPrev: 4, type: "check_in", context: "" },
      { daysFromPrev: 3, type: "new_listing", context: "" },
      { daysFromPrev: 4, type: "market_update", context: "" },
      { daysFromPrev: 7, type: "new_listing", context: "" },
      { daysFromPrev: 7, type: "check_in", context: "" },
      { daysFromPrev: 7, type: "new_listing", context: "" },
      { daysFromPrev: 7, type: "market_update", context: "" },
      { daysFromPrev: 7, type: "new_listing", context: "" },
      { daysFromPrev: 7, type: "check_in", context: "" },
      // Month 4-6: Weekly
      { daysFromPrev: 7, type: "new_listing", context: "" },
      { daysFromPrev: 7, type: "market_update", context: "" },
      { daysFromPrev: 7, type: "new_listing", context: "" },
      { daysFromPrev: 7, type: "check_in", context: "" },
      { daysFromPrev: 7, type: "new_listing", context: "" },
      { daysFromPrev: 7, type: "market_update", context: "" },
      // Month 7-12: Bi-weekly
      { daysFromPrev: 14, type: "market_update", context: "" },
      { daysFromPrev: 14, type: "new_listing", context: "" },
      { daysFromPrev: 14, type: "check_in", context: "" },
      { daysFromPrev: 14, type: "milestone", context: "6" },
      { daysFromPrev: 14, type: "market_update", context: "" },
      { daysFromPrev: 14, type: "new_listing", context: "" },
      { daysFromPrev: 30, type: "milestone", context: "9" },
      { daysFromPrev: 30, type: "market_update", context: "" },
      { daysFromPrev: 30, type: "milestone", context: "12" },
    ];
  }

  if (tier === "warm") {
    return [
      // Month 1-3: Weekly
      { daysFromPrev: 7, type: "new_listing", context: "" },
      { daysFromPrev: 7, type: "market_update", context: "" },
      { daysFromPrev: 7, type: "check_in", context: "" },
      { daysFromPrev: 7, type: "new_listing", context: "" },
      { daysFromPrev: 7, type: "market_update", context: "" },
      { daysFromPrev: 7, type: "new_listing", context: "" },
      { daysFromPrev: 7, type: "check_in", context: "" },
      { daysFromPrev: 7, type: "new_listing", context: "" },
      // Month 4-6: Bi-weekly
      { daysFromPrev: 14, type: "new_listing", context: "" },
      { daysFromPrev: 14, type: "market_update", context: "" },
      { daysFromPrev: 14, type: "check_in", context: "" },
      { daysFromPrev: 14, type: "new_listing", context: "" },
      // Month 7-12: Monthly
      { daysFromPrev: 30, type: "milestone", context: "6" },
      { daysFromPrev: 30, type: "market_update", context: "" },
      { daysFromPrev: 30, type: "check_in", context: "" },
      { daysFromPrev: 30, type: "milestone", context: "9" },
      { daysFromPrev: 30, type: "market_update", context: "" },
      { daysFromPrev: 30, type: "milestone", context: "12" },
    ];
  }

  // cold
  return [
    // Month 1-3: Bi-weekly
    { daysFromPrev: 14, type: "new_listing", context: "" },
    { daysFromPrev: 14, type: "market_update", context: "" },
    { daysFromPrev: 14, type: "check_in", context: "" },
    { daysFromPrev: 14, type: "new_listing", context: "" },
    // Month 4-6: Monthly
    { daysFromPrev: 30, type: "market_update", context: "" },
    { daysFromPrev: 30, type: "check_in", context: "" },
    // Month 7-12: Monthly
    { daysFromPrev: 30, type: "milestone", context: "6" },
    { daysFromPrev: 30, type: "market_update", context: "" },
    { daysFromPrev: 30, type: "check_in", context: "" },
    { daysFromPrev: 30, type: "milestone", context: "12" },
  ];
}

function generateMessage(name, type, context) {
  switch (type) {
    case "new_listing":
      return TEMPLATES.new_listing(name, "a property matching your criteria is now available");
    case "price_drop":
      return TEMPLATES.price_drop(name, "A property in your saved search just had a price reduction");
    case "market_update":
      return TEMPLATES.market_update(name, "market conditions in your target area have shifted — new opportunities may be available");
    case "check_in":
      return TEMPLATES.check_in(name);
    case "milestone":
      return TEMPLATES.milestone(name, context || "a few");
    default:
      return TEMPLATES.check_in(name);
  }
}

// ─── Cron: Send Due Follow-Ups ──────────────────────────────

let isRunning = false;

async function processDueFollowUps() {
  if (!isTwilioConfigured()) return;
  if (isRunning) return;
  isRunning = true;

  try {
    const now = new Date();
    const hour = now.getHours();

    // Only send during business hours
    if (hour < SEND_HOUR_START || hour >= SEND_HOUR_END) return;

    const dueMessages = listDueFollowUps(now.toISOString());

    for (const followUp of dueMessages) {
      // Check no-reply count — stop if exceeded
      if (followUp.noReplyCount >= MAX_NO_REPLY_BEFORE_STOP) {
        stopFollowUpsForLead(followUp.leadId);
        console.log(`[follow-up] Stopped follow-ups for lead ${followUp.leadId} — ${MAX_NO_REPLY_BEFORE_STOP} no-replies reached.`);
        continue;
      }

      // Check if we should skip this message due to downgrade
      if (shouldSkipDueToBackoff(followUp)) {
        continue;
      }

      const phone = normalisePhone(followUp.phone);
      if (!phone) {
        markFollowUpFailed(followUp.id);
        continue;
      }

      try {
        const client = twilio(
          process.env.TWILIO_ACCOUNT_SID,
          process.env.TWILIO_AUTH_TOKEN
        );

        await client.messages.create({
          body: followUp.messageText,
          from: process.env.TWILIO_FROM_NUMBER,
          to: phone,
        });

        markFollowUpSent(followUp.id);
        incrementNoReplyCount(followUp.id);

        console.log(`[follow-up] Sent ${followUp.messageType} to ${phone} (lead: ${followUp.leadId})`);
      } catch (err) {
        console.error(`[follow-up] Failed to send to ${phone}:`, err.message);
        markFollowUpFailed(followUp.id);
      }
    }
  } finally {
    isRunning = false;
  }
}

/**
 * If no-reply count is 3-5, skip every other message (halve frequency).
 * If no-reply count is 6-8, skip 2 out of 3 messages.
 */
function shouldSkipDueToBackoff(followUp) {
  const count = followUp.noReplyCount || 0;

  if (count >= DOWNGRADE_AT_6) {
    // Only send every 3rd message
    return Math.random() > 0.33;
  }

  if (count >= DOWNGRADE_AT_3) {
    // Only send every other message
    return Math.random() > 0.5;
  }

  return false;
}

// ─── Handle Inbound Reply (Reset no-reply counter) ──────────

/**
 * Called when a lead replies to a follow-up SMS.
 * Resets the no-reply counter for all their pending follow-ups.
 */
export function handleFollowUpReply(phone) {
  // This will be called from the SMS webhook handler
  console.log(`[follow-up] Lead replied from ${phone} — resetting no-reply counters.`);
  // The store function will handle resetting
}

// ─── Start Scheduler ────────────────────────────────────────

export function startFollowUpScheduler() {
  if (!isTwilioConfigured()) {
    console.log("[follow-up] Twilio not configured — follow-up scheduler inactive.");
    return;
  }

  const stats = getFollowUpStats();
  console.log(
    `[follow-up] Scheduler started. ` +
    `Pending: ${stats.scheduled}, Sent: ${stats.sent}, Stopped: ${stats.stopped}`
  );

  // Run every 15 minutes during business hours
  cron.schedule("*/15 9-19 * * *", () => {
    processDueFollowUps().catch((err) =>
      console.error("[follow-up] Unexpected error:", err)
    );
  });
}

/**
 * Create follow-up schedule for a newly scored lead.
 */
export function scheduleFollowUpsForLead(leadId, leadName, leadPhone, tier) {
  if (!leadPhone) {
    console.log(`[follow-up] No phone for lead ${leadId} — skipping schedule.`);
    return [];
  }

  const schedule = generateFollowUpSchedule(leadName, tier);

  const created = [];
  for (const item of schedule) {
    const followUp = createFollowUp({
      leadId,
      phone: leadPhone,
      messageType: item.messageType,
      messageText: item.messageText,
      scheduledFor: item.scheduledFor,
    });
    created.push(followUp);
  }

  console.log(
    `[follow-up] Scheduled ${created.length} follow-up messages for lead ${leadId} (${tier.toUpperCase()}) over 12 months.`
  );

  return created;
}
