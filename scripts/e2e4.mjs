// Step 4 end to end on testnet, driven through the running server (so one process owns the ledger and the operator nonce):
// live feed events -> Amy and Cal verify (ZK), Ben refused -> Amy sets a EUR 10 daily cap, tops up her agent -> Cal and Amy
// collect cards and Amy opens a pack -> Amy's agent buys, hits the cap, Amy approves, agent buys -> Cal pauses himself and is
// refused -> results agent posts results with evidence, dispute window, finalize, automatic payout. Writes .run/e2e4-<time>.json.
//   node scripts/e2e4.mjs [--skip-setup] [--wait-minutes 30]
import { writeFileSync } from "node:fs";
const B = process.env.EVENTSCOPE_URL || "http://127.0.0.1:8100";
const api = async (p, b) => { const r = await fetch(B + p, b ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) } : {}); return r.json(); };
const args = process.argv.slice(2); const skip = args.includes("--skip-setup");
const waitMin = Number(args[args.indexOf("--wait-minutes") + 1] || 0) || 30;
const out = { started: new Date().toISOString(), steps: [] };
const step = (name, data) => { out.steps.push({ name, at: new Date().toISOString(), ...data }); console.log(name, JSON.stringify(data)); writeFileSync(`.run/e2e4-${out.started.replace(/[:.]/g, "")}.json`, JSON.stringify(out, null, 1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = await api("/api/config");
const P = cfg.demo_people;
let evs = (await api("/api/events")).events;
step("feed", { events: evs.length, by_category: evs.reduce((a, e) => ((a[e.category] = (a[e.category] || 0) + 1), a), {}), by_status: evs.reduce((a, e) => ((a[e.status] = (a[e.status] || 0) + 1), a), {}) });
const live = () => evs.filter((e) => e.status === "live" && Date.parse(e.closes_at) > Date.now() + 3 * 60_000);
const soonest = (c) => live().filter((e) => e.category === c).sort((a, b) => Date.parse(a.closes_at) - Date.parse(b.closes_at))[0];

if (!skip) {
  for (const w of ["amy", "cal", "ben"]) { const r = await api("/api/demo/verify", { who: w }); step(`verify_${w}`, { ok: r.ok, error: r.error, request: r.anchor_link, allow: r.allow_link, granted: r.granted }); }
  step("amy_sets_cap_10", await api("/api/demo/call", { who: "amy", entrypoint: "setLimits", daily_cap_eur: 10 }));
  step("amy_tops_up_agent_10", await api("/api/demo/agent/topup", { amount_eur: 10 }));
}
// Cal and Amy collect on the events that settle first (crypto), plus a football card
const c1 = soonest("crypto"), w1 = soonest("weather"), f1 = soonest("football");
step("cal_collects_crypto", { event: c1?.title, ...(await api("/api/demo/buy", { who: "cal", event_id: c1.id, outcome: 0, count: 1 })) });
step("cal_collects_crypto_other_side", { event: c1?.title, ...(await api("/api/demo/buy", { who: "cal", event_id: c1.id, outcome: 1, count: 1 })) });
step("amy_collects_crypto", { event: c1?.title, ...(await api("/api/demo/buy", { who: "amy", event_id: c1.id, outcome: 0, count: 1 })) });
if (f1) step("cal_collects_football", { event: f1.title, ...(await api("/api/demo/buy", { who: "cal", event_id: f1.id, outcome: 0, count: 1 })) });
step("ben_tries_to_collect", { event: c1?.title, ...(await api("/api/demo/buy", { who: "ben", event_id: c1.id, outcome: 0, count: 1 })) });
step("amy_opens_pack", await api("/api/demo/pack", { who: "amy" }));
// Amy's agent: spends what is left of the cap, then asks
const run = await api("/api/agent/run", { categories: ["crypto", "weather", "football", "basketball", "hockey"], cards: 3 });
step("agent_run", run);
const ask = (run.actions || []).find((a) => a.action === "needs_approval");
if (ask) {
  step("amy_approves_extra", await api("/api/demo/call", { who: "amy", entrypoint: "approveExtra", amount_eur: 2, approval_id: ask.approval_id }));
  step("agent_retries_after_approval", await api("/api/agent/retry", { approval_id: ask.approval_id }));
}
step("amy_player_after", await api(`/api/player?account=${P.amy}`));
// Cal pauses himself (1 day) and is refused at once
step("cal_pause_me_1_day", await api("/api/demo/call", { who: "cal", entrypoint: "pauseMe", days: 1 }));
evs = (await api("/api/events")).events;
const anyLive = live()[0];
step("cal_tries_while_paused", { event: anyLive?.title, ...(await api("/api/demo/buy", { who: "cal", event_id: anyLive.id, outcome: 0, count: 1 })) });
// Results agent: wait for c1 to be posted, disputed-window, final and paid
const deadline = Date.now() + waitMin * 60_000; let last = "";
while (Date.now() < deadline) {
  const e = (await api(`/api/event?id=${c1.id}`));
  const s = `${e.status}${e.paid_out_tx ? " paid" : ""}`;
  if (s !== last) { step("watch_" + c1.id, { status: e.status, proposal: e.proposal, result: e.result, paid_out_tx: e.paid_out_tx }); last = s; }
  if (e.status === "final" && e.paid_out_tx) break;
  await sleep(20_000);
}
step("amy_collection", { stats: (await api(`/api/collection?account=${P.amy}`)).stats });
step("cal_collection", { stats: (await api(`/api/collection?account=${P.cal}`)).stats });
step("results_log", { log: (await api("/api/results")).log.slice(0, 15) });
out.finished = new Date().toISOString();
step("done", {});
process.exit(0);
