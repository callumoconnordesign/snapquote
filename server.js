// server.js — JD Leak Detection: omnichannel AI receptionist + WhatsApp photo triage
//
// Every channel is an on-ramp to ONE WhatsApp number where the brain lives:
//   - Missed calls  -> voice message + text-back with WhatsApp link
//   - Website       -> floating "WhatsApp us a photo" widget (GET /widget.js)
//   - QR / links    -> wa.me deep link (see GET /channels for your kit)
//   - WhatsApp      -> photos trigger vision triage -> price band -> booking
//   - Booked/urgent -> pushed to YOUR personal WhatsApp with the photo attached

import "dotenv/config";
import express from "express";
import twilio from "twilio";
import QRCode from "qrcode";
import { runAgentTurn } from "./agent.js";
import { getConversation, updateConversation, allLeads, maybeExpire } from "./store.js";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_VOICE_NUMBER,
  TWILIO_WHATSAPP_FROM, // whatsapp:+44... (production) or sandbox whatsapp:+14155238886
  OWNER_WHATSAPP,
  OWNER_SMS_FALLBACK,
  BUSINESS_NAME = "JD Leak Detection",
  MISSED_CALL_TEMPLATE_SID,
  PUBLIC_URL, // e.g. https://your-app.up.railway.app (used on /channels)
  VALIDATE_TWILIO_SIGNATURES = "false",
  PORT = 3000,
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const app = express();
app.use(express.urlencoded({ extended: false }));

const guard =
  VALIDATE_TWILIO_SIGNATURES === "true"
    ? twilio.webhook({ authToken: TWILIO_AUTH_TOKEN })
    : (req, res, next) => next();

const bare = (n) => (n || "").replace(/^whatsapp:/, "");
const waDigits = () => bare(TWILIO_WHATSAPP_FROM).replace("+", "");
const waLink = (text) =>
  `https://wa.me/${waDigits()}${text ? `?text=${encodeURIComponent(text)}` : ""}`;

// ---------------------------------------------------------------
// Media: pull WhatsApp photos from Twilio and hand them to Claude
// ---------------------------------------------------------------
async function fetchMediaAsBase64(url) {
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`media fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) throw new Error("media too large");
  return buf.toString("base64");
}

async function buildUserContent(req) {
  const text = (req.body.Body || "").trim();
  const numMedia = parseInt(req.body.NumMedia || "0", 10);
  const blocks = [];
  let hadUnsupported = false;

  for (let i = 0; i < Math.min(numMedia, 3); i++) {
    const type = req.body[`MediaContentType${i}`] || "";
    const url = req.body[`MediaUrl${i}`];
    if (type.startsWith("image/") && url) {
      try {
        const data = await fetchMediaAsBase64(url);
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: type === "image/png" ? "image/png" : "image/jpeg", data },
        });
      } catch (err) {
        console.error("Media fetch failed:", err.message);
        hadUnsupported = true;
      }
    } else if (url) {
      hadUnsupported = true; // video/audio/pdf etc.
    }
  }

  let note = text;
  if (!note && blocks.length) note = "Here's a photo of the problem.";
  if (hadUnsupported)
    note += (note ? "\n\n" : "") + "[Note: the customer also sent a video or file you can't view — ask for photos instead.]";
  blocks.push({ type: "text", text: note || "(empty message)" });

  const firstMediaUrl = numMedia > 0 ? req.body.MediaUrl0 : null;
  return { content: blocks, hasImages: blocks.length > 1, firstMediaUrl };
}

// ---------------------------------------------------------------
// Outbound helpers
// ---------------------------------------------------------------
async function sendToCustomer(number, channel, body) {
  if (channel === "whatsapp" && TWILIO_WHATSAPP_FROM) {
    return client.messages.create({ from: TWILIO_WHATSAPP_FROM, to: `whatsapp:${number}`, body });
  }
  return client.messages.create({ from: TWILIO_VOICE_NUMBER, to: number, body });
}

async function notifyOwner(text, mediaUrl) {
  try {
    if (OWNER_WHATSAPP && TWILIO_WHATSAPP_FROM) {
      await client.messages.create({
        from: TWILIO_WHATSAPP_FROM,
        to: OWNER_WHATSAPP,
        body: text,
        ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {}),
      });
      return;
    }
    throw new Error("WhatsApp owner notify not configured");
  } catch (err) {
    console.error("Owner WhatsApp notify failed:", err.message);
    if (OWNER_SMS_FALLBACK) {
      await client.messages
        .create({ from: TWILIO_VOICE_NUMBER, to: OWNER_SMS_FALLBACK, body: text })
        .catch((e) => console.error("Owner SMS fallback failed:", e.message));
    }
  }
}

function leadSummary(number, lead, header) {
  const line = (label, v) => (v ? `${label}: ${v}\n` : "");
  const band =
    lead.band_low && lead.band_high ? `£${lead.band_low}-£${lead.band_high} (${lead.confidence || "?"} confidence)` : null;
  return (
    `${header}\n` +
    line("Service", lead.service) +
    line("Detail", lead.symptom_or_spec) +
    line("Location", lead.location) +
    line("Urgency", lead.urgency) +
    line("Price band", band) +
    line("Site visit", lead.site_visit) +
    (lead.insurance ? "Insurance job: yes\n" : "") +
    line("Safety flag", lead.red_flags) +
    line("Name", lead.name) +
    line("Provisional slot", lead.slot) +
    `Number: ${number}\n` +
    `Reply to them directly or call to confirm.`
  );
}

async function maybeNotifyOwner(number, convo) {
  const lead = convo.lead || {};
  const status = lead.status;
  const already = convo.notifiedStatus;
  const photo = convo.lastMediaUrl || null;

  if (lead.urgency === "Emergency" && already !== "emergency" && status !== "booked") {
    await notifyOwner(leadSummary(number, lead, `🚨 EMERGENCY lead — call back ASAP (${BUSINESS_NAME})`), photo);
    updateConversation(number, { notifiedStatus: "emergency" });
    return;
  }
  if (status === "booked" && already !== "booked") {
    await notifyOwner(leadSummary(number, lead, `✅ JOB BOOKED (provisional) — ${BUSINESS_NAME}`), photo);
    updateConversation(number, { notifiedStatus: "booked" });
    return;
  }
  if ((status === "qualified" || status === "triaged") && !already) {
    await notifyOwner(leadSummary(number, lead, `📋 New triaged lead — ${BUSINESS_NAME}`), photo);
    updateConversation(number, { notifiedStatus: "qualified" });
  }
}

// ---------------------------------------------------------------
// 1) Missed call -> instant text-back pushing to WhatsApp photo triage
// ---------------------------------------------------------------
app.post("/voice/missed-call", guard, async (req, res) => {
  const caller = req.body.From;
  console.log("Missed call from:", caller);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(
    { voice: "Polly.Amy", language: "en-GB" },
    `Thanks for calling ${BUSINESS_NAME}. We're out on a job right now, but we're sending you a text this second — send us a photo of the problem and we'll give you a price straight away.`
  );
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());

  if (!caller || caller === "anonymous") return;

  try {
    let channel = "sms";
    if (TWILIO_WHATSAPP_FROM && MISSED_CALL_TEMPLATE_SID) {
      await client.messages.create({
        from: TWILIO_WHATSAPP_FROM,
        to: `whatsapp:${caller}`,
        contentSid: MISSED_CALL_TEMPLATE_SID,
      });
      channel = "whatsapp";
    } else {
      await client.messages.create({
        from: TWILIO_VOICE_NUMBER,
        to: caller,
        body:
          `Sorry we missed your call — ${BUSINESS_NAME} here. ` +
          `Send us a photo of the problem on WhatsApp and we'll give you a price band straight away: ` +
          `${waLink("Hi, I just called — here's my problem:")} — or just reply to this text.`,
      });
    }
    updateConversation(caller, { channel });
    console.log(`Text-back sent to ${caller} via ${channel}`);
  } catch (err) {
    console.error("Text-back failed:", err.message);
    await notifyOwner(`⚠️ Missed call from ${caller} but the text-back failed (${err.message}). Call them back.`);
  }
});

