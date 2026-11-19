// Headless test of the page's REAL-WALLET code path, with a stand-in for the Concordium Wallet for Web.
// The stand-in implements the provider calls the page uses (requestAccounts, getSelectedChain, requestVerifiablePresentationV1,
// sendSponsoredTransaction) and returns the same types the real extension does. Its "user" is a demo person whose test keys
// sign in Node. It does NOT test the real extension's popup UI or clicks.
//   node tests/wallet_page_test.mjs        (server must be running on 8100; uses live feed events, creates nothing)
import { chromium } from "playwright-core";
import { VerificationRequestV1 } from "@concordium/web-sdk";
import { load, prove, signer } from "../lib/testusers.mjs";
import { signAndSubmitSponsored } from "../lib/chain.mjs";
const B = "http://127.0.0.1:8100";
const results = [];
const t = (name, ok, extra = "") => { results.push({ name, ok, extra }); console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); };
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });

async function openAs(who) {
  const ctx = await b.newContext({ viewport: { width: 1360, height: 1000 } });
  const page = await ctx.newPage();
  const u = load(who);
  await page.exposeFunction("__walletProve", async (reqJSON) => (await prove(who, VerificationRequestV1.fromJSON(reqJSON))).toJSON());
  await page.exposeFunction("__walletSubmit", async (txJSONString) => (await signAndSubmitSponsored(JSON.parse(txJSONString), signer(u), "token")).tx);
  await page.addInitScript((account) => {
    window.__walletCalls = [];
    // toasts disappear after 9 to 14 s, so keep every one ever shown
    window.__toasts = [];
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.parentElement?.id === "toast") window.__toasts.push({ text: n.textContent + [...n.querySelectorAll("a")].map((a) => " " + a.href).join(""), cls: n.className }); })
      .observe(document, { childList: true, subtree: true });
    window.concordium = {
      requestAccounts: async () => { window.__walletCalls.push("requestAccounts"); return [account]; },
      getMostRecentlySelectedAccount: async () => account,
      getSelectedChain: async () => "4221332d34e1694168c2a0c0b3fd0f27c2f5c0a7e2c7a1c3f2c3a8c1a0e0f1d2",
      on: () => {},
      requestVerifiablePresentationV1: async (request) => {
        window.__walletCalls.push("requestVerifiablePresentationV1:" + (request?.constructor?.name || typeof request));
        const S = window.__EventScopeSdk;
        const json = typeof request.toJSON === "function" ? request.toJSON() : S.VerificationRequestV1.toJSON(request);
        return S.VerifiablePresentationV1.fromJSON(await window.__walletProve(JSON.parse(JSON.stringify(json))));
      },
      sendSponsoredTransaction: async (acct, tx, schema) => {
        window.__walletCalls.push("sendSponsoredTransaction:" + (schema?.type || "no-schema"));
        return window.__walletSubmit(window.__EventScopeSdk.Transaction.toJSONString(tx));
      },
    };
  }, u.acct.address);
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`${B}/?tab=live`, { waitUntil: "load" });
  await page.waitForSelector(".drop", { timeout: 180000 });
  t(`${who}: real wallet is the default mode`, (await page.$eval("#who", (el) => el.value)) === "wallet" && !(await page.$eval("#connect", (el) => el.classList.contains("hide"))));
  return { page, ctx, address: u.acct.address };
}
/** click, then wait for a NEW toast matching re (or a red one); returns its text */
async function click(p, sel, re, ms = 240000) {
  const before = await p.evaluate(() => window.__toasts.length);
  await p.waitForSelector(sel, { state: "attached", timeout: 120000 });
  await p.$eval(sel, (el) => el.click()); // the verify button is hidden once the account is already allowed
  const h = await p.waitForFunction(([r, n]) => window.__toasts.slice(n).find((d) => new RegExp(r, "i").test(d.text) || d.cls === "bad")?.text, [re.source, before], { timeout: ms });
  return h.jsonValue();
}
const live = (await (await fetch(`${B}/api/events`)).json()).events.filter((e) => e.status === "live" && Date.parse(e.closes_at) > Date.now() + 10 * 60_000);
const target = live.find((e) => e.category === "football") || live[0];

