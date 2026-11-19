//! Integration tests: EUR-demo token (CIS-2) + EventScope pot. Build both modules first.
use concordium_cis2::*;
use concordium_smart_contract_testing::*;
use concordium_std::{Deserial, Serial};
use eventscope::*;

const OP: AccountAddress = AccountAddress([0u8; 32]);
const VERIFIER: AccountAddress = AccountAddress([9u8; 32]);
const AMY: AccountAddress = AccountAddress([1u8; 32]);
const BEN: AccountAddress = AccountAddress([2u8; 32]);
const CAL: AccountAddress = AccountAddress([3u8; 32]);
const AGENT: AccountAddress = AccountAddress([4u8; 32]); // Amy's buyer agent wallet
const BEN_AGENT: AccountAddress = AccountAddress([5u8; 32]);
const RESOLVER: AccountAddress = AccountAddress([6u8; 32]); // results agent wallet
const AMY_AGENT_ID: u64 = 5;
const BEN_AGENT_ID: u64 = 6;
const RESULTS_AGENT_ID: u64 = 900;
const HOUSE_MAX: u64 = 100_000_000; // 100 EUR-demo per day
const WINDOW_MS: u64 = 600_000; // 10 minute dispute window
const SIGNER: Signer = Signer::with_one_key();
const START: u64 = 1_800_000_000_000;
const PRICE: u64 = 2_000_000; // 2 EUR-demo (6 decimals)
const MINT: u64 = 50_000_000; // 50 EUR-demo each

struct T { chain: Chain, token: ContractAddress, pot: ContractAddress, registry: ContractAddress }

#[derive(Serial)]
struct RegSet { id: u64, owner: AccountAddress, wallet: Option<AccountAddress>, active: bool }

#[derive(Serial)]
struct MintParams { to: AccountAddress, amount: TokenAmountU64 }

fn setup() -> T {
    let mut chain = Chain::builder().block_time(Timestamp::from_timestamp_millis(START)).build().unwrap();
    for a in [OP, VERIFIER, AMY, BEN, CAL, AGENT, BEN_AGENT, RESOLVER] { chain.create_account(Account::new(a, Amount::from_ccd(10_000))); }
    let tm = chain.module_deploy_v1(SIGNER, OP, module_load_v1("../eurdemo/concordium-out/module.wasm.v1").unwrap()).unwrap();
    let token = chain.contract_init(SIGNER, OP, Energy::from(10_000), InitContractPayload {
        amount: Amount::zero(), mod_ref: tm.module_reference, init_name: OwnedContractName::new_unchecked("init_eurdemo".into()),
        param: OwnedParameter::from_serial(&String::from("https://example.com/eur-demo.json")).unwrap(),
    }).unwrap().contract_address;
    let rm = chain.module_deploy_v1(SIGNER, OP, module_load_v1("../mockregistry/concordium-out/module.wasm.v1").unwrap()).unwrap();
    let registry = chain.contract_init(SIGNER, OP, Energy::from(10_000), InitContractPayload {
        amount: Amount::zero(), mod_ref: rm.module_reference, init_name: OwnedContractName::new_unchecked("init_mockregistry".into()),
        param: OwnedParameter::empty(),
    }).unwrap().contract_address;
    let pm = chain.module_deploy_v1(SIGNER, OP, module_load_v1("concordium-out/module.wasm.v1").unwrap()).unwrap();
    let pot = chain.contract_init(SIGNER, OP, Energy::from(10_000), InitContractPayload {
        amount: Amount::zero(), mod_ref: pm.module_reference, init_name: OwnedContractName::new_unchecked("init_eventscope".into()),
        param: OwnedParameter::from_serial(&InitParams { verifier: VERIFIER, token, registry, max_daily_spend: HOUSE_MAX, dispute_window_ms: WINDOW_MS }).unwrap(),
    }).unwrap().contract_address;
    let mut t = T { chain, token, pot, registry };
    t.reg(RESULTS_AGENT_ID, OP, Some(RESOLVER), true);
    t.pot(OP, "setResolver", &SetResolverParams { account: RESOLVER, agent_id: Some(RESULTS_AGENT_ID) }).unwrap();
    for a in [AMY, BEN, CAL] { t.upd(OP, token, "eurdemo.mint", &MintParams { to: a, amount: TokenAmountU64(MINT) }).unwrap(); }
    t
}

