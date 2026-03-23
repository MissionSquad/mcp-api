import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { SecretEncryptor } from '../utils/secretEncryptor'
import { env } from '../env'
import { log } from '../utils/general'
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

const truncateSensitiveValue = (value: string | undefined, visibleChars = 4): string | undefined => {
  if (!value) {
    return undefined
  }
  if (value.length <= visibleChars * 2) {
    return `${value[0]}...${value[value.length - 1]}`
  }
  return `${value.slice(0, visibleChars)}...${value.slice(-visibleChars)}`
}

const summarizeUrlForLog = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined
  }
  try {
    const parsed = new URL(value)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return value
  }
}

const summarizeTokenRecordForLog = (record: McpOAuthTokenDecrypted | null | undefined) => ({
  clientId: truncateSensitiveValue(record?.clientId),
  redirectUri: summarizeUrlForLog(record?.redirectUri),
  tokenEndpointAuthMethod: record?.tokenEndpointAuthMethod,
  registrationMode: record?.registrationMode,
  expiresAt: record?.expiresAt?.toISOString(),
  scopes: record?.scopes,
  hasAccessToken: !!record?.accessToken,
  hasRefreshToken: !!record?.refreshToken,
  hasClientSecret: !!record?.clientSecret,
  hasCodeVerifier: !!record?.codeVerifier
})

