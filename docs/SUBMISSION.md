# Encode form: paste-ready submission

Copy each section into the matching field on the Encode Club submission form. The demo-video line is a placeholder: replace it once the video is recorded. Do not submit this file with the TODO still in it.

Submissions close **9 December 2026, 23:59 UTC**. Judging is on 10 and 11 December 2026.

---

## Project name

EventScope

## One-line summary

Collect cards on real events on Concordium. A zero-knowledge proof gates play, a registered agent can buy for you, and a registered results agent pays winners automatically.

## Live URL

https://eventscope-lwpm.onrender.com

## Public repository

https://github.com/henry-n41/eventscope

## Demo video

TODO: add the public URL of a demo video of up to three minutes (unlisted YouTube or a similar public link). Record the live site: connect a wallet, prove 18 or over and not resident in the United Kingdom, collect a card, show a registered buyer agent, and show a results-agent payout (event #380, Barcelona versus Villarreal, is a complete cycle on chain). Do not submit until this line is a real URL.

## Path to production (going live on mainnet)

The full plan is in the repo: https://github.com/henry-n41/eventscope/blob/main/docs/GO-LIVE.md

Short version: the testnet pot uses our own CIS-2 play-money token because Concordium's official euro (EUDemo) is a Protocol-Level Token that a contract cannot hold, and because x402 cannot pay CIS-2. When Protocol-Level Locks reach testnet (Concordium: mid-December 2026) we will prototype a pot that locks a testnet euro PLT. On mainnet we would switch to a circulating regulated euro PLT (EURR, StablR Euro, is already live; EURQ is on testnet and targeted for mainnet in December 2026) and use Locks so funds stay in the holder's custody. A real-money launch needs a lawyer's review first: this looks close to betting under UK law, so the honest routes are a genuine free-entry prize competition, a licensed partner, or staying on play money. The existing zero-knowledge age and country gate stays. A closed beta would follow Locks on mainnet (Concordium: January 2027), a business identity for the results agent, and a longer dispute window than the 3-minute demo setting.

## CCDExplorer link

A complete cycle on Concordium testnet, event #380, Barcelona 3–2 Villarreal, 22 November 2026:

Automatic payout of €6.00 EUR-demo to Amy:
https://ccdexplorer.io/testnet/transaction/cd367157b034216973586a6f1af753cb9887dc1bb0be641cc9bb83693e85659b

(Result posted, then finalized, then paid: see "On-chain proof points" below if the form allows more than one link. If it allows only one, use the payout.)

## Project description

Paste from here to the end of "What this is not".

EventScope is a live Concordium testnet app where people collect cards on real football fixtures, crypto prices and weather. Winning cards share the prize pot. There is no house fee. EUR-demo is play money, not redeemable, and the site is testnet only.

A visitor connects Concordium Wallet for Web, or a Concordium mobile wallet (CryptoX or Concordium Wallet) through WalletConnect. They prove, with a Concordium identity zero-knowledge proof (Verifiable Presentation v1), that they are 18 or over and not resident in the United Kingdom. Nothing else is revealed. A VPN does not help. After a valid proof the pot sets an allow flag on chain and the visitor receives €20 EUR-demo once. They collect a card or open a pack; EventScope pays the CCD fee with a sponsored transaction, so the visitor does not need to hold CCD.

A visitor can also register their own buyer agent in Concordium's Agent Registry. The pot re-reads the registry on chain at every agent buy, credits the cards to the person, and enforces the daily cap and the self-exclusion the person set. The agent cannot raise the cap or lift a pause. Going over the cap needs the person's own signed approval.

A results agent, also in the registry, reads each event's official public source (ESPN scoreboards, Coinbase Exchange candles, MET Norway weather), posts the result with the SHA-256 of the exact source response, waits out a dispute window, then finalizes and pays winners automatically. Anyone can download the evidence file and hash it themselves. On testnet the dispute window is 3 minutes, so a full cycle can be shown in one sitting; that would be lengthened before real money.

Demo people (Amy, Cal, Ben) use test keys held by the server, clearly labelled, so a judge can click through without a wallet.

### What was built

- A prize-pot contract and a CIS-2 play-money euro on Concordium testnet, with allow flags, daily caps, agent buys and automatic payouts.
- A feed agent that creates events on chain from public sources (up to 10 new events per rolling 24 hours).
- A results agent that posts, finalizes and pays, with evidence files.
- A buyer agent for the demo person Amy, and a path for a visitor to register their own agent under their verified account.
- A web app with Concordium Wallet for Web and WalletConnect for phones, plus a responsive layout.
- Operational limits: sponsored-fee budget, a balance and burn watchdog, and a cached event feed.

### Concordium components used

- **Zero-knowledge identity proofs (Verifiable Presentation v1).** The backend anchors a request on chain; the wallet produces a presentation that the person is 18 or over and not resident in the United Kingdom. The pot then sets an allow flag. Example allow-flag transaction (Amy, 22 November 2026): https://ccdexplorer.io/testnet/transaction/a64186802a9b129daaf308137e8d7b44c5c5f92650d935b53f9c1e3a86cd1e72
- **Agent Registry (CIS-8004), testnet contract [12802,0](https://ccdexplorer.io/testnet/smart-contract/12802/0).**
  - Buyer agent **#1295** (owner: Amy). Card URL update: https://ccdexplorer.io/testnet/transaction/f63182345b176970dc86c4745c3041e656d8e1da4db4d97326102d8353e6a7fd
  - Results agent **#1296** (owner: EventScope operator). Card URL update: https://ccdexplorer.io/testnet/transaction/fac252ea1ab1b32117e5c00b899c54a8755d22da7630f2e32ddc3fc9b96d9c5f
  - Visitor-registered agent **#1306** (Amy, acting as a wallet visitor): https://ccdexplorer.io/testnet/transaction/d7c9a4f026558897ea7c66ac5ad154aaa72a5c538f151f296859fd051b8c707a — later pointed at the live card URL: https://ccdexplorer.io/testnet/transaction/c986c31fcc8b9e3b7b9db50458b08caf66957caa594da6f3b3c3c0fc0dcd1b71
- **Sponsored transactions.** The operator pays CCD fees; the visitor (or their agent) signs the action. Used for collect, packs, claims, limits, pause and agent steps, from the browser extension and from a phone wallet.
- **CIS-2 token EUR-demo, contract [13069,0](https://ccdexplorer.io/testnet/smart-contract/13069/0).** Play money used by the pot. (Why this token, and how we would switch to a real euro PLT, is in the path-to-production plan.)
- **Prize pot, contract [13076,0](https://ccdexplorer.io/testnet/smart-contract/13076/0).** Holds events, cards, allow flags, caps and payouts.
- **WalletConnect mobile.** Official `@concordium/wallet-connectors`, chain `ccd:testnet`, methods `sign_and_send_sponsored_transaction` and `request_verifiable_presentation_v1`. Works with CryptoX and Concordium Wallet for mobile, set to Testnet.

### On-chain proof points (event #380, Barcelona 3–2 Villarreal, 22 November 2026)

Amy collected all three outcomes, the results agent posted the official score, the pot finalized after the dispute window, and €6.00 was paid to Amy automatically:

- Collect (one of three): https://ccdexplorer.io/testnet/transaction/1dc9a28b630b134be9e1f872c50ff10a4a144adaaa4db45cc1963c6cf9aafdf4
- Result posted: https://ccdexplorer.io/testnet/transaction/6f4637d6d45a2701bab35dbad5ce9fc96b4ba9a47ce840f7dfd699e7b3088fcc
- Finalized: https://ccdexplorer.io/testnet/transaction/bad83a90279f920ba6e2660f08092a037877dd65d6c56b765d3412cc18a2586a
- Payout of €6.00 to Amy: https://ccdexplorer.io/testnet/transaction/cd367157b034216973586a6f1af753cb9887dc1bb0be641cc9bb83693e85659b

A later sponsored collect, approved by a simulated phone wallet over the real WalletConnect relay on the live site (23 November 2026): https://ccdexplorer.io/testnet/transaction/090e6a4295130d1d74b6be83d7878ff7ff7d60707085b39aa53d106396346137

### What this is not

EUR-demo is play money on testnet, not a redeemable euro. The 3-minute dispute window is a demo setting. The results agent is not yet tied to a mainnet business identity. The phone flow was tested end to end with a simulated wallet over the real relay; a real-phone walkthrough (opening the wallet app and producing the proof there) still needs to be done. No lawyer has approved a real-money launch. We are not claiming x402 payments or a contract-held PLT, because neither works for this pot today.
