export interface TurnLimits {
  /** Maximum provider responses in one user turn. */
  readonly maxSteps?: number | undefined;
  /** Wall-clock budget for the complete turn, including tools. */
  readonly maxDurationMs?: number | undefined;
  /** Sum of provider-reported input tokens across the turn. */
  readonly maxInputTokens?: number | undefined;
  /** Sum of provider-reported output tokens across the turn. */
  readonly maxOutputTokens?: number | undefined;
  /** Maximum completed invocations of the dedicated test tool. */
  readonly maxTestRuns?: number | undefined;
  /** Maximum edit rounds that may begin after a failed test run. */
  readonly maxRepairRounds?: number | undefined;
}

export interface ResolvedTurnLimits {
  readonly maxSteps: number;
  readonly maxDurationMs: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxTestRuns: number;
  readonly maxRepairRounds: number;
}

export const DEFAULT_TURN_LIMITS: ResolvedTurnLimits = {
  maxSteps: 12,
  maxDurationMs: 600_000,
  maxInputTokens: 1_000_000,
  maxOutputTokens: 100_000,
  maxTestRuns: 4,
  maxRepairRounds: 3,
};

export function validateTurnLimits(limits: TurnLimits): void {
  for (const [name, value] of Object.entries(resolveTurnLimits(limits))) {
    const minimum = name === "maxRepairRounds" ? 0 : 1;
    if (!Number.isInteger(value) || value < minimum) {
      throw new RangeError(
        minimum === 0
          ? `limits.${name} must be a non-negative integer`
          : `limits.${name} must be a positive integer`,
      );
    }
  }
}

export function resolveTurnLimits(limits?: TurnLimits): ResolvedTurnLimits {
  return {
    maxSteps: limits?.maxSteps ?? DEFAULT_TURN_LIMITS.maxSteps,
    maxDurationMs: limits?.maxDurationMs ?? DEFAULT_TURN_LIMITS.maxDurationMs,
    maxInputTokens: limits?.maxInputTokens ?? DEFAULT_TURN_LIMITS.maxInputTokens,
    maxOutputTokens: limits?.maxOutputTokens ?? DEFAULT_TURN_LIMITS.maxOutputTokens,
    maxTestRuns: limits?.maxTestRuns ?? DEFAULT_TURN_LIMITS.maxTestRuns,
    maxRepairRounds: limits?.maxRepairRounds ?? DEFAULT_TURN_LIMITS.maxRepairRounds,
  };
}
