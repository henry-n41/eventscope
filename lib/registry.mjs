// Concordium CIS-8004 Agent Registry (testnet 12802,0): register EventScope's two agents, give them a wallet, read them.
// Uses Concordium's hosted Agent Registry MCP only for sign-ready payloads (it holds no keys); we sign and submit here.
import { createPrivateKey, sign, createHash } from "node:crypto";
import { AccountAddress, AccountTransactionType, CcdAmount, ContractAddress, ContractName, EntrypointName, Energy, Parameter, ReceiveName, TransactionExpiry,
  buildBasicAccountSigner, signTransaction, deserializeReceiveReturnValue, tokenAddressToBase58 } from "@concordium/web-sdk";
import { readFileSync } from "node:fs";
import { grpc } from "./chain.mjs";
import { jsonSafe } from "./config.mjs";

export const REGISTRY = ContractAddress.create(12802n, 0n);
export const REGISTRY_CONTRACT_NAME = "CIS-8004";
const MCP_URL = process.env.EVENTSCOPE_REGISTRY_MCP || "https://agent-registry-mcp.concordium.com/mcp";
/** Call one tool on Concordium's hosted Agent Registry MCP (streamable HTTP, JSON-RPC). It builds payloads and holds no keys. */
export async function mcp(tool, args) {
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const post = async (body) => { const r = await fetch(MCP_URL, { method: "POST", headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }); return r; };
  const r0 = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "eventscope", version: "1" } } });
  const sid = r0.headers.get("mcp-session-id"); if (sid) h["mcp-session-id"] = sid; await r0.text();
  await (await post({ jsonrpc: "2.0", method: "notifications/initialized" })).text();
  let b = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: { network: "testnet", ...args } } })).text();
  if (/^\s*(event:|data:)/.test(b)) b = b.split("\n").find((l) => l.startsWith("data:")).slice(5);
  const res = JSON.parse(b);
  if (res.error) throw new Error(`${tool}: ${JSON.stringify(res.error).slice(0, 300)}`);
  const text = res.result?.content?.[0]?.text ?? "";
  if (res.result?.isError) throw new Error(`${tool}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${tool}: ${text.slice(0, 400)}`); }
}
export const REGISTRY_SCHEMA = Buffer.from(readFileSync(new URL("../contracts/registry/schema.b64", import.meta.url), "utf8").trim(), "base64");

export async function sendRegistryTx(keyHex, sender, built) {
  const client = grpc(); const from = AccountAddress.fromBase58(sender);
  const { nonce } = await client.getNextAccountNonce(from);
  const payload = { amount: CcdAmount.zero(), address: REGISTRY, receiveName: ReceiveName.fromString(built.receive_name),
    message: Parameter.fromHexString(built.parameter_hex), maxContractExecutionEnergy: Energy.create(BigInt(built.suggested_energy || 30000)) };
  const tx = { header: { sender: from, nonce, expiry: TransactionExpiry.futureMinutes(5) }, payload, type: AccountTransactionType.Update };
  const th = await client.sendAccountTransaction(tx, await signTransaction(tx, buildBasicAccountSigner(keyHex)));
  const out = await client.waitForTransactionFinalization(th, 180_000);
  const s = out.summary; const rejected = s.transactionType === "failed" || !!s.rejectReason;
  return { tx: th.toString(), outcome: rejected ? "rejected" : "success", reject_reason: s.rejectReason ? jsonSafe(s.rejectReason) : null,
    fee_ccd: Number(s.cost) / 1e6, events: jsonSafe(s.events || []) };
}

// The registry caps agent_uri at a few hundred bytes (tested: 256 accepted, 512 refused), so a data: URI does not fit.
// Cards are written to agents/<token_id>.json and served by the EventScope server at PUBLIC_URL/agents/<token_id>.json.
// On the box PUBLIC_URL is http://127.0.0.1:8100, so outside parties cannot fetch them until the app has a public host;
// then one setAgentURI per agent (same hash) fixes it.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";
export const PUBLIC_URL = (process.env.EVENTSCOPE_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "http://127.0.0.1:8100").replace(/\/$/, "");

