// Watches events until the results agent has posted, finalized and paid them (the tail of the Step 4 e2e, rerunnable).
//   node scripts/watch4.mjs 0,1,2 [--wait-minutes 40]   Writes .run/watch4-<time>.json.
import { writeFileSync } from "node:fs";
const B = process.env.EVENTSCOPE_URL || "http://127.0.0.1:8100";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p) => { for (let i = 0; ; i++) { try { return await (await fetch(B + p)).json(); } catch (e) { if (i > 30) throw e; await sleep(5000); } } };
const args = process.argv.slice(2); const ids = args[0].split(",").map(Number);
const waitMin = Number(args[args.indexOf("--wait-minutes") + 1] || 0) || 40;
const out = { started: new Date().toISOString(), steps: [] }; const f = `.run/watch4-${out.started.replace(/[:.]/g, "")}.json`;
const step = (name, data) => { out.steps.push({ name, at: new Date().toISOString(), ...data }); console.log(name, JSON.stringify(data)); writeFileSync(f, JSON.stringify(out, null, 1)); };
const last = {}; const deadline = Date.now() + waitMin * 60_000;
while (Date.now() < deadline) {
  let doneAll = true;
  for (const id of ids) {
    const e = await api(`/api/event?id=${id}`); const s = `${e.status}${e.proposal ? " proposed" : ""}${e.paid_out_tx ? " paid" : ""}`;
    if (s !== last[id]) { step(`event_${id}`, { title: e.title, status: e.status, proposal: e.proposal, result: e.result, paid_out_tx: e.paid_out_tx }); last[id] = s; }
    if (!(["final", "cancelled"].includes(e.status) && e.paid_out_tx)) doneAll = false;
  }
  if (doneAll) break;
  await sleep(20_000);
}
const cfg = await api("/api/config"); const P = cfg.demo_people;
for (const w of ["amy", "cal"]) step(`${w}_collection`, { stats: (await api(`/api/collection?account=${P[w]}`)).stats });
step("results_log", { log: (await api("/api/results")).log.slice(0, 20) });
step("done", {}); process.exit(0);
