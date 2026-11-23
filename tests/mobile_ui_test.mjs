// Headless check of the phone-wallet (WalletConnect) path and the small-screen layout.
// Serves the LOCAL web/ files over the live origin (APIs still go to the live server), so the WalletConnect relay
// sees the real origin. Nothing is signed: we only open the pairing modal. Usage: node tests/mobile_ui_test.mjs [shotsDir]
import { chromium, devices } from "playwright-core";
import { readFileSync } from "node:fs";
const BASE = process.env.EVENTSCOPE_URL || "https://eventscope-lwpm.onrender.com";
const LOCAL = process.env.LOCAL !== "0";
const out = process.argv[2] || "/workspace/eventscope-shots";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const results = [];
async function run(name, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  page.on("websocket", (ws) => { logs.push(`[ws] ${ws.url().replace(/projectId=[^&]+/, "projectId=…")}`); ws.on("close", () => logs.push("[ws closed]")); });
  if (LOCAL) for (const f of ["index.html", "app.js", "wc.js"]) {
    await page.route(f === "index.html" ? (u) => u.pathname === "/" || u.pathname === "/index.html" : `**/${f}*`, (r) =>
      r.fulfill({ body: readFileSync(`web/${f}`), contentType: f.endsWith("html") ? "text/html" : "text/javascript" }));
  }
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".drop", { state: "attached", timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${name}-1-home.png`, fullPage: false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.click("#connect");
  await page.waitForSelector("#wmodal:not(.hide)", { timeout: 8000 });
  const extShown = await page.isVisible("#wm-ext");
  await page.screenshot({ path: `${out}/${name}-2-chooser.png` });
  await page.click("#wm-phone");
  let wcModal = false, uri = null;
  try {
    await page.waitForSelector("wcm-modal", { state: "attached", timeout: 30000 });
    await page.waitForTimeout(6000);
    wcModal = true;
    uri = await page.evaluate(() => { const k = Object.keys(localStorage).find((x) => x.includes("pairing")); return k ? localStorage.getItem(k).slice(0, 200) : null; });
  } catch {}
  await page.screenshot({ path: `${out}/${name}-3-walletconnect.png` });
  results.push({ name, overflow_px: overflow, extension_option_visible: extShown, walletconnect_modal: wcModal, pairing_stored: !!uri,
    relay_errors: logs.filter((l) => /error|unauthor|origin|3000|denied/i.test(l)).slice(0, 8), ws: logs.filter((l) => l.startsWith("[ws")).slice(0, 4) });
  await ctx.close();
}
import { mkdirSync } from "node:fs"; mkdirSync(out, { recursive: true });
await run("desktop", { viewport: { width: 1366, height: 860 } });
await run("iphone", { ...devices["iPhone 13"] });
await run("android", { ...devices["Pixel 7"] });
console.log(JSON.stringify(results, null, 1));
await browser.close();
