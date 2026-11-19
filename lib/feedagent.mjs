// Feed agent: pulls real upcoming events from the public sources and creates them on chain. No hand-typed events.
import { sportsCandidates, cryptoCandidates, weatherCandidates } from "./feeds.mjs";
import { update, view } from "./chain.mjs";
import { OPERATOR, explorerTx } from "./config.mjs";
import { ledger, saveLedger, agentLog } from "./ledger.mjs";

export const CARD_PRICE = 2_000_000; // EUR 2 per card everywhere

export async function syncFeed(op, { maxNew = 40, kinds = ["crypto", "weather", "sports"] } = {}) {
  const l = ledger();
  const known = new Set(Object.values(l.events).map((e) => e.source_ref));
  const cand = [];
  if (kinds.includes("crypto")) cand.push(...(await cryptoCandidates().catch((e) => (agentLog("feed", `crypto source failed: ${e.message}`), []))));
  if (kinds.includes("weather")) cand.push(...(await weatherCandidates().catch((e) => (agentLog("feed", `weather source failed: ${e.message}`), []))));
  if (kinds.includes("sports")) cand.push(...(await sportsCandidates().catch((e) => (agentLog("feed", `sports source failed: ${e.message}`), []))));
  // one rolling crypto/weather event per coin/city/type at a time is enough
  const live = Object.values(l.events).filter((e) => Date.parse(e.closes_at) > Date.now());
  const busyKey = (c) => c.source_ref.split(":").slice(0, 2).join(":") + ":" + (c.source_ref.split(":")[3] || "");
  const liveKeys = new Set(live.map(busyKey));
  const created = [];
  for (const c of cand) {
    if (created.length >= maxNew) break;
    if (known.has(c.source_ref)) continue;
    if (c.category === "crypto" || c.category === "weather") { if (liveKeys.has(busyKey(c))) continue; liveKeys.add(busyKey(c)); }
    if (Date.parse(c.closes_at) < Date.now() + 3 * 60_000) continue;
    const id = Number((await view("pot", "viewConfig")).next_event);
    const r = await update(op, OPERATOR, "pot", "createEvent", { title: c.title, category: c.category, source_ref: c.source_ref, outcomes: c.outcomes, card_price: CARD_PRICE, closes_at: c.closes_at });
    if (r.outcome !== "success") { agentLog("feed", `create refused: ${c.title} (${r.reject_reason?.decoded})`); continue; }
    // the id the chain assigned is in the EventCreated log; fall back to the pre-read counter
    const ev = await view("pot", "viewEvent", id).catch(() => null);
    const eid = ev && ev.source_ref === c.source_ref ? id : Number((await view("pot", "viewConfig")).next_event) - 1;
    l.events[eid] = { id: eid, ...c, created_tx: r.tx, created_at: new Date().toISOString() };
    saveLedger();
    agentLog("feed", `New event #${eid} (${c.category}): ${c.title}`, { event_id: eid, tx: r.tx, link: explorerTx(r.tx) });
    created.push(eid);
  }
  return created;
}
