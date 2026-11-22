// EventScope backend + page. Testnet only. Keys come from the environment and are never sent to the browser.
//   CCD_SPONSOR_PRIVATE_KEY=... node server.mjs        -> http://127.0.0.1:8100
// Runs three agents on timers (EVENTSCOPE_AGENTS=1, default): the live events feed, the results agent, and (on request)
// Amy's buyer agent. Real wallet flow: /api/wallet/*. Demo people with server-held testnet keys: /api/demo/* (default on).
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { ROOT, OPERATOR, OPERATOR_KEY_ENV, CONTRACTS, SPONSOR, TOKEN_SYMBOL, TOKEN_DECIMALS, START_GRANT, deployment, explorerTx, explorerContract, explorerAccount, eur, jsonSafe } from "./lib/config.mjs";
import { view, dryRun, signerFromHex, tokenBalance, address, buildSponsored, toWalletJSON, signAndSubmitSponsored, sponsoredCall, buyTransferJSON, packTransferJSON,
  tokenTransferJSON, schema, grpc, withSender, update, balance } from "./lib/chain.mjs";
import { createRequest, checkPresentation, markAllowed, grantPlayMoney, BLOCKED_COUNTRIES, MIN_AGE } from "./lib/verify.mjs";
import { load, signer as userSigner, prove, keyHex } from "./lib/testusers.mjs";
import { ledger, saveLedger, recordTx, cardsOf, agentLog, rarity } from "./lib/ledger.mjs";
import { cardSvg, packSvg } from "./lib/art.mjs";
import { syncFeed, createdLast24h, DAILY_MAX } from "./lib/feedagent.mjs";
import { runResults, resultsState } from "./lib/resultsagent.mjs";
import { runBuyerAgent, agentBuyOne, approvals } from "./lib/buyeragent.mjs";
import { initStore, storeInfo, pruneEvidence, memory, readJSON, writeJSON } from "./lib/store.mjs";
import { unpackDemoSecrets } from "./lib/secrets.mjs";
import { limited, reserve, budget, clientIp } from "./lib/guard.mjs";
import { HIDDEN_PREFIXES } from "./lib/feeds.mjs";
import * as VA from "./lib/visitoragents.mjs";
import { buildSponsoredRaw } from "./lib/chain.mjs";
import { REGISTRY_SCHEMA, REGISTRY, readAgentOnChain, PUBLIC_URL } from "./lib/registry.mjs";

const PORT = Number(process.env.PORT || process.env.EVENTSCOPE_PORT || 8100);
const HOST = process.env.EVENTSCOPE_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const HAVE_DEMO_KEYS = unpackDemoSecrets();
const STORE = await initStore();
const DEMO = (process.env.EVENTSCOPE_DEMO ?? "1") === "1" && HAVE_DEMO_KEYS;
const VISITOR_AGENTS = HAVE_DEMO_KEYS && VA.pool().length > 0;
const AGENTS = (process.env.EVENTSCOPE_AGENTS ?? "1") === "1";
const key = process.env[OPERATOR_KEY_ENV];
if (!/^[0-9a-f]{64}$/i.test(key || "")) { console.error(`${OPERATOR_KEY_ENV} missing`); process.exit(1); }
const op = signerFromHex(key);
const pending = new Map();
const VERIFY_TTL_MS = 10 * 60_000;

const body = (req) => new Promise((ok, bad) => { let s = ""; req.on("data", (c) => { s += c; if (s.length > 2e6) bad(new Error("too big")); }); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } }); });
const send = (res, code, obj) => {
  const s = JSON.stringify(jsonSafe(obj));
  if (s.length > 4096 && /gzip/.test(res.req?.headers?.["accept-encoding"] || "")) { res.writeHead(code, { "content-type": "application/json", "content-encoding": "gzip", vary: "accept-encoding" }); res.end(gzipSync(s)); return; }
  res.writeHead(code, { "content-type": "application/json" }); res.end(s);
};
const PEOPLE = ["amy", "ben", "cal"];
const people = () => Object.fromEntries(PEOPLE.map((w) => { try { return [w, load(w).acct?.address]; } catch { return [w, null]; } }));
const isAccount = (a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{50}$/.test(a);
const potJSON = () => ({ index: Number(address("pot").index) });
const agentInfo = () => deployment().agents || {};
const agentKey = () => keyHex(load("amy"), 1);

// ------------------------------------------------------------------ events (chain state + feed metadata)
// Chain state per event is cached in memory (and in .run/events-cache.json so a restart serves at once). Requests never
// wait for the chain once the cache is warm: a background refresh re-reads only events that can still change.
const evState = new Map(); // id -> built event
for (const e of readJSON("events-cache.json", [])) evState.set(e.id, e);
let evRefreshing = null, evRefreshedAt = 0, cfgCache = { at: 0, windowMs: 180000 }, evSavedAt = 0;
const terminal = (e, m) => e && (e.status === "cancelled" || e.status === "closed" || (e.status === "final" && !!m?.paid_out_tx));
async function refreshEvents() {
  if (Date.now() - cfgCache.at > 600_000) cfgCache = { at: Date.now(), windowMs: Number((await view("pot", "viewConfig")).dispute_window_ms) };
  const windowMs = cfgCache.windowMs; const metas = Object.values(ledger().events).filter((m) => !terminal(evState.get(m.id), m));
  const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } })); };
  await pool(metas, 6, async (m) => {
    try {
      const ev = await view("pot", "viewEvent", m.id);
      const st = ev.status; const prop = ev.proposal?.Some?.[0] ?? null;
      const closed = Date.parse(ev.closes_at) <= Date.now();
      const status = st.Resolved ? "final" : st.Cancelled ? "cancelled" : prop ? "result_posted" : closed && m.closed_empty ? "closed" : closed ? "awaiting_result" : "live";
      evState.set(m.id, { id: m.id, title: ev.title, category: ev.category, source_ref: ev.source_ref, outcomes: ev.outcomes, closes_at: ev.closes_at, card_price_eur: eur(ev.card_price),
        pot_eur: eur(ev.pot), pot: ev.pot, cards_sold: ev.cards_sold.map(Number), paid_out_eur: eur(ev.paid_out), status, disputes: ev.disputes,
        winner: st.Resolved ? Number(st.Resolved[0]) : null,
        proposal: prop ? { outcome: Number(prop.outcome), evidence_sha256: Buffer.from(prop.evidence_hash.map(Number)).toString("hex"), source_url: prop.source_url, proposed_at: prop.proposed_at,
          dispute_until: new Date(Date.parse(prop.proposed_at) + windowMs).toISOString(), agent_id: prop.agent_id } : null,
        meta: m.meta, result: m.result || null, created_tx: m.created_tx, created_link: explorerTx(m.created_tx), paid_out_tx: m.paid_out_tx && m.paid_out_tx !== "none" ? m.paid_out_tx : null });
    } catch {}
  });
  evRefreshedAt = Date.now();
  if (Date.now() - evSavedAt > 300_000) { evSavedAt = Date.now(); writeJSON("events-cache.json", jsonSafe([...evState.values()])); }
}
const kickRefresh = () => (evRefreshing ||= refreshEvents().catch((e) => console.error("events refresh", e.message)).finally(() => { evRefreshing = null; }));
async function eventsNow(force = false) {
  if (!evState.size || force) await kickRefresh();
  else if (Date.now() - evRefreshedAt > 10_000) kickRefresh();
  const ids = ledger().events;
  return [...evState.values()].filter((e) => ids[e.id]).sort((a, b) => Date.parse(a.closes_at) - Date.parse(b.closes_at));
}
/** What the page needs: everything open or in progress, plus the most recent settled events. */
function eventsForPage(all, { recent = 30 } = {}) {
  const visible = all.filter((e) => !HIDDEN_PREFIXES.some((h) => (e.source_ref || "").startsWith(h)));
  const active = visible.filter((e) => ["live", "awaiting_result", "result_posted"].includes(e.status));
  const settled = visible.filter((e) => e.status === "final" || e.status === "cancelled").sort((a, b) => Date.parse(b.closes_at) - Date.parse(a.closes_at));
  return { events: [...active, ...settled.slice(0, recent)], settled_total: visible.filter((e) => e.status === "final").length, closed_empty_total: visible.filter((e) => e.status === "closed").length, total: visible.length };
}
const metaOf = (id) => ledger().events[id];