// --- Amy via the wallet path. Make sure she has room under her own daily cap first (the pot refuses otherwise, see the
// OverDailyCap check below): raise it to EUR 20 with her own signed setLimits if she is at her cap.
const amyAcct = load("amy").acct.address;
const pl = await (await fetch(`${B}/api/player?account=${amyAcct}`)).json();
if (pl.left_today_eur !== undefined && Number(pl.left_today_eur) < 2) {
  const r = await (await fetch(`${B}/api/demo/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ who: "amy", entrypoint: "setLimits", daily_cap_eur: Number(pl.daily_cap_eur || 10) + 10 }) })).json();
  console.log("raised Amy's cap first:", r.ok, r.tx_link || r.refused_with);
}
const amy = await openAs("amy");
let m = await click(amy.page, "#connect", /Wallet connected/);
t("connect: page reads the account from the wallet", /Wallet connected/.test(m) && (await amy.page.evaluate(() => window.__walletCalls)).includes("requestAccounts"));
m = await click(amy.page, "#verify", /verified with a zero-knowledge proof|refused/);
t("verify: wallet proof accepted by the backend, account allowed", /verified with a zero-knowledge proof/.test(m), m);
m = await click(amy.page, `[data-buy="${target.id}:1"]`, /Card success|Card rejected|Refused/);
t(`collect: sponsored token transfer approved in the wallet and finalized (#${target.id} ${target.title})`, /Card success/.test(m), m);
const calls = await amy.page.evaluate(() => window.__walletCalls);
t("page used the wallet API calls", calls.some((c) => c.startsWith("requestVerifiablePresentationV1")) && calls.includes("sendSponsoredTransaction:ModuleSchema"), JSON.stringify(calls));
await amy.page.click('#nav button[data-t="coll"]');
await amy.page.waitForSelector("#coll .cc", { timeout: 120000 });
const mine = await amy.page.$$eval("#coll .cc .cap", (d) => d.map((x) => x.textContent));
t("collection: the new card shows up in My collection", mine.some((x) => x.includes(target.title)), `${mine.length} cards`);
await amy.page.screenshot({ path: "/workspace/eventscope/.run/page-wallet-amy.png", fullPage: true });

// --- Amy creates her OWN agent through the wallet path (register, bind pool wallet, link in pot), funds it, lets it pick
if (!process.argv.includes("--skip-agent")) {
  await amy.page.click('#nav button[data-t="agent"]');
  await amy.page.waitForSelector("#vagent .panel", { timeout: 120000 });
  const hasSetup = await amy.page.$("#vsetup");
  if (hasSetup) {
    m = await click(amy.page, "#vsetup", /Your agent is ready|refused|rejected/, 600000);
    t("own agent: register + bind wallet + link, all signed in the wallet", /Your agent is ready/.test(m), m);
  } else t("own agent: already set up", true);
  await amy.page.waitForSelector("#vtopup", { timeout: 120000 });
  m = await click(amy.page, "#vtopup", /Move €6 to your agent: (success|rejected)|refused/, 240000);
  // passes if the transfer went through, or was correctly refused before any wallet prompt because the owner has no EUR-demo left
  t("own agent: owner funds the agent wallet (sponsored CIS-2 transfer), or is refused up front when empty", /success|not enough EUR-demo/.test(m), m);
  await amy.page.waitForSelector("#vrun", { timeout: 120000 });
  m = await click(amy.page, "#vrun", /Your agent bought|daily cap|Agent:/, 300000);
  t("own agent: agent picks and buys for its owner, or asks for approval at the cap", /Your agent bought|daily cap/.test(m), m);
  const g = await (await fetch(`${B}/api/wallet/agent?account=${amy.address}`)).json();
  t("own agent: registry entry owned by the wallet account, wallet bound, linked in the pot", g.agent?.registry_record?.owner === amy.address && g.agent?.registry_record?.agent_wallet === g.agent?.wallet && !!g.agent?.linked_in_pot, `agent #${g.agent?.token_id}`);
  await amy.page.screenshot({ path: "/workspace/eventscope/.run/page-wallet-amy-agent.png", fullPage: true });
}

// --- Ben via the wallet path
const ben = await openAs("ben");
await click(ben.page, "#connect", /Wallet connected/);
m = await click(ben.page, "#verify", /verified with a zero-knowledge proof|refused|failure/);
t("Ben: wallet cannot make the proof, nothing allowed", /failure to prove|refused|could not/i.test(m) && !/verified with/.test(m), m);
m = await click(ben.page, `[data-buy="${target.id}:0"]`, /Refused before paying|Card/);
t("Ben: collect refused before any wallet prompt", /Refused before paying: NotVerified/.test(m) && !(await ben.page.evaluate(() => window.__walletCalls)).some((c) => c.startsWith("send")), m);
await ben.page.screenshot({ path: "/workspace/eventscope/.run/page-wallet-ben.png" });
await b.close();
const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} passed, ${fail} failed`);
(await import("node:fs")).writeFileSync(`/workspace/eventscope/.run/wallet-test-${Date.now()}.json`, JSON.stringify({ at: new Date().toISOString(), target: target.id, results }, null, 1));
process.exit(fail ? 1 : 0);
