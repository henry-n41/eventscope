// DEMO ONLY: stands in for the user's wallet for the test people Amy, Ben and Cal (testnet identities with typed-in attributes).
// In the real flow the Browser Wallet or Concordium ID app holds these secrets and makes the proof; the backend never sees them.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { mnemonicToSeedSync } from "@scure/bip39";
import { ConcordiumHdWallet, TransactionExpiry, createCredentialPayload, signCredentialTransaction, serializeCredentialDeploymentPayload,
  getAccountAddress, buildBasicAccountSigner, VerifiablePresentationV1, CredentialRegistrationId, createAccountCommitmentInputWithHdWallet } from "@concordium/web-sdk";
import { grpc } from "./chain.mjs";
import { ROOT } from "./config.mjs";
const S = (f) => path.join(ROOT, ".secrets", f);

export function load(who) {
  const { mnemonic } = JSON.parse(readFileSync(S(`secrets-${who}.json`), "utf8"));
  const seedAsHex = Buffer.from(mnemonicToSeedSync(mnemonic)).toString("hex");
  const wallet = ConcordiumHdWallet.fromHex(seedAsHex, "Testnet");
  const idObject = JSON.parse(readFileSync(S(`idobj-${who}.json`), "utf8")).token.identityObject.value;
  const acct = existsSync(S(`account-${who}.json`)) ? JSON.parse(readFileSync(S(`account-${who}.json`), "utf8")) : null;
  return { who, seedAsHex, wallet, idObject, acct };
}
export const signer = (u) => buildBasicAccountSigner(u.wallet.getAccountSigningKey(0, 0, 0).toString("hex"));
/** Key of the person's n-th account (credential n of the same identity). (IP 0, identity 0, credential n). Account 1 of Amy is her buyer agent's wallet. */
export const keyHex = (u, credNumber = 0) => u.wallet.getAccountSigningKey(0, 0, credNumber).toString("hex");

/** Create the on-chain account from the test identity if it does not exist yet (credential deployment, no CCD needed). */
export async function ensureAccount(who, credNumber = 0, label = null) {
  const u = load(who);
  const file = label ? `account-${who}-${label}.json` : `account-${who}.json`;
  if (credNumber === 0 && u.acct) return u.acct;
  if (credNumber !== 0 && existsSync(S(file))) return JSON.parse(readFileSync(S(file), "utf8"));
  const client = grpc();
  const ips = await (await fetch("https://wallet-proxy.testnet.concordium.com/v2/ip_info")).json();
  const ip0 = ips.find((x) => x.ipInfo.ipIdentity === 0);
  const expiry = TransactionExpiry.futureMinutes(10);
  const payload = createCredentialPayload({ ipInfo: ip0.ipInfo, globalContext: await client.getCryptographicParameters(), arsInfos: ip0.arsInfos,
    idObject: u.idObject, revealedAttributes: [], credNumber, seedAsHex: u.seedAsHex, net: "Testnet", identityIndex: 0 }, expiry);
  const sig = await signCredentialTransaction(payload, u.wallet.getAccountSigningKey(0, 0, credNumber).toString("hex"));
  const th = await client.sendCredentialDeploymentTransaction(serializeCredentialDeploymentPayload([sig], payload), expiry);
  await client.waitForTransactionFinalization(th, 180000);
  const acct = { who, credNumber, tx: th.toString(), credId: payload.unsignedCdi.credId, address: getAccountAddress(payload.unsignedCdi.credId).address };
  writeFileSync(S(file), JSON.stringify(acct, null, 1), { mode: 0o600 });
  return acct;
}

/** Make the account-bound presentation for a request, as the wallet would. Throws if the person does not meet the statements. */
export async function prove(who, request) {
  const u = load(who);
  const stmts = request.subjectClaims[0].statements;
  const subj = [VerifiablePresentationV1.createAccountClaims("Testnet", CredentialRegistrationId.fromHexString(u.acct.credId), 0, VerifiablePresentationV1.noRevealRequestedStatements(stmts))];
  const input = createAccountCommitmentInputWithHdWallet(stmts, 0, u.idObject.attributeList, u.wallet, 0, 0);
  return VerifiablePresentationV1.createFromAnchor(grpc(), request, subj, [input], []);
}
