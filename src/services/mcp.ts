import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPReconnectionOptions,
  StreamableHTTPError
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { Resource } from '..'
import { BuiltInServer, BuiltInServerRegistry } from '../builtin-servers'
import { log, sanitizeString } from '../utils/general'
import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { Secrets } from './secrets'
import { McpOAuthClientProvider, McpOAuthTokens } from './oauthTokens'
import type { McpOAuthTokenInput } from './oauthTokens'

export interface MCPConnection {
  client: Client
  transport: Transport
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

export type MCPTransportType = 'stdio' | 'streamable_http'

export type StdioServerConfig = {
  transportType: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
}

export type StreamableHttpServerConfig = {
  transportType: 'streamable_http'
  url: string
  headers?: Record<string, string>
  sessionId?: string
  reconnectionOptions?: StreamableHTTPReconnectionOptions
}

type MCPServerBase = {
  name: string
  secretName?: string    // ← KEEP for backward compatibility
  secretNames?: string[] // ← ADD new property
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

export type MCPServer = MCPServerBase & (StdioServerConfig | StreamableHttpServerConfig)

type MCPServerRecord = MCPServerBase & {
  transportType?: MCPTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  sessionId?: string
  reconnectionOptions?: StreamableHTTPReconnectionOptions
}

export type AddServerInput = {
  name: string
  transportType?: MCPTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  sessionId?: string
  reconnectionOptions?: StreamableHTTPReconnectionOptions
  secretName?: string    // ← KEEP for backward compatibility
  secretNames?: string[] // ← ADD new property
  enabled?: boolean
  startupTimeout?: number
}

export type UpdateServerInput = {
  transportType?: MCPTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  sessionId?: string
  reconnectionOptions?: StreamableHTTPReconnectionOptions
  secretName?: string    // ← KEEP for backward compatibility
  secretNames?: string[] // ← ADD new property
  enabled?: boolean
  startupTimeout?: number
}

export const buildServerKey = (server: { name: string }): string => sanitizeString(server.name)

export const assertTransportConfigCompatible = (config: {
  transportType: MCPTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  sessionId?: string
  reconnectionOptions?: StreamableHTTPReconnectionOptions
}): void => {
  if (config.transportType === 'streamable_http') {
    const hasStdioFields =
      config.command !== undefined || config.args !== undefined || config.env !== undefined
    if (hasStdioFields) {
      throw new Error('Streamable HTTP servers cannot define stdio fields (command, args, env).')
    }
    return
  }

  const hasHttpFields =
    config.url !== undefined ||
    config.headers !== undefined ||
    config.sessionId !== undefined ||
    config.reconnectionOptions !== undefined
  if (hasHttpFields) {
    throw new Error('Stdio servers cannot define streamable HTTP fields (url, headers, sessionId, reconnectionOptions).')
  }
}

const isStreamableHTTPTransport = (transport: Transport): transport is StreamableHTTPClientTransport =>
  typeof (transport as StreamableHTTPClientTransport).terminateSession === 'function'

const extractHttpStatusFromError = (error: unknown): number | undefined => {
  if (error instanceof StreamableHTTPError && typeof error.code === 'number') {
    return error.code
  }
  if (error instanceof Error) {
    const match = /HTTP\s+(\d{3})/.exec(error.message)
    if (match) {
      const code = Number(match[1])
      return Number.isNaN(code) ? undefined : code
    }
  }
  return undefined
}

const shouldFallbackToSse = (error: unknown): boolean => {
  const status = extractHttpStatusFromError(error)
  return status === 400 || status === 404 || status === 405
}

const stripAuthorizationHeaders = (
  headers?: Record<string, string>
): Record<string, string> | undefined => {
  if (!headers) {
    return undefined
  }
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization') {
      continue
    }
    next[key] = value
  }
  return next
}

const buildRequestInit = (headers?: Record<string, string>): RequestInit | undefined => {
  if (!headers) {
    return undefined
  }
  return { headers }
}

export type TransportFactoryOptions = {
  requestInit?: RequestInit
  authProvider?: OAuthClientProvider
}

