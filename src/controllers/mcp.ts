import { Express, NextFunction, Request, RequestHandler, Response } from 'express'
import { MCPService } from '../services/mcp'
import type {
  AddServerInput,
  DiscoverExternalAuthorizationInput,
  SaveUserServerSecretsInput,
  UpdateServerInput
} from '../services/mcp'
import { MongoConnectionParams } from '../utils/mongodb'
import { Resource } from '..'
import { log } from '../utils/general'
import { Secrets } from '../services/secrets'
import type { McpOAuthTokenInput } from '../services/oauthTokens'
import type { McpOAuthTokens } from '../services/oauthTokens'
import type { McpUserSessions } from '../services/userSessions'
import type { InstallUserServerInput, UpdateUserServerInstallInput, McpUserServerInstalls } from '../services/userServerInstalls'
import { McpValidationError, toMcpErrorResponse } from '../services/mcpErrors'
import type { ExternalOAuthProvisioningContext } from '../services/dcrClients'

export interface ToolCallRequest {
  username: string
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

export type AddServerRequest = AddServerInput

export type UpdateServerRequest = UpdateServerInput

export type UpdateServerOAuthRequest = Omit<McpOAuthTokenInput, 'serverName'> & { username: string }
export interface ResolveExternalOAuthClientRequest {
  username: string
  oauthProvisioningContext: ExternalOAuthProvisioningContext
}

export const requireUsername = (username: string | undefined, context: string): string => {
  const normalized = username?.trim()
  if (!normalized) {
    throw new McpValidationError(`username is required for ${context}`)
  }
  return normalized
}

export class MCPController implements Resource {
  private app: Express
  private mcpService: MCPService

  constructor({
    app,
    mongoParams,
    secretsService,
    oauthTokensService,
    userSessionsService,
    userServerInstalls,
    dcrClients
  }: {
    app: Express
    mongoParams: MongoConnectionParams
    secretsService: Secrets
    oauthTokensService?: McpOAuthTokens
    userSessionsService?: McpUserSessions
    userServerInstalls: McpUserServerInstalls
    dcrClients?: import('../services/dcrClients').McpDcrClients
  }) {
    this.app = app
    this.mcpService = new MCPService({
      mongoParams,
      secretsService,
      oauthTokensService,
      userSessionsService,
      userServerInstalls,
      dcrClients
    })
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
    this.app.post('/mcp/servers/:name/oauth', this.updateServerOAuth.bind(this))
    this.app.delete('/mcp/servers/:name', this.deleteServer.bind(this))
    this.app.get('/mcp/servers/:name/delete-impact', this.getSharedServerDeleteImpact.bind(this))
    this.app.put('/mcp/servers/:name/enable', this.enableServer.bind(this))
    this.app.put('/mcp/servers/:name/disable', this.disableServer.bind(this))
    this.app.get('/mcp/tools', this.getTools.bind(this))
    this.app.get('/mcp/user/tools', this.getUserTools.bind(this))
    this.app.get('/mcp/user/servers', this.getUserServers.bind(this))
    this.app.get('/mcp/user/servers/:name', this.getUserServer.bind(this))
    this.app.get('/mcp/user/servers/:name/install', this.getUserServerInstall.bind(this))
    this.app.get('/mcp/user/servers/:name/tools', this.getUserServerTools.bind(this))
    this.app.post('/mcp/user/servers/:name/install', this.installUserServer.bind(this))
    this.app.put('/mcp/user/servers/:name/install', this.updateUserServerInstall.bind(this))
    this.app.delete('/mcp/user/servers/:name/install', this.uninstallUserServer.bind(this))
    this.app.post('/mcp/user/servers/:name/secrets', this.saveUserServerSecrets.bind(this))
    this.app.post('/mcp/user/servers/:name/refresh', this.refreshUserServer.bind(this))
    this.app.post('/mcp/user/servers/:name/oauth-client/resolve', this.resolveExternalOAuthClient.bind(this))
    this.app.post('/mcp/external/discover', this.discoverExternalAuthorization.bind(this))
    this.app.post('/secrets/set', this.setSecret.bind(this))
    this.app.post('/secrets/delete', this.deleteSecret.bind(this))
  }

