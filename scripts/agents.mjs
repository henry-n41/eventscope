// Register EventScope's agents in Concordium's Agent Registry (CIS-8004, testnet 12802,0) and wire them into the pot.
//   node scripts/agents.mjs     (idempotent: skips what .run/agents.json already has)
// 1. Amy's buyer agent: NFT owned by Amy's verified account; agent wallet = Amy's 2nd account (same identity, own key).
//    Amy then calls the pot's linkAgent herself; the pot reads the registry on chain.
// 2. Results agent: owned by the EventScope operator account; the pot's setResolver reads the registry on chain.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { OPERATOR, OPERATOR_KEY_ENV, ROOT, explorerTx, jsonSafe, deployment, DEPLOYMENT } from "../lib/config.mjs";
import { update, signerFromHex, view } from "../lib/chain.mjs";
import { registerAgent, checkBadge } from "../lib/registry.mjs";
import { ensureAccount, load, keyHex } from "../lib/testusers.mjs";
import { AccountAddress, AccountTransactionType, CcdAmount } from "@concordium/web-sdk";
import { send } from "../lib/chain.mjs";

const opKey = process.env[OPERATOR_KEY_ENV]; if (!/^[0-9a-f]{64}$/i.test(opKey || "")) { console.error(`${OPERATOR_KEY_ENV} missing`); process.exit(1); }
const op = signerFromHex(opKey);
const FILE = path.join(ROOT, ".run", "agents.json");
const state = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
const save = () => writeFileSync(FILE, JSON.stringify(jsonSafe(state), null, 1));

const amy = load("amy");
const amyAcct = await ensureAccount("amy");
const agentAcct = await ensureAccount("amy", 1, "agent");
console.log("amy", amyAcct.address, "agent wallet", agentAcct.address, explorerTx(agentAcct.tx));
// the agent wallet needs a little CCD to exist comfortably (its buys are sponsored by the operator anyway)
for (const [a, min] of [[amyAcct.address, 300_000_000n]]) {
  const i = await (await import("../lib/chain.mjs")).grpc().getAccountInfo(AccountAddress.fromBase58(a));
  if (i.accountAmount.microCcdAmount < min) { const t = await send(op, OPERATOR, AccountTransactionType.Transfer, { amount: CcdAmount.fromMicroCcd(min), toAddress: AccountAddress.fromBase58(a) }); console.log("funded", a, t.outcome, explorerTx(t.tx)); }
}
const { accountAmount } = await (await import("../lib/chain.mjs")).grpc().getAccountInfo(AccountAddress.fromBase58(agentAcct.address));
if (accountAmount.microCcdAmount < 5_000_000n) {
  const t = await send(op, OPERATOR, AccountTransactionType.Transfer, { amount: CcdAmount.fromMicroCcd(10_000_000n), toAddress: AccountAddress.fromBase58(agentAcct.address) });
  console.log("funded agent wallet", t.outcome, explorerTx(t.tx));
}

const buyerCard = {
  name: "Amy's EventScope Buyer Agent",
  description: "Picks and buys EventScope prize cards for Amy inside the daily cap Amy set on chain. It cannot raise the cap, approve extra spending or lift Amy's self-exclusion; the EventScope pot enforces all three. Testnet demo.",
  url: "https://eventscope-demo.example/agents/buyer",
  version: "1.0.0",
  role: "buyer",
  provider: { organization: "EventScope (testnet demo)" },
  capabilities: { streaming: false, extensions: [] },
  skills: [{ id: "buy-cards", name: "Buy event cards", description: "Chooses outcomes from Amy's preferences and buys cards with EUR-demo through the EventScope pot (CIS-2 transfer)." }],
  defaultInputModes: ["text"], defaultOutputModes: ["text"],
};
const resultsCard = {
  name: "EventScope Results Agent",
  description: "Reads each event's official public source (ESPN scoreboards, Coinbase Exchange candles, Open-Meteo), posts the result to the EventScope pot with the SHA-256 of the source response, waits out the dispute window, finalizes and pays winners. Owned by the EventScope operator account. Testnet demo.",
  url: "https://eventscope-demo.example/agents/results",
  version: "1.0.0",
  role: "results",
  provider: { organization: "EventScope (testnet demo)" },
  capabilities: { streaming: false, extensions: [] },
  skills: [{ id: "post-results", name: "Post results with evidence", description: "proposeResult(event, outcome, sha256(source), source_url) then finalize and payout." }],
  defaultInputModes: ["text"], defaultOutputModes: ["text"],
};

if (!state.buyer) {
  state.buyer = await registerAgent({ ownerKeyHex: keyHex(amy, 0), owner: amyAcct.address, card: buyerCard, wallet: { address: agentAcct.address, keyHex: keyHex(amy, 1) },
    ...(process.env.BUYER_TOKEN_ID ? { tokenId: process.env.BUYER_TOKEN_ID, registerTx: process.env.BUYER_REGISTER_TX } : {}) });
  save(); console.log("buyer agent", state.buyer.token_id, state.buyer.register_tx);
}
if (!state.results) {
  state.results = await registerAgent({ ownerKeyHex: opKey, owner: OPERATOR, card: resultsCard, wallet: null });
  save(); console.log("results agent", state.results.token_id, state.results.register_tx);
}
const pot = deployment().pot.index;
state.pots ||= {};
state.pots[pot] ||= {};
const P = state.pots[pot];
if (!P.link_tx) {
  const r = await update(signerFromHex(keyHex(amy, 0)), amyAcct.address, "pot", "linkAgent", Number(state.buyer.token_id));
  if (r.outcome !== "success") throw new Error("linkAgent: " + JSON.stringify(r.reject_reason));
  P.link_tx = r.tx; save(); console.log("linkAgent", explorerTx(r.tx));
}
if (!P.resolver_tx) {
  const r = await update(op, OPERATOR, "pot", "setResolver", { account: OPERATOR, agent_id: { Some: [Number(state.results.token_id)] } });
  if (r.outcome !== "success") throw new Error("setResolver: " + JSON.stringify(r.reject_reason));
  P.resolver_tx = r.tx; save(); console.log("setResolver", explorerTx(r.tx));
}
state.badge_checks = { buyer: await checkBadge(state.buyer.token_id), results: await checkBadge(state.results.token_id) };
save();
const d = deployment(); d.agents = { buyer: { token_id: state.buyer.token_id, owner: state.buyer.owner, wallet: state.buyer.agent_wallet }, results: { token_id: state.results.token_id, owner: OPERATOR } };
writeFileSync(DEPLOYMENT, JSON.stringify(d, null, 1));
console.log(JSON.stringify({ link: await view("pot", "viewAgent", agentAcct.address), resolver: await view("pot", "viewResolver", OPERATOR), badge: state.badge_checks }, null, 1));
process.exit(0);
