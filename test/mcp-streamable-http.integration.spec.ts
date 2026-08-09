import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolResultSchema, ListToolsResultSchema, TextContentSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  COMMS_MANAGEMENT_MCP_URL,
  ServiceHmacProvider
} from '../src/services/serviceHmac'

const waitFor = async (condition: () => boolean, timeoutMs = 4000, intervalMs = 50) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error('Timed out waiting for condition')
}

const readRequestBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

const getSingleHeader = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

const verifyReceivedServiceHmacRequest = ({
  method,
  pathnameAndQuery,
  headers,
  body,
  key,
  expectedTimestamp
}: {
  method: string
  pathnameAndQuery: string
  headers: IncomingHttpHeaders
  body: Buffer
  key: Buffer
  expectedTimestamp: number
}): boolean => {
  const kid = getSingleHeader(headers, 'x-msq-key-id')
  const timestamp = getSingleHeader(headers, 'x-msq-timestamp')
  const nonce = getSingleHeader(headers, 'x-msq-nonce')
  const bodyHash = getSingleHeader(headers, 'x-msq-body-sha256')
  const signature = getSingleHeader(headers, 'x-msq-signature')
  if (!kid || !timestamp || !nonce || !bodyHash || !signature) {
    return false
  }
  if (kid !== 'integration-active' || timestamp !== String(expectedTimestamp)) {
    return false
  }
  const nonceBytes = Buffer.from(nonce, 'base64url')
  if (nonceBytes.length !== 16 || nonceBytes.toString('base64url') !== nonce) {
    return false
  }
  const computedBodyHash = createHash('sha256').update(body).digest('hex')
  if (computedBodyHash !== bodyHash) {
    return false
  }
  const canonical = ['v1', method, pathnameAndQuery, timestamp, nonce, bodyHash].join('\n')
  return createHmac('sha256', key).update(canonical, 'utf8').digest('base64url') === signature
}

