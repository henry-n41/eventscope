// Deploy and init the EUR-demo token and the EventScope pot (which accepts only that token). Testnet only.
//   node scripts/deploy.mjs [metadata_url]          (fresh token and pot)
//   REUSE_TOKEN=1 node scripts/deploy.mjs           (keep the deployed EUR-demo token, new pot only; balances stay)
// Pot settings: registry = Concordium's CIS-8004 Agent Registry 12802,0; MAX_DAILY (EUR-demo units); DISPUTE_MS.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AccountTransactionType, CcdAmount, ContractName, Energy, ModuleReference, serializeInitContractParameters } from "@concordium/web-sdk";
import { CONTRACTS, DEPLOYMENT, OPERATOR, OPERATOR_KEY_ENV, explorerTx, explorerContract } from "../lib/config.mjs";
import { grpc, send, schema, signerFromHex } from "../lib/chain.mjs";
const key = process.env[OPERATOR_KEY_ENV]; if (!/^[0-9a-f]{64}$/i.test(key || "")) { console.error(`${OPERATOR_KEY_ENV} missing`); process.exit(1); }
const signer = signerFromHex(key);
const metadataUrl = process.argv[2] || "http://127.0.0.1:8100/eur-demo.json";

async function deployModule(which) {
  const wasm = readFileSync(path.join(CONTRACTS[which].dir, "module.wasm.v1"));
  const ref = createHash("sha256").update(wasm).digest("hex");
  const exists = await grpc().getModuleSource(ModuleReference.fromHexString(ref)).then(() => true, () => false);
  if (exists) return { ref, tx: null };
  const r = await send(signer, OPERATOR, AccountTransactionType.DeployModule, { source: wasm.subarray(8), version: 1 }, which);
  if (r.outcome !== "success") throw new Error(`deploy ${which}: ${JSON.stringify(r.reject_reason)}`);
  return { ref, tx: r.tx };
}
async function init(which, ref, paramJson) {
  const param = serializeInitContractParameters(ContractName.fromString(CONTRACTS[which].name), paramJson, schema(which));
  const r = await send(signer, OPERATOR, AccountTransactionType.InitContract, { amount: CcdAmount.zero(), moduleRef: ModuleReference.fromHexString(ref),
    initName: ContractName.fromString(CONTRACTS[which].name), param, maxContractExecutionEnergy: Energy.create(20000n) }, which);
  if (r.outcome !== "success") throw new Error(`init ${which}: ${JSON.stringify(r.reject_reason)}`);
  return { index: String(r.summary.contractInitialized.address.index), tx: r.tx };
}
const prev = (await import("../lib/config.mjs")).deployment();
const reuse = process.env.REUSE_TOKEN === "1" && prev?.token;
const tm = reuse ? { ref: prev.token.module_ref, tx: prev.token.deploy_tx } : await deployModule("token");
const ti = reuse ? { index: prev.token.index, tx: prev.token.init_tx } : await init("token", tm.ref, { metadata_url: metadataUrl });
const REGISTRY = { index: 12802, subindex: 0 };
const MAX_DAILY = Number(process.env.MAX_DAILY || 50_000_000); // EUR 50 a day house maximum
const DISPUTE_MS = Number(process.env.DISPUTE_MS || 180_000);  // 3 minute dispute window (demo)
const pm = await deployModule("pot");
const pi = await init("pot", pm.ref, { verifier: OPERATOR, token: { index: Number(ti.index), subindex: 0 }, registry: REGISTRY, max_daily_spend: MAX_DAILY, dispute_window_ms: DISPUTE_MS });
const out = { network: "testnet", operator: OPERATOR, deployed_at: new Date().toISOString(),
  token: { name: CONTRACTS.token.name, symbol: "EUR-demo", decimals: 6, index: ti.index, module_ref: tm.ref, deploy_tx: tm.tx, init_tx: ti.tx, metadata_url: reuse ? prev.token.metadata_url : metadataUrl },
  pot: { name: CONTRACTS.pot.name, index: pi.index, module_ref: pm.ref, deploy_tx: pm.tx, init_tx: pi.tx, verifier: OPERATOR, registry: "12802,0", max_daily_spend: MAX_DAILY, dispute_window_ms: DISPUTE_MS },
  previous_pots: [...(prev?.previous_pots || []), ...(prev?.pot ? [{ index: prev.pot.index, module_ref: prev.pot.module_ref }] : [])] };
writeFileSync(DEPLOYMENT, JSON.stringify(out, null, 1));
for (const w of ["token", "pot"]) console.log(w, out[w].index, explorerContract(out[w].index), out[w].deploy_tx ? explorerTx(out[w].deploy_tx) : "(module already on chain)", explorerTx(out[w].init_tx));
process.exit(0);
