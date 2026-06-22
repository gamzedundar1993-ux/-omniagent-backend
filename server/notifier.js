import { listPropertyTracksByListing, listActiveKriterTracks } from "./store.js";
import { isTwilioConfigured, normalisePhone } from "./sms.js";
import twilio from "twilio";

function getTwilioClient() {
  if (!isTwilioConfigured()) return null;
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendSms(to, body) {
  const phone = normalisePhone(to);
  if (!phone) return;
  console.log(`[notifier] Sending SMS to ${phone}: "${body}"`);
  
  if (!isTwilioConfigured()) {
    console.log(`[notifier] Twilio not configured. Simulated SMS: "${body}"`);
    return;
  }
  
  try {
    const client = getTwilioClient();
    await client.messages.create({
      body,
      from: process.env.TWILIO_FROM_NUMBER,
      to: phone,
    });
  } catch (err) {
    console.error(`[notifier] Failed to send SMS to ${phone}:`, err.message);
  }
}

/**
 * Notify all leads tracking a specific listing that its price has dropped.
 */
export async function notifyPriceDrop(listing, oldPrice, newPrice) {
  if (newPrice >= oldPrice) return; // not a price drop
  
  const tracks = listPropertyTracksByListing(listing.id);
  if (tracks.length === 0) return;
  
  const formattedOld = Number(oldPrice).toLocaleString("en-US");
  const formattedNew = Number(newPrice).toLocaleString("en-US");
  const address = listing.streetAddress;
  
  for (const track of tracks) {
    const name = track.leadName ? ` ${track.leadName.split(" ")[0]}` : "";
    const phone = track.leadPhone;
    if (!phone) continue;
    
    const body = `Hi${name}! Good news! The price of the property at ${address} has dropped from $${formattedOld} to $${formattedNew}. Reply YES to request a showing! (Real Estate AI)`;
    await sendSms(phone, body);
  }
}

/**
 * Check active criteria-based alerts when a new listing is created.
 */
export async function checkNewListingAlerts(listing) {
  const tracks = listActiveKriterTracks();
  if (tracks.length === 0) return;
  
  for (const track of tracks) {
    const criteria = track.searchCriteria || {};
    if (matchesCriteria(listing, criteria)) {
      const name = track.leadName ? ` ${track.leadName.split(" ")[0]}` : "";
      const phone = track.leadPhone;
      if (!phone) continue;
      
      const formattedPrice = listing.price ? ` ($${Number(listing.price).toLocaleString("en-US")})` : "";
      const body = `Hi${name}! A new listing matching your criteria was just posted at ${listing.streetAddress}${formattedPrice}. Reply YES to check details! (Real Estate AI)`;
      
      await sendSms(phone, body);
    }
  }
}

// Strict boolean filter — listing passes ONLY when it satisfies every criterion
// the lead explicitly specified. Unspecified criteria are skipped (no filter).
// This is intentionally stricter than matcher.js (which scores partial matches
// for in-chat suggestions); here we don't want to send "matching listing!" SMS
// for a listing that doesn't actually fit the lead's must-haves.
//
// Criteria shape (all optional):
//   list_type:    "for_sale" | "for_rent"
//   min_price,    max_price       — budget range, USD
//   min_sqft,     max_sqft        — area range, square feet
//   min_bedrooms, max_bedrooms    — bedroom count range
//   min_bathrooms                  — minimum bathroom count (fractional OK, e.g. 2.5)
//   city, state                    — location (city compared case-insensitively, state as 2-letter USPS code)
function matchesCriteria(listing, criteria) {
  // Sale vs. rent intent must match exactly when specified.
  if (criteria.list_type && listing.listType !== criteria.list_type) return false;

  // Budget range — fails if price is outside the [min, max] window.
  if (criteria.min_price != null && listing.price < criteria.min_price) return false;
  if (criteria.max_price != null && listing.price > criteria.max_price) return false;

  // Square footage range — same window logic as budget.
  if (criteria.min_sqft != null && listing.areaSqft < criteria.min_sqft) return false;
  if (criteria.max_sqft != null && listing.areaSqft > criteria.max_sqft) return false;

  // Bedroom count range — leads often specify both ("3-4 bedrooms").
  if (criteria.min_bedrooms != null && listing.bedrooms < criteria.min_bedrooms) return false;
  if (criteria.max_bedrooms != null && listing.bedrooms > criteria.max_bedrooms) return false;

  // Bathroom minimum only — leads rarely cap an upper bound on bathrooms.
  if (criteria.min_bathrooms != null && listing.bathrooms < criteria.min_bathrooms) return false;

  // City/state — case-insensitive equality. We deliberately skip the check when
  // the listing field is missing (rare but possible during partial data entry);
  // otherwise we would silently filter out otherwise-good matches.
  if (criteria.city && listing.city && listing.city.toLowerCase().trim() !== criteria.city.toLowerCase().trim()) return false;
  if (criteria.state && listing.state && listing.state.toLowerCase().trim() !== criteria.state.toLowerCase().trim()) return false;

  return true;
}
