import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { assertTransportConfigCompatible, buildServerKey, createTransport, MCPServer } from '../src/services/mcp'

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

  test('streamable_http config rejects stdio-only fields', () => {
    expect(() =>
      assertTransportConfigCompatible({
        transportType: 'streamable_http',
        command: 'node'
      })
    ).toThrow('Streamable HTTP servers cannot define stdio fields')
  })
})
