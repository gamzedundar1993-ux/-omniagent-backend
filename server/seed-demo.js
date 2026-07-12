// ─────────────────────────────────────────────────────────────────────────────
// Demo data seeder
// ─────────────────────────────────────────────────────────────────────────────
//
// Purpose: give the broker a clean, believable dataset to show on sales calls —
// a full listing inventory so the chatbot actually returns matches, plus leads
// spread across the HOT/WARM/COLD scoring tiers, a real conversation transcript,
// a pending appointment, an active property track, and a scheduled follow-up.
// Every dashboard tab has something meaningful to show.
//
// Why a seeder (not just manual API calls): the SQLite DB lives on the server's
// local disk. On hosts with ephemeral storage (e.g. Render without a persistent
// disk) that file is wiped on every deploy/restart, so hand-entered demo data
// disappears. Seeding on startup makes the demo self-healing — after any restart
// it repopulates itself.
//
// Safety: this ONLY runs when SEED_DEMO="true". It calls resetDemoData(), which
// deletes all operational rows — so it must never be enabled on a production
// instance holding real customer data. Turn the flag off before going live.

import {
  resetDemoData,
  createListing,
  createConversation,
  appendMessage,
  updateConversationMeta,
  createLead,
  upsertLeadScore,
  createAppointment,
  createPropertyTrack,
  createFollowUp,
} from "./store.js";

// (visitor name/phone/email are set via createConversation's visitorMeta below)

// The curated inventory. Deliberately varied (for_sale + for_rent, a range of
// prices, beds, cities) so demo searches like "3-bed under $700k in Miami"
// return a believable multi-result set. At least one home (Kendall) is tuned to
// match that exact query.
const LISTINGS = [
  {
    mlsNumber: "A11542201", listType: "for_sale", status: "active",
    streetAddress: "1425 Brickell Ave #402", city: "Miami", state: "FL", zipCode: "33131",
    price: 625000, bedrooms: 2, bathrooms: 2, areaSqft: 1180,
    description: "High-floor Brickell condo with bay views, floor-to-ceiling windows, and resort-style amenities. Walk to Mary Brickell Village.",
    features: ["Bay view", "Pool", "Gym", "Valet parking", "Balcony"],
  },
  {
    mlsNumber: "A11538877", listType: "for_sale", status: "active",
    streetAddress: "820 Sevilla Ave", city: "Coral Gables", state: "FL", zipCode: "33134",
    price: 1350000, bedrooms: 4, bathrooms: 3, areaSqft: 2960, lotSizeSqft: 8500,
    description: "Classic Mediterranean single-family home on a quiet tree-lined street. Updated kitchen, heated pool, two-car garage.",
    features: ["Heated pool", "2-car garage", "Renovated kitchen", "Hardwood floors"],
  },
  {
    mlsNumber: "A11551043", listType: "for_sale", status: "active",
    streetAddress: "7500 SW 102nd St", city: "Kendall", state: "FL", zipCode: "33156",
    price: 685000, bedrooms: 3, bathrooms: 2, areaSqft: 1740, lotSizeSqft: 7200,
    description: "Move-in ready 3-bedroom in the heart of Kendall. Great schools, large backyard, new roof (2024).",
    features: ["Large backyard", "New roof", "Tile floors", "Fenced yard"],
  },
  {
    mlsNumber: "A11547790", listType: "for_sale", status: "active",
    streetAddress: "3050 NE 1st Ave #1804", city: "Miami", state: "FL", zipCode: "33137",
    price: 499000, bedrooms: 2, bathrooms: 2, areaSqft: 1020,
    description: "Bright Midtown/Edgewater condo steps from the Design District. Open layout, modern finishes.",
    features: ["City view", "Pool", "Gym", "Pet-friendly"],
  },
  {
    mlsNumber: "A11533120", listType: "for_sale", status: "active",
    streetAddress: "2915 Bird Ave #3", city: "Coconut Grove", state: "FL", zipCode: "33133",
    price: 890000, bedrooms: 3, bathrooms: 3, areaSqft: 1980,
    description: "Contemporary Coconut Grove townhome with rooftop terrace, two-car garage, and smart-home features.",
    features: ["Rooftop terrace", "2-car garage", "Smart home", "Impact windows"],
  },
  {
    mlsNumber: "A11549932", listType: "for_sale", status: "active",
    streetAddress: "10230 NW 66th St", city: "Doral", state: "FL", zipCode: "33178",
    price: 560000, bedrooms: 3, bathrooms: 2, areaSqft: 1610, lotSizeSqft: 5000,
    description: "Well-kept Doral home in a gated community. Close to top-rated schools and Doral Central Park.",
    features: ["Gated community", "Community pool", "Two-car garage"],
  },
  {
    mlsNumber: "A11552888", listType: "for_rent", status: "active",
    streetAddress: "1500 Bay Rd #720S", city: "Miami Beach", state: "FL", zipCode: "33139",
    price: 4500, bedrooms: 2, bathrooms: 2, areaSqft: 1150,
    description: "Furnished South Beach rental with marina views. Available now, annual lease.",
    features: ["Furnished", "Marina view", "Pool", "24h security", "Parking"],
  },
  {
    mlsNumber: "A11540665", listType: "for_rent", status: "active",
    streetAddress: "51 NW 26th St #310", city: "Miami", state: "FL", zipCode: "33127",
    price: 2800, bedrooms: 1, bathrooms: 1, areaSqft: 760,
    description: "Wynwood loft in the arts district. Exposed concrete, high ceilings, walk to galleries and cafes.",
    features: ["Loft style", "High ceilings", "Pet-friendly", "Rooftop lounge"],
  },
];

