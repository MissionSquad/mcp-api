#!/usr/bin/env node
import express, { Express, Request, Response, NextFunction } from 'express'
import bodyParser from 'body-parser'
import { log } from './utils/general'
import { env } from './env'
import { MongoConnectionParams } from './utils/mongodb'
import { MCPController } from './controllers/mcp'
import { PackagesController } from './controllers/packages'
import { AuthController } from './controllers/auth'
import { Secrets } from './services/secrets'

export type Resource = {
  init: () => Promise<void>
  stop: () => Promise<void>
}


const mongoParams: MongoConnectionParams = {
  user: env.MONGO_USER,
  pass: env.MONGO_PASS,
  host: env.MONGO_HOST,
  db: env.MONGO_DBNAME,
  replicaSet: env.MONGO_REPLICASET
}

export class API {
  private app: Express = express()
  private resources: Resource[] = []

  constructor() {
    this.app.use(bodyParser.json({ limit: env.PAYLOAD_LIMIT }))
    this.app.use(bodyParser.urlencoded({ extended: false, limit: env.PAYLOAD_LIMIT }))
    log({ level: 'info', msg: `Payload limit is: ${env.PAYLOAD_LIMIT}` })
  }

  public async start() {
    const { app } = this

    // Initialize Secrets service
    const secretsService = new Secrets({ mongoParams })
    await secretsService.init()
    
    // Initialize MCP controller
    const mcpController = new MCPController({ app, mongoParams, secretsService })
    await mcpController.init()
    mcpController.registerRoutes()
    this.resources.push(mcpController)

    // Initialize Auth controller
    const authController = new AuthController(app, mcpController.getMcpService(), secretsService)
    authController.registerRoutes()
    
    // Initialize Packages controller
    const packagesController = new PackagesController({ 
      app, 
      mongoParams, 
      mcpService: mcpController.getMcpService() 
    })
    await packagesController.init()
    packagesController.registerRoutes()
    this.resources.push(packagesController)
    
    // Set up circular dependency between MCPService and PackageService
    mcpController.getMcpService().setPackageService(packagesController.getPackageService())

    app.get('/healthz', (req, res) => {
      console.log('Health checked')
      res.status(200).send('OK')
    })

    // Start the server
    app.listen(env.PORT, () => {
      log({ level: 'info', msg: `Server running at http://localhost:${env.PORT}` })
    })
  }

  public async shutDown(reason: string) {
    log({ level: 'info', msg: `Shutting down due to ${reason}...` })
    for (const resource of this.resources) {
      await resource.stop()
    }
    log({ level: 'info', msg: 'Shutdown complete.' })
  }
}

const api = new API()

// Global error handlers to prevent crash loops
process.on('unhandledRejection', (reason, promise) => {
  log({ level: 'error', msg: 'Unhandled Rejection at:', error: reason })
  // Application specific logging, throwing an error, or other logic here
})

process.on('uncaughtException', err => {
  log({ level: 'error', msg: 'Uncaught Exception thrown:', error: err })
  // It's generally recommended to gracefully shut down the process
  // process.exit(1); // Uncomment if you want to exit on uncaught exceptions
})

process.on('SIGINT', async () => {
  await api.shutDown('SIGINT')
  process.exit(0)
})
process.on('SIGTERM', async () => {
  await api.shutDown('SIGTERM')
  process.exit(0)
})

api.start().catch(async (err) => {
  console.error(err)
  await api.shutDown('ERROR')
  process.exit(1)
})
