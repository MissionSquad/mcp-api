import { afterEach, expect, test } from '@jest/globals'
import { executionRequestTimeout } from '../src/utils/executionTimeout'
const original = process.env.MSQ_EXECUTION_REQUEST_TIMEOUT_MS
afterEach(() => {
  if (original === undefined) delete process.env.MSQ_EXECUTION_REQUEST_TIMEOUT_MS
  else process.env.MSQ_EXECUTION_REQUEST_TIMEOUT_MS = original
})
test('execution request budget defaults to 180 seconds and validates bounded positive integers', () => {
  delete process.env.MSQ_EXECUTION_REQUEST_TIMEOUT_MS
  expect(executionRequestTimeout()).toBe(180000)
  for (const raw of ['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '2147483648', '1e3'])
    expect(() => executionRequestTimeout(raw)).toThrow('MSQ_EXECUTION_REQUEST_TIMEOUT_MS')
  for (const raw of ['1', '240000', '2147483647']) expect(executionRequestTimeout(raw)).toBe(Number(raw))
  process.env.MSQ_EXECUTION_REQUEST_TIMEOUT_MS = '240000'
  expect(executionRequestTimeout()).toBe(240000)
})
