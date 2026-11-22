// Results agent (CIS-8004 agent registered by the EventScope operator; the pot checks the registry on chain at every post):
// reads each closed event's official source, posts the outcome + SHA-256 of the exact response bytes, waits out the
// dispute window, finalizes and pushes prizes to holders. The response bytes are kept so anyone can re-hash them.
//
// Cost rules (testnet CCD is limited):
//  - only events with cards sold go on chain. A closed event nobody holds is closed in the off-chain index (no
//    transaction; the pot already refuses new cards after closes_at and holds no money for it).
//  - evidence is written only after the post succeeded, once per hash.
//  - a failing event backs off (2, 4, 8 ... min, max 6 h); "not enough funds" pauses the whole agent for 15 min.
import { createHash } from "node:crypto";
import { resultFor } from "./feeds.mjs";
import { writeRaw, hasFile } from "./store.mjs";
import { update, view } from "./chain.mjs";
import { OPERATOR, explorerTx, eur } from "./config.mjs";
import { ledger, saveLedger, agentLog, recordTx, holdersOf } from "./ledger.mjs";

const backoff = new Map(); // event id -> { n, until }
let pausedUntil = 0;
export const resultsState = () => ({ paused_until: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null, backing_off: [...backoff.entries()].filter(([, b]) => b.until > Date.now()).map(([id, b]) => ({ id, tries: b.n, until: new Date(b.until).toISOString(), note: b.note })) });
const isDone = (m) => !!(m.paid_out_tx || m.closed_empty || m.cancelled_tx);
export const doneStatus = (m) => (m.closed_empty ? "closed" : null);

function failed(meta, e) {
  const msg = String(e?.message || e);
  const b = backoff.get(meta.id) || { n: 0 }; b.n++; b.until = Date.now() + Math.min(2 ** b.n * 60_000, 6 * 3600_000); b.note = msg.slice(0, 160);
  backoff.set(meta.id, b); meta.last_note = b.note;
  if (/enough funds|insufficient/i.test(msg)) { pausedUntil = Date.now() + 15 * 60_000; console.error("[results] operator out of funds, pausing 15 min"); return "stop"; }
  return "next";
}

