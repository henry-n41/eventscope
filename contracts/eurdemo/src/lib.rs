//! EUR-demo: a play-money euro token for the EventScope testnet demo (CIS-2, one token, 6 decimals).
//! Not real money and not redeemable. Only the admin (the EventScope operator) can mint;
//! the backend only mints to accounts that passed the zero-knowledge proof (checked off-chain).
#![no_std]
use concordium_cis2::*;
use concordium_std::*;

pub type ContractTokenId = TokenIdUnit;
pub type ContractTokenAmount = TokenAmountU64;
pub const TOKEN_ID: ContractTokenId = TokenIdUnit();
pub const SUPPORTS: [StandardIdentifier<'static>; 2] = [CIS0_STANDARD_IDENTIFIER, CIS2_STANDARD_IDENTIFIER];

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    admin: AccountAddress,
    metadata_url: String,
    total_supply: u64,
    balances: StateMap<Address, u64, S>,
    /// (owner, operator)
    operators: StateSet<(Address, Address), S>,
}

#[derive(Serialize, SchemaType, Reject, Debug, PartialEq, Eq)]
pub enum CustomError {
    #[from(ParseError)]
    ParseParams,
    #[from(LogError)]
    LogFull,
    Overflow,
    InvokeContractError,
    NotAdmin,
}
pub type ContractError = Cis2Error<CustomError>;
impl From<CustomError> for ContractError { fn from(c: CustomError) -> Self { Cis2Error::Custom(c) } }
impl<T> From<CallContractError<T>> for CustomError { fn from(_: CallContractError<T>) -> Self { CustomError::InvokeContractError } }

#[derive(Serialize, SchemaType)]
pub struct InitParams { pub metadata_url: String }

#[derive(Serialize, SchemaType)]
pub struct MintParams { pub to: AccountAddress, pub amount: ContractTokenAmount }

#[derive(Serialize, SchemaType, Debug, PartialEq, Eq)]
pub struct InfoView { pub admin: AccountAddress, pub total_supply: ContractTokenAmount, pub metadata_url: String, pub decimals: u8, pub symbol: String }

type Event = Cis2Event<ContractTokenId, ContractTokenAmount>;

#[init(contract = "eurdemo", parameter = "InitParams", event = "Cis2Event<ContractTokenId, ContractTokenAmount>", enable_logger)]
fn init(ctx: &InitContext, sb: &mut StateBuilder, logger: &mut impl HasLogger) -> InitResult<State> {
    let p: InitParams = ctx.parameter_cursor().get()?;
    logger.log(&Event::TokenMetadata(TokenMetadataEvent { token_id: TOKEN_ID, metadata_url: MetadataUrl { url: p.metadata_url.clone(), hash: None } }))?;
    Ok(State { admin: ctx.init_origin(), metadata_url: p.metadata_url, total_supply: 0, balances: sb.new_map(), operators: sb.new_set() })
}

fn bal(st: &State, a: &Address) -> u64 { st.balances.get(a).map(|b| *b).unwrap_or(0) }

#[receive(contract = "eurdemo", name = "mint", parameter = "MintParams", error = "ContractError", enable_logger, mutable)]
fn mint(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut impl HasLogger) -> Result<(), ContractError> {
    let p: MintParams = ctx.parameter_cursor().get()?;
    let st = host.state_mut();
    ensure!(ctx.sender() == Address::Account(st.admin), CustomError::NotAdmin.into());
    let to = Address::Account(p.to);
    let nb = bal(st, &to).checked_add(p.amount.0).ok_or(CustomError::Overflow)?;
    st.total_supply = st.total_supply.checked_add(p.amount.0).ok_or(CustomError::Overflow)?;
    let _ = st.balances.insert(to, nb);
    logger.log(&Event::Mint(MintEvent { token_id: TOKEN_ID, amount: p.amount, owner: to }))?;
    Ok(())
}

#[receive(contract = "eurdemo", name = "transfer", parameter = "TransferParameter", error = "ContractError", enable_logger, mutable)]
fn transfer(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut impl HasLogger) -> Result<(), ContractError> {
    let TransferParams(transfers): TransferParameter = ctx.parameter_cursor().get()?;
    let sender = ctx.sender();
    for Transfer { token_id, amount, from, to, data } in transfers {
        ensure_eq!(token_id, TOKEN_ID, Cis2Error::InvalidTokenId);
        {
            let st = host.state_mut();
            ensure!(from == sender || st.operators.contains(&(from, sender)), Cis2Error::Unauthorized);
            let to_addr = to.address();
            let fb = bal(st, &from);
            ensure!(fb >= amount.0, Cis2Error::InsufficientFunds);
            if amount.0 > 0 && from != to_addr {
                let _ = st.balances.insert(from, fb - amount.0);
                let tb = bal(st, &to_addr).checked_add(amount.0).ok_or(CustomError::Overflow)?;
                let _ = st.balances.insert(to_addr, tb);
            }
        }
        logger.log(&Event::Transfer(TransferEvent { token_id, amount, from, to: to.address() }))?;
        if let Receiver::Contract(address, function) = to {
            let params = OnReceivingCis2Params { token_id, amount, from, data };
            host.invoke_contract(&address, &params, function.as_entrypoint_name(), Amount::zero()).map_err(CustomError::from)?;
        }
    }
    Ok(())
}

