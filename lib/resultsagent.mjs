// Results agent (CIS-8004 agent registered by the EventScope operator; the pot checks the registry on chain at every post):
// reads each closed event's official source, posts the outcome + SHA-256 of the exact response bytes, waits out the
// dispute window, finalizes and pushes prizes to holders. The response bytes are kept so anyone can re-hash them.
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { resultFor } from "./feeds.mjs";
import { mirror } from "./store.mjs";
import { update, view } from "./chain.mjs";
import { OPERATOR, ROOT, explorerTx, eur } from "./config.mjs";
import { ledger, saveLedger, agentLog, recordTx, holdersOf } from "./ledger.mjs";

const EVID = path.join(ROOT, ".run", "evidence");

export async function runResults(op, { only = null } = {}) {
  const l = ledger(); const cfg = await view("pot", "viewConfig"); const windowMs = Number(cfg.dispute_window_ms);
  const done = [];
  for (const meta of Object.values(l.events)) {
    if (only && !only.includes(meta.id)) continue;
    if (Date.parse(meta.closes_at) > Date.now()) continue;
    let ev; try { ev = await view("pot", "viewEvent", meta.id); } catch { continue; }
    const open = "Open" in ev.status;
    const prop = ev.proposal?.Some?.[0] ?? null;
    if (open && !prop) {
      if (meta.void_checked_at && Date.now() - Date.parse(meta.void_checked_at) < 60_000) continue;
      let r; try { r = await resultFor(meta); } catch (e) { meta.last_note = String(e.message || e); continue; }
      meta.void_checked_at = new Date().toISOString(); meta.last_note = r.note || null;
      if (r.void) {
        const c = await update(op, OPERATOR, "pot", "cancel", meta.id);
        await recordTx(c.tx, c.summary); agentLog("results", `#${meta.id} ${meta.title}: ${r.note}. Event cancelled, everyone refunded.`, { event_id: meta.id, tx: c.tx, link: explorerTx(c.tx) });
        continue;
      }
      if (!r.final) continue;
      const sha = createHash("sha256").update(r.bytes).digest("hex");
      mkdirSync(EVID, { recursive: true });
      writeFileSync(path.join(EVID, `${sha}.json`), r.bytes); mirror(`evidence/${sha}.json`, 0);
      const p = await update(op, OPERATOR, "pot", "proposeResult", { event_id: meta.id, winning_outcome: r.outcome, evidence_hash: [...Buffer.from(sha, "hex")], source_url: r.url.slice(0, 500) });
      if (p.outcome !== "success") { agentLog("results", `#${meta.id} post refused: ${p.reject_reason?.decoded}`, { event_id: meta.id, tx: p.tx }); continue; }
      await recordTx(p.tx, p.summary, { evidence_sha256: sha, source_url: r.url, summary: r.summary });
      meta.result = { outcome: r.outcome, summary: r.summary, evidence_sha256: sha, source_url: r.url, posted_tx: p.tx, posted_at: new Date().toISOString() };
      saveLedger();
      agentLog("results", `#${meta.id} ${meta.title}: "${meta.outcomes[r.outcome]}" (${r.summary}). Posted with evidence hash ${sha.slice(0, 12)}…; dispute window ${Math.round(windowMs / 60000)} min.`,
        { event_id: meta.id, tx: p.tx, link: explorerTx(p.tx), evidence_sha256: sha });
      done.push(meta.id);
      continue;
    }
    if (open && prop) {
      const due = Date.parse(prop.proposed_at) + windowMs;
      if (Date.now() < due + 5000) continue;
      const f = await update(op, OPERATOR, "pot", "finalize", meta.id);
      if (f.outcome !== "success") { agentLog("results", `#${meta.id} finalize refused: ${f.reject_reason?.decoded}`); continue; }
      await recordTx(f.tx, f.summary);
      meta.result = { ...(meta.result || {}), final_tx: f.tx, final_at: new Date().toISOString() }; saveLedger();
      agentLog("results", `#${meta.id} dispute window over, result final: "${meta.outcomes[Number(prop.outcome)]}".`, { event_id: meta.id, tx: f.tx, link: explorerTx(f.tx) });
      ev = await view("pot", "viewEvent", meta.id);
    }
    if (!("Open" in ev.status) && !meta.paid_out_tx) {
      const holders = holdersOf(meta.id);
      if (!holders.length) { meta.paid_out_tx = "none"; saveLedger(); continue; }
      const p = await update(op, OPERATOR, "pot", "payout", { event_id: meta.id, accounts: holders });
      if (p.outcome !== "success") { agentLog("results", `#${meta.id} payout refused: ${p.reject_reason?.decoded}`); continue; }
      await recordTx(p.tx, p.summary);
      const paid = ledger().claims.filter((c) => c.tx === p.tx);
      meta.paid_out_tx = p.tx; saveLedger();
      agentLog("results", `#${meta.id} paid automatically: ${paid.length ? paid.map((c) => `€${eur(c.amount)} to ${c.account.slice(0, 6)}…`).join(", ") : "nobody was owed anything"}.`,
        { event_id: meta.id, tx: p.tx, link: explorerTx(p.tx) });
    }
  }
  return done;
}
