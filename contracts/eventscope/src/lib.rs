//! EventScope: collectible prize cards tied to real events, paid in a CIS-2 token (the EUR-demo play-money token on testnet).
//!
//! - The operator (fed by the automatic events feed) creates an event with 2..=8 outcomes, a category and a source reference.
//! - Only accounts the verifier has marked as allowed (after a zero-knowledge account proof of 18+ and country, checked
//!   off-chain) can hold cards. The allow flag has an expiry time.
//! - Buying = a CIS-2 `transfer` of exactly `card_price * count` tokens to this contract with (event, outcome, count) in
//!   `data`. The token calls `onReceivingCIS2`; any refusal rejects the whole transfer, so the buyer keeps the tokens.
//! - Buyer agents: a person links an agent from Concordium's CIS-8004 Agent Registry (`linkAgent`). The pot reads the
//!   registry ON CHAIN (`agentOf`) at link time and again at every agent purchase: the record must be Active, owned by
//!   the person, and its `agent_wallet` must be the paying account. Cards bought by the agent belong to the person.
//! - Responsible play, enforced here: a daily spending cap per person (house maximum, the person can set lower), a buy
//!   above the cap only goes through after the person's own signed `approveExtra`, and `pauseMe` self-exclusion that
//!   nobody can shorten. Both apply to the person and to all of their agents.
//! - Results: a results agent (registered in the Agent Registry, checked on chain) posts the winning outcome plus the
//!   SHA-256 of the official source. A dispute window follows (holders or the operator can dispute). After it, anyone can
//!   `finalize`, and anyone can trigger `payout` to push prizes to holders. Each winning card gets an equal share.
//!   No house edge: the fee is 0. No winner, or a cancelled event, means everyone is refunded in full.
#![no_std]
use concordium_cis2::*;
use concordium_std::*;

pub type TokenId = TokenIdUnit;
pub type TokenAmount = TokenAmountU64;

pub type EventId = u64;
pub const MAX_OUTCOMES: usize = 8;
pub const MAX_CARDS_PER_BUY: u32 = 1000;
pub const DAY_MS: u64 = 86_400_000;

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Open,
    Resolved(u8),
    Cancelled,
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Proposal {
    pub outcome: u8,
    /// SHA-256 of the official source response the results agent read.
    pub evidence_hash: [u8; 32],
    pub source_url: String,
    pub proposed_at: Timestamp,
    pub resolver: AccountAddress,
    pub agent_id: u64,
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct EventData {
    pub title: String,
    /// e.g. "football", "basketball", "crypto", "weather"
    pub category: String,
    /// Where the result comes from, e.g. "espn:soccer/eng.1:740123" or "coinbase:BTC-USD:1795100700".
    pub source_ref: String,
    pub outcomes: Vec<String>,
    /// Token base units per card (EUR-demo has 6 decimals).
    pub card_price: u64,
    /// No new cards after this time; results only after it.
    pub closes_at: Timestamp,
    pub status: Status,
    pub pot: u64,
    /// Number of cards sold per outcome, same order as `outcomes`.
    pub cards_sold: Vec<u64>,
    pub paid_out: u64,
    pub proposal: Option<Proposal>,
    pub disputes: u32,
}

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Player {
    /// Personal daily cap in token units; `None` = the house maximum.
    pub daily_cap: Option<u64>,
    /// Day number (ms / 86 400 000) that `spent` and `extra` refer to.
    pub day: u64,
    pub spent: u64,
    /// Extra spending the person approved for `day` only.
    pub extra: u64,
    pub paused_until: Option<Timestamp>,
}

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub struct AgentLink {
    pub owner: AccountAddress,
    pub agent_id: u64,
}

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    operator: AccountAddress,
    /// The only CIS-2 contract (and token) accepted for payment.
    token: ContractAddress,
    verifier: AccountAddress,
    /// CIS-8004 Agent Registry (testnet 12802,0).
    registry: ContractAddress,
    max_daily_spend: u64,
    dispute_window_ms: u64,
    next_event: EventId,
    events: StateMap<EventId, EventData, S>,
    /// account -> allowed until this time
    allowed: StateMap<AccountAddress, Timestamp, S>,
    /// (event, outcome, account) -> number of cards
    cards: StateMap<(EventId, u8, AccountAddress), u64, S>,
    /// (event, account) that already claimed
    claimed: StateSet<(EventId, AccountAddress), S>,
    players: StateMap<AccountAddress, Player, S>,
    /// agent wallet account -> owner and registry token id
    agents: StateMap<AccountAddress, AgentLink, S>,
    /// results agent account -> registry token id
    resolvers: StateMap<AccountAddress, u64, S>,
}

