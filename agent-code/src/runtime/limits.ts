export interface TurnLimits {
  /** Maximum provider responses in one user turn. */
  readonly maxSteps: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = {
  maxSteps: 12,
};

export function validateTurnLimits(limits: TurnLimits): void {
  if (!Number.isInteger(limits.maxSteps) || limits.maxSteps < 1) {
    throw new RangeError("limits.maxSteps must be a positive integer");
  }
}
