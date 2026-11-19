// EventScope demo settings (public values only, no keys). Testnet only.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
// The box only lets gRPC (port 20000) out through its egress tunnel.
if (!process.env.grpc_proxy && !process.env.GRPC_PROXY && process.env.SAND_EGRESS_TUNNEL_PROXY_ADDR) {
  process.env.grpc_proxy = `http://${process.env.SAND_EGRESS_TUNNEL_PROXY_ADDR}`;
}
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OPERATOR = "3N9s8YUN2pxMuP5bszXUUk9vZ3ks7tDgxgzhG5arGr5qGYe6fn"; // ClientScope operator account, reused (key from env CCD_SPONSOR_PRIVATE_KEY)
export const OPERATOR_KEY_ENV = "CCD_SPONSOR_PRIVATE_KEY";
export const SPONSOR = OPERATOR; // pays the CCD fees of players' buy and claim transactions (sponsored transactions)
export const RESOURCE_ID = process.env.EVENTSCOPE_RESOURCE_ID || "https://eventscope-demo.example/play";
export const ALLOW_HOURS = 24;
export const TOKEN_SYMBOL = "EUR-demo";
export const TOKEN_DECIMALS = 6;
export const START_GRANT = 20_000_000n; // 20 EUR-demo play money minted to each newly verified player (once)
export const CONTRACTS = {
  pot: { name: "eventscope", dir: path.join(ROOT, "contracts/eventscope/concordium-out") },
  token: { name: "eurdemo", dir: path.join(ROOT, "contracts/eurdemo/concordium-out") },
};
export const DEPLOYMENT = path.join(ROOT, "deployment.json");
export const deployment = () => (existsSync(DEPLOYMENT) ? JSON.parse(readFileSync(DEPLOYMENT, "utf8")) : null);
export const explorerTx = (h) => `https://ccdexplorer.io/testnet/transaction/${h}`;
export const explorerAccount = (a) => `https://ccdexplorer.io/testnet/account/${a}`;
export const explorerContract = (i) => `https://ccdexplorer.io/testnet/smart-contract/${i}/0`;
export const jsonSafe = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
export const ccd = (micro) => (Number(BigInt(micro)) / 1e6).toFixed(6).replace(/\.?0+$/, "");
export const eur = (units) => (Number(BigInt(units)) / 10 ** TOKEN_DECIMALS).toFixed(2);
