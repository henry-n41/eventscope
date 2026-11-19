// Creates (or updates) the EventScope web service on Render through Render's API. Secrets are read from this machine's
// environment and from git-ignored files, and sent only to Render; nothing secret is written to the repo.
//   RENDER_API_KEY=... CCD_SPONSOR_PRIVATE_KEY=... node scripts/render-deploy.mjs <keyValueId>
import { readFileSync, existsSync } from "node:fs";
const API = "https://api.render.com/v1"; const H = { Authorization: `Bearer ${process.env.RENDER_API_KEY}`, "content-type": "application/json", accept: "application/json" };
const call = async (method, p, body) => { const r = await fetch(API + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${t.slice(0, 400)}`); return j; };
const OWNER = process.env.RENDER_OWNER_ID || "tea-d7iadcpf9bms7381p710";
const REPO = process.env.EVENTSCOPE_REPO || "https://github.com/henry-n41/eventscope";
const kvId = process.argv[2]; if (!kvId) throw new Error("key value id needed");
const kv = await call("GET", `/key-value/${kvId}/connection-info`);
const demo = existsSync(".run/demo-secrets.b64") ? readFileSync(".run/demo-secrets.b64", "utf8").trim() : null;
const env = [
  { key: "NODE_VERSION", value: "24.22.1" },
  { key: "CCD_SPONSOR_PRIVATE_KEY", value: process.env.CCD_SPONSOR_PRIVATE_KEY },
  { key: "REDIS_URL", value: kv.internalConnectionString },
  { key: "EVENTSCOPE_KEEPALIVE", value: "1" },
  { key: "EVENTSCOPE_SPONSOR_CCD_PER_HOUR", value: "750" },
];
const list = await call("GET", `/services?name=eventscope&ownerId=${OWNER}&limit=20`);
let svc = list.map((x) => x.service).find((s) => s.name === "eventscope");
if (!svc) {
  svc = (await call("POST", "/services", { type: "web_service", name: "eventscope", ownerId: OWNER, repo: REPO, branch: "main", autoDeploy: "yes",
    serviceDetails: { runtime: "node", plan: "free", region: "frankfurt", healthCheckPath: "/api/health", envSpecificDetails: { buildCommand: "npm ci --omit=dev", startCommand: "node server.mjs" } },
    envVars: env })).service;
  console.log("created", svc.id, svc.serviceDetails?.url);
} else {
  await call("PUT", `/services/${svc.id}/env-vars`, env);
  console.log("updated env of", svc.id, svc.serviceDetails?.url);
}
if (demo) { await call("PUT", `/services/${svc.id}/secret-files/demo-secrets.b64`, { content: demo }); console.log("secret file demo-secrets.b64 set"); }
const d = await call("POST", `/services/${svc.id}/deploys`, { clearCache: "do_not_clear" });
console.log("deploy", d.id, d.status, "service url:", svc.serviceDetails?.url);
