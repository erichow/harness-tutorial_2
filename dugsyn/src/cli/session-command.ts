import { resolve } from "node:path";

import { loadConfiguration } from "../config/loader.js";
import { exportSessionMarkdown } from "../sessions/export.js";
import { defaultSessionRoot, SessionStore } from "../sessions/store.js";
import type { CliIO } from "./main.js";
import { CliUsageError } from "./errors.js";

export async function runSessionCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  io: CliIO = { stdout: process.stdout, stderr: process.stderr },
  cwd = process.cwd(),
): Promise<number> {
  if (args[0] !== "export" || args[1] === undefined) {
    io.stderr.write("Usage: dugsyn session export <session-id> [--session-dir <path>]\n");
    return 2;
  }
  const sessionId = args[1];
  const configuration = await loadConfiguration({
    workspaceRoot: cwd,
    environment,
    cwd,
  });
  let sessionDirectory = configuration.sessionDirectory ?? defaultSessionRoot(environment);
  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === "--session-dir") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError("--session-dir requires a value");
      }
      sessionDirectory = resolve(cwd, value);
      index += 1;
      continue;
    }
    throw new CliUsageError(`Unknown session argument: ${args[index] ?? ""}`);
  }
  const snapshot = await new SessionStore({ rootDirectory: sessionDirectory }).read(sessionId);
  io.stdout.write(exportSessionMarkdown(snapshot));
  return 0;
}
