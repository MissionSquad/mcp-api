// Verifies ResourceStatsService.stop() waits for an in-flight sample so no
// sampling overlaps service teardown. sampleProcessTree is mocked so the test
// controls exactly when a sample completes.
jest.mock('../src/utils/resourceStats', () => {
  const actual = jest.requireActual('../src/utils/resourceStats')
  return { ...actual, sampleProcessTree: jest.fn() }
})

import { sampleProcessTree } from '../src/utils/resourceStats'
import { ResourceStatsService } from '../src/services/resourceStats'

const mockSampleProcessTree = sampleProcessTree as jest.Mock

describe('ResourceStatsService.stop', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockSampleProcessTree.mockReset()
    mockSampleProcessTree.mockResolvedValue([])
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  const flushMicrotasks = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
    }
  }

  it('waits for an in-flight sample to finish before resolving', async () => {
    let resolveSample: (value: unknown[]) => void = () => undefined
    mockSampleProcessTree.mockReturnValue(
      new Promise((resolve) => {
        resolveSample = resolve
      })
    )

    const service = new ResourceStatsService({ intervalMs: 1000, getTrackedProcesses: () => [] })
    await service.init()

    // Fire one tick: logSample() starts and suspends on the pending sampleProcessTree().
    jest.advanceTimersByTime(1000)
    await flushMicrotasks()
    expect(mockSampleProcessTree).toHaveBeenCalledTimes(1)

    let stopped = false
    const stopPromise = service.stop().then(() => {
      stopped = true
    })

    // stop() must not resolve while the sample is still in flight.
    await flushMicrotasks()
    expect(stopped).toBe(false)

    // Completing the sample lets stop() resolve.
    resolveSample([])
    await stopPromise
    expect(stopped).toBe(true)
  })

  it('resolves immediately when no sample is in flight', async () => {
    const service = new ResourceStatsService({ intervalMs: 1000, getTrackedProcesses: () => [] })
    await service.init()
    await expect(service.stop()).resolves.toBeUndefined()
    expect(mockSampleProcessTree).not.toHaveBeenCalled()
  })

  it('is disabled (no timer, never samples) when the interval is 0', async () => {
    const service = new ResourceStatsService({ intervalMs: 0, getTrackedProcesses: () => [] })
    await service.init()
    jest.advanceTimersByTime(60000)
    await flushMicrotasks()
    expect(mockSampleProcessTree).not.toHaveBeenCalled()
    await expect(service.stop()).resolves.toBeUndefined()
  })

  it('is disabled when the interval is not a finite number', async () => {
    const service = new ResourceStatsService({ intervalMs: NaN, getTrackedProcesses: () => [] })
    await service.init()
    jest.advanceTimersByTime(60000)
    await flushMicrotasks()
    expect(mockSampleProcessTree).not.toHaveBeenCalled()
  })
})