// ------------------------------------------------------------------ art (team logos embedded so the SVG works as an <img>)
const logoCache = new Map();
async function logoData(url) {
  if (!url) return null;
  if (logoCache.has(url)) return logoCache.get(url);
  const p = fetch(url.replace("/500/", "/500/") + (url.includes("?") ? "" : "?w=120&h=120"), { signal: AbortSignal.timeout(10000) }).then(async (r) => r.ok ? `data:${r.headers.get("content-type") || "image/png"};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}` : null).catch(() => null);
  logoCache.set(url, p); return p;
}
async function artFor(id, outcome, opts) {
  const m = metaOf(id); if (!m) return null;
  const meta = structuredClone(m.meta || {});
  if (meta.home) meta.home.logo = await logoData(meta.home.logo);
  if (meta.away) meta.away.logo = await logoData(meta.away.logo);
  return cardSvg({ ...m, meta }, outcome, opts);
}

// ------------------------------------------------------------------ purchases
async function prepareBuy(account, eventId, outcome, count) {
  const pre = await dryRun("pot", account, "canBuy", { account, event_id: eventId, outcome, count });
  if (!pre.ok) return { ok: false, refused_before_paying: true, refused_with: pre.error };
  const bal = await tokenBalance(account);
  if (bal < BigInt(pre.value)) return { ok: false, refused_before_paying: true, refused_with: `not enough ${TOKEN_SYMBOL} (have ${eur(bal)}, need ${eur(pre.value)})` };
  reserve(1, "buy");
  const tx = await buildSponsored(op, account, "token", "transfer", buyTransferJSON(account, eventId, outcome, count, BigInt(pre.value)));
  return { ok: true, amount: pre.value, amount_eur: eur(pre.value), tx };
}
/** A pack: 3 cards on 3 different live events, random outcomes, one transaction (all or nothing). */
async function preparePack(account, size = 3) {
  const live = (await eventsNow()).filter((e) => e.status === "live" && Date.parse(e.closes_at) > Date.now() + 3 * 60_000);
  const byCat = {}; for (const e of live) (byCat[e.category] ||= []).push(e);
  const cats = Object.keys(byCat).sort(() => Math.random() - 0.5);
  const picks = [];
  for (let i = 0; picks.length < size && i < 20; i++) { const c = byCat[cats[i % cats.length]]; const e = c?.splice(Math.floor(Math.random() * c.length), 1)[0]; if (e) picks.push({ event_id: e.id, outcome: Math.floor(Math.random() * e.outcomes.length), count: 1 }); }
  if (picks.length < size) return { ok: false, refused_with: "not enough live events for a pack right now" };
  let total = 0n;
  for (const p of picks) {
    const pre = await dryRun("pot", account, "canBuy", { account, event_id: p.event_id, outcome: p.outcome, count: 1 });
    if (!pre.ok) return { ok: false, refused_before_paying: true, refused_with: pre.error };
    p.amount = BigInt(pre.value); total += p.amount;
  }
  const pl = await view("pot", "viewPlayer", (await view("pot", "viewAgent", account))?.Some?.[0]?.owner ?? account);
  if (BigInt(pl.left_today) < total) return { ok: false, refused_before_paying: true, refused_with: `OverDailyCap (pack €${eur(total)}, €${eur(pl.left_today)} left today)` };
  const bal = await tokenBalance(account);
  if (bal < total) return { ok: false, refused_before_paying: true, refused_with: `not enough ${TOKEN_SYMBOL} (have ${eur(bal)}, need ${eur(total)})` };
  reserve(1, "pack");
  return { ok: true, picks, amount: total, amount_eur: eur(total), json: packTransferJSON(account, picks) };
}
async function prepareClaim(account, eventId) {
  const d = await dryRun("pot", account, "claim", eventId);
  if (!d.ok) return { ok: false, refused_with: d.error };
  const h = await view("pot", "viewHolding", { event_id: eventId, account });
  reserve(1, "claim");
  return { ok: true, amount: h.claimable, amount_eur: eur(h.claimable), tx: await buildSponsored(op, account, "pot", "claim", eventId) };
}
async function finishVerify(request, presentation, expectedAccount) {
  const chk = await checkPresentation(request, presentation);
  if (!chk.ok) return [400, chk];
  reserve(2, "allow flag and faucet");
  if (expectedAccount && chk.account !== expectedAccount) return [400, { ok: false, error: "the proof was made for a different account than the connected one" }];
  const m = await markAllowed(op, chk.account);
  const g = await grantPlayMoney(op, chk.account);
  return { ok: true, account: chk.account, allowed_until: m.until, allow_link: explorerTx(m.tx), grant_link: g.tx ? explorerTx(g.tx) : null, granted: g.skipped ? "already granted" : `${eur(START_GRANT)} ${TOKEN_SYMBOL}` };
}