#[derive(Serialize, SchemaType, Reject, PartialEq, Eq, Debug)]
pub enum Error {
    #[from(ParseError)]
    ParseParams,
    NotOperator,
    NotVerifier,
    OnlyAccounts,
    NotVerified,
    VerificationExpired,
    UnknownEvent,
    UnknownOutcome,
    BadOutcomes,
    EventNotOpen,
    EventClosed,
    WrongAmount,
    BadCount,
    NotResolved,
    NothingToClaim,
    AlreadyClaimed,
    Overflow,
    TransferFailed,
    WrongToken,
    MissingPurchaseData,
    // new in step 4
    OverDailyCap,
    SelfExcluded,
    RegistryUnavailable,
    AgentNotFound,
    AgentNotActive,
    AgentNotOwnedBySender,
    AgentHasNoWallet,
    AgentWalletMismatch,
    NotResolver,
    TooEarly,
    AlreadyProposed,
    NoProposal,
    DisputeWindowOver,
    DisputeWindowOpen,
    NotAHolder,
    BadCap,
}

impl<T> From<CallContractError<T>> for Error {
    fn from(_: CallContractError<T>) -> Self { Error::TransferFailed }
}

// ------------------------------------------------------------------ CIS-8004 registry record (same wire layout as 12802,0)
#[derive(Serialize, Clone)]
pub enum RegKind { Cis8 { namespace: String, key_type: String, public_key: Vec<u8> } }
#[derive(Serialize, Clone)]
pub struct RegExternalReference { pub contract_address: ContractAddress, pub kind: RegKind }
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RegStatus { Active, Revoked }
#[derive(Serialize, Clone)]
pub struct RegMeta { pub key: String, pub value: Vec<u8> }
#[derive(Serialize, Clone)]
pub struct RegAgent {
    pub token_id: TokenIdVec,
    pub owner_account: AccountAddress,
    pub agent_uri: Option<String>,
    pub metadata_hash: Option<[u8; 32]>,
    pub external_reference: Option<RegExternalReference>,
    pub agent_wallet: Option<AccountAddress>,
    pub status: RegStatus,
    pub registered_at: Timestamp,
    pub revoked_at: Option<Timestamp>,
    pub revocation_reason: Option<String>,
    pub on_chain_metadata: Vec<RegMeta>,
}

/// Read one agent from the registry contract, on chain.
fn registry_agent(host: &Host<State>, agent_id: u64) -> Result<RegAgent, Error> {
    let registry = host.state().registry;
    let id = TokenIdVec(agent_id.to_le_bytes().to_vec());
    let rv = host
        .invoke_contract_read_only(&registry, &id, EntrypointName::new_unchecked("agentOf"), Amount::zero())
        .map_err(|_| Error::RegistryUnavailable)?
        .ok_or(Error::RegistryUnavailable)?;
    let mut rv = rv;
    let rec: Option<RegAgent> = rv.get().map_err(|_| Error::RegistryUnavailable)?;
    rec.ok_or(Error::AgentNotFound)
}

// ------------------------------------------------------------------ parameters and views
#[derive(Serialize, SchemaType)]
pub struct InitParams {
    /// Account allowed to set allow flags (the verifier backend). Can equal the operator.
    pub verifier: AccountAddress,
    /// CIS-2 token contract used for cards and prizes (token id: unit, i.e. empty).
    pub token: ContractAddress,
    /// CIS-8004 Agent Registry contract.
    pub registry: ContractAddress,
    /// House maximum a person can spend per day (token units).
    pub max_daily_spend: u64,
    /// How long a posted result can be disputed before it is final.
    pub dispute_window_ms: u64,
}

#[derive(Serialize, SchemaType)]
pub struct SetAllowedParams {
    pub account: AccountAddress,
    /// `None` removes the flag.
    pub until: Option<Timestamp>,
}

#[derive(Serialize, SchemaType)]
pub struct CreateEventParams {
    pub title: String,
    pub category: String,
    pub source_ref: String,
    pub outcomes: Vec<String>,
    pub card_price: u64,
    pub closes_at: Timestamp,
}

#[derive(Serialize, SchemaType)]
pub struct BuyParams {
    pub event_id: EventId,
    pub outcome: u8,
    pub count: u32,
}

#[derive(Serialize, SchemaType)]
pub struct ProposeParams {
    pub event_id: EventId,
    pub winning_outcome: u8,
    pub evidence_hash: [u8; 32],
    pub source_url: String,
}

#[derive(Serialize, SchemaType)]
pub struct PayoutParams {
    pub event_id: EventId,
    pub accounts: Vec<AccountAddress>,
}

#[derive(Serialize, SchemaType)]
pub struct SetResolverParams {
    pub account: AccountAddress,
    /// `None` removes the resolver.
    pub agent_id: Option<u64>,
}

#[derive(Serialize, SchemaType)]
pub struct HoldingParams {
    pub event_id: EventId,
    pub account: AccountAddress,
}

#[derive(Serialize, SchemaType, PartialEq, Eq, Debug)]
pub struct HoldingView {
    /// Cards per outcome.
    pub cards: Vec<u64>,
    pub claimed: bool,
    /// What `claim` would pay now (0 if not claimable).
    pub claimable: u64,
}

