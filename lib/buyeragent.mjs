// Amy's buyer agent (CIS-8004 agent #1295 on testnet, owned by Amy's verified account, wallet = Amy's 2nd account).
// It reads the same public data as the feed, picks outcomes with a stated reason, checks the pot (canBuy) and buys with
// its OWN wallet (operator-sponsored, so it needs no CCD). The pot credits the cards to Amy and enforces Amy's daily cap
// and self-exclusion on chain. Over the cap it asks Amy; only Amy's own signed approveExtra lets the buy through.
import { randomUUID } from "node:crypto";
import { dryRun, view, tokenBalance, sponsoredCall, buyTransferJSON, signerFromHex } from "./chain.mjs";
import { explorerTx, eur } from "./config.mjs";
import { ledger, saveLedger, agentLog, recordTx } from "./ledger.mjs";
import { HIDDEN_PREFIXES } from "./feeds.mjs";

const get = async (u) => (await fetch(u, { signal: AbortSignal.timeout(15000) })).json();

/** Pick an outcome for one event and say why. Returns { outcome, reason } or null to skip. */
export async function pick(meta) {
  const [src, a, b, kind, x, y] = meta.source_ref.split(":");
  if (src === "coinbase") {
    const candles = await get(`https://api.exchange.coinbase.com/products/${a}/candles?granularity=60`);
    const now = Number(candles[0][4]), ago = Number(candles[Math.min(15, candles.length - 1)][4]);
    const drift = now - ago; const proj = now + drift * 0.5;
    if (kind === "line") return { outcome: proj > Number(x) ? 0 : 1, reason: `${a} is ${now.toFixed(2)} now, ${drift >= 0 ? "up" : "down"} ${Math.abs(drift).toFixed(2)} in 15 min; projected ${proj.toFixed(2)} vs line ${x}` };
    return { outcome: proj < Number(x) ? 0 : proj > Number(y) ? 2 : 1, reason: `${a} projected ${proj.toFixed(2)} (now ${now.toFixed(2)}), band ${x} to ${y}` };
  }
  if (src === "openmeteo") {
    const c = { london: [51.5072, -0.1276], lagos: [6.5244, 3.3792], newyork: [40.7128, -74.006], tokyo: [35.6762, 139.6503] }[a];
    const j = await get(`https://api.open-meteo.com/v1/forecast?latitude=${c[0]}&longitude=${c[1]}&hourly=temperature_2m,precipitation&timezone=GMT&forecast_days=2`);
    const i = j.hourly.time.indexOf(new Date(Number(b) * 1000).toISOString().slice(0, 13) + ":00");
    if (i < 0) return null;
    if (kind === "rain") { const mm = j.hourly.precipitation[i]; return { outcome: mm >= 0.1 ? 0 : 1, reason: `latest Open-Meteo forecast for that hour: ${mm} mm` }; }
    const t = j.hourly.temperature_2m[i]; return { outcome: t < Number(x) ? 0 : t > Number(y) ? 2 : 1, reason: `latest Open-Meteo forecast for that hour: ${t}°C` };
  }
  if (src === "espn") return { outcome: 0, reason: `${meta.meta?.home?.name || "home side"} at home (home advantage; the agent never reads bookmaker odds)` };
  return null;
}

const poss = (n) => (n === "you" ? "your" : `${n}'s`);
export const approvals = () => (ledger().approvals ||= []);

/**
 * One agent run. prefs: { categories: [...], cards: n }. people: { owner, agentWallet, agentKeyHex }. op: sponsor signer.
 * Returns a list of actions (bought, refused, needs_approval) with explorer links.
 */
