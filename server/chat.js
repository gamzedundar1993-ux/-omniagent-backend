import Anthropic from "@anthropic-ai/sdk";
import {
  appendMessage,
  createAppointment,
  createLead,
  updateConversationMeta,
  createPropertyTrack,
  confirmAppointmentWithEvent,
} from "./store.js";
import { findMatches, formatListingForBot } from "./matcher.js";
import { getConnectionStatus, checkConflicts, createCalendarEvent } from "./google.js";
import { sendConfirmationSms } from "./sms.js";

let client = null;

function getClient() {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to your .env file.");
  }
  client = new Anthropic({ apiKey });
  return client;
}

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const MAX_TOOL_HOPS = 5;

const companyName = process.env.COMPANY_NAME || "[ŞİRKET ADI]";
const assistantName = process.env.ASSISTANT_NAME || "[ASISTAN ADI]";

function getSystemPrompt() {
  const CURRENT_DATE = new Date().toISOString();
  return `You are the energetic, goal-oriented sales pre-assistant for the real estate company "${companyName}". Your name is "${assistantName}".
Your role is to warmly welcome clients, quickly understand their needs, recommend matching listings, and coordinate appointments with the sales team.

# Current Date and Time
The current date and time is: ${CURRENT_DATE}. Use this to resolve relative dates like "tomorrow" or "next Tuesday" when booking appointments. Assume standard appointments are 1 hour long.

# Language and Auto-Detection
Detect the visitor's language from their messages and respond in the SAME language. You fully support Turkish, English, Spanish, Arabic, or any other language they write in. If the visitor switches languages mid-conversation, switch with them immediately and naturally without commenting on or apologizing for the switch.

# Conversation Flow
Follow this exact sequence with every customer:

1. WARM WELCOME (Karşılama):
   - Provide a warm, enthusiastic, and energetic greeting.
   - Conversationally learn the visitor's name.

2. NEEDS ASSESSMENT (İhtiyaç tespiti):
   - Conversationally and naturally gather the following details one by one (do not ask all at once):
     - IF THE VISITOR IS A SELLER (Selling their property): Ask briefly about their property (location, size) and immediately offer to schedule a "Free Home Valuation / Consultation" (Ücretsiz Ekspertiz Değerlemesi) appointment with the broker.
     - IF THE VISITOR IS A BUYER OR RENTER:
       - Are they looking to buy or rent? (for_sale vs for_rent)
       - Are they looking for residential or commercial property?
       - Preferred location / neighborhood.
       - Budget range. When gathering budget, ask this exact question (translated to their language): "How much can you set aside for a down payment, and do you have a monthly installment preference?" (Turkish: "Peşinat için ne kadar ayırabilirsiniz ve aylık taksit tercihiniz var mı?")
       - Preferences like square footage (area_sqft), number of bedrooms/bathrooms.
       - Timeline (when do they want to move?).

3. LISTING RECOMMENDATIONS (İlan önerisi):
   - Call the 'search_properties' tool as soon as they mention budget, bedrooms, city, or property type. Do not wait for all fields.
   - Propose the 2-3 most suitable listings returned by the search. For each recommended listing, specify:
     - Location and price.
     - 2-3 highlight features (e.g. square footage, floor/level, etc.).
     - Explain why this property is a great fit for them.
   - Use concrete numbers (price, sqft, floor level, etc.) and highlight value/benefits before discussing price.

4. APPOINTMENT COORDINATION (Randevu ayarlama):
   - Offer an on-site viewing (yerinde görüntüleme) or an online consultation (online görüşme) to interested clients.
   - To request an appointment, collect:
     - Full name.
     - Phone number.
     - Preferred day and time.
   - Once collected, call the 'request_appointment' tool.

5. POSITIVE CLOSING (Kapanış):
   - Conclude every conversation with a highly positive, polite closing.
   - Leave the company contact info and state that you or the team will send a follow-up message.

# Tone and Communication Rules
- Energetic, positive, professional, and reassuring.
- Use short, clear sentences. Avoid long paragraphs.
- Use the visitor's name throughout the conversation once you know it.
- Value-oriented: Explain the benefits and lifestyle features of a property before stating the price.
- Create urgency using real, factual data (e.g. "Only 2 similar listings left in this neighborhood at this price point").
- Do NOT make up information. If you do not know something, say: "Our sales team will inform you about this." (Turkish: "Satış ekibimiz sizi bilgilendirecek.")
- Do NOT negotiate prices. Note their budget and pass it to the sales team.
- Do NOT pressure the visitor. If they are not interested, thank them politely and close the conversation.
- Do NOT give any legal guarantees, title deed status assurances, or promise guaranteed financial returns.

# Pricing and Payment Information
- When a price is requested, state the listing price directly.
- Generalize other costs: outline title deed fees (tapu harcı), agency commission, and other extra costs in broad terms.
- Summarize payment options: cash (peşin), bank loan (banka kredisi), or installment plans (taksitli ödeme planı) if available.
- Emphasize active campaigns or discounts if any are mentioned in the property info.
- Direct the client to the sales team for any specific price negotiation or discount request.

# Boundaries and Redirection
- Politely redirect the client to the sales team in these situations:
  - Price negotiation or custom discount requests.
  - Technical structure, title deed (tapu) status, or legal questions.
  - Custom requests not supported by the system.
  - Complaints or dissatisfaction.
- Redirection phrase (use this template, translated to their language):
  "Our expert advisor can provide the most accurate information on this matter. Can I connect you via [phone/email/WhatsApp]?"
  (Turkish: "Bu konuda size en doğru bilgiyi uzman danışmanımız verebilir. Sizi [telefon/e-posta/WhatsApp] üzerinden bağlayabilir miyim?")
- Keep polite boundaries for non-real estate topics (politics, personal questions, etc.) and guide the conversation back to real estate.

# Important
- The visitor cannot see tool calls — they only see your text responses. Always provide a friendly natural-language acknowledgment after calling a tool.
- For tracking property or search alerts, if they are interested in a specific property (e.g. loves a listing, wants updates, or thinks it's a bit out of their budget), or are searching for something specific that is not currently available, offer to set up an SMS Tracking Alert. To set up tracking, collect their full name and phone number and call the 'track_property' tool. Acknowledge friendly (e.g., 'I've set up an SMS tracking alert for you!').`;
}

