// STEP 3 ONLY: written for the step 3 pot (13070), which had a hand-typed `resolve`. The step 4 pot (13076) removed it;
// results now come only from the results agent. Use scripts/e2e4.mjs, scripts/watch4.mjs and scripts/shots4.mjs instead.
// End-to-end on testnet with the EUR-demo CIS-2 token: verify Amy and Cal (ZK account proofs), mark them allowed and grant
// play money, they buy cards with sponsored token transfers (operator pays CCD fees), Ben (UK resident) is refused,
// operator resolves, Amy claims her prize in EUR-demo. Writes .run/e2e-<time>.json.
import { writeFileSync } from "node:fs";
import { OPERATOR, OPERATOR_KEY_ENV, explorerTx, explorerAccount, explorerContract, ccd, eur, deployment } from "../lib/config.mjs";
import { update, dryRun, view, balance, tokenBalance, signerFromHex, buildSponsored, signAndSubmitSponsored, buyTransferJSON, address } from "../lib/chain.mjs";
import { createRequest, checkPresentation, markAllowed, grantPlayMoney } from "../lib/verify.mjs";
import { ensureAccount, load, signer as userSigner, prove } from "../lib/testusers.mjs";

const key = process.env[OPERATOR_KEY_ENV]; if (!/^[0-9a-f]{64}$/i.test(key || "")) { console.error(`${OPERATOR_KEY_ENV} missing`); process.exit(1); }
const op = signerFromHex(key);
const PRICE = 2_000_000n; // 2 EUR-demo per card
const d = deployment();
const log = { started: new Date().toISOString(), token: explorerContract(d.token.index), pot: explorerContract(d.pot.index), steps: [] };
const step = (name, data) => { const s = { name, ...data }; if (s.tx) s.link = explorerTx(s.tx); delete s.summary; log.steps.push(s); console.log(name, JSON.stringify(s)); };
const potTokens = async () => tokenBalance({ index: address("pot").index });

const people = {};
for (const who of ["amy", "ben", "cal"]) people[who] = await ensureAccount(who);
const ccdStart = Object.fromEntries(await Promise.all(Object.entries(people).map(async ([w, a]) => [w, await balance(a.address)])));

// 1. event
const eventId = Number((await view("pot", "viewConfig")).next_event);
const closes = new Date(Date.now() + 2 * 3600_000).toISOString();
const ce = await update(op, OPERATOR, "pot", "createEvent", { title: "Arsenal v Chelsea (demo)", outcomes: ["Arsenal win", "Draw", "Arsenal lose"], card_price: Number(PRICE), closes_at: closes });
step("create_event", { event_id: eventId, price: `${eur(PRICE)} EUR-demo per card`, tx: ce.tx, outcome: ce.outcome });

// 2. verification + play money
async function verify(who) {
  const req = await createRequest(op);
  const reqTx = req.transactionRef.toString();
  let pres;
  try { pres = await prove(who, req); }
  catch (e) { step(`verify_${who}`, { request_link: explorerTx(reqTx), proof: "wallet could not make the proof", error: String(e.message || e), allowed: false }); return false; }
  const chk = await checkPresentation(req, pres);
  if (!chk.ok) { step(`verify_${who}`, { request_link: explorerTx(reqTx), proof: "rejected", error: chk.error }); return false; }
  const m = await markAllowed(op, chk.account);
  step(`verify_${who}`, { request_link: explorerTx(reqTx), proof: "valid", proved_account: chk.account, matches: chk.account === people[who].address, tx: m.tx, outcome: m.outcome, allowed_until: m.until });
  const g = await grantPlayMoney(op, chk.account);
  step(`grant_${who}`, { tx: g.tx, outcome: g.outcome ?? g.skipped, balance: `${eur(g.balance ?? (await tokenBalance(chk.account)))} EUR-demo` });
  return true;
}
await verify("amy"); await verify("cal"); await verify("ben");

