// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

export interface ContextWindowBudgetPolicy {
  reminderThresholdTokens: number
  fallbackReserveTokens: number
  outputReserveTokens: number
}

export interface ContextWindowBudgetInput {
  contextWindow: number
  totalTokens: number
  explicitRolloverPending: boolean
  reminderClaimed: boolean
  fallbackClaimed: boolean
  policy: ContextWindowBudgetPolicy
}

export type ContextWindowBudgetDecision =
  | { kind: 'continue'; baseRemainingTokens: number; hardRemainingTokens: number }
  | { kind: 'remind'; baseRemainingTokens: number; hardRemainingTokens: number }
  | { kind: 'fallback'; hardRemainingTokens: number }
  | { kind: 'rollover'; reason: 'model' | 'hard-limit' }

function assertTokens(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
}

/** Resolve one post-step action from host-measured pressure and durable claims. */
export function decideContextWindowBudget(input: ContextWindowBudgetInput): ContextWindowBudgetDecision {
  assertTokens('contextWindow', input.contextWindow)
  assertTokens('totalTokens', input.totalTokens)
  assertTokens('reminderThresholdTokens', input.policy.reminderThresholdTokens)
  assertTokens('fallbackReserveTokens', input.policy.fallbackReserveTokens)
  assertTokens('outputReserveTokens', input.policy.outputReserveTokens)
  const hardLimit = input.contextWindow - input.policy.outputReserveTokens
  const baseLimit = hardLimit - input.policy.fallbackReserveTokens
  if (hardLimit < 1 || baseLimit < 1) {
    throw new TypeError('context-window reserves must leave a positive normal task budget')
  }
  if (input.explicitRolloverPending) return { kind: 'rollover', reason: 'model' }
  const hardRemainingTokens = Math.max(0, hardLimit - input.totalTokens)
  if (input.totalTokens >= hardLimit || (input.totalTokens >= baseLimit && input.fallbackClaimed)) {
    return { kind: 'rollover', reason: 'hard-limit' }
  }
  if (input.totalTokens >= baseLimit) return { kind: 'fallback', hardRemainingTokens }
  const baseRemainingTokens = baseLimit - input.totalTokens
  if (!input.reminderClaimed && baseRemainingTokens <= input.policy.reminderThresholdTokens) {
    return { kind: 'remind', baseRemainingTokens, hardRemainingTokens }
  }
  return { kind: 'continue', baseRemainingTokens, hardRemainingTokens }
}
