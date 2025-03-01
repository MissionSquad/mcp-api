import { Express, NextFunction, Request, RequestHandler, Response } from 'express'
import { MCPService } from '../services/mcp'
import { MongoConnectionParams } from '../utils/mongodb'
import { Resource } from '..'
import { log } from '../utils/general'

export interface ToolCallRequest {
  serverName: string
  methodName: string
  args: Record<string, unknown>
}

export class MCPController implements Resource {
  private app: Express
  private mcpService: MCPService
  
  constructor({ app, mongoParams }: { app: Express, mongoParams: MongoConnectionParams }) {
    this.app = app
    this.mcpService = new MCPService({ mongoParams })
  }

  public async init() {
    await this.mcpService.init()
  }

  public registerRoutes(): void {
    this.app.post('/mcp/tool/call', this.callTool.bind(this))
    this.app.get('/mcp/servers', this.getServers.bind(this))
    this.app.get('/mcp/tools', this.getTools.bind(this))
  }

  private getServers(req: Request, res: Response, next: NextFunction): void {
    try {
      const servers = Object.values(this.mcpService.servers)
        .map(({ name, command, args, env, status, toolsList, errors }) => ({ name, command, args, env, status, toolsList, errors }))
      log({ level: 'info', msg: 'sending servers list'})
      res.json({ success: true, servers })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  private getTools(req: Request, res: Response, next: NextFunction): void {
    try {
      const tools = Object.values(this.mcpService.servers)
        .map(({ name, toolsList }) => ({ [`${name}`]: [ ...toolsList ?? [] ] }))
      log({ level: 'info', msg: 'sending tools list' })
      res.json({ success: true, tools })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  private async callTool(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { serverName, methodName, args } = req.body as ToolCallRequest
      const result = await this.mcpService.callTool(serverName, methodName, args)
      res.json({ success: true, data: result })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }

  public async stop() {
    await this.mcpService.stop()
  }
}