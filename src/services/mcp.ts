import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { log, sanitizeString } from '../utils/general'
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { Resource } from '..'
import { Secrets } from './secrets'

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
  enabled: boolean
  startupTimeout?: number
  logs?: string[]
  connection?: MCPConnection
  toolsList?: ToolsList
  // Event handlers for cleanup
  eventHandlers?: {
    stderrDataHandler?: (data: Buffer) => void
    transportErrorHandler?: (error: Error) => void
    transportCloseHandler?: () => void
  }
}

const mcpIndexes: IndexDefinition[] = [{ name: 'name', key: { name: 1 } }]

const globalEnv = {
  ...process.env,
  ...(process.env.PATH ? { PATH: process.env.PATH } : {})
}

export class MCPService implements Resource {
  public servers: Record<string, MCPServer> = {}
  private list: MCPServer[] = []
  private serverKeys: string[] = []
  private mcpDBClient: MongoDBClient<MCPServer>
  public secretsService: Secrets
  private packageService?: any // Will be set after initialization to avoid circular dependency

  constructor({
    mongoParams,
    secretsService
  }: {
    mongoParams: MongoConnectionParams
    secretsService: Secrets
  }) {
    this.mcpDBClient = new MongoDBClient<MCPServer>(mongoParams, mcpIndexes)
    this.secretsService = secretsService
  }

  /**
   * Set the package service reference
   * This is called after initialization to avoid circular dependency
   */
  public setPackageService(packageService: any): void {
    this.packageService = packageService
  }

  public async init() {
    await this.mcpDBClient.connect('mcp')
    // No need to init secrets here, it will be done at a higher level
    const list = await this.mcpDBClient.find({})
    this.list = (list ?? []).map(({ _id, ...server }) => ({
      ...server,
      status: 'disconnected',
      enabled: server.enabled !== false // Default to true if not set
    }))
    for (const server of this.list) {
      try {
        await this.connectToServer(server)
        this.fetchToolsForServer(server)
      } catch (error) {
        log({
          level: 'error',
          msg: `[${server.name}] Unhandled exception during server startup sequence.`,
          error: error
        })
      }
    }
    log({ level: 'info', msg: `MCPService initialized with ${this.list.length} servers` })
  }

  private async connectToServer(server: MCPServer) {
    const serverKey = sanitizeString(`${server.name}-${server.command}`)
    try {
      // If server is disabled, add it to this.servers with disconnected status but don't start it
      if (server.enabled === false) {
        log({ level: 'info', msg: `Server ${server.name} is disabled, adding to servers list but not starting` })
        this.servers[serverKey] = {
          ...server,
          status: 'disconnected',
          logs: []
        }
        return
      }

      const client = new Client(
        { name: 'MSQStdioClient', version: '1.0.0' },
        { capabilities: { prompts: {}, resources: {}, tools: {} } }
      )
      const { command, args, env } = server
      const transport = new StdioClientTransport({ command, args, env: { ...env, ...globalEnv }, stderr: 'pipe' })
      this.servers[serverKey] = {
        ...server,
        status: 'connecting',
        logs: [],
        connection: { client, transport }
      }
      this.serverKeys.push(serverKey)

      // Create event handlers and store references for later cleanup
      const transportErrorHandler = async (error: Error) => {
        log({ level: 'error', msg: `${serverKey} transport error: ${error.message}`, error })
        if (this.servers[serverKey]) {
          this.servers[serverKey].logs?.push(error.message)
        }
      }

      const transportCloseHandler = async () => {
        log({ level: 'info', msg: `[${server.name}] Transport closed.` })
        if (this.servers[serverKey]) {
          this.servers[serverKey].status = 'disconnected'
          // Add a final log of all captured stderr logs for debugging
          if (this.servers[serverKey].logs && this.servers[serverKey].logs!.length > 0) {
            log({
              level: 'info',
              msg: `[${server.name}] Final captured logs before exit:\n ${JSON.stringify(
                this.servers[serverKey].logs,
                null,
                2
              )}`
            })
          }
        }
      }

      // Store event handler references
      this.servers[serverKey].eventHandlers = {
        transportErrorHandler,
        transportCloseHandler
      }

      transport.onerror = transportErrorHandler
      transport.onclose = transportCloseHandler

      log({
        level: 'info',
        msg: `Attempting to start server ${server.name} with command: ${
          server.command
        } ${server.args.join(' ')}`
      })
      // can't call start again, so we reassign it below with a monkey patch. thanks for the tip @saoudrizwan!
      this.servers[serverKey].connection?.transport.start()
      const stderrStream = this.servers[serverKey].connection?.transport.stderr
      if (stderrStream) {
        log({ level: 'info', msg: `[${server.name}] Attaching stderr listener.` })
        // Create and store stderr data handler
        const stderrDataHandler = async (data: Buffer) => {
          const logMsg = data.toString().trim()
          log({ level: 'error', msg: `[${server.name}] stderr: ${logMsg}` })
          if (this.servers[serverKey]) {
            this.servers[serverKey].logs?.push(logMsg)
          }
        }

        this.servers[serverKey].eventHandlers!.stderrDataHandler = stderrDataHandler
        stderrStream.on('data', stderrDataHandler)
      } else {
        log({ level: 'error', msg: `[${server.name}] stderr stream is null` })
      }
      this.servers[serverKey].connection!.transport.start = async () => {}

      this.servers[serverKey].connection!.client.connect(this.servers[serverKey].connection!.transport)
      this.servers[serverKey].status = 'connected'
      log({ level: 'info', msg: `[${server.name}] Connected successfully. Will fetch tool list.` })
    } catch (error) {
      log({
        level: 'error',
        msg: `[${server.name}] Failed to start or connect to server.`,
        error: error
      })

      if (this.servers[serverKey]) {
        this.servers[serverKey].status = 'error'
      }

      // Attempt to install missing package if PackageService is available
      let installSuccess = false
      if (this.packageService) {
        log({ level: 'info', msg: `Attempting to install missing package for server ${server.name}` })
        installSuccess = await this.packageService.installMissingPackage(server.name)
      }

      // If installation failed or no PackageService, mark as disabled
      if (!installSuccess) {
        // Mark server as disabled in the database
        server.enabled = false
        await this.mcpDBClient.update(server, { name: server.name })
        log({ level: 'info', msg: `Server ${server.name} has been disabled due to startup failure` })
      }
    }
  }

