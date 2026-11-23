// End-to-end test of the phone-wallet (WalletConnect) path WITHOUT a phone: a Node "wallet" built on
// @walletconnect/sign-client pairs with the page through the real WalletConnect relay, approves the session,
// and handles the requests exactly as the mobile wallets document them:
//   sign_and_send_sponsored_transaction {header, payload, sponsorSignature, schema} -> add sender signature, submit, reply {hash}
//   request_verifiable_presentation_v1  <VerificationRequestV1 JSON>               -> shape check only (no gRPC on the box to prove)
// The signer is the DEMO person Amy (testnet test keys from .secrets, git-ignored). Uses the live server's APIs.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { SignClient } from "@walletconnect/sign-client";
// Concordium's shared dApp project ID, as exported by @concordium/wallet-connectors (its Node ESM build does not resolve).
const CONCORDIUM_WALLET_CONNECT_PROJECT_ID = "76324905a70fe5c388bab46d3e0564dc";
import { AccountTransactionV1, Payload } from "@concordium/web-sdk/transactions";
import { load, signer } from "../lib/testusers.mjs";

const BASE = process.env.EVENTSCOPE_URL || "https://eventscope-lwpm.onrender.com";
const LOCAL = process.env.LOCAL !== "0";
const WHO = process.env.WHO || "amy";
const u = load(WHO); const ACCOUNT = u.acct.address;
const hex = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { account: ACCOUNT };

// ---- the simulated wallet
const wallet = await SignClient.init({ projectId: process.env.WALLETCONNECT_PROJECT_ID || CONCORDIUM_WALLET_CONNECT_PROJECT_ID,
  metadata: { name: "EventScope test wallet (sim)", description: "headless test", url: "https://example.invalid", icons: [] } });
wallet.on("session_proposal", async ({ id, params }) => {
  // sign-client 2.2x moves requiredNamespaces into optionalNamespaces; both mobile wallets merge the two (cryptox-ios SessionProposalView, cryptox-android WalletConnectViewModel)
  const ns = { ...(params.optionalNamespaces || {}), ...(params.requiredNamespaces || {}) }.ccd; report.proposal = ns; log("proposal", JSON.stringify(ns));
  await wallet.approve({ id, namespaces: { ccd: { accounts: [`ccd:testnet:${ACCOUNT}`], methods: ns.methods, events: ns.events, chains: ns.chains } } });
});
// Parse an AccountTransactionSignature (u8 #creds, [u8 credIdx, u8 #keys, [u8 keyIdx, u16 len, sig]])
function parseSig(b) { let i = 0; const out = {}; const nc = b[i++]; for (let c = 0; c < nc; c++) { const ci = b[i++]; const nk = b[i++]; out[ci] = {}; for (let k = 0; k < nk; k++) { const ki = b[i++]; const len = (b[i] << 8) | b[i + 1]; i += 2; out[ci][ki] = Buffer.from(b.slice(i, i + len)).toString("hex"); i += len; } } if (i !== b.length) throw new Error("trailing bytes in sponsorSignature"); return out; }
wallet.on("session_request", async ({ id, topic, params }) => {
  const { method, params: p } = params.request; log("request", method);
  try {
    if (method === "sign_and_send_sponsored_transaction") {
      const header = AccountTransactionV1.deserializeHeader(hex(p.header).buffer);
      const payload = Payload.deserialize(hex(p.payload).buffer);
      const sponsor = parseSig(hex(p.sponsorSignature));
      report.sponsored = { keys: Object.keys(p), sender: header.sender.address, sponsor: header.sponsor?.address, payload_type: payload.type, schema: p.schema?.type, energy: String(header.energyAmount?.value ?? header.energyAmount) };
      if (header.sender.address !== ACCOUNT) throw new Error("sender mismatch");
      const unsigned = { version: 1, header, payload };
      const sender = await AccountTransactionV1.createSignature(unsigned, signer(u));
      const tx = AccountTransactionV1.create(unsigned, { sender, sponsor });
      const raw = AccountTransactionV1.serializeBlockItem(tx);
      const r = await fetch("https://wallet-proxy.testnet.concordium.com/v0/submitRawTransaction", { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: raw });
      const j = await r.json(); log("submit", r.status, JSON.stringify(j));
      if (!r.ok) throw new Error("submit failed: " + JSON.stringify(j));
      const hash = j.submissionId || Buffer.from(AccountTransactionV1.getAccountTransactionHash(tx)).toString("hex");
      report.sponsored.hash = hash;
      await wallet.respond({ topic, response: { id, jsonrpc: "2.0", result: { hash } } });
    } else if (method === "request_verifiable_presentation_v1") {
      const req = typeof p === "string" ? JSON.parse(p) : p;
      report.vp_v1 = { keys: Object.keys(req), has_context: !!req.context, subject_claims: req.subjectClaims?.length, claim_type: req.subjectClaims?.[0]?.type, transactionRef: req.transactionRef };
      await wallet.respond({ topic, response: { id, jsonrpc: "2.0", error: { code: 5000, message: "sim wallet: proof not produced (box cannot reach testnet gRPC)" } } });
    } else {
      await wallet.respond({ topic, response: { id, jsonrpc: "2.0", error: { code: 5001, message: "unsupported" } } });
    }
  } catch (e) { log("error", e.message); report.error = e.message; await wallet.respond({ topic, response: { id, jsonrpc: "2.0", error: { code: 500, message: e.message } } }); }
});

