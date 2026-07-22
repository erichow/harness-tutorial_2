#!/usr/bin/env node

import { main } from "./main.js";

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Internal error: ${message}\n`);
  process.exitCode = 1;
}
