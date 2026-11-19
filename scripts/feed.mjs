// Run the live events feed and the results agent once (the server also runs both on a timer).
//   node scripts/feed.mjs [sync|results|both] [kinds=crypto,weather,sports] [maxNew]
import { OPERATOR_KEY_ENV } from "../lib/config.mjs";
import { signerFromHex } from "../lib/chain.mjs";
import { syncFeed } from "../lib/feedagent.mjs";
import { runResults } from "../lib/resultsagent.mjs";
const key = process.env[OPERATOR_KEY_ENV]; if (!/^[0-9a-f]{64}$/i.test(key || "")) { console.error(`${OPERATOR_KEY_ENV} missing`); process.exit(1); }
const op = signerFromHex(key);
const [mode = "both", kinds = "crypto,weather,sports", maxNew = "40"] = process.argv.slice(2);
if (mode !== "results") console.log("created", await syncFeed(op, { kinds: kinds.split(","), maxNew: Number(maxNew) }));
if (mode !== "sync") console.log("posted", await runResults(op));
process.exit(0);
