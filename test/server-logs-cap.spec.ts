import { appendServerLog, MAX_SERVER_LOG_LINES } from '../src/services/mcp'

describe('appendServerLog', () => {
  it('exposes a cap of 500 lines', () => {
    expect(MAX_SERVER_LOG_LINES).toBe(500)
  })

  it('appends normally when under the cap', () => {
    const logs: string[] = []
    appendServerLog(logs, 'a')
    appendServerLog(logs, 'b')
    appendServerLog(logs, 'c')
    expect(logs).toEqual(['a', 'b', 'c'])
    expect(logs.length).toBe(3)
  })

  it('keeps exactly the last 500 entries in order once the cap is exceeded (oldest dropped)', () => {
    const logs: string[] = []
    const total = MAX_SERVER_LOG_LINES + 250 // 750 entries pushed
    for (let i = 0; i < total; i++) {
      appendServerLog(logs, `line-${i}`)
    }
    expect(logs.length).toBe(MAX_SERVER_LOG_LINES)
    // The oldest 250 (line-0 .. line-249) must have been dropped.
    expect(logs[0]).toBe(`line-${total - MAX_SERVER_LOG_LINES}`) // line-250
    expect(logs[logs.length - 1]).toBe(`line-${total - 1}`) // line-749
    // Contents are the last 500 lines in insertion order.
    const expected: string[] = []
    for (let i = total - MAX_SERVER_LOG_LINES; i < total; i++) {
      expected.push(`line-${i}`)
    }
    expect(logs).toEqual(expected)
  })

  it('tolerates an undefined logs array without throwing', () => {
    expect(() => appendServerLog(undefined, 'ignored')).not.toThrow()
  })

  it('maintains a steady-state length of 500 when called repeatedly one-at-a-time past the cap', () => {
    const logs: string[] = []
    // Fill exactly to the cap.
    for (let i = 0; i < MAX_SERVER_LOG_LINES; i++) {
      appendServerLog(logs, `seed-${i}`)
    }
    expect(logs.length).toBe(MAX_SERVER_LOG_LINES)

    // Each subsequent single append must keep the length pinned at the cap,
    // dropping exactly one oldest line and retaining the newest.
    for (let i = 0; i < 1000; i++) {
      appendServerLog(logs, `stream-${i}`)
      expect(logs.length).toBe(MAX_SERVER_LOG_LINES)
      expect(logs[logs.length - 1]).toBe(`stream-${i}`)
    }

    // After 1000 single appends past a full buffer, every seed line is gone
    // and only the last 500 streamed lines remain, in order.
    const expected: string[] = []
    for (let i = 1000 - MAX_SERVER_LOG_LINES; i < 1000; i++) {
      expected.push(`stream-${i}`)
    }
    expect(logs).toEqual(expected)
  })
})