#[derive(Serialize, SchemaType, PartialEq, Eq, Debug)]
pub struct ConfigView {
    pub operator: AccountAddress,
    pub verifier: AccountAddress,
    pub token: ContractAddress,
    pub registry: ContractAddress,
    pub next_event: EventId,
    pub fee_basis_points: u16,
    pub max_daily_spend: u64,
    pub dispute_window_ms: u64,
}

#[derive(Serialize, SchemaType, PartialEq, Eq, Debug)]
pub struct PlayerView {
    pub allowed_until: Option<Timestamp>,
    pub daily_cap: u64,
    pub spent_today: u64,
    pub extra_today: u64,
    pub left_today: u64,
    pub paused_until: Option<Timestamp>,
}

#[derive(Serialize, SchemaType)]
pub struct CanBuyParams {
    pub account: AccountAddress,
    pub event_id: EventId,
    pub outcome: u8,
    pub count: u32,
}

/// Logged events, so the web page, the collection and the explorer can follow what happened.
#[derive(Serialize, SchemaType)]
#[concordium(repr(u8))]
pub enum Log {
    #[concordium(tag = 0)]
    EventCreated { event_id: EventId },
    #[concordium(tag = 1)]
    Allowed { account: AccountAddress, until: Option<Timestamp> },
    /// `serial_from` = number of cards of this outcome sold before, so these cards are #serial_from+1 .. #serial_from+count.
    #[concordium(tag = 2)]
    CardsBought { event_id: EventId, account: AccountAddress, outcome: u8, count: u32, paid: u64, serial_from: u64, agent_id: Option<u64> },
    #[concordium(tag = 3)]
    Resolved { event_id: EventId, winning_outcome: u8 },
    #[concordium(tag = 4)]
    Cancelled { event_id: EventId },
    #[concordium(tag = 5)]
    Claimed { event_id: EventId, account: AccountAddress, amount: u64 },
    #[concordium(tag = 6)]
    ResultProposed { event_id: EventId, winning_outcome: u8, evidence_hash: [u8; 32], resolver: AccountAddress, agent_id: u64 },
    #[concordium(tag = 7)]
    Disputed { event_id: EventId, by: AccountAddress },
    #[concordium(tag = 8)]
    AgentLinked { owner: AccountAddress, agent_wallet: AccountAddress, agent_id: u64 },
    #[concordium(tag = 9)]
    AgentUnlinked { owner: AccountAddress, agent_wallet: AccountAddress },
    #[concordium(tag = 10)]
    LimitsSet { account: AccountAddress, daily_cap: Option<u64> },
    #[concordium(tag = 11)]
    ExtraApproved { account: AccountAddress, amount: u64, day: u64 },
    #[concordium(tag = 12)]
    Paused { account: AccountAddress, until: Timestamp },
    #[concordium(tag = 13)]
    ResolverSet { account: AccountAddress, agent_id: Option<u64> },
}

fn sender_account(ctx: &ReceiveContext) -> Result<AccountAddress, Error> {
    match ctx.sender() {
        Address::Account(a) => Ok(a),
        Address::Contract(_) => Err(Error::OnlyAccounts),
    }
}

fn day_of(t: Timestamp) -> u64 { t.timestamp_millis() / DAY_MS }

/// Player record with `spent` and `extra` rolled over to today.
fn player_today(st: &State, a: &AccountAddress, now: Timestamp) -> Player {
    let mut p = st.players.get(a).map(|p| *p).unwrap_or_default();
    let d = day_of(now);
    if p.day != d { p.day = d; p.spent = 0; p.extra = 0; }
    p
}

fn cap_of(st: &State, p: &Player) -> u64 {
    match p.daily_cap { Some(c) if c < st.max_daily_spend => c, _ => st.max_daily_spend }
}

fn left_today(st: &State, p: &Player) -> u64 {
    // approved extra lifts the personal cap; the house maximum stays a hard ceiling
    cap_of(st, p).saturating_add(p.extra).min(st.max_daily_spend).saturating_sub(p.spent)
}

/// Payout for `account` in `ev`, given its cards. Pure function, used by `claim`, `payout` and the view.
fn payout_for(ev: &EventData, holding: &[u64]) -> Result<u64, Error> {
    let refund = |h: &[u64]| -> Result<u64, Error> {
        let n: u64 = h.iter().try_fold(0u64, |a, x| a.checked_add(*x)).ok_or(Error::Overflow)?;
        ev.card_price.checked_mul(n).ok_or(Error::Overflow)
    };
    match ev.status {
        Status::Open => Err(Error::NotResolved),
        Status::Cancelled => refund(holding),
        Status::Resolved(w) => {
            let winning_total = ev.cards_sold[w as usize];
            if winning_total == 0 {
                // Nobody picked the winner: everyone gets their money back.
                return refund(holding);
            }
            let mine = holding[w as usize];
            // equal share per winning card; rounding dust stays in the contract
            Ok(((ev.pot as u128) * (mine as u128) / (winning_total as u128)) as u64)
        }
    }
}