// ------------------------------------------------------------------ collection
async function collection(account) {
  const evs = Object.fromEntries((await eventsNow()).map((e) => [e.id, e]));
  const hidden = (id) => HIDDEN_PREFIXES.some((h) => (evs[id]?.source_ref || metaOf(id)?.source_ref || "").startsWith(h));
  const cards = cardsOf(account).filter((c) => !hidden(c.event_id));
  const ids = [...new Set(cards.map((c) => c.event_id))];
  const holdings = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await view("pot", "viewHolding", { event_id: id, account }).catch(() => null)])));
  const claims = ledger().claims.filter((c) => c.account === account);
  const out = cards.map((c) => {
    const e = evs[c.event_id] || {}; const h = holdings[c.event_id];
    const paid = claims.filter((x) => x.event_id === c.event_id).reduce((s, x) => s + Number(x.amount), 0);
    const myWinning = h ? Number(h.cards[e.winner ?? 0] || 0) : 0;
    let state = e.status;
    if (e.status === "final") state = e.winner === c.outcome ? "won" : (e.cards_sold?.[e.winner] === 0 ? "refunded" : "lost");
    if (e.status === "cancelled") state = "refunded";
    const won_eur = state === "won" && myWinning ? eur(Math.floor((paid || Number(h?.claimable || 0)) / myWinning)) : state === "refunded" ? e.card_price_eur : null;
    return { ...c, title: e.title, category: e.category, outcome_label: e.outcomes?.[c.outcome], status: state, event_status: e.status, won_eur, paid_out: paid > 0, claimable_eur: h ? eur(h.claimable) : "0.00",
      dispute_until: e.proposal?.dispute_until || null, proposal_outcome: e.proposal ? e.outcomes[e.proposal.outcome] : null, art: `/art/${c.event_id}/${c.outcome}.svg?serial=${c.serial}`, link: explorerTx(c.tx) };
  });
  const by = (r) => out.filter((c) => c.rarity === r).length;
  return { account, cards: out.reverse(), stats: { total: out.length, legendary: by("legendary"), epic: by("epic"), rare: by("rare"), common: by("common"),
    won: out.filter((c) => c.status === "won").length, won_eur: eur(claims.reduce((s, x) => s + Number(x.amount), 0)) } };
}

