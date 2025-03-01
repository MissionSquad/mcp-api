#!/usr/bin/env node
import express, { Express, Request, Response, NextFunction } from 'express'
import bodyParser from 'body-parser'
import { log } from './utils/general'
import { env } from './env'
import { MongoConnectionParams } from './utils/mongodb'
import { MCPController } from './controllers/mcp'

export type Resource = {
  init: () => Promise<void>
  stop: () => Promise<void>
}


const mongoParams: MongoConnectionParams = {
  user: env.MONGO_USER,
  pass: env.MONGO_PASS,
  host: env.MONGO_HOST,
  db: env.MONGO_DBNAME
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
    const mcpController = new MCPController({ app, mongoParams })
    await mcpController.init()
    mcpController.registerRoutes()
    this.resources.push(mcpController)

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