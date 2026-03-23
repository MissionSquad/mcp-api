import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'

export type UserInstallAuthState = 'not_required' | 'not_connected' | 'connected' | 'reauth_required' | 'error'

export interface InstallUserServerInput {
  serverName: string
  username: string
  enabled: boolean
  authMode: 'none' | 'oauth2'
  oauthClientId?: string
  oauthClientSecret?: string
  oauthScopes?: string[]
}

export interface UpdateUserServerInstallInput extends InstallUserServerInput {}

export interface McpUserExternalServerInstallRecord {
  serverName: string
  username: string
  enabled: boolean
  authState: UserInstallAuthState
  oauthClientId?: string
  oauthClientSecret?: string
  oauthScopes?: string[]
  lastAuthError?: string
  createdAt: Date
  updatedAt: Date
}

const installIndexes: IndexDefinition[] = [
  { name: 'serverName_username', key: { serverName: 1, username: 1 }, unique: true },
  { name: 'username', key: { username: 1 } },
  { name: 'serverName', key: { serverName: 1 } }
]

export const resolveInitialUserInstallAuthState = (
  existingAuthState: UserInstallAuthState | undefined,
  authMode: InstallUserServerInput['authMode']
): UserInstallAuthState => existingAuthState ?? (authMode === 'oauth2' ? 'not_connected' : 'not_required')

export class McpUserServerInstalls {
  private dbClient: MongoDBClient<McpUserExternalServerInstallRecord>

  constructor({ mongoParams }: { mongoParams: MongoConnectionParams }) {
    this.dbClient = new MongoDBClient<McpUserExternalServerInstallRecord>(mongoParams, installIndexes)
  }

  public async init(): Promise<void> {
    await this.dbClient.connect('mcpUserServerInstalls')
  }

  public async getInstall(serverName: string, username: string): Promise<McpUserExternalServerInstallRecord | null> {
    return this.dbClient.findOne({ serverName, username })
  }

  public async listInstallsForUser(username: string): Promise<McpUserExternalServerInstallRecord[]> {
    return this.dbClient.find({ username })
  }

  public async listInstallsForServer(serverName: string): Promise<McpUserExternalServerInstallRecord[]> {
    return this.dbClient.find({ serverName })
  }

  public async upsertInstall(input: InstallUserServerInput): Promise<McpUserExternalServerInstallRecord> {
    const existing = await this.getInstall(input.serverName, input.username)
    const now = new Date()
    const authState = resolveInitialUserInstallAuthState(existing?.authState, input.authMode)

    const record: McpUserExternalServerInstallRecord = {
      serverName: input.serverName,
      username: input.username,
      enabled: input.enabled,
      authState,
      oauthClientId: input.oauthClientId ?? existing?.oauthClientId,
      oauthClientSecret: input.oauthClientSecret ?? existing?.oauthClientSecret,
      oauthScopes: input.oauthScopes ?? existing?.oauthScopes,
      lastAuthError: existing?.lastAuthError,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }

    await this.dbClient.upsert(record, { serverName: input.serverName, username: input.username })
    return record
  }

  public async deleteInstall(serverName: string, username: string): Promise<void> {
    await this.dbClient.delete({ serverName, username }, false)
  }

  public async deleteInstallsByServer(serverName: string): Promise<void> {
    await this.dbClient.delete({ serverName }, true)
  }

  public async setAuthState(
    serverName: string,
    username: string,
    authState: UserInstallAuthState,
    lastAuthError?: string
  ): Promise<void> {
    await this.dbClient.update(
      {
        authState,
        lastAuthError,
        updatedAt: new Date()
      },
      { serverName, username }
    )
  }

  public async stop(): Promise<void> {
    await this.dbClient.disconnect()
  }
}
