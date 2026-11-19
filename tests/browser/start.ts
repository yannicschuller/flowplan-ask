// Starts the production (standalone) build for the browser test: a fresh
// data directory, the fake docs (tests/docs-mock.ts) and throwaway tokens
// generated here. No Claude API is reached – the landing page never asks.
// Run by playwright.config.ts as its web server; `npm run build` must have run.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { startDocsMock } from "../docs-mock";

const root = resolve(import.meta.dirname, "..", "..");
const port = Number(process.env.PORT || 3134);
const dataDir = process.env.ASK_DATA_DIR!;
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const docs = await startDocsMock();

// The standalone server needs the static files next to it.
const standalone = join(root, ".next", "standalone");
cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), { recursive: true });
cpSync(join(root, "public"), join(standalone, "public"), { recursive: true });
const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(standalone, "server.js")], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    ASK_URL: `http://127.0.0.1:${port}`,
    DOCS_URL: docs.base,
    // Throwaway values: present, so the status reads "answering"; never used for a call.
    ANTHROPIC_API_KEY: `test-${randomBytes(12).toString("hex")}`,
    ASK_BOT_TOKEN: `bot-${randomBytes(18).toString("hex")}`,
  },
});
const stop = () => {
  server.kill("SIGTERM");
  void docs.close();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.on("exit", (code) => process.exit(code ?? 0));