impl T {
    fn upd<P: Serial>(&mut self, who: AccountAddress, c: ContractAddress, name: &str, p: &P) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.chain.contract_update(SIGNER, who, Address::Account(who), Energy::from(100_000), UpdateContractPayload {
            amount: Amount::zero(), address: c, receive_name: OwnedReceiveName::new_unchecked(name.into()), message: OwnedParameter::from_serial(p).unwrap() })
    }
    fn pot<P: Serial>(&mut self, who: AccountAddress, name: &str, p: &P) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        let pot = self.pot; self.upd(who, pot, &format!("eventscope.{name}"), p)
    }
    fn view<P: Serial, R: Deserial>(&self, name: &str, p: &P) -> R {
        self.chain.contract_invoke(OP, Address::Account(OP), Energy::from(100_000), UpdateContractPayload {
            amount: Amount::zero(), address: self.pot, receive_name: OwnedReceiveName::new_unchecked(format!("eventscope.{name}")),
            message: OwnedParameter::from_serial(p).unwrap() }).unwrap().parse_return_value().unwrap()
    }
    fn balance(&self, a: Address) -> u64 {
        let q = BalanceOfQueryParams { queries: vec![BalanceOfQuery { token_id: TokenIdUnit(), address: a }] };
        let r: BalanceOfQueryResponse<TokenAmountU64> = self.chain.contract_invoke(OP, Address::Account(OP), Energy::from(100_000), UpdateContractPayload {
            amount: Amount::zero(), address: self.token, receive_name: OwnedReceiveName::new_unchecked("eurdemo.balanceOf".into()),
            message: OwnedParameter::from_serial(&q).unwrap() }).unwrap().parse_return_value().unwrap();
        r.0[0].0
    }
    fn acct(&self, a: AccountAddress) -> u64 { self.balance(Address::Account(a)) }
    fn pot_balance(&self) -> u64 { self.balance(Address::Contract(self.pot)) }
    /// Buying = CIS-2 transfer to the pot with BuyParams in `data`.
    fn buy_raw(&mut self, who: AccountAddress, event_id: EventId, outcome: u8, count: u32, amount: u64) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        let data = AdditionalData::from(concordium_std::to_bytes(&BuyParams { event_id, outcome, count }));
        let p = TransferParams(vec![concordium_cis2::Transfer { token_id: TokenIdUnit(), amount: TokenAmountU64(amount), from: Address::Account(who),
            to: Receiver::Contract(self.pot, OwnedEntrypointName::new_unchecked("onReceivingCIS2".into())), data }]);
        let token = self.token; self.upd(who, token, "eurdemo.transfer", &p)
    }
    fn buy(&mut self, who: AccountAddress, outcome: u8, count: u32) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.buy_raw(who, 0, outcome, count, PRICE * count as u64)
    }
    fn allow(&mut self, who: AccountAddress) {
        self.pot(VERIFIER, "setAllowed", &SetAllowedParams { account: who, until: Some(Timestamp::from_timestamp_millis(START + 86_400_000)) }).unwrap();
    }
    fn now(&self) -> u64 { self.chain.block_time().timestamp_millis() }
    fn create(&mut self) -> EventId {
        let closes = Timestamp::from_timestamp_millis(self.now() + 3_600_000);
        self.pot(OP, "createEvent", &CreateEventParams { title: "Arsenal v Chelsea".into(), category: "football".into(), source_ref: "espn:soccer/eng.1:1".into(),
            outcomes: vec!["Arsenal win".into(), "Draw".into(), "Arsenal lose".into()], card_price: PRICE,
            closes_at: closes }).unwrap().parse_return_value().unwrap()
    }
    fn reg(&mut self, id: u64, owner: AccountAddress, wallet: Option<AccountAddress>, active: bool) {
        let r = self.registry; self.upd(OP, r, "mockregistry.set", &RegSet { id, owner, wallet, active }).unwrap();
    }
    fn to_close(&mut self, id: EventId) {
        let ev: EventData = self.view("viewEvent", &id);
        let now = self.now();
        if ev.closes_at.timestamp_millis() > now { self.chain.tick_block_time(Duration::from_millis(ev.closes_at.timestamp_millis() - now)).unwrap(); }
    }
    fn propose(&mut self, id: EventId, w: u8) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.pot(RESOLVER, "proposeResult", &ProposeParams { event_id: id, winning_outcome: w, evidence_hash: [0xab; 32], source_url: "https://example.com/result".into() })
    }
    fn tick_window(&mut self) { self.chain.tick_block_time(Duration::from_millis(WINDOW_MS)).unwrap(); }
    /// Results agent posts, the dispute window passes, anyone finalizes.
    fn resolve_ev(&mut self, id: EventId, w: u8) {
        self.to_close(id);
        self.propose(id, w).unwrap();
        self.tick_window();
        self.pot(CAL, "finalize", &id).unwrap();
    }
    fn resolve(&mut self, w: u8) { self.resolve_ev(0, w) }
    fn mint(&mut self, to: AccountAddress, amount: u64) { let tk = self.token; self.upd(OP, tk, "eurdemo.mint", &MintParams { to, amount: TokenAmountU64(amount) }).unwrap(); }
    fn link(&mut self) { self.reg(AMY_AGENT_ID, AMY, Some(AGENT), true); self.pot(AMY, "linkAgent", &AMY_AGENT_ID).unwrap(); self.mint(AGENT, MINT); }
    fn player(&self, a: AccountAddress) -> PlayerView { self.view("viewPlayer", &a) }
}

