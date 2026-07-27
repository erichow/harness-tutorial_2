#!/usr/bin/env node

import { main } from "./main.js";
import { runChatCli } from "./chat.js";
import { runHeadlessCli } from "./headless.js";
import { runSessionCli } from "./session-command.js";
import { CliUsageError } from "./errors.js";
import { ConfigurationError } from "../config/loader.js";

try {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.exitCode = main(["--help"]);
  } else if (args.includes("--version") || args.includes("-V")) {
    process.exitCode = main(["--version"]);
  } else if (args[0] === "chat" && args.includes("--print")) {
    process.exitCode = await runHeadlessCli(args.slice(1));
  } else if (args.includes("--print")) {
    process.exitCode = await runHeadlessCli(args);
  } else if (args[0] === "chat") process.exitCode = await runChatCli(args.slice(1));
  else if (args[0] === "session") process.exitCode = await runSessionCli(args.slice(1));
  else if (args[0] === "--resume" || args[0] === "--fork-session") {
    process.exitCode = await runChatCli(args);
  } else process.exitCode = main(args);
  cleanupWatcher(process.exitCode);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const inputError = error instanceof CliUsageError || error instanceof ConfigurationError;
  process.stderr.write(`${inputError ? "Input" : "Internal"} error: ${message}\n`);
  process.exitCode = inputError ? 2 : 1;
  cleanupWatcher(process.exitCode);
}

/**
 * When running under tsx --watch (e.g. npm run dev), the watcher restarts
 * the process after every exit.  On a clean exit (code 0) we send SIGTERM to
 * the parent so the watcher shuts down cleanly as well.
 */
function cleanupWatcher(code: number | undefined): void {
  if (code !== 0) return;
  try {
    process.kill(process.ppid, "SIGTERM");
  } catch {
    // Parent may already be gone (not running under a watcher).
  }
}
