const SUPPORTED_LANGS = ["en", "es", "ar"];
const RTL_LANGS = new Set(["ar"]);
const DEFAULT_LANG = "en";

let translations = {};
let currentLang = DEFAULT_LANG;

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const statConversations = document.getElementById("statConversations");
const statLeads = document.getElementById("statLeads");
const statAppointments = document.getElementById("statAppointments");
const langSelect = document.getElementById("langSelect");
const refreshBtn = document.getElementById("refreshBtn");
const tabButtons = document.querySelectorAll(".tab");
const tabPanels = document.querySelectorAll(".tab-panel");
const conversationsList = document.getElementById("conversationsList");
const leadsList = document.getElementById("leadsList");
const appointmentsList = document.getElementById("appointmentsList");
const embedSnippet = document.getElementById("embedSnippet");
const copyEmbedBtn = document.getElementById("copyEmbedBtn");
const modal = document.getElementById("conversationModal");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const modalCloseBtn = document.getElementById("modalCloseBtn");

// Confirm appointment modal
const confirmModal = document.getElementById("confirmModal");
const confirmSummary = document.getElementById("confirmSummary");
const confirmStartInput = document.getElementById("confirmStart");
const confirmDurationInput = document.getElementById("confirmDuration");
const confirmTitleInput = document.getElementById("confirmTitle");
const confirmConflict = document.getElementById("confirmConflict");
const confirmCalendarStatus = document.getElementById("confirmCalendarStatus");
const confirmCancelBtn = document.getElementById("confirmCancelBtn");
const confirmSubmitBtn = document.getElementById("confirmSubmitBtn");
const confirmCloseBtn = document.getElementById("confirmCloseBtn");

// Settings
const googleDot = document.getElementById("googleDot");
const googleStatusText = document.getElementById("googleStatusText");
const googleConnectBtn = document.getElementById("googleConnectBtn");
const googleDisconnectBtn = document.getElementById("googleDisconnectBtn");
const googleNotConfiguredHint = document.getElementById("googleNotConfiguredHint");

// ---------- Listings UI references ----------
// Every listing-related DOM handle lives together so the wiring is easy to find.
// The HTML for the panel + modal + form is in public/index.html — we only attach
// behavior here.
const statListings = document.getElementById("statListings");
const listingsList = document.getElementById("listingsList");
const addListingBtn = document.getElementById("addListingBtn");
const listingFilterType = document.getElementById("listingFilterType");
const listingFilterStatus = document.getElementById("listingFilterStatus");
const listingModal = document.getElementById("listingModal");
const listingModalTitle = document.getElementById("listingModalTitle");
const listingCloseBtn = document.getElementById("listingCloseBtn");
const listingCancelBtn = document.getElementById("listingCancelBtn");
const listingSaveBtn = document.getElementById("listingSaveBtn");
const lStreetAddress = document.getElementById("lStreetAddress");
const lCity = document.getElementById("lCity");
const lState = document.getElementById("lState");
const lZip = document.getElementById("lZip");
const lMls = document.getElementById("lMls");
const lListType = document.getElementById("lListType");
const lStatus = document.getElementById("lStatus");
const lPrice = document.getElementById("lPrice");
const lBedrooms = document.getElementById("lBedrooms");
const lBathrooms = document.getElementById("lBathrooms");
const lAreaSqft = document.getElementById("lAreaSqft");
const lLotSqft = document.getElementById("lLotSqft");
const lDescription = document.getElementById("lDescription");
const lFeaturesInput = document.getElementById("lFeaturesInput");
const lFeatureChips = document.getElementById("lFeatureChips");

let pendingConfirmId = null;
let conflictCheckTimer = null;

// ---------- i18n ----------
function detectInitialLang() {
  const stored = localStorage.getItem("dashboard_lang");
  if (stored && SUPPORTED_LANGS.includes(stored)) return stored;
  const nav = (navigator.language || "en").slice(0, 2);
  return SUPPORTED_LANGS.includes(nav) ? nav : DEFAULT_LANG;
}

async function loadTranslations(lang) {
  const res = await fetch(`/i18n/${lang}.json`);
  if (!res.ok) throw new Error(`failed to load locale ${lang}`);
  return res.json();
}