// 3. Ben: refused before paying
const benPre = await dryRun("pot", people.ben.address, "canBuy", { account: people.ben.address, event_id: eventId, outcome: 0, count: 1 });
step("ben_precheck", { would_succeed: benPre.ok, refused_with: benPre.error, note: "the page runs this before asking the wallet to sign; the backend also refuses to sponsor him" });
// Give Ben tokens by another route (operator mint) to prove the pot itself refuses him, not just an empty balance.
const benMint = await update(op, OPERATOR, "token", "mint", { to: people.ben.address, amount: "4000000" });
step("ben_gets_4_eur_demo_by_other_route", { tx: benMint.tx, outcome: benMint.outcome });
const benBefore = await tokenBalance(people.ben.address), potBefore = await potTokens();
const benTx = await update(userSigner(load("ben")), people.ben.address, "token", "transfer", buyTransferJSON(people.ben.address, eventId, 0, 1, PRICE));
step("ben_sends_buy_himself", { tx: benTx.tx, outcome: benTx.outcome, refused_with: benTx.reject_reason?.decoded, ben_tokens_before: eur(benBefore), ben_tokens_after: eur(await tokenBalance(people.ben.address)),
  pot_unchanged: (await potTokens()) === potBefore, ben_paid_fee_ccd: benTx.fee_ccd });

// 4. Amy and Cal buy with sponsored transactions
async function sponsoredBuy(who, outcome, count) {
  const a = people[who].address;
  const pre = await dryRun("pot", a, "canBuy", { account: a, event_id: eventId, outcome, count });
  if (!pre.ok) { step(`${who}_buy`, { refused_with: pre.error }); return; }
  const sponsored = await buildSponsored(op, a, "token", "transfer", buyTransferJSON(a, eventId, outcome, count, BigInt(pre.value)));
  const r = await signAndSubmitSponsored(sponsored, userSigner(load(who)), "token");
  step(`${who}_buys_${count}_on_${outcome}`, { tx: r.tx, outcome: r.outcome, paid: `${eur(pre.value)} EUR-demo`, fee_ccd: r.fee_ccd, sponsor: r.sponsor, sponsor_fee_ccd: r.sponsor_fee_ccd });
}
await sponsoredBuy("amy", 0, 3);
await sponsoredBuy("cal", 1, 2);
const ev = await view("pot", "viewEvent", eventId);
step("pot", { pot: `${eur(ev.pot)} EUR-demo`, cards_sold: ev.cards_sold, pot_contract_token_balance: eur(await potTokens()) });

// 5. resolve
const rs = await update(op, OPERATOR, "pot", "resolve", { event_id: eventId, winning_outcome: 0 });
step("resolve_arsenal_win", { tx: rs.tx, outcome: rs.outcome });

// 6. Amy claims (sponsored)
const h = await view("pot", "viewHolding", { event_id: eventId, account: people.amy.address });
const amyTokBefore = await tokenBalance(people.amy.address);
const cs = await buildSponsored(op, people.amy.address, "pot", "claim", eventId);
const cl = await signAndSubmitSponsored(cs, userSigner(load("amy")), "pot");
step("amy_claims", { tx: cl.tx, outcome: cl.outcome, claimable: eur(h.claimable), received: eur((await tokenBalance(people.amy.address)) - amyTokBefore), fee_ccd: cl.fee_ccd, sponsor: cl.sponsor, sponsor_fee_ccd: cl.sponsor_fee_ccd });
step("cal_claim_dry_run", { refused_with: (await dryRun("pot", people.cal.address, "claim", eventId)).error });
step("amy_second_claim_dry_run", { refused_with: (await dryRun("pot", people.amy.address, "claim", eventId)).error });
const evEnd = await view("pot", "viewEvent", eventId);
const ccdEnd = Object.fromEntries(await Promise.all(Object.entries(people).map(async ([w, a]) => [w, await balance(a.address)])));
step("final", { status: evEnd.status, paid_out: eur(evEnd.paid_out), pot_contract_token_balance: eur(await potTokens()),
  tokens: { amy: eur(await tokenBalance(people.amy.address)), cal: eur(await tokenBalance(people.cal.address)), ben: eur(await tokenBalance(people.ben.address)) },
  ccd_spent_by_player: Object.fromEntries(Object.keys(people).map((w) => [w, ccd(ccdStart[w] - ccdEnd[w])])) });
log.finished = new Date().toISOString();
const f = `.run/e2e-${Date.now()}.json`; writeFileSync(f, JSON.stringify(log, null, 1)); console.log("saved", f);
process.exit(0);
