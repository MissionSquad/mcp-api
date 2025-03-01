import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { log, sanitizeString } from '../utils/general'
import { CallToolRequestSchema, CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { Resource } from '..'

export interface MCPConnection {
  client: Client
  transport: StdioClientTransport
}

export type ToolsList = {
  /**
   * The name of the tool.
   */
  name: string
  /**
   * A human-readable description of the tool.
   */
  description?: string
  /**
   * A JSON Schema object defining the expected parameters for the tool.
   */
  inputSchema: {
    type: 'object'
    properties?: Record<string, any>
  }
}[]

export interface MCPServer {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  errors?: string[]
  connection?: MCPConnection
  toolsList?: ToolsList
}

const mcpIndexes: IndexDefinition[] = [
  { name: 'name', key: { name: 1 } }
]

const globalEnv = {
  ...process.env,
  ...(process.env.PATH ? { PATH: process.env.PATH } : {})
}

export class MCPService implements Resource {
  public servers: Record<string, MCPServer> = {}
  private list: MCPServer[] = []
  private serverKeys: string[] = []
  private mcpDBClient: MongoDBClient<MCPServer>

  constructor({ mongoParams }: { mongoParams: MongoConnectionParams }) {
    this.mcpDBClient = new MongoDBClient<MCPServer>(mongoParams, mcpIndexes)
  }

  public async init() {
    await this.mcpDBClient.connect('mcp')
    const list = await this.mcpDBClient.find({})
    this.list = (list ?? []).map(({ _id, ...server }) => ({ ...server, status: 'disconnected' }))
    for (const server of this.list) {
      await this.startMCPServer(server)
    }
    log({ level: 'info', msg: `MCPService initialized with ${this.list.length} servers`})
  }

  private async startMCPServer(server: MCPServer) {
    const serverKey = sanitizeString(`${server.name}-${server.command}`)
    const client = new Client(
      { name: 'MSQStdioClient', version: '1.0.0' },
      { capabilities: { prompts: {}, resources: {}, tools: {} } }
    )
    const { command, args, env } = server
    const transport = new StdioClientTransport({ command, args, env: { ...env, ...globalEnv }, stderr: 'pipe' })
    this.servers[serverKey] = {
      ...server,
      status: 'connecting',
      errors: [],
      connection: { client, transport }
    }
    this.serverKeys.push(serverKey)

    transport.onerror = async (error) => {
      log({ level: 'error', msg: `${serverKey} transport error: ${error}` })
      this.servers[serverKey].errors?.push(error.message)
    }

    transport.onclose = async () => {
      log({ level: 'info', msg: `${serverKey} transport closed` })
      this.servers[serverKey].status = 'disconnected'
    }

    this.servers[serverKey].connection?.transport.start() // can't call start again, so we reassign it below with a monkey patch
    const stderrStream = this.servers[serverKey].connection?.transport.stderr
    if (stderrStream) {
      stderrStream.on('data', async (data: Buffer) => {
        log({ level: 'error', msg: `${serverKey} stderr: ${data.toString()}` })
        this.servers[serverKey].errors?.push(data.toString())
      })
    } else {
      log({ level: 'error', msg: `${serverKey} stderr stream is null` })
    }
    this.servers[serverKey].connection!.transport.start = async () => {}

    this.servers[serverKey].connection!.client.connect(this.servers[serverKey].connection!.transport)
    this.servers[serverKey].status = 'connected'
    const tools = await this.servers[serverKey].connection!.client.request({ method: 'tools/list' }, ListToolsResultSchema)
    this.servers[serverKey].toolsList = tools.tools
    log({ level: 'info', msg: `${serverKey} connected` })
  }

  public async callTool(serverName: string, methodName: string, args: Record<string, unknown>) {
    const server = Object.values(this.servers).find((server) => server.name === serverName)
    if (!server) {
      log({ level: 'error', msg: `Server ${serverName} not found` })
      return undefined
    }
    if (server.status != 'connected') {
      log({ level: 'error', msg: `Server ${serverName} not connected. Status: ${server.status}` })
      return undefined
    }
    const toolResponse = await server.connection!.client.callTool({ name: methodName, arguments: args }, CallToolResultSchema)
    log({ level: 'info', msg: `Tool called - ${serverName}:${methodName}` })
    return toolResponse
  }

  public async stop() {
    log({ level: 'info', msg: 'Stopping MCP servers' })
    for (const serverKey in this.servers) {
      const serverStatus = this.servers[serverKey].status
      if (serverStatus != 'disconnected') {
        try {
          await this.servers[serverKey].connection?.transport.close()
          await this.servers[serverKey].connection?.client.close()
          this.servers[serverKey].status = 'disconnected'
          log({ level: 'info', msg: `${this.servers[serverKey].name} stopped` })
        } catch (error) {
          log({ level: 'error', msg: `${serverKey} error stopping: ${error}` })
        }

      }
    }
    await this.mcpDBClient.disconnect()
  }
}