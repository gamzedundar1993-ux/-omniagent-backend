// Real Estate Automation — embeddable chatbot widget.
// Broker usage:
//   <script src="https://<host>/widget.js" async></script>
// Optional attributes:
//   data-locale="en|es|ar"  — force UI locale (default: auto-detect from browser)
//   data-position="left"    — pin the bubble to the bottom-left (default: bottom-right)
//
// The widget runs in a shadow DOM so the broker's site CSS cannot leak in.

(function () {
  if (window.__REA_WIDGET_LOADED__) return;
  window.__REA_WIDGET_LOADED__ = true;

  const SCRIPT = document.currentScript;
  const API_BASE = SCRIPT ? new URL(SCRIPT.src).origin : window.location.origin;
  const POSITION = SCRIPT?.getAttribute("data-position") === "left" ? "left" : "right";

  const SUPPORTED = ["en", "es", "ar"];
  const RTL = new Set(["ar"]);

  const I18N = {
    en: {
      open: "Chat with us",
      title: "How can we help?",
      subtitle: "Typically replies in a few seconds",
      greeting:
        "Hi! I'm the OmniAgent AI. Ask me about properties, schedule a showing, or leave your contact and we'll be in touch. How can I help today?",
      placeholder: "Type your message…",
      send: "Send",
      sending: "Sending…",
      close: "Close",
      error: "Something went wrong. Please try again.",
      offline: "The assistant is offline right now. Please try later.",
      langLabel: "Language",
    },
    es: {
      open: "Chatea con nosotros",
      title: "¿Cómo podemos ayudar?",
      subtitle: "Suele responder en segundos",
      greeting:
        "¡Hola! Soy el asistente virtual de esta agencia. Pregúntame sobre propiedades, agenda una visita, o déjanos tus datos y te contactaremos. ¿En qué puedo ayudarte hoy?",
      placeholder: "Escribe tu mensaje…",
      send: "Enviar",
      sending: "Enviando…",
      close: "Cerrar",
      error: "Algo salió mal. Inténtalo de nuevo.",
      offline: "El asistente no está disponible. Inténtalo más tarde.",
      langLabel: "Idioma",
    },
    ar: {
      open: "تواصل معنا",
      title: "كيف يمكننا المساعدة؟",
      subtitle: "عادةً ما يرد خلال ثوانٍ",
      greeting:
        "مرحبًا! أنا المساعد الافتراضي لهذه الوكالة العقارية. اسألني عن العقارات، احجز موعد معاينة، أو اترك بياناتك وسنتواصل معك. كيف يمكنني المساعدة اليوم؟",
      placeholder: "اكتب رسالتك…",
      send: "إرسال",
      sending: "جارٍ الإرسال…",
      close: "إغلاق",
      error: "حدث خطأ. حاول مرة أخرى.",
      offline: "المساعد غير متاح حاليًا. حاول لاحقًا.",
      langLabel: "اللغة",
    },
  };

  function detectLocale() {
    const override = SCRIPT?.getAttribute("data-locale");
    if (override && SUPPORTED.includes(override)) return override;
    const stored = localStorage.getItem("rea_widget_locale");
    if (stored && SUPPORTED.includes(stored)) return stored;
    const navLang = (navigator.language || "en").slice(0, 2);
    return SUPPORTED.includes(navLang) ? navLang : "en";
  }

  let locale = detectLocale();
  let t = I18N[locale];
  let conversationId = localStorage.getItem("rea_widget_conv_id");
  let isOpen = false;
  let isSending = false;
  let hasGreeted = false;

  // ---------- Shadow DOM host ----------
  const host = document.createElement("div");
  host.id = "rea-widget-host";
  host.style.cssText = "all: initial;";
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
      .wrap {
        position: fixed;
        bottom: 20px;
        ${POSITION === "left" ? "left" : "right"}: 20px;
        z-index: 2147483647;
        color: #ececec;
      }
      .bubble {
        width: 60px; height: 60px;
        border-radius: 50%;
        background: linear-gradient(135deg, #000000, #10b981);
        color: white;
        border: none;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(16,185,129,0.32);
        display: flex; align-items: center; justify-content: center;
        transition: transform .15s ease, box-shadow .15s ease;
      }
      .bubble:hover { transform: translateY(-2px); box-shadow: 0 10px 28px rgba(16,185,129,0.45); }
      .bubble svg { width: 26px; height: 26px; }
      .panel {
        position: absolute;
        bottom: 76px;
        ${POSITION === "left" ? "left" : "right"}: 0;
        width: 360px;
        max-width: calc(100vw - 40px);
        height: 540px;
        max-height: calc(100vh - 120px);
        background: #0a0a0a;
        border: 1px solid #262626;
        border-radius: 14px;
        box-shadow: 0 16px 48px rgba(0,0,0,0.55);
        display: none;
        flex-direction: column;
        overflow: hidden;
      }
      .panel.open { display: flex; }
      .header {
        background: linear-gradient(135deg, #000000, #10b981);
        color: white;
        padding: 14px 16px;
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px;
      }
      .header h3 { margin: 0; font-size: 15px; font-weight: 600; }
      .header p { margin: 2px 0 0; font-size: 12px; opacity: 0.9; }
      .header-actions { display: flex; align-items: center; gap: 8px; }
      .lang-select {
        background: rgba(255,255,255,0.18);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 4px 6px;
        font-size: 12px;
        cursor: pointer;
      }
      .lang-select option { color: #ececec; background: #121212; }
      .close-btn {
        background: rgba(255,255,255,0.15);
        color: white;
        border: none;
        border-radius: 6px;
        width: 28px; height: 28px;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
      }
      .close-btn:hover { background: rgba(255,255,255,0.25); }
      .messages {
        flex: 1;
        padding: 14px;
        overflow-y: auto;
        background: #0a0a0a;
        display: flex; flex-direction: column; gap: 8px;
      }
      .msg {
        max-width: 80%;
        padding: 9px 12px;
        border-radius: 12px;
        font-size: 14px;
        line-height: 1.4;
        word-wrap: break-word;
        white-space: pre-wrap;
      }
      .msg.bot { background: #1a1a1a; color: #ececec; align-self: flex-start; border: 1px solid #262626; border-bottom-left-radius: 4px; }
      .msg.user { background: #10b981; color: #0a0a0a; align-self: flex-end; border-bottom-right-radius: 4px; font-weight: 500; }
      :host-context([dir="rtl"]) .msg.bot, .rtl .msg.bot { align-self: flex-end; border-bottom-left-radius: 12px; border-bottom-right-radius: 4px; }
      :host-context([dir="rtl"]) .msg.user, .rtl .msg.user { align-self: flex-start; border-bottom-right-radius: 12px; border-bottom-left-radius: 4px; }
      .typing { display: flex; gap: 4px; padding: 9px 12px; background: #1a1a1a; border: 1px solid #262626; border-radius: 12px; align-self: flex-start; width: fit-content; }
      .typing span { width: 6px; height: 6px; border-radius: 50%; background: #10b981; animation: blink 1.2s infinite both; }
      .typing span:nth-child(2) { animation-delay: .2s; }
      .typing span:nth-child(3) { animation-delay: .4s; }
      @keyframes blink { 0%, 60%, 100% { opacity: .3; } 30% { opacity: 1; } }
      .footer {
        border-top: 1px solid #262626;
        padding: 10px;
        background: #0a0a0a;
        display: flex; gap: 8px;
      }
      .footer textarea {
        flex: 1;
        background: #1a1a1a;
        color: #ececec;
        border: 1px solid #262626;
        border-radius: 10px;
        padding: 9px 11px;
        font-size: 14px;
        font-family: inherit;
        resize: none;
        outline: none;
        max-height: 100px;
        min-height: 38px;
      }
      .footer textarea::placeholder { color: #6b7280; }
      .footer textarea:focus { border-color: #10b981; box-shadow: 0 0 0 3px rgba(16,185,129,0.22); }
      .send-btn {
        background: #10b981;
        color: #0a0a0a;
        border: none;
        border-radius: 10px;
        padding: 0 14px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
      }
      .send-btn:hover:not([disabled]) { background: #34d399; }
      .send-btn[disabled] { opacity: 0.5; cursor: not-allowed; }
      @media (max-width: 480px) {
        .panel { width: calc(100vw - 24px); ${POSITION === "left" ? "left: 12px" : "right: 12px"}; bottom: 76px; max-height: calc(100vh - 96px); }
        .wrap { ${POSITION === "left" ? "left" : "right"}: 12px; bottom: 12px; }
      }
    </style>

    <div class="wrap" id="wrap">
      <button class="bubble" id="bubbleBtn" aria-label="${escapeAttr(t.open)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
        </svg>
      </button>
      <div class="panel" id="panel" role="dialog" aria-label="Chat">
        <div class="header">
          <div>
            <h3 id="title">${escapeHtml(t.title)}</h3>
            <p id="subtitle">${escapeHtml(t.subtitle)}</p>
          </div>
          <div class="header-actions">
            <select class="lang-select" id="langSelect" aria-label="${escapeAttr(t.langLabel)}">
              <option value="en">English</option>
              <option value="es">Español</option>
              <option value="ar">العربية</option>
            </select>
            <button class="close-btn" id="closeBtn" aria-label="${escapeAttr(t.close)}">×</button>
          </div>
        </div>
        <div class="messages" id="messages"></div>
        <div class="footer">
          <textarea id="input" rows="1" placeholder="${escapeAttr(t.placeholder)}"></textarea>
          <button class="send-btn" id="sendBtn">${escapeHtml(t.send)}</button>
        </div>
      </div>
    </div>
  `;

  const bubbleBtn = shadow.getElementById("bubbleBtn");
  const panel = shadow.getElementById("panel");
  const closeBtn = shadow.getElementById("closeBtn");
  const messagesEl = shadow.getElementById("messages");
  const input = shadow.getElementById("input");
  const sendBtn = shadow.getElementById("sendBtn");
  const langSelect = shadow.getElementById("langSelect");
  const titleEl = shadow.getElementById("title");
  const subtitleEl = shadow.getElementById("subtitle");
  const wrap = shadow.getElementById("wrap");

  function applyLocale() {
    t = I18N[locale];
    titleEl.textContent = t.title;
    subtitleEl.textContent = t.subtitle;
    input.placeholder = t.placeholder;
    sendBtn.textContent = isSending ? t.sending : t.send;
    bubbleBtn.setAttribute("aria-label", t.open);
    closeBtn.setAttribute("aria-label", t.close);
    langSelect.value = locale;
    if (RTL.has(locale)) {
      wrap.classList.add("rtl");
      wrap.setAttribute("dir", "rtl");
    } else {
      wrap.classList.remove("rtl");
      wrap.setAttribute("dir", "ltr");
    }
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function addMessage(role, text) {
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    el.setAttribute("dir", "auto");
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function showTyping() {
    const el = document.createElement("div");
    el.className = "typing";
    el.innerHTML = "<span></span><span></span><span></span>";
    el.id = "typingIndicator";
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function hideTyping() {
    const el = shadow.getElementById("typingIndicator");
    if (el) el.remove();
  }

  async function startConversation() {
    const res = await fetch(`${API_BASE}/api/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: locale }),
    });
    if (!res.ok) throw new Error(`start failed: ${res.status}`);
    const data = await res.json();
    conversationId = data.conversationId;
    localStorage.setItem("rea_widget_conv_id", conversationId);
    return conversationId;
  }

  async function postMessage(text) {
    if (!conversationId) await startConversation();
    let res = await fetch(`${API_BASE}/api/chat/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, message: text }),
    });
    if (res.status === 404) {
      localStorage.removeItem("rea_widget_conv_id");
      conversationId = null;
      await startConversation();
      res = await fetch(`${API_BASE}/api/chat/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message: text }),
      });
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `send failed: ${res.status}`);
    }
    return res.json();
  }

  async function send() {
    const text = input.value.trim();
    if (!text || isSending) return;
    input.value = "";
    input.style.height = "auto";
    addMessage("user", text);

    isSending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = t.sending;
    showTyping();

    try {
      const data = await postMessage(text);
      hideTyping();
      if (data.reply) addMessage("bot", data.reply);
    } catch (err) {
      hideTyping();
      addMessage("bot", t.error);
      console.error("[rea-widget]", err);
    } finally {
      isSending = false;
      sendBtn.disabled = false;
      sendBtn.textContent = t.send;
      input.focus();
    }
  }

  bubbleBtn.addEventListener("click", () => {
    isOpen = !isOpen;
    panel.classList.toggle("open", isOpen);
    if (isOpen && !hasGreeted) {
      hasGreeted = true;
      let finalGreeting = t.greeting;
      const isDemoSite = window.location.hostname.includes("omniagent") || window.location.hostname.includes("lovable.app");
      if (isDemoSite && locale === "en") {
        finalGreeting = "Hi! I am the OmniAgent AI Demo. I help real estate brokers automate their sales 24/7. To see how I work, please pretend to be a home buyer and ask me to find a house, or ask me how I can help your agency!";
      }
      addMessage("bot", finalGreeting);
      setTimeout(() => input.focus(), 50);
    } else if (isOpen) {
      setTimeout(() => input.focus(), 50);
    }
  });
  closeBtn.addEventListener("click", () => {
    isOpen = false;
    panel.classList.remove("open");
  });

  langSelect.addEventListener("change", (e) => {
    locale = e.target.value;
    localStorage.setItem("rea_widget_locale", locale);
    applyLocale();
  });

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 100) + "px";
  });

  applyLocale();
})();
