import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { log, sanitizeString } from '../utils/general'
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { Resource } from '..'
import { Secrets } from './secrets'
import { BuiltInServer, BuiltInServerRegistry } from '../builtin-servers'

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
  secretName?: string        // ← KEEP for backward compatibility
  secretNames?: string[]     // ← ADD new property
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

  /**
   * Migrates old secretName format to new secretNames format
   * Also persists the migrated version back to database
   * This enables seamless backward compatibility during transition
   */
  private async migrateServerSecrets(server: MCPServer): Promise<MCPServer> {
    // If already using new format, return as-is
    if (server.secretNames && server.secretNames.length > 0) {
      return server
    }
    
    // If has old format, migrate
    if (server.secretName && !server.secretNames) {
      const migratedServer = {
        ...server,
        secretNames: [server.secretName],
        secretName: undefined  // Remove old property from in-memory object
      }
      
      // Persist migration to DB asynchronously (don't block)
      this.mcpDBClient.update(migratedServer, { name: server.name }).catch(err => {
        log({ 
          level: 'warn', 
          msg: `Failed to auto-migrate server ${server.name}: ${err.message}` 
        })
      })
      
      log({ 
        level: 'info', 
        msg: `Auto-migrated server ${server.name} from secretName to secretNames` 
      })
      
      return migratedServer
    }
    
    // No secrets configured
    return server
  }

  /**
   * Convert a built-in server to MCPServer format for API consistency
   */
  private builtInToMCPServer(builtInServer: BuiltInServer): MCPServer {
    return {
      name: builtInServer.externalName, // Use external name for public-facing API
      command: 'built-in', // Special marker
      args: [],
      env: {},
      status: 'connected', // Built-in servers are always "connected"
      enabled: true, // Built-in servers are always enabled
      toolsList: builtInServer.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    }
  }

  public async init() {
    await this.mcpDBClient.connect('mcp')

    // Initialize built-in servers
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    await builtInRegistry.initAll()

    // Add built-in servers to the servers map
    for (const builtInServer of builtInRegistry.list()) {
      const mcpServer = this.builtInToMCPServer(builtInServer)
      const serverKey = sanitizeString(`${builtInServer.name}-built-in`)
      this.servers[serverKey] = mcpServer
      this.serverKeys.push(serverKey)
      log({
        level: 'info',
        msg: `Added built-in server to registry: ${builtInServer.name}`
      })
    }

    // No need to init secrets here, it will be done at a higher level
    const list = await this.mcpDBClient.find({})
    this.list = (list ?? []).map(({ _id, ...server }) => ({
      ...server,
      status: 'disconnected',
      enabled: server.enabled !== false // Default to true if not set
    }))
    
    // Auto-migrate old format to new format
    for (let i = 0; i < this.list.length; i++) {
      this.list[i] = await this.migrateServerSecrets(this.list[i])
    }
    
    for (const server of this.list) {
      try {
        await this.connectToServer(server)
        // Now awaiting the fetchToolsForServer call to catch errors
        await this.fetchToolsForServer(server)
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

  private async fetchToolsForServer(
    server: MCPServer,
    retryCount = 0,
    maxRetries = 3,
    initialDelay = 120000
  ) {
    const serverKey = sanitizeString(`${server.name}-${server.command}`)
    const connection = this.servers[serverKey]?.connection

    if (!connection || !this.servers[serverKey] || this.servers[serverKey].status !== 'connected') {
      return
    }

    try {
      const requestOptions: RequestOptions = {
        // Respect the server-specific timeout, or default to 3 minutes.
        timeout: server.startupTimeout || 180000,
        maxTotalTimeout: 300000
      }

      log({
        level: 'info',
        msg: `[${server.name}] Attempting to fetch tool list (Attempt ${
          retryCount + 1
        }/${maxRetries}) with timeout ${requestOptions.timeout}ms.`
      })

      const tools = await connection.client.request({ method: 'tools/list' }, ListToolsResultSchema, requestOptions)

      if (this.servers[serverKey]) {
        this.servers[serverKey].toolsList = tools.tools
        log({ level: 'info', msg: `[${server.name}] Successfully fetched tool list.` })
      }
    } catch (error) {
      log({
        level: 'error',
        msg: `[${server.name}] Failed to fetch tool list on attempt ${retryCount + 1}.`,
        error: error
      })

      if (retryCount < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, retryCount)
        log({ level: 'info', msg: `[${server.name}] Retrying in ${delay / 1000} seconds...` })
        await new Promise(resolve => setTimeout(resolve, delay))
        // Important: await the recursive call to ensure the sequence is handled correctly.
        await this.fetchToolsForServer(server, retryCount + 1, maxRetries, initialDelay)
      } else {
        log({
          level: 'error',
          msg: `[${server.name}] Max retries reached. Disabling server.`
        })
        // Gracefully handle the error by marking the server as 'error' and disabling it
        if (this.servers[serverKey]) {
          this.servers[serverKey].status = 'error'
          this.servers[serverKey].enabled = false // Mark as disabled in memory
        }
        // Also update the database to persist the disabled state
        await this.mcpDBClient.update({ ...server, enabled: false }, { name: server.name })
      }
    }
  }

  public async callTool(username: string, serverName: string, methodName: string, args: Record<string, unknown>) {
    // Check if it's a built-in server first by its external name
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(serverName)) {
      const builtInServer = builtInRegistry.getByExternalName(serverName)
      if (!builtInServer) {
        log({ level: 'error', msg: `Built-in server with external name ${serverName} not found in registry` })
        return undefined
      }

      log({ level: 'info', msg: `Calling built-in tool - ${serverName}:${methodName}` })

      // Apply secrets if any (built-in servers can still use secrets)
      const secrets = await this.secretsService.getSecrets(username)
      if (secrets != null) {
        args = { ...args, ...secrets }
        log({
          level: 'info',
          msg: `Secrets applied to built-in tool call - ${serverName}:${methodName}`
        })
      }

      // Call the built-in server directly
      const toolResponse = await builtInServer.callTool(methodName, args)
      log({ level: 'info', msg: `Built-in tool called - ${serverName}:${methodName}` })

      return toolResponse
    }

    const server = Object.values(this.servers).find(server => server.name === serverName)
    if (!server) {
      log({ level: 'error', msg: `Server ${serverName} not found` })
      return undefined
    }
    if (server.status != 'connected') {
      log({ level: 'error', msg: `Server ${serverName} not connected. Status: ${server.status}` })
      return undefined
    }
    const secrets = await this.secretsService.getSecrets(username)
    if (secrets != null) {
      args = { ...args, ...secrets }
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

  public async setSecret(username: string, secretName: string, secretValue: string) {
    await this.secretsService.updateSecret({ username, secretName, secretValue, action: 'update' })
  }

  public async deleteSecret(username: string, secretName: string) {
    await this.secretsService.updateSecret({ username, secretName, secretValue: '', action: 'delete' })
  }

  public async addServer(serverData: {
    name: string
    command: string
    args?: string[]
    env?: Record<string, string>
    secretName?: string        // ← KEEP for backward compatibility
    secretNames?: string[]     // ← ADD new property
    enabled?: boolean
    startupTimeout?: number
  }): Promise<MCPServer> {
    const { name, command, args = [], env = {}, secretName, secretNames, enabled = true, startupTimeout } = serverData

    // Normalize: prefer secretNames, but handle secretName for backward compat
    let finalSecretNames = secretNames
    if (!finalSecretNames && secretName) {
      finalSecretNames = [secretName]
    }

    // Prevent adding servers that conflict with built-in external names
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      throw new Error(`Cannot add server with name '${name}' as it conflicts with a built-in server.`)
    }

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
      secretNames: finalSecretNames,  // Use normalized value
      secretName: undefined,          // Don't save old format for new servers
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
      secretName?: string        // ← KEEP for backward compatibility
      secretNames?: string[]     // ← ADD new property
      enabled?: boolean
      startupTimeout?: number
    }
  ): Promise<MCPServer | null> {
    // Prevent updating built-in servers
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      throw new Error(`Cannot update built-in server ${name}`)
    }

    const existingServer = await this.mcpDBClient.findOne({ name })
    if (!existingServer) {
      throw new Error(`Server with name ${name} not found`)
    }

    // Normalize secrets if provided in update
    let finalSecretNames = serverData.secretNames
    if (!finalSecretNames && serverData.secretName) {
      finalSecretNames = [serverData.secretName]
    }

    // Check if enabled state is changing
    const enabledChanged = serverData.enabled !== undefined && serverData.enabled !== existingServer.enabled

    const updatedServer: MCPServer = {
      ...existingServer,
      ...serverData,
      name, // Ensure name doesn't change
      secretNames: finalSecretNames ?? existingServer.secretNames,
      secretName: undefined,  // Remove old format when updating
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
    // Prevent deleting built-in servers
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      throw new Error(`Cannot delete built-in server ${name}`)
    }

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
    // Check built-in servers first by external name
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      const builtInServer = builtInRegistry.getByExternalName(name)
      if (builtInServer) {
        return this.builtInToMCPServer(builtInServer)
      }
    }

    return this.mcpDBClient.findOne({ name })
  }

  public async enableServer(name: string): Promise<MCPServer | null> {
    // Built-in servers are always enabled
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      return this.getServer(name)
    }

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
    // Cannot disable built-in servers
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      throw new Error(`Cannot disable built-in server ${name}`)
    }

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

    // Stop built-in servers
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    await builtInRegistry.stopAll()

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