// ------------------------------------------------------------------ routes
const routes = {
  "GET /api/config": async () => {
    const d = deployment(); const cfg = await view("pot", "viewConfig");
    return { network: "testnet", genesis_prefix: "4221332d34e1694168c2a0c0b3fd0f27",
      pot: { name: CONTRACTS.pot.name, index: d.pot.index, link: explorerContract(d.pot.index) },
      token: { name: CONTRACTS.token.name, index: d.token.index, link: explorerContract(d.token.index), symbol: TOKEN_SYMBOL, decimals: TOKEN_DECIMALS },
      registry: { index: "12802", link: explorerContract(12802) }, agents: agentInfo(), max_daily_eur: eur(cfg.max_daily_spend), dispute_window_min: Number(cfg.dispute_window_ms) / 60000,
      sponsor: SPONSOR, rules: { min_age: MIN_AGE, blocked_countries: BLOCKED_COUNTRIES }, fee: "none (0%); CCD network fees paid by the operator (sponsored transactions)",
      demo: DEMO, demo_people: DEMO ? people() : undefined, agent_wallet: agentInfo().buyer?.wallet, visitor_agents: VISITOR_AGENTS,
      public_url: PUBLIC_URL, store: storeInfo(), budget: budget() };
  },
  "GET /api/events": async (q) => {
    const all = await eventsNow();
    if (q.get("all") === "1") return { events: all.filter((e) => !HIDDEN_PREFIXES.some((h) => (e.source_ref || "").startsWith(h))) };
    return { ...eventsForPage(all), sources: ["ESPN public scoreboards", "Coinbase Exchange market data", "Open-Meteo"] };
  },
  "GET /api/event": async (q) => (await eventsNow()).find((e) => e.id === Number(q.get("id"))) || [404, { error: "unknown event" }],
  "GET /api/collection": async (q) => { const a = q.get("account"); if (!isAccount(a)) return [400, { error: "bad account" }]; return collection(a); },
  "GET /api/player": async (q) => {
    const a = q.get("account"); if (!isAccount(a)) return [400, { error: "bad account" }];
    const p = await view("pot", "viewPlayer", a);
    return { account: a, account_link: explorerAccount(a), tokens_eur: eur(await tokenBalance(a)), allowed_until: p.allowed_until?.Some?.[0] ?? null,
      daily_cap_eur: eur(p.daily_cap), spent_today_eur: eur(p.spent_today), extra_today_eur: eur(p.extra_today), left_today_eur: eur(p.left_today), paused_until: p.paused_until?.Some?.[0] ?? null };
  },
  "GET /api/agent": async () => {
    const a = agentInfo().buyer; if (!a) return { registered: false };
    const { readAgentOnChain } = await import("./lib/registry.mjs");
    const rec = await readAgentOnChain(a.token_id).catch((e) => ({ error: e.message }));
    const link = await view("pot", "viewAgent", a.wallet);
    const l = ledger();
    return { registered: true, token_id: a.token_id, owner: a.owner, wallet: a.wallet, wallet_eur: eur(await tokenBalance(a.wallet)), registry_record: rec,
      linked_in_pot: link?.Some?.[0] ?? null, card_url: `/agents/${a.token_id}.json`, approvals: approvals().slice(-10).reverse(),
      log: l.agent_log.filter((x) => x.agent === "buyer").slice(-30).reverse(), results_agent: agentInfo().results };
  },
  "GET /api/results": async () => ({ log: ledger().agent_log.filter((x) => (x.agent === "results" || x.agent === "feed") && !/Lagos/.test(x.text)).slice(-60).reverse(), results_agent: agentInfo().results }),
  "GET /api/schema": async (q) => { const w = q.get("which"); return { which: w, base64: (w === "registry" ? REGISTRY_SCHEMA : schema(w === "token" ? "token" : "pot")).toString("base64") }; },
  "GET /api/health": async () => ({ ok: true, store: { ...storeInfo(), memory: await memory() }, demo: DEMO, visitor_agents: VISITOR_AGENTS, agents: AGENTS, operator: watch(), results: resultsState(),
    feed: { created_last_24h: createdLast24h(), daily_max: DAILY_MAX }, prune: pruned }),
  // --- real wallet flow
  "POST /api/wallet/verify/start": async (_, b) => {
    if (!isAccount(b.account)) return [400, { error: "connect a wallet account first" }];
    reserve(1, "proof request anchor");
    const request = await createRequest(op);
    const id = randomUUID(); pending.set(id, { request, account: b.account, created: Date.now() });
    return { id, request: request.toJSON(), anchor_link: explorerTx(request.transactionRef.toString()) };
  },
  "POST /api/wallet/verify/finish": async (_, b) => {
    const p = pending.get(b.id); pending.delete(b.id);
    if (!p || Date.now() - p.created > VERIFY_TTL_MS) return [404, { ok: false, error: "unknown or expired verification, start again" }];
    return finishVerify(p.request, b.presentation, p.account);
  },
  "POST /api/wallet/buy": async (_, b) => {
    if (!isAccount(b.account)) return [400, { error: "bad account" }];
    const r = await prepareBuy(b.account, Number(b.event_id), Number(b.outcome), Number(b.count || 1));
    return r.ok ? { ...r, tx: toWalletJSON(r.tx), schema_for: "token" } : r;
  },
  "POST /api/wallet/pack": async (_, b) => {
    if (!isAccount(b.account)) return [400, { error: "bad account" }];
    const r = await preparePack(b.account);
    return r.ok ? { ...r, tx: toWalletJSON(await buildSponsored(op, b.account, "token", "transfer", r.json)), schema_for: "token" } : r;
  },
  "POST /api/wallet/claim": async (_, b) => {
    if (!isAccount(b.account)) return [400, { error: "bad account" }];
    const r = await prepareClaim(b.account, Number(b.event_id));
    return r.ok ? { ...r, tx: toWalletJSON(r.tx), schema_for: "pot" } : r;
  },
  "POST /api/wallet/call": async (_, b) => {
    // limits, approval and self-exclusion signed by the person in their own wallet (sponsored)
    if (!isAccount(b.account)) return [400, { error: "bad account" }];
    const allowed = { setLimits: (x) => ({ daily_cap: x.daily_cap_eur == null ? { None: [] } : { Some: [Math.round(Number(x.daily_cap_eur) * 1e6)] } }),
      approveExtra: (x) => Math.round(Number(x.amount_eur) * 1e6), pauseMe: (x) => Number(x.days) };
    if (!allowed[b.entrypoint]) return [400, { error: "not allowed" }];
    const json = allowed[b.entrypoint](b);
    const d = await dryRun("pot", b.account, b.entrypoint, json); if (!d.ok) return { ok: false, refused_with: d.error };
    reserve(1, b.entrypoint);
    return { ok: true, tx: toWalletJSON(await buildSponsored(op, b.account, "pot", b.entrypoint, json)), schema_for: "pot" };
  },
  "GET /api/tx": async (q) => {
    const { TransactionHash } = await import("@concordium/web-sdk");
    const h = q.get("hash"); if (!/^[0-9a-f]{64}$/.test(h || "")) return [400, { error: "bad hash" }];
    const s = await grpc().getBlockItemStatus(TransactionHash.fromHexString(h));
    const sum = s.outcome?.summary;
    const outcome = sum ? (sum.transactionType === "failed" || sum.rejectReason ? "rejected" : "success") : null;
    if (s.status === "finalized" && outcome === "success") await recordTx(h, sum, { via: "wallet" }).catch(() => {});
    if (s.status !== "finalized") watchTx(h);
    return { status: s.status, link: explorerTx(h), outcome };
  },
};

