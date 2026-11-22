# EventScope (Concordium testnet)

Collect cards on real events. Winning cards pay out. Play money only (EUR-demo token), testnet only, no house fee.

- **Live drops**: a feed agent pulls real fixtures, prices and weather from free public sources (ESPN public scoreboards,
  Coinbase Exchange candles, Open-Meteo) and creates each event on chain. Nothing is typed by hand.
- **Cards**: every outcome is a collectible card with generated art. Serial #001 is Legendary, #002 to #003 Epic,
  #004 to #010 Rare, then Common. Packs: 3 random cards in one all-or-nothing transaction.
- **Your own wallet**: connect Concordium Wallet for Web, prove 18+ and not resident in GB with a zero-knowledge proof
  (nothing else is revealed), get €20 EUR-demo once, collect cards and packs, see your collection, get paid automatically.
  Network fees are paid by EventScope (sponsored transactions).
- **Your own buyer agent**: register an AI agent in Concordium's Agent Registry (CIS-8004, contract 12802,0) under your
  account, fund it, set your daily cap or pause yourself. The prize pot reads the registry on chain at every agent buy,
  credits the cards to you and enforces your limits; going over the cap needs your own signed approval.
- **Results agent**: a registered agent posts each result with the SHA-256 of the exact source response, a 3-minute dispute
  window follows, then the result is final and prizes are paid automatically.
- **Demo people** (Amy, Cal, Ben) use test keys held by the server, for a quick look without a wallet. Clearly labelled.

Contracts: pot 13076,0 (`contracts/eventscope`), EUR-demo token 13069,0 (`contracts/eurdemo`); `contracts/mockregistry` is test only.

## Play as yourself (Concordium Wallet for Web, testnet)

1. Install **Concordium Wallet** for Chrome from the Chrome Web Store and create a wallet. Keep your recovery phrase to yourself.
2. Switch the wallet's network to **Testnet**.
3. Request a **test identity** from one of the testnet identity providers. Enter a date of birth that makes you 18 or over and a
   country of residence other than the United Kingdom (for example Germany).
4. Create an **account** with that identity. You do not need CCD: EventScope pays the network fees.
5. Open the site, click **Connect wallet**, approve the connection in the wallet.
6. Click **Verify age 18+** and approve the proof request in the wallet. You get €20 EUR-demo play money (once per account).
7. Collect a card (**Collect · €2**) or open a pack, approve each transaction in the wallet. Your cards are under **My collection**.
8. Optional: **My agent** → **Create my agent** (up to 3 wallet approvals), **Move €6 to my agent**, **Let my agent pick 3 cards**.
   Set your daily cap or pause yourself on the same page.

## Run

    cargo test                                # contract tests
    node tests/guard_test.mjs                 # rate limits and sponsor budget
    CCD_SPONSOR_PRIVATE_KEY=... node server.mjs   # http://127.0.0.1:8100, runs the feed and results agents on timers
    node tests/wallet_page_test.mjs           # page's real-wallet code path with a stand-in wallet (server running)

Environment (secrets only from the environment, never from the repo):

| Variable | What |
|---|---|
| `CCD_SPONSOR_PRIVATE_KEY` | operator account key: pays fees, runs the feed and results agents |
| `EVENTSCOPE_DEMO_SECRETS_B64` or secret file `/etc/secrets/demo-secrets.b64` | testnet keys of the demo people and the agent-wallet pool (optional) |
| `REDIS_URL` | Render Key Value; keeps the off-chain index (event display data, card serials, evidence) across restarts |
| `EVENTSCOPE_SPONSOR_CCD_PER_HOUR` | hourly cap on CCD spent for visitors (default 750); over it the site says "busy, try later" |
| `EVENTSCOPE_KEEPALIVE` | `1` pings the public URL every 10 minutes so Render's free plan does not put the agents to sleep |
| `EVENTSCOPE_FEED_DAILY` | max new events per rolling 24 h (default 10: 4 crypto slots, 3 cities, up to 3 fixtures) |
| `EVENTSCOPE_WARN_CCD`, `EVENTSCOPE_STOP_FEED_CCD`, `EVENTSCOPE_STOP_ALL_CCD` | operator balance watchdog: warn (2000), stop creating events (1000), stop agent spending (300). Balance and burn per day are in `/api/health` |
| `EVENTSCOPE_RUN_UNTIL` | end date for the projected-spend figure in `/api/health` (default 2026-12-11) |

Deploy: `render.yaml` (Blueprint) or `node scripts/render-deploy.mjs <keyValueId>`.
