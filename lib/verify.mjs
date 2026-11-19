// Verifier side: anchor a zero-knowledge proof request (18+ and country of residence not GB), check the returned
// presentation, find the account it was made for, and mark that account allowed in the contract.
import { randomBytes } from "node:crypto";
import { AccountAddress, IdentityProviderDID, VerificationRequestV1, VerifiablePresentationV1, VerificationAuditRecordV1, getAccountAddress } from "@concordium/web-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { grpc, update, tokenBalance } from "./chain.mjs";
import { mirror } from "./store.mjs";
import { OPERATOR, RESOURCE_ID, ALLOW_HOURS, START_GRANT, ROOT, deployment } from "./config.mjs";

export const BLOCKED_COUNTRIES = ["GB"];
export const MIN_AGE = 18;
// Testnet identity providers accepted: 0 Concordium testnet IP, 3 Digital Trust Solutions TestNet, 4 Global FinReg Testnet, 5 Dataspike. On mainnet: real providers only.
export const ACCEPTED_IDPS = (process.env.EVENTSCOPE_IDPS || "0,3,4,5").split(",").map(Number); // all four testnet providers

/** Build and anchor an account-bound request. Costs the operator a small fee (Verification Request Anchor). */
export async function createRequest(signer, connectionId = "conn-" + randomBytes(4).toString("hex")) {
  const claims = VerificationRequestV1.claimsBuilder()
    .addAccountClaims(ACCEPTED_IDPS.map((i) => new IdentityProviderDID("Testnet", i)), (b) => b.addMinimumAge(MIN_AGE).addNonMembership("countryOfResidence", BLOCKED_COUNTRIES))
    .getClaims();
  const ctx = VerificationRequestV1.createSimpleContext(randomBytes(32), connectionId, RESOURCE_ID, `EventScope: ${MIN_AGE}+ and not resident in ${BLOCKED_COUNTRIES.join(", ")}`);
  const request = await VerificationRequestV1.createAndAnchor(grpc(), { sender: AccountAddress.fromBase58(OPERATOR), signer }, { given: ctx.given, requested: ctx.requested }, claims);
  await grpc().waitForTransactionFinalization(request.transactionRef, 120000);
  return request;
}

/** Check a presentation against its request. Returns { ok, account, credId, error }. Never trusts the browser. */
export async function checkPresentation(request, presentation) {
  const p = typeof presentation?.toJSON === "function" ? presentation : VerifiablePresentationV1.fromJSON(typeof presentation === "string" ? JSON.parse(presentation) : presentation);
  let r;
  try { r = await VerificationAuditRecordV1.createChecked("eventscope-" + Date.now(), request, p, grpc(), "Testnet"); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
  if (r.type !== "success") return { ok: false, error: String(r.error?.message || r.error || r.type) };
  const json = JSON.stringify(p.toJSON());
  const creds = [...json.matchAll(/did:ccd:testnet:cred:([0-9a-f]{96})/g)].map((m) => m[1]);
  if (creds.length !== 1) return { ok: false, error: "expected exactly one account credential in the proof" };
  const credId = creds[0];
  const account = getAccountAddress(credId).address;
  // the credential must really be on that account on chain
  const info = await grpc().getAccountInfo(AccountAddress.fromBase58(account));
  const onChain = Object.values(info.accountCredentials).some((c) => (c.value.contents.credId ?? c.value.contents.regId) === credId);
  if (!onChain) return { ok: false, error: "credential not found on the account" };
  return { ok: true, account, credId };
}

/** After a successful check: set the allow flag for the proved account (operator signs). */
export async function markAllowed(signer, account, hours = ALLOW_HOURS) {
  const until = new Date(Date.now() + hours * 3600_000).toISOString();
  return { until, ...(await update(signer, OPERATOR, "pot", "setAllowed", { account, until: { Some: [until] } })) };
}

/** Demo play money: mint START_GRANT EUR-demo once to a newly verified account (only ever called after a valid proof). */
const GRANTS = path.join(ROOT, ".run", "grants.json");
export async function grantPlayMoney(signer, account) {
  mkdirSync(path.dirname(GRANTS), { recursive: true });
  const all = existsSync(GRANTS) ? JSON.parse(readFileSync(GRANTS, "utf8")) : {};
  const key = `${deployment().token.index}:${account}`;
  if (all[key]) return { skipped: "already granted", tx: all[key] };
  const r = await update(signer, OPERATOR, "token", "mint", { to: account, amount: START_GRANT.toString() });
  if (r.outcome === "success") { all[key] = r.tx; writeFileSync(GRANTS, JSON.stringify(all, null, 1)); mirror("grants.json"); }
  return { ...r, balance: (await tokenBalance(account)).toString() };
}