// ---------------------------------------------------------------
// 2) Inbound WhatsApp (with photos) + SMS share the same brain
// ---------------------------------------------------------------
async function handleInbound(req, res, channel) {
  const from = bare(req.body.From);
  console.log(`Inbound ${channel} from ${from}: ${req.body.Body || ""} (media: ${req.body.NumMedia || 0})`);
  res.type("text/xml").send("<Response></Response>");

  maybeExpire(from);
  const convo = getConversation(from);
  convo.channel = channel;

  try {
    const { content, hasImages, firstMediaUrl } = await buildUserContent(req);
    if (content.length === 1 && content[0].text === "(empty message)") return;

    const { reply, lead, rawAssistant } = await runAgentTurn(convo.history, content);

    const history = [
      ...convo.history,
      { role: "user", content },
      { role: "assistant", content: rawAssistant },
    ].slice(-12); // keep last 6 exchanges (images make turns heavy)

    const mergedLead = lead ? { ...convo.lead, ...lead } : convo.lead;
    updateConversation(from, {
      history,
      lead: mergedLead,
      channel,
      ...(hasImages && firstMediaUrl ? { lastMediaUrl: firstMediaUrl } : {}),
    });

    await sendToCustomer(from, channel, reply);
    await maybeNotifyOwner(from, getConversation(from));
  } catch (err) {
    console.error("Agent turn failed:", err.message);
    await sendToCustomer(
      from,
      channel,
      `Sorry — small technical hiccup our end. A member of the ${BUSINESS_NAME} team will get back to you shortly.`
    ).catch(() => {});
    await notifyOwner(`⚠️ Assistant error talking to ${from}. Please pick this one up.`);
  }
}

app.post("/whatsapp/inbound", guard, (req, res) => handleInbound(req, res, "whatsapp"));
app.post("/sms/inbound", guard, (req, res) => handleInbound(req, res, "sms"));

