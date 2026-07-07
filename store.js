// store.js — conversation + lead storage.
// In-memory with best-effort JSON file persistence so a restart doesn't lose leads.
import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const FILE = path.join(DATA_DIR, "conversations.json");

let conversations = {}; // keyed by customer number (E.164, no channel prefix)

function load() {
  try {
    if (fs.existsSync(FILE)) {
      conversations = JSON.parse(fs.readFileSync(FILE, "utf8"));
      console.log(`Loaded ${Object.keys(conversations).length} conversation(s) from disk`);
    }
  } catch (err) {
    console.error("Could not load conversations file:", err.message);
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(conversations, null, 2));
  } catch (err) {
    console.error("Could not persist conversations:", err.message);
  }
}

load();

const FRESH = () => ({
  history: [], // Claude-format turns
  lead: {},
  channel: null, // 'whatsapp' | 'sms'
  notifiedStatus: null, // last lead status we alerted the owner about
  createdAt: new Date().toISOString(),
  updatedAt: null,
});

export function getConversation(number) {
  if (!conversations[number]) conversations[number] = FRESH();
  return conversations[number];
}

export function updateConversation(number, patch) {
  const convo = getConversation(number);
  Object.assign(convo, patch, { updatedAt: new Date().toISOString() });
  save();
  return convo;
}

export function resetConversation(number) {
  conversations[number] = FRESH();
  save();
}

export function allLeads() {
  return Object.entries(conversations)
    .map(([number, c]) => ({ number, ...c.lead, channel: c.channel, updatedAt: c.updatedAt }))
    .filter((l) => l.status)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

// A conversation older than 6h is treated as finished; a new inbound message starts fresh
// (so a customer texting again next month isn't dropped mid-way into an old thread).
export function maybeExpire(number) {
  const c = conversations[number];
  if (!c || !c.updatedAt) return;
  const ageHours = (Date.now() - new Date(c.updatedAt).getTime()) / 36e5;
  const finished = c.lead?.status === "booked" || c.lead?.status === "not_serviceable";
  if (ageHours > 6 && finished) resetConversation(number);
}