  private async fetchToolsForServer(server: MCPServer) {
    const serverKey = sanitizeString(`${server.name}-${server.command}`)
    const connection = this.servers[serverKey]?.connection
    if (!connection) return

    try {
      const requestOptions: RequestOptions = {}
      if (server.startupTimeout) {
        requestOptions.timeout = server.startupTimeout
      }
      const tools = await connection.client.request({ method: 'tools/list' }, ListToolsResultSchema, requestOptions)
      if (this.servers[serverKey]) {
        this.servers[serverKey].toolsList = tools.tools
        log({ level: 'info', msg: `[${server.name}] Successfully fetched tool list.` })
      }
    } catch (error) {
      log({
        level: 'error',
        msg: `[${server.name}] Failed to fetch tool list.`,
        error: error
      })
      if (this.servers[serverKey]) {
        this.servers[serverKey].status = 'error'
      }
    }
  }

  public async callTool(username: string, serverName: string, methodName: string, args: Record<string, unknown>) {
    const server = Object.values(this.servers).find(server => server.name === serverName)
    if (!server) {
      log({ level: 'error', msg: `Server ${serverName} not found` })
      return undefined
    }
    if (server.status != 'connected') {
      log({ level: 'error', msg: `Server ${serverName} not connected. Status: ${server.status}` })
      return undefined
    }
    const secrets = await this.secretsService.getSecrets(username, serverName)
    if (secrets[serverName] != null) {
      args = { ...args, ...secrets[serverName] }
      log({
        level: 'info',
        msg: `Secrets applied to tool call - ${serverName}:${methodName} - ${Object.keys(secrets).join(', ')}`
      })
    }
    log({ level: 'info', msg: `Calling tool - ${serverName}:${methodName}` })
    const requestOptions: RequestOptions = {}
    if (server.startupTimeout) {
      requestOptions.timeout = server.startupTimeout
    }
    const toolResponse = await server.connection!.client.callTool(
      { name: methodName, arguments: args },
      CallToolResultSchema,
      requestOptions
    )
    log({ level: 'info', msg: `Tool called - ${serverName}:${methodName}` })
    if (Array.isArray(toolResponse.content)) {
      toolResponse.content = toolResponse.content.map(item => {
        return item
      })
    }
    return toolResponse
  }

