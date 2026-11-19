// Chain helpers: gRPC client, signed and sponsored transactions, contract calls and read-only views via the embedded schemas.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { AccountAddress, AccountTransactionType, CcdAmount, ContractAddress, ContractName, EntrypointName, Energy, ReceiveName,
  TransactionExpiry, buildBasicAccountSigner, signTransaction, serializeUpdateContractParameters, deserializeReceiveReturnValue } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { CONTRACTS, SPONSOR, jsonSafe, deployment } from "./config.mjs";

let _client;
export const grpc = () => (_client ||= new ConcordiumGRPCNodeClient("grpc.testnet.concordium.com", 20000, credentials.createSsl(), { timeout: 30000 }));
const _schemas = {};
export const schema = (which) => (_schemas[which] ||= Buffer.from(readFileSync(path.join(CONTRACTS[which].dir, "schema.b64"), "utf8").trim(), "base64"));
export const address = (which) => { const d = deployment(); if (!d?.[which]) throw new Error(`${which} not deployed yet`); return ContractAddress.create(BigInt(d[which].index), 0n); };
export const signerFromHex = (hex) => buildBasicAccountSigner(hex);
const rn = (which, ep) => ReceiveName.fromString(`${CONTRACTS[which].name}.${ep}`);

export function encodeParam(which, entrypoint, json) {
  return serializeUpdateContractParameters(ContractName.fromString(CONTRACTS[which].name), EntrypointName.fromString(entrypoint), json, schema(which));
}

// Error names in declaration order: concordium-std maps variant i to reject code -(i+1).
const POT_ERRORS = ["ParseParams", "NotOperator", "NotVerifier", "OnlyAccounts", "NotVerified", "VerificationExpired", "UnknownEvent", "UnknownOutcome",
  "BadOutcomes", "EventNotOpen", "EventClosed", "WrongAmount", "BadCount", "NotResolved", "NothingToClaim", "AlreadyClaimed", "Overflow", "TransferFailed",
  "WrongToken", "MissingPurchaseData", "OverDailyCap", "SelfExcluded", "RegistryUnavailable", "AgentNotFound", "AgentNotActive", "AgentNotOwnedBySender",
  "AgentHasNoWallet", "AgentWalletMismatch", "NotResolver", "TooEarly", "AlreadyProposed", "NoProposal", "DisputeWindowOver", "DisputeWindowOpen", "NotAHolder", "BadCap"];
const TOKEN_ERRORS = { "-42000001": "InvalidTokenId", "-42000002": "InsufficientFunds", "-42000003": "Unauthorized", "-1": "ParseParams", "-2": "LogFull",
  "-3": "Overflow", "-4": "ReceiverRefused (the prize pot rejected the transfer)", "-5": "NotAdmin" };
export const decodeError = (which, code) => which === "token" ? (TOKEN_ERRORS[String(code)] ?? `code ${code}`) : (POT_ERRORS[-Number(code) - 1] ?? `code ${code}`);

function summarize(th, out, which) {
  const s = out.summary;
  const rejected = s.transactionType === "failed" || !!s.rejectReason;
  const reason = s.rejectReason ? jsonSafe(s.rejectReason) : null;
  if (reason?.rejectReason !== undefined) reason.decoded = decodeError(which, reason.rejectReason);
  return { tx: th.toString(), outcome: rejected ? "rejected" : "success", fee_ccd: Number(s.cost) / 1e6, sponsor: s.sponsor?.sponsor?.address ?? null, sponsor_fee_ccd: s.sponsor ? Number(s.sponsor.cost?.microCcdAmount ?? s.sponsor.cost) / 1e6 : 0, reject_reason: reason, summary: jsonSafe(s) };
}

