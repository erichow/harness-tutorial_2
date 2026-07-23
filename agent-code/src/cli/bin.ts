#!/usr/bin/env node

import { main } from "./main.js";
import { runChatCli } from "./chat.js";
import { runSessionCli } from "./session-command.js";

try {
  const args = process.argv.slice(2);
  if (args[0] === "chat") process.exitCode = await runChatCli(args.slice(1));
  else if (args[0] === "session") process.exitCode = await runSessionCli(args.slice(1));
  else if (args[0] === "--resume" || args[0] === "--fork-session") {
    process.exitCode = await runChatCli(args);
  } else process.exitCode = main(args);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Internal error: ${message}\n`);
  process.exitCode = 1;
}