describe('Streamable HTTP integration', () => {
  jest.setTimeout(20000)

  test('initialize, list tools, call tool with progress, reconnect SSE', async () => {
    const standaloneStreamId = '_GET_stream'
    const eventsByStream = new Map<string, Array<{ id: string; message: JSONRPCMessage }>>()
    let nextEventId = 0
    const eventStore: EventStore = {
      async storeEvent(streamId, message) {
        const id = String(++nextEventId)
        const existing = eventsByStream.get(streamId) ?? []
        existing.push({ id, message })
        eventsByStream.set(streamId, existing)
        return id
      },
      async replayEventsAfter(lastEventId, { send }) {
        for (const [streamId, events] of eventsByStream.entries()) {
          const index = events.findIndex(event => event.id === lastEventId)
          if (index !== -1) {
            for (const event of events.slice(index + 1)) {
              await send(event.id, event.message)
            }
            return streamId
          }
        }
        return standaloneStreamId
      }
    }

    const serverTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore
    })
    const mcpServer = new McpServer(
      { name: 'test-streamable-http', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )

    mcpServer.registerTool(
      'echo',
      {
        title: 'Echo Tool',
        description: 'Echoes input text',
        inputSchema: { text: z.string() }
      },
      async ({ text }, extra) => {
        const progressToken = extra._meta?.progressToken
        if (progressToken !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: 1 }
          })
        }
        return { content: [{ type: 'text', text }] }
      }
    )

    await mcpServer.connect(serverTransport)

    let getRequestCount = 0
    let sseResponse: ServerResponse | null = null
    const httpServer = createServer((req, res) => {
      if (!req.url?.startsWith('/mcp')) {
        res.statusCode = 404
        res.end()
        return
      }

      if (req.method === 'GET') {
        getRequestCount += 1
        sseResponse = res
        void serverTransport.handleRequest(req, res).catch(() => {})
        return
      }

      if (req.method === 'POST' || req.method === 'DELETE') {
        let body = ''
        req.on('data', chunk => {
          body += chunk.toString()
        })
        req.on('end', () => {
          const parsedBody = body.length > 0 ? JSON.parse(body) : undefined
          serverTransport.handleRequest(req, res, parsedBody).catch(() => {
            res.statusCode = 500
            res.end()
          })
        })
        return
      }

      res.statusCode = 405
      res.end()
    })

    let port: number
    try {
      port = await new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          httpServer.removeListener('error', onError)
          resolve((httpServer.address() as AddressInfo).port)
        }
        httpServer.once('error', onError)
        httpServer.once('listening', onListening)
        httpServer.listen(0, '127.0.0.1')
      })
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'EPERM') {
        await mcpServer.close()
        return
      }
      throw error
    }

    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    )
    const clientTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    await client.connect(clientTransport)

    let disconnectTriggered = false
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (!disconnectTriggered && sseResponse) {
        disconnectTriggered = true
        sseResponse.destroy(new Error('simulate disconnect'))
      }
    })

    await waitFor(() => getRequestCount >= 1 && sseResponse !== null, 5000)
    mcpServer.sendToolListChanged()
    await waitFor(() => disconnectTriggered, 5000)
    await waitFor(() => getRequestCount >= 2, 5000)

    const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema)
    expect(tools.tools.some(tool => tool.name === 'echo')).toBe(true)

    const progressEvents: number[] = []
    const result = await client.callTool(
      { name: 'echo', arguments: { text: 'hello' } },
      CallToolResultSchema,
      {
        onprogress: progress => {
          progressEvents.push(progress.progress)
        },
        resetTimeoutOnProgress: true
      }
    )

    expect(progressEvents.length).toBeGreaterThan(0)
    if (!Array.isArray(result.content)) {
      throw new Error('Expected tool result content to be an array')
    }
    const first = result.content[0]
    const parsed = TextContentSchema.parse(first)
    expect(parsed.type).toBe('text')
    expect(parsed.text).toBe('hello')

    await client.close()
    await mcpServer.close()
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
  })

  test('official SDK POST, GET, and DELETE requests are signed over the exact received bytes', async () => {
    const fixedUnixSeconds = 1_700_000_000
    const hmacKey = Buffer.alloc(32, 0x5a)
    let nonceCounter = 0
    const verifiedRequests: Array<{ method: string; url: string; body: Buffer; nonce: string }> = []
    let receiverRejectedRequest = false

    const serverTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
    const mcpServer = new McpServer(
      { name: 'signed-streamable-http', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )
    mcpServer.registerTool(
      'signed-echo',
      { description: 'Echo through the signed transport', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text', text }] })
    )
    await mcpServer.connect(serverTransport)

    const httpServer = createServer((request, response) => {
      void (async () => {
        const body = await readRequestBody(request)
        const method = request.method ?? ''
        const pathnameAndQuery = request.url ?? ''
        const verified = verifyReceivedServiceHmacRequest({
          method,
          pathnameAndQuery,
          headers: request.headers,
          body,
          key: hmacKey,
          expectedTimestamp: fixedUnixSeconds
        })
        if (!verified || new URL(pathnameAndQuery, 'https://receiver.invalid').pathname !== '/internal/mcp') {
          receiverRejectedRequest = true
          response.statusCode = 401
          response.end()
          return
        }
        verifiedRequests.push({
          method,
          url: pathnameAndQuery,
          body,
          nonce: getSingleHeader(request.headers, 'x-msq-nonce') ?? ''
        })

        const parsedBody = body.length > 0 ? JSON.parse(body.toString('utf8')) : undefined
        await serverTransport.handleRequest(request, response, parsedBody)
      })().catch(() => {
        if (!response.headersSent) {
          response.statusCode = 500
          response.end()
        }
      })
    })

    let port: number
    try {
      port = await new Promise<number>((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(0, '127.0.0.1', () => resolve((httpServer.address() as AddressInfo).port))
      })
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      await mcpServer.close()
      if (err.code === 'EPERM') {
        return
      }
      throw error
    }

    const directory = await mkdtemp(join(tmpdir(), 'mcp-sdk-hmac-integration-'))
    const keyFilePath = join(directory, 'keyring.json')
    await writeFile(
      keyFilePath,
      JSON.stringify({
        version: '1',
        activeKid: 'integration-active',
        keys: [
          {
            kid: 'integration-active',
            state: 'active',
            keyBase64url: hmacKey.toString('base64url'),
            notBefore: '2023-01-01T00:00:00Z',
            verifyUntil: '2030-01-01T00:00:00Z'
          }
        ]
      }),
      { mode: 0o400 }
    )
    await chmod(keyFilePath, 0o400)

    const bridgeFetch: FetchLike = async (input, init) => {
      const outboundUrl = new URL(input.toString())
      return fetch(`http://127.0.0.1:${port}${outboundUrl.pathname}${outboundUrl.search}`, init)
    }
    const provider = new ServiceHmacProvider({
      keyFilePath,
      clock: () => fixedUnixSeconds,
      nonceSource: () => Buffer.alloc(16, ++nonceCounter),
      fetch: bridgeFetch
    })
    const client = new Client(
      { name: 'signed-integration-client', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )
    const clientTransport = new StreamableHTTPClientTransport(new URL(COMMS_MANAGEMENT_MCP_URL), {
      fetch: provider.createSignedFetch()
    })

    try {
      await provider.init()
      await client.connect(clientTransport)
      const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema)
      expect(tools.tools.some((tool) => tool.name === 'signed-echo')).toBe(true)

      const result = await client.callTool({ name: 'signed-echo', arguments: { text: 'signed-body' } })
      expect(result.content).toEqual([{ type: 'text', text: 'signed-body' }])

      await waitFor(() => verifiedRequests.some(({ method }) => method === 'GET'), 5000)
      await clientTransport.terminateSession()

      expect(receiverRejectedRequest).toBe(false)
      expect(new Set(verifiedRequests.map(({ method }) => method))).toEqual(new Set(['POST', 'GET', 'DELETE']))
      expect(new Set(verifiedRequests.map(({ nonce }) => nonce).filter(Boolean)).size).toBe(verifiedRequests.length)
      expect(
        verifiedRequests
          .filter(({ method }) => method === 'POST')
          .every(({ body }) => createHash('sha256').update(body).digest('hex').length === 64)
      ).toBe(true)
    } finally {
      await client.close().catch(() => {})
      await provider.stop()
      await mcpServer.close().catch(() => {})
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  })
})
