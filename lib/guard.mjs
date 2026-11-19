// Public-use guards: rate limits per IP and per account, and an hourly cap on CCD the operator spends on visitors' behalf
// (sponsored fees, proof anchors, allow flags, faucet mints). Over a limit the API answers 429 / 503 with a plain message.
const buckets = new Map();
/** Sliding-window limit: at most `max` hits per `windowMs` for `key`. Returns true if allowed. */
export function hit(key, max, windowMs) {
  const now = Date.now(); const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(now); buckets.set(key, arr); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.some((t) => now - t < 3600_000)) buckets.delete(k); }, 600_000).unref();

export const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";

// Per-route limits: [per IP, per account], each [max, windowMs]
const MIN = 60_000, H = 3600_000;
export const LIMITS = {
  verify: { ip: [6, H], account: [4, H] },          // each try anchors a proof request on chain
  prepare: { ip: [40, 10 * MIN], account: [30, 10 * MIN] }, // buy, pack, claim, limits, agent steps (build a sponsored tx)
  agentRun: { ip: [10, 10 * MIN], account: [6, 10 * MIN] },
  demo: { ip: [20, 10 * MIN] },
  read: { ip: [400, MIN] },
};
export function limited(kind, ip, account) {
  const l = LIMITS[kind]; if (!l) return null;
  if (l.ip && !hit(`${kind}:ip:${ip}`, ...l.ip)) return "Too many requests from your connection. Wait a few minutes and try again.";
  if (account && l.account && !hit(`${kind}:acct:${account}`, ...l.account)) return "Too many requests for this account. Wait a few minutes and try again.";
  return null;
}

// Sponsor budget: estimated CCD per operator-paid transaction (testnet price today is about 20 to 25 CCD per contract call).
const TX_CCD = Number(process.env.EVENTSCOPE_TX_CCD || 25);
const CAP = Number(process.env.EVENTSCOPE_SPONSOR_CCD_PER_HOUR || 750);
const spent = [];
const used = () => { const now = Date.now(); while (spent.length && now - spent[0].t > H) spent.shift(); return spent.reduce((s, x) => s + x.ccd, 0); };
/** Reserve budget for `txs` operator-paid transactions; throws a Busy error if the hourly cap would be passed. */
export function reserve(txs = 1, what = "") {
  const need = txs * TX_CCD;
  if (used() + need > CAP) { const e = new Error("EventScope is busy right now (the hourly budget for network fees is used up). Please try again later."); e.busy = true; throw e; }
  spent.push({ t: Date.now(), ccd: need, what });
}
export const budget = () => ({ cap_ccd_per_hour: CAP, used_ccd_last_hour: used(), est_ccd_per_tx: TX_CCD });