/// The pot's own error, found (recursively) inside the token contract's failed call trace.
fn find_pot_err(elems: &[DebugTraceElement]) -> Option<Error> {
    for ev in elems {
        if let DebugTraceElement::WithFailures { contract_address, error, trace_elements, .. } = ev {
            if let Some(x) = find_pot_err(trace_elements) { return Some(x); }
            if *contract_address == ContractAddress::new(2, 0) {
                if let InvokeExecutionError::Reject { return_value, .. } = error {
                    if let Ok(x) = concordium_std::from_bytes::<Error>(return_value) { return Some(x); }
                }
            }
        }
    }
    None
}
fn pot_err(r: Result<ContractInvokeSuccess, ContractInvokeError>) -> Error {
    let e = r.expect_err("expected a refusal");
    find_pot_err(&e.trace_elements).unwrap_or_else(|| panic!("no pot error found: {:?}", e.kind))
}
fn direct_err(r: Result<ContractInvokeSuccess, ContractInvokeError>) -> Error { r.expect_err("expected a refusal").parse_return_value::<Error>().unwrap() }

#[test]
fn unverified_account_is_refused_and_keeps_its_tokens() {
    let mut t = setup(); t.create();
    assert_eq!(pot_err(t.buy(BEN, 0, 1)), Error::NotVerified);
    assert_eq!(t.acct(BEN), MINT);
    // the read-only pre-check gives the same answer
    let r = t.chain.contract_invoke(BEN, Address::Account(BEN), Energy::from(100_000), UpdateContractPayload {
        amount: Amount::zero(), address: t.pot, receive_name: OwnedReceiveName::new_unchecked("eventscope.canBuy".into()),
        message: OwnedParameter::from_serial(&CanBuyParams { account: BEN, event_id: 0, outcome: 0, count: 1 }).unwrap() });
    assert_eq!(direct_err(r), Error::NotVerified);
    t.allow(AMY);
    let ok: u64 = t.chain.contract_invoke(AMY, Address::Account(AMY), Energy::from(100_000), UpdateContractPayload {
        amount: Amount::zero(), address: t.pot, receive_name: OwnedReceiveName::new_unchecked("eventscope.canBuy".into()),
        message: OwnedParameter::from_serial(&CanBuyParams { account: AMY, event_id: 0, outcome: 0, count: 3 }).unwrap() }).unwrap().parse_return_value().unwrap();
    assert_eq!(ok, 3 * PRICE);
    assert_eq!(t.pot_balance(), 0);
    let ev: EventData = t.view("viewEvent", &0u64);
    assert_eq!(ev.pot, 0);
}