if (DEMO) {
  const who = (b) => { const w = String(b.who); if (!PEOPLE.includes(w)) throw new Error("unknown demo person"); return w; };
  routes["POST /api/demo/verify"] = async (_, b) => {
    const w = who(b); reserve(1, "demo proof anchor"); const request = await createRequest(op);
    const anchor_link = explorerTx(request.transactionRef.toString());
    let pres;
    try { pres = await prove(w, request); }
    catch (e) { return { ok: false, who: w, error: `The wallet could not prove ${MIN_AGE}+ and not resident in ${BLOCKED_COUNTRIES.join(", ")}`, detail: String(e.message || e), anchor_link }; }
    const r = await finishVerify(request, pres, load(w).acct.address);
    return Array.isArray(r) ? { ok: false, who: w, ...r[1], anchor_link } : { ...r, who: w, anchor_link };
  };
  routes["POST /api/demo/buy"] = async (_, b) => {
    const w = who(b); const u = load(w); const a = u.acct.address;
    return withSender(a, async () => {
      const r = await prepareBuy(a, Number(b.event_id), Number(b.outcome), Number(b.count || 1));
      if (!r.ok) return { ...r, who: w, paid: "nothing" };
      const s = await signAndSubmitSponsored(r.tx, userSigner(u), "token");
      if (s.outcome === "success") await recordTx(s.tx, s.summary, { via: "demo" });
      const card = s.outcome === "success" ? cardsOf(a).filter((c) => c.tx === s.tx) : [];
      return { ok: s.outcome === "success", who: w, paid_eur: r.amount_eur, sponsor_fee_ccd: s.sponsor_fee_ccd, player_fee_ccd: s.fee_ccd, tx_link: explorerTx(s.tx), refused_with: s.reject_reason?.decoded, cards: card };
    });
  };
  routes["POST /api/demo/pack"] = async (_, b) => {
    const w = who(b); const u = load(w); const a = u.acct.address;
    return withSender(a, async () => {
      const r = await preparePack(a);
      if (!r.ok) return { ...r, who: w, paid: "nothing" };
      const s = await signAndSubmitSponsored(await buildSponsored(op, a, "token", "transfer", r.json), userSigner(u), "token");
      if (s.outcome === "success") await recordTx(s.tx, s.summary, { via: "pack" });
      return { ok: s.outcome === "success", who: w, paid_eur: r.amount_eur, tx_link: explorerTx(s.tx), refused_with: s.reject_reason?.decoded, cards: cardsOf(a).filter((c) => c.tx === s.tx) };
    });
  };
  routes["POST /api/demo/claim"] = async (_, b) => {
    const w = who(b); const u = load(w);
    const r = await prepareClaim(u.acct.address, Number(b.event_id));
    if (!r.ok) return { ...r, who: w };
    const s = await signAndSubmitSponsored(r.tx, userSigner(u), "pot");
    if (s.outcome === "success") await recordTx(s.tx, s.summary, { via: "demo" });
    return { ok: s.outcome === "success", who: w, received_eur: r.amount_eur, sponsor_fee_ccd: s.sponsor_fee_ccd, tx_link: explorerTx(s.tx) };
  };
  // the person's own signed pot calls: daily cap, approval above the cap, pause me
  routes["POST /api/demo/call"] = async (_, b) => {
    const w = who(b); const u = load(w); const a = u.acct.address;
    const map = { setLimits: () => ({ daily_cap: b.daily_cap_eur == null ? { None: [] } : { Some: [Math.round(Number(b.daily_cap_eur) * 1e6)] } }),
      approveExtra: () => Math.round(Number(b.amount_eur) * 1e6), pauseMe: () => Number(b.days) };
    if (!map[b.entrypoint]) return [400, { error: "not allowed" }];
    const json = map[b.entrypoint]();
    const d = await dryRun("pot", a, b.entrypoint, json); if (!d.ok) return { ok: false, refused_with: d.error };
    reserve(1, "demo " + b.entrypoint);
    const s = await sponsoredCall(op, userSigner(u), a, "pot", b.entrypoint, json);
    if (b.entrypoint === "approveExtra" && b.approval_id) { const ap = approvals().find((x) => x.id === b.approval_id); if (ap) { ap.status = "approved"; ap.approved_tx = s.tx; saveLedger(); } }
    agentLog("owner", `${w[0].toUpperCase() + w.slice(1)} signed ${b.entrypoint} ${JSON.stringify(json)}`, { tx: s.tx, link: explorerTx(s.tx) });
    return { ok: s.outcome === "success", tx_link: explorerTx(s.tx), refused_with: s.reject_reason?.decoded };
  };
  // Amy tops up her agent's wallet from her own EUR-demo (Amy signs; sponsored)
  routes["POST /api/demo/agent/topup"] = async (_, b) => {
    const u = load("amy"); const a = u.acct.address; const amount = BigInt(Math.round(Number(b.amount_eur || 10) * 1e6)); reserve(1, "demo topup");
    const s = await sponsoredCall(op, userSigner(u), a, "token", "transfer", tokenTransferJSON(a, agentInfo().buyer.wallet, amount));
    agentLog("owner", `Amy moved €${eur(amount)} EUR-demo to her agent's wallet`, { tx: s.tx, link: explorerTx(s.tx) });
    return { ok: s.outcome === "success", tx_link: explorerTx(s.tx) };
  };
}
// Amy's buyer agent: the agent holds its own key (Amy's 2nd account); a demo button here just wakes it up.
routes["POST /api/agent/run"] = async (_, b) => {
  if (!DEMO) return [400, { error: "demo mode is off" }];
  const a = agentInfo().buyer; if (!a) return [400, { error: "agent not registered" }];
  const prefs = { categories: Array.isArray(b.categories) && b.categories.length ? b.categories : ["crypto", "weather", "football", "basketball", "hockey"], cards: Math.min(5, Number(b.cards || 3)) };
  reserve(prefs.cards, "demo agent run");
  return { actions: await runBuyerAgent(op, { owner: a.owner, agentWallet: a.wallet, agentKeyHex: agentKey(), agentId: a.token_id }, prefs) };
};
routes["POST /api/agent/retry"] = async (_, b) => {
  if (!DEMO) return [400, { error: "demo mode is off" }];
  const a = agentInfo().buyer; const ap = approvals().find((x) => x.id === b.approval_id); if (!ap) return [404, { error: "unknown approval" }];
  const e = { ...metaOf(ap.event_id), card_price: 2_000_000 };
  const r = await agentBuyOne(op, signerFromHex(agentKey()), { owner: a.owner, agentWallet: a.wallet, agentId: a.token_id }, e, ap.outcome, ap.count, ap.reason + " (after Amy's approval)");
  if (r.action === "bought") { ap.status = "used"; ap.used_tx = r.tx; saveLedger(); }
  return r;
};

// ------------------------------------------------------------------ wallet transactions the page reported: finish recording them even if the visitor leaves
const watching = new Map();
async function watchTx(h) {
  if (watching.has(h)) return; watching.set(h, Date.now());
  const { TransactionHash } = await import("@concordium/web-sdk");
  try {
    const out = await grpc().waitForTransactionFinalization(TransactionHash.fromHexString(h), 300_000);
    const sum = out.summary; if (!(sum.transactionType === "failed" || sum.rejectReason)) await recordTx(h, sum, { via: "wallet" }).catch(() => {});
  } catch {} finally { setTimeout(() => watching.delete(h), 600_000); }
}