// ---- the page
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
page.on("pageerror", (e) => log("pageerror", e.message));
if (LOCAL) for (const f of ["index.html", "app.js", "wc.js"]) await page.route(f === "index.html" ? (x) => x.pathname === "/" : `**/${f}*`, (r) => r.fulfill({ body: readFileSync(`web/${f}`), contentType: f.endsWith("html") ? "text/html" : "text/javascript" }));
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".drop", { state: "attached", timeout: 60000 });
await page.click("#phone");
await page.waitForSelector("wcm-modal", { state: "attached", timeout: 30000 });
let uri = null;
// The WalletConnect modal's "copy link" button puts the pairing URI on the clipboard (same URI the QR code encodes).
await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
await page.waitForTimeout(3000);
for (let i = 0; i < 10 && !uri; i++) {
  const btns = page.locator("wcm-modal-header button");
  const n = await btns.count();
  for (let j = 0; j < n && !uri; j++) { await btns.nth(j).click().catch(() => {}); await page.waitForTimeout(500);
    const t = await page.evaluate(() => navigator.clipboard.readText().catch(() => "")); if (t.startsWith("wc:")) uri = t; }
  if (!uri) await page.waitForTimeout(1500);
}
if (!uri) throw new Error("no pairing URI in page");
log("pairing uri found; wallet pairing");
await wallet.core.pairing.pair({ uri });
await page.waitForFunction(() => !document.getElementById("acctchip").classList.contains("hide"), null, { timeout: 60000 });
report.connected_chip = await page.textContent("#acctchip");
report.addtok_hidden = await page.evaluate(() => document.getElementById("addtok").classList.contains("hide"));
report.disconnect_visible = await page.isVisible("#wcoff");
log("page connected:", report.connected_chip);
await page.screenshot({ path: "/workspace/eventscope-shots/sim-connected.png" });

// Sponsored buy: click the first Collect button of an open event (one €2 card for the demo person)
if (process.env.BUY !== "0") {
  const btn = page.locator(".pick .btn:not([disabled])").first();
  await btn.click();
  await page.waitForFunction(() => [...document.querySelectorAll("#toast div")].some((d) => /^Card |Refused|rejected|failed/i.test(d.textContent)), null, { timeout: 240000 }).catch(() => {});
  report.buy_toasts = await page.$$eval("#toast div", (ds) => ds.map((d) => d.textContent.slice(0, 160)));
  await page.screenshot({ path: "/workspace/eventscope-shots/sim-bought.png" });
}
// VP v1 request shape
if (process.env.VP !== "0") {
  report.vp_page_error = await page.evaluate(async (a) => { const M = await import("/app.js"); try { await M.verify(a); return "no error?"; } catch (e) { return String(e.message || e); } }, ACCOUNT);
}
console.log(JSON.stringify(report, null, 1));
await browser.close(); process.exit(0);
