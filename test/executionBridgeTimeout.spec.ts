import { afterEach, expect, jest, test } from '@jest/globals'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import express, { Request, Response } from 'express'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ExecutionBridge, Invocation } from '../src/controllers/execution'
jest.mock('../src/utils/mongodb', () => ({ MongoDBClient: class {
  async connect() {} async disconnect() {} async insert() {}
} }))
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: jest.fn() }))
const original = process.env.MSQ_EXECUTION_REQUEST_TIMEOUT_MS
afterEach(() => {
  jest.useRealTimers(); jest.restoreAllMocks()
  if (original === undefined) delete process.env.MSQ_EXECUTION_REQUEST_TIMEOUT_MS
  else process.env.MSQ_EXECUTION_REQUEST_TIMEOUT_MS = original
})
async function run(action: 'list' | 'call', pending = false, value: unknown = {}) {
  const resource = 'https://execution.example/mcp', key = Buffer.alloc(32, 9)
  const body: Invocation = { v: 1, timestamp: Date.now(), nonce: randomUUID(), resource, ownerId: 'owner', actorId: 'owner', runId: null, workspaceId: null, action, name: action === 'list' ? '' : 'ee_exec', args: {} }
  const bearer = 'ee1.' + 'a'.repeat(43)
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const signature = createHmac('sha256', key).update(JSON.stringify(['msq-execution-invocation-v1', body.timestamp, body.nonce, resource, body.ownerId, body.actorId, null, null, hash(bearer), action, body.name, hash('{}')])).digest('hex')
  const connect = jest.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue()
  const call = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockImplementation(async (...args) => {
    if (!pending) return value
    const options = args[action === 'list' ? 1 : 2] as { signal: AbortSignal }
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }))
  })
  const close = jest.fn<() => Promise<void>>().mockResolvedValue()
  jest.mocked(Client, { shallow: true }).mockImplementation(() => ({ connect, callTool: call, listTools: call, close }) as unknown as jest.Mocked<Client>)
  const app = express()
  const post = jest.spyOn(app, 'post')
  const bridge = new ExecutionBridge(app, { host: 'unused', db: 'unused', user: 'unused', pass: 'unused' }, resource, key.toString('base64'))
  await bridge.init()
  const handler = post.mock.calls[0][1] as (req: Request, res: Response) => Promise<void>
  const req = { body, get: (name: string) => name === 'authorization' ? 'Bearer ' + bearer : signature } as unknown as Request
  const res = Object.assign(new EventEmitter(), { writableEnded: false, headersSent: false, destroyed: false, set: jest.fn(), status: jest.fn(), json: jest.fn() })
  res.status.mockReturnValue(res)
  const done = handler(req, res as unknown as Response)
  // Nonce insertion and SDK connect are asynchronous.
  for (let i = 0; i < 5; i++) await Promise.resolve()
  return { done, res, call, connect, close }
}
test('SDK connect and calls receive explicit bounded budgets; discovery retains 30 seconds', async () => {
  for (const [configured, action, expected] of [[undefined, 'call', 180000], ['240000', 'call', 240000], [undefined, 'list', 30000]] as const) {
    if (configured === undefined) delete process.env.MSQ_EXECUTION_REQUEST_TIMEOUT_MS
    else process.env.MSQ_EXECUTION_REQUEST_TIMEOUT_MS = configured
    const result = await run(action)
    await result.done
    const options = { timeout: expected, maxTotalTimeout: expected, signal: expect.any(AbortSignal) }
    expect(result.connect).toHaveBeenCalledWith(expect.anything(), options)
    if (action === 'call') expect(result.call).toHaveBeenCalledWith({ name: 'ee_exec', arguments: {} }, undefined, options)
    else expect(result.call).toHaveBeenCalledWith(undefined, options)
    expect(result.close).toHaveBeenCalledTimes(1)
  }
})
test('overall deadline and disconnected caller cancel the SDK request and close the client', async () => {
  jest.useFakeTimers()
  delete process.env.MSQ_EXECUTION_REQUEST_TIMEOUT_MS
  for (const source of ['deadline', 'disconnect']) {
    const result = await run('call', true)
    const options = result.call.mock.calls[0][2] as { signal: AbortSignal }
    if (source === 'deadline') {
      jest.advanceTimersByTime(179999)
      expect(options.signal.aborted).toBe(false)
      jest.advanceTimersByTime(1)
    } else result.res.emit('close')
    await result.done
    expect(options.signal.aborted).toBe(true)
    expect(result.close).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  }
})

test('bridge forwards actionable execution failures as normal model-visible tool results', async () => {
  const receipt = { status: 'UNAVAILABLE', code: 'INVALID_ARGUMENTS', outcome: 'not_run', message: 'No file was read. Supply path and retry.', recovery: 'Use /workspace/report.txt.' }
  const value = { content: [{ type: 'text', text: JSON.stringify(receipt) }], structuredContent: receipt, isError: true }
  const result = await run('call', false, value)
  await result.done
  expect(result.res.json).toHaveBeenCalledWith({ success: true, data: value })
  expect(result.res.status).not.toHaveBeenCalled()
})
