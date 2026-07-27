import { MINIMUM_NODE_MAJOR, VERSION } from "../version.js";

export interface CliIO {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
}

export interface CliEnvironment {
  readonly nodeVersion: string;
}

const HELP = `dugsyn ${VERSION}

Usage:
  dugsyn [options]
  dugsyn chat [--provider <openai|deepseek>] [--model <model>] [--workspace <path>]
  dugsyn --print [prompt] [--input-format <text|jsonl>] [--output-format <text|json|jsonl>]
  dugsyn --resume <session-id> [--session-dir <path>]
  dugsyn --fork-session <session-id> [chat options]
  dugsyn session export <session-id> [--session-dir <path>]

Options:
  -h, --help       Show this help message
  -V, --version    Show the version
  --print [prompt] Run non-interactively; read stdin when prompt is omitted

Configuration:
  ~/.dugsyn/config.json and trusted <workspace>/.dugsyn/config*.json
  CLI > DUGSYN_* > local > project > user > managed > defaults

Interactive commands:
  /help  /status  /context  /permissions  /undo  /clear  /exit
`;

export function checkNodeVersion(version: string): string | undefined {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);

  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    return `dugsyn requires Node.js ${MINIMUM_NODE_MAJOR} or newer; current version is ${version}.`;
  }

  return undefined;
}

export function main(
  args: readonly string[],
  io: CliIO = { stdout: process.stdout, stderr: process.stderr },
  environment: CliEnvironment = { nodeVersion: process.versions.node },
): number {
  const versionError = checkNodeVersion(environment.nodeVersion);
  if (versionError !== undefined) {
    io.stderr.write(`${versionError}\n`);
    return 1;
  }

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout.write(HELP);
    return 0;
  }

  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }

  io.stderr.write(`Unknown argument: ${args[0] ?? ""}\nRun 'dugsyn --help' for usage.\n`);
  return 2;
}
