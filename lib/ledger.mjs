// Off-chain index of what the pot did, rebuilt from transaction summaries (the chain stays the source of truth):
// events created by the feed (source and display data), card purchases with serial numbers (for rarity),
// results posted with evidence, claims and payouts. Stored per pot contract in .run/ledger-<pot>.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { AccountAddress, TransactionHash } from "@concordium/web-sdk";
import { ROOT, deployment, jsonSafe } from "./config.mjs";
import { grpc } from "./chain.mjs";

const file = () => path.join(ROOT, ".run", `ledger-${deployment().pot.index}.json`);
let L = null;
export function ledger() {
  if (L && L.pot === deployment().pot.index) return L;
  mkdirSync(path.join(ROOT, ".run"), { recursive: true });
  L = existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : { pot: deployment().pot.index, events: {}, cards: [], claims: [], results: [], txs: {}, agent_log: [] };
  return L;
}
import { mirror } from "./store.mjs";
export const saveLedger = () => { writeFileSync(file(), JSON.stringify(jsonSafe(ledger()), null, 1)); mirror(path.basename(file())); };

const acct = (b) => AccountAddress.fromBuffer(b).address;
/** Decode one EventScope pot log (see `Log` in the contract). */
export function decodeLog(hex) {
  const b = Buffer.from(hex, "hex"); let o = 1;
  const u64 = () => { const v = b.readBigUInt64LE(o); o += 8; return Number(v); };
  const u8 = () => b[o++]; const u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
  const ac = () => { const v = acct(b.subarray(o, o + 32)); o += 32; return v; };
  const optU64 = () => (u8() === 1 ? u64() : null);
  switch (b[0]) {
    case 0: return { type: "EventCreated", event_id: u64() };
    case 2: return { type: "CardsBought", event_id: u64(), account: ac(), outcome: u8(), count: u32(), paid: u64(), serial_from: u64(), agent_id: optU64() };
    case 3: return { type: "Resolved", event_id: u64(), winning_outcome: u8() };
    case 4: return { type: "Cancelled", event_id: u64() };
    case 5: return { type: "Claimed", event_id: u64(), account: ac(), amount: u64() };
    case 6: { const event_id = u64(), winning_outcome = u8(); const evidence_hash = b.subarray(o, o + 32).toString("hex"); o += 32; return { type: "ResultProposed", event_id, winning_outcome, evidence_hash, resolver: ac(), agent_id: u64() }; }
    case 7: return { type: "Disputed", event_id: u64(), by: ac() };
    case 8: return { type: "AgentLinked", owner: ac(), agent_wallet: ac(), agent_id: u64() };
    case 11: return { type: "ExtraApproved", account: ac(), amount: u64(), day: u64() };
    case 12: return { type: "Paused", account: ac() };
    default: return { type: `tag${b[0]}` };
  }
}

/** All pot logs in a finalized transaction summary. */
export function potLogs(summary) {
  const pot = String(deployment().pot.index); const out = [];
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const addr = x.address || x.contractAddress;
    if (addr && String(addr.index) === pot && Array.isArray(x.events)) {
      for (const e of x.events) { const hex = typeof e === "string" ? e : e?.buffer ? Buffer.from(e.buffer).toString("hex") : String(e); try { out.push(decodeLog(hex)); } catch {} }
    }
    for (const v of Object.values(x)) if (v && typeof v === "object") walk(v);
  };
  walk(summary);
  // the same event can appear in nested trace objects once each; de-duplicate by content
  const seen = new Set(); return out.filter((l) => { const k = JSON.stringify(l); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Record a finalized pot-touching transaction once (by hash). Accepts a summary we already have, else fetches it. */
export async function recordTx(hash, summary = null, extra = {}) {
  const l = ledger();
  if (l.txs[hash]) return l.txs[hash];
  if (!summary) {
    const s = await grpc().getBlockItemStatus(TransactionHash.fromHexString(hash));
    if (s.status !== "finalized") return null;
    summary = s.outcome.summary;
  }
  const logs = potLogs(jsonSafe(summary)); const at = new Date().toISOString();
  for (const g of logs) {
    if (g.type === "CardsBought") l.cards.push({ ...g, tx: hash, at, ...extra });
    if (g.type === "Claimed") l.claims.push({ ...g, tx: hash, at, ...extra });
    if (["ResultProposed", "Resolved", "Disputed", "Cancelled"].includes(g.type)) l.results.push({ ...g, tx: hash, at, ...extra });
  }
  l.txs[hash] = { logs: logs.length, at, ...extra };
  saveLedger();
  return l.txs[hash];
}

export function agentLog(agent, text, data = {}) {
  const l = ledger();
  l.agent_log.push({ at: new Date().toISOString(), agent, text, ...data });
  if (l.agent_log.length > 500) l.agent_log.splice(0, l.agent_log.length - 500);
  saveLedger();
  console.log(`[${agent}] ${text}`, data.link || "");
}

/** Rarity by serial number within an outcome (numbered editions): #1 Legendary, #2-3 Epic, #4-10 Rare, then Common. */
export function rarity(serial) { return serial === 1 ? "legendary" : serial <= 3 ? "epic" : serial <= 10 ? "rare" : "common"; }

/** A person's cards, one entry per physical card, with serial numbers. */
export function cardsOf(account) {
  const out = [];
  for (const c of ledger().cards.filter((x) => x.account === account)) {
    for (let k = 1; k <= c.count; k++) { const serial = c.serial_from + k; out.push({ event_id: c.event_id, outcome: c.outcome, serial, rarity: rarity(serial), tx: c.tx, agent_id: c.agent_id, at: c.at }); }
  }
  return out;
}
export const holdersOf = (eventId) => [...new Set(ledger().cards.filter((c) => c.event_id === Number(eventId)).map((c) => c.account))];
