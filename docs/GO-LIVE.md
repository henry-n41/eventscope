# Path to production (going live on mainnet)

This is EventScope's plan for moving from the live Concordium **testnet** demo to a real-money service on **mainnet**. It is written for the Concordium Trusted Agents hackathon (submissions close 9 December 2026, 23:59 UTC). Nothing here is a promise that mainnet is ready now. The testnet site is a working end-to-end flow with play money.

Live demo: <https://eventscope-lwpm.onrender.com>
Code: <https://github.com/henry-n41/eventscope>

## What already works on testnet

A visitor proves, with a zero-knowledge proof, that they are 18 or over and not resident in the United Kingdom. Nothing else is revealed. They collect cards on real fixtures, prices and weather. A buyer agent, registered in Concordium's Agent Registry, can buy for them inside a daily cap the person set on chain. A results agent, also registered, posts each official result with a hash of the source, waits out a dispute window, then finalizes and pays winners automatically. EventScope pays the CCD network fees (sponsored transactions). Phones can connect with CryptoX or Concordium Wallet through WalletConnect.

That flow is what we would keep on mainnet. What has to change is the money, the law, and a few operational settings that are still demo-sized.

## Money: why a home-made token today, and the switch to a real euro

On testnet the pot holds **EUR-demo**, our own CIS-2 token (contract [13069,0](https://ccdexplorer.io/testnet/smart-contract/13069/0), 6 decimals, play money, not redeemable). Three facts forced that choice.

1. **A contract cannot hold a Protocol-Level Token.** Concordium's official testnet euro, [EUDemo](https://ccdexplorer.io/testnet/tokens/EUDemo), is a PLT. Under today's protocol rules a PLT can only sit on an account, not in a smart contract. Our pot is a contract, so it cannot take EUDemo in or pay it out. EUDemo also has an **allow list** of accounts (confirmed on CCDExplorer on 25 November 2026); a contract could not join that list either.

2. **x402 cannot pay a CIS-2 token.** Concordium's x402 path settles CCD and PLTs, not CIS-2. Card payments therefore go through a CIS-2 transfer into the pot, with the person's (or their agent's) signature and a sponsored fee, not through x402.

3. **Protocol-Level Locks, the escrow that can hold a PLT safely, are not on testnet yet.** Concordium's public plan (Town Hall #6, 28 October 2026, and the [roadmap](https://www.concordium.com/roadmap)) is Locks on **public testnet in mid-December 2026** and on **mainnet in January 2027**, after a CertiK review. Until then, a contract-held CIS-2 token is the honest way to run a pot on testnet.

**On mainnet the play-money token goes away.** The pot should take a real euro stablecoin issued as a PLT, and use Locks so the funds stay in the holder's custody, earmarked for the pot, rather than sitting in a contract that could be drained.

What Concordium actually lists today (checked on CCDExplorer on 25 November 2026):

- **[EURR (StablR Euro)](https://ccdexplorer.io/mainnet/tokens/EURR)** is the euro PLT that is actually circulating on mainnet (about 320,395 EURR, 6 decimals). It is issued by StablR Ltd, an electronic money institution supervised by the Malta Financial Services Authority, and is described as MiCAR-compliant. It has a deny list and no allow list.
- **EURQ (Quantoz EURQ)** is live on [testnet](https://ccdexplorer.io/testnet/tokens/EURQ) (1,000 EURQ). Concordium has said it is targeting **mainnet in December 2026**. The mainnet token page did not yet list a live EURQ on 25 November 2026.
- **VEUR (VNX Euro)** and **eEUR (Aryze)** are listed on mainnet but both showed a total supply of zero on the same day, so they are not a practical choice yet.

The first mainnet money should be whichever regulated euro PLT is liquid, supported in the wallets, and acceptable to counsel at the time: EURR if it remains the circulating option, or EURQ if it has shipped and is the better fit. We will not pretend a token is live before the explorer shows it.

A short testnet prototype, once Locks exist there, will lock EUDemo or testnet EURQ instead of holding CIS-2 in the contract. That is the rehearsal for the mainnet pot. It depends on Concordium shipping Locks; the mid-December date is theirs, not ours.

## Legal (the United Kingdom and the European Union)

This is not legal advice. A lawyer has not reviewed EventScope yet. **No real-money launch happens until one does.**

Paying to predict sports results, prices or weather looks, in UK law, much closer to **betting** or a **lottery** than to a skill-based prize competition. A prize competition usually needs a genuine skill element, a genuine free-entry route, or both, under the Gambling Act 2005. In the EU the picture varies by member state; many treat this kind of paid prediction as gambling.

Three honest routes, in order of how soon they could be real:

1. **Restructure** as a prize competition with a genuine, well-advertised free-entry route, and only after counsel agrees that the product as built fits that definition.
2. **Launch only with a licensed partner** in each market that treats this as betting or gambling, and geo-block everywhere else.
3. **Stay on play money**, or keep the product invite-only and geo-blocked, until a licence or a partner is in place.

The site already gates play with a zero-knowledge proof: 18 or over, and country of residence not in the blocked list (today that list is the United Kingdom). A VPN does not help, because the proof comes from the identity, not from an IP address. That gate is necessary. It is not a licence and it does not make a real-money launch lawful on its own. The blocked-country list and the age rule would be set to whatever counsel requires for each market.

## Operations on mainnet

**Results agent.** On testnet the results agent is registry token [#1296](https://eventscope-lwpm.onrender.com/agents/1296.json), owned by the operator account. On mainnet it should be owned by a **verified business identity** (a Concordium ID issued to the company), so a legal person is accountable for what it posts. The job stays the same: read the official public source, post the result with the SHA-256 of the exact response, wait out the dispute window, finalize, pay. Anyone can download the evidence file and hash it themselves.

**Dispute window.** On testnet it is **3 minutes**, so the demo can show a full cycle in one sitting. That is too short for real money. Mainnet should use a window measured in **hours** (a working day is a reasonable starting point), set with counsel and written into the pot before launch.

**Fee sponsoring.** EventScope pays CCD network fees so visitors never have to hold CCD. Figures from the live testnet operator, read from [`/api/health`](https://eventscope-lwpm.onrender.com/api/health) at 17:43 GMT on 25 November 2026:

- Operator account [`3N9s8YUN2pxMuP5bszXUUk9vZ3ks7tDgxgzhG5arGr5qGYe6fn`](https://ccdexplorer.io/testnet/account/3N9s8YUN2pxMuP5bszXUUk9vZ3ks7tDgxgzhG5arGr5qGYe6fn): **78,085.51 CCD**.
- Burn: **151 CCD per day**, measured over the last 25.8 hours.
- At that rate the balance would last hundreds of days. Projected spend to 11 December 2026: **2,463 CCD**.
- A watchdog already warns below 2,000 CCD, stops the feed below 1,000, and stops agent spending below 300.
- Measured testnet fees, from the 22 November 2026 run: create an event about 11 CCD, propose a result about 19, finalize about 13, pay out about 22 to 29, a sponsored collect about 25.

On mainnet those CCD amounts have a real price. The same watchdog stays. The operator account will be funded for a published daily cap, and the site will say "busy, try later" when the cap or the balance threshold is hit. We will not guess a sterling cost until we have a mainnet energy price and a CCD price to multiply.

**Monitoring.** `/api/health` already reports operator balance and burn, whether the feed and the agents are allowed to spend, results-agent backoff, events created in the last 24 hours, and Key Value memory. That stays, with alerts when the watchdog trips. The off-chain index (event titles, card art, evidence files) is in Render Key Value today; a mainnet deployment should keep a durable store and a backup.

## Phased milestones

Dates that belong to Concordium (Locks, EURQ) can move. Ours move with them.

| When | What | Who, and what it needs |
|---|---|---|
| Now to 9 December 2026 | Keep the testnet demo up, record a demo video of up to three minutes, submit on the Encode form. | Henry: video and form. The live site, repo and this plan are already in place. |
| Mid-December 2026 | Prototype the pot against **Locks on public testnet**, using EUDemo or testnet EURQ instead of CIS-2 in the contract. | Engineering. Needs Locks actually available on testnet. |
| December 2026 to January 2027 | Legal review for the UK and at least one EU market. Decide between a free-entry prize competition, a licensed partner, or staying on play money. Apply for a mainnet **business identity** for the operator and the results agent. | Henry and counsel. EURQ may reach mainnet in December (Concordium's target, not in our control). |
| January 2027 | If Locks are on mainnet and counsel has signed off a path, deploy a mainnet pot that locks a circulating euro PLT (EURR today, or EURQ if it has shipped). **Closed beta**: invite-only, small caps, the existing age and country proofs, a longer dispute window, a funded operator with the same watchdog. | Engineering and Henry. Needs Locks on mainnet, a liquid euro PLT, legal sign-off, and a business identity. |
| Spring 2027 | If the legal path is clear, widen the beta. Concordium's roadmap also lists enhanced, contract-authenticated Locks for March 2027, which would let the pot's own rules sit on top of the lock. | Engineering, Henry, and, if the chosen path is licensed, the partner. |

A public, real-money launch is after a successful closed beta, not before. If Locks or the legal review slip, the testnet demo stays up and the mainnet date moves. We would rather be late than hold real euros in a design we have not rehearsed.
