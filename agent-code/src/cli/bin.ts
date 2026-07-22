#!/usr/bin/env node

import { main } from "./main.js";
import { runChatCli } from "./chat.js";

try {
  const args = process.argv.slice(2);
  process.exitCode = args[0] === "chat"
    ? await runChatCli(args.slice(1))
    : main(args);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Internal error: ${message}\n`);
  process.exitCode = 1;
}
