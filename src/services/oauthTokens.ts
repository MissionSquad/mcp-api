import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { SecretEncryptor } from '../utils/secretEncryptor'
import { env } from '../env'
import { McpReauthRequiredError } from './mcpErrors'
import type { McpDcrClients, SupportedTokenEndpointAuthMethod } from './dcrClients'

export interface McpOAuthTokenRecord {
  serverName: string
  username: string
  tokenType: string
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
  scopes?: string[]
  clientId: string
  clientSecret?: string
  redirectUri: string
  codeVerifier?: string
  tokenEndpointAuthMethod: SupportedTokenEndpointAuthMethod
  registrationMode: 'cimd' | 'dcr' | 'manual'
  createdAt: Date
  updatedAt: Date
}

export interface McpOAuthTokenInput {
  serverName: string
  username: string
  tokenType: string
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  scopes?: string[]
  clientId: string
  clientSecret?: string
  redirectUri: string
  codeVerifier?: string
  tokenEndpointAuthMethod: SupportedTokenEndpointAuthMethod
  registrationMode: 'cimd' | 'dcr' | 'manual'
}

export interface McpOAuthTokenDecrypted {
  serverName: string
  username: string
  tokenType: string
  accessToken: string
  refreshToken?: string
  expiresAt?: Date
  scopes?: string[]
  clientId: string
  clientSecret?: string
  redirectUri: string
  codeVerifier?: string
  tokenEndpointAuthMethod: SupportedTokenEndpointAuthMethod
  registrationMode: 'cimd' | 'dcr' | 'manual'
  createdAt: Date
  updatedAt: Date
}