fn holding_of(state: &State, event_id: EventId, n_outcomes: usize, account: AccountAddress) -> Vec<u64> {
    (0..n_outcomes)
        .map(|o| state.cards.get(&(event_id, o as u8, account)).map(|c| *c).unwrap_or(0))
        .collect()
}

#[init(contract = "eventscope", parameter = "InitParams", event = "Log")]
fn init(ctx: &InitContext, state_builder: &mut StateBuilder) -> InitResult<State> {
    let p: InitParams = ctx.parameter_cursor().get()?;
    Ok(State {
        operator: ctx.init_origin(),
        token: p.token,
        verifier: p.verifier,
        registry: p.registry,
        max_daily_spend: p.max_daily_spend,
        dispute_window_ms: p.dispute_window_ms,
        next_event: 0,
        events: state_builder.new_map(),
        allowed: state_builder.new_map(),
        cards: state_builder.new_map(),
        claimed: state_builder.new_set(),
        players: state_builder.new_map(),
        agents: state_builder.new_map(),
        resolvers: state_builder.new_map(),
    })
}

#[receive(contract = "eventscope", name = "setAllowed", parameter = "SetAllowedParams", error = "Error", mutable, enable_logger)]
fn set_allowed(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let p: SetAllowedParams = ctx.parameter_cursor().get()?;
    let s = sender_account(ctx)?;
    let st = host.state_mut();
    ensure!(s == st.verifier || s == st.operator, Error::NotVerifier);
    match p.until {
        Some(t) => { let _ = st.allowed.insert(p.account, t); }
        None => { let _ = st.allowed.remove(&p.account); }
    }
    logger.log(&Log::Allowed { account: p.account, until: p.until }).map_err(|_| Error::Overflow)?;
    Ok(())
}