const TOOLS = [
  {
    name: "search_properties",
    description:
      "Search the broker's active listings by visitor criteria. Call this as soon as the visitor mentions budget, bedrooms, city, property type, or any housing preference. Returns up to 3 best-matching properties.",
    input_schema: {
      type: "object",
      properties: {
        list_type: {
          type: "string",
          enum: ["for_sale", "for_rent"],
          description: "Whether the visitor wants to buy or rent",
        },
        min_price: { type: "number", description: "Minimum budget in USD" },
        max_price: { type: "number", description: "Maximum budget in USD" },
        min_bedrooms: { type: "number", description: "Minimum number of bedrooms" },
        max_bedrooms: { type: "number", description: "Maximum number of bedrooms" },
        min_bathrooms: { type: "number", description: "Minimum number of bathrooms" },
        city: { type: "string", description: "City name" },
        state: { type: "string", description: "2-letter US state code (e.g. TX, FL)" },
        min_sqft: { type: "number", description: "Minimum square footage" },
        max_sqft: { type: "number", description: "Maximum square footage" },
      },
    },
  },
  {
    name: "capture_lead",
    description:
      "Save the visitor as a lead for the broker to follow up. Call this once you have collected the visitor's name plus at least one contact method (email OR phone). Safe to call again with additional info — each call creates a new lead record, so prefer to call exactly once per conversation when you have meaningful info.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Visitor's name" },
        email: { type: "string", description: "Visitor's email address" },
        phone: { type: "string", description: "Visitor's phone number" },
        notes: {
          type: "string",
          description:
            "Brief context — what the visitor is looking for, budget, timeline, etc. ALWAYS write notes in English regardless of conversation language, since the broker dashboard is English.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "request_appointment",
    description:
      "Submit a property showing, walkthrough, or consultation request from the visitor to the broker. Use only when the visitor has explicitly asked for an appointment AND you have collected name, contact, and a preferred time.",
    input_schema: {
      type: "object",
      properties: {
        visitor_name: { type: "string", description: "Visitor's full name" },
        visitor_contact: {
          type: "string",
          description: "Email or phone number for the broker to confirm with",
        },
        property_ref: {
          type: "string",
          description:
            "Property address, MLS number, or short description. Leave blank if no specific property — broker will follow up to clarify.",
        },
        requested_time: {
          type: "string",
          description:
            "Visitor's preferred time in their own words (e.g. 'Saturday at 2pm', 'weekday mornings next week')",
        },
        start_iso: {
          type: "string",
          description: "The calculated start time in ISO 8601 format (e.g. 2026-06-18T14:00:00Z) based on the current date and requested_time.",
        },
        end_iso: {
          type: "string",
          description: "The calculated end time in ISO 8601 format (e.g. 2026-06-18T15:00:00Z), typically 1 hour after start_iso.",
        },
        notes: {
          type: "string",
          description:
            "Any additional context. ALWAYS write notes in English regardless of conversation language.",
        },
      },
      required: ["visitor_name", "visitor_contact", "requested_time", "start_iso", "end_iso"],
    },
  },
  {
    name: "track_property",
    description:
      "Set up property tracking or search criteria tracking for the visitor. Call this when the visitor wants to track a specific property for price drops/status updates, OR wants to save their search criteria to get SMS alerts when new matching properties are posted. Requires visitor name and phone number.",
    input_schema: {
      type: "object",
      properties: {
        visitor_name: { type: "string", description: "Visitor's full name" },
        visitor_phone: { type: "string", description: "Visitor's phone number for SMS alerts" },
        listing_id: {
          type: "string",
          description: "ID of the specific property listing they want to track. Leave blank if they are saving search criteria (saved search alert).",
        },
        search_criteria: {
          type: "object",
          description: "Search criteria filters if they are setting up a search criteria tracking alert (saved search).",
          properties: {
            list_type: { type: "string", enum: ["for_sale", "for_rent"] },
            min_price: { type: "number" },
            max_price: { type: "number" },
            min_bedrooms: { type: "number" },
            max_bedrooms: { type: "number" },
            min_bathrooms: { type: "number" },
            city: { type: "string" },
            state: { type: "string" },
          }
        },
        notes: {
          type: "string",
          description: "Context or notes. Write in English.",
        }
      },
      required: ["visitor_name", "visitor_phone"],
    },
  },
];