/** register -> badge the card -> pin card URI + hash -> bind the agent wallet (wallet signs the registry's canonical bytes). */
export async function registerAgent({ ownerKeyHex, owner, card, wallet, tokenId = null, registerTx = null }) {
  const steps = {};
  if (!tokenId) {
    const reg = await mcp("build_register", { sender: owner });
    const r1 = await sendRegistryTx(ownerKeyHex, owner, reg);
    if (r1.outcome !== "success") throw new Error("register rejected " + JSON.stringify(r1.reject_reason));
    steps.register_tx = r1.tx;
    const ev = JSON.stringify(r1.events).match(/"fe08([0-9a-f]{16})/);
    if (!ev) throw new Error("no token id in register events");
    tokenId = Buffer.from(ev[1], "hex").readBigUInt64LE().toString();
  } else steps.register_tx = registerTx;
  const badge = await mcp("build_agent_badge", { card_json: JSON.stringify(card), owner_account: owner, token_id: tokenId, agent_wallet: wallet?.address ?? null });
  const cardJson = badge.agent_card_json;
  const sha = createHash("sha256").update(Buffer.from(cardJson, "utf8")).digest("hex");
  if (sha !== badge.metadata_hash_hex) throw new Error("card hash mismatch");
  mkdirSync(path.join(ROOT, "agents"), { recursive: true });
  writeFileSync(path.join(ROOT, "agents", `${tokenId}.json`), cardJson);
  const uri = `${PUBLIC_URL}/agents/${tokenId}.json`;
  const set = await mcp("build_set_agent_uri", { token_id: tokenId, agent_uri: uri, metadata_hash_hex: sha, sender: owner });
  const r2 = await sendRegistryTx(ownerKeyHex, owner, set);
  if (r2.outcome !== "success") throw new Error("setAgentURI rejected " + JSON.stringify(r2.reject_reason));
  steps.set_uri_tx = r2.tx;
  if (wallet) {
    const deadline = Date.now() + 40 * 60_000;
    const cb = await mcp("set_agent_wallet_canonical_bytes", { token_id: tokenId, new_wallet: wallet.address, deadline_unix_ms: deadline });
    const msg = Buffer.from(cb.bytes_hex, "hex");
    if (msg.length !== 162 || cb.owner_account !== owner) throw new Error("unexpected canonical bytes");
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(wallet.keyHex, "hex")]), format: "der", type: "pkcs8" });
    const built = await mcp("build_set_agent_wallet", { token_id: tokenId, new_wallet: wallet.address, deadline_unix_ms: deadline, signature_hex: sign(null, msg, key).toString("hex"), sender: owner });
    const r3 = await sendRegistryTx(ownerKeyHex, owner, built);
    if (r3.outcome !== "success") throw new Error("setAgentWallet rejected " + JSON.stringify(r3.reject_reason));
    steps.set_wallet_tx = r3.tx;
  }
  return { token_id: tokenId, owner, agent_wallet: wallet?.address ?? null, card_sha256: sha, card: JSON.parse(cardJson), ...steps };
}

/** Concordium's own hosted badge checker (second opinion). */
export async function checkBadge(tokenId) {
  const ta = await mcp("token_address", { contract_index: 12802, contract_subindex: 0, token_id: String(tokenId) });
  const addr = ta.token_address || ta.address || ta;
  try {
    const r = await fetch(`https://agent-registry-mcp.concordium.com/v1/check-badge/${addr}?network=testnet`, { signal: AbortSignal.timeout(20000) });
    return { token_address: addr, ...(await r.json()) };
  } catch (e) { return { token_address: addr, error: String(e.message || e) }; }
}

const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
export const tokenAddressOf = (id) => tokenAddressToBase58({ contract: REGISTRY, id: u64le(id).toString("hex") });
const some = (o) => (o && "Some" in o ? o.Some[0] : null);
/** Read an agent straight from the registry contract (same call the pot makes on chain). */
export async function readAgentOnChain(tokenId) {
  const id = BigInt(tokenId);
  const r = await grpc().invokeContract({ contract: REGISTRY, method: ReceiveName.fromString(`${REGISTRY_CONTRACT_NAME}.agentOf`), parameter: Parameter.fromBuffer(Buffer.concat([Buffer.from([8]), u64le(id)])) });
  if (r.tag !== "success") throw new Error("agentOf call failed");
  const a = some(deserializeReceiveReturnValue(r.returnValue.buffer, REGISTRY_SCHEMA, ContractName.fromString(REGISTRY_CONTRACT_NAME), EntrypointName.fromString("agentOf")));
  if (!a) return null;
  const h = some(a.metadata_hash);
  return { token_id: id.toString(), token_address: tokenAddressOf(id), owner: String(a.owner_account), agent_wallet: some(a.agent_wallet) ? String(some(a.agent_wallet)) : null,
    agent_uri: some(a.agent_uri), metadata_hash_hex: h ? Buffer.from(h.map(Number)).toString("hex") : null, status: Object.keys(a.status || {})[0] || null, registered_at: a.registered_at };
}
