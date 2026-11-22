// Durable storage for the small off-chain index (ledger, faucet record, visitor agents, results evidence).
// Locally everything lives in .run/. On Render the disk is wiped on every restart, so when REDIS_URL is set (a Render
// Key Value instance) each file is mirrored there and pulled back on start. The chain stays the source of truth for money.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import path from "node:path";
import { ROOT } from "./config.mjs";

export const RUN = path.join(ROOT, ".run");
const SEED = path.join(ROOT, "data", "seed");
let client = null;
const prefix = "eventscope:";

export async function initStore() {
  mkdirSync(path.join(RUN, "evidence"), { recursive: true });
  if (process.env.REDIS_URL) {
    const { createClient } = await import("redis");
    client = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: (n) => Math.min(n * 500, 5000) } });
    client.on("error", (e) => console.error("[store]", e.message));
    await client.connect();
    for (const k of await client.keys(prefix + "file:*")) {
      const name = k.slice((prefix + "file:").length);
      const f = path.join(RUN, name);
      if (!existsSync(f)) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, gunzipSync(Buffer.from(await client.get(k), "base64"))); }
    }
  }
  // first start anywhere: seed from the repo copy (public data only: events, cards, results, evidence)
  if (existsSync(SEED)) {
    const walk = (d, rel = "") => { for (const n of readdirSync(path.join(d, rel), { withFileTypes: true })) {
      const r = path.join(rel, n.name);
      if (n.isDirectory()) { mkdirSync(path.join(RUN, r), { recursive: true }); walk(d, r); }
      else if (!existsSync(path.join(RUN, r))) { copyFileSync(path.join(d, r), path.join(RUN, r)); mirror(r); }
    } };
    walk(SEED);
  }
  return { durable: !!client };
}

const timers = new Map();
/** Mirror one file under .run to Key Value (debounced). Safe to call often. */
export function mirror(rel, delay = 1500) {
  if (!client) return;
  clearTimeout(timers.get(rel));
  timers.set(rel, setTimeout(async () => {
    timers.delete(rel);
    try { await client.set(prefix + "file:" + rel, gzipSync(readFileSync(path.join(RUN, rel))).toString("base64")); }
    catch (e) { console.error("[store] mirror", rel, e.message); }
  }, delay));
}
export function readJSON(rel, fallback) { const f = path.join(RUN, rel); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fallback; }
export function writeJSON(rel, obj) { const f = path.join(RUN, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(obj, null, 1)); mirror(rel); }
export function writeRaw(rel, buf) { const f = path.join(RUN, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, buf); mirror(rel, 0); }
export const storeInfo = () => ({ durable: !!client, kind: client ? "render-key-value" : "local-disk" });

/** Delete mirrored evidence files that nothing references (left over from failed result posts). Returns counts. */
export async function pruneEvidence(keep) {
  const { unlinkSync, readdirSync: rd } = await import("node:fs");
  let removedKV = 0, removedLocal = 0, kept = 0;
  if (client) {
    for (const k of await client.keys(prefix + "file:evidence/*")) {
      const sha = k.slice((prefix + "file:evidence/").length).replace(/\.json$/, "");
      if (keep.has(sha)) { kept++; continue; }
      await client.del(k); removedKV++;
    }
  }
  const dir = path.join(RUN, "evidence");
  if (existsSync(dir)) for (const n of rd(dir)) { if (!keep.has(n.replace(/\.json$/, ""))) { try { unlinkSync(path.join(dir, n)); removedLocal++; } catch {} } }
  return { kept, removed_kv: removedKV, removed_local: removedLocal };
}
/** Key Value memory use, for the health check. */
export async function memory() {
  if (!client) return null;
  try {
    const info = await client.info("memory");
    const g = (k) => Number((info.match(new RegExp(`^${k}:(\\d+)`, "m")) || [])[1] || 0);
    const used = g("used_memory"), max = g("maxmemory");
    return { used_mb: +(used / 1048576).toFixed(2), max_mb: max ? +(max / 1048576).toFixed(2) : null, headroom_pct: max ? Math.round((1 - used / max) * 100) : null, keys: await client.dbSize() };
  } catch (e) { return { error: e.message }; }
}
export const hasFile = (rel) => existsSync(path.join(RUN, rel));