#[test]
fn buying_with_a_different_token_contract_is_refused() {
    let mut t = setup(); t.create(); t.allow(AMY);
    // calling the hook directly (pretending to be a token) is refused
    let fake = OnReceivingCis2Params { token_id: TokenIdUnit(), amount: TokenAmountU64(PRICE), from: Address::Account(AMY),
        data: AdditionalData::from(concordium_std::to_bytes(&BuyParams { event_id: 0, outcome: 0, count: 1 })) };
    assert_eq!(direct_err(t.pot(AMY, "onReceivingCIS2", &fake)), Error::WrongToken);
}

#[test]
fn plain_transfer_without_purchase_data_is_refused() {
    let mut t = setup(); t.create(); t.allow(AMY);
    let p = TransferParams(vec![concordium_cis2::Transfer { token_id: TokenIdUnit(), amount: TokenAmountU64(PRICE), from: Address::Account(AMY),
        to: Receiver::Contract(t.pot, OwnedEntrypointName::new_unchecked("onReceivingCIS2".into())), data: AdditionalData::empty() }]);
    let token = t.token;
    assert_eq!(pot_err(t.upd(AMY, token, "eurdemo.transfer", &p)), Error::MissingPurchaseData);
    assert_eq!(t.acct(AMY), MINT);
}

#[test]
fn only_verifier_or_operator_can_allow_and_only_operator_creates_and_resolves() {
    let mut t = setup();
    let p = SetAllowedParams { account: BEN, until: Some(Timestamp::from_timestamp_millis(START + 1)) };
    assert_eq!(direct_err(t.pot(BEN, "setAllowed", &p)), Error::NotVerifier);
    t.pot(OP, "setAllowed", &p).unwrap();
    let c = CreateEventParams { title: "x".into(), category: "c".into(), source_ref: "s".into(), outcomes: vec!["a".into(), "b".into()], card_price: 1, closes_at: Timestamp::from_timestamp_millis(START + 1) };
    assert_eq!(direct_err(t.pot(AMY, "createEvent", &c)), Error::NotOperator);
    t.create();
    t.to_close(0);
    assert_eq!(direct_err(t.pot(AMY, "proposeResult", &ProposeParams { event_id: 0, winning_outcome: 0, evidence_hash: [0; 32], source_url: "x".into() })), Error::NotResolver);
    let bad = CreateEventParams { title: "x".into(), category: "c".into(), source_ref: "s".into(), outcomes: vec!["one".into()], card_price: 1, closes_at: Timestamp::from_timestamp_millis(START + 1) };
    assert_eq!(direct_err(t.pot(OP, "createEvent", &bad)), Error::BadOutcomes);
}

#[test]
fn only_admin_mints() {
    let mut t = setup();
    let token = t.token;
    assert!(t.upd(AMY, token, "eurdemo.mint", &MintParams { to: AMY, amount: TokenAmountU64(1) }).is_err());
}

#[test]
fn wrong_amount_unknown_outcome_bad_count_closed_event_are_refused() {
    let mut t = setup(); t.create(); t.allow(AMY);
    assert_eq!(pot_err(t.buy_raw(AMY, 0, 0, 2, PRICE)), Error::WrongAmount);
    assert_eq!(pot_err(t.buy(AMY, 7, 1)), Error::UnknownOutcome);
    assert_eq!(pot_err(t.buy_raw(AMY, 0, 0, 0, 0)), Error::BadCount);
    assert_eq!(pot_err(t.buy_raw(AMY, 9, 0, 1, PRICE)), Error::UnknownEvent);
    t.chain.tick_block_time(Duration::from_seconds(3601)).unwrap();
    assert_eq!(pot_err(t.buy(AMY, 0, 1)), Error::EventClosed);
    assert_eq!(t.acct(AMY), MINT);
}