  private getServers(req: Request, res: Response, next: NextFunction): void {
    try {
      const servers = Object.values(this.mcpService.servers).map(server => {
        const base = {
          name: server.name,
          displayName: server.displayName,
          description: server.description,
          source: server.source,
          authMode: server.authMode,
          oauthTemplate: server.oauthTemplate,
          secretFields: server.secretFields,
          homepageUrl: server.homepageUrl,
          repositoryUrl: server.repositoryUrl,
          licenseName: server.licenseName,
          transportType: server.transportType,
          secretNames: server.secretNames, // Only return new format (migration already happened)
          // secretName is intentionally excluded from response
          status: server.status,
          enabled: server.enabled,
          startupTimeout: server.startupTimeout,
          toolsList: server.toolsList,
          logs: server.logs
        }

        if (server.transportType === 'stdio') {
          return {
            ...base,
            command: server.command,
            args: server.args,
            env: server.env
          }
        }

        return {
          ...base,
          url: server.url,
          headers: server.headers,
          reconnectionOptions: server.reconnectionOptions
        }
      })
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

  private async getUserTools(req: Request, res: Response): Promise<void> {
    try {
      const username = requireUsername(typeof req.query.username === 'string' ? req.query.username : undefined, 'listing user tools')
      const tools = await this.mcpService.getUserTools(username)
      res.json({ success: true, tools })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async getUserServers(req: Request, res: Response): Promise<void> {
    try {
      const username = requireUsername(typeof req.query.username === 'string' ? req.query.username : undefined, 'listing user servers')
      const servers = await this.mcpService.getUserServers(username)
      res.json({ success: true, servers })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async getUserServer(req: Request, res: Response): Promise<void> {
    try {
      const username = requireUsername(typeof req.query.username === 'string' ? req.query.username : undefined, 'getting a user server')
      const server = await this.mcpService.getUserServer(username, req.params.name)
      if (!server) {
        res.status(404).json({ success: false, error: `Server ${req.params.name} not found` })
        return
      }
      res.json({ success: true, server })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async getUserServerInstall(req: Request, res: Response): Promise<void> {
    try {
      const username = requireUsername(
        typeof req.query.username === 'string' ? req.query.username : undefined,
        'getting a user server install'
      )
      const install = await this.mcpService.getUserServerInstallDetails(username, req.params.name)
      if (!install) {
        res.status(404).json({ success: false, error: `Server ${req.params.name} is not installed for user ${username}` })
        return
      }
      res.json({ success: true, install })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async getUserServerTools(req: Request, res: Response): Promise<void> {
    try {
      const username = requireUsername(typeof req.query.username === 'string' ? req.query.username : undefined, 'getting user server tools')
      const tools = await this.mcpService.getUserServerTools(username, req.params.name)
      res.json({ success: true, tools })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async callTool(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as ToolCallRequest
      let { serverName, methodName, args } = body
      const username = requireUsername(body.username, 'tool calls')

      // 1. Get the server's configuration from the MCPService
      const server = await this.mcpService.getServer(serverName)
      const authType = server && server.transportType === 'stdio' ? server.env?.MCP_AUTH_TYPE : undefined

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
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  public async setSecret(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as SetSecretRequest
      const { secretName, secretValue } = body
      const username = requireUsername(body.username, 'setting secrets')
      await this.mcpService.setSecret(username, secretName, secretValue)
      log({ level: 'info', msg: `set secret ${secretName}` })
      res.json({ success: true })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  public async deleteSecret(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as DeleteSecretRequest
      const { secretName } = body
      const username = requireUsername(body.username, 'deleting secrets')
      await this.mcpService.deleteSecret(username, secretName)
      res.json({ success: true })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async installUserServer(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body as Partial<InstallUserServerInput>
      const username = requireUsername(body.username, 'installing a user server')
      const server = await this.mcpService.installUserServer({
        serverName: req.params.name,
        username,
        enabled: body.enabled === true,
        oauthClientId: body.oauthClientId,
        oauthClientSecret: body.oauthClientSecret,
        oauthScopes: body.oauthScopes
      })
      res.json({ success: true, server })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async updateUserServerInstall(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body as Partial<UpdateUserServerInstallInput>
      const username = requireUsername(body.username, 'updating a user server install')
      const server = await this.mcpService.updateUserServerInstall({
        serverName: req.params.name,
        username,
        enabled: body.enabled === true,
        oauthClientId: body.oauthClientId,
        oauthClientSecret: body.oauthClientSecret,
        oauthScopes: body.oauthScopes
      })
      res.json({ success: true, server })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async uninstallUserServer(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body as { username?: string }
      const username = requireUsername(body.username, 'uninstalling a user server')
      await this.mcpService.uninstallUserServer(req.params.name, username)
      res.json({ success: true })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async saveUserServerSecrets(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body as SaveUserServerSecretsInput
      const username = requireUsername(body.username, 'saving user server secrets')
      await this.mcpService.saveUserServerSecrets({
        serverName: req.params.name,
        username,
        secrets: body.secrets
      })
      res.json({ success: true })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async refreshUserServer(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body as { username?: string }
      const username = requireUsername(body.username, 'refreshing a user server')
      const server = await this.mcpService.refreshUserServer(req.params.name, username)
      res.json({ success: true, server })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async discoverExternalAuthorization(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body as DiscoverExternalAuthorizationInput
      const result = await this.mcpService.discoverExternalAuthorization(body)
      res.json({ success: true, ...result })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async resolveExternalOAuthClient(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body as ResolveExternalOAuthClientRequest
      const username = requireUsername(body.username, 'resolving external OAuth client')
      const client = await this.mcpService.resolveExternalOAuthClientContext({
        serverName: req.params.name,
        username,
        oauthProvisioningContext: body.oauthProvisioningContext
      })
      res.json({ success: true, client })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async addServer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as AddServerRequest
      const result = await this.mcpService.addServer(body)
      if (body.source === 'external' && body.username) {
        const userServer = await this.mcpService.getUserServer(body.username, body.name)
        res.json({ success: true, server: userServer ?? result })
        return
      }
      res.json({ success: true, server: result })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async updateServer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      const body = req.body as UpdateServerRequest
      const result = await this.mcpService.updateServer(name, body)
      res.json({ success: true, server: result })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async updateServerOAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      const body = req.body as UpdateServerOAuthRequest
      const username = requireUsername(body.username, 'OAuth token update')
      const { username: _username, ...tokenInput } = body
      const result = await this.mcpService.updateServerOAuthTokens(name, username, tokenInput)
      res.json({ success: true, server: result })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async deleteServer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      await this.mcpService.deleteServer(name)
      res.json({ success: true })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async getSharedServerDeleteImpact(req: Request, res: Response): Promise<void> {
    try {
      const impact = await this.mcpService.getSharedServerDeleteImpact(req.params.name)
      res.json({ success: true, impact })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
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
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async enableServer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      const server = await this.mcpService.enableServer(name)
      res.json({ success: true, server })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  private async disableServer(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      const server = await this.mcpService.disableServer(name)
      res.json({ success: true, server })
    } catch (error) {
      const response = toMcpErrorResponse(error)
      res.status(response.statusCode).json(response.body)
    }
  }

  public async stop() {
    await this.mcpService.stop()
  }
}