function t(key, params) {
  let s = translations[key] ?? key;
  if (params) {
    for (const k of Object.keys(params)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), params[k]);
    }
  }
  return s;
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  document.title = t("app.title");
}

async function setLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = DEFAULT_LANG;
  translations = await loadTranslations(lang);
  currentLang = lang;
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL_LANGS.has(lang) ? "rtl" : "ltr";
  localStorage.setItem("dashboard_lang", lang);
  langSelect.value = lang;
  applyTranslations();
  // Re-render dynamic content with new translations
  if (lastData) renderAll(lastData);
  renderEmbed();
}

// ---------- Data ----------
let lastData = null;

async function fetchAll() {
  // Parallel fetch — endpoints are independent so we don't pay sequential latency.
  const [health, convs, leads, appts, lists] = await Promise.all([
    fetch("/api/health").then((r) => r.json()),
    fetch("/api/conversations").then((r) => r.json()),
    fetch("/api/leads").then((r) => r.json()),
    fetch("/api/appointments").then((r) => r.json()),
    fetch("/api/listings").then((r) => r.json()),
  ]);
  return {
    health,
    conversations: convs.conversations ?? [],
    leads: leads.leads ?? [],
    appointments: appts.appointments ?? [],
    listings: lists.listings ?? [],
  };
}

function renderStatus(health) {
  if (!health) {
    statusDot.className = "dot err";
    statusText.textContent = t("conn.unreachable");
    renderGoogleStatus(null);
    return;
  }
  if (health.chatbotConfigured) {
    statusDot.className = "dot ok";
    statusText.textContent = t("conn.connected");
  } else {
    statusDot.className = "dot warn";
    statusText.textContent = t("conn.missing_key");
  }
  renderGoogleStatus(health.googleCalendar);
}

function renderStats(data) {
  statConversations.textContent = data.conversations.length;
  statLeads.textContent = data.leads.length;
  statAppointments.textContent = data.appointments.length;
  // Count only ACTIVE listings — sold/pending/off_market are inventory we no
  // longer pitch, so they don't belong in the "Active Listings" headline.
  statListings.textContent = data.listings.filter((l) => l.status === "active").length;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(
      currentLang === "ar" ? "ar" : currentLang === "es" ? "es-US" : "en-US",
      { dateStyle: "medium", timeStyle: "short" }
    );
  } catch {
    return iso;
  }
}

function visitorName(conv) {
  return conv?.visitorMeta?.name || t("conv.unnamed");
}

function messagesCountLabel(n) {
  return n === 1
    ? t("conv.messages_count_one")
    : t("conv.messages_count_other", { n });
}

function renderConversations(items) {
  if (!items.length) {
    conversationsList.innerHTML = `<p class="muted empty">${escapeHtml(t("empty.conversations"))}</p>`;
    return;
  }
  conversationsList.innerHTML = items
    .map((c) => {
      const last = c.messages[c.messages.length - 1];
      const preview = last ? last.content.slice(0, 140) : "";
      return `
        <article class="list-item" data-conv-id="${escapeHtml(c.id)}">
          <div class="list-row">
            <span class="list-title">${escapeHtml(visitorName(c))}</span>
            <span class="list-meta">${escapeHtml(formatDateTime(c.lastActivityAt))}</span>
          </div>
          <div class="list-row sub">
            <span class="muted small">${escapeHtml(messagesCountLabel(c.messages.length))} · ${escapeHtml(c.lang)}</span>
          </div>
          ${preview ? `<div class="list-preview" dir="auto">${escapeHtml(preview)}</div>` : ""}
        </article>
      `;
    })
    .join("");

  conversationsList.querySelectorAll(".list-item").forEach((el) => {
    el.addEventListener("click", () => openConversation(el.dataset.convId));
  });
}

