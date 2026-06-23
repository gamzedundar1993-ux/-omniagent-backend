// Lead Scoring Engine
// Analyzes conversation data and assigns a score (0-100) to each lead.
// Called automatically after each chat conversation ends.

import {
  getConversation,
  createLead,
  getLeadScoreByLeadId,
  upsertLeadScore,
} from "./store.js";

/**
 * Scoring weights for different lead signals.
 */
const SCORING_RULES = {
  gave_name: 5,
  gave_phone: 15,
  gave_budget: 20,
  gave_location: 10,
  gave_bedrooms: 5,
  searched_properties: 10,
  liked_specific_listing: 10,
  booked_appointment: 25,
  gave_timeline: 10,
};

/**
 * Determine the tier from a numeric score.
 */
export function tierFromScore(score) {
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}

/**
 * Analyze a conversation's messages and tool-call metadata to produce
 * a lead score breakdown.
 *
 * @param {object} opts
 * @param {string} opts.conversationId
 * @param {object} [opts.toolCallSummary]  – aggregated info from chat.js
 * @returns {{ score: number, tier: string, signals: object }}
 */
export function scoreConversation({ conversationId, toolCallSummary = {} }) {
  const conv = getConversation(conversationId);
  if (!conv) return null;

  const signals = {
    has_name: false,
    has_phone: false,
    has_budget: false,
    has_location: false,
    has_bedrooms: false,
    searched_properties: false,
    liked_listing: false,
    booked_appointment: false,
    has_timeline: false,
  };

  // Analyze visitor messages for signals
  const visitorMessages = conv.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : "").toLowerCase())
    .join(" ");

  // Name detection: if visitor meta has a name or messages contain name-like patterns
  if (conv.visitorMeta?.name || /my name is|i'm |i am /i.test(visitorMessages)) {
    signals.has_name = true;
  }

  // Phone detection
  const phoneRegex = /(\+?\d[\d\s\-()]{7,}\d)/;
  if (conv.visitorMeta?.phone || phoneRegex.test(visitorMessages)) {
    signals.has_phone = true;
  }

  // Budget detection
  const budgetPatterns = /(\$[\d,]+|budget|afford|down ?payment|monthly|price range|\d{3,}k|\d{4,})/i;
  if (budgetPatterns.test(visitorMessages)) {
    signals.has_budget = true;
  }

  // Location detection
  const locationPatterns = /\b(city|town|neighborhood|district|area|street|avenue|downtown|suburb|brooklyn|manhattan|queens|bronx|miami|houston|dallas|austin|chicago|los angeles|san francisco)\b/i;
  if (locationPatterns.test(visitorMessages)) {
    signals.has_location = true;
  }

  // Bedrooms detection
  if (/\b(\d+)\s*(bed|br|bedroom|room)/i.test(visitorMessages)) {
    signals.has_bedrooms = true;
  }

  // Timeline detection
  const timelinePatterns = /\b(asap|immediately|this month|next month|within|moving|relocat|urgently|soon|(\d+)\s*(week|month|day))\b/i;
  if (timelinePatterns.test(visitorMessages)) {
    signals.has_timeline = true;
  }

  // Tool call based signals (passed from chat.js)
  if (toolCallSummary.searchedProperties) {
    signals.searched_properties = true;
  }
  if (toolCallSummary.bookedAppointment) {
    signals.booked_appointment = true;
  }
  if (toolCallSummary.trackedProperty) {
    signals.liked_listing = true;
  }

  // Calculate score
  let score = 0;
  if (signals.has_name) score += SCORING_RULES.gave_name;
  if (signals.has_phone) score += SCORING_RULES.gave_phone;
  if (signals.has_budget) score += SCORING_RULES.gave_budget;
  if (signals.has_location) score += SCORING_RULES.gave_location;
  if (signals.has_bedrooms) score += SCORING_RULES.gave_bedrooms;
  if (signals.searched_properties) score += SCORING_RULES.searched_properties;
  if (signals.liked_listing) score += SCORING_RULES.liked_specific_listing;
  if (signals.booked_appointment) score += SCORING_RULES.booked_appointment;
  if (signals.has_timeline) score += SCORING_RULES.gave_timeline;

  // Cap at 100
  score = Math.min(score, 100);

  const tier = tierFromScore(score);

  return { score, tier, signals };
}

/**
 * Score a lead and persist the result.
 * If the lead doesn't exist yet, creates it first.
 *
 * @param {object} opts
 * @param {string} opts.conversationId
 * @param {string} [opts.leadId]
 * @param {object} [opts.toolCallSummary]
 * @returns {object} The saved lead score record
 */
export function scoreAndPersist({ conversationId, leadId, toolCallSummary = {} }) {
  const result = scoreConversation({ conversationId, toolCallSummary });
  if (!result) return null;

  // If no leadId provided, try to find or create one
  if (!leadId) {
    const conv = getConversation(conversationId);
    // Create a minimal lead from conversation metadata
    const lead = createLead({
      conversationId,
      name: conv?.visitorMeta?.name || null,
      phone: conv?.visitorMeta?.phone || null,
      notes: `Auto-created from conversation. Score: ${result.score} (${result.tier})`,
    });
    leadId = lead.id;
  }

  // Upsert the score
  const saved = upsertLeadScore({
    leadId,
    score: result.score,
    tier: result.tier,
    hasBudget: result.signals.has_budget ? 1 : 0,
    hasTimeline: result.signals.has_timeline ? 1 : 0,
    hasPhone: result.signals.has_phone ? 1 : 0,
    bookedAppointment: result.signals.booked_appointment ? 1 : 0,
    propertyInterestCount: (result.signals.searched_properties ? 1 : 0) + (result.signals.liked_listing ? 1 : 0),
  });

  console.log(
    `[lead-scorer] Scored lead ${leadId}: ${result.score}/100 (${result.tier.toUpperCase()}) ` +
    `| budget=${result.signals.has_budget} phone=${result.signals.has_phone} appt=${result.signals.booked_appointment}`
  );

  return saved;
}
