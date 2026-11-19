// Visitors' own buyer agents. A visitor (verified with their own wallet) gets an agent registered in Concordium's Agent
// Registry under THEIR account. The agent's wallet is one of EventScope's pool accounts (testnet accounts the server holds
// keys for, so the agent can act while the visitor is away). Binding it needs both sides: the pool wallet signs the
// registry's 162-byte setAgentWallet message here, and the visitor signs register, setAgentWallet and linkAgent in their wallet.
// The pot then re-reads the registry on chain at every agent buy and enforces the visitor's daily cap and pause.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createPrivateKey, sign } from "node:crypto";
import { ROOT } from "./config.mjs";
import { readJSON, writeJSON } from "./store.mjs";
import { mcp, REGISTRY, readAgentOnChain } from "./registry.mjs";
import { load, keyHex } from "./testusers.mjs";

const FILE = "visitor-agents.json";
export const state = () => readJSON(FILE, {});
const save = (s) => writeJSON(FILE, s);

/** Pool accounts: .secrets/account-ben-pool<N>.json (credential N of the Ben test identity). */
export function pool() {
  const dir = path.join(ROOT, ".secrets"); if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^account-ben-pool\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"))).sort((a, b) => a.credNumber - b.credNumber);
}
export const poolKey = (credNumber) => keyHex(load("ben"), credNumber);
export const agentOf = (owner) => state()[owner] || null;

export function assign(owner, reserved = []) {
  const s = state(); if (s[owner]) return s[owner];
  const taken = new Set([...Object.values(s).map((x) => x.wallet), ...reserved]);
  const free = pool().find((p) => !taken.has(p.address));
  if (!free) return null;
  s[owner] = { owner, wallet: free.address, cred: free.credNumber, step: "assigned", created: new Date().toISOString() };
  save(s); return s[owner];
}
export function patch(owner, fields) { const s = state(); s[owner] = { ...s[owner], ...fields }; save(s); return s[owner]; }

export async function buildRegister(owner, publicUrl) {
  return mcp("build_register", { sender: owner, agent_uri: `${publicUrl}/agents/owner/${owner}.json` });
}
/** Find the new token id in a finalized register transaction's events and check it belongs to `owner`. */
export async function tokenFromRegister(summary, owner) {
  const ev = JSON.stringify(summary?.events ?? summary, (_, v) => (typeof v === "bigint" ? v.toString() : v)).match(/"fe08([0-9a-f]{16})/);
  if (!ev) return null;
  const id = Buffer.from(ev[1], "hex").readBigUInt64LE().toString();
  const rec = await readAgentOnChain(id);
  return rec && rec.owner === owner ? { id, rec } : null;
}
export async function buildSetWallet(owner, tokenId, wallet, cred) {
  const deadline = Date.now() + 30 * 60_000;
  const cb = await mcp("set_agent_wallet_canonical_bytes", { token_id: String(tokenId), new_wallet: wallet, deadline_unix_ms: deadline });
  const msg = Buffer.from(cb.bytes_hex, "hex");
  if (msg.length !== 162 || cb.owner_account !== owner) throw new Error("registry says this agent is not owned by your account");
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(poolKey(cred), "hex")]), format: "der", type: "pkcs8" });
  return mcp("build_set_agent_wallet", { token_id: String(tokenId), new_wallet: wallet, deadline_unix_ms: deadline, signature_hex: sign(null, msg, key).toString("hex"), sender: owner });
}
export const card = (owner, a, publicUrl) => ({
  name: `EventScope buyer agent for ${owner.slice(0, 6)}…`, description: "Picks and collects EventScope cards for its owner from its own wallet. The prize pot reads this agent's Concordium Agent Registry entry at every buy and enforces the owner's daily cap and pause.",
  url: publicUrl, version: "1", provider: { organization: "EventScope (testnet demo)", url: publicUrl },
  capabilities: { extensions: [{ uri: "https://concordium.com/agent-registry/v1", params: { network: "testnet", registry: "12802,0", token_id: a?.token_id ?? null, owner_account: owner, agent_wallet: a?.wallet ?? null } }] },
  skills: [{ id: "collect-cards", name: "Collect cards", description: "Reads public data (Coinbase, Open-Meteo, fixtures), picks an outcome with a stated reason and buys within the owner's limits." }],
});
export { REGISTRY };
