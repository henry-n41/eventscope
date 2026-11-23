// Regression check that the browser-extension path is unchanged after adding the phone wallet: a stand-in
// window.concordium (the shape Concordium Wallet for Web injects) connects directly (no chooser modal) and approves one
// sponsored Collect. Signing uses the demo person's test key in Node and submits via the wallet-proxy (the box has no gRPC).
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { Transaction, AccountTransactionV1 } from "@concordium/web-sdk/transactions";
import { load, signer } from "../lib/testusers.mjs";
const BASE = process.env.EVENTSCOPE_URL || "https://eventscope-lwpm.onrender.com";
const LOCAL = process.env.LOCAL !== "0";
const u = load(process.env.WHO || "amy"); const ACCOUNT = u.acct.address;
const rep = {};
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await (await b.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
await page.exposeFunction("__submit", async (txStr, acct) => {
  rep.sponsored_account_arg_type = typeof acct;
  const tx = Transaction.signableFromJSON(JSON.parse(txStr));
  const unsigned = Transaction.preFinalized(tx);
  const sender = await AccountTransactionV1.createSignature(unsigned, signer(u));
  const raw = AccountTransactionV1.serializeBlockItem(AccountTransactionV1.create(unsigned, { sender, sponsor: tx.signatures.sponsor }));
  const r = await fetch("https://wallet-proxy.testnet.concordium.com/v0/submitRawTransaction", { method: "PUT", body: raw });
  const j = await r.json(); rep.submit = j; return j.submissionId;
});
await page.addInitScript((account) => {
  window.concordium = {
    requestAccounts: async () => [account], getMostRecentlySelectedAccount: async () => account,
    getSelectedChain: async () => "4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796",
    on: () => {}, addCIS2Tokens: async () => [],
    sendSponsoredTransaction: async (acct, tx) => { if (typeof acct !== "string") throw new Error("Site is not whitelisted"); return window.__submit(window.__EventScopeSdk.Transaction.toJSONString(tx), acct); },
  };
  window.dispatchEvent(new Event("concordium#initialized"));
}, ACCOUNT);
if (LOCAL) for (const f of ["index.html", "app.js", "wc.js"]) await page.route(f === "index.html" ? (x) => x.pathname === "/" : `**/${f}*`, (r) => r.fulfill({ body: readFileSync(`web/${f}`), contentType: f.endsWith("html") ? "text/html" : "text/javascript" }));
let wcLoaded = false; page.on("request", (r) => { if (r.url().includes("/wc.js")) wcLoaded = true; });
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".drop", { state: "attached", timeout: 60000 });
await page.click("#connect");
await page.waitForFunction(() => !document.getElementById("acctchip").classList.contains("hide"), null, { timeout: 20000 });
rep.chooser_opened = await page.isVisible("#wmodal");
rep.chip = await page.textContent("#acctchip");
await page.waitForTimeout(1500);
rep.addtok_visible = await page.isVisible("#addtok");
if (process.env.BUY !== "0") {
  await page.locator(".pick .btn:not([disabled])").first().click();
  await page.waitForFunction(() => [...document.querySelectorAll("#toast div")].some((d) => /^Card |Refused|whitelist|failed/i.test(d.textContent)), null, { timeout: 240000 }).catch(() => {});
  rep.toasts = await page.$$eval("#toast div", (ds) => ds.map((d) => d.textContent.slice(0, 140)));
}
rep.wc_bundle_loaded = wcLoaded;
console.log(JSON.stringify(rep, null, 1)); await b.close();