#[test]
fn insufficient_tokens_is_refused_by_the_token() {
    let mut t = setup(); t.create(); t.allow(AMY);
    assert!(t.buy(AMY, 0, 26).is_err()); // 52 > 50 (and the token refuses before the pot is asked)
    assert_eq!(t.acct(AMY), MINT);
}

#[test]
fn expired_and_revoked_verification_are_refused() {
    let mut t = setup(); t.create();
    t.pot(VERIFIER, "setAllowed", &SetAllowedParams { account: AMY, until: Some(Timestamp::from_timestamp_millis(START + 1000)) }).unwrap();
    t.chain.tick_block_time(Duration::from_seconds(2)).unwrap();
    assert_eq!(pot_err(t.buy(AMY, 0, 1)), Error::VerificationExpired);
    t.allow(CAL);
    t.pot(VERIFIER, "setAllowed", &SetAllowedParams { account: CAL, until: None }).unwrap();
    assert_eq!(pot_err(t.buy(CAL, 0, 1)), Error::NotVerified);
}

#[test]
fn winners_split_pot_equally_per_card_in_tokens() {
    let mut t = setup(); t.create();
    for a in [AMY, BEN, CAL] { t.allow(a); }
    t.buy(AMY, 0, 3).unwrap();
    t.buy(CAL, 0, 1).unwrap();
    t.buy(BEN, 2, 4).unwrap();
    assert_eq!(t.pot_balance(), PRICE * 8);
    let ev: EventData = t.view("viewEvent", &0u64);
    assert_eq!((ev.pot, ev.cards_sold.clone()), (PRICE * 8, vec![4, 0, 4]));
    assert_eq!(direct_err(t.pot(AMY, "claim", &0u64)), Error::NotResolved);
    t.resolve(0);
    assert_eq!(pot_err(t.buy(AMY, 0, 1)), Error::EventNotOpen);
    let h: HoldingView = t.view("viewHolding", &HoldingParams { event_id: 0, account: AMY });
    assert_eq!(h.claimable, PRICE * 6);
    t.pot(AMY, "claim", &0u64).unwrap();
    t.pot(CAL, "claim", &0u64).unwrap();
    assert_eq!(t.acct(AMY), MINT - 3 * PRICE + 6 * PRICE);
    assert_eq!(t.acct(CAL), MINT - PRICE + 2 * PRICE);
    assert_eq!(t.acct(BEN), MINT - 4 * PRICE);
    assert_eq!(direct_err(t.pot(AMY, "claim", &0u64)), Error::AlreadyClaimed);
    assert_eq!(direct_err(t.pot(BEN, "claim", &0u64)), Error::NothingToClaim);
    assert_eq!(t.pot_balance(), 0); // no house edge
}

#[test]
fn rounding_dust_never_overpays() {
    let mut t = setup(); t.create();
    for a in [AMY, BEN, CAL] { t.allow(a); }
    for a in [AMY, BEN, CAL] { t.buy(a, 1, 1).unwrap(); }
    t.buy(CAL, 0, 1).unwrap(); // pot 8, 3 winners -> 2.666666 each
    t.resolve(1);
    for a in [AMY, BEN, CAL] { t.pot(a, "claim", &0u64).unwrap(); }
    assert!(t.pot_balance() < 3);
}