function renderLeads(items) {
  if (!items.length) {
    leadsList.innerHTML = `<p class="muted empty">${escapeHtml(t("empty.leads"))}</p>`;
    return;
  }
  leadsList.innerHTML = items
    .map(
      (l) => `
      <article class="list-item">
        <div class="list-row">
          <span class="list-title">${escapeHtml(l.name || t("conv.unnamed"))}</span>
          <span class="list-meta">${escapeHtml(formatDateTime(l.createdAt))}</span>
        </div>
        <div class="fields">
          ${l.email ? fieldRow("lead.email", l.email) : ""}
          ${l.phone ? fieldRow("lead.phone", l.phone) : ""}
          ${l.notes ? fieldRow("lead.notes", l.notes) : ""}
        </div>
      </article>
    `
    )
    .join("");
}

function renderAppointments(items) {
  if (!items.length) {
    appointmentsList.innerHTML = `<p class="muted empty">${escapeHtml(t("empty.appointments"))}</p>`;
    return;
  }
  appointmentsList.innerHTML = items
    .map((a) => {
      const confirmedRow =
        a.status === "confirmed" && a.confirmedStart
          ? fieldRow("appt.confirmed_for", formatDateTime(a.confirmedStart))
          : "";
      const calendarLink = a.calendarHtmlLink
        ? `<div class="list-row sub"><a class="calendar-link" href="${escapeHtml(a.calendarHtmlLink)}" target="_blank" rel="noopener">${escapeHtml(t("appt.calendar_link"))}</a></div>`
        : "";
      const actions =
        a.status === "pending"
          ? `<div class="actions">
                <button class="btn primary" data-action="confirm" data-id="${escapeHtml(a.id)}">${escapeHtml(t("appt.action.confirm"))}</button>
                <button class="btn ghost" data-action="decline" data-id="${escapeHtml(a.id)}">${escapeHtml(t("appt.action.decline"))}</button>
              </div>`
          : a.status === "confirmed"
          ? `<div class="actions">
                <button class="btn ghost" data-action="cancel" data-id="${escapeHtml(a.id)}">${escapeHtml(t("appt.action.cancel"))}</button>
              </div>`
          : "";
      return `
        <article class="list-item">
          <div class="list-row">
            <span class="list-title">${escapeHtml(a.visitorName || t("conv.unnamed"))}</span>
            <span class="badge status-${escapeHtml(a.status)}">${escapeHtml(t("appt.status." + a.status))}</span>
          </div>
          <div class="fields">
            ${fieldRow("appt.contact", a.visitorContact)}
            ${a.propertyRef ? fieldRow("appt.property", a.propertyRef) : ""}
            ${fieldRow("appt.requested_time", a.requestedTime)}
            ${confirmedRow}
            ${a.notes ? fieldRow("appt.notes", a.notes) : ""}
            ${fieldRow("appt.created", formatDateTime(a.createdAt))}
          </div>
          ${calendarLink}
          ${actions}
        </article>
      `;
    })
    .join("");

  appointmentsList.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      if (action === "confirm") {
        openConfirmModal(id);
      } else if (action === "decline") {
        updateAppointment(id, "declined");
      } else if (action === "cancel") {
        if (confirm(t("confirm.cancel_prompt"))) {
          updateAppointment(id, "cancelled");
        }
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Listings (Module 3 — property management with criteria-matching auto-SMS)
// ─────────────────────────────────────────────────────────────────────────────
//
// The broker manages their inventory here. When a NEW listing is POSTed, the
// server (server/index.js → server/notifier.js) automatically fires SMS to any
// leads whose saved property_tracks criteria match the listing. When the price
// on an existing listing DROPS via PUT, the server fires a price-drop SMS to
// leads tracking that specific listing. No extra client-side step needed — the
// UI's job is just to let the broker enter and update listings reliably.
//
// Module-level state:
//   editingListingId — null in CREATE mode, the listing id in EDIT mode.
//                      Determines whether saveListing() does POST or PUT.
//   listingFeatures  — chip-array state while the modal is open. We keep it as
//                      a real array (not derived from the DOM on save) so that
//                      add/remove operations are simple and unambiguous.

let editingListingId = null;
let listingFeatures = [];

// These must mirror the backend's accepted values exactly. Kept here as
// constants so a typo in the dropdown can't silently produce a value the
// backend will accept-then-mismatch in the matcher.
const LISTING_TYPES = ["for_sale", "for_rent"];
const LISTING_STATUSES = ["active", "pending", "sold", "off_market"];

// Apply the current dropdown filter selections. An empty filter value means
// "no filter" for that field (the "All types" / "All statuses" options).
function applyListingFilters(items) {
  const type = listingFilterType.value;
  const status = listingFilterStatus.value;
  return items.filter((l) => {
    if (type && l.listType !== type) return false;
    if (status && l.status !== status) return false;
    return true;
  });
}

// Format a numeric price as USD ($450,000). Returns "—" for null/undefined.
// We always show USD because Module 3's data conventions assume USD (see CLAUDE.md).
function formatPrice(price) {
  if (price == null) return "—";
  return "$" + Number(price).toLocaleString("en-US");
}

// Compose a short, readable address line for the card title.
function listingTitle(l) {
  const parts = [l.streetAddress, l.city, l.state].filter(Boolean);
  return parts.join(", ") + (l.zipCode ? " " + l.zipCode : "");
}

// Render the listings grid. Called by renderAll (initial load + 15s auto-refresh)
// and whenever a filter dropdown changes.
function renderListings(items) {
  const filtered = applyListingFilters(items);
  if (!filtered.length) {
    listingsList.innerHTML = `<p class="muted empty">${escapeHtml(t("empty.listings"))}</p>`;
    return;
  }
  listingsList.innerHTML = filtered
    .map((l) => {
      const features = Array.isArray(l.features) ? l.features : [];
      const featuresRow = features.length
        ? `<div class="list-row sub">${features
            .map((f) => `<span class="chip">${escapeHtml(f)}</span>`)
            .join("")}</div>`
        : "";
      return `
        <article class="list-item listing-card" data-listing-id="${escapeHtml(l.id)}">
          <div class="list-row">
            <span class="list-title">${escapeHtml(listingTitle(l))}</span>
            <span class="badge status-${escapeHtml(l.status)}">${escapeHtml(t("listing.status." + l.status))}</span>
          </div>
          <div class="fields">
            ${fieldRow("listing.price", formatPrice(l.price))}
            ${fieldRow("listing.list_type", t("listing.type." + l.listType))}
            ${l.bedrooms != null ? fieldRow("listing.bedrooms", l.bedrooms) : ""}
            ${l.bathrooms != null ? fieldRow("listing.bathrooms", l.bathrooms) : ""}
            ${l.areaSqft != null ? fieldRow("listing.sqft", Number(l.areaSqft).toLocaleString("en-US") + " sqft") : ""}
            ${l.mlsNumber ? fieldRow("listing.mls", l.mlsNumber) : ""}
            ${l.description ? fieldRow("listing.description", l.description) : ""}
          </div>
          ${featuresRow}
          <div class="actions">
            <button class="btn ghost" data-listing-action="edit" data-id="${escapeHtml(l.id)}">${escapeHtml(t("listing.edit"))}</button>
            <button class="btn ghost" data-listing-action="delete" data-id="${escapeHtml(l.id)}">${escapeHtml(t("listing.delete"))}</button>
          </div>
        </article>
      `;
    })
    .join("");

  // Wire edit/delete buttons. Re-querying after innerHTML rewrite is required
  // because the previous nodes (and their listeners) are gone.
  listingsList.querySelectorAll("[data-listing-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const action = btn.dataset.listingAction;
      if (action === "edit") {
        const target = (lastData?.listings ?? []).find((x) => x.id === id);
        if (target) openListingModal(target);
      } else if (action === "delete") {
        if (confirm(t("listing.delete_confirm"))) {
          deleteListingById(id);
        }
      }
    });
  });
}