// Helper: build a conversation with a scripted transcript and return its id.
function seedConversation(lang, visitorMeta, messages) {
  const conv = createConversation({ lang, visitorMeta });
  for (const m of messages) appendMessage(conv.id, m);
  return conv.id;
}

export function seedDemoData() {
  resetDemoData();

  // 1) Inventory ---------------------------------------------------------------
  const created = LISTINGS.map((l) => createListing(l));
  const byCity = (city) => created.find((l) => l.city === city);
  const kendall = byCity("Kendall");

  // 2) HOT lead — Jennifer: budget + timeline + phone + booked showing ---------
  // This is the story the broker tells: an after-hours visitor the AI fully
  // qualified and booked while the office was closed.
  const jenConv = seedConversation(
    "en",
    { name: "Jennifer Alvarez", phone: "555-018-4472", email: "jennifer.alvarez.demo@example.com" },
    [
      { role: "user", content: "Hi, I'm looking for a 3 bedroom house in the Miami area under $700k." },
      { role: "assistant", content: "Great news! I found a few strong matches. The Kendall home at $685K is move-in ready with a new roof and a large backyard. Would you like to book a showing?" },
      { role: "user", content: "Yes — I'm pre-approved and ready to buy within 2 weeks. Saturday morning works." },
      { role: "assistant", content: "Perfect, Jennifer. I've submitted a showing request for the Kendall home on Saturday morning and shared your details with the broker. You'll get an SMS confirmation shortly." },
    ]
  );
  const jen = createLead({
    conversationId: jenConv,
    name: "Jennifer Alvarez",
    phone: "555-018-4472",
    email: "jennifer.alvarez.demo@example.com",
    notes: "Pre-approved. Wants a 3BR under $700k in Miami. Ready to buy within 2 weeks.",
  });
  upsertLeadScore({
    leadId: jen.id, score: 92, tier: "hot",
    hasBudget: 1, hasTimeline: 1, hasPhone: 1, bookedAppointment: 1, propertyInterestCount: 3,
  });
  createAppointment({
    conversationId: jenConv,
    visitorName: "Jennifer Alvarez",
    visitorContact: "555-018-4472",
    propertyRef: kendall ? `${kendall.streetAddress}, ${kendall.city}` : "Kendall home",
    requestedTime: "Saturday morning",
    notes: "Pre-approved buyer, high intent. Confirm ASAP.",
  });
  // She asked to be alerted about new 3BR listings under $700k in Miami.
  createPropertyTrack({
    leadId: jen.id,
    searchCriteria: { city: "Miami", minBedrooms: 3, maxPrice: 700000, listType: "for_sale" },
    status: "active",
  });

  // 3) WARM lead — Marcus: shared phone, browsing, no firm timeline -----------
  const marcusConv = seedConversation(
    "en",
    { name: "Marcus Bennett", phone: "555-027-9910" },
    [
      { role: "user", content: "Do you have any 2 bedroom condos in Brickell?" },
      { role: "assistant", content: "Yes! There's a bay-view 2BR/2BA on Brickell Ave at $625K with pool, gym and valet. Want me to send more details or set up an alert?" },
      { role: "user", content: "Just looking for now, but you can text me if something good comes up. 555-027-9910." },
      { role: "assistant", content: "Done — I'll text you when new Brickell condos hit the market. Thanks, Marcus!" },
    ]
  );
  const marcus = createLead({
    conversationId: marcusConv,
    name: "Marcus Bennett",
    phone: "555-027-9910",
    notes: "Browsing 2BR condos in Brickell. No firm timeline. Opted into new-listing alerts.",
  });
  upsertLeadScore({
    leadId: marcus.id, score: 55, tier: "warm",
    hasBudget: 0, hasTimeline: 0, hasPhone: 1, bookedAppointment: 0, propertyInterestCount: 1,
  });
  createPropertyTrack({
    leadId: marcus.id,
    searchCriteria: { city: "Miami", minBedrooms: 2, maxPrice: 700000, listType: "for_sale" },
    status: "active",
  });
  // A value-driven follow-up already queued for him (the 12-month engine).
  createFollowUp({
    leadId: marcus.id,
    phone: "555-027-9910",
    messageType: "new_listing",
    messageText: "Hi Marcus! A new 2BR condo just listed in Brickell with bay views. Want me to send the details?",
    scheduledFor: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  });

  // 4) COLD lead — Sophia: a single general question, minimal info ------------
  const sophiaConv = seedConversation(
    "es",
    { name: "Sophia Nguyen" },
    [
      { role: "user", content: "¿Trabajan con propiedades de alquiler?" },
      { role: "assistant", content: "¡Sí! Tenemos alquileres en Miami Beach y Wynwood. ¿Le comparto algunas opciones o sus datos para avisarle de nuevas?" },
      { role: "user", content: "Solo estaba mirando, gracias." },
    ]
  );
  const sophia = createLead({
    conversationId: sophiaConv,
    name: "Sophia Nguyen",
    notes: "Asked a general rental question in Spanish. No contact details shared. Low intent.",
  });
  upsertLeadScore({
    leadId: sophia.id, score: 18, tier: "cold",
    hasBudget: 0, hasTimeline: 0, hasPhone: 0, bookedAppointment: 0, propertyInterestCount: 0,
  });

  const summary = {
    listings: created.length,
    leads: 3,
    tiers: { hot: 1, warm: 1, cold: 1 },
    appointments: 1,
    tracks: 2,
    followUps: 1,
  };
  return summary;
}

// Called from server startup. No-op unless SEED_DEMO="true". When the flag is on
// it resets and reseeds on every boot, guaranteeing a clean, predictable demo
// (and self-healing after an ephemeral-storage wipe). Because this wipes data,
// the flag must stay OFF on any instance holding real customer records.
export function maybeSeedDemoOnStartup() {
  if (process.env.SEED_DEMO !== "true") return;
  const s = seedDemoData();
  console.log(
    `[seed-demo] Seeded demo data: ${s.listings} listings, ${s.leads} leads ` +
      `(${s.tiers.hot} hot / ${s.tiers.warm} warm / ${s.tiers.cold} cold), ` +
      `${s.appointments} appointment, ${s.tracks} tracks, ${s.followUps} follow-up.`
  );
}