type TransferParameter = TransferParams<ContractTokenId, ContractTokenAmount>;

#[receive(contract = "eurdemo", name = "updateOperator", parameter = "UpdateOperatorParams", error = "ContractError", enable_logger, mutable)]
fn update_operator(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut impl HasLogger) -> Result<(), ContractError> {
    let UpdateOperatorParams(params) = ctx.parameter_cursor().get()?;
    let owner = ctx.sender();
    for p in params {
        match p.update {
            OperatorUpdate::Add => { host.state_mut().operators.insert((owner, p.operator)); }
            OperatorUpdate::Remove => { host.state_mut().operators.remove(&(owner, p.operator)); }
        }
        logger.log(&Event::UpdateOperator(UpdateOperatorEvent { update: p.update, owner, operator: p.operator }))?;
    }
    Ok(())
}

#[receive(contract = "eurdemo", name = "balanceOf", parameter = "BalanceOfQueryParams<ContractTokenId>", return_value = "BalanceOfQueryResponse<ContractTokenAmount>", error = "ContractError")]
fn balance_of(ctx: &ReceiveContext, host: &Host<State>) -> Result<BalanceOfQueryResponse<ContractTokenAmount>, ContractError> {
    let p: BalanceOfQueryParams<ContractTokenId> = ctx.parameter_cursor().get()?;
    let mut out = Vec::with_capacity(p.queries.len());
    for q in p.queries { ensure_eq!(q.token_id, TOKEN_ID, Cis2Error::InvalidTokenId); out.push(TokenAmountU64(bal(host.state(), &q.address))); }
    Ok(BalanceOfQueryResponse::from(out))
}

#[receive(contract = "eurdemo", name = "operatorOf", parameter = "OperatorOfQueryParams", return_value = "OperatorOfQueryResponse", error = "ContractError")]
fn operator_of(ctx: &ReceiveContext, host: &Host<State>) -> Result<OperatorOfQueryResponse, ContractError> {
    let p: OperatorOfQueryParams = ctx.parameter_cursor().get()?;
    Ok(OperatorOfQueryResponse::from(p.queries.iter().map(|q| host.state().operators.contains(&(q.owner, q.address))).collect::<Vec<_>>()))
}

#[receive(contract = "eurdemo", name = "tokenMetadata", parameter = "TokenMetadataQueryParams<ContractTokenId>", return_value = "TokenMetadataQueryResponse", error = "ContractError")]
fn token_metadata(ctx: &ReceiveContext, host: &Host<State>) -> Result<TokenMetadataQueryResponse, ContractError> {
    let p: TokenMetadataQueryParams<ContractTokenId> = ctx.parameter_cursor().get()?;
    let mut out = Vec::new();
    for t in p.queries { ensure_eq!(t, TOKEN_ID, Cis2Error::InvalidTokenId); out.push(MetadataUrl { url: host.state().metadata_url.clone(), hash: None }); }
    Ok(TokenMetadataQueryResponse::from(out))
}

#[receive(contract = "eurdemo", name = "supports", parameter = "SupportsQueryParams", return_value = "SupportsQueryResponse", error = "ContractError")]
fn supports(ctx: &ReceiveContext, _host: &Host<State>) -> Result<SupportsQueryResponse, ContractError> {
    let p: SupportsQueryParams = ctx.parameter_cursor().get()?;
    let r = p.queries.into_iter().map(|id| if SUPPORTS.contains(&id.as_standard_identifier()) { SupportResult::Support } else { SupportResult::NoSupport }).collect::<Vec<_>>();
    Ok(SupportsQueryResponse::from(r))
}

#[receive(contract = "eurdemo", name = "view", return_value = "InfoView", error = "ContractError")]
fn view(_ctx: &ReceiveContext, host: &Host<State>) -> Result<InfoView, ContractError> {
    let st = host.state();
    Ok(InfoView { admin: st.admin, total_supply: TokenAmountU64(st.total_supply), metadata_url: st.metadata_url.clone(), decimals: 6, symbol: "EUR-demo".into() })
}

#[receive(contract = "eurdemo", name = "setMetadataUrl", parameter = "String", error = "ContractError", enable_logger, mutable)]
fn set_metadata_url(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut impl HasLogger) -> Result<(), ContractError> {
    let url: String = ctx.parameter_cursor().get()?;
    ensure!(ctx.sender() == Address::Account(host.state().admin), CustomError::NotAdmin.into());
    host.state_mut().metadata_url = url.clone();
    logger.log(&Event::TokenMetadata(TokenMetadataEvent { token_id: TOKEN_ID, metadata_url: MetadataUrl { url, hash: None } }))?;
    Ok(())
}
