// Secrets come only from environment variables. CCD_SPONSOR_PRIVATE_KEY is read where it is used (server.mjs).
// EVENTSCOPE_DEMO_SECRETS_B64 (optional): base64 of a .tar.gz of the demo people's testnet key files (Amy, Cal, Ben and
// the agent-wallet pool). Unpacked into .secrets/ at start (git-ignored, never served). Without it, demo mode and visitor
// agents are off and only the real-wallet flow runs.
import { mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { ROOT } from "./config.mjs";
export function unpackDemoSecrets() {
  const dir = path.join(ROOT, ".secrets");
  // env var, or a Render "secret file" with the same content (for hosts that limit env var size)
  const file = process.env.EVENTSCOPE_DEMO_SECRETS_FILE || "/etc/secrets/demo-secrets.b64";
  const b64 = process.env.EVENTSCOPE_DEMO_SECRETS_B64 || (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
  if (b64) { mkdirSync(dir, { recursive: true, mode: 0o700 }); execFileSync("tar", ["-xz", "-C", dir], { input: Buffer.from(b64, "base64") }); }
  return existsSync(dir) && readdirSync(dir).some((f) => f.startsWith("secrets-"));
}