  public async setSecret(username: string, serverName: string, secretName: string, secretValue: string) {
    await this.secretsService.updateSecret({ username, serverName, secretName, secretValue, action: 'update' })
  }

  public async deleteSecret(username: string, serverName: string, secretName: string) {
    await this.secretsService.updateSecret({ username, serverName, secretName, secretValue: '', action: 'delete' })
  }

  public async addServer(serverData: {
    name: string
    command: string
    args?: string[]
    env?: Record<string, string>
    enabled?: boolean
    startupTimeout?: number
  }): Promise<MCPServer> {
    const { name, command, args = [], env = {}, enabled = true, startupTimeout } = serverData

    // Check if server with this name already exists
    const existingServer = await this.mcpDBClient.findOne({ name })
    if (existingServer) {
      throw new Error(`Server with name ${name} already exists`)
    }

    const server: MCPServer = {
      name,
      command,
      args,
      env,
      status: 'disconnected',
      enabled,
      startupTimeout
    }

    await this.mcpDBClient.insert(server)
    await this.connectToServer(server)
    this.fetchToolsForServer(server)

    return server
  }

  public async updateServer(
    name: string,
    serverData: {
      command?: string
      args?: string[]
      env?: Record<string, string>
      enabled?: boolean
      startupTimeout?: number
    }
  ): Promise<MCPServer | null> {
    const existingServer = await this.mcpDBClient.findOne({ name })
    if (!existingServer) {
      throw new Error(`Server with name ${name} not found`)
    }

    // Check if enabled state is changing
    const enabledChanged = serverData.enabled !== undefined && serverData.enabled !== existingServer.enabled

    const updatedServer: MCPServer = {
      ...existingServer,
      ...serverData,
      name, // Ensure name doesn't change
      startupTimeout: serverData.startupTimeout ?? existingServer.startupTimeout
    }

    await this.mcpDBClient.update(updatedServer, { name })

    // If only the enabled state is changing, use the enable/disable methods
    if (enabledChanged && Object.keys(serverData).length === 1) {
      if (serverData.enabled) {
        return this.enableServer(name)
      } else {
        return this.disableServer(name)
      }
    }

    // Otherwise, restart the server with the new configuration
    // Stop the existing server if it's running
    const serverKey = sanitizeString(`${name}-${existingServer.command}`)
    if (this.servers[serverKey]) {
      try {
        // Clean up event listeners first
        if (this.servers[serverKey].eventHandlers) {
          const { stderrDataHandler, transportErrorHandler, transportCloseHandler } = this.servers[
            serverKey
          ].eventHandlers

          // Remove stderr data handler if it exists
          if (stderrDataHandler && this.servers[serverKey].connection?.transport.stderr) {
            this.servers[serverKey].connection.transport.stderr.removeListener('data', stderrDataHandler)
          }

          // Clear transport event handlers
          if (this.servers[serverKey].connection?.transport) {
            if (transportErrorHandler) {
              this.servers[serverKey].connection.transport.onerror = undefined
            }
            if (transportCloseHandler) {
              this.servers[serverKey].connection.transport.onclose = undefined
            }
          }
        }

        await this.servers[serverKey].connection?.transport.close()
        await this.servers[serverKey].connection?.client.close()
        delete this.servers[serverKey]
      } catch (error) {
        log({ level: 'error', msg: `Error stopping server ${name}: ${error}` })
      }
    }

    // Start the updated server (connectToServer will respect the enabled flag)
    await this.connectToServer(updatedServer)
    this.fetchToolsForServer(updatedServer)

    return updatedServer
  }

  public async deleteServer(name: string): Promise<void> {
    const existingServer = await this.mcpDBClient.findOne({ name })
    if (!existingServer) {
      throw new Error(`Server with name ${name} not found`)
    }

    // Stop the server if it's running
    const serverKey = sanitizeString(`${name}-${existingServer.command}`)
    if (this.servers[serverKey]) {
      try {
        // Clean up event listeners first
        if (this.servers[serverKey].eventHandlers) {
          const { stderrDataHandler, transportErrorHandler, transportCloseHandler } = this.servers[
            serverKey
          ].eventHandlers

          // Remove stderr data handler if it exists
          if (stderrDataHandler && this.servers[serverKey].connection?.transport.stderr) {
            this.servers[serverKey].connection.transport.stderr.removeListener('data', stderrDataHandler)
          }

          // Clear transport event handlers
          if (this.servers[serverKey].connection?.transport) {
            if (transportErrorHandler) {
              this.servers[serverKey].connection.transport.onerror = undefined
            }
            if (transportCloseHandler) {
              this.servers[serverKey].connection.transport.onclose = undefined
            }
          }
        }

        // Now close the transport and client
        await this.servers[serverKey].connection?.transport.close()
        await this.servers[serverKey].connection?.client.close()

        // Finally delete the server reference
        delete this.servers[serverKey]
      } catch (error) {
        log({ level: 'error', msg: `Error stopping server ${name}: ${error}` })
      }
    }

    await this.mcpDBClient.delete({ name }, false)
  }