// Reset the modal form to a blank state. Used before opening in CREATE mode
// and after closing so the next open starts clean.
function resetListingForm() {
  lStreetAddress.value = "";
  lCity.value = "";
  lState.value = "";
  lZip.value = "";
  lMls.value = "";
  lListType.value = "for_sale";
  lStatus.value = "active";
  lPrice.value = "";
  lBedrooms.value = "";
  lBathrooms.value = "";
  lAreaSqft.value = "";
  lLotSqft.value = "";
  lDescription.value = "";
  lFeaturesInput.value = "";
  listingFeatures = [];
  renderFeatureChips();
}

// Populate the modal form from an existing listing. Used for EDIT mode only.
function populateListingForm(l) {
  lStreetAddress.value = l.streetAddress ?? "";
  lCity.value = l.city ?? "";
  lState.value = l.state ?? "";
  lZip.value = l.zipCode ?? "";
  lMls.value = l.mlsNumber ?? "";
  // Guard against bad values being silently accepted — fall back to defaults
  // if the stored value isn't in our allowed list.
  lListType.value = LISTING_TYPES.includes(l.listType) ? l.listType : "for_sale";
  lStatus.value = LISTING_STATUSES.includes(l.status) ? l.status : "active";
  lPrice.value = l.price ?? "";
  lBedrooms.value = l.bedrooms ?? "";
  lBathrooms.value = l.bathrooms ?? "";
  lAreaSqft.value = l.areaSqft ?? "";
  lLotSqft.value = l.lotSizeSqft ?? "";
  lDescription.value = l.description ?? "";
  lFeaturesInput.value = "";
  // Copy the array so mutating chips doesn't accidentally edit the cached listing.
  listingFeatures = Array.isArray(l.features) ? [...l.features] : [];
  renderFeatureChips();
}

