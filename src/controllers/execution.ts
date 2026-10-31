import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { Express, Request, Response } from 'express'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { MongoDBClient, MongoConnectionParams } from '../utils/mongodb'

export const RESERVED_EXECUTION_SERVER = 'mcp-execution'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)
export interface Invocation {
  v: 1
  timestamp: number
  nonce: string
  resource: string
  ownerId: string
  actorId: string
  runId: string | null
  workspaceId: string | null
  action: 'list' | 'call'
  name: string
  args: Record<string, unknown>
}
export function verifyInvocation(
  body: Invocation,
  bearer: string,
  sig: string,
  key: Buffer,
  resource: string,
  now = Date.now()
): boolean {
  if (
    !body ||
    body.v !== 1 ||
    body.resource !== resource ||
    !Number.isSafeInteger(body.timestamp) ||
    Math.abs(now - body.timestamp) > 30000 ||
    !/^[0-9a-f-]{36}$/.test(body.nonce) ||
    !identifier(body.ownerId) ||
    !identifier(body.actorId) ||
    !(body.runId === null || identifier(body.runId)) ||
    !(body.workspaceId === null || identifier(body.workspaceId)) ||
    !(
      (body.action === 'list' && body.name === '') ||
      (body.action === 'call' && /^ee_[a-z_]{1,32}$/.test(body.name))
    ) ||
    !body.args ||
    typeof body.args !== 'object' ||
    Array.isArray(body.args) ||
    !/^ee1\.[A-Za-z0-9_-]{43}$/.test(bearer) ||
    !/^[a-f0-9]{64}$/.test(sig)
  )
    return false
  const args = JSON.stringify(body.args)
  if (Buffer.byteLength(args) > 2 * 1048576) return false
  const signed = JSON.stringify([
    'msq-execution-invocation-v1',
    body.timestamp,
    body.nonce,
    resource,
    body.ownerId,
    body.actorId,
    body.runId,
    body.workspaceId,
    digest(bearer),
    body.action,
    body.name,
    digest(args)
  ])
  return timingSafeEqual(createHmac('sha256', key).update(signed).digest(), Buffer.from(sig, 'hex'))
}
export class ExecutionBridge {
  private readonly nonces
  private readonly key
  private readonly target
  constructor(
    private readonly app: Express,
    mongo: MongoConnectionParams,
    readonly resource: string,
    secret: string
  ) {
    this.key = Buffer.from(secret, 'base64')
    this.target = new URL(resource)
    if (
      this.key.length !== 32 ||
      this.key.toString('base64') !== secret ||
      this.target.username ||
      this.target.password ||
      this.target.search ||
      this.target.hash ||
      (this.target.protocol !== 'https:' &&
        !(this.target.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(this.target.hostname)))
    )
      throw Error('Invalid execution bridge configuration')
    this.nonces = new MongoDBClient<{ _id: string; expiresAt: Date }>(mongo, [
      { key: { expiresAt: 1 }, name: 'expire_execution_nonces', expireAfterSeconds: 0 }
    ])
  }
  async init() {
    await this.nonces.connect('execution_service_nonces')
    this.app.post('/internal/execution/invoke', this.invoke.bind(this))
  }
  async stop() {
    await this.nonces.disconnect()
  }
  private async invoke(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store')
    const bearer = req.get('authorization')?.match(/^Bearer (ee1\.[A-Za-z0-9_-]{43})$/)?.[1] ?? ''
    const body: Invocation = req.body
    if (!verifyInvocation(body, bearer, req.get('x-msq-execution-signature') ?? '', this.key, this.resource)) {
      res.status(403).json({ error: 'Execution authority unavailable' })
      return
    }
    try {
      await this.nonces.insert({ _id: body.nonce, expiresAt: new Date(Date.now() + 120000) })
    } catch (e) {
      res
        .status(e instanceof Error && 'code' in e && e.code === 11000 ? 403 : 503)
        .json({ error: 'Execution invocation unavailable' })
      return
    }
    const client = new Client({ name: 'missionsquad-tools-host', version: '1' })
    const controller = new AbortController()
    const cancel = () => {
      if (!res.writableEnded) controller.abort()
    }
    res.once('close', cancel)
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const transport = new StreamableHTTPClientTransport(this.target, {
        requestInit: { headers: { authorization: 'Bearer ' + bearer }, redirect: 'error' },
        fetch: async (input, init) => {
          const u = new URL(input instanceof RequestGlobal ? input.url : input.toString())
          if (u.href !== this.target.href) throw Error('Unexpected execution destination')
          return fetch(u, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])])
          })
        }
      })
      await client.connect(transport)
      const value =
        body.action === 'list'
          ? await client.listTools()
          : await client.callTool({ name: body.name, arguments: body.args })
      res.json({ success: true, data: value })
    } catch {
      if (!res.headersSent && !res.destroyed) res.status(502).json({ error: 'Execution service unavailable' })
    } finally {
      clearTimeout(timer)
      res.off('close', cancel)
      await client.close().catch(() => {})
    }
  }
}
const RequestGlobal = globalThis.Request