// ------------------------------------------------------------------ visitors' own buyer agents (real wallet)
const agentRuns = new Set();
const allowedNow = async (a) => { const p = await view("pot", "viewPlayer", a); const u = p.allowed_until?.Some?.[0]; return u && Date.parse(u) > Date.now(); };
const regTx = async (account, built) => ({ ok: true, tx: toWalletJSON(await buildSponsoredRaw(op, account, REGISTRY, built.receive_name, built.parameter_hex)), schema_for: "registry" });
async function visitorAgentView(account) {
  const a = VA.agentOf(account);
  const p = await view("pot", "viewPlayer", account);
  const player = { daily_cap_eur: eur(p.daily_cap), spent_today_eur: eur(p.spent_today), extra_today_eur: eur(p.extra_today), left_today_eur: eur(p.left_today), paused_until: p.paused_until?.Some?.[0] ?? null, allowed_until: p.allowed_until?.Some?.[0] ?? null };
  if (!a) return { available: VISITOR_AGENTS, agent: null, player, pool_free: VISITOR_AGENTS ? VA.pool().length - Object.keys(VA.state()).length : 0 };
  const rec = a.token_id ? await readAgentOnChain(a.token_id).catch(() => null) : null;
  const link = await view("pot", "viewAgent", a.wallet).catch(() => null);
  const l = ledger();
  return { available: true, player, agent: { ...a, registry_record: rec, linked_in_pot: link?.Some?.[0] ?? null, wallet_eur: eur(await tokenBalance(a.wallet)), card_url: `/agents/owner/${account}.json`,
    registry_link: a.token_id ? `https://ccdexplorer.io/testnet/smart-contract/12802/0` : null },
    approvals: approvals().filter((x) => x.owner === account).slice(-10).reverse(), log: l.agent_log.filter((x) => x.agent === "buyer" && x.owner === account).slice(-30).reverse() };
}
Object.assign(routes, {
  "GET /api/wallet/agent": async (q) => { const a = q.get("account"); if (!isAccount(a)) return [400, { error: "bad account" }]; return visitorAgentView(a); },
  // step 1: register an agent under the visitor's own account (the visitor signs in their wallet; fee sponsored)
  "POST /api/wallet/agent/register": async (_, b) => {
    if (!VISITOR_AGENTS) return { ok: false, refused_with: "agents are not available on this server" };
    if (!(await allowedNow(b.account))) return { ok: false, refused_with: "NotVerified: verify 18+ first" };
    const a = VA.assign(b.account, [agentInfo().buyer?.wallet].filter(Boolean)); if (!a) return { ok: false, refused_with: "all agent wallets are taken right now" };
    if (a.token_id) return { ok: false, refused_with: "you already have an agent", agent: a };
    reserve(1, "agent register");
    return regTx(b.account, await VA.buildRegister(b.account, PUBLIC_URL));
  },
  "POST /api/wallet/agent/registered": async (_, b) => {
    const a = VA.agentOf(b.account); if (!a) return [400, { error: "start again" }];
    const { TransactionHash } = await import("@concordium/web-sdk");
    const out = await grpc().waitForTransactionFinalization(TransactionHash.fromHexString(String(b.hash)), 180_000);
    const t = await VA.tokenFromRegister(out.summary, b.account);
    if (!t) return { ok: false, refused_with: "no agent registered to your account in that transaction" };
    VA.patch(b.account, { token_id: t.id, register_tx: String(b.hash), step: "registered" });
    agentLog("owner", `A visitor ${b.account.slice(0, 6)}… registered buyer agent #${t.id} in the Agent Registry`, { tx: String(b.hash), link: explorerTx(String(b.hash)), owner: b.account });
    return { ok: true, token_id: t.id };
  },
  // step 2: bind the agent's wallet (the pool wallet signed the registry's message here; the visitor signs the transaction)
  "POST /api/wallet/agent/wallet": async (_, b) => {
    const a = VA.agentOf(b.account); if (!a?.token_id) return { ok: false, refused_with: "register the agent first" };
    reserve(1, "agent wallet");
    return regTx(b.account, await VA.buildSetWallet(b.account, a.token_id, a.wallet, a.cred));
  },
  // step 3: link the agent in the prize pot (the pot reads the registry on chain and refuses if anything does not match)
  "POST /api/wallet/agent/link": async (_, b) => {
    const a = VA.agentOf(b.account); if (!a?.token_id) return { ok: false, refused_with: "register the agent first" };
    const d = await dryRun("pot", b.account, "linkAgent", Number(a.token_id)); if (!d.ok) return { ok: false, refused_with: d.error };
    reserve(1, "agent link");
    return { ok: true, tx: toWalletJSON(await buildSponsored(op, b.account, "pot", "linkAgent", Number(a.token_id))), schema_for: "pot" };
  },
  "POST /api/wallet/agent/step": async (_, b) => { const a = VA.agentOf(b.account); if (!a) return [400, { error: "no agent" }]; VA.patch(b.account, { step: String(b.step).slice(0, 20), [`${String(b.step).slice(0, 20)}_tx`]: String(b.hash || "").slice(0, 64) }); return { ok: true }; },
  "POST /api/wallet/agent/topup": async (_, b) => {
    const a = VA.agentOf(b.account); if (!a?.token_id) return { ok: false, refused_with: "register the agent first" };
    const amount = BigInt(Math.round(Math.min(20, Math.max(1, Number(b.amount_eur || 6))) * 1e6));
    if ((await tokenBalance(b.account)) < amount) return { ok: false, refused_with: `not enough ${TOKEN_SYMBOL}` };
    reserve(1, "agent topup");
    return { ok: true, tx: toWalletJSON(await buildSponsored(op, b.account, "token", "transfer", tokenTransferJSON(b.account, a.wallet, amount))), schema_for: "token" };
  },
  "POST /api/wallet/agent/run": async (_, b) => {
    const a = VA.agentOf(b.account); if (!a?.token_id) return { ok: false, refused_with: "register the agent first" };
    const prefs = { categories: Array.isArray(b.categories) && b.categories.length ? b.categories.map(String).slice(0, 8) : ["crypto", "weather", "football", "basketball", "hockey"], cards: Math.min(3, Number(b.cards || 3)) };
    reserve(prefs.cards, "visitor agent run");
    // one run at a time per agent (the sponsored calls inside are already serialized per wallet)
    if (agentRuns.has(a.wallet)) return { ok: false, refused_with: "your agent is already running" };
    agentRuns.add(a.wallet);
    try { return { actions: await runBuyerAgent(op, { owner: b.account, ownerName: "you", agentWallet: a.wallet, agentKeyHex: VA.poolKey(a.cred), agentId: a.token_id }, prefs) }; }
    finally { agentRuns.delete(a.wallet); }
  },
  "POST /api/wallet/agent/retry": async (_, b) => {
    const a = VA.agentOf(b.account); const ap = approvals().find((x) => x.id === b.approval_id && x.owner === b.account); if (!a || !ap) return [404, { error: "unknown approval" }];
    reserve(1, "visitor agent retry");
    const r = await agentBuyOne(op, signerFromHex(VA.poolKey(a.cred)), { owner: b.account, ownerName: "you", agentWallet: a.wallet, agentId: a.token_id }, { ...metaOf(ap.event_id), card_price: 2_000_000 }, ap.outcome, ap.count, ap.reason + " (after your approval)");
    if (r.action === "bought") { ap.status = "used"; ap.used_tx = r.tx; saveLedger(); }
    return r;
  },
});