// Open the modal. Pass null/undefined for CREATE mode, an existing listing
// object for EDIT mode. editingListingId is the single source of truth for
// which mode we're in — saveListing() reads it to decide POST vs PUT.
function openListingModal(listing = null) {
  if (listing) {
    editingListingId = listing.id;
    listingModalTitle.textContent = t("listing.edit");
    populateListingForm(listing);
  } else {
    editingListingId = null;
    listingModalTitle.textContent = t("listing.add");
    resetListingForm();
  }
  listingModal.hidden = false;
  // setTimeout because the focus() must run after the modal is visible.
  setTimeout(() => lStreetAddress.focus(), 50);
}

function closeListingModal() {
  listingModal.hidden = true;
  editingListingId = null;
}

// ---- Feature chips ----
// The chips array is the source of truth; the DOM is just a view of it.
function renderFeatureChips() {
  if (!listingFeatures.length) {
    lFeatureChips.innerHTML = "";
    return;
  }
  lFeatureChips.innerHTML = listingFeatures
    .map(
      (f, i) => `
      <span class="chip removable" data-chip-index="${i}">
        ${escapeHtml(f)}
        <button type="button" class="chip-remove" aria-label="Remove">×</button>
      </span>
    `
    )
    .join("");
  lFeatureChips.querySelectorAll(".chip-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.currentTarget.parentElement.dataset.chipIndex);
      listingFeatures.splice(idx, 1);
      renderFeatureChips();
    });
  });
}

// Add a chip from whatever's currently in the input. No-ops on empty or
// duplicate. Called on Enter keypress and as a "flush" before save.
function addFeatureChipFromInput() {
  const text = lFeaturesInput.value.trim();
  if (!text) return;
  if (!listingFeatures.includes(text)) {
    listingFeatures.push(text);
    renderFeatureChips();
  }
  lFeaturesInput.value = "";
}