#[test]
fn no_winners_or_cancelled_means_full_refund() {
    let mut t = setup(); t.create(); t.allow(AMY);
    t.buy(AMY, 0, 2).unwrap();
    t.buy(AMY, 2, 1).unwrap();
    t.resolve(1);
    t.pot(AMY, "claim", &0u64).unwrap();
    assert_eq!(t.acct(AMY), MINT);
    let id = t.create();
    t.buy_raw(AMY, id, 0, 1, PRICE).unwrap();
    t.pot(OP, "cancel", &id).unwrap();
    t.pot(AMY, "claim", &id).unwrap();
    assert_eq!(t.acct(AMY), MINT);
    assert_eq!(t.pot_balance(), 0);
}

// ============================================================ step 4: buyer agents, limits, self-exclusion, results agent

#[test]
fn agent_buys_for_its_verified_owner_and_the_prize_goes_to_the_owner() {
    let mut t = setup(); t.create(); t.allow(AMY); t.allow(CAL); t.link();
    let link: Option<AgentLink> = t.view("viewAgent", &AGENT);
    assert_eq!(link, Some(AgentLink { owner: AMY, agent_id: AMY_AGENT_ID }));
    t.buy(AGENT, 0, 2).unwrap(); // agent pays from its own wallet
    t.buy(CAL, 2, 2).unwrap();
    let h: HoldingView = t.view("viewHolding", &HoldingParams { event_id: 0, account: AMY });
    assert_eq!(h.cards, vec![2, 0, 0]); // the cards are Amy's
    let ha: HoldingView = t.view("viewHolding", &HoldingParams { event_id: 0, account: AGENT });
    assert_eq!(ha.cards, vec![0, 0, 0]);
    assert_eq!(t.acct(AGENT), MINT - 2 * PRICE);
    t.resolve(0);
    t.pot(OP, "payout", &PayoutParams { event_id: 0, accounts: vec![AMY, CAL, AGENT, BEN] }).unwrap();
    assert_eq!(t.acct(AMY), MINT + 4 * PRICE); // whole pot of 4 cards to Amy
    assert_eq!(t.acct(CAL), MINT - 2 * PRICE);
    assert_eq!(t.pot_balance(), 0);
}

#[test]
fn agent_of_an_unverified_owner_is_refused() {
    let mut t = setup(); t.create();
    t.reg(BEN_AGENT_ID, BEN, Some(BEN_AGENT), true);
    t.pot(BEN, "linkAgent", &BEN_AGENT_ID).unwrap();
    t.mint(BEN_AGENT, MINT);
    assert_eq!(pot_err(t.buy(BEN_AGENT, 0, 1)), Error::NotVerified);
    assert_eq!(t.acct(BEN_AGENT), MINT);
}

#[test]
fn linking_needs_an_active_registry_entry_owned_by_the_sender_with_a_wallet() {
    let mut t = setup();
    assert_eq!(direct_err(t.pot(AMY, "linkAgent", &77u64)), Error::AgentNotFound);
    t.reg(AMY_AGENT_ID, AMY, Some(AGENT), true);
    assert_eq!(direct_err(t.pot(CAL, "linkAgent", &AMY_AGENT_ID)), Error::AgentNotOwnedBySender);
    t.reg(8, AMY, None, true);
    assert_eq!(direct_err(t.pot(AMY, "linkAgent", &8u64)), Error::AgentHasNoWallet);
    t.reg(9, AMY, Some(AGENT), false);
    assert_eq!(direct_err(t.pot(AMY, "linkAgent", &9u64)), Error::AgentNotActive);
    t.pot(AMY, "linkAgent", &AMY_AGENT_ID).unwrap();
    assert_eq!(direct_err(t.pot(CAL, "unlinkAgent", &AGENT)), Error::AgentNotOwnedBySender);
    t.pot(AMY, "unlinkAgent", &AGENT).unwrap();
    let link: Option<AgentLink> = t.view("viewAgent", &AGENT);
    assert_eq!(link, None);
}