const oauthTokenIndexes: IndexDefinition[] = [
  { name: 'serverName_username', key: { serverName: 1, username: 1 }, unique: true }
]

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

  public async getTokenRecord(serverName: string, username: string): Promise<McpOAuthTokenDecrypted | null> {
    const record = await this.dbClient.findOne({ serverName, username })
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
    const existing = await this.getTokenRecord(input.serverName, input.username)
    const now = new Date()
    const expiresAt =
      input.expiresIn !== undefined ? new Date(now.getTime() + input.expiresIn * 1000) : existing?.expiresAt

    const refreshTokenValue = input.refreshToken ?? existing?.refreshToken
    const record: McpOAuthTokenRecord = {
      serverName: input.serverName,
      username: input.username,
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
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? existing?.tokenEndpointAuthMethod ?? 'none',
      registrationMode: input.registrationMode ?? existing?.registrationMode ?? 'manual',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }

    await this.dbClient.upsert(record, { serverName: input.serverName, username: input.username })
  }

  public async saveTokens(serverName: string, username: string, tokens: OAuthTokens): Promise<void> {
    const existing = await this.getTokenRecord(serverName, username)
    if (!existing) {
      throw new Error(`OAuth token record not found for server ${serverName} and user ${username}`)
    }

    const expiresAt =
      tokens.expires_in !== undefined ? new Date(Date.now() + tokens.expires_in * 1000) : existing.expiresAt

    const updated: McpOAuthTokenRecord = {
      serverName,
      username,
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
      tokenEndpointAuthMethod: existing.tokenEndpointAuthMethod,
      registrationMode: existing.registrationMode,
      createdAt: existing.createdAt,
      updatedAt: new Date()
    }

    await this.dbClient.upsert(updated, { serverName, username })
  }

  public async saveCodeVerifier(serverName: string, username: string, codeVerifier: string): Promise<void> {
    const existing = await this.getTokenRecord(serverName, username)
    if (!existing) {
      throw new Error(`OAuth token record not found for server ${serverName} and user ${username}`)
    }
    await this.dbClient.update(
      {
        codeVerifier: this.encryptor.encrypt(codeVerifier),
        updatedAt: new Date()
      },
      { serverName, username }
    )
  }

  public async deleteTokenRecord(serverName: string, username: string): Promise<void> {
    await this.dbClient.delete({ serverName, username }, false)
  }

  public async deleteTokensByServer(serverName: string): Promise<void> {
    await this.dbClient.delete({ serverName })
  }

  public async listTokenRecordsForServer(serverName: string): Promise<McpOAuthTokenDecrypted[]> {
    const records = await this.dbClient.find({ serverName })
    return records.map((record) => ({
      ...record,
      accessToken: this.encryptor.decrypt(record.accessToken),
      refreshToken: record.refreshToken ? this.encryptor.decrypt(record.refreshToken) : undefined,
      clientSecret: record.clientSecret ? this.encryptor.decrypt(record.clientSecret) : undefined,
      codeVerifier: record.codeVerifier ? this.encryptor.decrypt(record.codeVerifier) : undefined
    }))
  }

  public async refreshTokenRecord(input: {
    serverName: string
    username: string
    tokenEndpoint: string
    resource?: string
  }): Promise<McpOAuthTokenDecrypted> {
    const existing = await this.getTokenRecord(input.serverName, input.username)
    if (!existing?.refreshToken) {
      throw new Error(`OAuth refresh token not found for server ${input.serverName} and user ${input.username}`)
    }

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: existing.refreshToken,
      client_id: existing.clientId
    })
    if (input.resource) {
      params.set('resource', input.resource)
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    }

    if (existing.tokenEndpointAuthMethod === 'client_secret_post') {
      if (!existing.clientSecret) {
        throw new Error(`OAuth client_secret is required for refresh method ${existing.tokenEndpointAuthMethod}`)
      }
      params.set('client_secret', existing.clientSecret)
    } else if (existing.tokenEndpointAuthMethod === 'client_secret_basic') {
      if (!existing.clientSecret) {
        throw new Error(`OAuth client_secret is required for refresh method ${existing.tokenEndpointAuthMethod}`)
      }
      headers.Authorization = `Basic ${Buffer.from(`${existing.clientId}:${existing.clientSecret}`, 'utf8').toString('base64')}`
    }

    const response = await fetch(input.tokenEndpoint, {
      method: 'POST',
      headers,
      body: params
    })

    const responseText = await response.text()
    let parsed: OAuthTokens | { error?: string; error_description?: string }
    try {
      parsed = JSON.parse(responseText) as OAuthTokens | { error?: string; error_description?: string }
    } catch {
      throw new Error(`OAuth token refresh failed with non-JSON response: ${response.status}`)
    }

    if (!response.ok) {
      const errorCode = (parsed as { error?: string }).error || `HTTP_${response.status}`
      const errorDescription = (parsed as { error_description?: string }).error_description
      throw new Error(`OAuth token refresh failed: ${errorCode}${errorDescription ? ` ${errorDescription}` : ''}`)
    }

    await this.saveTokens(input.serverName, input.username, parsed as OAuthTokens)
    const updated = await this.getTokenRecord(input.serverName, input.username)
    if (!updated) {
      throw new Error(`OAuth token record not found after refresh for server ${input.serverName}`)
    }
    return updated
  }

  public async stop(): Promise<void> {
    await this.dbClient.disconnect()
  }
}

export class McpOAuthClientProvider implements OAuthClientProvider {
  private serverName: string
  private username: string
  private tokenStore: McpOAuthTokens
  private tokensSnapshot: OAuthTokens
  private clientInfo: OAuthClientInformation
  private clientMetadataValue: OAuthClientMetadata
  private redirectUri: string
  private tokenEndpoint: string
  private resource?: string
  private issuer?: string
  private registrationEndpoint?: string
  private tokenEndpointAuthMethodsSupported?: SupportedTokenEndpointAuthMethod[]
  private dcrClients?: McpDcrClients