// Save the listing — POST when creating, PUT when editing. On success, refresh
// the dashboard data (which will re-render the grid and pick up any side effects
// like a new "Active Listings" count).
async function saveListing() {
  // Flush any unconverted text in the features input into a chip first, so the
  // broker doesn't lose a half-typed feature they didn't press Enter on.
  addFeatureChipFromInput();

  // Required-field validation — matches the backend NOT NULL constraints on
  // listings.street_address / city / state (see server/store.js schema).
  const streetAddress = lStreetAddress.value.trim();
  const city = lCity.value.trim();
  // States are 2-letter USPS codes; uppercase normalizes "ca" → "CA" so
  // case-insensitive matching in notifier.js stays consistent with data entry.
  const state = lState.value.trim().toUpperCase();
  if (!streetAddress || !city || !state) {
    alert(t("listing.required_fields"));
    return;
  }

  // Convert empty number inputs to null rather than 0/NaN. The schema columns
  // are nullable, so null preserves "unknown" — important because matchesCriteria
  // in notifier.js can otherwise treat a 0 as a real value and miss matches.
  const num = (v) => {
    const s = String(v).trim();
    if (s === "") return null;
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  };

  const payload = {
    streetAddress,
    city,
    state,
    zipCode: lZip.value.trim() || null,
    mlsNumber: lMls.value.trim() || null,
    listType: lListType.value,
    status: lStatus.value,
    price: num(lPrice.value),
    bedrooms: num(lBedrooms.value),
    bathrooms: num(lBathrooms.value),
    areaSqft: num(lAreaSqft.value),
    lotSizeSqft: num(lLotSqft.value),
    description: lDescription.value.trim() || null,
    features: listingFeatures,
  };

  listingSaveBtn.disabled = true;
  try {
    const url = editingListingId
      ? `/api/listings/${encodeURIComponent(editingListingId)}`
      : "/api/listings";
    const method = editingListingId ? "PUT" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // Side effects (fire-and-forget on the server):
    //   POST → checkNewListingAlerts() → SMS to leads whose criteria match.
    //   PUT  → notifyPriceDrop() if new price < old price → SMS to listing-trackers.
    // Both happen on the server side, no client follow-up needed.
    closeListingModal();
    await refresh();
  } catch (err) {
    console.error("[saveListing]", err);
    alert(t("listing.save_error", { error: err.message }));
  } finally {
    listingSaveBtn.disabled = false;
  }
}

