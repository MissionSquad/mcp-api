import { randomUUID } from 'crypto'
import { env } from '../env'
import { log, sleep } from '../utils/general'
import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { SecretEncryptor } from '../utils/secretEncryptor'
import { McpValidationError } from './mcpErrors'

export type SupportedTokenEndpointAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic'

export interface ExternalOAuthProvisioningContext {
  publicApiOrigin: string
  redirectUri: string
  clientMetadataUrl: string
  clientName: string
}

export interface McpDcrClientRegistrationRecord {
  issuer: string
  publicApiOrigin: string
  redirectUri: string
  clientName: string
  registrationEndpoint: string
  tokenEndpointAuthMethod: SupportedTokenEndpointAuthMethod
  clientId: string
  clientSecret?: string
  clientIdIssuedAt?: number
  clientSecretExpiresAt?: number
  registrationAccessToken?: string
  registrationClientUri?: string
  grantTypes: string[]
  responseTypes: string[]
  scope?: string
  createdAt: Date
  updatedAt: Date
}

interface StoredMcpDcrClientRegistrationRecord extends Omit<McpDcrClientRegistrationRecord, 'clientSecret' | 'registrationAccessToken'> {
  clientSecret?: string
  registrationAccessToken?: string
}

interface McpDcrProvisioningLockRecord {
  issuer: string
  publicApiOrigin: string
  redirectUri: string
  lockOwner: string
  expiresAt: Date
  createdAt: Date
}

interface DynamicClientRegistrationRequest {
  client_name: string
  grant_types: string[]
  response_types: string[]
  redirect_uris: string[]
  token_endpoint_auth_method: SupportedTokenEndpointAuthMethod
}

interface DynamicClientRegistrationResponse {
  client_id?: string
  client_secret?: string
  client_id_issued_at?: number
  client_secret_expires_at?: number
  registration_access_token?: string
  registration_client_uri?: string
  token_endpoint_auth_method?: string
  [key: string]: unknown
}

const registrationIndexes: IndexDefinition[] = [
  { name: 'issuer_public_origin_redirect', key: { issuer: 1, publicApiOrigin: 1, redirectUri: 1 }, unique: true }
]

