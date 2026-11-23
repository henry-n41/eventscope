// WalletConnect glue for Concordium mobile wallets (CryptoX / Concordium Wallet for mobile, testnet builds).
// Bundled separately to web/wc.js and loaded only when someone picks "phone wallet", so the extension flow is untouched.
// Uses Concordium's official @concordium/wallet-connectors (0.9.0: sign_and_send_sponsored_transaction support).
import "./shim.js";
import {
  WalletConnectConnector, WalletConnectConnection, createWalletConnectModalConfig, TESTNET,
  CONCORDIUM_WALLET_CONNECT_PROJECT_ID,
} from "@concordium/wallet-connectors";
import { AccountAddress } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";

const CHAIN = "ccd:testnet";
// Only the two methods EventScope needs. Both mobile wallets list them as supported (cryptox-android
// WalletConnectViewModel.allowedRequestMethods, cryptox-ios SessionRequestDataType); a session proposal with a
// method the wallet does not know is rejected outright, so we keep the list minimal.
const METHODS = ["sign_and_send_sponsored_transaction", "request_verifiable_presentation_v1"];
let connector = null, connection = null, listeners = [];
const emit = (a) => listeners.forEach((f) => { try { f(a); } catch {} });

const delegate = {
  onAccountChanged: (_c, a) => emit(a ?? null),
  onChainChanged: () => {},
  onConnected: (c, a) => { connection = c; emit(a ?? null); },
  onDisconnected: () => { connection = null; emit(null); },
};

export async function init(projectId) {
  if (connector) return connector;
  const pid = projectId || CONCORDIUM_WALLET_CONNECT_PROJECT_ID;
  const modal = { ...createWalletConnectModalConfig(TESTNET), projectId: pid, themeMode: "dark" };
  connector = await WalletConnectConnector.create(
    { projectId: pid, metadata: { name: "EventScope", description: "Collect cards on real events (Concordium testnet)", url: location.origin, icons: [location.origin + "/art/pack.svg"] } },
    delegate, TESTNET, { methods: METHODS, events: ["accounts_changed", "chain_changed"] }, modal,
  );
  return connector;
}
export const onAccount = (fn) => listeners.push(fn);
export const projectIdInUse = (p) => p || CONCORDIUM_WALLET_CONNECT_PROJECT_ID;

/** Re-attach to a session that survived a page reload (WalletConnect keeps it in localStorage). */
export async function restore(projectId) {
  await init(projectId);
  const s = connector.client.session.getAll().filter((x) => x.namespaces?.ccd?.accounts?.some((a) => a.startsWith(CHAIN + ":")) && x.expiry * 1000 > Date.now()).pop();
  if (!s) return null;
  connection = new WalletConnectConnection(connector, CHAIN, s);
  connector.connections.set(s.topic, connection);
  return connection.getConnectedAccount();
}
/** Shows the WalletConnect modal: a QR code on desktop, wallet buttons (deep links) on a phone. */
export async function connect(projectId) {
  await init(projectId);
  const c = await connector.connect();
  if (!c) throw new Error("Connection cancelled");
  connection = c;
  return c.getConnectedAccount();
}
export async function disconnect() { try { await connection?.disconnect(); } catch {} connection = null; emit(null); }
export const account = () => connection?.getConnectedAccount() ?? null;

function need() { if (!connection) throw new Error("Phone wallet not connected"); return connection; }

/** Sponsor-signed V1 transaction from our backend -> wallet adds the sender signature and submits. Returns the tx hash. */
export async function sponsored(account, txJson, schema) {
  const c = need();
  const tx = Transaction.signableFromJSON(txJson);
  return String(await c.signAndSendSponsoredTransaction(AccountAddress.fromBase58(account), tx, schema));
}

const parse = (x) => (typeof x === "string" ? JSON.parse(x) : x);
/** VerificationRequestV1 (JSON form, includes transactionRef to the on-chain anchor) -> VerifiablePresentationV1 JSON. */
export async function presentationV1(requestJson) {
  const c = need();
  const res = parse(await c.connector.client.request({
    topic: c.session.topic, chainId: CHAIN,
    request: { method: "request_verifiable_presentation_v1", params: requestJson },
  }));
  // Android answers {"verifiablePresentationJson": {...}}; iOS encodes the same key.
  return parse(res?.verifiablePresentationJson ?? res);
}
