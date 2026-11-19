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