export async function runBuyerAgent(op, { owner, ownerName = "Amy", agentWallet, agentKeyHex, agentId }, prefs = { categories: ["crypto", "weather", "football"], cards: 3 }) {
  const agentSigner = signerFromHex(agentKeyHex);
  const l = ledger(); const actions = [];
  const mine = new Set(l.cards.filter((c) => c.account === owner).map((c) => c.event_id));
  const open = Object.values(l.events).filter((e) => !HIDDEN_PREFIXES.some((h) => e.source_ref.startsWith(h)) && Date.parse(e.closes_at) > Date.now() + 2 * 60_000 && prefs.categories.includes(e.category) && !mine.has(e.id))
    .sort((p, q) => Date.parse(p.closes_at) - Date.parse(q.closes_at));
  const chosen = []; const seenCat = new Set();
  for (const e of open) { if (chosen.length >= prefs.cards) break; if (seenCat.has(e.category) && open.some((o) => !seenCat.has(o.category) && prefs.categories.includes(o.category) && !chosen.includes(o))) continue; chosen.push(e); seenCat.add(e.category); }
  agentLog("buyer", `Run for ${ownerName}: looking at ${open.length} open events in ${prefs.categories.join(", ")}; picked ${chosen.length}.`, { agent_id: agentId, owner });
  for (const e of chosen) {
    let p; try { p = await pick(e); } catch (err) { p = null; }
    if (!p) continue;
    actions.push(await agentBuyOne(op, agentSigner, { owner, ownerName, agentWallet, agentId }, e, p.outcome, 1, p.reason));
  }
  return actions;
}

export async function agentBuyOne(op, agentSigner, { owner, ownerName = "Amy", agentWallet, agentId }, e, outcome, count, reason) {
  const label = `#${e.id} ${e.title} -> "${e.outcomes[outcome]}"`;
  const pre = await dryRun("pot", agentWallet, "canBuy", { account: agentWallet, event_id: e.id, outcome, count });
  if (!pre.ok) {
    if (pre.error === "OverDailyCap") {
      const pl = await view("pot", "viewPlayer", owner);
      const need = BigInt(e.card_price ?? 2_000_000) * BigInt(count);
      const ap = { id: randomUUID().slice(0, 8), event_id: e.id, outcome, count, amount: need.toString(), reason, asked_at: new Date().toISOString(), status: "waiting", owner };
      approvals().push(ap); saveLedger();
      agentLog("buyer", `Over ${poss(ownerName)} daily cap (€${eur(pl.daily_cap)}; €${eur(pl.left_today)} left): ${label} needs €${eur(need)}. Asking ${ownerName} for approval; the pot will refuse until the owner signs.`,
        { event_id: e.id, refused_with: "OverDailyCap", approval_id: ap.id, owner });
      return { action: "needs_approval", event_id: e.id, outcome, approval_id: ap.id, refused_with: "OverDailyCap" };
    }
    agentLog("buyer", `The pot refused ${label}: ${pre.error}. Nothing paid.`, { event_id: e.id, refused_with: pre.error, owner });
    return { action: "refused", event_id: e.id, refused_with: pre.error };
  }
  const bal = await tokenBalance(agentWallet);
  if (bal < BigInt(pre.value)) { agentLog("buyer", `Agent wallet has €${eur(bal)}, needs €${eur(pre.value)}. Ask ${ownerName} to top it up.`, { owner }); return { action: "no_funds" }; }
  const s = await sponsoredCall(op, agentSigner, agentWallet, "token", "transfer", buyTransferJSON(agentWallet, e.id, outcome, count, BigInt(pre.value)));
  if (s.outcome !== "success") { agentLog("buyer", `Buy rejected on chain: ${label} (${s.reject_reason?.decoded})`, { tx: s.tx, link: explorerTx(s.tx), owner }); return { action: "rejected", tx: s.tx }; }
  await recordTx(s.tx, s.summary, { via: "buyer-agent" });
  agentLog("buyer", `Bought ${count} card for ${ownerName}: ${label} for €${eur(pre.value)}. Why: ${reason}. Network fee paid by EventScope.`, { event_id: e.id, tx: s.tx, link: explorerTx(s.tx), agent_id: agentId, owner });
  return { action: "bought", event_id: e.id, outcome, tx: s.tx, link: explorerTx(s.tx), paid_eur: eur(pre.value), reason };
}
