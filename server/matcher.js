// Property matching engine.
// Scores all active listings against visitor criteria and returns top matches.
// Every criterion is optional — omitted criteria contribute their full weight
// so the score stays comparable regardless of how many criteria are provided.

import { searchListings } from "./store.js";

// Maximum possible raw score (all criteria satisfied perfectly).
const MAX_SCORE = 100;

/**
 * @typedef {Object} Criteria
 * @property {"for_sale"|"for_rent"} [list_type]
 * @property {number} [min_price]
 * @property {number} [max_price]
 * @property {number} [min_bedrooms]
 * @property {number} [max_bedrooms]
 * @property {number} [min_bathrooms]
 * @property {string} [city]
 * @property {string} [state]
 * @property {number} [min_sqft]
 * @property {number} [max_sqft]
 */

/**
 * Find the best matching listings for the given criteria.
 * @param {Criteria} criteria
 * @param {number} [topN=3]
 * @returns {{ listing: object, score: number, scorePercent: number }[]}
 */
export function findMatches(criteria = {}, topN = 3) {
  const listings = searchListings(); // all active listings

  if (!listings.length) return [];

  const scored = listings
    .map((listing) => ({ listing, score: scoreListing(listing, criteria) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(({ listing, score }) => ({
      listing,
      score,
      scorePercent: Math.round((score / MAX_SCORE) * 100),
    }));

  return scored;
}

/**
 * Score a single listing against criteria.
 * Returns 0–100. Unspecified criteria default to full points.
 */
function scoreListing(listing, criteria) {
  let score = 0;

  // ── Type match (5 pts) ───────────────────────────────────────────────────
  if (!criteria.list_type) {
    score += 5; // not specified → give full points
  } else {
    score += listing.list_type === criteria.list_type ? 5 : 0;
  }

  // ── Budget (30 pts) ──────────────────────────────────────────────────────
  const hasMinPrice = criteria.min_price != null;
  const hasMaxPrice = criteria.max_price != null;

  if (!hasMinPrice && !hasMaxPrice) {
    score += 30; // no price preference → full points
  } else {
    const price = listing.price;
    if (price == null) {
      score += 15; // price unknown → partial credit
    } else {
      let priceScore = 30;

      if (hasMaxPrice && price > criteria.max_price) {
        const overPct = (price - criteria.max_price) / criteria.max_price;
        if (overPct <= 0.1) priceScore = 20;       // within 10% over → partial
        else if (overPct <= 0.2) priceScore = 10;  // within 20% over → low
        else priceScore = 0;                        // too expensive → eliminated
      }

      if (hasMinPrice && price < criteria.min_price) {
        // Under-budget is OK but might not match (e.g. renter specifying min)
        priceScore = Math.min(priceScore, 20);
      }

      score += priceScore;
    }
  }

  // ── Bedrooms (20 pts) ────────────────────────────────────────────────────
  const hasMinBed = criteria.min_bedrooms != null;
  const hasMaxBed = criteria.max_bedrooms != null;

  if (!hasMinBed && !hasMaxBed) {
    score += 20;
  } else {
    const beds = listing.bedrooms;
    if (beds == null) {
      score += 10;
    } else {
      const minOk = !hasMinBed || beds >= criteria.min_bedrooms;
      const maxOk = !hasMaxBed || beds <= criteria.max_bedrooms;

      if (minOk && maxOk) {
        score += 20; // perfect range match
      } else if (hasMinBed && beds === criteria.min_bedrooms - 1) {
        score += 10; // one bedroom short
      } else if (hasMaxBed && beds === criteria.max_bedrooms + 1) {
        score += 10; // one bedroom over
      } else {
        score += 0;
      }
    }
  }

  // ── Bathrooms (15 pts) ───────────────────────────────────────────────────
  if (criteria.min_bathrooms == null) {
    score += 15;
  } else {
    const baths = listing.bathrooms;
    if (baths == null) {
      score += 7;
    } else if (baths >= criteria.min_bathrooms) {
      score += 15;
    } else if (baths >= criteria.min_bathrooms - 0.5) {
      score += 8; // half bath short
    } else {
      score += 0;
    }
  }

  // ── Location: city + state (20 pts) ─────────────────────────────────────
  const hasCity = criteria.city && criteria.city.trim();
  const hasState = criteria.state && criteria.state.trim();

  if (!hasCity && !hasState) {
    score += 20;
  } else {
    const cityMatch =
      hasCity &&
      listing.city &&
      listing.city.toLowerCase().trim() ===
        criteria.city.toLowerCase().trim();
    const stateMatch =
      hasState &&
      listing.state &&
      listing.state.toLowerCase().trim() ===
        criteria.state.toLowerCase().trim();

    if (cityMatch) score += 20;
    else if (stateMatch) score += 10;
    // city specified but different city → 0
  }

  // ── Area / sqft (10 pts) ─────────────────────────────────────────────────
  const hasMinSqft = criteria.min_sqft != null;
  const hasMaxSqft = criteria.max_sqft != null;

  if (!hasMinSqft && !hasMaxSqft) {
    score += 10;
  } else {
    const sqft = listing.area_sqft;
    if (sqft == null) {
      score += 5;
    } else {
      const minOk = !hasMinSqft || sqft >= criteria.min_sqft;
      const maxOk = !hasMaxSqft || sqft <= criteria.max_sqft;
      score += minOk && maxOk ? 10 : 0;
    }
  }

  return score;
}

/**
 * Format a listing for the Claude tool result (concise, English).
 */
export function formatListingForBot(listing, rank, score) {
  const parts = [
    `#${rank}: ${listing.street_address}, ${listing.city}, ${listing.state}${listing.zip_code ? " " + listing.zip_code : ""}`,
    listing.price != null
      ? `Price: $${Number(listing.price).toLocaleString("en-US")}`
      : null,
    listing.bedrooms != null ? `Bedrooms: ${listing.bedrooms}` : null,
    listing.bathrooms != null ? `Bathrooms: ${listing.bathrooms}` : null,
    listing.area_sqft != null
      ? `Size: ${Number(listing.area_sqft).toLocaleString("en-US")} sqft`
      : null,
    listing.list_type === "for_rent" ? "For Rent" : "For Sale",
    listing.mls_number ? `MLS# ${listing.mls_number}` : null,
    listing.description ? `Notes: ${listing.description}` : null,
    `Match score: ${score}%`,
  ].filter(Boolean);

  return parts.join(" | ");
}