// ------------------------------------------------------------------ operator balance and burn watchdog
// Testnet CCD is limited. Below STOP_FEED the feed agent creates nothing; below STOP_ALL the agents' own timers stop
// spending entirely (visitor actions still go through the hourly sponsor cap). Warnings go to the log and the results desk.
const WD = { warn: Number(process.env.EVENTSCOPE_WARN_CCD || 2000), stopFeed: Number(process.env.EVENTSCOPE_STOP_FEED_CCD || 1000), stopAll: Number(process.env.EVENTSCOPE_STOP_ALL_CCD || 300),
  balance: null, at: null, samples: [], level: "unknown" };
const UNTIL = Date.parse(process.env.EVENTSCOPE_RUN_UNTIL || "2026-12-11T23:59:59Z");
function watch() {
  let spent = 0; for (let i = 1; i < WD.samples.length; i++) spent += Math.max(0, WD.samples[i - 1].b - WD.samples[i].b);
  const span = WD.samples.length > 1 ? (WD.samples.at(-1).t - WD.samples[0].t) / 86400_000 : 0;
  const perDay = span >= 1 / 24 ? spent / span : null; const daysToEnd = Math.max(0, (UNTIL - Date.now()) / 86400_000);
  return { account: OPERATOR, balance_ccd: WD.balance, read_at: WD.at, level: WD.level, thresholds: { warn: WD.warn, stop_feed: WD.stopFeed, stop_all: WD.stopAll },
    burn_ccd_per_day: perDay === null ? null : Math.round(perDay), measured_over_hours: +(span * 24).toFixed(1),
    days_to_run_until: +daysToEnd.toFixed(1), run_until: new Date(UNTIL).toISOString(), projected_spend_ccd: perDay === null ? null : Math.round(perDay * daysToEnd),
    days_left_at_this_burn: perDay ? Math.round(WD.balance / perDay) : null, feed_running: allowFeed(), agents_spending: allowAgents() };
}
const allowFeed = () => WD.balance === null || WD.balance > WD.stopFeed;
const allowAgents = () => WD.balance === null || WD.balance > WD.stopAll;
async function watchdog() {
  try {
    const b = Number(await balance(OPERATOR)) / 1e6; const t = Date.now();
    WD.balance = +b.toFixed(2); WD.at = new Date(t).toISOString(); WD.samples.push({ t, b }); WD.samples = WD.samples.filter((x) => x.t > t - 26 * 3600_000);
    const level = b <= WD.stopAll ? "stop_all" : b <= WD.stopFeed ? "stop_feed" : b <= WD.warn ? "warn" : "ok";
    if (level !== WD.level) {
      const msg = { ok: `Operator balance ${b.toFixed(0)} CCD: all agents running.`, warn: `Warning: operator balance ${b.toFixed(0)} CCD is below ${WD.warn}. Refill soon.`,
        stop_feed: `Operator balance ${b.toFixed(0)} CCD is below ${WD.stopFeed}: the feed stopped creating events to save fees.`, stop_all: `Operator balance ${b.toFixed(0)} CCD is below ${WD.stopAll}: agents stopped spending.` }[level];
      if (WD.level !== "unknown" || level !== "ok") agentLog("feed", msg); else console.log("[watchdog]", msg);
      WD.level = level;
    }
    const w = watch(); if (w.burn_ccd_per_day !== null) console.log(`[watchdog] balance ${WD.balance} CCD, burn ~${w.burn_ccd_per_day} CCD/day over ${w.measured_over_hours} h`);
  } catch (e) { console.error("[watchdog]", e.message); }
}

// ------------------------------------------------------------------ store hygiene (Key Value free plan is 25 MB)
let pruned = null;
async function pruneStore() {
  const l = ledger(); const keep = new Set();
  for (const m of Object.values(l.events)) if (m.result?.evidence_sha256) keep.add(m.result.evidence_sha256);
  for (const r of l.results) if (r.evidence_hash) keep.add(r.evidence_hash);
  for (const t of Object.values(l.txs)) if (t.evidence_sha256) keep.add(t.evidence_sha256);
  try { pruned = { at: new Date().toISOString(), ...(await pruneEvidence(keep)), memory_after: await memory() }; console.log("[store] prune", JSON.stringify(pruned)); }
  catch (e) { pruned = { error: e.message }; console.error("[store] prune", e.message); }
  saveLedger();
}

// ------------------------------------------------------------------ agents on timers
let busy = { feed: false, results: false };
async function tick(kind, fn) { if (busy[kind]) return; busy[kind] = true; try { await fn(); } catch (e) { console.error(kind, e.message); } finally { busy[kind] = false; } }
setTimeout(pruneStore, 3_000);
if (AGENTS) {
  setTimeout(watchdog, 2_000); setInterval(watchdog, 10 * 60_000);
  setInterval(() => tick("results", () => runResults(op, { allowSpend: allowAgents })), 60_000);
  setInterval(() => { if (allowFeed()) tick("feed", () => syncFeed(op, { allowSpend: allowFeed })); }, 30 * 60_000);
  setTimeout(() => tick("results", () => runResults(op, { allowSpend: allowAgents })), 20_000);
  setTimeout(() => { if (allowFeed()) tick("feed", () => syncFeed(op, { allowSpend: allowFeed })); }, 90_000);
  setTimeout(fixLocalAgentUris, 45_000);
}
setTimeout(kickRefresh, 5_000);

// Visitor agents registered from the box before go-live point at http://127.0.0.1. For owners whose demo key the
// server holds (Amy), point them at PUBLIC_URL once (one setAgentURI each). Others re-register from the page.
async function fixLocalAgentUris() {
  if (!PUBLIC_URL.startsWith("https://") || !HAVE_DEMO_KEYS) return;
  const owners = {}; for (const w of PEOPLE) { try { owners[load(w).acct.address] = w; } catch {} }
  for (const [owner, a] of Object.entries(VA.state())) {
    if (!a?.token_id || !owners[owner]) continue;
    try {
      const rec = await readAgentOnChain(a.token_id);
      if (!rec?.agent_uri?.startsWith("http://127.0.0.1") || rec.owner !== owner) continue;
      if (!allowAgents()) return;
      const { mcp, sendRegistryTx } = await import("./lib/registry.mjs");
      const args = { token_id: String(a.token_id), agent_uri: `${PUBLIC_URL}/agents/owner/${owner}.json`, sender: owner };
      if (rec.metadata_hash_hex) args.metadata_hash_hex = rec.metadata_hash_hex;
      const t = await sendRegistryTx(keyHex(load(owners[owner]), 0), owner, await mcp("build_set_agent_uri", args));
      agentLog("owner", `Agent #${a.token_id} card URL moved to the live site (${t.outcome}).`, { tx: t.tx, link: explorerTx(t.tx), owner });
    } catch (e) { console.error("[agents] uri fix", a.token_id, e.message); }
  }
}
// Render's free plan sleeps a web service after 15 minutes without inbound requests, which would also stop the feed and
// results timers. EVENTSCOPE_KEEPALIVE=1 pings the public URL every 10 minutes (counts against the plan's free hours).
if (process.env.EVENTSCOPE_KEEPALIVE === "1" && PUBLIC_URL.startsWith("https://")) setInterval(() => fetch(`${PUBLIC_URL}/api/health`).catch(() => {}), 10 * 60_000);