export async function handleChat({ conversationId, conversation, userMessage }) {
  const c = getClient();

  appendMessage(conversationId, { role: "user", content: userMessage });

  const workingHistory = conversation.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  workingHistory.push({ role: "user", content: userMessage });

  const toolEvents = [];
  let lastResponse = null;

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    lastResponse = await c.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      system: getSystemPrompt(),
      tools: TOOLS,
      messages: workingHistory,
    });

    const toolUseBlocks = lastResponse.content.filter(
      (b) => b.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) break;

    const toolResults = [];
    for (const tool of toolUseBlocks) {
      let resultText;
      try {
        if (tool.name === "search_properties") {
          const criteria = {
            list_type: tool.input.list_type,
            min_price: tool.input.min_price,
            max_price: tool.input.max_price,
            min_bedrooms: tool.input.min_bedrooms,
            max_bedrooms: tool.input.max_bedrooms,
            min_bathrooms: tool.input.min_bathrooms,
            city: tool.input.city,
            state: tool.input.state,
            min_sqft: tool.input.min_sqft,
            max_sqft: tool.input.max_sqft,
          };
          const matches = findMatches(criteria, 3);
          if (matches.length === 0) {
            resultText = "No active listings match the visitor's criteria right now. Let them know and ask if they'd like to adjust their search.";
          } else {
            const lines = matches.map(({ listing, scorePercent }, i) =>
              formatListingForBot(listing, i + 1, scorePercent)
            );
            resultText = `Found ${matches.length} matching listing(s):\n${lines.join("\n")}`;
          }
          toolEvents.push({ type: "property_search", count: matches.length });
        } else if (tool.name === "capture_lead") {
          const lead = createLead({
            conversationId,
            name: tool.input.name,
            email: tool.input.email,
            phone: tool.input.phone,
            notes: tool.input.notes,
          });
          updateConversationMeta(conversationId, {
            name: tool.input.name,
            email: tool.input.email,
            phone: tool.input.phone,
          });
          toolEvents.push({ type: "lead_captured", id: lead.id });
          resultText = `Lead saved (id: ${lead.id}). The broker will follow up.`;
        } else if (tool.name === "request_appointment") {
          const appt = createAppointment({
            conversationId,
            visitorName: tool.input.visitor_name,
            visitorContact: tool.input.visitor_contact,
            propertyRef: tool.input.property_ref,
            requestedTime: tool.input.requested_time,
            notes: tool.input.notes,
          });
          toolEvents.push({ type: "appointment_requested", id: appt.id });

          // Attempt Auto-Booking
          const { connected } = getConnectionStatus();
          let autoConfirmed = false;
          if (connected && tool.input.start_iso && tool.input.end_iso) {
            try {
              const conflictCheck = await checkConflicts({
                startIso: tool.input.start_iso,
                endIso: tool.input.end_iso,
              });
              if (!conflictCheck.hasConflict) {
                const summary = tool.input.property_ref
                  ? `Showing: ${tool.input.property_ref}`
                  : `Consultation with ${tool.input.visitor_name}`;
                
                const eventInfo = await createCalendarEvent({
                  summary,
                  description: `Booked via AI Chatbot.\nVisitor: ${tool.input.visitor_name}\nContact: ${tool.input.visitor_contact}\nProperty: ${tool.input.property_ref ?? "—"}\nNotes: ${tool.input.notes ?? "—"}`,
                  startIso: tool.input.start_iso,
                  endIso: tool.input.end_iso,
                  attendeeEmail: tool.input.visitor_contact.includes("@") ? tool.input.visitor_contact : null,
                });

                confirmAppointmentWithEvent(appt.id, {
                  confirmedStart: tool.input.start_iso,
                  confirmedEnd: tool.input.end_iso,
                  googleEventId: eventInfo.id,
                  calendarHtmlLink: eventInfo.htmlLink,
                });
                
                // Fire off confirmation SMS asynchronously
                sendConfirmationSms(appt).catch(err => console.error("Failed to send auto-confirm SMS:", err));
                autoConfirmed = true;
              }
            } catch (err) {
              console.error("[chat auto-book error]", err);
            }
          }

          if (autoConfirmed) {
            resultText = `Appointment automatically confirmed and scheduled! The event was added to the broker's calendar and an SMS confirmation was sent. Inform the user the slot is confirmed.`;
          } else {
            resultText = `Appointment request saved (id: ${appt.id}). Status: pending. The requested slot might have conflicts or the calendar is disconnected. Tell the user the broker will review and confirm.`;
          }
        } else if (tool.name === "track_property") {
          const lead = createLead({
            conversationId,
            name: tool.input.visitor_name,
            phone: tool.input.visitor_phone,
            notes: `Interested in property tracking. ${tool.input.notes ?? ""}`,
          });
          updateConversationMeta(conversationId, {
            name: tool.input.visitor_name,
            phone: tool.input.visitor_phone,
          });
          
          const track = createPropertyTrack({
            leadId: lead.id,
            listingId: tool.input.listing_id || null,
            searchCriteria: tool.input.search_criteria || {},
          });
          
          toolEvents.push({ type: "property_track_created", id: track.id });
          const typeLabel = tool.input.listing_id ? "property price alert" : "new matching listing alert";
          resultText = `Property tracking alert set up successfully (id: ${track.id}, type: ${typeLabel}). The system will send SMS notifications to ${tool.input.visitor_phone} when updates occur.`;
        } else {
          resultText = `Unknown tool: ${tool.name}`;
        }
      } catch (err) {
        console.error(`[chat] tool ${tool.name} error:`, err);
        resultText = `Tool error: ${err.message}`;
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: tool.id,
        content: resultText,
      });
    }

    workingHistory.push({ role: "assistant", content: lastResponse.content });
    workingHistory.push({ role: "user", content: toolResults });
  }

  const replyText =
    lastResponse?.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim() || "Thanks — I've noted that. The broker will follow up shortly.";

  appendMessage(conversationId, { role: "assistant", content: replyText });

  return {
    reply: replyText,
    events: toolEvents,
  };
}