  public async getServer(name: string): Promise<MCPServer | null> {
    return this.mcpDBClient.findOne({ name })
  }

  public async enableServer(name: string): Promise<MCPServer | null> {
    const server = await this.mcpDBClient.findOne({ name })
    if (!server) {
      throw new Error(`Server ${name} not found`)
    }

    server.enabled = true
    await this.mcpDBClient.update(server, { name })

    // If server is not running, start it
    const serverKey = sanitizeString(`${name}-${server.command}`)

    // Update the enabled status in the in-memory server object
    if (this.servers[serverKey]) {
      this.servers[serverKey].enabled = true
    }
    if (
      !this.servers[serverKey] ||
      this.servers[serverKey].status === 'disconnected' ||
      this.servers[serverKey].status === 'error'
    ) {
      await this.connectToServer(server)
      this.fetchToolsForServer(server)
    }

    return server
  }

  public async disableServer(name: string): Promise<MCPServer | null> {
    const server = await this.mcpDBClient.findOne({ name })
    if (!server) {
      throw new Error(`Server ${name} not found`)
    }

    server.enabled = false
    await this.mcpDBClient.update(server, { name })

    // If server is running, stop it
    const serverKey = sanitizeString(`${name}-${server.command}`)

    // Update the enabled status in the in-memory server object
    if (this.servers[serverKey]) {
      this.servers[serverKey].enabled = false
    }
    if (this.servers[serverKey] && this.servers[serverKey].status !== 'disconnected') {
      try {
        // Clean up event listeners first
        if (this.servers[serverKey].eventHandlers) {
          const { stderrDataHandler, transportErrorHandler, transportCloseHandler } = this.servers[
            serverKey
          ].eventHandlers

          // Remove stderr data handler if it exists
          if (stderrDataHandler && this.servers[serverKey].connection?.transport.stderr) {
            this.servers[serverKey].connection.transport.stderr.removeListener('data', stderrDataHandler)
          }

          // Clear transport event handlers
          if (this.servers[serverKey].connection?.transport) {
            if (transportErrorHandler) {
              this.servers[serverKey].connection.transport.onerror = undefined
            }
            if (transportCloseHandler) {
              this.servers[serverKey].connection.transport.onclose = undefined
            }
          }
        }

        await this.servers[serverKey].connection?.transport.close()
        await this.servers[serverKey].connection?.client.close()
        this.servers[serverKey].status = 'disconnected'
        log({ level: 'info', msg: `Server ${name} stopped due to being disabled` })
      } catch (error) {
        log({ level: 'error', msg: `Error stopping server ${name}: ${error}` })
      }
    }

    return server
  }

  public async stop() {
    log({ level: 'info', msg: 'Stopping MCP servers' })
    for (const serverKey in this.servers) {
      const serverStatus = this.servers[serverKey].status
      if (serverStatus != 'disconnected') {
        try {
          // Clean up event listeners first
          if (this.servers[serverKey].eventHandlers) {
            const { stderrDataHandler, transportErrorHandler, transportCloseHandler } = this.servers[
              serverKey
            ].eventHandlers

            // Remove stderr data handler if it exists
            if (stderrDataHandler && this.servers[serverKey].connection?.transport.stderr) {
              this.servers[serverKey].connection.transport.stderr.removeListener('data', stderrDataHandler)
            }

            // Clear transport event handlers
            if (this.servers[serverKey].connection?.transport) {
              if (transportErrorHandler) {
                this.servers[serverKey].connection.transport.onerror = undefined
              }
              if (transportCloseHandler) {
                this.servers[serverKey].connection.transport.onclose = undefined
              }
            }
          }

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
