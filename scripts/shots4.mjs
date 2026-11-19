// Screenshots of the step-4 page (server must be running): live drops, collection, agent, results desk, pack reveal.
//   node scripts/shots4.mjs [prefix]
import { chromium } from "playwright-core";
const pre = process.argv[2] || "/workspace/eventscope/.run/shot4";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1360, height: 1000 }, deviceScaleFactor: 1 });
const go = async (tab, who = "amy", wait = "body") => { await p.goto(`http://127.0.0.1:8100/?tab=${tab}&who=${who}`, { waitUntil: "load", timeout: 120000 }); await p.waitForSelector(wait, { timeout: 120000 }); await p.waitForTimeout(6000); };
await go("live", "amy", ".drop"); await p.screenshot({ path: `${pre}-live.png` });
await p.click('#cats button[data-c="crypto"]').catch(() => {}); await p.waitForTimeout(2500); await p.screenshot({ path: `${pre}-live-crypto.png` });
await go("coll", "amy", "#stats .stat"); await p.screenshot({ path: `${pre}-collection-amy.png`, fullPage: true });
await go("coll", "cal", "#stats .stat"); await p.screenshot({ path: `${pre}-collection-cal.png`, fullPage: true });
await go("agent", "amy", "#agentcard .kv"); await p.screenshot({ path: `${pre}-agent.png`, fullPage: true });
await go("results", "amy", "#resultlist"); await p.screenshot({ path: `${pre}-results.png`, fullPage: true });
await b.close(); console.log("ok", pre); process.exit(0);