// One transaction at a time per sender account inside this process, so nonces never collide (feed, results agent, page).
const _locks = new Map();
export function withSender(sender, fn) {
  const prev = _locks.get(sender) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  _locks.set(sender, run.catch(() => {}));
  return run;
}
/** Plain account transaction (sender pays the fee). */
export async function send(signer, sender, type, payload, which = "pot") {
  return withSender(sender, () => sendNow(signer, sender, type, payload, which));
}
async function sendNow(signer, sender, type, payload, which) {
  const client = grpc();
  const from = AccountAddress.fromBase58(sender);
  const { nonce } = await retry(() => client.getNextAccountNonce(from));
  const tx = { header: { sender: from, nonce, expiry: TransactionExpiry.futureMinutes(5) }, payload, type };
  const th = await client.sendAccountTransaction(tx, await signTransaction(tx, signer));
  return summarize(th, await client.waitForTransactionFinalization(th, 180_000), which);
}

async function estimateEnergy(which, sender, entrypoint, json) {
  const r = await retry(() => grpc().invokeContract({ contract: address(which), invoker: AccountAddress.fromBase58(sender), method: rn(which, entrypoint),
    parameter: encodeParam(which, entrypoint, json), energy: Energy.create(200000n) }));
  return BigInt(Math.ceil(Number(r.usedEnergy.value) * 1.2)) + 300n;
}

export async function update(signer, sender, which, entrypoint, json, energy = null) {
  energy ??= await estimateEnergy(which, sender, entrypoint, json);
  return send(signer, sender, AccountTransactionType.Update, { amount: CcdAmount.zero(), address: address(which), receiveName: rn(which, entrypoint),
    message: encodeParam(which, entrypoint, json), maxContractExecutionEnergy: Energy.create(energy) }, which);
}

/** A contract call from `sender` whose CCD fee is paid by the sponsor. Returns the sponsor-signed transaction (what the wallet gets). */
export async function buildSponsored(sponsorSigner, sender, which, entrypoint, json, { minutes = 10 } = {}) {
  const energy = await estimateEnergy(which, sender, entrypoint, json);
  const { nonce } = await retry(() => grpc().getNextAccountNonce(AccountAddress.fromBase58(sender)));
  const tx = Transaction.updateContract({ amount: CcdAmount.zero(), address: address(which), receiveName: rn(which, entrypoint), message: encodeParam(which, entrypoint, json) }, Energy.create(energy))
    .addMetadata({ sender: AccountAddress.fromBase58(sender), nonce, expiry: TransactionExpiry.futureMinutes(minutes) })
    .addSponsor(AccountAddress.fromBase58(SPONSOR))
    .build();
  return Transaction.sponsor(tx, sponsorSigner);
}
export const toWalletJSON = (signed) => JSON.parse(Transaction.toJSONString(signed));

/** What the Browser Wallet's sendSponsoredTransaction does: add the sender's signature and submit. Used by the demo people. */
export async function signAndSubmitSponsored(sponsoredJSONorTx, userSigner, which = "pot") {
  const isJSON = typeof sponsoredJSONorTx?.header?.sender === "string";
  const parsed = isJSON ? Transaction.signableFromJSON(sponsoredJSONorTx) : sponsoredJSONorTx;
  const signed = await Transaction.sign(parsed, userSigner);
  const th = await grpc().sendTransaction(Transaction.finalize(signed));
  return summarize(th, await grpc().waitForTransactionFinalization(th, 180_000), which);
}
/** Build, sign (as sender) and submit a sponsored call in one go, serialized per sender. For server-held demo keys only. */
export async function sponsoredCall(sponsorSigner, userSigner, sender, which, entrypoint, json) {
  return withSender(sender, async () => signAndSubmitSponsored(await buildSponsored(sponsorSigner, sender, which, entrypoint, json), userSigner, which));
}

/** Dry run (no transaction, no fee). */
export async function retry(fn, tries = 7) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries - 1 || !/UNAVAILABLE|Connection dropped|No connection|ECONNRESET|socket/i.test(String(e?.code) + String(e?.message))) throw e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
}
export async function dryRun(which, invoker, entrypoint, json) {
  const r = await retry(() => grpc().invokeContract({ contract: address(which), invoker: invoker ? AccountAddress.fromBase58(invoker) : undefined, method: rn(which, entrypoint),
    parameter: json === undefined ? undefined : encodeParam(which, entrypoint, json), energy: Energy.create(200000n) }));
  if (r.tag === "success") {
    let rv = null;
    try { if (r.returnValue) rv = deserializeReceiveReturnValue(Buffer.from(r.returnValue.buffer), schema(which), ContractName.fromString(CONTRACTS[which].name), EntrypointName.fromString(entrypoint)); }
    catch (e) { if (!/no return value schema/.test(String(e.message))) throw e; }
    return { ok: true, value: jsonSafe(rv) };
  }
  const code = r.reason?.rejectReason;
  return { ok: false, error: code !== undefined ? decodeError(which, code) : jsonSafe(r.reason) };
}
export const view = async (which, entrypoint, json) => { const r = await dryRun(which, undefined, entrypoint, json); if (!r.ok) throw new Error(`${entrypoint}: ${r.error}`); return r.value; };
export async function balance(addr) { const i = await retry(() => grpc().getAccountInfo(AccountAddress.fromBase58(addr))); return i.accountAmount.microCcdAmount; }