// ------------------------------------------------------------------ static
const WEB = path.join(ROOT, "web");
// CIS-2 token metadata the wallets fetch (Concordium Wallet for Web fetches it with mode "cors", so CORS must be open).
const TOKEN_METADATA = { name: "EUR-demo", symbol: TOKEN_SYMBOL, decimals: TOKEN_DECIMALS, unique: false,
  description: "EventScope play-money euro on Concordium testnet. Not real money, not redeemable.",
  thumbnail: { url: `${PUBLIC_URL}/img/eur-demo-256.png` }, display: { url: `${PUBLIC_URL}/img/eur-demo-1024.png` } };
const TOKEN_METADATA_URL = `${PUBLIC_URL}/eur-demo.json`;
// The token contract (13069,0) was created on the box with metadata at 127.0.0.1, which no wallet can reach. On the public
// host, the operator (token admin) points it at PUBLIC_URL once via the contract's setMetadataUrl (admin-only).
const tokenMeta = { token_id: "", metadata_url: null, fixed_tx: null, error: null };
async function ensureTokenMetadataUrl() {
  try {
    const r = await view("token", "tokenMetadata", [""]);
    tokenMeta.metadata_url = r?.[0]?.url ?? null;
    if (!PUBLIC_URL.startsWith("https://") || tokenMeta.metadata_url === TOKEN_METADATA_URL) return;
    reserve(1, "token metadata url");
    const t = await update(op, OPERATOR, "token", "setMetadataUrl", TOKEN_METADATA_URL);
    tokenMeta.fixed_tx = t.tx; tokenMeta.fixed_outcome = t.outcome; tokenMeta.fixed_link = explorerTx(t.tx);
    if (t.outcome === "success") tokenMeta.metadata_url = TOKEN_METADATA_URL; else tokenMeta.error = JSON.stringify(t.reject_reason ?? t);
    console.log("token metadata url ->", TOKEN_METADATA_URL, t.outcome, t.tx);
  } catch (e) { tokenMeta.error = String(e.message || e); console.error("token metadata url", tokenMeta.error); }
}
if (AGENTS) setTimeout(ensureTokenMetadataUrl, 15_000);
routes["GET /api/token"] = async () => ({ contract: { index: Number(address("token").index), subindex: 0 }, ...tokenMeta, expected_url: TOKEN_METADATA_URL, metadata: TOKEN_METADATA });
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/eur-demo.json") { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(TOKEN_METADATA)); return; }
    let m;
    if ((m = u.pathname.match(/^\/art\/(\d+)\/(\d+)\.svg$/))) {
      const serial = u.searchParams.get("serial"); const svg = await artFor(Number(m[1]), Number(m[2]), serial ? { serial: Number(serial), rarity: rarity(Number(serial)) } : { minted: u.searchParams.get("minted") });
      if (!svg) return send(res, 404, { error: "unknown event" });
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=60" }); res.end(svg); return;
    }
    if (u.pathname === "/art/pack.svg") { res.writeHead(200, { "content-type": "image/svg+xml" }); res.end(packSvg()); return; }
    if ((m = u.pathname.match(/^\/agents\/owner\/([1-9A-HJ-NP-Za-km-z]{50})\.json$/))) { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(VA.card(m[1], VA.agentOf(m[1]), PUBLIC_URL), null, 1)); return; }
    if ((m = u.pathname.match(/^\/agents\/(\d+)\.json$/)) && existsSync(path.join(ROOT, "agents", `${m[1]}.json`))) { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(readFileSync(path.join(ROOT, "agents", `${m[1]}.json`))); return; }
    if ((m = u.pathname.match(/^\/evidence\/([0-9a-f]{64})\.json$/)) && existsSync(path.join(ROOT, ".run", "evidence", `${m[1]}.json`))) { res.writeHead(200, { "content-type": "application/json" }); res.end(readFileSync(path.join(ROOT, ".run", "evidence", `${m[1]}.json`))); return; }
    const h = routes[`${req.method} ${u.pathname}`];
    if (h) {
      const b = req.method === "POST" ? await body(req) : null;
      const ip = clientIp(req); const acct = b?.account || u.searchParams.get("account") || null;
      const p = u.pathname;
      const kind = req.method === "GET" ? "read" : p.startsWith("/api/demo/") ? "demo" : p.startsWith("/api/wallet/verify/start") ? "verify" : p === "/api/wallet/agent/run" ? "agentRun" : p.startsWith("/api/wallet/") || p.startsWith("/api/agent/") ? "prepare" : null;
      const lim = kind && limited(kind, ip, acct);
      if (lim) return send(res, 429, { ok: false, error: lim, refused_with: lim });
      if (b && "account" in b && !isAccount(b.account)) return send(res, 400, { ok: false, error: "connect a wallet account first" });
      let out;
      try { out = await h(u.searchParams, b); }
      catch (e) { if (e.busy) return send(res, 503, { ok: false, busy: true, error: e.message, refused_with: e.message }); throw e; } Array.isArray(out) ? send(res, out[0], out[1]) : send(res, 200, out); return;
    }
  } catch (e) { console.error(e); send(res, 500, { ok: false, error: String(e.message || e) }); return; }
  const f = path.join(WEB, u.pathname === "/" ? "index.html" : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ""));
  if (f.startsWith(WEB) && existsSync(f) && !f.endsWith("/")) {
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(f)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, ...(u.pathname.startsWith("/img/") ? { "access-control-allow-origin": "*", "cache-control": "max-age=86400" } : {}) }); res.end(readFileSync(f)); return;
  }
  send(res, 404, { error: "not found" });
}).listen(PORT, HOST, () => console.log(`EventScope on http://${HOST}:${PORT} (demo people ${DEMO ? "on" : "off"}, agents ${AGENTS ? "on" : "off"})`));
