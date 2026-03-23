import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'

export interface McpUserSessionRecord {
  serverName: string
  username: string
  sessionId?: string
  updatedAt: Date
}

const sessionIndexes: IndexDefinition[] = [
  { name: 'serverName_username', key: { serverName: 1, username: 1 }, unique: true }
]

export class McpUserSessions {
  private dbClient: MongoDBClient<McpUserSessionRecord>

  constructor({ mongoParams }: { mongoParams: MongoConnectionParams }) {
    this.dbClient = new MongoDBClient<McpUserSessionRecord>(mongoParams, sessionIndexes)
  }

  public async init(): Promise<void> {
    await this.dbClient.connect('mcpUserSessions')
  }

  public async getSession(serverName: string, username: string): Promise<McpUserSessionRecord | null> {
    return this.dbClient.findOne({ serverName, username })
  }

  public async upsertSession(serverName: string, username: string, sessionId: string | undefined): Promise<void> {
    await this.dbClient.upsert(
      {
        serverName,
        username,
        sessionId,
        updatedAt: new Date()
      },
      { serverName, username }
    )
  }

  public async clearSession(serverName: string, username: string): Promise<void> {
    await this.dbClient.update(
      {
        sessionId: undefined,
        updatedAt: new Date()
      },
      { serverName, username }
    )
  }

  public async deleteSession(serverName: string, username: string): Promise<void> {
    await this.dbClient.delete({ serverName, username }, false)
  }

  public async deleteSessionsByServer(serverName: string): Promise<void> {
    await this.dbClient.delete({ serverName })
  }

  public async listSessionsForServer(serverName: string): Promise<McpUserSessionRecord[]> {
    return this.dbClient.find({ serverName })
  }

  public async stop(): Promise<void> {
    await this.dbClient.disconnect()
  }
}
