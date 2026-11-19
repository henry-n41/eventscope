// Unit test of the public-use guards (no chain): rate limits per IP and per account, and the hourly sponsor budget.
//   node tests/guard_test.mjs
process.env.EVENTSCOPE_SPONSOR_CCD_PER_HOUR = "100"; process.env.EVENTSCOPE_TX_CCD = "25";
const { limited, reserve, budget } = await import("../lib/guard.mjs");
let fail = 0; const t = (n, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) fail++; };
const r = []; for (let i = 0; i < 7; i++) r.push(limited("verify", "1.2.3.4", `acct${i}`));
t("verify: 6 tries per IP per hour, the 7th is refused", r.slice(0, 6).every((x) => x === null) && /Too many requests from your connection/.test(r[6]));
const a = []; for (let i = 0; i < 5; i++) a.push(limited("verify", `9.9.9.${i}`, "sameAccount"));
t("verify: 4 tries per account per hour, from any IP", a.slice(0, 4).every((x) => x === null) && /this account/.test(a[4]));
t("other IPs are not affected", limited("verify", "5.6.7.8", "other") === null);
reserve(2); reserve(2);
let busy = null; try { reserve(1); } catch (e) { busy = e; }
t("sponsor budget: 4 transactions fit in 100 CCD per hour, the 5th gets 'busy, try later'", busy?.busy === true && /busy/.test(busy.message) && budget().used_ccd_last_hour === 100);
console.log(fail ? `${fail} failed` : "all passed"); process.exit(fail ? 1 : 0);
