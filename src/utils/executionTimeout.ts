/** Bounded request budget, including foreground execution and transport overhead. */
export function executionRequestTimeout(raw = process.env.MSQ_EXECUTION_REQUEST_TIMEOUT_MS): number {
  if (raw === undefined) return 180000
  const value = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    throw Error('Invalid MSQ_EXECUTION_REQUEST_TIMEOUT_MS: expected an integer from 1 to 2147483647')
  return value
}
