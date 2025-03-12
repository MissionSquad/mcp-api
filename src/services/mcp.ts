import { Client } from '@modelcontextprotocol/sdk/client/index.js'
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
  private secrets: Secrets
  private packageService?: any // Will be set after initialization to avoid circular dependency

  constructor({ mongoParams }: { mongoParams: MongoConnectionParams }) {
    this.mcpDBClient = new MongoDBClient<MCPServer>(mongoParams, mcpIndexes)
    this.secrets = new Secrets({ mongoParams })
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
    await this.secrets.init()
    const list = await this.mcpDBClient.find({})
    this.list = (list ?? []).map(({ _id, ...server }) => ({ 
      ...server, 
      status: 'disconnected',
      enabled: server.enabled !== false // Default to true if not set
    }))
    for (const server of this.list) {
      await this.startMCPServer(server)
    }
    log({ level: 'info', msg: `MCPService initialized with ${this.list.length} servers`})
  }

  private async startMCPServer(server: MCPServer) {
    // Skip if server is disabled
    if (server.enabled === false) {
      log({ level: 'info', msg: `Server ${server.name} is disabled, skipping startup` })
      return
    }

    const serverKey = sanitizeString(`${server.name}-${server.command}`)
    
    try {
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
      
      // can't call start again, so we reassign it below with a monkey patch. thanks for the tip @saoudrizwan!
      this.servers[serverKey].connection?.transport.start()
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
    } catch (error: any) {
      log({ level: 'error', msg: `Failed to start server ${server.name}: ${error.message}` })
      
      // Attempt to install missing package if PackageService is available
      let installSuccess = false;
      if (this.packageService) {
        log({ level: 'info', msg: `Attempting to install missing package for server ${server.name}` });
        installSuccess = await this.packageService.installMissingPackage(server.name);
      }
      
      // If installation failed or no PackageService, mark as disabled
      if (!installSuccess) {
        // Mark server as disabled in the database
        server.enabled = false;
        await this.mcpDBClient.update(server, { name: server.name });
        log({ level: 'info', msg: `Server ${server.name} has been disabled due to startup failure` });
      }
    }
  }

  public async callTool(username: string, serverName: string, methodName: string, args: Record<string, unknown>) {
    const server = Object.values(this.servers).find((server) => server.name === serverName)
    if (!server) {
      log({ level: 'error', msg: `Server ${serverName} not found` })
      return undefined
    }
    if (server.status != 'connected') {
      log({ level: 'error', msg: `Server ${serverName} not connected. Status: ${server.status}` })
      return undefined
    }
    const secrets = await this.secrets.getSecrets(username, serverName)
    if (secrets[serverName] != null) {
      args = { ...args, ...secrets[serverName] }
    }
    log({ level: 'info', msg: `Calling tool - ${serverName}:${methodName}` })
    const toolResponse = await server.connection!.client.callTool({ name: methodName, arguments: args }, CallToolResultSchema)
    log({ level: 'info', msg: `Tool called - ${serverName}:${methodName}` })
    if (Array.isArray(toolResponse.content)) {
      toolResponse.content = toolResponse.content.map((item) => {
        return item
      })
    }
    return toolResponse
  }

  public async setSecret(username: string, serverName: string, secretName: string, secretValue: string) {
    await this.secrets.updateSecret({ username, serverName, secretName, secretValue, action: 'update' })
  }

  public async deleteSecret(username: string, serverName: string, secretName: string) {
    await this.secrets.updateSecret({ username, serverName, secretName, secretValue: '', action: 'delete' })
  }

  public async addServer(serverData: { name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }): Promise<MCPServer> {
    const { name, command, args = [], env = {}, enabled = true } = serverData;
    
    // Check if server with this name already exists
    const existingServer = await this.mcpDBClient.findOne({ name });
    if (existingServer) {
      throw new Error(`Server with name ${name} already exists`);
    }
    
    const server: MCPServer = {
      name,
      command,
      args,
      env,
      status: 'disconnected',
      enabled
    };
    
    await this.mcpDBClient.insert(server);
    await this.startMCPServer(server);
    
    return server;
  }

  public async updateServer(name: string, serverData: { command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }): Promise<MCPServer | null> {
    const existingServer = await this.mcpDBClient.findOne({ name });
    if (!existingServer) {
      throw new Error(`Server with name ${name} not found`);
    }
    
    // Check if enabled state is changing
    const enabledChanged = serverData.enabled !== undefined && serverData.enabled !== existingServer.enabled;
    
    const updatedServer: MCPServer = {
      ...existingServer,
      ...serverData,
      name // Ensure name doesn't change
    };
    
    await this.mcpDBClient.update(updatedServer, { name });
    
    // If only the enabled state is changing, use the enable/disable methods
    if (enabledChanged && Object.keys(serverData).length === 1) {
      if (serverData.enabled) {
        return this.enableServer(name);
      } else {
        return this.disableServer(name);
      }
    }
    
    // Otherwise, restart the server with the new configuration
    // Stop the existing server if it's running
    const serverKey = sanitizeString(`${name}-${existingServer.command}`);
    if (this.servers[serverKey]) {
      try {
        await this.servers[serverKey].connection?.transport.close();
        await this.servers[serverKey].connection?.client.close();
        delete this.servers[serverKey];
      } catch (error) {
        log({ level: 'error', msg: `Error stopping server ${name}: ${error}` });
      }
    }
    
    // Start the updated server (startMCPServer will respect the enabled flag)
    await this.startMCPServer(updatedServer);
    
    return updatedServer;
  }

  public async deleteServer(name: string): Promise<void> {
    const existingServer = await this.mcpDBClient.findOne({ name });
    if (!existingServer) {
      throw new Error(`Server with name ${name} not found`);
    }
    
    // Stop the server if it's running
    const serverKey = sanitizeString(`${name}-${existingServer.command}`);
    if (this.servers[serverKey]) {
      try {
        await this.servers[serverKey].connection?.transport.close();
        await this.servers[serverKey].connection?.client.close();
        delete this.servers[serverKey];
      } catch (error) {
        log({ level: 'error', msg: `Error stopping server ${name}: ${error}` });
      }
    }
    
    await this.mcpDBClient.delete({ name }, false);
  }

  public async getServer(name: string): Promise<MCPServer | null> {
    return this.mcpDBClient.findOne({ name });
  }

  public async enableServer(name: string): Promise<MCPServer | null> {
    const server = await this.mcpDBClient.findOne({ name });
    if (!server) {
      throw new Error(`Server ${name} not found`);
    }
    
    server.enabled = true;
    await this.mcpDBClient.update(server, { name });
    
    // If server is not running, start it
    const serverKey = sanitizeString(`${name}-${server.command}`);
    if (!this.servers[serverKey] || this.servers[serverKey].status === 'disconnected' || this.servers[serverKey].status === 'error') {
      await this.startMCPServer(server);
    }
    
    return server;
  }

  public async disableServer(name: string): Promise<MCPServer | null> {
    const server = await this.mcpDBClient.findOne({ name });
    if (!server) {
      throw new Error(`Server ${name} not found`);
    }
    
    server.enabled = false;
    await this.mcpDBClient.update(server, { name });
    
    // If server is running, stop it
    const serverKey = sanitizeString(`${name}-${server.command}`);
    if (this.servers[serverKey] && this.servers[serverKey].status !== 'disconnected') {
      try {
        await this.servers[serverKey].connection?.transport.close();
        await this.servers[serverKey].connection?.client.close();
        this.servers[serverKey].status = 'disconnected';
        log({ level: 'info', msg: `Server ${name} stopped due to being disabled` });
      } catch (error) {
        log({ level: 'error', msg: `Error stopping server ${name}: ${error}` });
      }
    }
    
    return server;
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