const lockIndexes: IndexDefinition[] = [
  { name: 'issuer_public_origin_redirect', key: { issuer: 1, publicApiOrigin: 1, redirectUri: 1 }, unique: true },
  { name: 'expiresAt_ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 }
]

const DCR_LOCK_DURATION_MS = 30_000
const DCR_LOCK_WAIT_TIMEOUT_MS = 30_000
const DCR_LOCK_WAIT_INTERVAL_MS = 500

const SUPPORTED_AUTH_METHODS: SupportedTokenEndpointAuthMethod[] = [
  'none',
  'client_secret_post',
  'client_secret_basic'
]

const isSupportedAuthMethod = (value: string): value is SupportedTokenEndpointAuthMethod =>
  SUPPORTED_AUTH_METHODS.includes(value as SupportedTokenEndpointAuthMethod)

export const normalizeTokenEndpointAuthMethods = (
  methods?: string[]
): SupportedTokenEndpointAuthMethod[] => {
  const input = methods && methods.length > 0 ? methods : ['client_secret_basic']
  return input.filter(isSupportedAuthMethod)
}

export const resolvePreferredTokenEndpointAuthMethod = (
  methods?: string[]
): SupportedTokenEndpointAuthMethod => {
  const normalized = normalizeTokenEndpointAuthMethods(methods)
  for (const method of SUPPORTED_AUTH_METHODS) {
    if (normalized.includes(method)) {
      return method
    }
  }
  throw new McpValidationError(
    'Dynamic client registration requires one of these token endpoint auth methods: none, client_secret_post, client_secret_basic'
  )
}

const isClientSecretExpired = (record: McpDcrClientRegistrationRecord): boolean => {
  if (record.clientSecretExpiresAt === undefined || record.clientSecretExpiresAt === 0) {
    return false
  }
  return Date.now() >= record.clientSecretExpiresAt * 1000
}

export class McpDcrClients {
  private encryptor: SecretEncryptor
  private registrationDbClient: MongoDBClient<StoredMcpDcrClientRegistrationRecord>
  private lockDbClient: MongoDBClient<McpDcrProvisioningLockRecord>

  constructor({ mongoParams }: { mongoParams: MongoConnectionParams }) {
    this.encryptor = new SecretEncryptor(env.SECRETS_KEY)
    this.registrationDbClient = new MongoDBClient<StoredMcpDcrClientRegistrationRecord>(mongoParams, registrationIndexes)
    this.lockDbClient = new MongoDBClient<McpDcrProvisioningLockRecord>(mongoParams, lockIndexes)
  }

  public async init(): Promise<void> {
    await this.registrationDbClient.connect('mcpDcrClients')
    await this.lockDbClient.connect('mcpDcrProvisioningLocks')
  }

  public async stop(): Promise<void> {
    await this.registrationDbClient.disconnect()
    await this.lockDbClient.disconnect()
  }

  public async getRegistration(input: {
    issuer: string
    publicApiOrigin: string
    redirectUri: string
  }): Promise<McpDcrClientRegistrationRecord | null> {
    const record = await this.registrationDbClient.findOne(input)
    if (!record) {
      return null
    }

    return {
      ...record,
      clientSecret: record.clientSecret ? this.encryptor.decrypt(record.clientSecret) : undefined,
      registrationAccessToken: record.registrationAccessToken
        ? this.encryptor.decrypt(record.registrationAccessToken)
        : undefined
    }
  }

  public async getOrRegisterClient(input: {
    issuer: string
    registrationEndpoint: string
    tokenEndpointAuthMethodsSupported?: string[]
    oauthProvisioningContext: ExternalOAuthProvisioningContext
  }): Promise<McpDcrClientRegistrationRecord> {
    const identity = {
      issuer: input.issuer,
      publicApiOrigin: input.oauthProvisioningContext.publicApiOrigin,
      redirectUri: input.oauthProvisioningContext.redirectUri
    }

    const existing = await this.getRegistration(identity)
    if (existing && !isClientSecretExpired(existing)) {
      return existing
    }

    const lockOwner = randomUUID()
    const acquired = await this.tryAcquireLock(identity, lockOwner)
    if (!acquired) {
      return this.waitForProvisionedClient(identity)
    }

    try {
      const afterLock = await this.getRegistration(identity)
      if (afterLock && !isClientSecretExpired(afterLock)) {
        return afterLock
      }

      return this.registerNewClient(input)
    } finally {
      await this.releaseLock(identity, lockOwner)
    }
  }

  public async invalidateRegistration(input: {
    issuer: string
    publicApiOrigin: string
    redirectUri: string
  }): Promise<void> {
    await this.registrationDbClient.delete(input, false)
  }

  private async tryAcquireLock(
    identity: { issuer: string; publicApiOrigin: string; redirectUri: string },
    lockOwner: string
  ): Promise<boolean> {
    try {
      await this.lockDbClient.insert({
        ...identity,
        lockOwner,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + DCR_LOCK_DURATION_MS)
      })
      return true
    } catch (error) {
      const code = (error as { code?: number })?.code
      if (code === 11000) {
        return false
      }
      throw error
    }
  }

  private async releaseLock(
    identity: { issuer: string; publicApiOrigin: string; redirectUri: string },
    lockOwner: string
  ): Promise<void> {
    await this.lockDbClient.delete({ ...identity, lockOwner }, false)
  }

  private async waitForProvisionedClient(identity: {
    issuer: string
    publicApiOrigin: string
    redirectUri: string
  }): Promise<McpDcrClientRegistrationRecord> {
    const deadline = Date.now() + DCR_LOCK_WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const record = await this.getRegistration(identity)
      if (record && !isClientSecretExpired(record)) {
        return record
      }
      await sleep(DCR_LOCK_WAIT_INTERVAL_MS)
    }
    throw new McpValidationError(`Timed out waiting for DCR registration for issuer ${identity.issuer}`)
  }

  private async registerNewClient(input: {
    issuer: string
    registrationEndpoint: string
    tokenEndpointAuthMethodsSupported?: string[]
    oauthProvisioningContext: ExternalOAuthProvisioningContext
  }): Promise<McpDcrClientRegistrationRecord> {
    const tokenEndpointAuthMethod = resolvePreferredTokenEndpointAuthMethod(
      input.tokenEndpointAuthMethodsSupported
    )
    const requestBody: DynamicClientRegistrationRequest = {
      client_name: input.oauthProvisioningContext.clientName,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [input.oauthProvisioningContext.redirectUri],
      token_endpoint_auth_method: tokenEndpointAuthMethod
    }

    const response = await fetch(input.registrationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(requestBody)
    })

    const responseText = await response.text()
    let parsedResponse: DynamicClientRegistrationResponse
    try {
      parsedResponse = JSON.parse(responseText) as DynamicClientRegistrationResponse
    } catch {
      throw new McpValidationError(
        `Dynamic client registration for issuer ${input.issuer} returned a non-JSON response`
      )
    }

    if (!response.ok) {
      throw new McpValidationError(
        `Dynamic client registration failed for issuer ${input.issuer}: ${response.status} ${responseText}`
      )
    }

    if (!parsedResponse.client_id) {
      throw new McpValidationError(`Dynamic client registration for issuer ${input.issuer} did not return client_id`)
    }

    const effectiveAuthMethodRaw = parsedResponse.token_endpoint_auth_method ?? tokenEndpointAuthMethod
    if (!isSupportedAuthMethod(effectiveAuthMethodRaw)) {
      throw new McpValidationError(
        `Dynamic client registration for issuer ${input.issuer} returned unsupported token_endpoint_auth_method ${String(effectiveAuthMethodRaw)}`
      )
    }

    if (
      (effectiveAuthMethodRaw === 'client_secret_post' || effectiveAuthMethodRaw === 'client_secret_basic') &&
      !parsedResponse.client_secret
    ) {
      throw new McpValidationError(
        `Dynamic client registration for issuer ${input.issuer} requires client_secret for ${effectiveAuthMethodRaw}`
      )
    }

    const now = new Date()
    const record: McpDcrClientRegistrationRecord = {
      issuer: input.issuer,
      publicApiOrigin: input.oauthProvisioningContext.publicApiOrigin,
      redirectUri: input.oauthProvisioningContext.redirectUri,
      clientName: input.oauthProvisioningContext.clientName,
      registrationEndpoint: input.registrationEndpoint,
      tokenEndpointAuthMethod: effectiveAuthMethodRaw,
      clientId: parsedResponse.client_id,
      clientSecret: parsedResponse.client_secret,
      clientIdIssuedAt: parsedResponse.client_id_issued_at,
      clientSecretExpiresAt: parsedResponse.client_secret_expires_at,
      registrationAccessToken: typeof parsedResponse.registration_access_token === 'string' ? parsedResponse.registration_access_token : undefined,
      registrationClientUri: typeof parsedResponse.registration_client_uri === 'string' ? parsedResponse.registration_client_uri : undefined,
      grantTypes: requestBody.grant_types,
      responseTypes: requestBody.response_types,
      createdAt: now,
      updatedAt: now
    }

    await this.registrationDbClient.upsert(
      {
        ...record,
        clientSecret: record.clientSecret ? this.encryptor.encrypt(record.clientSecret) : undefined,
        registrationAccessToken: record.registrationAccessToken
          ? this.encryptor.encrypt(record.registrationAccessToken)
          : undefined
      },
      {
        issuer: record.issuer,
        publicApiOrigin: record.publicApiOrigin,
        redirectUri: record.redirectUri
      }
    )

    log({ level: 'info', msg: `Provisioned DCR client ${record.clientId} for issuer ${record.issuer}` })
    return record
  }
}