// ---- EUR-demo token helpers
const addrJSON = (a) => (typeof a === "string" ? { Account: [a] } : { Contract: [{ index: Number(a.index), subindex: 0 }] });
export async function tokenBalance(addr) {
  const r = await view("token", "balanceOf", [{ token_id: "", address: addrJSON(addr) }]);
  return BigInt(r[0]);
}
export const potAddressJSON = () => ({ index: Number(address("pot").index), subindex: 0 });
/** BuyParams as bytes (u64 LE event id, u8 outcome, u32 LE count): the `data` of the CIS-2 transfer. */
export function buyData(eventId, outcome, count) {
  const b = Buffer.alloc(13); b.writeBigUInt64LE(BigInt(eventId), 0); b.writeUInt8(outcome, 8); b.writeUInt32LE(count, 9); return b.toString("hex");
}
/** The token transfer that buys cards: from the player to the pot, with the purchase in `data`. */
export const buyTransferJSON = (player, eventId, outcome, count, amount) => [{ token_id: "", amount: String(amount), from: { Account: [player] },
  to: { Contract: [potAddressJSON(), "onReceivingCIS2"] }, data: buyData(eventId, outcome, count) }];
/** A pack: several purchases in ONE token transfer transaction (all or nothing). items: [{event_id, outcome, count, amount}] */
export const packTransferJSON = (player, items) => items.map((i) => ({ token_id: "", amount: String(i.amount), from: { Account: [player] },
  to: { Contract: [potAddressJSON(), "onReceivingCIS2"] }, data: buyData(i.event_id, i.outcome, i.count) }));
/** Plain EUR-demo transfer between accounts (e.g. Amy tops up her agent's wallet). */
export const tokenTransferJSON = (from, to, amount) => [{ token_id: "", amount: String(amount), from: { Account: [from] }, to: { Account: [to] }, data: "" }];

/** Sponsored call with a pre-encoded parameter on any contract (used for Agent Registry payloads built by Concordium's MCP). */
export async function buildSponsoredRaw(sponsorSigner, sender, contract, receiveName, parameterHex, { minutes = 10, energy = null } = {}) {
  const { Parameter } = await import("@concordium/web-sdk");
  const param = Parameter.fromHexString(parameterHex);
  if (!energy) {
    const r = await retry(() => grpc().invokeContract({ contract, invoker: AccountAddress.fromBase58(sender), method: ReceiveName.fromString(receiveName), parameter: param, energy: Energy.create(300000n) }));
    if (r.tag !== "success") throw new Error(`dry run of ${receiveName} failed: ${JSON.stringify(jsonSafe(r.reason ?? r)).slice(0, 300)}`);
    energy = BigInt(Math.ceil(Number(r.usedEnergy.value) * 1.25)) + 500n;
  }
  const { nonce } = await retry(() => grpc().getNextAccountNonce(AccountAddress.fromBase58(sender)));
  const tx = Transaction.updateContract({ amount: CcdAmount.zero(), address: contract, receiveName: ReceiveName.fromString(receiveName), message: param }, Energy.create(BigInt(energy)))
    .addMetadata({ sender: AccountAddress.fromBase58(sender), nonce, expiry: TransactionExpiry.futureMinutes(minutes) })
    .addSponsor(AccountAddress.fromBase58(SPONSOR))
    .build();
  return Transaction.sponsor(tx, sponsorSigner);
}
