import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { SecretEncryptor } from '../utils/secretEncryptor'
import { env } from '../env'

export interface McpOAuthTokenRecord {
  serverName: string
  tokenType: string
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
  scopes?: string[]
  clientId: string
  clientSecret?: string
  redirectUri: string
  codeVerifier?: string
  createdAt: Date
  updatedAt: Date
}

export interface McpOAuthTokenInput {
  serverName: string
  tokenType: string
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  scopes?: string[]
  clientId: string
  clientSecret?: string
  redirectUri: string
  codeVerifier?: string
}

export interface McpOAuthTokenDecrypted {
  serverName: string
  tokenType: string
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
  scopes?: string[]
  clientId: string
  clientSecret?: string
  redirectUri: string
  codeVerifier?: string
  createdAt: Date
  updatedAt: Date
}

const oauthTokenIndexes: IndexDefinition[] = [{ name: 'serverName', key: { serverName: 1 }, unique: true }]

export class McpOAuthTokens {
  private encryptor: SecretEncryptor
  private dbClient: MongoDBClient<McpOAuthTokenRecord>

  constructor({ mongoParams }: { mongoParams: MongoConnectionParams }) {
    this.encryptor = new SecretEncryptor(env.SECRETS_KEY)
    this.dbClient = new MongoDBClient<McpOAuthTokenRecord>(mongoParams, oauthTokenIndexes)
  }

  public async init(): Promise<void> {
    await this.dbClient.connect('mcpOAuthTokens')
  }

  public async getTokenRecord(serverName: string): Promise<McpOAuthTokenDecrypted | null> {
    const record = await this.dbClient.findOne({ serverName })
    if (!record) {
      return null
    }

    return {
      ...record,
      accessToken: this.encryptor.decrypt(record.accessToken),
      refreshToken: record.refreshToken ? this.encryptor.decrypt(record.refreshToken) : undefined,
      clientSecret: record.clientSecret ? this.encryptor.decrypt(record.clientSecret) : undefined,
      codeVerifier: record.codeVerifier ? this.encryptor.decrypt(record.codeVerifier) : undefined
    }
  }

  public async upsertTokenRecord(input: McpOAuthTokenInput): Promise<void> {
    const existing = await this.getTokenRecord(input.serverName)
    const now = new Date()
    const expiresAt =
      input.expiresIn !== undefined ? new Date(now.getTime() + input.expiresIn * 1000) : existing?.expiresAt

    const refreshTokenValue = input.refreshToken ?? existing?.refreshToken
    const record: McpOAuthTokenRecord = {
      serverName: input.serverName,
      tokenType: input.tokenType,
      accessToken: this.encryptor.encrypt(input.accessToken),
      refreshToken: refreshTokenValue ? this.encryptor.encrypt(refreshTokenValue) : undefined,
      expiresAt,
      scopes: input.scopes ?? existing?.scopes,
      clientId: input.clientId ?? existing?.clientId ?? '',
      clientSecret: input.clientSecret
        ? this.encryptor.encrypt(input.clientSecret)
        : existing?.clientSecret
        ? this.encryptor.encrypt(existing.clientSecret)
        : undefined,
      redirectUri: input.redirectUri ?? existing?.redirectUri ?? '',
      codeVerifier: input.codeVerifier
        ? this.encryptor.encrypt(input.codeVerifier)
        : existing?.codeVerifier
        ? this.encryptor.encrypt(existing.codeVerifier)
        : undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }

    await this.dbClient.upsert(record, { serverName: input.serverName })
  }

  public async saveTokens(serverName: string, tokens: OAuthTokens): Promise<void> {
    const existing = await this.getTokenRecord(serverName)
    if (!existing) {
      throw new Error(`OAuth token record not found for server ${serverName}`)
    }

    const expiresAt =
      tokens.expires_in !== undefined ? new Date(Date.now() + tokens.expires_in * 1000) : existing.expiresAt

    const updated: McpOAuthTokenRecord = {
      serverName,
      tokenType: tokens.token_type,
      accessToken: this.encryptor.encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token
        ? this.encryptor.encrypt(tokens.refresh_token)
        : existing.refreshToken
        ? this.encryptor.encrypt(existing.refreshToken)
        : undefined,
      expiresAt,
      scopes: tokens.scope ? tokens.scope.split(' ') : existing.scopes,
      clientId: existing.clientId,
      clientSecret: existing.clientSecret ? this.encryptor.encrypt(existing.clientSecret) : undefined,
      redirectUri: existing.redirectUri,
      codeVerifier: existing.codeVerifier ? this.encryptor.encrypt(existing.codeVerifier) : undefined,
      createdAt: existing.createdAt,
      updatedAt: new Date()
    }

    await this.dbClient.upsert(updated, { serverName })
  }

  public async saveCodeVerifier(serverName: string, codeVerifier: string): Promise<void> {
    const existing = await this.getTokenRecord(serverName)
    if (!existing) {
      throw new Error(`OAuth token record not found for server ${serverName}`)
    }
    await this.dbClient.update(
      {
        codeVerifier: this.encryptor.encrypt(codeVerifier),
        updatedAt: new Date()
      },
      { serverName }
    )
  }

  public async stop(): Promise<void> {
    await this.dbClient.disconnect()
  }
}

export class McpOAuthClientProvider implements OAuthClientProvider {
  private serverName: string
  private tokenStore: McpOAuthTokens
  private tokensSnapshot: OAuthTokens
  private clientInfo: OAuthClientInformation
  private clientMetadataValue: OAuthClientMetadata
  private redirectUri: string

  constructor({
    serverName,
    tokenStore,
    record
  }: {
    serverName: string
    tokenStore: McpOAuthTokens
    record: McpOAuthTokenDecrypted
  }) {
    this.serverName = serverName
    this.tokenStore = tokenStore
    this.redirectUri = record.redirectUri
    this.clientInfo = {
      client_id: record.clientId,
      client_secret: record.clientSecret
    }
    this.clientMetadataValue = {
      redirect_uris: [record.redirectUri],
      scope: record.scopes ? record.scopes.join(' ') : undefined
    }
    const expiresIn = record.expiresAt
      ? Math.max(0, Math.floor((record.expiresAt.getTime() - Date.now()) / 1000))
      : undefined
    this.tokensSnapshot = {
      access_token: record.accessToken,
      refresh_token: record.refreshToken,
      token_type: record.tokenType,
      expires_in: expiresIn,
      scope: record.scopes ? record.scopes.join(' ') : undefined
    }
  }

  get redirectUrl(): string {
    return this.redirectUri
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.clientMetadataValue
  }

  clientInformation(): OAuthClientInformation {
    return this.clientInfo
  }

  tokens(): OAuthTokens {
    return this.tokensSnapshot
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const nextTokens: OAuthTokens = {
      ...tokens,
      refresh_token: tokens.refresh_token ?? this.tokensSnapshot.refresh_token
    }
    this.tokensSnapshot = nextTokens
    await this.tokenStore.saveTokens(this.serverName, nextTokens)
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    throw new Error(
      `OAuth re-authorization required. Complete OAuth in MissionSquad and retry. Authorization URL: ${authorizationUrl.toString()}`
    )
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.tokenStore.saveCodeVerifier(this.serverName, codeVerifier)
  }

  async codeVerifier(): Promise<string> {
    const record = await this.tokenStore.getTokenRecord(this.serverName)
    if (!record?.codeVerifier) {
      throw new Error('PKCE code verifier not available for this OAuth session.')
    }
    return record.codeVerifier
  }
}
