// Verifies BuiltInSearxngServer's Puppeteer lifecycle guards without launching a
// real browser: @missionsquad/puppeteer-scraper is fully mocked.
const mockInit = jest.fn()
const mockCloseBrowser = jest.fn()
const mockScraperCtor = jest.fn()

jest.mock('@missionsquad/puppeteer-scraper', () => ({
  PuppeteerScraper: jest.fn().mockImplementation((...args: unknown[]) => {
    mockScraperCtor(...args)
    return { init: mockInit, closeBrowser: mockCloseBrowser }
  })
}))

import { BuiltInSearxngServer } from '../src/builtin-servers/servers/searxng'

type Internals = {
  initializePuppeteerWithRetries(retryCount: number): Promise<void>
  scraper: unknown
  scraperReady: boolean
}
const internals = (server: BuiltInSearxngServer) => server as unknown as Internals

describe('BuiltInSearxngServer Puppeteer lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockScraperCtor.mockClear()
    mockInit.mockReset()
    mockCloseBrowser.mockReset()
    mockCloseBrowser.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('schedules a retry timer after a failed init attempt', async () => {
    mockInit.mockRejectedValue(new Error('init failed'))
    const server = new BuiltInSearxngServer()

    await internals(server).initializePuppeteerWithRetries(0)

    expect(mockScraperCtor).toHaveBeenCalledTimes(1)
    // A pending retry is scheduled (not yet fired).
    expect(jest.getTimerCount()).toBe(1)
  })

  it('cancels the pending retry on stop() and ignores any later retry attempt', async () => {
    mockInit.mockRejectedValue(new Error('init failed'))
    const server = new BuiltInSearxngServer()

    await internals(server).initializePuppeteerWithRetries(0)
    expect(jest.getTimerCount()).toBe(1)

    await server.stop()
    // The scheduled retry timer is cleared by stop().
    expect(jest.getTimerCount()).toBe(0)

    // Even if a retry callback still fired after stop(), the stopped guard makes it
    // a no-op: no new scraper/browser is ever constructed.
    mockScraperCtor.mockClear()
    await internals(server).initializePuppeteerWithRetries(1)
    expect(mockScraperCtor).not.toHaveBeenCalled()
  })

  it('closes a browser created during init if stop() ran mid-init (no leak, not published)', async () => {
    let resolveInit: () => void = () => undefined
    mockInit.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve
        })
    )
    const server = new BuiltInSearxngServer()

    const pending = internals(server).initializePuppeteerWithRetries(0)
    expect(mockScraperCtor).toHaveBeenCalledTimes(1)

    // stop() runs while init() is still in flight; the scraper is not yet published.
    await server.stop()
    resolveInit()
    await pending

    // The freshly created browser is closed by the mid-init guard, not published.
    expect(mockCloseBrowser).toHaveBeenCalledTimes(1)
    expect(internals(server).scraper).toBeNull()
    expect(internals(server).scraperReady).toBe(false)
  })
})
