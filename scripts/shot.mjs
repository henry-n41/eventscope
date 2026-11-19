// STEP 3 ONLY: written for the step 3 pot (13070), which had a hand-typed `resolve`. The step 4 pot (13076) removed it;
// results now come only from the results agent. Use scripts/e2e4.mjs, scripts/watch4.mjs and scripts/shots4.mjs instead.
// Screenshot of the page (demo people), event from argv. Server must be running.
import { chromium } from "playwright-core";
const EVENT = process.argv[2] || "3", OUT = process.argv[3] || "/workspace/eventscope/.run/page.png";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1100, height: 950 } });
await p.goto(`http://127.0.0.1:8100/?event=${EVENT}`, { waitUntil: "networkidle" });
await p.waitForSelector("text=Arsenal win");
const act = async (sel) => { const n = await p.$$eval("#log div", (d) => d.length); await p.click(sel); await p.waitForFunction((n) => document.querySelectorAll("#log div").length > n, n, { timeout: 240000 }); };
if (!process.argv[4]) {
  await p.selectOption("#who", "ben"); await act("#buy");
  await p.selectOption("#who", "cal"); await p.click(".opt[data-i='0']"); await act("#buy");
}
await p.selectOption("#who", "amy"); await p.waitForTimeout(2500);
await p.screenshot({ path: OUT, fullPage: true }); await b.close();
