// STEP 3 ONLY: written for the step 3 pot (13070), which had a hand-typed `resolve`. The step 4 pot (13076) removed it;
// results now come only from the results agent. Use scripts/e2e4.mjs, scripts/watch4.mjs and scripts/shots4.mjs instead.
// Operator commands (testnet). Key from env CCD_SPONSOR_PRIVATE_KEY.
//   node scripts/admin.mjs create "<title>" "<opt1|opt2|opt3>" <price_eur> <hours_open>
//   node scripts/admin.mjs resolve <event_id> <winning_index>
//   node scripts/admin.mjs cancel <event_id>
//   node scripts/admin.mjs allow <account> [hours]     (normally done by the verifier after a valid proof)
//   node scripts/admin.mjs show <event_id>
import { OPERATOR, OPERATOR_KEY_ENV, explorerTx } from "../lib/config.mjs";
import { update, view, signerFromHex } from "../lib/chain.mjs";
import { markAllowed } from "../lib/verify.mjs";
const op = signerFromHex(process.env[OPERATOR_KEY_ENV] || "");
const [cmd, a, b, c, d] = process.argv.slice(2);
const out = (r) => console.log(JSON.stringify({ outcome: r.outcome, link: r.tx ? explorerTx(r.tx) : undefined, reject: r.reject_reason?.decoded ?? r.reject_reason ?? undefined, ...(r.extra || {}) }));
if (cmd === "create") {
  const id = Number((await view("pot", "viewConfig")).next_event);
  const r = await update(op, OPERATOR, "pot", "createEvent", { title: a, outcomes: b.split("|"), card_price: Math.round(Number(c) * 1e6), closes_at: new Date(Date.now() + Number(d || 24) * 3600_000).toISOString() });
  out({ ...r, extra: { event_id: id } });
} else if (cmd === "resolve") out(await update(op, OPERATOR, "pot", "resolve", { event_id: Number(a), winning_outcome: Number(b) }));
else if (cmd === "cancel") out(await update(op, OPERATOR, "pot", "cancel", Number(a)));
else if (cmd === "allow") out(await markAllowed(op, a, Number(b || 24)));
else if (cmd === "show") console.log(JSON.stringify(await view("pot", "viewEvent", Number(a))));
else { console.error("usage: create|resolve|cancel|allow|show"); process.exit(2); }
process.exit(0);
