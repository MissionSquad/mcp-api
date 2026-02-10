import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolResultSchema, ListToolsResultSchema, TextContentSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

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
})
