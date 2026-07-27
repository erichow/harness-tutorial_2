import type { ToolCallBlock, ToolResultBlock } from "../messages/blocks.js";
import type { ToolExecutionContext, ToolExecutor } from "../tools/executor.js";
import { createToolErrorResult } from "../tools/result.js";
import type { ResolvedTurnLimits } from "./limits.js";

export type TestReportStatus = "not_run" | "passed" | "failed";

export interface TestRunSummary {
  readonly status: TestReportStatus;
  readonly runs: number;
  readonly repairRounds: number;
  readonly lastOutcome?: string | undefined;
}

export interface TestLoopExecutor {
  readonly executor: ToolExecutor;
  summary(): TestRunSummary;
}

/**
 * Enforces the test/repair budget around an ordinary executor. A repair round
 * begins at the first successful apply_patch after a failed test. Additional
 * patches before the next test are part of that same round.
 */
export function createTestLoopExecutor(
  inner: ToolExecutor,
  limits: ResolvedTurnLimits,
): TestLoopExecutor {
  let status: TestReportStatus = "not_run";
  let runs = 0;
  let repairRounds = 0;
  let repairStarted = false;
  let lastOutcome: string | undefined;

  const executor: ToolExecutor = {
    definitions: inner.definitions,
    async execute(call: ToolCallBlock, context: ToolExecutionContext): Promise<ToolResultBlock> {
      if (call.name === "run_tests" && runs >= limits.maxTestRuns) {
        return createToolErrorResult(
          call.id,
          "limit_reached",
          `Test run limit reached (${limits.maxTestRuns}). Report the latest structured test result instead of running again.`,
        );
      }
      if (
        call.name === "apply_patch" &&
        status === "failed" &&
        !repairStarted &&
        repairRounds >= limits.maxRepairRounds
      ) {
        return createToolErrorResult(
          call.id,
          "limit_reached",
          `Repair round limit reached (${limits.maxRepairRounds}). Stop editing and report the remaining test failure.`,
        );
      }

      const result = await inner.execute(call, context);
      if (call.name === "run_tests" && result.status === "success") {
        const outcome = structuredOutcome(result);
        if (outcome !== undefined) {
          runs += 1;
          lastOutcome = outcome;
          status = outcome === "passed" ? "passed" : "failed";
          repairStarted = false;
        }
      } else if (
        call.name === "apply_patch" &&
        result.status === "success" &&
        status === "failed" &&
        !repairStarted
      ) {
        repairRounds += 1;
        repairStarted = true;
      } else if (call.name === "apply_patch" && result.status === "success" && status === "passed") {
        // A passing result only verifies the bytes that existed when it ran.
        status = "not_run";
      }
      return result;
    },
  };

  return {
    executor,
    summary: () => ({
      status,
      runs,
      repairRounds,
      ...(lastOutcome === undefined ? {} : { lastOutcome }),
    }),
  };
}

function structuredOutcome(result: ToolResultBlock): string | undefined {
  const data = result.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const outcome = data.outcome;
  return typeof outcome === "string" && [
    "passed",
    "failed",
    "timed_out",
    "signalled",
    "spawn_failed",
  ].includes(outcome)
    ? outcome
    : undefined;
}