#[test]
fn revoking_the_agent_in_the_registry_stops_it_at_the_next_buy() {
    let mut t = setup(); t.create(); t.allow(AMY); t.link();
    t.buy(AGENT, 0, 1).unwrap();
    t.reg(AMY_AGENT_ID, AMY, Some(AGENT), false); // owner revokes in the registry
    assert_eq!(pot_err(t.buy(AGENT, 0, 1)), Error::AgentNotActive);
    t.reg(AMY_AGENT_ID, AMY, Some(CAL), true); // wallet moved elsewhere
    assert_eq!(pot_err(t.buy(AGENT, 0, 1)), Error::AgentWalletMismatch);
}

#[test]
fn daily_cap_covers_owner_and_agent_and_extra_needs_the_owners_own_approval() {
    let mut t = setup(); t.create(); t.allow(AMY); t.link();
    assert_eq!(direct_err(t.pot(AMY, "setLimits", &SetLimitsParams { daily_cap: Some(HOUSE_MAX + 1) })), Error::BadCap);
    t.pot(AMY, "setLimits", &SetLimitsParams { daily_cap: Some(5 * PRICE) }).unwrap(); // EUR 10 a day
    t.buy(AGENT, 0, 3).unwrap();
    t.buy(AMY, 1, 2).unwrap(); // Amy herself: 5 cards = the cap
    assert_eq!(t.player(AMY).left_today, 0);
    // pre-check gives the same answer the hook will
    let r = t.chain.contract_invoke(AGENT, Address::Account(AGENT), Energy::from(100_000), UpdateContractPayload {
        amount: Amount::zero(), address: t.pot, receive_name: OwnedReceiveName::new_unchecked("eventscope.canBuy".into()),
        message: OwnedParameter::from_serial(&CanBuyParams { account: AGENT, event_id: 0, outcome: 0, count: 1 }).unwrap() });
    assert_eq!(direct_err(r), Error::OverDailyCap);
    assert_eq!(pot_err(t.buy(AGENT, 0, 1)), Error::OverDailyCap);
    // the agent cannot consent for its owner
    assert_eq!(direct_err(t.pot(AGENT, "approveExtra", &PRICE)), Error::OnlyAccounts);
    t.pot(AMY, "approveExtra", &PRICE).unwrap(); // Amy approves one more card
    t.buy(AGENT, 0, 1).unwrap();
    assert_eq!(pot_err(t.buy(AGENT, 0, 1)), Error::OverDailyCap);
    let p = t.player(AMY);
    assert_eq!((p.daily_cap, p.spent_today, p.extra_today, p.left_today), (5 * PRICE, 6 * PRICE, PRICE, 0));
    // next day: fresh budget, approved extra is gone
    let id = { t.chain.tick_block_time(Duration::from_millis(DAY_MS)).unwrap(); t.allow(AMY); t.create() };
    t.buy_raw(AGENT, id, 0, 5, 5 * PRICE).unwrap();
    assert_eq!(pot_err(t.buy_raw(AGENT, id, 0, 1, PRICE)), Error::OverDailyCap);
}

#[test]
fn house_maximum_applies_without_a_personal_cap() {
    let mut t = setup(); t.create(); t.allow(AMY); t.mint(AMY, 200_000_000);
    t.buy(AMY, 0, 50).unwrap(); // EUR 100 = house max
    assert_eq!(pot_err(t.buy(AMY, 0, 1)), Error::OverDailyCap);
    t.pot(AMY, "approveExtra", &(10 * PRICE)).unwrap(); // extra never lifts the house maximum
    assert_eq!(pot_err(t.buy(AMY, 0, 1)), Error::OverDailyCap);
}

#[test]
fn pause_me_blocks_owner_and_agent_cannot_be_shortened_and_claims_still_work() {
    let mut t = setup(); t.create(); t.allow(AMY); t.link();
    t.buy(AMY, 0, 1).unwrap();
    t.pot(AMY, "pauseMe", &30u32).unwrap();
    assert_eq!(pot_err(t.buy(AMY, 0, 1)), Error::SelfExcluded);
    assert_eq!(pot_err(t.buy(AGENT, 0, 1)), Error::SelfExcluded);
    let until = t.player(AMY).paused_until.unwrap();
    t.pot(AMY, "pauseMe", &1u32).unwrap(); // does not shorten
    assert_eq!(t.player(AMY).paused_until.unwrap(), until);
    t.resolve(0);
    t.pot(AMY, "claim", &0u64).unwrap(); // winnings are still paid out
    assert_eq!(t.acct(AMY), MINT);
}

