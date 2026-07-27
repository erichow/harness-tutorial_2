import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      "tests/security/**/*.test.ts",
    ],
    testTimeout: 5_000,
  },
});