export async function runResults(op, { only = null, allowSpend = () => true } = {}) {
  if (Date.now() < pausedUntil) return [];
  const l = ledger(); const cfg = await view("pot", "viewConfig"); const windowMs = Number(cfg.dispute_window_ms);
  const done = []; let emptied = 0;
  const due = Object.values(l.events).filter((m) => !isDone(m) && Date.parse(m.closes_at) <= Date.now() && (!only || only.includes(m.id)));
  for (const meta of due) {
    const b = backoff.get(meta.id); if (b && b.until > Date.now()) continue;
    let ev; try { ev = await view("pot", "viewEvent", meta.id); } catch { continue; }
    const open = "Open" in ev.status;
    const prop = ev.proposal?.Some?.[0] ?? null;
    const sold = ev.cards_sold.reduce((a, x) => a + Number(x), 0);
    if ("Cancelled" in ev.status) { meta.cancelled_tx = meta.cancelled_tx || "on-chain"; saveLedger(); continue; }
    if (open && !prop && sold === 0) { meta.closed_empty = new Date().toISOString(); emptied++; continue; } // no holders: close off chain, no fee
    if (!allowSpend()) continue;
    try {
      if (open && !prop) {
        if (meta.void_checked_at && Date.now() - Date.parse(meta.void_checked_at) < 5 * 60_000) continue;
        const r = await resultFor(meta);
        meta.void_checked_at = new Date().toISOString(); meta.last_note = r.note || null;
        if (r.void) {
          const c = await update(op, OPERATOR, "pot", "cancel", meta.id);
          if (c.outcome !== "success") throw new Error(`cancel refused: ${c.reject_reason?.decoded}`);
          meta.cancelled_tx = c.tx; await recordTx(c.tx, c.summary);
          agentLog("results", `#${meta.id} ${meta.title}: ${r.note}. Event cancelled, everyone refunded.`, { event_id: meta.id, tx: c.tx, link: explorerTx(c.tx) });
          continue;
        }
        if (!r.final) {
          // safety net: a held event whose source never publishes (postponed game, source gap) is refunded after 18 h
          if (Date.now() > Date.parse(meta.closes_at) + 18 * 3600_000) {
            const c = await update(op, OPERATOR, "pot", "cancel", meta.id);
            if (c.outcome !== "success") throw new Error(`cancel refused: ${c.reject_reason?.decoded}`);
            meta.cancelled_tx = c.tx; await recordTx(c.tx, c.summary);
            agentLog("results", `#${meta.id} ${meta.title}: no official result 18 h after closing (${r.note || "source silent"}). Event cancelled, everyone refunded.`, { event_id: meta.id, tx: c.tx, link: explorerTx(c.tx) });
          }
          saveLedger(); continue;
        }
        const sha = createHash("sha256").update(r.bytes).digest("hex");
        const p = await update(op, OPERATOR, "pot", "proposeResult", { event_id: meta.id, winning_outcome: r.outcome, evidence_hash: [...Buffer.from(sha, "hex")], source_url: r.url.slice(0, 500) });
        if (p.outcome !== "success") throw new Error(`post refused: ${p.reject_reason?.decoded}`);
        if (!hasFile(`evidence/${sha}.json`)) writeRaw(`evidence/${sha}.json`, r.bytes); // only after the post succeeded
        await recordTx(p.tx, p.summary, { evidence_sha256: sha, source_url: r.url, summary: r.summary });
        meta.result = { outcome: r.outcome, summary: r.summary, evidence_sha256: sha, source_url: r.url, posted_tx: p.tx, posted_at: new Date().toISOString() };
        saveLedger(); backoff.delete(meta.id);
        agentLog("results", `#${meta.id} ${meta.title}: "${meta.outcomes[r.outcome]}" (${r.summary}). Posted with evidence hash ${sha.slice(0, 12)}…; dispute window ${Math.round(windowMs / 60000)} min.`,
          { event_id: meta.id, tx: p.tx, link: explorerTx(p.tx), evidence_sha256: sha });
        done.push(meta.id);
        continue;
      }
      if (open && prop) {
        if (Date.now() < Date.parse(prop.proposed_at) + windowMs + 5000) continue;
        const f = await update(op, OPERATOR, "pot", "finalize", meta.id);
        if (f.outcome !== "success") throw new Error(`finalize refused: ${f.reject_reason?.decoded}`);
        await recordTx(f.tx, f.summary);
        meta.result = { ...(meta.result || {}), final_tx: f.tx, final_at: new Date().toISOString() }; saveLedger();
        agentLog("results", `#${meta.id} dispute window over, result final: "${meta.outcomes[Number(prop.outcome)]}".`, { event_id: meta.id, tx: f.tx, link: explorerTx(f.tx) });
        ev = await view("pot", "viewEvent", meta.id);
      }
      if (!("Open" in ev.status) && !meta.paid_out_tx) {
        const holders = holdersOf(meta.id);
        if (!holders.length) { meta.paid_out_tx = "none"; saveLedger(); continue; }
        const p = await update(op, OPERATOR, "pot", "payout", { event_id: meta.id, accounts: holders });
        if (p.outcome !== "success") throw new Error(`payout refused: ${p.reject_reason?.decoded}`);
        await recordTx(p.tx, p.summary);
        const paid = ledger().claims.filter((c) => c.tx === p.tx);
        meta.paid_out_tx = p.tx; saveLedger(); backoff.delete(meta.id);
        agentLog("results", `#${meta.id} paid automatically: ${paid.length ? paid.map((c) => `€${eur(c.amount)} to ${c.account.slice(0, 6)}…`).join(", ") : "nobody was owed anything"}.`,
          { event_id: meta.id, tx: p.tx, link: explorerTx(p.tx) });
      }
    } catch (e) { if (failed(meta, e) === "stop") break; }
  }
  if (emptied) { saveLedger(); agentLog("results", `${emptied} closed event${emptied > 1 ? "s" : ""} had no cards sold: closed without a transaction (nothing to pay).`); }
  return done;
}
