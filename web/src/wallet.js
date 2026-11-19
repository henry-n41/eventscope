// Concordium Wallet for Web (browser extension) glue for the EventScope page. Bundled to web/app.js with esbuild.
import "./shim.js";
// The extension injects window.concordium; nothing here sees keys. The backend never sees the user's keys either.
import { detectConcordiumProvider } from "@concordium/browser-wallet-api-helpers";
import { AccountAddress, VerificationRequestV1 } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { Buffer } from "buffer";

export const INSTALL_URL = "https://chromewebstore.google.com/detail/concordium-wallet/mnnkpffndmickbiakofclnpoiajlegmg";
const TESTNET = "4221332d34e1694168c2a0c0b3fd0f27";
let provider = null;
const api = async (p, b) => { const r = await fetch(p, b ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) } : {}); return r.json(); };
const schemas = {};
async function moduleSchema(which) {
  schemas[which] ||= (await api(`/api/schema?which=${which}`)).base64;
  return { type: "ModuleSchema", value: Buffer.from(schemas[which], "base64") };
}

export async function detect(timeoutMs = 2000) {
  try { provider = await detectConcordiumProvider(timeoutMs); } catch { provider = null; }
  return !!provider;
}
export async function connect() {
  if (!provider && !(await detect())) throw new Error("Concordium Wallet for Web not found in this browser");
  const accounts = await provider.requestAccounts();
  const chain = await provider.getSelectedChain().catch(() => undefined);
  if (chain && !String(chain).toLowerCase().startsWith(TESTNET)) throw new Error("The wallet is not on Testnet. Switch the network to Testnet in the wallet settings.");
  if (!accounts?.[0]) throw new Error("No account selected in the wallet");
  return accounts[0];
}
export const onAccountChanged = (fn) => provider?.on?.("accountChanged", fn);

/** Zero-knowledge account proof: 18+ and country of residence not in the blocked list. */
export async function verify(account) {
  const s = await api("/api/wallet/verify/start", { account });
  if (!s.request) throw new Error(s.error || "could not start verification");
  const request = VerificationRequestV1.fromJSON(s.request);
  const presentation = await provider.requestVerifiablePresentationV1(request); // the wallet shows the request; the user approves
  const pj = typeof presentation?.toJSON === "function" ? presentation.toJSON() : presentation;
  const r = await api("/api/wallet/verify/finish", { id: s.id, presentation: pj });
  return { ...r, anchor_link: s.anchor_link };
}

/** The backend builds a sponsored transaction (operator pays the CCD fee); the wallet shows it, the user approves, the wallet submits. */
async function approveSponsored(account, prepared) {
  const tx = Transaction.signableFromJSON(prepared.tx);
  // Pass the base58 STRING. The extension's sendSponsoredTransaction (unlike sendTransaction) forwards accountAddress
  // unconverted, and its gate does allowlist[origin].includes(accountAddress); an AccountAddress object never matches,
  // so the wallet answers "Site is not whitelisted". (concordium-browser-wallet background/index.ts runIfAccountIsAllowlisted)
  const addr = AccountAddress.toBase58(AccountAddress.fromBase58(account)); // validates, then back to a plain string
  const hash = await provider.sendSponsoredTransaction(addr, tx, await moduleSchema(prepared.schema_for));
  return String(hash?.toString?.() ?? hash);
}
export async function buy(account, eventId, outcome, count) {
  const p = await api("/api/wallet/buy", { account, event_id: eventId, outcome, count });
  if (!p.ok) return p;
  return { ok: true, amount_eur: p.amount_eur, hash: await approveSponsored(account, p) };
}
export async function pack(account) {
  const p = await api("/api/wallet/pack", { account });
  if (!p.ok) return p;
  return { ok: true, amount_eur: p.amount_eur, picks: p.picks, hash: await approveSponsored(account, p) };
}
/** setLimits, approveExtra or pauseMe, signed by the person in their own wallet. */
export async function call(account, entrypoint, args) {
  const p = await api("/api/wallet/call", { account, entrypoint, ...args });
  if (!p.ok) return p;
  return { ok: true, hash: await approveSponsored(account, p) };
}
/** Your own buyer agent: step = register | wallet | link | topup. The backend builds the sponsored transaction; you approve it. */
export async function agent(account, step, args = {}) {
  const p = await api(`/api/wallet/agent/${step}`, { account, ...args });
  if (!p.ok) return p;
  return { ok: true, hash: await approveSponsored(account, p) };
}
export async function claim(account, eventId) {
  const p = await api("/api/wallet/claim", { account, event_id: eventId });
  if (!p.ok) return p;
  return { ok: true, amount_eur: p.amount_eur, hash: await approveSponsored(account, p) };
}
export async function waitTx(hash, tries = 60) {
  for (let i = 0; i < tries; i++) { const s = await api(`/api/tx?hash=${hash}`); if (s.status === "finalized") return s; await new Promise((r) => setTimeout(r, 2000)); }
  return { status: "pending", link: `https://ccdexplorer.io/testnet/transaction/${hash}` };
}

// Exposed for the headless test harness (a stand-in wallet) and for debugging in the console. No secrets here.
import { VerifiablePresentationV1 } from "@concordium/web-sdk";
window.__EventScopeSdk = { Transaction, VerificationRequestV1, VerifiablePresentationV1 };
