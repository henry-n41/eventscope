// Feed agent: pulls real upcoming events from the public sources and creates them on chain. No hand-typed events.
// Curated to keep testnet fees low (about 11 CCD per createEvent):
//   crypto  : 4 fixed daily slots (BTC 09:00 and 21:00, ETH 18:00, SOL 15:00 UTC), band questions
//   weather : London, New York, Tokyo, one temperature question each per day
//   sports  : a handful of upcoming Premier League, LaLiga, Champions League and NBA fixtures (max 6 open, 3 new a day)
// A hard cap of EVENTSCOPE_FEED_DAILY new events per rolling 24 h (default 10) sits on top of all that.
import { sportsCandidates, cryptoDaily, weatherDaily } from "./feeds.mjs";
import { update, view } from "./chain.mjs";
import { OPERATOR, explorerTx } from "./config.mjs";
import { ledger, saveLedger, agentLog } from "./ledger.mjs";

export const CARD_PRICE = 2_000_000; // EUR 2 per card everywhere
export const DAILY_MAX = Number(process.env.EVENTSCOPE_FEED_DAILY || 10);
const SPORT_LEAGUES = ["soccer/eng.1", "soccer/esp.1", "soccer/uefa.champions", "basketball/nba"];
const SPORTS_OPEN_MAX = 6, SPORTS_DAILY_MAX = 3;

export function createdLast24h(prefix = null) {
  const since = Date.now() - 86400_000;
  return Object.values(ledger().events).filter((e) => Date.parse(e.created_at || 0) > since && (!prefix || (e.source_ref || "").startsWith(prefix))).length;
}

export async function syncFeed(op, { kinds = ["crypto", "weather", "sports"], allowSpend = () => true } = {}) {
  const l = ledger();
  const known = new Set(Object.values(l.events).map((e) => e.source_ref));
  const knownSlot = new Set(Object.values(l.events).map((e) => (e.source_ref || "").split(":").slice(0, 3).join(":"))); // source:pair/city:time
  const cand = [];
  if (kinds.includes("crypto")) cand.push(...(await cryptoDaily().catch((e) => (agentLog("feed", `crypto source failed: ${e.message}`), []))));
  if (kinds.includes("weather")) cand.push(...(await weatherDaily().catch((e) => (agentLog("feed", `weather source failed: ${e.message}`), []))));
  if (kinds.includes("sports")) {
    const openSports = Object.values(l.events).filter((e) => e.source_ref?.startsWith("espn:") && Date.parse(e.closes_at) > Date.now()).length;
    let room = Math.min(SPORTS_OPEN_MAX - openSports, SPORTS_DAILY_MAX - createdLast24h("espn:"));
    if (room > 0) {
      const s = (await sportsCandidates({ days: 3, leagues: SPORT_LEAGUES }).catch((e) => (agentLog("feed", `sports source failed: ${e.message}`), [])))
        .filter((c) => !known.has(c.source_ref)).sort((a, b) => Date.parse(a.closes_at) - Date.parse(b.closes_at));
      const seenLeague = new Set(); const pick = [];
      for (const c of s) { if (pick.length >= room) break; if (!seenLeague.has(c.meta.league)) { seenLeague.add(c.meta.league); pick.push(c); } } // variety first
      for (const c of s) { if (pick.length >= room) break; if (!pick.includes(c)) pick.push(c); }
      cand.push(...pick);
    }
  }
  const created = [];
  for (const c of cand) {
    if (createdLast24h() >= DAILY_MAX) break;
    if (!allowSpend()) break;
    if (known.has(c.source_ref) || (!c.source_ref.startsWith("espn:") && knownSlot.has(c.source_ref.split(":").slice(0, 3).join(":")))) continue;
    if (Date.parse(c.closes_at) < Date.now() + 15 * 60_000) continue;
    const id = Number((await view("pot", "viewConfig")).next_event);
    const r = await update(op, OPERATOR, "pot", "createEvent", { title: c.title, category: c.category, source_ref: c.source_ref, outcomes: c.outcomes, card_price: CARD_PRICE, closes_at: c.closes_at });
    if (r.outcome !== "success") { agentLog("feed", `create refused: ${c.title} (${r.reject_reason?.decoded})`); continue; }
    const ev = await view("pot", "viewEvent", id).catch(() => null);
    const eid = ev && ev.source_ref === c.source_ref ? id : Number((await view("pot", "viewConfig")).next_event) - 1;
    l.events[eid] = { id: eid, ...c, created_tx: r.tx, created_at: new Date().toISOString() };
    saveLedger();
    agentLog("feed", `New event #${eid} (${c.category}): ${c.title}`, { event_id: eid, tx: r.tx, link: explorerTx(r.tx) });
    created.push(eid);
  }
  return created;
}
