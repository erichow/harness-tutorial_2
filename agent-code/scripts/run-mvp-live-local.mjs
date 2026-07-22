import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const provider = process.argv[2];
if (provider !== "openai" && provider !== "deepseek") {
  throw new Error("Usage: npm run test:mvp:live:local -- openai|deepseek");
}

const localEnvironment = parseEnv(readFileSync(new URL("../.env.local", import.meta.url), "utf8"));
const names = provider === "openai"
  ? ["OPENAI_API_KEY", "OPENAI_MODEL"]
  : ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL"];
for (const name of names) {
  const value = localEnvironment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
process.env.MVP_LIVE_PROVIDER = provider;

const result = spawnSync(
  process.execPath,
  [
    "./node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "vitest.config.ts",
    "tests/integration/mvp-live-smoke.test.ts",
  ],
  {
    cwd: new URL("..", import.meta.url),
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
