//! TEST ONLY. Mimics the `agentOf` entrypoint of Concordium's CIS-8004 Agent Registry (testnet 12802,0) with the same
//! byte layout, so the EventScope pot's on-chain registry check can be unit-tested. Not deployed anywhere.
#![no_std]
use concordium_cis2::TokenIdVec;
use concordium_std::*;

#[derive(Serialize, Clone)]
pub enum Kind { Cis8 { namespace: String, key_type: String, public_key: Vec<u8> } }
#[derive(Serialize, Clone)]
pub struct ExternalReference { pub contract_address: ContractAddress, pub kind: Kind }
#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
pub enum AgentStatus { Active, Revoked }
#[derive(Serialize, Clone)]
pub struct MetaEntry { pub key: String, pub value: Vec<u8> }
#[derive(Serialize, Clone)]
pub struct AgentRecord {
    pub token_id: TokenIdVec,
    pub owner_account: AccountAddress,
    pub agent_uri: Option<String>,
    pub metadata_hash: Option<[u8; 32]>,
    pub external_reference: Option<ExternalReference>,
    pub agent_wallet: Option<AccountAddress>,
    pub status: AgentStatus,
    pub registered_at: Timestamp,
    pub revoked_at: Option<Timestamp>,
    pub revocation_reason: Option<String>,
    pub on_chain_metadata: Vec<MetaEntry>,
}

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> { agents: StateMap<u64, AgentRecord, S> }

#[derive(Serialize)]
pub struct SetParams { pub id: u64, pub owner: AccountAddress, pub wallet: Option<AccountAddress>, pub active: bool }

#[init(contract = "mockregistry")]
fn init(_ctx: &InitContext, sb: &mut StateBuilder) -> InitResult<State> { Ok(State { agents: sb.new_map() }) }

#[receive(contract = "mockregistry", name = "set", mutable)]
fn set(ctx: &ReceiveContext, host: &mut Host<State>) -> ReceiveResult<()> {
    let p: SetParams = ctx.parameter_cursor().get()?;
    let rec = AgentRecord {
        token_id: TokenIdVec(p.id.to_le_bytes().to_vec()), owner_account: p.owner, agent_uri: Some("data:x".into()), metadata_hash: Some([7u8; 32]),
        external_reference: None, agent_wallet: p.wallet, status: if p.active { AgentStatus::Active } else { AgentStatus::Revoked },
        registered_at: Timestamp::from_timestamp_millis(1), revoked_at: None, revocation_reason: None,
        on_chain_metadata: vec![MetaEntry { key: "k".into(), value: vec![1, 2] }],
    };
    let _ = host.state_mut().agents.insert(p.id, rec);
    Ok(())
}

#[receive(contract = "mockregistry", name = "agentOf")]
fn agent_of(ctx: &ReceiveContext, host: &Host<State>) -> ReceiveResult<Option<AgentRecord>> {
    let id: TokenIdVec = ctx.parameter_cursor().get()?;
    let mut b = [0u8; 8];
    if id.0.len() != 8 { return Ok(None); }
    b.copy_from_slice(&id.0);
    Ok(host.state().agents.get(&u64::from_le_bytes(b)).map(|r| r.clone()))
}