#[test]
fn results_agent_posts_with_evidence_dispute_window_then_final_and_automatic_payout() {
    let mut t = setup(); t.create(); t.allow(AMY); t.allow(CAL);
    t.buy(AMY, 0, 1).unwrap();
    t.buy(CAL, 1, 1).unwrap();
    // too early, and only the registered results agent
    assert_eq!(direct_err(t.propose(0, 0)), Error::TooEarly);
    t.to_close(0);
    assert_eq!(direct_err(t.pot(AMY, "proposeResult", &ProposeParams { event_id: 0, winning_outcome: 0, evidence_hash: [0; 32], source_url: "x".into() })), Error::NotResolver);
    t.propose(0, 1).unwrap(); // a wrong result
    assert_eq!(direct_err(t.propose(0, 0)), Error::AlreadyProposed);
    let ev: EventData = t.view("viewEvent", &0u64);
    assert_eq!(ev.proposal.as_ref().map(|p| (p.outcome, p.evidence_hash, p.agent_id)), Some((1, [0xab; 32], RESULTS_AGENT_ID)));
    assert_eq!(direct_err(t.pot(AMY, "claim", &0u64)), Error::NotResolved);
    assert_eq!(direct_err(t.pot(BEN, "dispute", &0u64)), Error::NotAHolder);
    assert_eq!(direct_err(t.pot(CAL, "finalize", &0u64)), Error::DisputeWindowOpen);
    t.pot(AMY, "dispute", &0u64).unwrap(); // a holder disputes inside the window
    let ev: EventData = t.view("viewEvent", &0u64);
    assert_eq!((ev.proposal.is_none(), ev.disputes), (true, 1));
    t.propose(0, 0).unwrap(); // corrected result
    t.tick_window();
    assert_eq!(direct_err(t.pot(CAL, "dispute", &0u64)), Error::DisputeWindowOver);
    t.pot(BEN, "finalize", &0u64).unwrap(); // anyone
    let r = t.pot(RESOLVER, "payout", &PayoutParams { event_id: 0, accounts: vec![AMY, CAL, BEN] }).unwrap();
    assert_eq!(r.parse_return_value::<u64>().unwrap(), 2 * PRICE);
    assert_eq!(t.acct(AMY), MINT + PRICE);
    let r = t.pot(RESOLVER, "payout", &PayoutParams { event_id: 0, accounts: vec![AMY] }).unwrap();
    assert_eq!(r.parse_return_value::<u64>().unwrap(), 0); // never twice
    assert_eq!(direct_err(t.pot(AMY, "claim", &0u64)), Error::AlreadyClaimed);
}

#[test]
fn resolver_needs_an_active_registry_entry() {
    let mut t = setup(); t.create();
    assert_eq!(direct_err(t.pot(AMY, "setResolver", &SetResolverParams { account: CAL, agent_id: Some(RESULTS_AGENT_ID) })), Error::NotOperator);
    assert_eq!(direct_err(t.pot(OP, "setResolver", &SetResolverParams { account: CAL, agent_id: Some(RESULTS_AGENT_ID) })), Error::AgentWalletMismatch);
    t.reg(RESULTS_AGENT_ID, OP, Some(RESOLVER), false); // results agent revoked
    t.to_close(0);
    assert_eq!(direct_err(t.propose(0, 0)), Error::AgentNotActive);
}

#[test]
fn buying_after_a_result_is_posted_is_refused() {
    let mut t = setup(); t.create(); t.allow(AMY);
    t.to_close(0);
    t.propose(0, 0).unwrap();
    assert_eq!(pot_err(t.buy(AMY, 0, 1)), Error::EventNotOpen);
}