// ---------------------------------------------------------------
// 3) Website widget — paste one line on any site
// ---------------------------------------------------------------
app.get("/widget.js", (_req, res) => {
  res.type("application/javascript").send(`(function(){
  var link=${JSON.stringify(waLink("Hi, I'd like a price — I can send a photo of the problem."))};
  var a=document.createElement('a');
  a.href=link;a.target='_blank';a.rel='noopener';
  a.setAttribute('aria-label','WhatsApp us a photo for an instant price');
  a.style.cssText='position:fixed;bottom:20px;right:20px;z-index:99999;display:flex;align-items:center;gap:10px;background:#25D366;color:#fff;font:600 15px/1 system-ui,sans-serif;padding:14px 20px 14px 16px;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.25);text-decoration:none';
  a.innerHTML='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg><span>Photo = instant price</span>';
  document.body.appendChild(a);
})();`);
});

// ---------------------------------------------------------------
// 4) Channels kit: your wa.me link, QR code, and widget snippet
// ---------------------------------------------------------------
app.get("/channels", async (_req, res) => {
  const link = waLink("Hi, I'd like a price — I can send a photo of the problem.");
  const qr = await QRCode.toDataURL(link, { width: 280, margin: 1 });
  const appUrl = PUBLIC_URL || "https://YOUR-APP-URL";
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${BUSINESS_NAME} — Channel kit</title>
  <style>body{font-family:system-ui,sans-serif;background:#0F1B2D;color:#eee;padding:24px;max-width:760px;margin:0 auto}
  h1{font-size:22px}.tag{color:#FFB400;font-weight:700;letter-spacing:.1em;font-size:11px}
  .card{background:#16253C;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:20px;margin:16px 0}
  code,pre{background:#0F1B2D;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:10px;display:block;font-size:12px;overflow-x:auto;color:#FFB400}
  a{color:#FFB400}img{border-radius:12px;background:#fff;padding:8px}</style></head><body>
  <p class="tag">SNAPQUOTE · CHANNEL KIT</p><h1>Get every enquiry into WhatsApp photo triage</h1>
  <div class="card"><h3>1. Your WhatsApp link (Google Business Profile, Facebook, email signature)</h3>
  <code>${link}</code></div>
  <div class="card"><h3>2. Website widget — paste before &lt;/body&gt; on any site</h3>
  <pre>&lt;script src="${appUrl}/widget.js" async&gt;&lt;/script&gt;</pre></div>
  <div class="card"><h3>3. QR code — van, business cards, quote paperwork</h3>
  <img src="${qr}" alt="WhatsApp QR code" width="280" height="280"><p>Right-click / long-press to save.</p></div>
  <div class="card"><h3>4. Missed calls</h3><p>Already wired: unanswered calls get a text pushing them to the same WhatsApp number.</p></div>
  </body></html>`);
});

// ---------------------------------------------------------------
// 5) Lead board + health
// ---------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/", (_req, res) => {
  const leads = allLeads();
  const rows = leads
    .map(
      (l) => `<tr>
        <td>${l.updatedAt ? new Date(l.updatedAt).toLocaleString("en-GB", { timeZone: "Europe/London" }) : ""}</td>
        <td>${l.number}</td>
        <td>${l.service || ""}</td>
        <td>${l.symptom_or_spec || ""}</td>
        <td>${l.location || ""}</td>
        <td>${l.urgency || ""}</td>
        <td>${l.band_low && l.band_high ? `£${l.band_low}–£${l.band_high}` : ""}</td>
        <td>${l.slot || ""}</td>
        <td><strong>${(l.status || "").toUpperCase()}</strong></td>
      </tr>`
    )
    .join("");
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${BUSINESS_NAME} — Lead board</title>
  <style>body{font-family:system-ui,sans-serif;background:#0F1B2D;color:#eee;padding:24px}
  h1{font-size:20px}.tag{color:#FFB400;font-weight:700;letter-spacing:.1em;font-size:11px}
  a{color:#FFB400}
  table{width:100%;border-collapse:collapse;background:#fff;color:#111;border-radius:8px;overflow:hidden;margin-top:16px;font-size:13px}
  th,td{padding:9px 10px;text-align:left;border-bottom:1px solid #eee}th{background:#FFB400;color:#0F1B2D;font-size:11px;letter-spacing:.05em;text-transform:uppercase}
  tr:hover{background:#faf7ef}</style></head><body>
  <p class="tag">SNAPQUOTE · LIVE</p><h1>${BUSINESS_NAME} — leads & triage</h1>
  <p><a href="/channels">→ Channel kit (WhatsApp link, website widget, QR code)</a></p>
  <table><tr><th>Updated</th><th>Number</th><th>Service</th><th>Detail</th><th>Location</th><th>Urgency</th><th>Band</th><th>Slot</th><th>Status</th></tr>
  ${rows || `<tr><td colspan="9">No leads yet — message your WhatsApp number or divert a call to test.</td></tr>`}
  </table></body></html>`);
});

app.listen(PORT, () => {
  console.log(`${BUSINESS_NAME} SnapQuote server running on port ${PORT}`);
  const missing = ["ANTHROPIC_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VOICE_NUMBER"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) console.warn("⚠️ Missing env vars:", missing.join(", "));
});
