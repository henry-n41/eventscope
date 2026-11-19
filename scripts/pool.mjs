// Creates the agent-wallet pool: testnet accounts that visitors' buyer agents use (credentials 1..N of the Ben test identity;
// account creation is free on Concordium). Writes .secrets/account-ben-pool<N>.json. Keys are derived from Ben's test seed.
//   node scripts/pool.mjs [count=8]
import { ensureAccount } from "../lib/testusers.mjs";
const n = Number(process.argv[2] || 8);
for (let i = 1; i <= n; i++) {
  for (let t = 0; t < 4; t++) {
    try { const a = await ensureAccount("ben", i, `pool${i}`); console.log(i, a.address, a.tx); break; }
    catch (e) { console.log(i, "retry", e.message); await new Promise((r) => setTimeout(r, 5000)); }
  }
}
process.exit(0);