export class McpOAuthTokens {
  private encryptor: SecretEncryptor
  private dbClient: MongoDBClient<McpOAuthTokenRecord>
  private refreshInFlightByKey = new Map<string, Promise<McpOAuthTokenDecrypted>>()

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
      log({
        level: 'info',
        msg: `[oauth:${username}:${serverName}] No OAuth token record found`
      })
      return null
    }

    const decryptedRecord = {
      ...record,
      accessToken: this.encryptor.decrypt(record.accessToken),
      refreshToken: record.refreshToken ? this.encryptor.decrypt(record.refreshToken) : undefined,
      clientSecret: record.clientSecret ? this.encryptor.decrypt(record.clientSecret) : undefined,
      codeVerifier: record.codeVerifier ? this.encryptor.decrypt(record.codeVerifier) : undefined
    }

    log({
      level: 'info',
      msg: `[oauth:${username}:${serverName}] Loaded OAuth token record ${JSON.stringify(summarizeTokenRecordForLog(decryptedRecord))}`
    })

    return decryptedRecord
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
    log({
      level: 'info',
      msg: `[oauth:${input.username}:${input.serverName}] Upserted OAuth token record ${JSON.stringify({
        clientId: truncateSensitiveValue(record.clientId),
        redirectUri: summarizeUrlForLog(record.redirectUri),
        tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
        registrationMode: record.registrationMode,
        expiresAt: record.expiresAt?.toISOString(),
        scopes: record.scopes,
        hasRefreshToken: !!refreshTokenValue,
        hasClientSecret: !!record.clientSecret,
        hasCodeVerifier: !!record.codeVerifier
      })}`
    })
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
    log({
      level: 'info',
      msg: `[oauth:${username}:${serverName}] Saved OAuth tokens ${JSON.stringify({
        tokenType: updated.tokenType,
        expiresAt: updated.expiresAt?.toISOString(),
        scopes: updated.scopes,
        hasRefreshToken: !!tokens.refresh_token || !!existing.refreshToken,
        refreshTokenChanged: !!tokens.refresh_token,
        clientId: truncateSensitiveValue(updated.clientId),
        tokenEndpointAuthMethod: updated.tokenEndpointAuthMethod,
        registrationMode: updated.registrationMode
      })}`
    })
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
    log({
      level: 'info',
      msg: `[oauth:${username}:${serverName}] Saved PKCE code verifier ${JSON.stringify({
        codeVerifier: truncateSensitiveValue(codeVerifier)
      })}`
    })
  }

  public async deleteTokenRecord(serverName: string, username: string): Promise<void> {
    await this.dbClient.delete({ serverName, username }, false)
    log({
      level: 'info',
      msg: `[oauth:${username}:${serverName}] Deleted OAuth token record`
    })
  }

  public async deleteTokensByServer(serverName: string): Promise<void> {
    await this.dbClient.delete({ serverName })
    log({
      level: 'info',
      msg: `[oauth:*:${serverName}] Deleted all OAuth token records for server`
    })
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

  private buildRefreshKey(serverName: string, username: string): string {
    return `${serverName}::${username}`
  }

  private async refreshTokenRecordInternal(input: {
    serverName: string
    username: string
    tokenEndpoint: string
    resource?: string
  }): Promise<McpOAuthTokenDecrypted> {
    const existing = await this.getTokenRecord(input.serverName, input.username)
    if (!existing?.refreshToken) {
      throw new Error(`OAuth refresh token not found for server ${input.serverName} and user ${input.username}`)
    }

    log({
      level: 'info',
      msg: `[oauth:${input.username}:${input.serverName}] Starting OAuth refresh ${JSON.stringify({
        tokenEndpoint: summarizeUrlForLog(input.tokenEndpoint),
        resource: summarizeUrlForLog(input.resource),
        clientId: truncateSensitiveValue(existing.clientId),
        refreshToken: truncateSensitiveValue(existing.refreshToken),
        tokenEndpointAuthMethod: existing.tokenEndpointAuthMethod,
        registrationMode: existing.registrationMode,
        expiresAt: existing.expiresAt?.toISOString(),
        scopes: existing.scopes
      })}`
    })

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

    log({
      level: 'info',
      msg: `[oauth:${input.username}:${input.serverName}] Refresh response received ${JSON.stringify({
        status: response.status,
        tokenEndpoint: summarizeUrlForLog(input.tokenEndpoint),
        resource: summarizeUrlForLog(input.resource)
      })}`
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
      log({
        level: 'info',
        msg: `[oauth:${input.username}:${input.serverName}] Refresh failed ${JSON.stringify({
          status: response.status,
          error: errorCode,
          errorDescription,
          tokenEndpoint: summarizeUrlForLog(input.tokenEndpoint),
          resource: summarizeUrlForLog(input.resource)
        })}`
      })
      throw new Error(`OAuth token refresh failed: ${errorCode}${errorDescription ? ` ${errorDescription}` : ''}`)
    }

    await this.saveTokens(input.serverName, input.username, parsed as OAuthTokens)
    const updated = await this.getTokenRecord(input.serverName, input.username)
    if (!updated) {
      throw new Error(`OAuth token record not found after refresh for server ${input.serverName}`)
    }

    log({
      level: 'info',
      msg: `[oauth:${input.username}:${input.serverName}] Refresh succeeded ${JSON.stringify({
        returnedResource: typeof (parsed as Record<string, unknown>).resource === 'string'
          ? summarizeUrlForLog((parsed as Record<string, unknown>).resource as string)
          : undefined,
        expiresAt: updated.expiresAt?.toISOString(),
        hasRefreshToken: !!updated.refreshToken,
        refreshToken: truncateSensitiveValue(updated.refreshToken),
        tokenType: updated.tokenType,
        scopes: updated.scopes
      })}`
    })
    return updated
  }

  public async refreshTokenRecord(input: {
    serverName: string
    username: string
    tokenEndpoint: string
    resource?: string
  }): Promise<McpOAuthTokenDecrypted> {
    const refreshKey = this.buildRefreshKey(input.serverName, input.username)
    const existingRefresh = this.refreshInFlightByKey.get(refreshKey)
    if (existingRefresh) {
      log({
        level: 'info',
        msg: `[oauth:${input.username}:${input.serverName}] Awaiting in-flight OAuth refresh`
      })
      return existingRefresh
    }

    const refreshPromise = this.refreshTokenRecordInternal(input).finally(() => {
      if (this.refreshInFlightByKey.get(refreshKey) === refreshPromise) {
        this.refreshInFlightByKey.delete(refreshKey)
      }
    })
    this.refreshInFlightByKey.set(refreshKey, refreshPromise)
    return refreshPromise
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
    log({
      level: 'info',
      msg: `[oauth:${this.username}:${this.serverName}] Provider saved token snapshot ${JSON.stringify({
        hasAccessToken: !!nextTokens.access_token,
        hasRefreshToken: !!nextTokens.refresh_token,
        expiresIn: nextTokens.expires_in,
        scope: nextTokens.scope
      })}`
    })
    await this.tokenStore.saveTokens(this.serverName, this.username, nextTokens)
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    log({
      level: 'info',
      msg: `[oauth:${this.username}:${this.serverName}] Redirecting to authorization ${JSON.stringify({
        authorizationUrl: summarizeUrlForLog(authorizationUrl.toString()),
        clientId: truncateSensitiveValue(authorizationUrl.searchParams.get('client_id') || undefined),
        resource: summarizeUrlForLog(authorizationUrl.searchParams.get('resource') || undefined),
        hasState: authorizationUrl.searchParams.has('state'),
        hasCodeChallenge: authorizationUrl.searchParams.has('code_challenge')
      })}`
    })
    throw new McpReauthRequiredError({
      serverName: this.serverName,
      username: this.username,
      authorizationUrl: authorizationUrl.toString(),
      message: `OAuth re-authorization required. Complete OAuth in MissionSquad and retry.`
    })
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    log({
      level: 'info',
      msg: `[oauth:${this.username}:${this.serverName}] Provider saving PKCE code verifier ${JSON.stringify({
        codeVerifier: truncateSensitiveValue(codeVerifier)
      })}`
    })
    await this.tokenStore.saveCodeVerifier(this.serverName, this.username, codeVerifier)
  }

  async validateResourceURL(serverUrl: URL): Promise<URL> {
    const resolvedResourceUrl = new URL(this.resource ?? serverUrl.toString())
    log({
      level: 'info',
      msg: `[oauth:${this.username}:${this.serverName}] Validated OAuth resource URL ${JSON.stringify({
        serverUrl: summarizeUrlForLog(serverUrl.toString()),
        configuredResource: summarizeUrlForLog(this.resource),
        resolvedResource: summarizeUrlForLog(resolvedResourceUrl.toString())
      })}`
    })
    return resolvedResourceUrl
  }

  private async refreshTokensIfNeeded(): Promise<McpOAuthTokenDecrypted> {
    let record = await this.tokenStore.getTokenRecord(this.serverName, this.username)
    if (!record) {
      throw new Error(`OAuth token record not found for server ${this.serverName} and user ${this.username}`)
    }
    if (!record.expiresAt || record.expiresAt.getTime() > Date.now()) {
      log({
        level: 'info',
        msg: `[oauth:${this.username}:${this.serverName}] Reusing current access token ${JSON.stringify({
          expiresAt: record.expiresAt?.toISOString(),
          tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
          registrationMode: record.registrationMode,
          hasRefreshToken: !!record.refreshToken
        })}`
      })
      return record
    }
    if (!record.refreshToken) {
      log({
        level: 'info',
        msg: `[oauth:${this.username}:${this.serverName}] Access token expired with no refresh token available`
      })
      throw new McpReauthRequiredError({
        serverName: this.serverName,
        username: this.username,
        message: 'OAuth token expired and no refresh token is available. Reconnect the server.'
      })
    }

    try {
      log({
        level: 'info',
        msg: `[oauth:${this.username}:${this.serverName}] Access token expired; attempting refresh ${JSON.stringify({
          expiresAt: record.expiresAt?.toISOString(),
          tokenEndpoint: summarizeUrlForLog(this.tokenEndpoint),
          resource: summarizeUrlForLog(this.resource),
          tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
          registrationMode: record.registrationMode,
          clientId: truncateSensitiveValue(record.clientId),
          refreshToken: truncateSensitiveValue(record.refreshToken)
        })}`
      })
      record = await this.tokenStore.refreshTokenRecord({
        serverName: this.serverName,
        username: this.username,
        tokenEndpoint: this.tokenEndpoint,
        resource: this.resource
      })
      return record
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log({
        level: 'info',
        msg: `[oauth:${this.username}:${this.serverName}] OAuth refresh attempt failed ${JSON.stringify({
          message,
          tokenEndpoint: summarizeUrlForLog(this.tokenEndpoint),
          resource: summarizeUrlForLog(this.resource)
        })}`
      })
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
    log({
      level: 'info',
      msg: `[oauth:${this.username}:${this.serverName}] Loaded PKCE code verifier ${JSON.stringify({
        codeVerifier: truncateSensitiveValue(record.codeVerifier)
      })}`
    })
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
      // MissionSquad owns refresh behavior in refreshTokensIfNeeded().
      // Do not expose refresh_token back to the SDK helper or it will refresh
      // again on every 401 regardless of token expiry.
      refresh_token: undefined,
      token_type: record.tokenType,
      expires_in: expiresIn,
      scope: record.scopes ? record.scopes.join(' ') : undefined
    }
    log({
      level: 'info',
      msg: `[oauth:${this.username}:${this.serverName}] Returning provider token snapshot ${JSON.stringify({
        hasAccessToken: !!this.tokensSnapshot.access_token,
        hasRefreshToken: !!this.tokensSnapshot.refresh_token,
        expiresIn: this.tokensSnapshot.expires_in,
        scope: this.tokensSnapshot.scope,
        tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
        registrationMode: record.registrationMode,
        resource: summarizeUrlForLog(this.resource)
      })}`
    })
    return this.tokensSnapshot
  }
}
