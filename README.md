# SnapQuote — Omnichannel AI Receptionist + WhatsApp Photo Triage
### Built for JD Leak Detection (leak detection & new water supply)

Every enquiry channel funnels into ONE WhatsApp number, where the AI:
reads photos of the problem, asks 2-3 smart questions, gives a provisional
price band from YOUR rate card, books a provisional visit, and pushes the
job (with the photo attached) to your personal WhatsApp.

**The funnel — every door leads to the same brain:**

| Channel | How it gets to WhatsApp |
|---|---|
| 📞 Missed call | Caller hears "send us a photo for an instant price", gets a text with your WhatsApp link |
| 🌐 Website | Floating "Photo = instant price" widget (one line of code, works on any site) |
| 🔎 Google Business Profile / Facebook | Your wa.me link in the profile |
| 🚐 Van / business cards / quotes | QR code (auto-generated for you) |
| 💬 WhatsApp direct | Straight in |

Open **`/channels`** on your deployed app for your complete kit: wa.me link,
website widget snippet, and printable QR code.

---

## Setup — same as before, one evening

### First, pick your call mode (30 seconds of thought)

**Front Door mode — recommended if your mobile is also your personal phone
(most SME traders).** The Twilio number becomes your PUBLIC business number
(Google, website, van). Calls to it ring your mobile showing the business
number as caller ID — save it as a contact called "BUSINESS CALL" so you know
to answer professionally. Don't answer within ~18 seconds and the AI takes
over. Your personal number is never touched and no divert codes are needed.
- Set the Twilio Voice webhook to: `/voice/inbound`
- Add variables: `FORWARD_TO_NUMBER` (your mobile), `FORWARD_CALLER_ID=business`, `RING_SECONDS=18`
- Skip the divert-codes step entirely.
- Transition tip: old customers still have your personal number — that's fine,
  those calls behave as normal. Update Google/website/van to the new number
  and new enquiries flow through the system from day one.

**Divert mode — for business-only phones.** Keep advertising your existing
mobile; set the `**61*`/`**67*`/`**62*` divert codes so unanswered calls
forward to the Twilio number. Voice webhook: `/voice/missed-call`. Note:
ALL unanswered calls get the treatment, including personal ones.


Follow Steps 1-6 in the original guide (Anthropic + Twilio + Railway accounts,
buy a UK number, deploy, point the two webhooks, set your phone divert).
Everything is identical, plus:

- Add the new variables from `.env.example`: **`RATE_CARD`** (your prices in
  plain English — the AI prices only from this) and **`PUBLIC_URL`** (your
  Railway URL, used to generate the widget snippet).

### Photo triage needs WhatsApp — do Step 7 in week one

Inbound photos only work over WhatsApp (UK SMS can't receive photos), so the
WhatsApp sender upgrade is now the priority, not an optional extra:

1. **Test today with the sandbox:** Twilio Console → Messaging → *Try it out →
   WhatsApp sandbox*. Join from your phone, set the sandbox inbound webhook to
   `https://YOUR-URL/whatsapp/inbound`, then send it a photo of a pipe. Watch
   the triage happen and the lead hit your WhatsApp.
2. **Production (1-5 days):** Messaging → *Senders → WhatsApp senders → Create
   new sender* with your Twilio number; complete Meta business verification for
   JD Leak Detection. Set its inbound webhook to the same `/whatsapp/inbound`.
3. Create the missed-call **template** in the Content Template Builder:
   > "Sorry we missed your call — JD Leak Detection here. Send us a photo of
   > the problem and we'll give you a price band straight away."
   Copy its Content SID (HX...) into `MISSED_CALL_TEMPLATE_SID` and set
   `TWILIO_WHATSAPP_FROM` to `whatsapp:+44YOURNUMBER`.

Until production approval: missed callers get an **SMS** with your WhatsApp
link — so photo triage works for real customers from day one via the link.

### Put the funnel everywhere (30 min)

- **Website:** paste `<script src="https://YOUR-URL/widget.js" async></script>`
  before `</body>` — a WhatsApp button appears bottom-right on every page.
- **Google Business Profile:** add your wa.me link (from `/channels`) as the
  website/appointment link and in your business description.
- **Van & cards:** print the QR code from `/channels`.
- **Quotes & invoices:** add the QR — past customers become repeat WhatsApp leads.

---

## What you'll see day-to-day

- 📋 **Triaged lead** on your WhatsApp: service, detail, location, urgency,
  **price band**, insurance flag, safety flags — with the customer's photo attached.
- ✅ **Booked job** with name and provisional slot — you call to confirm.
- 🚨 **Emergencies** flagged instantly.
- **Lead board** at your app URL; **channel kit** at `/channels`.
- Tune behaviour anytime by editing Railway variables (rate card, hours, area) —
  no code changes.

## Troubleshooting

- **Photos not triaging:** the sender must be WhatsApp (sandbox or approved) —
  check the inbound webhook is `/whatsapp/inbound` and Railway logs for
  "media fetch" errors.
- **No text-back on missed calls:** check the Voice webhook ends `/voice/missed-call`.
- **Agent apologises about a hiccup:** usually `ANTHROPIC_API_KEY` wrong or out of credit.
- Set `VALIDATE_TWILIO_SIGNATURES=true` once stable.
