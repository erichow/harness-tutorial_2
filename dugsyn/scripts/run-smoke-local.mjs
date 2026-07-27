import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";

const localEnvironment = parseEnv(readFileSync(new URL("../.env.local", import.meta.url), "utf8"));
const providerVariables = [
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
];

for (const name of providerVariables) {
  const value = localEnvironment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const result = spawnSync(
  process.execPath,
  [
    "./node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "vitest.config.ts",
    "tests/integration/provider-smoke.test.ts",
    ...process.argv.slice(2),
  ],
  {
    cwd: new URL("..", import.meta.url),
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
