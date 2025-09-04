import { Express, NextFunction, Request, RequestHandler, Response } from 'express'
import { MCPService } from '../services/mcp'
import { MongoConnectionParams } from '../utils/mongodb'
import { Resource } from '..'
import { log } from '../utils/general'
import { Secrets } from '../services/secrets'

export interface ToolCallRequest {
  username?: string
  serverName: string
  methodName: string
  args: Record<string, unknown>
}

export interface SetSecretRequest {
  username: string
  serverName: string
  secretName: string
  secretValue: string
}

export interface DeleteSecretRequest {
  username: string
  serverName: string
  secretName: string
}

export interface AddServerRequest {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
  startupTimeout?: number
}

export interface UpdateServerRequest {
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
  startupTimeout?: number
}

export class MCPController implements Resource {
  private app: Express
  private mcpService: MCPService

  constructor({
    app,
    mongoParams,
    secretsService
  }: {
    app: Express
    mongoParams: MongoConnectionParams
    secretsService: Secrets
  }) {
    this.app = app
    this.mcpService = new MCPService({ mongoParams, secretsService })
  }

  /**
   * Get the MCP service instance
   * @returns The MCP service instance
   */
  public getMcpService(): MCPService {
    return this.mcpService
  }

  public async init() {
    await this.mcpService.init()
  }

  public registerRoutes(): void {
    this.app.post('/mcp/tool/call', this.callTool.bind(this))
    this.app.get('/mcp/servers', this.getServers.bind(this))
    this.app.get('/mcp/servers/:name', this.getServer.bind(this))
    this.app.post('/mcp/servers', this.addServer.bind(this))
    this.app.put('/mcp/servers/:name', this.updateServer.bind(this))
    this.app.delete('/mcp/servers/:name', this.deleteServer.bind(this))
    this.app.put('/mcp/servers/:name/enable', this.enableServer.bind(this))
    this.app.put('/mcp/servers/:name/disable', this.disableServer.bind(this))
    this.app.get('/mcp/tools', this.getTools.bind(this))
    this.app.post('/secrets/set', this.setSecret.bind(this))
    this.app.post('/secrets/delete', this.deleteSecret.bind(this))
  }

  private getServers(req: Request, res: Response, next: NextFunction): void {
    try {
      const servers = Object.values(this.mcpService.servers).map(
        ({ name, command, args, env, secretName, status, enabled, toolsList, logs }) => ({
          name,
          command,
          args,
          env,
          secretName,
          status,
          enabled,
          toolsList,
          logs
        })
      )
      log({ level: 'info', msg: 'sending servers list' })
      res.json({ success: true, servers })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  private getTools(req: Request, res: Response, next: NextFunction): void {
    try {
      // Filter to only include enabled servers before mapping tools
      const tools = Object.values(this.mcpService.servers)
        .filter(server => server.enabled)
        .map(({ name, toolsList }) => ({
          [`${name}`]: [...(toolsList ?? [])]
        }))
      log({ level: 'info', msg: 'sending tools list' })
      res.json({ success: true, tools })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  private async callTool(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as ToolCallRequest
      let { serverName, methodName, args } = body
      const username = body.username ?? 'default'

      // 1. Get the server's configuration from the MCPService
      const server = await this.mcpService.getServer(serverName)
      const authType = server?.env?.MCP_AUTH_TYPE

      // 2. Check if the server has declared it needs Google OAuth2 tokens
      if (authType === 'OAUTH2_GOOGLE' && !methodName.startsWith('auth_')) {
        // 3. Retrieve the encrypted tokens using the Secrets service
        const userSecrets = await this.mcpService.secretsService.getSecrets(username)
        const googleTokensString = userSecrets?.google_tokens

        if (!googleTokensString) {
          throw new Error(`Google tokens not found for user ${username}. Please authenticate.`)
        }
        const googleTokens = JSON.parse(googleTokensString)

        // 4. Retrieve the app's OAuth client details (from env or secure config)
        const gauthFileContent = JSON.parse(process.env.GOOGLE_OAUTH_CREDENTIALS || '{}')

        // 5. Inject the hidden parameters
        args = {
          ...args,
          userCredentials: googleTokens,
          gauthFileContent: gauthFileContent
        }
      }

      log({
        level: 'info',
        msg: `calling tool ${methodName} on server ${serverName} with args ${JSON.stringify(args)}`
      })
      const result = await this.mcpService.callTool(username, serverName, methodName, args)
      res.json({ success: true, data: result })
    } catch (error) {
      log({ level: 'error', msg: `error calling tool: ${(error as Error).message}` })
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  public async setSecret(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as SetSecretRequest
      const { secretName, secretValue } = body
      const username = body.username ?? 'default'
      await this.mcpService.setSecret(username, secretName, secretValue)
      log({ level: 'info', msg: `set secret ${secretName}` })
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  public async deleteSecret(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as DeleteSecretRequest
      const { secretName } = body
      const username = body.username ?? 'default'
      await this.mcpService.deleteSecret(username, secretName)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  private async addServer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as AddServerRequest
      const result = await this.mcpService.addServer(body)
      res.json({ success: true, server: result })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  private async updateServer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      const body = req.body as UpdateServerRequest
      const result = await this.mcpService.updateServer(name, body)
      res.json({ success: true, server: result })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  private async deleteServer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      await this.mcpService.deleteServer(name)
      res.json({ success: true })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  private async getServer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      const server = await this.mcpService.getServer(name)
      if (!server) {
        res.status(404).json({ success: false, error: `Server ${name} not found` })
        return
      }
      res.json({ success: true, server })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  private async enableServer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      const server = await this.mcpService.enableServer(name)
      res.json({ success: true, server })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  private async disableServer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      const server = await this.mcpService.disableServer(name)
      res.json({ success: true, server })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  public async stop() {
    await this.mcpService.stop()
  }
}