// DELETE the listing. Confirmation prompt happens in the caller (renderListings).
async function deleteListingById(id) {
  try {
    const res = await fetch(`/api/listings/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await refresh();
  } catch (err) {
    console.error("[deleteListingById]", err);
    alert(err.message);
  }
}

function fieldRow(labelKey, value) {
  if (value === undefined || value === null || value === "") return "";
  return `
    <div class="field-row">
      <span class="field-label">${escapeHtml(t(labelKey))}</span>
      <span class="field-value" dir="auto">${escapeHtml(value)}</span>
    </div>`;
}

function renderEmbed() {
  const snippet = `<script src="${window.location.origin}/widget.js" async></` + `script>`;
  embedSnippet.textContent = snippet;
}

function renderAll(data) {
  lastData = data;
  renderStatus(data.health);
  renderStats(data);
  renderConversations(data.conversations);
  renderLeads(data.leads);
  renderAppointments(data.appointments);
  renderListings(data.listings);
}

// ---------- Conversation modal ----------
function openConversation(id) {
  const conv = lastData?.conversations.find((c) => c.id === id);
  if (!conv) return;
  modalTitle.textContent = visitorName(conv);
  modalBody.innerHTML = conv.messages
    .map(
      (m) => `
      <div class="msg ${escapeHtml(m.role)}">
        <div class="msg-meta">${escapeHtml(t("conv.role." + m.role))} · ${escapeHtml(formatDateTime(m.at))}</div>
        <div class="msg-content" dir="auto">${escapeHtml(m.content)}</div>
      </div>
    `
    )
    .join("");
  modal.hidden = false;
}

modalCloseBtn.addEventListener("click", () => {
  modal.hidden = true;
});
modal.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal-backdrop")) modal.hidden = true;
});

// ---------- Confirm appointment modal ----------
function toLocalDatetimeInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" + pad(date.getMonth() + 1) +
    "-" + pad(date.getDate()) +
    "T" + pad(date.getHours()) +
    ":" + pad(date.getMinutes())
  );
}

function openConfirmModal(id) {
  const appt = lastData?.appointments.find((a) => a.id === id);
  if (!appt) return;
  pendingConfirmId = id;

  confirmSummary.innerHTML = [
    fieldRow("appt.visitor", appt.visitorName),
    fieldRow("appt.contact", appt.visitorContact),
    appt.propertyRef ? fieldRow("appt.property", appt.propertyRef) : "",
    fieldRow("appt.requested_time", appt.requestedTime),
    appt.notes ? fieldRow("appt.notes", appt.notes) : "",
  ].join("");

  const defaultTitle = appt.propertyRef
    ? `Showing: ${appt.propertyRef}`
    : `Consultation with ${appt.visitorName || "visitor"}`;
  confirmTitleInput.value = defaultTitle;

  // Default start: tomorrow at 14:00 local
  const dflt = new Date();
  dflt.setDate(dflt.getDate() + 1);
  dflt.setHours(14, 0, 0, 0);
  confirmStartInput.value = toLocalDatetimeInputValue(dflt);
  confirmDurationInput.value = "60";

  confirmConflict.hidden = true;
  confirmConflict.innerHTML = "";

  const gcalConnected = Boolean(lastData?.health?.googleCalendar?.connected);
  confirmCalendarStatus.hidden = gcalConnected;

  confirmModal.hidden = false;
  scheduleConflictCheck();
}

function closeConfirmModal() {
  confirmModal.hidden = true;
  pendingConfirmId = null;
  if (conflictCheckTimer) {
    clearTimeout(conflictCheckTimer);
    conflictCheckTimer = null;
  }
}

function computeConfirmTimes() {
  const startLocal = confirmStartInput.value;
  const durationMin = Math.max(15, Number(confirmDurationInput.value) || 60);
  if (!startLocal) return null;
  const start = new Date(startLocal);
  if (isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + durationMin * 60_000);
  return { start, end };
}

function scheduleConflictCheck() {
  if (conflictCheckTimer) clearTimeout(conflictCheckTimer);
  conflictCheckTimer = setTimeout(runConflictCheck, 350);
}

async function runConflictCheck() {
  const times = computeConfirmTimes();
  if (!times) {
    confirmConflict.hidden = true;
    return;
  }
  if (!lastData?.health?.googleCalendar?.connected) {
    confirmConflict.hidden = true;
    return;
  }
  try {
    const res = await fetch("/api/google/check-conflicts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startTime: times.start.toISOString(),
        endTime: times.end.toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.checked && data.hasConflict && data.conflicts.length) {
      const items = data.conflicts
        .map(
          (c) =>
            `<li>${escapeHtml(c.summary || t("confirm.conflict_unnamed"))} · ${escapeHtml(formatDateTime(c.start))}</li>`
        )
        .join("");
      confirmConflict.innerHTML = `<strong>${escapeHtml(t("confirm.conflict_title"))}</strong><ul>${items}</ul>`;
      confirmConflict.hidden = false;
    } else {
      confirmConflict.hidden = true;
    }
  } catch (err) {
    console.warn("[conflict-check]", err);
    confirmConflict.hidden = true;
  }
}

async function submitConfirm() {
  const times = computeConfirmTimes();
  if (!times) {
    alert(t("confirm.invalid_time"));
    return;
  }
  const id = pendingConfirmId;
  if (!id) return;

  confirmSubmitBtn.disabled = true;
  try {
    const res = await fetch(`/api/appointments/${encodeURIComponent(id)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "confirmed",
        startTime: times.start.toISOString(),
        endTime: times.end.toISOString(),
        title: confirmTitleInput.value.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    if (data.calendar && data.calendar.created === false && data.calendar.reason === "error") {
      alert(t("confirm.calendar_error", { error: data.calendar.error || "" }));
    }
    closeConfirmModal();
    await refresh();
  } catch (err) {
    console.error("[submitConfirm]", err);
    alert(err.message);
  } finally {
    confirmSubmitBtn.disabled = false;
  }
}

confirmCloseBtn.addEventListener("click", closeConfirmModal);
confirmCancelBtn.addEventListener("click", closeConfirmModal);
confirmModal.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal-backdrop")) closeConfirmModal();
});
confirmStartInput.addEventListener("input", scheduleConflictCheck);
confirmDurationInput.addEventListener("input", scheduleConflictCheck);
confirmSubmitBtn.addEventListener("click", submitConfirm);