#[receive(contract = "eventscope", name = "createEvent", parameter = "CreateEventParams", error = "Error", mutable, enable_logger)]
fn create_event(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<EventId, Error> {
    let p: CreateEventParams = ctx.parameter_cursor().get()?;
    let st = host.state_mut();
    ensure!(sender_account(ctx)? == st.operator, Error::NotOperator);
    ensure!(p.outcomes.len() >= 2 && p.outcomes.len() <= MAX_OUTCOMES, Error::BadOutcomes);
    ensure!(p.card_price > 0, Error::WrongAmount);
    let id = st.next_event;
    st.next_event += 1;
    let n = p.outcomes.len();
    let _ = st.events.insert(id, EventData {
        title: p.title,
        category: p.category,
        source_ref: p.source_ref,
        outcomes: p.outcomes,
        card_price: p.card_price,
        closes_at: p.closes_at,
        status: Status::Open,
        pot: 0,
        cards_sold: vec![0; n],
        paid_out: 0,
        proposal: None,
        disputes: 0,
    });
    logger.log(&Log::EventCreated { event_id: id }).map_err(|_| Error::Overflow)?;
    Ok(id)
}

/// Who a purchase is for, after the agent and responsible-play checks. Read-only (registry read is read-only too).
/// Returns (person, agent id, updated player record, cost, serial_from).
fn check_purchase(host: &Host<State>, buyer: AccountAddress, now: Timestamp, p: &BuyParams)
    -> Result<(AccountAddress, Option<u64>, Player, u64, u64), Error> {
    // 1. agent? then the registry must still say: Active, same owner, this wallet
    let link = host.state().agents.get(&buyer).map(|l| *l);
    let (person, agent_id) = match link {
        Some(l) => {
            let rec = registry_agent(host, l.agent_id)?;
            ensure!(rec.status == RegStatus::Active, Error::AgentNotActive);
            ensure!(rec.owner_account == l.owner, Error::AgentNotOwnedBySender);
            ensure!(rec.agent_wallet == Some(buyer), Error::AgentWalletMismatch);
            (l.owner, Some(l.agent_id))
        }
        None => (buyer, None),
    };
    let st = host.state();
    // 2. the person must hold a valid verification
    let until = st.allowed.get(&person).map(|t| *t).ok_or(Error::NotVerified)?;
    ensure!(now <= until, Error::VerificationExpired);
    // 3. self-exclusion
    let mut pl = player_today(st, &person, now);
    if let Some(t) = pl.paused_until { ensure!(now >= t, Error::SelfExcluded); }
    // 4. the purchase itself
    ensure!(p.count > 0 && p.count <= MAX_CARDS_PER_BUY, Error::BadCount);
    let ev = st.events.get(&p.event_id).map(|e| e.clone()).ok_or(Error::UnknownEvent)?;
    ensure!(ev.status == Status::Open && ev.proposal.is_none(), Error::EventNotOpen);
    ensure!(now < ev.closes_at, Error::EventClosed);
    ensure!((p.outcome as usize) < ev.outcomes.len(), Error::UnknownOutcome);
    let cost = ev.card_price.checked_mul(p.count as u64).ok_or(Error::Overflow)?;
    // 5. daily cap (person + all agents together)
    ensure!(cost <= left_today(st, &pl), Error::OverDailyCap);
    pl.spent = pl.spent.checked_add(cost).ok_or(Error::Overflow)?;
    let serial_from = ev.cards_sold[p.outcome as usize];
    Ok((person, agent_id, pl, cost, serial_from))
}

/// CIS-2 receive hook: a card purchase. Called by the token contract while it transfers `amount` from the buyer to this
/// contract. `data` must hold `BuyParams`. Any error rejects the whole token transfer, so a refused buyer pays nothing.
#[receive(contract = "eventscope", name = "onReceivingCIS2", error = "Error", mutable, enable_logger)]
fn on_receiving_cis2(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    // 0. only the configured token contract can pay
    ensure!(ctx.sender() == Address::Contract(host.state().token), Error::WrongToken);
    let r: OnReceivingCis2Params<TokenId, TokenAmount> = ctx.parameter_cursor().get()?;
    ensure!(!r.data.as_ref().is_empty(), Error::MissingPurchaseData);
    let p: BuyParams = from_bytes(r.data.as_ref()).map_err(|_| Error::ParseParams)?;
    let buyer = match r.from { Address::Account(a) => a, Address::Contract(_) => return Err(Error::OnlyAccounts) };
    let now = ctx.metadata().slot_time();
    let (person, agent_id, pl, cost, serial_from) = check_purchase(host, buyer, now, &p)?;
    ensure!(r.amount.0 == cost, Error::WrongAmount);
    let st = host.state_mut();
    let mut ev = st.events.get(&p.event_id).map(|e| e.clone()).ok_or(Error::UnknownEvent)?;
    ev.pot = ev.pot.checked_add(cost).ok_or(Error::Overflow)?;
    ev.cards_sold[p.outcome as usize] += p.count as u64;
    let _ = st.events.insert(p.event_id, ev);
    let _ = st.players.insert(person, pl);
    let key = (p.event_id, p.outcome, person);
    let prev = st.cards.get(&key).map(|c| *c).unwrap_or(0);
    let _ = st.cards.insert(key, prev + p.count as u64);
    logger.log(&Log::CardsBought { event_id: p.event_id, account: person, outcome: p.outcome, count: p.count, paid: cost, serial_from, agent_id })
        .map_err(|_| Error::Overflow)?;
    Ok(())
}

// ------------------------------------------------------------------ responsible play (signed by the person only)
#[derive(Serialize, SchemaType)]
pub struct SetLimitsParams { pub daily_cap: Option<u64> }

#[receive(contract = "eventscope", name = "setLimits", parameter = "SetLimitsParams", error = "Error", mutable, enable_logger)]
fn set_limits(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let p: SetLimitsParams = ctx.parameter_cursor().get()?;
    let who = sender_account(ctx)?;
    let now = ctx.metadata().slot_time();
    let st = host.state_mut();
    if let Some(c) = p.daily_cap { ensure!(c <= st.max_daily_spend, Error::BadCap); }
    let mut pl = player_today(st, &who, now);
    pl.daily_cap = p.daily_cap;
    let _ = st.players.insert(who, pl);
    logger.log(&Log::LimitsSet { account: who, daily_cap: p.daily_cap }).map_err(|_| Error::Overflow)?;
    Ok(())
}

/// The person's own consent to spend `amount` more than their cap today (for example after their agent was refused).
#[receive(contract = "eventscope", name = "approveExtra", parameter = "u64", error = "Error", mutable, enable_logger)]
fn approve_extra(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let amount: u64 = ctx.parameter_cursor().get()?;
    let who = sender_account(ctx)?;
    let now = ctx.metadata().slot_time();
    let st = host.state_mut();
    ensure!(st.agents.get(&who).is_none(), Error::OnlyAccounts); // an agent can never approve for its owner
    let mut pl = player_today(st, &who, now);
    pl.extra = pl.extra.checked_add(amount).ok_or(Error::Overflow)?;
    let day = pl.day;
    let _ = st.players.insert(who, pl);
    logger.log(&Log::ExtraApproved { account: who, amount, day }).map_err(|_| Error::Overflow)?;
    Ok(())
}

/// Self-exclusion for `days` days. Can be extended, never shortened, by anyone (the operator included).
#[receive(contract = "eventscope", name = "pauseMe", parameter = "u32", error = "Error", mutable, enable_logger)]
fn pause_me(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let days: u32 = ctx.parameter_cursor().get()?;
    let who = sender_account(ctx)?;
    let now = ctx.metadata().slot_time();
    ensure!(days > 0, Error::BadCount);
    let st = host.state_mut();
    let mut pl = player_today(st, &who, now);
    let until = Timestamp::from_timestamp_millis(now.timestamp_millis().saturating_add((days as u64).saturating_mul(DAY_MS)));
    let until = match pl.paused_until { Some(t) if t > until => t, _ => until };
    pl.paused_until = Some(until);
    let _ = st.players.insert(who, pl);
    logger.log(&Log::Paused { account: who, until }).map_err(|_| Error::Overflow)?;
    Ok(())
}

// ------------------------------------------------------------------ buyer agents (CIS-8004 registry, read on chain)
#[receive(contract = "eventscope", name = "linkAgent", parameter = "u64", error = "Error", mutable, enable_logger)]
fn link_agent(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<AccountAddress, Error> {
    let agent_id: u64 = ctx.parameter_cursor().get()?;
    let owner = sender_account(ctx)?;
    let rec = registry_agent(host, agent_id)?;
    ensure!(rec.status == RegStatus::Active, Error::AgentNotActive);
    ensure!(rec.owner_account == owner, Error::AgentNotOwnedBySender);
    let wallet = rec.agent_wallet.ok_or(Error::AgentHasNoWallet)?;
    ensure!(wallet != owner, Error::AgentWalletMismatch);
    let _ = host.state_mut().agents.insert(wallet, AgentLink { owner, agent_id });
    logger.log(&Log::AgentLinked { owner, agent_wallet: wallet, agent_id }).map_err(|_| Error::Overflow)?;
    Ok(wallet)
}

/// The owner (or the agent itself) removes the link. A revoked registry entry also stops the agent at once.
#[receive(contract = "eventscope", name = "unlinkAgent", parameter = "AccountAddress", error = "Error", mutable, enable_logger)]
fn unlink_agent(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let wallet: AccountAddress = ctx.parameter_cursor().get()?;
    let who = sender_account(ctx)?;
    let st = host.state_mut();
    let l = st.agents.get(&wallet).map(|l| *l).ok_or(Error::AgentNotFound)?;
    ensure!(who == l.owner || who == wallet, Error::AgentNotOwnedBySender);
    let _ = st.agents.remove(&wallet);
    logger.log(&Log::AgentUnlinked { owner: l.owner, agent_wallet: wallet }).map_err(|_| Error::Overflow)?;
    Ok(())
}

// ------------------------------------------------------------------ results agent, dispute window, payout
#[receive(contract = "eventscope", name = "setResolver", parameter = "SetResolverParams", error = "Error", mutable, enable_logger)]
fn set_resolver(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let p: SetResolverParams = ctx.parameter_cursor().get()?;
    ensure!(sender_account(ctx)? == host.state().operator, Error::NotOperator);
    match p.agent_id {
        Some(id) => {
            let rec = registry_agent(host, id)?;
            ensure!(rec.status == RegStatus::Active, Error::AgentNotActive);
            ensure!(rec.agent_wallet == Some(p.account) || rec.owner_account == p.account, Error::AgentWalletMismatch);
            let _ = host.state_mut().resolvers.insert(p.account, id);
        }
        None => { let _ = host.state_mut().resolvers.remove(&p.account); }
    }
    logger.log(&Log::ResolverSet { account: p.account, agent_id: p.agent_id }).map_err(|_| Error::Overflow)?;
    Ok(())
}

#[receive(contract = "eventscope", name = "proposeResult", parameter = "ProposeParams", error = "Error", mutable, enable_logger)]
fn propose_result(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let p: ProposeParams = ctx.parameter_cursor().get()?;
    let who = sender_account(ctx)?;
    let now = ctx.metadata().slot_time();
    let agent_id = host.state().resolvers.get(&who).map(|x| *x).ok_or(Error::NotResolver)?;
    let rec = registry_agent(host, agent_id)?;
    ensure!(rec.status == RegStatus::Active, Error::AgentNotActive);
    ensure!(rec.agent_wallet == Some(who) || rec.owner_account == who, Error::AgentWalletMismatch);
    let st = host.state_mut();
    let mut ev = st.events.get(&p.event_id).map(|e| e.clone()).ok_or(Error::UnknownEvent)?;
    ensure!(ev.status == Status::Open, Error::EventNotOpen);
    ensure!(ev.proposal.is_none(), Error::AlreadyProposed);
    ensure!(now >= ev.closes_at, Error::TooEarly);
    ensure!((p.winning_outcome as usize) < ev.outcomes.len(), Error::UnknownOutcome);
    ev.proposal = Some(Proposal { outcome: p.winning_outcome, evidence_hash: p.evidence_hash, source_url: p.source_url, proposed_at: now, resolver: who, agent_id });
    let _ = st.events.insert(p.event_id, ev);
    logger.log(&Log::ResultProposed { event_id: p.event_id, winning_outcome: p.winning_outcome, evidence_hash: p.evidence_hash, resolver: who, agent_id })
        .map_err(|_| Error::Overflow)?;
    Ok(())
}

/// A card holder of this event, or the operator, disputes the posted result inside the window. The result is cleared,
/// so a new one must be posted (or the operator cancels the event and everyone is refunded).
#[receive(contract = "eventscope", name = "dispute", parameter = "EventId", error = "Error", mutable, enable_logger)]
fn dispute(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let id: EventId = ctx.parameter_cursor().get()?;
    let who = sender_account(ctx)?;
    let now = ctx.metadata().slot_time();
    let st = host.state_mut();
    let mut ev = st.events.get(&id).map(|e| e.clone()).ok_or(Error::UnknownEvent)?;
    let pr = ev.proposal.clone().ok_or(Error::NoProposal)?;
    ensure!(now.timestamp_millis() < pr.proposed_at.timestamp_millis().saturating_add(st.dispute_window_ms), Error::DisputeWindowOver);
    let holds = holding_of(st, id, ev.outcomes.len(), who).iter().any(|c| *c > 0);
    ensure!(who == st.operator || holds, Error::NotAHolder);
    ev.proposal = None;
    ev.disputes += 1;
    let _ = st.events.insert(id, ev);
    logger.log(&Log::Disputed { event_id: id, by: who }).map_err(|_| Error::Overflow)?;
    Ok(())
}

/// Anyone can make an undisputed result final once the dispute window has passed.
#[receive(contract = "eventscope", name = "finalize", parameter = "EventId", error = "Error", mutable, enable_logger)]
fn finalize(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let id: EventId = ctx.parameter_cursor().get()?;
    let now = ctx.metadata().slot_time();
    let st = host.state_mut();
    let mut ev = st.events.get(&id).map(|e| e.clone()).ok_or(Error::UnknownEvent)?;
    ensure!(ev.status == Status::Open, Error::EventNotOpen);
    let pr = ev.proposal.clone().ok_or(Error::NoProposal)?;
    ensure!(now.timestamp_millis() >= pr.proposed_at.timestamp_millis().saturating_add(st.dispute_window_ms), Error::DisputeWindowOpen);
    ev.status = Status::Resolved(pr.outcome);
    let _ = st.events.insert(id, ev);
    logger.log(&Log::Resolved { event_id: id, winning_outcome: pr.outcome }).map_err(|_| Error::Overflow)?;
    Ok(())
}

#[receive(contract = "eventscope", name = "cancel", parameter = "EventId", error = "Error", mutable, enable_logger)]
fn cancel(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let id: EventId = ctx.parameter_cursor().get()?;
    let st = host.state_mut();
    ensure!(sender_account(ctx)? == st.operator, Error::NotOperator);
    let mut ev = st.events.get(&id).map(|e| e.clone()).ok_or(Error::UnknownEvent)?;
    ensure!(ev.status == Status::Open, Error::EventNotOpen);
    ev.status = Status::Cancelled;
    ev.proposal = None;
    let _ = st.events.insert(id, ev);
    logger.log(&Log::Cancelled { event_id: id }).map_err(|_| Error::Overflow)?;
    Ok(())
}

/// Pay `who` what they are owed in event `id`. Returns 0 (and changes nothing) if nothing is owed or it was paid.
fn pay(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger, id: EventId, who: AccountAddress, strict: bool) -> Result<u64, Error> {
    let (amount, ev, token) = {
        let st = host.state();
        let ev = st.events.get(&id).map(|e| e.clone()).ok_or(Error::UnknownEvent)?;
        if st.claimed.contains(&(id, who)) { if strict { return Err(Error::AlreadyClaimed); } else { return Ok(0); } }
        let h = holding_of(st, id, ev.outcomes.len(), who);
        (payout_for(&ev, &h)?, ev, st.token)
    };
    if amount == 0 { if strict { return Err(Error::NothingToClaim); } else { return Ok(0); } }
    {
        // state is updated before the token transfer, so a second claim can never pay twice
        let st = host.state_mut();
        st.claimed.insert((id, who));
        let mut ev = ev;
        ev.paid_out = ev.paid_out.checked_add(amount).ok_or(Error::Overflow)?;
        let _ = st.events.insert(id, ev);
    }
    let t = TransferParams(vec![Transfer { token_id: TokenIdUnit(), amount: TokenAmountU64(amount), from: Address::Contract(ctx.self_address()),
        to: Receiver::Account(who), data: AdditionalData::empty() }]);
    host.invoke_contract(&token, &t, EntrypointName::new_unchecked("transfer"), Amount::zero())?;
    logger.log(&Log::Claimed { event_id: id, account: who, amount }).map_err(|_| Error::Overflow)?;
    Ok(amount)
}

#[receive(contract = "eventscope", name = "claim", parameter = "EventId", error = "Error", mutable, enable_logger)]
fn claim(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<u64, Error> {
    let id: EventId = ctx.parameter_cursor().get()?;
    let who = sender_account(ctx)?;
    pay(ctx, host, logger, id, who, true)
}

/// Automatic payout: anyone (in practice the results agent) pushes prizes to the listed holders. Prizes only ever go
/// to the holder's own account; accounts with nothing owed, or already paid, are skipped.
#[receive(contract = "eventscope", name = "payout", parameter = "PayoutParams", error = "Error", mutable, enable_logger)]
fn payout(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<u64, Error> {
    let p: PayoutParams = ctx.parameter_cursor().get()?;
    let mut total = 0u64;
    for a in p.accounts { total = total.saturating_add(pay(ctx, host, logger, p.event_id, a, false)?); }
    Ok(total)
}

// ------------------------------------------------------------------ views
#[receive(contract = "eventscope", name = "viewEvent", parameter = "EventId", return_value = "EventData", error = "Error")]
fn view_event(ctx: &ReceiveContext, host: &Host<State>) -> Result<EventData, Error> {
    let id: EventId = ctx.parameter_cursor().get()?;
    host.state().events.get(&id).map(|e| e.clone()).ok_or(Error::UnknownEvent)
}

#[receive(contract = "eventscope", name = "viewHolding", parameter = "HoldingParams", return_value = "HoldingView", error = "Error")]
fn view_holding(ctx: &ReceiveContext, host: &Host<State>) -> Result<HoldingView, Error> {
    let p: HoldingParams = ctx.parameter_cursor().get()?;
    let st = host.state();
    let ev = st.events.get(&p.event_id).map(|e| e.clone()).ok_or(Error::UnknownEvent)?;
    let cards = holding_of(st, p.event_id, ev.outcomes.len(), p.account);
    let claimed = st.claimed.contains(&(p.event_id, p.account));
    let claimable = if claimed { 0 } else { payout_for(&ev, &cards).unwrap_or(0) };
    Ok(HoldingView { cards, claimed, claimable })
}

/// Read-only pre-check the page and the buyer agent run before signing: same rules as `onReceivingCIS2`
/// (agent registry check, verification, self-exclusion, daily cap). Returns the token amount to send.
#[receive(contract = "eventscope", name = "canBuy", parameter = "CanBuyParams", return_value = "u64", error = "Error")]
fn can_buy(ctx: &ReceiveContext, host: &Host<State>) -> Result<u64, Error> {
    let p: CanBuyParams = ctx.parameter_cursor().get()?;
    let now = ctx.metadata().slot_time();
    let (_, _, _, cost, _) = check_purchase(host, p.account, now, &BuyParams { event_id: p.event_id, outcome: p.outcome, count: p.count })?;
    Ok(cost)
}

#[receive(contract = "eventscope", name = "isAllowed", parameter = "AccountAddress", return_value = "Option<Timestamp>", error = "Error")]
fn is_allowed(ctx: &ReceiveContext, host: &Host<State>) -> Result<Option<Timestamp>, Error> {
    let a: AccountAddress = ctx.parameter_cursor().get()?;
    Ok(host.state().allowed.get(&a).map(|t| *t))
}

#[receive(contract = "eventscope", name = "viewPlayer", parameter = "AccountAddress", return_value = "PlayerView", error = "Error")]
fn view_player(ctx: &ReceiveContext, host: &Host<State>) -> Result<PlayerView, Error> {
    let a: AccountAddress = ctx.parameter_cursor().get()?;
    let now = ctx.metadata().slot_time();
    let st = host.state();
    let pl = player_today(st, &a, now);
    Ok(PlayerView { allowed_until: st.allowed.get(&a).map(|t| *t), daily_cap: cap_of(st, &pl), spent_today: pl.spent, extra_today: pl.extra,
        left_today: left_today(st, &pl), paused_until: pl.paused_until })
}

#[receive(contract = "eventscope", name = "viewAgent", parameter = "AccountAddress", return_value = "Option<AgentLink>", error = "Error")]
fn view_agent(ctx: &ReceiveContext, host: &Host<State>) -> Result<Option<AgentLink>, Error> {
    let a: AccountAddress = ctx.parameter_cursor().get()?;
    Ok(host.state().agents.get(&a).map(|l| *l))
}

#[receive(contract = "eventscope", name = "viewResolver", parameter = "AccountAddress", return_value = "Option<u64>", error = "Error")]
fn view_resolver(ctx: &ReceiveContext, host: &Host<State>) -> Result<Option<u64>, Error> {
    let a: AccountAddress = ctx.parameter_cursor().get()?;
    Ok(host.state().resolvers.get(&a).map(|x| *x))
}

#[receive(contract = "eventscope", name = "viewConfig", return_value = "ConfigView", error = "Error")]
fn view_config(_ctx: &ReceiveContext, host: &Host<State>) -> Result<ConfigView, Error> {
    let st = host.state();
    Ok(ConfigView { operator: st.operator, verifier: st.verifier, token: st.token, registry: st.registry, next_event: st.next_event, fee_basis_points: 0,
        max_daily_spend: st.max_daily_spend, dispute_window_ms: st.dispute_window_ms })
}