  constructor({
    serverName,
    username,
    tokenStore,
    record,
    tokenEndpoint,
    resource,
    issuer,
    registrationEndpoint,
    tokenEndpointAuthMethodsSupported,
    dcrClients
  }: {
    serverName: string
    username: string
    tokenStore: McpOAuthTokens
    record: McpOAuthTokenDecrypted
    tokenEndpoint: string
    resource?: string
    issuer?: string
    registrationEndpoint?: string
    tokenEndpointAuthMethodsSupported?: SupportedTokenEndpointAuthMethod[]
    dcrClients?: McpDcrClients
  }) {
    this.serverName = serverName
    this.username = username
    this.tokenStore = tokenStore
    this.redirectUri = record.redirectUri
    this.tokenEndpoint = tokenEndpoint
    this.resource = resource
    this.issuer = issuer
    this.registrationEndpoint = registrationEndpoint
    this.tokenEndpointAuthMethodsSupported = tokenEndpointAuthMethodsSupported
    this.dcrClients = dcrClients
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

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const nextTokens: OAuthTokens = {
      ...tokens,
      refresh_token: tokens.refresh_token ?? this.tokensSnapshot.refresh_token
    }
    this.tokensSnapshot = nextTokens
    await this.tokenStore.saveTokens(this.serverName, this.username, nextTokens)
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    throw new McpReauthRequiredError({
      serverName: this.serverName,
      username: this.username,
      authorizationUrl: authorizationUrl.toString(),
      message: `OAuth re-authorization required. Complete OAuth in MissionSquad and retry.`
    })
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.tokenStore.saveCodeVerifier(this.serverName, this.username, codeVerifier)
  }

  private async refreshTokensIfNeeded(): Promise<McpOAuthTokenDecrypted> {
    let record = await this.tokenStore.getTokenRecord(this.serverName, this.username)
    if (!record) {
      throw new Error(`OAuth token record not found for server ${this.serverName} and user ${this.username}`)
    }
    if (!record.expiresAt || record.expiresAt.getTime() > Date.now()) {
      return record
    }
    if (!record.refreshToken) {
      throw new McpReauthRequiredError({
        serverName: this.serverName,
        username: this.username,
        message: 'OAuth token expired and no refresh token is available. Reconnect the server.'
      })
    }

    try {
      record = await this.tokenStore.refreshTokenRecord({
        serverName: this.serverName,
        username: this.username,
        tokenEndpoint: this.tokenEndpoint,
        resource: this.resource
      })
      return record
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/invalid_grant|invalid_token/i.test(message)) {
        throw new McpReauthRequiredError({
          serverName: this.serverName,
          username: this.username,
          message: 'OAuth refresh token is no longer valid. Reconnect the server.'
        })
      }
      if (/invalid_client/i.test(message)) {
        if (record.registrationMode === 'dcr' && this.dcrClients && this.issuer && this.registrationEndpoint) {
          await this.dcrClients.invalidateRegistration({
            issuer: this.issuer,
            publicApiOrigin: new URL(record.redirectUri).origin,
            redirectUri: record.redirectUri
          })
          await this.dcrClients.getOrRegisterClient({
            issuer: this.issuer,
            registrationEndpoint: this.registrationEndpoint,
            tokenEndpointAuthMethodsSupported: this.tokenEndpointAuthMethodsSupported,
            oauthProvisioningContext: {
              publicApiOrigin: new URL(record.redirectUri).origin,
              redirectUri: record.redirectUri,
              clientMetadataUrl: '',
              clientName: 'MissionSquad'
            }
          })
        }
        throw new McpReauthRequiredError({
          serverName: this.serverName,
          username: this.username,
          message: 'OAuth client registration is no longer valid. Reconnect the server.'
        })
      }
      throw error
    }
  }

  async codeVerifier(): Promise<string> {
    const record = await this.tokenStore.getTokenRecord(this.serverName, this.username)
    if (!record?.codeVerifier) {
      throw new Error('PKCE code verifier not available for this OAuth session.')
    }
    return record.codeVerifier
  }

  async tokens(): Promise<OAuthTokens> {
    const record = await this.refreshTokensIfNeeded()
    this.clientInfo = {
      client_id: record.clientId,
      client_secret: record.clientSecret
    }
    const expiresIn = record.expiresAt
      ? Math.max(0, Math.floor((record.expiresAt.getTime() - Date.now()) / 1000))
      : undefined
    this.tokensSnapshot = {
      access_token: record.accessToken,
      token_type: record.tokenType,
      expires_in: expiresIn,
      scope: record.scopes ? record.scopes.join(' ') : undefined
    }
    return this.tokensSnapshot
  }
}