// ---------- Settings: Google Calendar ----------
function renderGoogleStatus(gcal) {
  if (!gcal) {
    googleDot.className = "dot";
    googleStatusText.textContent = t("settings.calendar.unknown");
    googleConnectBtn.hidden = true;
    googleDisconnectBtn.hidden = true;
    googleNotConfiguredHint.hidden = true;
    return;
  }
  if (!gcal.configured) {
    googleDot.className = "dot err";
    googleStatusText.textContent = t("settings.calendar.not_configured_short");
    googleConnectBtn.hidden = true;
    googleDisconnectBtn.hidden = true;
    googleNotConfiguredHint.hidden = false;
    return;
  }
  if (gcal.connected) {
    googleDot.className = "dot ok";
    googleStatusText.textContent = gcal.accountEmail
      ? t("settings.calendar.connected_as", { email: gcal.accountEmail })
      : t("settings.calendar.connected");
    googleConnectBtn.hidden = true;
    googleDisconnectBtn.hidden = false;
    googleNotConfiguredHint.hidden = true;
  } else {
    googleDot.className = "dot warn";
    googleStatusText.textContent = t("settings.calendar.not_connected");
    googleConnectBtn.hidden = false;
    googleDisconnectBtn.hidden = true;
    googleNotConfiguredHint.hidden = true;
  }
}

async function disconnectGoogle() {
  if (!confirm(t("settings.calendar.disconnect_prompt"))) return;
  try {
    const res = await fetch("/api/google/disconnect", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await refresh();
  } catch (err) {
    console.error("[disconnectGoogle]", err);
    alert(err.message);
  }
}

googleDisconnectBtn.addEventListener("click", disconnectGoogle);

// Surface OAuth callback result from URL (?google=connected|error&reason=...)
function processOAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const g = params.get("google");
  if (!g) return;
  if (g === "connected") {
    // Switch to Settings tab and clean the URL
    document.querySelector('.tab[data-tab="settings"]')?.click();
  } else if (g === "error") {
    alert(t("settings.calendar.oauth_error", { reason: params.get("reason") || "" }));
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("google");
  url.searchParams.delete("reason");
  window.history.replaceState({}, "", url.toString());
}

// ---------- Actions ----------
async function updateAppointment(id, status) {
  try {
    const res = await fetch(`/api/appointments/${encodeURIComponent(id)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await refresh();
  } catch (err) {
    console.error("[updateAppointment]", err);
    alert(err.message);
  }
}

async function refresh() {
  try {
    const data = await fetchAll();
    renderAll(data);
  } catch (err) {
    console.error("[refresh]", err);
    renderStatus(null);
  }
}

// ---------- Tabs ----------
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.toggle("active", b === btn));
    tabPanels.forEach((p) =>
      p.classList.toggle("active", p.id === `panel-${btn.dataset.tab}`)
    );
  });
});

// ---------- Embed copy ----------
copyEmbedBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(embedSnippet.textContent);
    copyEmbedBtn.textContent = t("embed.copied");
    setTimeout(() => {
      copyEmbedBtn.textContent = t("embed.copy");
    }, 1500);
  } catch (err) {
    console.error("[copy]", err);
  }
});

// ---------- Language selector ----------
langSelect.addEventListener("change", (e) => setLanguage(e.target.value));
refreshBtn.addEventListener("click", refresh);

// ---------- Listings event wiring ----------
// All Listings event listeners attach here, mirroring the structure used by the
// confirm-appointment modal above. Kept together so future-self can find them.
addListingBtn.addEventListener("click", () => openListingModal());
listingCloseBtn.addEventListener("click", closeListingModal);
listingCancelBtn.addEventListener("click", closeListingModal);
listingModal.addEventListener("click", (e) => {
  // Clicking the dimmed backdrop (not the modal content) closes the modal.
  if (e.target.classList.contains("modal-backdrop")) closeListingModal();
});
listingSaveBtn.addEventListener("click", saveListing);

// Features input — Enter commits the current text as a chip. We also call
// addFeatureChipFromInput() from inside saveListing() to flush whatever's still
// in the input when the broker clicks Save without pressing Enter first.
lFeaturesInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addFeatureChipFromInput();
  }
});

// Filter dropdowns just re-render against the in-memory data — no new fetch.
listingFilterType.addEventListener("change", () => {
  if (lastData) renderListings(lastData.listings);
});
listingFilterStatus.addEventListener("change", () => {
  if (lastData) renderListings(lastData.listings);
});

// ---------- Init ----------
await setLanguage(detectInitialLang());
await refresh();
processOAuthRedirect();

// Auto-refresh every 15s so new conversations/leads/appointments appear without manual reload
setInterval(refresh, 15000);
