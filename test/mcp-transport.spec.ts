import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  assertTransportConfigCompatible,
  buildServerKey,
  createSseTransport,
  createTransport,
  MCPServer
} from '../src/services/mcp'

describe('MCP transport utilities', () => {
  test('buildServerKey is stable across transport changes', () => {
    const stdioServer: MCPServer = {
      name: 'example-server',
      transportType: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: {},
      status: 'disconnected',
      enabled: true
    }
    const httpServer: MCPServer = {
      name: 'example-server',
      transportType: 'streamable_http',
      url: 'https://example.com/mcp',
      status: 'disconnected',
      enabled: true
    }

    expect(buildServerKey(stdioServer)).toEqual(buildServerKey(httpServer))
  })

  test('createTransport selects stdio transport for stdio servers', () => {
    const stdioServer: MCPServer = {
      name: 'local-server',
      transportType: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: {},
      status: 'disconnected',
      enabled: true
    }

    const transport = createTransport(stdioServer)
    expect(transport).toBeInstanceOf(StdioClientTransport)
  })

  test('createTransport selects streamable HTTP transport for streamable_http servers', () => {
    const httpServer: MCPServer = {
      name: 'remote-server',
      transportType: 'streamable_http',
      url: 'https://example.com/mcp',
      status: 'disconnected',
      enabled: true
    }

    const transport = createTransport(httpServer)
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
  })

  test('createTransport passes the consumer fetch to the official Streamable HTTP transport', () => {
    const customFetch: FetchLike = async () => new Response(null, { status: 204 })
    const transport = createTransport(
      {
        name: 'signed-streamable-http',
        transportType: 'streamable_http',
        url: 'https://example.com/mcp',
        status: 'disconnected',
        enabled: true
      },
      { fetch: customFetch }
    )

    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport)
    expect(Reflect.get(transport, '_fetch')).toBe(customFetch)
  })

  test('createSseTransport passes the same consumer fetch to the official SSE transport', () => {
    const customFetch: FetchLike = async () => new Response(null, { status: 204 })
    const transport = createSseTransport(
      { transportType: 'streamable_http', url: 'https://example.com/mcp' },
      { fetch: customFetch }
    )

    expect(transport).toBeInstanceOf(SSEClientTransport)
    expect(Reflect.get(transport, '_fetch')).toBe(customFetch)
  })

  test('official SSE runtime uses the consumer fetch for its GET stream and POST messages', async () => {
    const methods: string[] = []
    let closeEventStream = (): void => {}
    const customFetch: FetchLike = async (_url, init) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'POST') {
        return new Response(null, { status: 202 })
      }

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          closeEventStream = () => controller.close()
          controller.enqueue(
            new TextEncoder().encode('event: endpoint\ndata: https://example.com/mcp?session=legacy\n\n')
          )
        }
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    }
    const transport = createSseTransport(
      { transportType: 'streamable_http', url: 'https://example.com/mcp' },
      { fetch: customFetch }
    )
    if (!(transport instanceof SSEClientTransport)) {
      throw new Error('Expected the SSE transport factory to return SSEClientTransport')
    }

    try {
      await transport.start()
      await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      expect(methods).toEqual(['GET', 'POST'])
    } finally {
      await transport.close()
      closeEventStream()
    }
  })

  test('custom fetch remains absent from default HTTP and stdio transports', () => {
    const customFetch: FetchLike = async () => new Response(null, { status: 204 })
    const defaultHttpTransport = createTransport({
      name: 'default-http',
      transportType: 'streamable_http',
      url: 'https://example.com/mcp',
      status: 'disconnected',
      enabled: true
    })
    const stdioTransport = createTransport(
      {
        name: 'default-stdio',
        transportType: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: {},
        status: 'disconnected',
        enabled: true
      },
      { fetch: customFetch }
    )

    expect(Reflect.get(defaultHttpTransport, '_fetch')).toBeUndefined()
    expect(Reflect.get(stdioTransport, '_fetch')).toBeUndefined()
  })

  test('streamable_http config rejects stdio-only fields', () => {
    expect(() =>
      assertTransportConfigCompatible({
        transportType: 'streamable_http',
        command: 'node'
      })
    ).toThrow('Streamable HTTP servers cannot define stdio fields')
  })
})