export const createTransport = (server: MCPServer, options: TransportFactoryOptions = {}): Transport => {
  if (server.transportType === 'streamable_http') {
    const requestInit = options.requestInit ?? buildRequestInit(server.headers)
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit,
      sessionId: server.sessionId,
      reconnectionOptions: server.reconnectionOptions,
      authProvider: options.authProvider
    })
  }

  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...server.env, ...globalEnv },
    stderr: 'pipe'
  })
}

const createSseTransport = (
  server: StreamableHttpServerConfig,
  options: TransportFactoryOptions = {}
): Transport => {
  const requestInit = options.requestInit ?? buildRequestInit(server.headers)
  return new SSEClientTransport(new URL(server.url), {
    requestInit,
    authProvider: options.authProvider
  })
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
  private mcpDBClient: MongoDBClient<MCPServerRecord>
  public secretsService: Secrets
  private oauthTokensService?: McpOAuthTokens
  private packageService?: any // Will be set after initialization to avoid circular dependency

  constructor({
    mongoParams,
    secretsService,
    oauthTokensService
  }: {
    mongoParams: MongoConnectionParams
    secretsService: Secrets
    oauthTokensService?: McpOAuthTokens
  }) {
    this.mcpDBClient = new MongoDBClient<MCPServerRecord>(mongoParams, mcpIndexes)
    this.secretsService = secretsService
    this.oauthTokensService = oauthTokensService
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
  private async migrateServerSecrets(server: MCPServerRecord): Promise<MCPServerRecord> {
    // If already using new format, return as-is
    if (server.secretNames && server.secretNames.length > 0) {
      return server
    }
    
    // If has old format, migrate
    if (server.secretName && !server.secretNames) {
      const migratedServer: MCPServerRecord = {
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
   * Migrates legacy servers to include transportType and normalized config fields.
   */
  private async migrateServerTransport(server: MCPServerRecord): Promise<MCPServer> {
    const transportType: MCPTransportType = server.transportType ?? 'stdio'
    let needsUpdate = server.transportType === undefined

    if (transportType === 'streamable_http') {
      if (!server.url) {
        throw new Error(`Streamable HTTP server ${server.name} is missing url`)
      }

      const { command, args, env, ...rest } = server
      if (command !== undefined || args !== undefined || env !== undefined) {
        needsUpdate = true
      }

      const normalized: MCPServer = {
        ...rest,
        transportType: 'streamable_http',
        url: server.url,
        headers: server.headers,
        sessionId: server.sessionId ?? undefined,
        reconnectionOptions: server.reconnectionOptions
      }

      if (needsUpdate) {
        this.mcpDBClient.update(normalized, { name: server.name }).catch(err => {
          log({
            level: 'warn',
            msg: `Failed to auto-migrate transport for server ${server.name}: ${err.message}`
          })
        })
      }

      return normalized
    }

    if (!server.command) {
      throw new Error(`Stdio server ${server.name} is missing command`)
    }

    const args = server.args ?? []
    const env = server.env ?? {}

    if (server.args === undefined || server.env === undefined) {
      needsUpdate = true
    }
    if (
      server.url !== undefined ||
      server.headers !== undefined ||
      server.sessionId !== undefined ||
      server.reconnectionOptions !== undefined
    ) {
      needsUpdate = true
    }

    const { url, headers, sessionId, reconnectionOptions, ...rest } = server
    const normalized: MCPServer = {
      ...rest,
      transportType: 'stdio',
      command: server.command,
      args,
      env
    }

    if (needsUpdate) {
      this.mcpDBClient.update(normalized, { name: server.name }).catch(err => {
        log({
          level: 'warn',
          msg: `Failed to auto-migrate transport for server ${server.name}: ${err.message}`
        })
      })
    }

    return normalized
  }

  private async normalizeServerRecord(server: MCPServerRecord): Promise<MCPServer> {
    const withSecrets = await this.migrateServerSecrets(server)
    return this.migrateServerTransport(withSecrets)
  }

  private async buildTransportOptions(server: MCPServer): Promise<TransportFactoryOptions> {
    if (server.transportType !== 'streamable_http') {
      return {}
    }

    if (!this.oauthTokensService) {
      return {}
    }

    const record = await this.oauthTokensService.getTokenRecord(server.name)
    if (!record) {
      return {}
    }

    const authProvider = new McpOAuthClientProvider({
      serverName: server.name,
      tokenStore: this.oauthTokensService,
      record
    })
    const sanitizedHeaders = stripAuthorizationHeaders(server.headers)
    return {
      authProvider,
      requestInit: buildRequestInit(sanitizedHeaders ?? {})
    }
  }

  private async persistSessionId(
    serverKey: string,
    server: MCPServer,
    transport: StreamableHTTPClientTransport
  ): Promise<void> {
    if (server.transportType !== 'streamable_http') {
      return
    }
    const nextSessionId = transport.sessionId
    if (nextSessionId === server.sessionId) {
      return
    }
    server.sessionId = nextSessionId
    const current = this.servers[serverKey]
    if (current && current.transportType === 'streamable_http') {
      current.sessionId = nextSessionId
    }
    await this.mcpDBClient.update({ sessionId: nextSessionId }, { name: server.name })
  }

  private async clearServerSessionId(serverKey: string, server: MCPServer): Promise<void> {
    if (server.transportType !== 'streamable_http') {
      return
    }
    server.sessionId = undefined
    const current = this.servers[serverKey]
    if (current && current.transportType === 'streamable_http') {
      current.sessionId = undefined
    }
    await this.mcpDBClient.update({ sessionId: undefined }, { name: server.name })
  }

  /**
   * Convert a built-in server to MCPServer format for API consistency
   */
  private builtInToMCPServer(builtInServer: BuiltInServer): MCPServer {
    return {
      name: builtInServer.externalName, // Use external name for public-facing API
      transportType: 'stdio',
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
      const serverKey = buildServerKey(mcpServer)
      this.servers[serverKey] = mcpServer
      this.serverKeys.push(serverKey)
      log({
        level: 'info',
        msg: `Added built-in server to registry: ${builtInServer.name}`
      })
    }

    // No need to init secrets here, it will be done at a higher level
    const list = await this.mcpDBClient.find({})
    this.list = []
    for (const { _id, ...server } of list ?? []) {
      const baseServer: MCPServerRecord = {
        ...server,
        status: 'disconnected',
        enabled: server.enabled !== false // Default to true if not set
      }

      try {
        const normalized = await this.normalizeServerRecord(baseServer)
        this.list.push(normalized)
      } catch (error) {
        log({
          level: 'error',
          msg: `[${server.name}] Failed to normalize server config; skipping startup.`,
          error: error
        })
      }
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

  private async connectToServer(server: MCPServer, allowSessionRetry = true) {
    const serverKey = buildServerKey(server)
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
      const transportOptions = await this.buildTransportOptions(server)
      const transport = createTransport(server, transportOptions)
      this.servers[serverKey] = {
        ...server,
        status: 'connecting',
        logs: [],
        connection: { client, transport }
      }
      if (!this.serverKeys.includes(serverKey)) {
        this.serverKeys.push(serverKey)
      }

      // Store event handler references
      this.servers[serverKey].eventHandlers = {
        transportErrorHandler,
        transportCloseHandler
      }

      transport.onerror = transportErrorHandler
      transport.onclose = transportCloseHandler

      if (server.transportType === 'stdio') {
        if (!(transport instanceof StdioClientTransport)) {
          throw new Error(`[${server.name}] Expected stdio transport but got a different transport instance.`)
        }

        const stderrStream = transport.stderr
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

        log({
          level: 'info',
          msg: `Attempting to start server ${server.name} with command: ${server.command} ${server.args.join(' ')}`
        })
      } else {
        log({
          level: 'info',
          msg: `Attempting to connect to streamable HTTP server ${server.name} at ${server.url}`
        })
      }

      await this.servers[serverKey].connection!.client.connect(this.servers[serverKey].connection!.transport)
      this.servers[serverKey].status = 'connected'
      if (server.transportType === 'streamable_http' && transport instanceof StreamableHTTPClientTransport) {
        await this.persistSessionId(serverKey, server, transport)
      }
      log({ level: 'info', msg: `[${server.name}] Connected successfully. Will fetch tool list.` })
    } catch (error) {
      if (
        server.transportType === 'streamable_http' &&
        server.sessionId &&
        allowSessionRetry &&
        extractHttpStatusFromError(error) === 404
      ) {
        log({
          level: 'warn',
          msg: `[${server.name}] Streamable HTTP session expired. Clearing sessionId and retrying without it.`
        })
        await this.clearServerSessionId(serverKey, server)
        try {
          await this.teardownServerConnection(serverKey)
        } catch (cleanupError) {
          log({
            level: 'warn',
            msg: `[${server.name}] Failed to close transport after session expiration: ${
              (cleanupError as Error).message
            }`
          })
        }
        const retryServer: MCPServer = {
          ...server,
          sessionId: undefined
        }
        await this.connectToServer(retryServer, false)
        return
      }

      if (server.transportType === 'streamable_http' && shouldFallbackToSse(error)) {
        log({
          level: 'warn',
          msg: `[${server.name}] Streamable HTTP initialize failed with legacy status. Falling back to SSE transport.`
        })

        try {
          if (this.servers[serverKey]?.connection?.transport) {
            this.servers[serverKey].connection!.transport.onerror = undefined
            this.servers[serverKey].connection!.transport.onclose = undefined
            await this.servers[serverKey].connection!.transport.close()
          }
        } catch (cleanupError) {
          log({
            level: 'warn',
            msg: `[${server.name}] Failed to close Streamable HTTP transport during fallback: ${
              (cleanupError as Error).message
            }`
          })
        }

        const fallbackClient = new Client(
          { name: 'MSQStdioClient', version: '1.0.0' },
          { capabilities: { prompts: {}, resources: {}, tools: {} } }
        )
        const transportOptions = await this.buildTransportOptions(server)
        const fallbackTransport = createSseTransport(server, transportOptions)

        fallbackTransport.onerror = transportErrorHandler
        fallbackTransport.onclose = transportCloseHandler

        this.servers[serverKey].connection = {
          client: fallbackClient,
          transport: fallbackTransport
        }

        try {
          await fallbackClient.connect(fallbackTransport)
          this.servers[serverKey].status = 'connected'
          log({
            level: 'info',
            msg: `[${server.name}] Connected successfully using SSE fallback. Will fetch tool list.`
          })
          return
        } catch (fallbackError) {
          log({
            level: 'error',
            msg: `[${server.name}] SSE fallback connection failed.`,
            error: fallbackError
          })
        }
      }

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
      if (server.transportType === 'stdio' && this.packageService) {
        log({ level: 'info', msg: `Attempting to install missing package for server ${server.name}` })
        installSuccess = await this.packageService.installMissingPackage(server.name)
      }

      // If installation failed or no PackageService, mark stdio servers as disabled
      if (server.transportType === 'stdio' && !installSuccess) {
        // Mark server as disabled in the database
        server.enabled = false
        await this.mcpDBClient.update(server, { name: server.name })
        log({ level: 'info', msg: `Server ${server.name} has been disabled due to startup failure` })
      }
    }
  }

  private async teardownServerConnection(serverKey: string): Promise<void> {
    const server = this.servers[serverKey]
    if (!server?.connection) {
      return
    }

    const { transport, client } = server.connection
    const { stderrDataHandler, transportErrorHandler, transportCloseHandler } = server.eventHandlers ?? {}

    if (stderrDataHandler && transport instanceof StdioClientTransport) {
      const stderrStream = transport.stderr
      if (stderrStream) {
        stderrStream.removeListener('data', stderrDataHandler)
      }
    }

    if (transportErrorHandler) {
      transport.onerror = undefined
    }
    if (transportCloseHandler) {
      transport.onclose = undefined
    }

    if (isStreamableHTTPTransport(transport)) {
      try {
        await transport.terminateSession()
      } catch (error) {
        log({
          level: 'warn',
          msg: `[${server.name}] Failed to terminate HTTP session: ${(error as Error).message}`
        })
      }
    }

    await transport.close()
    await client.close()
  }

  private async fetchToolsForServer(
    server: MCPServer,
    retryCount = 0,
    maxRetries = 3,
    initialDelay = 120000
  ) {
    const serverKey = buildServerKey(server)
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
    const allSecrets = await this.secretsService.getSecrets(username)
    if (allSecrets != null) {
      // Get server's declared secret names from metadata
      const serverSecretNames = server.secretNames ?? (server.secretName ? [server.secretName] : [])

      if (serverSecretNames.length > 0) {
        // Inject ONLY secrets declared by this server
        const scopedSecrets: Record<string, string> = {}
        for (const name of serverSecretNames) {
          if (allSecrets[name] !== undefined) {
            scopedSecrets[name] = allSecrets[name]
          }
        }
        args = { ...args, ...scopedSecrets }
        log({
          level: 'info',
          msg: `Scoped secrets applied to tool call - ${serverName}:${methodName} - ${Object.keys(scopedSecrets).join(', ')}`
        })
      } else {
        // Backward compatibility: if server has no declared secretNames,
        // fall back to injecting all secrets (preserves existing behavior
        // for servers not yet migrated to secretNames metadata).
        args = { ...args, ...allSecrets }
        log({
          level: 'warn',
          msg: `Server ${serverName} has no declared secretNames — injecting all secrets (legacy behavior)`
        })
      }
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

  public async addServer(serverData: AddServerInput): Promise<MCPServer> {
    const transportType: MCPTransportType = serverData.transportType ?? 'stdio'

    assertTransportConfigCompatible({
      transportType,
      command: serverData.command,
      args: serverData.args,
      env: serverData.env,
      url: serverData.url,
      headers: serverData.headers,
      sessionId: serverData.sessionId,
      reconnectionOptions: serverData.reconnectionOptions
    })

    const { name, secretName, secretNames, enabled = true, startupTimeout } = serverData

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

    let server: MCPServer
    if (transportType === 'streamable_http') {
      if (!serverData.url) {
        throw new Error('Streamable HTTP servers require a url.')
      }

      new URL(serverData.url)

      server = {
        name,
        transportType: 'streamable_http',
        url: serverData.url,
        headers: serverData.headers,
        sessionId: serverData.sessionId,
        reconnectionOptions: serverData.reconnectionOptions,
        secretNames: finalSecretNames,  // Use normalized value
        secretName: undefined,          // Don't save old format for new servers
        status: 'disconnected',
        enabled,
        startupTimeout
      }
    } else {
      if (!serverData.command) {
        throw new Error('Stdio servers require a command.')
      }

      server = {
        name,
        transportType: 'stdio',
        command: serverData.command,
        args: serverData.args ?? [],
        env: serverData.env ?? {},
        secretNames: finalSecretNames,  // Use normalized value
        secretName: undefined,          // Don't save old format for new servers
        status: 'disconnected',
        enabled,
        startupTimeout
      }
    }

    await this.mcpDBClient.insert(server)
    await this.connectToServer(server)
    this.fetchToolsForServer(server)

    return server
  }

  public async updateServer(
    name: string,
    serverData: UpdateServerInput
  ): Promise<MCPServer | null> {
    // Prevent updating built-in servers
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      throw new Error(`Cannot update built-in server ${name}`)
    }

    const existingRecord = await this.mcpDBClient.findOne({ name })
    if (!existingRecord) {
      throw new Error(`Server with name ${name} not found`)
    }

    const existingServer = await this.normalizeServerRecord({
      ...existingRecord,
      status: existingRecord.status ?? 'disconnected',
      enabled: existingRecord.enabled !== false
    })

    const nextTransportType: MCPTransportType = serverData.transportType ?? existingServer.transportType
    assertTransportConfigCompatible({
      transportType: nextTransportType,
      command: serverData.command,
      args: serverData.args,
      env: serverData.env,
      url: serverData.url,
      headers: serverData.headers,
      sessionId: serverData.sessionId,
      reconnectionOptions: serverData.reconnectionOptions
    })

    // Normalize secrets if provided in update
    let finalSecretNames = serverData.secretNames
    if (!finalSecretNames && serverData.secretName) {
      finalSecretNames = [serverData.secretName]
    }

    // Check if enabled state is changing
    const enabledChanged = serverData.enabled !== undefined && serverData.enabled !== existingServer.enabled

    const updateKeys = Object.keys(serverData).filter(
      key => (serverData as Record<string, unknown>)[key] !== undefined
    )

    // If only the enabled state is changing, use the enable/disable methods
    if (enabledChanged && updateKeys.length === 1) {
      if (serverData.enabled) {
        return this.enableServer(name)
      } else {
        return this.disableServer(name)
      }
    }

    const baseServer: Omit<MCPServerBase, 'status'> & { status: MCPServerBase['status'] } = {
      name,
      secretNames: finalSecretNames ?? existingServer.secretNames,
      secretName: undefined, // Remove old format when updating
      status: existingServer.status,
      enabled: serverData.enabled ?? existingServer.enabled,
      startupTimeout: serverData.startupTimeout ?? existingServer.startupTimeout,
      logs: existingServer.logs,
      connection: existingServer.connection,
      toolsList: existingServer.toolsList,
      eventHandlers: existingServer.eventHandlers
    }

    let updatedServer: MCPServer
    if (nextTransportType === 'streamable_http') {
      const url =
        serverData.url ?? (existingServer.transportType === 'streamable_http' ? existingServer.url : undefined)
      if (!url) {
        throw new Error('Streamable HTTP servers require a url.')
      }
      new URL(url)

      updatedServer = {
        ...baseServer,
        transportType: 'streamable_http',
        url,
        headers:
          serverData.headers ??
          (existingServer.transportType === 'streamable_http' ? existingServer.headers : undefined),
        sessionId:
          serverData.sessionId ??
          (existingServer.transportType === 'streamable_http' ? existingServer.sessionId : undefined),
        reconnectionOptions:
          serverData.reconnectionOptions ??
          (existingServer.transportType === 'streamable_http' ? existingServer.reconnectionOptions : undefined)
      }
    } else {
      const command =
        serverData.command ?? (existingServer.transportType === 'stdio' ? existingServer.command : undefined)
      if (!command) {
        throw new Error('Stdio servers require a command.')
      }

      updatedServer = {
        ...baseServer,
        transportType: 'stdio',
        command,
        args: serverData.args ?? (existingServer.transportType === 'stdio' ? existingServer.args : []),
        env: serverData.env ?? (existingServer.transportType === 'stdio' ? existingServer.env : {})
      }
    }

    await this.mcpDBClient.update(updatedServer, { name })

    // Otherwise, restart the server with the new configuration
    // Stop the existing server if it's running
    const serverKey = buildServerKey(existingServer)
    if (this.servers[serverKey]) {
      try {
        await this.teardownServerConnection(serverKey)
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

  public async updateServerOAuthTokens(
    name: string,
    input: Omit<McpOAuthTokenInput, 'serverName'>
  ): Promise<MCPServer> {
    if (!this.oauthTokensService) {
      throw new Error('OAuth token storage is not configured')
    }
    if (!input.accessToken || !input.clientId || !input.redirectUri) {
      throw new Error('Missing required OAuth fields: accessToken, clientId, redirectUri')
    }

    const server = await this.getServer(name)
    if (!server) {
      throw new Error(`Server ${name} not found`)
    }
    if (server.transportType !== 'streamable_http') {
      throw new Error(`Server ${name} is not a streamable HTTP server`)
    }

    const tokenType = input.tokenType || 'Bearer'
    await this.oauthTokensService.upsertTokenRecord({
      ...input,
      tokenType,
      serverName: name
    })

    const sanitizedHeaders = server.headers ? stripAuthorizationHeaders(server.headers) ?? {} : undefined
    const updated = await this.updateServer(name, { headers: sanitizedHeaders })
    if (!updated) {
      throw new Error(`Failed to update server ${name} after OAuth token update`)
    }
    return updated
  }

  public async deleteServer(name: string): Promise<void> {
    // Prevent deleting built-in servers
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      throw new Error(`Cannot delete built-in server ${name}`)
    }

    const existingRecord = await this.mcpDBClient.findOne({ name })
    if (!existingRecord) {
      throw new Error(`Server with name ${name} not found`)
    }

    const existingServer = await this.normalizeServerRecord({
      ...existingRecord,
      status: existingRecord.status ?? 'disconnected',
      enabled: existingRecord.enabled !== false
    })

    // Stop the server if it's running
    const serverKey = buildServerKey(existingServer)
    if (this.servers[serverKey]) {
      try {
        await this.teardownServerConnection(serverKey)

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

    const record = await this.mcpDBClient.findOne({ name })
    if (!record) {
      return null
    }

    return this.normalizeServerRecord({
      ...record,
      status: record.status ?? 'disconnected',
      enabled: record.enabled !== false
    })
  }

  public async enableServer(name: string): Promise<MCPServer | null> {
    // Built-in servers are always enabled
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      return this.getServer(name)
    }

    const record = await this.mcpDBClient.findOne({ name })
    if (!record) {
      throw new Error(`Server ${name} not found`)
    }
    const server = await this.normalizeServerRecord({
      ...record,
      status: record.status ?? 'disconnected',
      enabled: record.enabled !== false
    })
    const updatedServer: MCPServer = { ...server, enabled: true }
    await this.mcpDBClient.update(updatedServer, { name })

    // If server is not running, start it
    const serverKey = buildServerKey(updatedServer)

    // Update the enabled status in the in-memory server object
    if (this.servers[serverKey]) {
      this.servers[serverKey].enabled = true
    }
    if (
      !this.servers[serverKey] ||
      this.servers[serverKey].status === 'disconnected' ||
      this.servers[serverKey].status === 'error'
    ) {
      await this.connectToServer(updatedServer)
      this.fetchToolsForServer(updatedServer)
    }

    return updatedServer
  }

  public async disableServer(name: string): Promise<MCPServer | null> {
    // Cannot disable built-in servers
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      throw new Error(`Cannot disable built-in server ${name}`)
    }

    const record = await this.mcpDBClient.findOne({ name })
    if (!record) {
      throw new Error(`Server ${name} not found`)
    }
    const server = await this.normalizeServerRecord({
      ...record,
      status: record.status ?? 'disconnected',
      enabled: record.enabled !== false
    })
    const updatedServer: MCPServer = { ...server, enabled: false }
    await this.mcpDBClient.update(updatedServer, { name })

    // If server is running, stop it
    const serverKey = buildServerKey(updatedServer)

    // Update the enabled status in the in-memory server object
    if (this.servers[serverKey]) {
      this.servers[serverKey].enabled = false
    }
    if (this.servers[serverKey] && this.servers[serverKey].status !== 'disconnected') {
      try {
        await this.teardownServerConnection(serverKey)
        this.servers[serverKey].status = 'disconnected'
        log({ level: 'info', msg: `Server ${name} stopped due to being disabled` })
      } catch (error) {
        log({ level: 'error', msg: `Error stopping server ${name}: ${error}` })
      }
    }

    return updatedServer
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
          await this.teardownServerConnection(serverKey)
          this.servers[serverKey].status = 'disconnected'
          log({ level: 'info', msg: `${this.servers[serverKey].name} stopped` })
        } catch (error) {
          log({ level: 'error', msg: `${serverKey} error stopping: ${error}` })
        }
      }
    }
    await this.mcpDBClient.disconnect()
    if (this.oauthTokensService) {
      await this.oauthTokensService.stop()
    }
  }
}
