// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  canonicalDeepseekMemberAssistantMessageUuid,
  canonicalDeepseekTreeSessionId,
  deepseekProjectScope,
} from '../packages/core/src/providers/deepseek-identity.ts'

const SCOPE = 'b78b2ee732553438148cb0e0d9aa03fa3219ae20fce5a44a5b4655177ddc2d44'

test('keeps DeepSeek project scopes compatible with existing indexed identities', () => {
  assert.equal(deepseekProjectScope('/tmp/dsh-project'), SCOPE)
})

test('builds canonical root-tree session ids without conflating member ids', () => {
  assert.equal(
    canonicalDeepseekTreeSessionId('root-session-1', SCOPE),
    `deepseek:root-session-1:${SCOPE}`,
  )
  assert.equal(
    canonicalDeepseekTreeSessionId('child/session', SCOPE),
    `deepseek:child%2Fsession:${SCOPE}`,
  )
})

test('builds canonical member assistant anchors used by context handoffs', () => {
  assert.equal(
    canonicalDeepseekMemberAssistantMessageUuid(
      'child/session',
      SCOPE,
      3,
      7,
      'tool_use',
    ),
    `deepseek:child%2Fsession:${SCOPE}:t3:s7:tool_use`,
  )
})
