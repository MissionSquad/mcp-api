import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPReconnectionOptions,
  StreamableHTTPError
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { Resource } from '..'
import { BuiltInServer, BuiltInServerRegistry } from '../builtin-servers'
import { env } from '../env'
import { log, retryWithExponentialBackoff, sanitizeString } from '../utils/general'
import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { Secrets } from './secrets'
import { McpOAuthClientProvider, McpOAuthTokens } from './oauthTokens'
import type { McpOAuthTokenInput } from './oauthTokens'
import { McpUserSessions } from './userSessions'
import {
  ExternalOAuthProvisioningContext,
  McpDcrClients,
  SupportedTokenEndpointAuthMethod,
  normalizeTokenEndpointAuthMethods
} from './dcrClients'
import {
  InstallUserServerInput,
  McpUserExternalServerInstallRecord,
  McpUserServerInstalls,
  UpdateUserServerInstallInput,
  UserInstallAuthState
} from './userServerInstalls'
import {
  McpValidationError,
  McpReauthRequiredError,
  McpServerDisabledError,
  McpServerNotFoundError,
  McpAuthNotConnectedError,
  McpDiscoveryFailedError,
  McpServerAlreadyExistsError
} from './mcpErrors'
import { validateExternalMcpUrl } from '../utils/ssrf'

export interface MCPConnection {
  client: Client
  transport: Transport
}

export type ToolsList = {
  /**
   * The name of the tool.
   */
  name: string
  /**
   * A human-readable description of the tool.
   */
  description?: string
  /**
   * A JSON Schema object defining the expected parameters for the tool.
   */
  inputSchema: {
    type: 'object'
    properties?: Record<string, any>
  }
}[]

export type MCPTransportType = 'stdio' | 'streamable_http'
export type McpServerSource = 'platform' | 'external'
export type McpServerAuthMode = 'none' | 'oauth2'
export type McpExternalOAuthDiscoverySource = 'prm' | 'issuer_override'

export interface McpExternalSecretField {
  name: string
  label: string
  description: string
  required: boolean
  inputType: 'password'
}

export interface McpExternalOAuthTemplate {
  authorizationServerIssuer: string
  authorizationServerMetadataUrl: string
  resourceMetadataUrl?: string
  resourceUri: string
  authorizationEndpoint: string
  tokenEndpoint: string
  scopesSupported?: string[]
  challengedScopes?: string[]
  codeChallengeMethodsSupported: string[]
  pkceRequired: boolean
  discoveryMode: 'auto' | 'manual'
  discoverySource?: McpExternalOAuthDiscoverySource
  registrationMode: 'cimd' | 'dcr' | 'manual'
  manualClientCredentialsAllowed?: boolean
  clientIdMetadataDocumentSupported?: boolean
  registrationEndpoint?: string
  tokenEndpointAuthMethodsSupported?: SupportedTokenEndpointAuthMethod[]
}

export interface DiscoverExternalAuthorizationInput {
  url: string
  authorizationServerIssuerOverride?: string
}

export interface SuccessfulAuthorizationServerMetadataDocument {
  url: string
  document: Record<string, unknown>
}

export interface DiscoverAuthorizationServerMetadataResult {
  documents: SuccessfulAuthorizationServerMetadataDocument[]
  attemptedUrls: string[]
}

export interface DiscoveredAuthorizationServer {
  issuer: string
  authorizationServerMetadataUrl: string
  authorizationEndpoint: string
  tokenEndpoint: string
  scopesSupported?: string[]
  codeChallengeMethodsSupported: string[]
  clientIdMetadataDocumentSupported?: boolean
  registrationEndpoint?: string
  tokenEndpointAuthMethodsSupported?: SupportedTokenEndpointAuthMethod[]
}

export interface DiscoverExternalAuthorizationResult {
  serverUrl: string
  resourceMetadataUrl?: string
  resourceUri: string
  discoverySource: McpExternalOAuthDiscoverySource
  challengedScopes?: string[]
  authorizationServers: DiscoveredAuthorizationServer[]
  recommendedRegistrationMode: 'cimd' | 'dcr' | 'manual'
}

export type StdioServerConfig = {
  transportType: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
}

export type StreamableHttpServerConfig = {
  transportType: 'streamable_http'
  url: string
  headers?: Record<string, string>
  reconnectionOptions?: StreamableHTTPReconnectionOptions
}

type MCPServerBase = {
  id?: string
  name: string
  displayName?: string
  description?: string
  source?: McpServerSource
  authMode?: McpServerAuthMode
  oauthTemplate?: McpExternalOAuthTemplate
  secretFields?: McpExternalSecretField[]
  homepageUrl?: string
  repositoryUrl?: string
  licenseName?: string
  catalogProvider?: 'glama' | 'manual'
  catalogId?: string
  createdBy?: string
  createdAt?: Date
  updatedAt?: Date
  secretName?: string    // ← KEEP for backward compatibility
  secretNames?: string[] // ← ADD new property
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  enabled: boolean
  startupTimeout?: number
  logs?: string[]
  connection?: MCPConnection
  toolsList?: ToolsList
  // Event handlers for cleanup
  eventHandlers?: {
    stderrDataHandler?: (data: Buffer) => void
    transportErrorHandler?: (error: Error) => void
    transportCloseHandler?: () => void
  }
}

export type MCPServer = MCPServerBase & (StdioServerConfig | StreamableHttpServerConfig)

type MCPServerRecord = MCPServerBase & {
  transportType?: MCPTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  sessionId?: string
  reconnectionOptions?: StreamableHTTPReconnectionOptions
}

export type AddServerInput = {
  id?: string
  name: string
  username?: string
  displayName?: string
  description?: string
  source?: McpServerSource
  transportType?: MCPTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  reconnectionOptions?: StreamableHTTPReconnectionOptions
  authMode?: McpServerAuthMode
  oauthTemplate?: McpExternalOAuthTemplate
  secretFields?: McpExternalSecretField[]
  homepageUrl?: string
  repositoryUrl?: string
  licenseName?: string
  catalogProvider?: 'glama' | 'manual'
  catalogId?: string
  oauthClientConfig?: {
    clientId: string
    clientSecret?: string
    scopes?: string[]
  }
  oauthProvisioningContext?: ExternalOAuthProvisioningContext
  secretName?: string    // ← KEEP for backward compatibility
  secretNames?: string[] // ← ADD new property
  enabled?: boolean
  startupTimeout?: number
}

export type UpdateServerInput = {
  username?: string
  displayName?: string
  description?: string
  source?: McpServerSource
  transportType?: MCPTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  reconnectionOptions?: StreamableHTTPReconnectionOptions
  authMode?: McpServerAuthMode
  oauthTemplate?: McpExternalOAuthTemplate
  secretFields?: McpExternalSecretField[]
  homepageUrl?: string
  repositoryUrl?: string
  licenseName?: string
  catalogProvider?: 'glama' | 'manual'
  catalogId?: string
  secretName?: string    // ← KEEP for backward compatibility
  secretNames?: string[] // ← ADD new property
  enabled?: boolean
  startupTimeout?: number
}

export interface SaveUserServerSecretsInput {
  serverName: string
  username: string
  secrets: Array<{
    name: string
    value: string
  }>
}

export interface UserVisibleMcpServer {
  name: string
  displayName: string
  description: string
  source: McpServerSource
  transportType: MCPTransportType
  url?: string
  authMode?: McpServerAuthMode
  installed: boolean
  enabled: boolean
  authState?: UserInstallAuthState
  authRequired: boolean
  secretFields: McpExternalSecretField[]
  secretNames?: string[]
  configuredSecretNames?: string[]
  toolsList?: ToolsList
  homepageUrl?: string
  repositoryUrl?: string
  licenseName?: string
  canInstall: boolean
  canUninstall: boolean
  canConfigure: boolean
  canManagePlatformServer: boolean
  statusMessage?: string
  oauthTemplate?: McpExternalOAuthTemplate
  oauthClientConfig?: {
    clientId?: string
    scopes?: string[]
  }
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  logs?: string[]
}

export interface UserServerInstallDetails {
  serverName: string
  username: string
  enabled: boolean
  authState: UserInstallAuthState
  oauthClientId?: string
  oauthClientSecret?: string
  oauthScopes?: string[]
}

export interface SharedServerDeleteImpact {
  serverName: string
  source: McpServerSource
  authMode: McpServerAuthMode
  transportType: MCPTransportType
  installedUsers: number
  connectedAuthUsers: number
  oauthTokenUsers: number
  usersWithSavedSecrets: number
  activeSessionUsers: number
}

export interface ResolveExternalOAuthClientInput {
  serverName: string
  username: string
  oauthProvisioningContext: ExternalOAuthProvisioningContext
}

export interface ResolvedExternalOAuthClientContext {
  registrationMode: 'cimd' | 'dcr' | 'manual'
  clientId: string
  clientSecret?: string
  tokenEndpointAuthMethod: SupportedTokenEndpointAuthMethod
}

export const buildServerKey = (server: { name: string }): string => sanitizeString(server.name)

export type UserServerKey = `${string}:${string}`

export const buildUserServerKey = (username: string, serverName: string): UserServerKey =>
  `${username}:${sanitizeString(serverName)}`

export const assertTransportConfigCompatible = (config: {
  transportType: MCPTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  sessionId?: unknown
  reconnectionOptions?: StreamableHTTPReconnectionOptions
}): void => {
  if (config.transportType === 'streamable_http') {
    const hasStdioFields =
      config.command !== undefined || config.args !== undefined || config.env !== undefined
    if (hasStdioFields) {
      throw new Error('Streamable HTTP servers cannot define stdio fields (command, args, env).')
    }
    if (config.sessionId !== undefined) {
      throw new Error('Streamable HTTP server definitions cannot define sessionId; sessions are persisted per user.')
    }
    return
  }

  const hasHttpFields =
    config.url !== undefined ||
    config.headers !== undefined ||
    config.sessionId !== undefined ||
    config.reconnectionOptions !== undefined
  if (hasHttpFields) {
    throw new Error('Stdio servers cannot define streamable HTTP fields (url, headers, sessionId, reconnectionOptions).')
  }
}

const isStreamableHTTPTransport = (transport: Transport): transport is StreamableHTTPClientTransport =>
  typeof (transport as StreamableHTTPClientTransport).terminateSession === 'function'

const extractHttpStatusFromError = (error: unknown): number | undefined => {
  if (error instanceof StreamableHTTPError && typeof error.code === 'number') {
    return error.code
  }
  if (error instanceof Error) {
    const match = /HTTP\s+(\d{3})/.exec(error.message)
    if (match) {
      const code = Number(match[1])
      return Number.isNaN(code) ? undefined : code
    }
  }
  return undefined
}

export const shouldFallbackToSse = (error: unknown): boolean => {
  if (error instanceof StreamableHTTPError && error.code === -1) {
    return /Unexpected content type:/i.test(error.message)
  }
  const status = extractHttpStatusFromError(error)
  return status === 400 || status === 404 || status === 405
}

const stripAuthorizationHeaders = (
  headers?: Record<string, string>
): Record<string, string> | undefined => {
  if (!headers) {
    return undefined
  }
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization') {
      continue
    }
    next[key] = value
  }
  return next
}

const DISCOVERY_REQUEST_TIMEOUT_MS = 5000
const DISCOVERY_MAX_ATTEMPTS = 3
const DISCOVERY_BASE_DELAY_MS = 500
const DISCOVERY_TOTAL_BUDGET_MS = 20000
const REQUIRED_PKCE_CHALLENGE_METHOD = 'S256'
const RESOURCE_URI_BACKFILL_FAILURE_COOLDOWN_MS = 15 * 60 * 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const toOptionalStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }
  const normalized = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return normalized.length > 0 ? normalized : undefined
}

const getOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

export const canonicalizeExternalOAuthResourceUri = (input: string): string => {
  const parsed = new URL(input)
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

type ExternalOAuthResourceCompatibilityRule = {
  id: string
  matchesTransportUrl: (transportUrl: URL) => boolean
  resourceUri: (transportUrl: URL) => string
}

const EXTERNAL_OAUTH_RESOURCE_COMPATIBILITY_RULES: ExternalOAuthResourceCompatibilityRule[] = [
  {
    id: 'webflow_transport_resource_split',
    matchesTransportUrl: (transportUrl) =>
      transportUrl.origin === 'https://mcp.webflow.com' &&
      transportUrl.pathname.replace(/\/+$/, '') === '/mcp',
    resourceUri: () => 'https://mcp.webflow.com/sse'
  }
]

export const resolveCompatibilityFallbackExternalOAuthResourceUri = (transportUrl: string): string => {
  const canonicalTransportResourceUri = canonicalizeExternalOAuthResourceUri(transportUrl)
  const parsedTransportUrl = new URL(canonicalTransportResourceUri)
  const rule = EXTERNAL_OAUTH_RESOURCE_COMPATIBILITY_RULES.find((candidate) =>
    candidate.matchesTransportUrl(parsedTransportUrl)
  )
  return rule ? rule.resourceUri(parsedTransportUrl) : canonicalTransportResourceUri
}

const oauthLogInfo = (msg: string): void => {
  if (!env.ENABLE_OAUTH_LOGGING) {
    return
  }
  log({ level: 'info', msg })
}

const INVALID_ISSUER_OVERRIDE_PATH_SUFFIXES = [
  '/authorize',
  '/authorization',
  '/oauth/token',
  '/token',
  '/openid-configuration',
  '/oauth-authorization-server'
] as const

export const normalizeAuthorizationServerIssuerOverride = (input: string): string => {
  const trimmed = input.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new McpValidationError('authorizationServerIssuerOverride must be a valid absolute HTTPS URL')
  }

  if (parsed.protocol !== 'https:') {
    throw new McpValidationError('authorizationServerIssuerOverride must use https')
  }
  if (parsed.username || parsed.password) {
    throw new McpValidationError('authorizationServerIssuerOverride must not include embedded credentials')
  }
  if (parsed.search) {
    throw new McpValidationError('authorizationServerIssuerOverride must not include a query string')
  }
  if (parsed.hash) {
    throw new McpValidationError('authorizationServerIssuerOverride must not include a fragment')
  }

  const normalizedPathname = parsed.pathname.replace(/\/+$/, '').toLowerCase() || '/'
  if (INVALID_ISSUER_OVERRIDE_PATH_SUFFIXES.some((suffix) => normalizedPathname.endsWith(suffix))) {
    throw new McpValidationError(
      'authorizationServerIssuerOverride must be an issuer URL, not an authorization, token, or well-known metadata endpoint'
    )
  }

  return trimmed
}

export const buildExternalUrlWithSecretQueryParams = (
  baseUrl: string,
  secretValues: Record<string, string>
): string => {
  const resolvedUrl = new URL(baseUrl)
  for (const [name, value] of Object.entries(secretValues)) {
    if (!value.trim()) {
      continue
    }
    resolvedUrl.searchParams.set(name, value)
  }
  return resolvedUrl.toString()
}

const getKnownProviderUrlError = (value: string): string | null => {
  try {
    const parsed = new URL(value)
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    if (parsed.origin === 'https://mcp.zapier.com' && pathname !== '/api/v1/connect') {
      return 'Zapier requires the Integration URL ending in /api/v1/connect. Do not use https://mcp.zapier.com/mcp.'
    }
    return null
  } catch {
    return null
  }
}

const buildSecretFieldLabel = (name: string): string => name

const buildExtractedExternalUrlSecretMetadata = (
  inputUrl: string,
  existingFields: McpExternalSecretField[] | undefined
): {
  sanitizedUrl: string
  secretFields: McpExternalSecretField[]
  secrets: Array<{ name: string; value: string }>
} => {
  const parsed = new URL(inputUrl)
  const secretFields = [...(existingFields ?? [])]
  const secretsByName = new Map<string, string>()

  for (const [name, value] of parsed.searchParams.entries()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,49}$/.test(name)) {
      throw new McpValidationError(`Invalid query parameter name for secret extraction: ${name}`)
    }
    secretsByName.set(name, value)
    if (!secretFields.some((field) => field.name === name)) {
      secretFields.push({
        name,
        label: buildSecretFieldLabel(name),
        description: `Extracted from URL query parameter "${name}"`,
        required: true,
        inputType: 'password'
      })
    }
  }

  parsed.search = ''
  parsed.hash = ''

  return {
    sanitizedUrl: parsed.toString(),
    secretFields,
    secrets: Array.from(secretsByName.entries()).map(([name, value]) => ({ name, value }))
  }
}

const hasUsablePrimaryAuthorizationMetadata = (document: Record<string, unknown>): boolean => {
  const authorizationEndpoint = getOptionalString(document.authorization_endpoint)
  const tokenEndpoint = getOptionalString(document.token_endpoint)
  const codeChallengeMethodsSupported = toOptionalStringArray(document.code_challenge_methods_supported) ?? []
  return (
    typeof authorizationEndpoint === 'string' &&
    typeof tokenEndpoint === 'string' &&
    codeChallengeMethodsSupported.includes(REQUIRED_PKCE_CHALLENGE_METHOD)
  )
}

export const selectPrimaryAuthorizationServerMetadataDocument = (
  documents: SuccessfulAuthorizationServerMetadataDocument[]
): SuccessfulAuthorizationServerMetadataDocument | undefined =>
  documents.find((candidate) => hasUsablePrimaryAuthorizationMetadata(candidate.document))

export const buildMergedAuthorizationServerResult = ({
  issuer,
  scopesSupported,
  primaryDocuments,
  compatibilityDocuments
}: {
  issuer: string
  scopesSupported?: string[]
  primaryDocuments: SuccessfulAuthorizationServerMetadataDocument[]
  compatibilityDocuments: SuccessfulAuthorizationServerMetadataDocument[]
}): DiscoveredAuthorizationServer => {
  const primaryIndex = primaryDocuments.findIndex((candidate) => hasUsablePrimaryAuthorizationMetadata(candidate.document))
  if (primaryIndex === -1) {
    throw new Error(`Issuer ${issuer} does not include a usable primary authorization metadata document`)
  }

  const primaryDocument = primaryDocuments[primaryIndex]
  const issuerCompatibilityDocuments = primaryDocuments.slice(primaryIndex + 1)
  const orderedCompatibilityDocuments = [...issuerCompatibilityDocuments, ...compatibilityDocuments]

  const authorizationEndpoint = primaryDocument.document.authorization_endpoint as string
  const tokenEndpoint = primaryDocument.document.token_endpoint as string
  const codeChallengeMethodsSupported = toOptionalStringArray(
    primaryDocument.document.code_challenge_methods_supported
  ) as string[]

  const primaryRegistrationEndpoint = getOptionalString(primaryDocument.document.registration_endpoint)
  const compatibilityRegistrationEndpoint = orderedCompatibilityDocuments
    .map((candidate) => getOptionalString(candidate.document.registration_endpoint))
    .find((candidate): candidate is string => typeof candidate === 'string')
  const primaryTokenEndpointAuthMethodsSupported = normalizeTokenEndpointAuthMethods(
    toOptionalStringArray(primaryDocument.document.token_endpoint_auth_methods_supported)
  )
  const compatibilityTokenEndpointAuthMethodsSupported = orderedCompatibilityDocuments
    .map((candidate) =>
      normalizeTokenEndpointAuthMethods(toOptionalStringArray(candidate.document.token_endpoint_auth_methods_supported))
    )
    .find((candidate) => candidate.length > 0)
  const mergedTokenEndpointAuthMethodsSupported =
    primaryTokenEndpointAuthMethodsSupported.length > 0
      ? primaryTokenEndpointAuthMethodsSupported
      : compatibilityTokenEndpointAuthMethodsSupported
  const clientIdMetadataDocumentSupported =
    primaryDocument.document.client_id_metadata_document_supported === true ||
    orderedCompatibilityDocuments.some((candidate) => candidate.document.client_id_metadata_document_supported === true)

  return {
    issuer,
    authorizationServerMetadataUrl: primaryDocument.url,
    authorizationEndpoint,
    tokenEndpoint,
    scopesSupported,
    codeChallengeMethodsSupported,
    ...(clientIdMetadataDocumentSupported ? { clientIdMetadataDocumentSupported: true } : {}),
    ...(primaryRegistrationEndpoint ?? compatibilityRegistrationEndpoint
      ? { registrationEndpoint: primaryRegistrationEndpoint ?? compatibilityRegistrationEndpoint }
      : {}),
    ...(mergedTokenEndpointAuthMethodsSupported && mergedTokenEndpointAuthMethodsSupported.length > 0
      ? { tokenEndpointAuthMethodsSupported: mergedTokenEndpointAuthMethodsSupported }
      : {})
  }
}

export const parseWwwAuthenticateHeader = (
  headerValue: string | null
): { resourceMetadataUrl?: string; challengedScopes?: string[] } => {
  if (!headerValue) {
    return {}
  }

  const resourceMetadataMatch = /resource_metadata="([^"]+)"/i.exec(headerValue)
  const scopeMatch = /scope="([^"]+)"/i.exec(headerValue)

  return {
    ...(resourceMetadataMatch?.[1] ? { resourceMetadataUrl: resourceMetadataMatch[1] } : {}),
    ...(scopeMatch?.[1]
      ? {
          challengedScopes: scopeMatch[1]
            .split(/\s+/)
            .map((scope) => scope.trim())
            .filter(Boolean)
        }
      : {})
  }
}

export const buildProtectedResourceMetadataCandidates = (serverUrl: URL): string[] => {
  const candidates: string[] = []
  if (serverUrl.pathname !== '/') {
    candidates.push(new URL(`/.well-known/oauth-protected-resource${serverUrl.pathname}`, serverUrl.origin).toString())
  }
  candidates.push(new URL('/.well-known/oauth-protected-resource', serverUrl.origin).toString())
  return Array.from(new Set(candidates))
}

export const buildAuthorizationServerMetadataCandidates = (issuerUrl: URL): string[] => {
  const hasPath = issuerUrl.pathname !== '/'
  if (!hasPath) {
    return [
      new URL('/.well-known/oauth-authorization-server', issuerUrl.origin).toString(),
      new URL('/.well-known/openid-configuration', issuerUrl.origin).toString()
    ]
  }

  return [
    new URL(`/.well-known/oauth-authorization-server${issuerUrl.pathname}`, issuerUrl.origin).toString(),
    new URL(`/.well-known/openid-configuration${issuerUrl.pathname}`, issuerUrl.origin).toString(),
    new URL(`${issuerUrl.pathname.replace(/\/+$/, '')}/.well-known/openid-configuration`, issuerUrl.origin).toString()
  ]
}

const resolveRecommendedRegistrationMode = (
  authorizationServers: DiscoveredAuthorizationServer[]
): 'cimd' | 'dcr' | 'manual' =>
  authorizationServers.some((server) => server.clientIdMetadataDocumentSupported === true)
    ? 'cimd'
    : authorizationServers.some((server) => typeof server.registrationEndpoint === 'string')
      ? 'dcr'
      : 'manual'

const buildRequestInit = (headers?: Record<string, string>): RequestInit | undefined => {
  if (!headers) {
    return undefined
  }
  return { headers }
}

export type TransportFactoryOptions = {
  requestInit?: RequestInit
  authProvider?: OAuthClientProvider
  sessionId?: string
  url?: string
}

export const createTransport = (server: MCPServer, options: TransportFactoryOptions = {}): Transport => {
  if (server.transportType === 'streamable_http') {
    const requestInit = options.requestInit ?? buildRequestInit(server.headers)
    return new StreamableHTTPClientTransport(new URL(options.url ?? server.url), {
      requestInit,
      sessionId: options.sessionId,
      reconnectionOptions: server.reconnectionOptions,
      authProvider: options.authProvider
    })
  }

  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...server.env, ...globalEnv },
    stderr: 'pipe'
  })
}

const createSseTransport = (
  server: StreamableHttpServerConfig,
  options: TransportFactoryOptions = {}
): Transport => {
  const requestInit = options.requestInit ?? buildRequestInit(server.headers)
  return new SSEClientTransport(new URL(options.url ?? server.url), {
    requestInit,
    authProvider: options.authProvider
  })
}

const mcpIndexes: IndexDefinition[] = [{ name: 'name', key: { name: 1 } }]

const globalEnv = {
  ...process.env,
  ...(process.env.PATH ? { PATH: process.env.PATH } : {})
}

export interface UserConnection {
  username: string
  serverName: string
  client: Client
  transport: Transport
  sessionId?: string
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  logs?: string[]
  eventHandlers?: {
    transportErrorHandler?: (error: Error) => void
    transportCloseHandler?: () => void
  }
}

export type UserConnectionTeardownReason =
  | 'shutdown'
  | 'oauth_updated'
  | 'session_expired'
  | 'server_updated'
  | 'server_disabled'
  | 'server_deleted'

export type UserConnectionTeardownPolicy = {
  terminateSession: boolean
  clearPersistedSession: boolean
}

export const resolveUserConnectionTeardownPolicy = (
  reason: UserConnectionTeardownReason
): UserConnectionTeardownPolicy => {
  switch (reason) {
    case 'server_updated':
    case 'server_disabled':
    case 'server_deleted':
      return { terminateSession: true, clearPersistedSession: true }
    case 'oauth_updated':
      return { terminateSession: false, clearPersistedSession: true }
    case 'session_expired':
    case 'shutdown':
      return { terminateSession: false, clearPersistedSession: false }
  }
}

const normalizeExternalAuthError = (
  error: unknown,
  username: string,
  serverName: string
): unknown => {
  if (error instanceof McpReauthRequiredError) {
    return error
  }
  if (error instanceof UnauthorizedError) {
    return new McpReauthRequiredError({
      serverName,
      username,
      message: error.message
    })
  }
  return error
}

export class MCPService implements Resource {
  public servers: Record<string, MCPServer> = {}
  public userConnections: Record<UserServerKey, UserConnection> = {}
  private userConnectionInFlight = new Map<UserServerKey, Promise<UserConnection>>()
  private list: MCPServer[] = []
  private serverKeys: string[] = []
  private resourceUriBackfillInFlight = new Map<string, Promise<void>>()
  private resourceUriBackfillCooldownUntil = new Map<string, number>()
  private mcpDBClient: MongoDBClient<MCPServerRecord>
  public secretsService: Secrets
  private oauthTokensService?: McpOAuthTokens
  private userSessionsService?: McpUserSessions
  private dcrClients?: McpDcrClients
  public userServerInstalls: McpUserServerInstalls
  private mongoParams: MongoConnectionParams
  private packageService?: any // Will be set after initialization to avoid circular dependency

  constructor({
    mongoParams,
    secretsService,
    oauthTokensService,
    userSessionsService,
    userServerInstalls,
    dcrClients
  }: {
    mongoParams: MongoConnectionParams
    secretsService: Secrets
    oauthTokensService?: McpOAuthTokens
    userSessionsService?: McpUserSessions
    userServerInstalls: McpUserServerInstalls
    dcrClients?: McpDcrClients
  }) {
    this.mongoParams = mongoParams
    this.mcpDBClient = new MongoDBClient<MCPServerRecord>(mongoParams, mcpIndexes)
    this.secretsService = secretsService
    this.oauthTokensService = oauthTokensService
    this.userSessionsService = userSessionsService
    this.userServerInstalls = userServerInstalls
    this.dcrClients = dcrClients
  }

  private async fetchDiscoveryResponse(url: string, discoveryDeadlineMs: number): Promise<Response> {
    const result = await retryWithExponentialBackoff(
      async () => {
        const remainingBudgetMs = discoveryDeadlineMs - Date.now()
        if (remainingBudgetMs <= 0) {
          throw new Error('Discovery budget exceeded')
        }

        return fetch(url, {
          method: 'GET',
          redirect: 'follow',
          headers: {
            Accept: 'application/json, text/plain, */*'
          },
          signal: AbortSignal.timeout(Math.min(DISCOVERY_REQUEST_TIMEOUT_MS, remainingBudgetMs))
        })
      },
      () => undefined,
      DISCOVERY_MAX_ATTEMPTS,
      DISCOVERY_BASE_DELAY_MS
    )

    if (isRecord(result) && 'error' in result && result.error instanceof Error) {
      throw result.error
    }

    return result as Response
  }

  private async fetchDiscoveryJsonDocument(
    url: string,
    discoveryDeadlineMs: number
  ): Promise<{ response: Response; document: Record<string, unknown> | null }> {
    await validateExternalMcpUrl(url)
    const response = await this.fetchDiscoveryResponse(url, discoveryDeadlineMs)
    const bodyText = await response.text()
    if (!bodyText) {
      return { response, document: null }
    }

    try {
      const parsed = JSON.parse(bodyText)
      return {
        response,
        document: isRecord(parsed) ? parsed : null
      }
    } catch {
      return { response, document: null }
    }
  }

  private async fetchProtectedResourceMetadataDocument(
    resourceMetadataUrl: string,
    discoveryDeadlineMs: number
  ): Promise<Record<string, unknown>> {
    const { response, document } = await this.fetchDiscoveryJsonDocument(resourceMetadataUrl, discoveryDeadlineMs)
    if (response.status === 404 || response.status === 405) {
      throw new Error(`Protected resource metadata not found at ${resourceMetadataUrl} (${response.status})`)
    }
    if (response.status >= 400) {
      throw new Error(`Protected resource metadata request failed at ${resourceMetadataUrl} (${response.status})`)
    }
    if (!document) {
      throw new Error(`Protected resource metadata at ${resourceMetadataUrl} was not valid JSON`)
    }

    const authorizationServers = toOptionalStringArray(document.authorization_servers)
    if (!authorizationServers || authorizationServers.length === 0) {
      throw new Error(`Protected resource metadata at ${resourceMetadataUrl} did not include authorization_servers`)
    }

    return document
  }

  private async probeExternalMcpChallenge(
    serverUrl: URL,
    discoveryDeadlineMs: number
  ): Promise<{ challengedScopes?: string[]; resourceMetadataUrlFromChallenge?: string }> {
    try {
      const probeResponse = await this.fetchDiscoveryResponse(serverUrl.toString(), discoveryDeadlineMs)
      if (probeResponse.status !== 401) {
        return {}
      }

      const parsedHeader = parseWwwAuthenticateHeader(probeResponse.headers.get('www-authenticate'))
      return {
        ...(parsedHeader.challengedScopes ? { challengedScopes: parsedHeader.challengedScopes } : {}),
        ...(parsedHeader.resourceMetadataUrl
          ? { resourceMetadataUrlFromChallenge: parsedHeader.resourceMetadataUrl }
          : {})
      }
    } catch (error) {
      log({
        level: 'warn',
        msg: `Unauthenticated external MCP discovery probe failed for ${serverUrl.toString()}; continuing with fallback behavior`,
        error
      })
      return {}
    }
  }

  private resolveProtectedResourceUri(metadata: Record<string, unknown>, transportUrl: string): string {
    return typeof metadata.resource === 'string'
      ? metadata.resource
      : resolveCompatibilityFallbackExternalOAuthResourceUri(transportUrl)
  }

  private async discoverProtectedResourceMetadata(
    serverUrl: URL,
    discoveryDeadlineMs: number
  ): Promise<{
    resourceMetadataUrl: string
    resourceUri: string
    challengedScopes?: string[]
    metadata: Record<string, unknown>
    attemptedUrls: string[]
  }> {
    const attemptedUrls: string[] = []
    const { challengedScopes, resourceMetadataUrlFromChallenge } = await this.probeExternalMcpChallenge(
      serverUrl,
      discoveryDeadlineMs
    )

    const candidateUrls = [
      ...(resourceMetadataUrlFromChallenge ? [resourceMetadataUrlFromChallenge] : []),
      ...buildProtectedResourceMetadataCandidates(serverUrl)
    ]

    let lastCause = 'No protected resource metadata candidate succeeded'
    for (const candidateUrl of Array.from(new Set(candidateUrls))) {
      attemptedUrls.push(candidateUrl)
      try {
        const document = await this.fetchProtectedResourceMetadataDocument(candidateUrl, discoveryDeadlineMs)

        return {
          resourceMetadataUrl: candidateUrl,
          resourceUri: this.resolveProtectedResourceUri(document, serverUrl.toString()),
          challengedScopes,
          metadata: document,
          attemptedUrls
        }
      } catch (error) {
        lastCause = error instanceof Error ? error.message : String(error)
      }
    }

    throw new McpDiscoveryFailedError(
      'Unable to discover Protected Resource Metadata for the external MCP server',
      attemptedUrls,
      lastCause
    )
  }

  private async discoverAuthorizationServerMetadata(
    issuer: string,
    discoveryDeadlineMs: number
  ): Promise<DiscoverAuthorizationServerMetadataResult> {
    const issuerUrl = await validateExternalMcpUrl(issuer)
    const candidateUrls = buildAuthorizationServerMetadataCandidates(issuerUrl)
    const attemptedUrls: string[] = []
    const documents: SuccessfulAuthorizationServerMetadataDocument[] = []
    let lastCause = 'No authorization server metadata candidate succeeded'

    for (const candidateUrl of candidateUrls) {
      attemptedUrls.push(candidateUrl)
      try {
        const { response, document } = await this.fetchDiscoveryJsonDocument(candidateUrl, discoveryDeadlineMs)
        if (response.status === 404 || response.status === 405) {
          lastCause = `Authorization server metadata not found at ${candidateUrl} (${response.status})`
          continue
        }
        if (response.status >= 400) {
          lastCause = `Authorization server metadata request failed at ${candidateUrl} (${response.status})`
          continue
        }
        if (!document) {
          lastCause = `Authorization server metadata at ${candidateUrl} was not valid JSON`
          continue
        }

        documents.push({
          url: candidateUrl,
          document
        })
      } catch (error) {
        lastCause = error instanceof Error ? error.message : String(error)
      }
    }

    if (documents.length > 0) {
      return {
        documents,
        attemptedUrls
      }
    }

    throw new McpDiscoveryFailedError(
      `Unable to discover authorization server metadata for issuer ${issuer}`,
      attemptedUrls,
      lastCause
    )
  }

  private async discoverCompatibilityAuthorizationMetadata(
    resourceUri: string,
    issuer: string,
    discoveryDeadlineMs: number
  ): Promise<SuccessfulAuthorizationServerMetadataDocument[]> {
    if (new URL(resourceUri).origin === new URL(issuer).origin) {
      return []
    }

    const resourceOriginUrl = await validateExternalMcpUrl(new URL(resourceUri).origin)
    const candidateUrls = buildAuthorizationServerMetadataCandidates(resourceOriginUrl)
    const documents: SuccessfulAuthorizationServerMetadataDocument[] = []

    for (const candidateUrl of candidateUrls) {
      try {
        const { response, document } = await this.fetchDiscoveryJsonDocument(candidateUrl, discoveryDeadlineMs)
        if (response.status >= 400 || !document) {
          continue
        }

        const hasCompatibleField =
          typeof document.registration_endpoint === 'string' ||
          normalizeTokenEndpointAuthMethods(toOptionalStringArray(document.token_endpoint_auth_methods_supported)).length > 0 ||
          document.client_id_metadata_document_supported === true

        if (!hasCompatibleField) {
          continue
        }

        documents.push({
          url: candidateUrl,
          document
        })
      } catch {
        continue
      }
    }

    return documents
  }

  private buildMergedAuthorizationServer(
    issuer: string,
    scopesSupported: string[] | undefined,
    primaryDocuments: SuccessfulAuthorizationServerMetadataDocument[],
    compatibilityDocuments: SuccessfulAuthorizationServerMetadataDocument[]
  ): DiscoveredAuthorizationServer {
    return buildMergedAuthorizationServerResult({
      issuer,
      scopesSupported,
      primaryDocuments,
      compatibilityDocuments
    })
  }

  private async discoverExternalAuthorizationFromIssuerOverride(input: {
    serverUrl: URL
    authorizationServerIssuerOverride: string
    discoveryDeadlineMs: number
  }): Promise<DiscoverExternalAuthorizationResult> {
    const { challengedScopes } = await this.probeExternalMcpChallenge(input.serverUrl, input.discoveryDeadlineMs)
    const resourceUri = canonicalizeExternalOAuthResourceUri(input.serverUrl.toString())
    const attemptedIssuerMetadataUrls: string[] = []

    const { documents, attemptedUrls } = await this.discoverAuthorizationServerMetadata(
      input.authorizationServerIssuerOverride,
      input.discoveryDeadlineMs
    )
    attemptedIssuerMetadataUrls.push(...attemptedUrls)

    const primaryDocument = selectPrimaryAuthorizationServerMetadataDocument(documents)
    if (!primaryDocument) {
      throw new McpDiscoveryFailedError(
        'Unable to discover a usable authorization server for the external MCP server',
        [input.serverUrl.toString(), ...attemptedIssuerMetadataUrls],
        `Issuer ${input.authorizationServerIssuerOverride} does not advertise PKCE ${REQUIRED_PKCE_CHALLENGE_METHOD}`
      )
    }

    const compatibilityDocuments = await this.discoverCompatibilityAuthorizationMetadata(
      resourceUri,
      input.authorizationServerIssuerOverride,
      input.discoveryDeadlineMs
    )

    const authorizationServers = [
      this.buildMergedAuthorizationServer(
        input.authorizationServerIssuerOverride,
        undefined,
        documents,
        compatibilityDocuments
      )
    ]

    return {
      serverUrl: input.serverUrl.toString(),
      resourceUri,
      discoverySource: 'issuer_override',
      ...(challengedScopes && challengedScopes.length > 0 ? { challengedScopes } : {}),
      authorizationServers,
      recommendedRegistrationMode: resolveRecommendedRegistrationMode(authorizationServers)
    }
  }

  public async discoverExternalAuthorization(
    input: DiscoverExternalAuthorizationInput
  ): Promise<DiscoverExternalAuthorizationResult> {
    const knownProviderUrlError = getKnownProviderUrlError(input.url)
    if (knownProviderUrlError) {
      throw new McpValidationError(knownProviderUrlError)
    }
    const sanitizedInputUrl = buildExtractedExternalUrlSecretMetadata(input.url, undefined).sanitizedUrl
    const serverUrl = await validateExternalMcpUrl(sanitizedInputUrl)
    const discoveryDeadlineMs = Date.now() + DISCOVERY_TOTAL_BUDGET_MS

    if (input.authorizationServerIssuerOverride) {
      const normalizedIssuerOverride = normalizeAuthorizationServerIssuerOverride(input.authorizationServerIssuerOverride)
      await validateExternalMcpUrl(normalizedIssuerOverride)
      return this.discoverExternalAuthorizationFromIssuerOverride({
        serverUrl,
        authorizationServerIssuerOverride: normalizedIssuerOverride,
        discoveryDeadlineMs
      })
    }

    const { resourceMetadataUrl, resourceUri, challengedScopes, metadata } = await this.discoverProtectedResourceMetadata(
      serverUrl,
      discoveryDeadlineMs
    )

    const authorizationServers = toOptionalStringArray(metadata.authorization_servers)
    if (!authorizationServers || authorizationServers.length === 0) {
      throw new McpDiscoveryFailedError(
        'Protected Resource Metadata did not include any authorization server issuers',
        [resourceMetadataUrl],
        'authorization_servers was empty'
      )
    }

    const scopesSupported = toOptionalStringArray(metadata.scopes_supported)
    const discoveredAuthorizationServers: DiscoveredAuthorizationServer[] = []
    const attemptedIssuerMetadataUrls: string[] = []
    const invalidIssuerMessages: string[] = []

    for (const issuer of authorizationServers) {
      try {
        const { documents, attemptedUrls } =
          await this.discoverAuthorizationServerMetadata(issuer, discoveryDeadlineMs)
        attemptedIssuerMetadataUrls.push(...attemptedUrls)

        const primaryDocument = selectPrimaryAuthorizationServerMetadataDocument(documents)
        if (!primaryDocument) {
          invalidIssuerMessages.push(`Issuer ${issuer} does not advertise PKCE ${REQUIRED_PKCE_CHALLENGE_METHOD}`)
          continue
        }

        const compatibilityDocuments = await this.discoverCompatibilityAuthorizationMetadata(
          resourceUri,
          issuer,
          discoveryDeadlineMs
        )

        discoveredAuthorizationServers.push(
          this.buildMergedAuthorizationServer(issuer, scopesSupported, documents, compatibilityDocuments)
        )
      } catch (error) {
        if (error instanceof McpDiscoveryFailedError) {
          attemptedIssuerMetadataUrls.push(...error.details?.attemptedUrls ?? [])
          invalidIssuerMessages.push(error.message)
          continue
        }
        throw error
      }
    }

    if (discoveredAuthorizationServers.length === 0) {
      throw new McpDiscoveryFailedError(
        'Unable to discover a usable authorization server for the external MCP server',
        [resourceMetadataUrl, ...attemptedIssuerMetadataUrls],
        invalidIssuerMessages.join('; ')
      )
    }

    return {
      serverUrl: serverUrl.toString(),
      resourceMetadataUrl,
      resourceUri,
      discoverySource: 'prm',
      ...(challengedScopes && challengedScopes.length > 0 ? { challengedScopes } : {}),
      authorizationServers: discoveredAuthorizationServers,
      recommendedRegistrationMode: resolveRecommendedRegistrationMode(discoveredAuthorizationServers)
    }
  }

  /**
   * Set the package service reference
   * This is called after initialization to avoid circular dependency
   */
  public setPackageService(packageService: any): void {
    this.packageService = packageService
  }

  /**
   * Migrates old secretName format to new secretNames format
   * Also persists the migrated version back to database
   * This enables seamless backward compatibility during transition
   */
  private async migrateServerSecrets(server: MCPServerRecord): Promise<MCPServerRecord> {
    // If already using new format, return as-is
    if (server.secretNames && server.secretNames.length > 0) {
      return server
    }
    
    // If has old format, migrate
    if (server.secretName && !server.secretNames) {
      const migratedServer: MCPServerRecord = {
        ...server,
        secretNames: [server.secretName],
        secretName: undefined  // Remove old property from in-memory object
      }
      
      // Persist migration to DB asynchronously (don't block)
      this.mcpDBClient.update(migratedServer, { name: server.name }).catch(err => {
        log({ 
          level: 'warn', 
          msg: `Failed to auto-migrate server ${server.name}: ${err.message}` 
        })
      })
      
      log({ 
        level: 'info', 
        msg: `Auto-migrated server ${server.name} from secretName to secretNames` 
      })
      
      return migratedServer
    }
    
    // No secrets configured
    return server
  }

  /**
   * Migrates legacy servers to include transportType and normalized config fields.
   */
  private async migrateServerTransport(server: MCPServerRecord): Promise<MCPServer> {
    const transportType: MCPTransportType = server.transportType ?? 'stdio'
    let needsUpdate = server.transportType === undefined

    if (transportType === 'streamable_http') {
      if (!server.url) {
        throw new Error(`Streamable HTTP server ${server.name} is missing url`)
      }

      const { command, args, env, ...rest } = server
      if (command !== undefined || args !== undefined || env !== undefined) {
        needsUpdate = true
      }

      const normalized: MCPServer = {
        ...rest,
        transportType: 'streamable_http',
        url: server.url,
        headers: server.headers,
        reconnectionOptions: server.reconnectionOptions
      }

      if (needsUpdate) {
        this.mcpDBClient.update(normalized, { name: server.name }).catch(err => {
          log({
            level: 'warn',
            msg: `Failed to auto-migrate transport for server ${server.name}: ${err.message}`
          })
        })
      }

      return normalized
    }

    if (!server.command) {
      throw new Error(`Stdio server ${server.name} is missing command`)
    }

    const args = server.args ?? []
    const env = server.env ?? {}

    if (server.args === undefined || server.env === undefined) {
      needsUpdate = true
    }
    if (
      server.url !== undefined ||
      server.headers !== undefined ||
      server.sessionId !== undefined ||
      server.reconnectionOptions !== undefined
    ) {
      needsUpdate = true
    }

    const { url, headers, sessionId, reconnectionOptions, ...rest } = server
    const normalized: MCPServer = {
      ...rest,
      transportType: 'stdio',
      command: server.command,
      args,
      env
    }

    if (needsUpdate) {
      this.mcpDBClient.update(normalized, { name: server.name }).catch(err => {
        log({
          level: 'warn',
          msg: `Failed to auto-migrate transport for server ${server.name}: ${err.message}`
        })
      })
    }

    return normalized
  }

  private shouldBackfillExternalOAuthResourceUri(server: MCPServerRecord): boolean {
    if (
      (server.source ?? 'platform') !== 'external' ||
      (server.authMode ?? 'none') !== 'oauth2' ||
      server.transportType === 'stdio' ||
      typeof server.url !== 'string' ||
      !server.oauthTemplate
    ) {
      return false
    }

    const runtimeTemplate = this.normalizeExternalOAuthTemplateForRuntime(server)
    return (
      typeof server.oauthTemplate.resourceUri !== 'string' ||
      runtimeTemplate?.resourceUri !== server.oauthTemplate.resourceUri
    )
  }

  private scheduleExternalOAuthResourceUriBackfill(server: MCPServerRecord): void {
    if (!this.shouldBackfillExternalOAuthResourceUri(server)) {
      return
    }

    const cooldownUntil = this.resourceUriBackfillCooldownUntil.get(server.name)
    if (typeof cooldownUntil === 'number' && cooldownUntil > Date.now()) {
      return
    }
    if (this.resourceUriBackfillInFlight.has(server.name)) {
      return
    }

    const task = this.backfillExternalOAuthResourceUri(server)
      .catch((error) => {
        this.resourceUriBackfillCooldownUntil.set(server.name, Date.now() + RESOURCE_URI_BACKFILL_FAILURE_COOLDOWN_MS)
        log({
          level: 'warn',
          msg: `Failed to backfill external OAuth resourceUri for server ${server.name}: ${
            error instanceof Error ? error.message : String(error)
          }`
        })
      })
      .finally(() => {
        this.resourceUriBackfillInFlight.delete(server.name)
      })

    this.resourceUriBackfillInFlight.set(server.name, task)
  }

  private async backfillExternalOAuthResourceUri(server: MCPServerRecord): Promise<void> {
    if (!server.url || !server.oauthTemplate) {
      return
    }

    const previousResourceUri = server.oauthTemplate.resourceUri
    const resourceUri = await this.resolveAuthoritativeResourceUri(
      server.url,
      server.oauthTemplate.discoveryMode,
      server.oauthTemplate.discoverySource,
      server.oauthTemplate.resourceMetadataUrl
    )
    const persistedOauthTemplate: McpExternalOAuthTemplate = {
      ...server.oauthTemplate,
      resourceUri
    }

    await this.mcpDBClient.update(
      {
        oauthTemplate: persistedOauthTemplate,
        updatedAt: new Date()
      },
      { name: server.name }
    )

    const serverKey = buildServerKey({ name: server.name })
    if (this.servers[serverKey]?.transportType === 'streamable_http' && this.servers[serverKey].oauthTemplate) {
      this.servers[serverKey].oauthTemplate = persistedOauthTemplate
    }

    if (previousResourceUri !== resourceUri) {
      await this.invalidateExternalOAuthRuntimeState(server.name)
    }

    this.resourceUriBackfillCooldownUntil.delete(server.name)
  }

  private async invalidateExternalOAuthRuntimeState(serverName: string): Promise<void> {
    const installs = await this.userServerInstalls.listInstallsForServer(serverName)

    for (const [userKey, connection] of Object.entries(this.userConnections) as Array<[UserServerKey, UserConnection]>) {
      if (connection.serverName !== serverName) {
        continue
      }
      await this.teardownUserConnection(userKey, 'oauth_updated')
    }

    if (this.oauthTokensService) {
      await this.oauthTokensService.deleteTokensByServer(serverName)
    }
    if (this.userSessionsService) {
      await this.userSessionsService.deleteSessionsByServer(serverName)
    }

    await Promise.all(
      installs.map((install) =>
        this.userServerInstalls.setAuthState(serverName, install.username, 'not_connected')
      )
    )
  }

  private normalizeExternalOAuthTemplateForRuntime(server: MCPServerRecord): McpExternalOAuthTemplate | undefined {
    if (!server.oauthTemplate) {
      return server.oauthTemplate
    }
    if ((server.source ?? 'platform') !== 'external' || (server.authMode ?? 'none') !== 'oauth2' || !server.url) {
      return server.oauthTemplate
    }

    const normalizedDiscoverySource = server.oauthTemplate.discoverySource ?? 'prm'
    const compatibilityFallbackResourceUri = resolveCompatibilityFallbackExternalOAuthResourceUri(server.url)
    const runtimeResourceUri =
      server.oauthTemplate.discoveryMode !== 'auto' || normalizedDiscoverySource === 'issuer_override'
        ? compatibilityFallbackResourceUri
        : server.oauthTemplate.resourceUri ?? compatibilityFallbackResourceUri

    return {
      ...server.oauthTemplate,
      ...(server.oauthTemplate.discoveryMode === 'auto' && !server.oauthTemplate.discoverySource
        ? { discoverySource: 'prm' as const }
        : {}),
      resourceUri: runtimeResourceUri
    }
  }

  private async normalizeServerRecord(server: MCPServerRecord): Promise<MCPServer> {
    const withSecrets = await this.migrateServerSecrets(server)
    if (this.shouldBackfillExternalOAuthResourceUri(withSecrets)) {
      this.scheduleExternalOAuthResourceUriBackfill(withSecrets)
    }

    const withRuntimeOauthTemplate: MCPServerRecord = {
      ...withSecrets,
      oauthTemplate: this.normalizeExternalOAuthTemplateForRuntime(withSecrets)
    }
    return this.migrateServerTransport(withRuntimeOauthTemplate)
  }

  private async buildTransportOptions(server: MCPServer, username?: string): Promise<TransportFactoryOptions> {
    if (server.transportType !== 'streamable_http') {
      return {}
    }

    const runtimeUrl =
      this.resolveServerSource(server) === 'external' && username
        ? buildExternalUrlWithSecretQueryParams(
            server.url,
            await this.secretsService.getUserServerSecrets(server.name, username)
          )
        : undefined

    if (!this.oauthTokensService || !username) {
      return runtimeUrl ? { url: runtimeUrl } : {}
    }

    const record = await this.oauthTokensService.getTokenRecord(server.name, username)
    if (!record) {
      return runtimeUrl ? { url: runtimeUrl } : {}
    }

    oauthLogInfo(`[oauth:${username}:${server.name}] Building transport auth provider ${JSON.stringify({
        transportUrl: server.url,
        runtimeUrl,
        resourceUri: server.oauthTemplate?.resourceUri,
        authorizationServerIssuer: server.oauthTemplate?.authorizationServerIssuer,
        registrationEndpoint: server.oauthTemplate?.registrationEndpoint,
        tokenEndpoint: server.oauthTemplate?.tokenEndpoint,
        tokenEndpointAuthMethodsSupported: server.oauthTemplate?.tokenEndpointAuthMethodsSupported,
        persistedRecord: {
          clientId: record.clientId ? `${record.clientId.slice(0, 4)}...${record.clientId.slice(-4)}` : undefined,
          tokenEndpointAuthMethod: record.tokenEndpointAuthMethod,
          registrationMode: record.registrationMode,
          expiresAt: record.expiresAt?.toISOString(),
          hasRefreshToken: !!record.refreshToken,
          hasClientSecret: !!record.clientSecret
        }
      })}`)

    const authProvider = new McpOAuthClientProvider({
      serverName: server.name,
      username,
      tokenStore: this.oauthTokensService,
      record,
      tokenEndpoint: server.oauthTemplate?.tokenEndpoint ?? new URL('/token', server.url).toString(),
      resource: server.oauthTemplate?.resourceUri ?? resolveCompatibilityFallbackExternalOAuthResourceUri(server.url),
      issuer: server.oauthTemplate?.authorizationServerIssuer,
      registrationEndpoint: server.oauthTemplate?.registrationEndpoint,
      tokenEndpointAuthMethodsSupported: server.oauthTemplate?.tokenEndpointAuthMethodsSupported,
      dcrClients: this.dcrClients
    })
    const sanitizedHeaders = stripAuthorizationHeaders(server.headers)
    return {
      authProvider,
      requestInit: buildRequestInit(sanitizedHeaders ?? {}),
      ...(runtimeUrl ? { url: runtimeUrl } : {})
    }
  }

  private async persistUserSessionId(
    serverName: string,
    username: string,
    transport: StreamableHTTPClientTransport
  ): Promise<void> {
    const nextSessionId = transport.sessionId
    const userKey = buildUserServerKey(username, serverName)
    const userConn = this.userConnections[userKey]
    if (userConn && nextSessionId === userConn.sessionId) {
      return
    }
    if (userConn) {
      userConn.sessionId = nextSessionId
    }
    if (this.userSessionsService) {
      await this.userSessionsService.upsertSession(serverName, username, nextSessionId)
    }
  }

  private async clearUserSessionId(serverName: string, username: string): Promise<void> {
    const userKey = buildUserServerKey(username, serverName)
    const userConn = this.userConnections[userKey]
    if (userConn) {
      userConn.sessionId = undefined
    }
    if (this.userSessionsService) {
      await this.userSessionsService.clearSession(serverName, username)
    }
  }

  /**
   * Convert a built-in server to MCPServer format for API consistency
   */
  private builtInToMCPServer(builtInServer: BuiltInServer): MCPServer {
    return {
      name: builtInServer.externalName, // Use external name for public-facing API
      displayName: builtInServer.externalName,
      description: '',
      source: 'platform',
      authMode: 'none',
      secretFields: [],
      transportType: 'stdio',
      command: 'built-in', // Special marker
      args: [],
      env: {},
      status: 'connected', // Built-in servers are always "connected"
      enabled: true, // Built-in servers are always enabled
      toolsList: builtInServer.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    }
  }

  private resolveServerSource(server: MCPServer): McpServerSource {
    return server.source ?? 'platform'
  }

  private assertAbsoluteUrl(value: string, fieldName: string): void {
    try {
      new URL(value)
    } catch {
      throw new McpValidationError(`${fieldName} must be a valid absolute URL`)
    }
  }

  private assertAbsoluteHttpsUrl(value: string, fieldName: string): void {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new McpValidationError(`${fieldName} must be a valid absolute HTTPS URL`)
    }
    if (parsed.protocol !== 'https:') {
      throw new McpValidationError(`${fieldName} must use https`)
    }
  }

  private async resolveAuthoritativeResourceUri(
    transportUrl: string,
    discoveryMode: McpExternalOAuthTemplate['discoveryMode'],
    discoverySource?: McpExternalOAuthDiscoverySource,
    resourceMetadataUrl?: string
  ): Promise<string> {
    if (discoveryMode !== 'auto') {
      return resolveCompatibilityFallbackExternalOAuthResourceUri(transportUrl)
    }

    const normalizedDiscoverySource = discoverySource ?? 'prm'
    if (normalizedDiscoverySource === 'issuer_override') {
      return resolveCompatibilityFallbackExternalOAuthResourceUri(transportUrl)
    }
    if (!resourceMetadataUrl) {
      throw new McpValidationError('oauthTemplate.resourceMetadataUrl is required for PRM-backed discovery mode')
    }

    const discoveryDeadlineMs = Date.now() + DISCOVERY_TOTAL_BUDGET_MS
    const metadata = await this.fetchProtectedResourceMetadataDocument(resourceMetadataUrl, discoveryDeadlineMs)
    return this.resolveProtectedResourceUri(metadata, transportUrl)
  }

  private validateExternalOAuthTemplate(
    authMode: McpServerAuthMode,
    oauthTemplate?: McpExternalOAuthTemplate,
    transportUrl?: string
  ): void {
    if (authMode !== 'oauth2') {
      return
    }

    if (!oauthTemplate) {
      throw new McpValidationError('oauthTemplate is required when authMode is oauth2')
    }

    this.assertAbsoluteUrl(oauthTemplate.authorizationEndpoint, 'oauthTemplate.authorizationEndpoint')
    this.assertAbsoluteUrl(oauthTemplate.tokenEndpoint, 'oauthTemplate.tokenEndpoint')
    if (!oauthTemplate.resourceUri) {
      throw new McpValidationError('oauthTemplate.resourceUri is required for external OAuth servers')
    }

    if (oauthTemplate.pkceRequired !== true) {
      throw new McpValidationError('oauthTemplate.pkceRequired must be true for external OAuth servers')
    }
    if (!oauthTemplate.codeChallengeMethodsSupported.includes(REQUIRED_PKCE_CHALLENGE_METHOD)) {
      throw new McpValidationError(
        `oauthTemplate.codeChallengeMethodsSupported must include ${REQUIRED_PKCE_CHALLENGE_METHOD}`
      )
    }

    if (oauthTemplate.discoveryMode === 'auto') {
      const normalizedDiscoverySource = oauthTemplate.discoverySource ?? 'prm'
      this.assertAbsoluteUrl(
        oauthTemplate.authorizationServerMetadataUrl,
        'oauthTemplate.authorizationServerMetadataUrl'
      )
      this.assertAbsoluteHttpsUrl(oauthTemplate.authorizationServerIssuer, 'oauthTemplate.authorizationServerIssuer')
      if (!oauthTemplate.authorizationServerIssuer.trim()) {
        throw new McpValidationError('oauthTemplate.authorizationServerIssuer is required in discovery mode')
      }
      if (normalizedDiscoverySource === 'prm') {
        if (!oauthTemplate.resourceMetadataUrl) {
          throw new McpValidationError('oauthTemplate.resourceMetadataUrl is required for PRM-backed discovery mode')
        }
        this.assertAbsoluteUrl(oauthTemplate.resourceMetadataUrl, 'oauthTemplate.resourceMetadataUrl')
      } else if (normalizedDiscoverySource === 'issuer_override') {
        if (oauthTemplate.resourceMetadataUrl) {
          throw new McpValidationError('oauthTemplate.resourceMetadataUrl must be omitted for issuer-override discovery mode')
        }
        if (!transportUrl) {
          throw new McpValidationError('External OAuth transport url is required for issuer-override mode validation')
        }
        if (oauthTemplate.resourceUri !== resolveCompatibilityFallbackExternalOAuthResourceUri(transportUrl)) {
          throw new McpValidationError(
            'oauthTemplate.resourceUri must equal the resolved fallback resource uri in issuer-override discovery mode'
          )
        }
      } else {
        throw new McpValidationError('oauthTemplate.discoverySource must be prm or issuer_override in discovery mode')
      }
      if (
        oauthTemplate.registrationMode === 'dcr' &&
        !oauthTemplate.registrationEndpoint
      ) {
        throw new McpValidationError('oauthTemplate.registrationEndpoint is required when registrationMode is dcr')
      }
      if (
        oauthTemplate.registrationMode === 'dcr' &&
        normalizeTokenEndpointAuthMethods(oauthTemplate.tokenEndpointAuthMethodsSupported).length === 0
      ) {
        throw new McpValidationError(
          'oauthTemplate.tokenEndpointAuthMethodsSupported must include a supported auth method for dcr'
        )
      }
    } else {
      this.assertAbsoluteHttpsUrl(oauthTemplate.authorizationEndpoint, 'oauthTemplate.authorizationEndpoint')
      this.assertAbsoluteHttpsUrl(oauthTemplate.tokenEndpoint, 'oauthTemplate.tokenEndpoint')
      if (oauthTemplate.discoverySource) {
        throw new McpValidationError('oauthTemplate.discoverySource must be omitted in manual mode')
      }
      if (oauthTemplate.registrationMode !== 'manual') {
        throw new McpValidationError('Manual OAuth template mode must use manual registration mode')
      }
      if (!transportUrl) {
        throw new McpValidationError('External OAuth transport url is required for manual mode validation')
      }
      if (oauthTemplate.resourceUri !== resolveCompatibilityFallbackExternalOAuthResourceUri(transportUrl)) {
        throw new McpValidationError('oauthTemplate.resourceUri must equal the resolved fallback resource uri in manual mode')
      }
    }

    if (
      oauthTemplate.registrationMode === 'cimd' &&
      oauthTemplate.clientIdMetadataDocumentSupported !== true
    ) {
      throw new McpValidationError(
        'oauthTemplate.clientIdMetadataDocumentSupported must be true when registrationMode is cimd'
      )
    }
    if (oauthTemplate.registrationMode === 'dcr' && oauthTemplate.discoveryMode !== 'auto') {
      throw new McpValidationError('DCR requires discovery-backed OAuth metadata')
    }
  }

  private async normalizeExternalOAuthTemplateForPersistence(
    authMode: McpServerAuthMode,
    transportUrl: string,
    oauthTemplate?: McpExternalOAuthTemplate
  ): Promise<McpExternalOAuthTemplate | undefined> {
    if (authMode !== 'oauth2') {
      return oauthTemplate
    }

    if (!oauthTemplate) {
      throw new McpValidationError('oauthTemplate is required when authMode is oauth2')
    }

    if (oauthTemplate.discoveryMode === 'auto') {
      const normalizedDiscoverySource = oauthTemplate.discoverySource ?? 'prm'
      this.assertAbsoluteUrl(
        oauthTemplate.authorizationServerMetadataUrl,
        'oauthTemplate.authorizationServerMetadataUrl'
      )
      this.assertAbsoluteHttpsUrl(oauthTemplate.authorizationServerIssuer, 'oauthTemplate.authorizationServerIssuer')
      if (!oauthTemplate.authorizationServerIssuer.trim()) {
        throw new McpValidationError('oauthTemplate.authorizationServerIssuer is required in discovery mode')
      }
      if (normalizedDiscoverySource === 'prm') {
        if (!oauthTemplate.resourceMetadataUrl) {
          throw new McpValidationError('oauthTemplate.resourceMetadataUrl is required for PRM-backed discovery mode')
        }
        this.assertAbsoluteUrl(oauthTemplate.resourceMetadataUrl, 'oauthTemplate.resourceMetadataUrl')
      } else if (normalizedDiscoverySource === 'issuer_override') {
        if (oauthTemplate.resourceMetadataUrl) {
          throw new McpValidationError('oauthTemplate.resourceMetadataUrl must be omitted for issuer-override discovery mode')
        }
      } else {
        throw new McpValidationError('oauthTemplate.discoverySource must be prm or issuer_override in discovery mode')
      }
    }

    const normalizedTemplate: McpExternalOAuthTemplate = {
      ...oauthTemplate,
      ...(oauthTemplate.discoveryMode === 'auto' && !oauthTemplate.discoverySource
        ? { discoverySource: 'prm' as const }
        : {}),
      resourceUri: await this.resolveAuthoritativeResourceUri(
        transportUrl,
        oauthTemplate.discoveryMode,
        oauthTemplate.discoverySource,
        oauthTemplate.resourceMetadataUrl
      )
    }

    this.validateExternalOAuthTemplate(authMode, normalizedTemplate, transportUrl)
    return normalizedTemplate
  }

  private resolveAuthState(server: MCPServer, install?: McpUserExternalServerInstallRecord): UserInstallAuthState | undefined {
    if (this.resolveServerSource(server) !== 'external') {
      return 'not_required'
    }

    if ((server.authMode ?? 'none') === 'none') {
      return 'not_required'
    }

    return install?.authState ?? 'not_connected'
  }

  private toUserVisibleServer(
    server: MCPServer,
    install?: McpUserExternalServerInstallRecord | null,
    configuredSecretNames: string[] = []
  ): UserVisibleMcpServer {
    const source = this.resolveServerSource(server)
    const authMode = server.authMode ?? 'none'
    const installed = source === 'platform' ? true : install != null
    const enabled = source === 'platform' ? server.enabled : install?.enabled === true
    const authState = this.resolveAuthState(server, install ?? undefined)
    const authRequired = authMode === 'oauth2'

    return {
      name: server.name,
      displayName: server.displayName ?? server.name,
      description: server.description ?? '',
      source,
      transportType: server.transportType,
      authMode,
      installed,
      enabled,
      authState,
      authRequired,
      secretFields: server.secretFields ?? [],
      secretNames: server.secretNames ?? (server.secretName ? [server.secretName] : []),
      configuredSecretNames,
      toolsList: server.toolsList,
      homepageUrl: server.homepageUrl,
      repositoryUrl: server.repositoryUrl,
      licenseName: server.licenseName,
      canInstall: source === 'external' && !installed,
      canUninstall: source === 'external' && installed,
      canConfigure:
        (source === 'external' && installed) ||
        ((server.secretNames?.length ?? 0) > 0 || (server.secretName ? 1 : 0) > 0),
      canManagePlatformServer: source === 'platform',
      statusMessage: install?.lastAuthError,
      url: server.transportType === 'streamable_http' ? server.url : undefined,
      oauthTemplate: server.oauthTemplate,
      oauthClientConfig:
        source === 'external'
          ? {
              clientId: install?.oauthClientId,
              scopes: install?.oauthScopes
            }
          : undefined,
      command: server.transportType === 'stdio' ? server.command : undefined,
      args: server.transportType === 'stdio' ? server.args : undefined,
      env: server.transportType === 'stdio' ? server.env : undefined,
      headers: server.transportType === 'streamable_http' ? server.headers : undefined,
      logs: server.logs
    }
  }

  public async init() {
    await this.mcpDBClient.connect('mcp')

    // Initialize built-in servers
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    await builtInRegistry.initAll()

    // Add built-in servers to the servers map
    for (const builtInServer of builtInRegistry.list()) {
      const mcpServer = this.builtInToMCPServer(builtInServer)
      const serverKey = buildServerKey(mcpServer)
      this.servers[serverKey] = mcpServer
      this.serverKeys.push(serverKey)
      log({
        level: 'info',
        msg: `Added built-in server to registry: ${builtInServer.name}`
      })
    }

    // No need to init secrets here, it will be done at a higher level
    const list = await this.mcpDBClient.find({})
    this.list = []
    for (const { _id, ...server } of list ?? []) {
      const baseServer: MCPServerRecord = {
        ...server,
        status: 'disconnected',
        enabled: server.enabled !== false // Default to true if not set
      }

      try {
        const normalized = await this.normalizeServerRecord(baseServer)
        this.list.push(normalized)
      } catch (error) {
        log({
          level: 'error',
          msg: `[${server.name}] Failed to normalize server config; skipping startup.`,
          error: error
        })
      }
    }

    for (const server of this.list) {
      try {
        if (server.transportType === 'streamable_http') {
          // Streamable HTTP servers use lazy per-user connections.
          // Register the server definition but do not eagerly connect.
          const serverKey = buildServerKey(server)
          this.servers[serverKey] = {
            ...server,
            status: 'disconnected',
            logs: []
          }
          if (!this.serverKeys.includes(serverKey)) {
            this.serverKeys.push(serverKey)
          }
          log({
            level: 'info',
            msg: `[${server.name}] Registered streamable HTTP server (lazy per-user connection).`
          })
        } else {
          await this.connectToServer(server)
          // Now awaiting the fetchToolsForServer call to catch errors
          await this.fetchToolsForServer(server)
        }
      } catch (error) {
        log({
          level: 'error',
          msg: `[${server.name}] Unhandled exception during server startup sequence.`,
          error: error
        })
      }
    }
    log({ level: 'info', msg: `MCPService initialized with ${this.list.length} servers` })
  }

  public async getUserServers(username: string): Promise<UserVisibleMcpServer[]> {
    const sharedServers = Object.values(this.servers)
    const installs = await this.userServerInstalls.listInstallsForUser(username)
    const installsByServer = new Map(installs.map((install) => [install.serverName, install]))
    const configuredSecretNamesEntries = await Promise.all(
      sharedServers.map(async (server) => [
        server.name,
        await this.secretsService.listSecretNamesByServerPrefix(server.name, username)
      ] as const)
    )
    const configuredSecretNamesByServer = new Map(configuredSecretNamesEntries)

    return sharedServers.flatMap((server) => {
      const source = this.resolveServerSource(server)
      if (source !== 'external') {
        if (server.enabled !== true) return []
        return [this.toUserVisibleServer(server, undefined, configuredSecretNamesByServer.get(server.name) ?? [])]
      }

      if (server.enabled !== true) {
        return []
      }

      const install = installsByServer.get(server.name)
      return [this.toUserVisibleServer(server, install, configuredSecretNamesByServer.get(server.name) ?? [])]
    })
  }

  public async getUserServer(username: string, serverName: string): Promise<UserVisibleMcpServer | null> {
    const server = await this.getServer(serverName)
    if (!server) {
      return null
    }

    const install = this.resolveServerSource(server) === 'external'
      ? await this.userServerInstalls.getInstall(serverName, username)
      : undefined
    const configuredSecretNames = await this.secretsService.listSecretNamesByServerPrefix(serverName, username)

    return this.toUserVisibleServer(server, install, configuredSecretNames)
  }

  public async getUserServerInstallDetails(
    username: string,
    serverName: string
  ): Promise<UserServerInstallDetails | null> {
    const install = await this.userServerInstalls.getInstall(serverName, username)
    if (!install) {
      return null
    }

    return {
      serverName: install.serverName,
      username: install.username,
      enabled: install.enabled,
      authState: install.authState,
      oauthClientId: install.oauthClientId,
      oauthClientSecret: install.oauthClientSecret,
      oauthScopes: install.oauthScopes
    }
  }

  public async resolveExternalOAuthClientContext(
    input: ResolveExternalOAuthClientInput
  ): Promise<ResolvedExternalOAuthClientContext> {
    const server = await this.getServer(input.serverName)
    if (!server) {
      throw new McpServerNotFoundError(input.serverName)
    }
    if (this.resolveServerSource(server) !== 'external' || server.authMode !== 'oauth2' || !server.oauthTemplate) {
      throw new McpValidationError(`Server ${input.serverName} is not an external OAuth server`)
    }

    const registrationMode = server.oauthTemplate.registrationMode
    if (registrationMode === 'manual') {
      const install = await this.userServerInstalls.getInstall(input.serverName, input.username)
      if (!install?.oauthClientId) {
        throw new McpValidationError(`Manual OAuth clientId is not configured for user ${input.username}`)
      }
      return {
        registrationMode,
        clientId: install.oauthClientId,
        clientSecret: install.oauthClientSecret,
        tokenEndpointAuthMethod: install.oauthClientSecret ? 'client_secret_post' : 'none'
      }
    }

    if (registrationMode === 'cimd') {
      return {
        registrationMode,
        clientId: input.oauthProvisioningContext.clientMetadataUrl,
        tokenEndpointAuthMethod: 'none'
      }
    }

    if (!this.dcrClients || !server.oauthTemplate.registrationEndpoint) {
      throw new McpValidationError(`DCR client provisioning is not available for server ${input.serverName}`)
    }

    const registration = await this.dcrClients.getOrRegisterClient({
      issuer: server.oauthTemplate.authorizationServerIssuer,
      registrationEndpoint: server.oauthTemplate.registrationEndpoint,
      tokenEndpointAuthMethodsSupported: server.oauthTemplate.tokenEndpointAuthMethodsSupported,
      oauthProvisioningContext: input.oauthProvisioningContext
    })

    return {
      registrationMode,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod
    }
  }

  public async getUserTools(username: string): Promise<ToolsList[] | { [key: string]: ToolsList }[]> {
    const servers = await this.getUserServers(username)

    return servers
      .filter((server) => {
        if (server.source !== 'external') {
          return server.enabled === true
        }

        return server.installed === true && server.enabled === true
      })
      .map((server) => ({
        [server.name]: [...(server.toolsList ?? [])]
      }))
  }

  public async getUserServerTools(username: string, serverName: string): Promise<ToolsList> {
    const server = await this.getServer(serverName)
    if (!server) {
      throw new McpServerNotFoundError(serverName)
    }

    if (this.resolveServerSource(server) === 'external') {
      const install = await this.userServerInstalls.getInstall(serverName, username)
      if (!install || install.enabled !== true) {
        throw new McpValidationError(`Server ${serverName} is not installed for user ${username}`)
      }
      if ((server.authMode ?? 'none') === 'oauth2' && install.authState !== 'connected') {
        throw new McpAuthNotConnectedError(serverName, username)
      }
      await this.refreshUserServer(serverName, username)
    }

    return this.servers[buildServerKey(server)]?.toolsList ?? []
  }

  private async connectToServer(server: MCPServer) {
    const serverKey = buildServerKey(server)
    const transportErrorHandler = async (error: Error) => {
      log({ level: 'error', msg: `${serverKey} transport error: ${error.message}`, error })
      if (this.servers[serverKey]) {
        this.servers[serverKey].logs?.push(error.message)
      }
    }

    const transportCloseHandler = async () => {
      log({ level: 'info', msg: `[${server.name}] Transport closed.` })
      if (this.servers[serverKey]) {
        this.servers[serverKey].status = 'disconnected'
        // Add a final log of all captured stderr logs for debugging
        if (this.servers[serverKey].logs && this.servers[serverKey].logs!.length > 0) {
          log({
            level: 'info',
            msg: `[${server.name}] Final captured logs before exit:\n ${JSON.stringify(
              this.servers[serverKey].logs,
              null,
              2
            )}`
          })
        }
      }
    }

    try {
      // If server is disabled, add it to this.servers with disconnected status but don't start it
      if (server.enabled === false) {
        log({ level: 'info', msg: `Server ${server.name} is disabled, adding to servers list but not starting` })
        this.servers[serverKey] = {
          ...server,
          status: 'disconnected',
          logs: []
        }
        return
      }

      const client = new Client(
        { name: 'MSQStdioClient', version: '1.0.0' },
        { capabilities: { prompts: {}, resources: {}, tools: {} } }
      )
      const transportOptions = await this.buildTransportOptions(server)
      const transport = createTransport(server, transportOptions)
      this.servers[serverKey] = {
        ...server,
        status: 'connecting',
        logs: [],
        connection: { client, transport }
      }
      if (!this.serverKeys.includes(serverKey)) {
        this.serverKeys.push(serverKey)
      }

      // Store event handler references
      this.servers[serverKey].eventHandlers = {
        transportErrorHandler,
        transportCloseHandler
      }

      transport.onerror = transportErrorHandler
      transport.onclose = transportCloseHandler

      if (server.transportType === 'stdio') {
        if (!(transport instanceof StdioClientTransport)) {
          throw new Error(`[${server.name}] Expected stdio transport but got a different transport instance.`)
        }

        const stderrStream = transport.stderr
        if (stderrStream) {
          log({ level: 'info', msg: `[${server.name}] Attaching stderr listener.` })
          // Create and store stderr data handler
          const stderrDataHandler = async (data: Buffer) => {
            const logMsg = data.toString().trim()
            log({ level: 'error', msg: `[${server.name}] stderr: ${logMsg}` })
            if (this.servers[serverKey]) {
              this.servers[serverKey].logs?.push(logMsg)
            }
          }

          this.servers[serverKey].eventHandlers!.stderrDataHandler = stderrDataHandler
          stderrStream.on('data', stderrDataHandler)
        } else {
          log({ level: 'error', msg: `[${server.name}] stderr stream is null` })
        }

        log({
          level: 'info',
          msg: `Attempting to start server ${server.name} with command: ${server.command} ${server.args.join(' ')}`
        })
      } else {
        log({
          level: 'info',
          msg: `Attempting to connect to streamable HTTP server ${server.name} at ${server.url}`
        })
      }

      await this.servers[serverKey].connection!.client.connect(this.servers[serverKey].connection!.transport)
      this.servers[serverKey].status = 'connected'
      log({ level: 'info', msg: `[${server.name}] Connected successfully. Will fetch tool list.` })
    } catch (error) {
      log({
        level: 'error',
        msg: `[${server.name}] Failed to start or connect to server.`,
        error: error
      })

      if (this.servers[serverKey]) {
        this.servers[serverKey].status = 'error'
      }

      // Attempt to install missing package if PackageService is available
      let installSuccess = false
      if (server.transportType === 'stdio' && this.packageService) {
        log({ level: 'info', msg: `Attempting to install missing package for server ${server.name}` })
        installSuccess = await this.packageService.installMissingPackage(server.name)
      }

      // If installation failed or no PackageService, mark stdio servers as disabled
      if (server.transportType === 'stdio' && !installSuccess) {
        // Mark server as disabled in the database
        server.enabled = false
        await this.mcpDBClient.update(server, { name: server.name })
        log({ level: 'info', msg: `Server ${server.name} has been disabled due to startup failure` })
      }
    }
  }

  /**
   * Establishes a per-user connection to a streamable HTTP server.
   * Uses persisted session ID and OAuth tokens for the given user.
   */
  public async connectUserToServer(
    username: string,
    server: MCPServer,
    allowSessionRetry = true
  ): Promise<UserConnection> {
    if (server.transportType !== 'streamable_http') {
      throw new Error(`connectUserToServer is only for streamable_http servers, got ${server.transportType}`)
    }

    const userKey = buildUserServerKey(username, server.name)

    // Check if already connected
    const existing = this.userConnections[userKey]
    if (existing && existing.status === 'connected') {
      return existing
    }

    const inFlight = this.userConnectionInFlight.get(userKey)
    if (inFlight) {
      oauthLogInfo(`[${username}:${server.name}] Connection already in flight; awaiting existing attempt.`)
      return inFlight
    }

    const connectPromise = this.connectUserToServerInternal(username, server, allowSessionRetry).finally(() => {
      if (this.userConnectionInFlight.get(userKey) === connectPromise) {
        this.userConnectionInFlight.delete(userKey)
      }
    })
    this.userConnectionInFlight.set(userKey, connectPromise)
    return connectPromise
  }

  private async connectUserToServerInternal(
    username: string,
    server: MCPServer,
    allowSessionRetry = true
  ): Promise<UserConnection> {
    if (server.transportType !== 'streamable_http') {
      throw new Error(`connectUserToServer is only for streamable_http servers, got ${server.transportType}`)
    }

    await validateExternalMcpUrl(server.url)

    const userKey = buildUserServerKey(username, server.name)

    // Check if already connected
    const existing = this.userConnections[userKey]
    if (existing && existing.status === 'connected') {
      return existing
    }

    // Load persisted session for this user
    let sessionId: string | undefined
    if (this.userSessionsService) {
      const sessionRecord = await this.userSessionsService.getSession(server.name, username)
      sessionId = sessionRecord?.sessionId ?? undefined
    }

    const transportErrorHandler = async (error: Error) => {
      log({ level: 'error', msg: `[${username}:${server.name}] transport error: ${error.message}`, error })
      const conn = this.userConnections[userKey]
      if (conn) {
        conn.logs?.push(error.message)
      }
    }

    const transportCloseHandler = async () => {
      log({ level: 'info', msg: `[${username}:${server.name}] Transport closed.` })
      const conn = this.userConnections[userKey]
      if (conn) {
        conn.status = 'disconnected'
      }
    }

    try {
      const client = new Client(
        { name: 'MSQStdioClient', version: '1.0.0' },
        { capabilities: { prompts: {}, resources: {}, tools: {} } }
      )
      const transportOptions = await this.buildTransportOptions(server, username)
      const transport = createTransport(server, { ...transportOptions, sessionId })

      const userConn: UserConnection = {
        username,
        serverName: server.name,
        client,
        transport,
        sessionId,
        status: 'connecting',
        logs: [],
        eventHandlers: {
          transportErrorHandler,
          transportCloseHandler
        }
      }
      this.userConnections[userKey] = userConn

      transport.onerror = transportErrorHandler
      transport.onclose = transportCloseHandler

      log({
        level: 'info',
        msg: `[${username}:${server.name}] Connecting to streamable HTTP server at ${server.url}`
      })

      await client.connect(transport)
      userConn.status = 'connected'

      if (transport instanceof StreamableHTTPClientTransport) {
        await this.persistUserSessionId(server.name, username, transport)
      }
      log({ level: 'info', msg: `[${username}:${server.name}] Connected successfully.` })

      return userConn
    } catch (error) {
      // Session expired — retry without sessionId
      if (
        sessionId &&
        allowSessionRetry &&
        extractHttpStatusFromError(error) === 404
      ) {
        log({
          level: 'warn',
          msg: `[${username}:${server.name}] Session expired. Clearing and retrying.`
        })
        await this.clearUserSessionId(server.name, username)
        await this.teardownUserConnection(userKey, 'session_expired')
        return this.connectUserToServerInternal(username, server, false)
      }

      // Fallback to SSE
      if (shouldFallbackToSse(error)) {
        log({
          level: 'warn',
          msg: `[${username}:${server.name}] Streamable HTTP failed. Falling back to SSE.`
        })

        // Clean up failed transport
        const failedConn = this.userConnections[userKey]
        if (failedConn?.transport) {
          failedConn.transport.onerror = undefined
          failedConn.transport.onclose = undefined
          try {
            await failedConn.transport.close()
          } catch {
            // ignore cleanup errors
          }
        }

        const fallbackClient = new Client(
          { name: 'MSQStdioClient', version: '1.0.0' },
          { capabilities: { prompts: {}, resources: {}, tools: {} } }
        )
        const transportOptions = await this.buildTransportOptions(server, username)
        const fallbackTransport = createSseTransport(server, transportOptions)

        fallbackTransport.onerror = transportErrorHandler
        fallbackTransport.onclose = transportCloseHandler

        const userConn: UserConnection = {
          username,
          serverName: server.name,
          client: fallbackClient,
          transport: fallbackTransport,
          status: 'connecting',
          logs: [],
          eventHandlers: {
            transportErrorHandler,
            transportCloseHandler
          }
        }
        this.userConnections[userKey] = userConn

        try {
          await fallbackClient.connect(fallbackTransport)
          userConn.status = 'connected'
          log({
            level: 'info',
            msg: `[${username}:${server.name}] Connected via SSE fallback.`
          })
          return userConn
        } catch (fallbackError) {
          log({
            level: 'error',
            msg: `[${username}:${server.name}] SSE fallback also failed.`,
            error: fallbackError
          })
        }
      }

      log({
        level: 'error',
        msg: `[${username}:${server.name}] Failed to connect.`,
        error
      })

      const conn = this.userConnections[userKey]
      if (conn) {
        conn.status = 'error'
      }

      throw normalizeExternalAuthError(error, username, server.name)
    }
  }

  private async teardownUserConnection(
    userKey: UserServerKey,
    reason: UserConnectionTeardownReason = 'shutdown'
  ): Promise<void> {
    const conn = this.userConnections[userKey]
    if (!conn) {
      return
    }

    const policy = resolveUserConnectionTeardownPolicy(reason)
    const { transport, client, eventHandlers } = conn
    if (eventHandlers?.transportErrorHandler) {
      transport.onerror = undefined
    }
    if (eventHandlers?.transportCloseHandler) {
      transport.onclose = undefined
    }

    if (policy.clearPersistedSession) {
      await this.clearUserSessionId(conn.serverName, conn.username)
    }

    if (policy.terminateSession && isStreamableHTTPTransport(transport)) {
      try {
        await transport.terminateSession()
      } catch (error) {
        log({
          level: 'warn',
          msg: `[${userKey}] Failed to terminate HTTP session: ${(error as Error).message}`
        })
      }
    }

    await transport.close()
    await client.close()
    delete this.userConnections[userKey]
  }

  private async teardownServerConnection(serverKey: string): Promise<void> {
    const server = this.servers[serverKey]
    if (!server?.connection) {
      return
    }

    const { transport, client } = server.connection
    const { stderrDataHandler, transportErrorHandler, transportCloseHandler } = server.eventHandlers ?? {}

    if (stderrDataHandler && transport instanceof StdioClientTransport) {
      const stderrStream = transport.stderr
      if (stderrStream) {
        stderrStream.removeListener('data', stderrDataHandler)
      }
    }

    if (transportErrorHandler) {
      transport.onerror = undefined
    }
    if (transportCloseHandler) {
      transport.onclose = undefined
    }

    if (isStreamableHTTPTransport(transport)) {
      try {
        await transport.terminateSession()
      } catch (error) {
        log({
          level: 'warn',
          msg: `[${server.name}] Failed to terminate HTTP session: ${(error as Error).message}`
        })
      }
    }

    await transport.close()
    await client.close()
  }

  private async fetchToolsForServer(
    server: MCPServer,
    retryCount = 0,
    maxRetries = 3,
    initialDelay = 120000
  ) {
    const serverKey = buildServerKey(server)
    const connection = this.servers[serverKey]?.connection

    if (!connection || !this.servers[serverKey] || this.servers[serverKey].status !== 'connected') {
      return
    }

    try {
      const requestOptions: RequestOptions = {
        // Respect the server-specific timeout, or default to 3 minutes.
        timeout: server.startupTimeout || 180000,
        maxTotalTimeout: 300000
      }

      log({
        level: 'info',
        msg: `[${server.name}] Attempting to fetch tool list (Attempt ${
          retryCount + 1
        }/${maxRetries}) with timeout ${requestOptions.timeout}ms.`
      })

      const tools = await connection.client.request({ method: 'tools/list' }, ListToolsResultSchema, requestOptions)

      if (this.servers[serverKey]) {
        this.servers[serverKey].toolsList = tools.tools
        log({ level: 'info', msg: `[${server.name}] Successfully fetched tool list.` })
      }
    } catch (error) {
      log({
        level: 'error',
        msg: `[${server.name}] Failed to fetch tool list on attempt ${retryCount + 1}.`,
        error: error
      })

      if (retryCount < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, retryCount)
        log({ level: 'info', msg: `[${server.name}] Retrying in ${delay / 1000} seconds...` })
        await new Promise(resolve => setTimeout(resolve, delay))
        // Important: await the recursive call to ensure the sequence is handled correctly.
        await this.fetchToolsForServer(server, retryCount + 1, maxRetries, initialDelay)
      } else {
        log({
          level: 'error',
          msg: `[${server.name}] Max retries reached. Disabling server.`
        })
        // Gracefully handle the error by marking the server as 'error' and disabling it
        if (this.servers[serverKey]) {
          this.servers[serverKey].status = 'error'
          this.servers[serverKey].enabled = false // Mark as disabled in memory
        }
        // Also update the database to persist the disabled state
        await this.mcpDBClient.update({ ...server, enabled: false }, { name: server.name })
      }
    }
  }

  public async callTool(username: string, serverName: string, methodName: string, args: Record<string, unknown>) {
    // Check if it's a built-in server first by its external name
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(serverName)) {
      const builtInServer = builtInRegistry.getByExternalName(serverName)
      if (!builtInServer) {
        throw new McpServerNotFoundError(serverName)
      }

      log({ level: 'info', msg: `Calling built-in tool - ${serverName}:${methodName}` })

      // Apply secrets if any (built-in servers can still use secrets)
      const secrets = await this.secretsService.getSecrets(username)
      if (secrets != null) {
        args = { ...args, ...secrets }
        log({
          level: 'info',
          msg: `Secrets applied to built-in tool call - ${serverName}:${methodName}`
        })
      }

      // Call the built-in server directly
      const toolResponse = await builtInServer.callTool(methodName, args)
      log({ level: 'info', msg: `Built-in tool called - ${serverName}:${methodName}` })

      return toolResponse
    }

    const server = Object.values(this.servers).find(server => server.name === serverName)
    if (!server) {
      log({ level: 'error', msg: `Server ${serverName} not found` })
      throw new McpServerNotFoundError(serverName)
    }
    if (!server.enabled) {
      log({ level: 'error', msg: `Server ${serverName} is disabled` })
      throw new McpServerDisabledError(serverName)
    }

    // Resolve the correct client based on transport type
    let callClient: Client

    if (server.transportType === 'streamable_http') {
      // Per-user connection for streamable HTTP servers
      const userKey = buildUserServerKey(username, serverName)
      let userConn = this.userConnections[userKey]

      // Lazy connection: connect on first use
      if (!userConn || userConn.status !== 'connected') {
        try {
          userConn = await this.connectUserToServer(username, server)
        } catch (error) {
          log({
            level: 'error',
            msg: `[${username}:${serverName}] Failed to establish user connection for tool call.`,
            error
          })
          const normalized = normalizeExternalAuthError(error, username, serverName)
          if (normalized instanceof McpReauthRequiredError) {
            await this.userServerInstalls.setAuthState(serverName, username, 'reauth_required', normalized.message)
          }
          throw normalized
        }
      }

      callClient = userConn.client
    } else {
      // Shared connection for stdio servers
      if (server.status !== 'connected') {
        throw new Error(`Server ${serverName} not connected. Status: ${server.status}`)
      }
      if (!server.connection) {
        throw new Error(`Server ${serverName} has no connection`)
      }
      callClient = server.connection.client
    }

    const allSecrets = await this.secretsService.getSecrets(username)
    if (allSecrets != null) {
      // Get server's declared secret names from metadata
      const serverSecretNames = server.secretNames ?? (server.secretName ? [server.secretName] : [])

      // Extract secrets belonging to this server: keys stored as "${serverName}.${secretName}"
      const prefix = `${serverName}.`
      const serverSecrets: Record<string, string> = {}
      for (const [key, value] of Object.entries(allSecrets)) {
        if (key.startsWith(prefix)) {
          serverSecrets[key.slice(prefix.length)] = value
        }
      }

      if (serverSecretNames.length > 0) {
        // Inject only the declared secret names
        const scopedSecrets: Record<string, string> = {}
        for (const name of serverSecretNames) {
          if (serverSecrets[name] !== undefined) {
            scopedSecrets[name] = serverSecrets[name]
          }
        }
        args = { ...args, ...scopedSecrets }
        log({
          level: 'info',
          msg: `Scoped secrets applied to tool call - ${serverName}:${methodName} - ${Object.keys(scopedSecrets).join(', ')}`
        })
      } else {
        // No declared secretNames — inject all secrets belonging to this server
        args = { ...args, ...serverSecrets }
        log({
          level: 'info',
          msg: `Server secrets applied to tool call - ${serverName}:${methodName} - ${Object.keys(serverSecrets).join(', ')}`
        })
      }
    }
    log({ level: 'info', msg: `Calling tool - ${serverName}:${methodName}` })
    log({ level: 'debug', msg: `callTool arguments keys: ${Object.keys(args).join(', ')}` })
    const requestOptions: RequestOptions = {}
    if (server.startupTimeout) {
      requestOptions.timeout = server.startupTimeout
    }
    const toolResponse = await callClient
      .callTool(
        { name: methodName, arguments: args },
        CallToolResultSchema,
        requestOptions
      )
      .catch(async error => {
        const normalized = normalizeExternalAuthError(error, username, serverName)
        if (normalized instanceof McpReauthRequiredError) {
          await this.userServerInstalls.setAuthState(serverName, username, 'reauth_required', normalized.message)
        }
        throw normalized
      })
    log({ level: 'info', msg: `Tool called - ${serverName}:${methodName}` })
    if (this.resolveServerSource(server) === 'external' && (server.authMode ?? 'none') === 'oauth2') {
      await this.userServerInstalls.setAuthState(serverName, username, 'connected')
    }
    if (Array.isArray(toolResponse.content)) {
      toolResponse.content = toolResponse.content.map(item => {
        return item
      })
    }
    return toolResponse
  }

  public async installUserServer(
    input: Omit<InstallUserServerInput, 'authMode'>
  ): Promise<UserVisibleMcpServer> {
    const server = await this.getServer(input.serverName)
    if (!server) {
      throw new McpServerNotFoundError(input.serverName)
    }
    if (this.resolveServerSource(server) !== 'external') {
      throw new McpValidationError(`Server ${input.serverName} is not an external server`)
    }

    if (
      server.authMode === 'oauth2' &&
      (server.oauthTemplate?.registrationMode === 'cimd' || server.oauthTemplate?.registrationMode === 'dcr') &&
      server.oauthTemplate?.manualClientCredentialsAllowed !== true &&
      (input.oauthClientId || input.oauthClientSecret)
    ) {
      throw new McpValidationError(
        `Server ${input.serverName} uses automatic client registration and does not accept manual client credential overrides`
      )
    }

    const install = await this.userServerInstalls.upsertInstall({
      ...input,
      authMode: server.authMode ?? 'none'
    })
    return this.toUserVisibleServer(
      server,
      install,
      await this.secretsService.listSecretNamesByServerPrefix(input.serverName, input.username)
    )
  }

  public async updateUserServerInstall(
    input: Omit<UpdateUserServerInstallInput, 'authMode'>
  ): Promise<UserVisibleMcpServer> {
    const server = await this.getServer(input.serverName)
    if (!server) {
      throw new McpServerNotFoundError(input.serverName)
    }
    if (this.resolveServerSource(server) !== 'external') {
      throw new McpValidationError(`Server ${input.serverName} is not an external server`)
    }

    const existing = await this.userServerInstalls.getInstall(input.serverName, input.username)
    if (!existing) {
      throw new McpValidationError(`Server ${input.serverName} is not installed for user ${input.username}`)
    }

    if (
      server.authMode === 'oauth2' &&
      (server.oauthTemplate?.registrationMode === 'cimd' || server.oauthTemplate?.registrationMode === 'dcr') &&
      server.oauthTemplate?.manualClientCredentialsAllowed !== true &&
      (input.oauthClientId || input.oauthClientSecret)
    ) {
      throw new McpValidationError(
        `Server ${input.serverName} uses automatic client registration and does not accept manual client credential overrides`
      )
    }

    const oauthConfigChanged =
      input.oauthClientId !== existing.oauthClientId ||
      input.oauthClientSecret !== existing.oauthClientSecret ||
      JSON.stringify(input.oauthScopes ?? []) !== JSON.stringify(existing.oauthScopes ?? [])

    const install = await this.userServerInstalls.upsertInstall({
      ...input,
      authMode: server.authMode ?? 'none'
    })
    if (oauthConfigChanged) {
      if (this.oauthTokensService) {
        await this.oauthTokensService.deleteTokenRecord(input.serverName, input.username)
      }
      if (this.userSessionsService) {
        await this.userSessionsService.deleteSession(input.serverName, input.username)
      }
      const userKey = buildUserServerKey(input.username, input.serverName)
      if (this.userConnections[userKey]) {
        await this.teardownUserConnection(userKey, 'oauth_updated')
      }
      await this.userServerInstalls.setAuthState(input.serverName, input.username, 'not_connected')
      return this.toUserVisibleServer(server, {
        ...install,
        authState: 'not_connected',
        lastAuthError: undefined
      }, await this.secretsService.listSecretNamesByServerPrefix(input.serverName, input.username))
    }

    return this.toUserVisibleServer(
      server,
      install,
      await this.secretsService.listSecretNamesByServerPrefix(input.serverName, input.username)
    )
  }

  public async uninstallUserServer(serverName: string, username: string): Promise<void> {
    await this.userServerInstalls.deleteInstall(serverName, username)
    if (this.oauthTokensService) {
      await this.oauthTokensService.deleteTokenRecord(serverName, username)
    }
    if (this.userSessionsService) {
      await this.userSessionsService.deleteSession(serverName, username)
    }
    await this.secretsService.deleteSecretsByServerPrefix(serverName, username)

    const userKey = buildUserServerKey(username, serverName)
    if (this.userConnections[userKey]) {
      await this.teardownUserConnection(userKey, 'server_deleted')
    }
  }

  public async saveUserServerSecrets(input: SaveUserServerSecretsInput): Promise<void> {
    const server = await this.getServer(input.serverName)
    if (!server) {
      throw new McpServerNotFoundError(input.serverName)
    }
    if (this.resolveServerSource(server) === 'external') {
      const install = await this.userServerInstalls.getInstall(input.serverName, input.username)
      if (!install) {
        throw new McpValidationError(`Server ${input.serverName} is not installed for user ${input.username}`)
      }
    }

    const allowedSecretNames = new Set([
      ...(server.secretFields ?? []).map((field) => field.name),
      ...(server.secretNames ?? []),
      ...(server.secretName ? [server.secretName] : [])
    ])
    for (const secret of input.secrets) {
      if (!allowedSecretNames.has(secret.name)) {
        throw new McpValidationError(`Secret ${secret.name} is not declared for server ${input.serverName}`)
      }
      if (!secret.value || secret.value.trim() === '') {
        throw new McpValidationError(`Secret ${secret.name} must be a non-empty string`)
      }
    }

    await this.secretsService.saveUserServerSecrets(input)
  }

  public async refreshUserServer(serverName: string, username: string): Promise<UserVisibleMcpServer> {
    const server = await this.getServer(serverName)
    if (!server) {
      throw new McpServerNotFoundError(serverName)
    }
    if (this.resolveServerSource(server) !== 'external') {
      return this.toUserVisibleServer(
        server,
        undefined,
        await this.secretsService.listSecretNamesByServerPrefix(serverName, username)
      )
    }
    if (server.transportType !== 'streamable_http') {
      return this.toUserVisibleServer(
        server,
        await this.userServerInstalls.getInstall(serverName, username),
        await this.secretsService.listSecretNamesByServerPrefix(serverName, username)
      )
    }

    const install = await this.userServerInstalls.getInstall(serverName, username)
    if (!install || install.enabled !== true) {
      throw new McpValidationError(`Server ${serverName} is not installed for user ${username}`)
    }

    await validateExternalMcpUrl(server.url)

    try {
      const userConn = await this.connectUserToServer(username, server)
      const tools = await userConn.client.request({ method: 'tools/list' }, ListToolsResultSchema, {
        timeout: server.startupTimeout || 180000,
        maxTotalTimeout: 300000
      })

      const serverKey = buildServerKey(server)
      if (this.servers[serverKey]) {
        this.servers[serverKey].toolsList = tools.tools
      }
      await this.mcpDBClient.update({ toolsList: tools.tools, updatedAt: new Date() }, { name: serverName })

      if ((server.authMode ?? 'none') === 'oauth2') {
        await this.userServerInstalls.setAuthState(serverName, username, 'connected')
      }

      return this.toUserVisibleServer(
        {
          ...server,
          toolsList: tools.tools
        },
        {
          ...install,
          authState: (server.authMode ?? 'none') === 'oauth2' ? 'connected' : install.authState,
          lastAuthError: undefined
        },
        await this.secretsService.listSecretNamesByServerPrefix(serverName, username)
      )
    } catch (error) {
      const normalized = normalizeExternalAuthError(error, username, serverName)
      if (normalized instanceof McpReauthRequiredError) {
        await this.userServerInstalls.setAuthState(serverName, username, 'reauth_required', normalized.message)
      }
      throw normalized
    }
  }

  public async setSecret(username: string, secretName: string, secretValue: string) {
    await this.secretsService.updateSecret({ username, secretName, secretValue, action: 'update' })
  }

  public async deleteSecret(username: string, secretName: string) {
    await this.secretsService.updateSecret({ username, secretName, secretValue: '', action: 'delete' })
  }

  public async getSharedServerDeleteImpact(name: string): Promise<SharedServerDeleteImpact> {
    const server = await this.getServer(name)
    if (!server) {
      throw new McpServerNotFoundError(name)
    }

    const installs = this.resolveServerSource(server) === 'external'
      ? await this.userServerInstalls.listInstallsForServer(name)
      : []
    const tokenRecords = this.oauthTokensService
      ? await this.oauthTokensService.listTokenRecordsForServer(name)
      : []
    const sessions = this.userSessionsService
      ? await this.userSessionsService.listSessionsForServer(name)
      : []
    const secretUsernames = await this.secretsService.listUsernamesByServerPrefix(name)

    return {
      serverName: name,
      source: this.resolveServerSource(server),
      authMode: server.authMode ?? 'none',
      transportType: server.transportType,
      installedUsers: installs.length,
      connectedAuthUsers: installs.filter((install) => install.authState === 'connected').length,
      oauthTokenUsers: tokenRecords.length,
      usersWithSavedSecrets: secretUsernames.length,
      activeSessionUsers: sessions.filter((session) => typeof session.sessionId === 'string' && session.sessionId.length > 0).length
    }
  }

  public async addServer(serverData: AddServerInput): Promise<MCPServer> {
    const transportType: MCPTransportType = serverData.transportType ?? 'stdio'
    const source: McpServerSource = serverData.source ?? 'platform'
    const sharedSessionId = (serverData as AddServerInput & { sessionId?: unknown }).sessionId

    assertTransportConfigCompatible({
      transportType,
      command: serverData.command,
      args: serverData.args,
      env: serverData.env,
      url: serverData.url,
      headers: serverData.headers,
      sessionId: sharedSessionId,
      reconnectionOptions: serverData.reconnectionOptions
    })

    const {
      name,
      secretName,
      secretNames,
      enabled = true,
      startupTimeout,
      displayName,
      description,
      authMode,
      oauthTemplate,
      secretFields,
      homepageUrl,
      repositoryUrl,
      licenseName,
      catalogProvider,
      catalogId,
      username,
      oauthProvisioningContext
    } = serverData

    // Normalize: prefer secretNames, but handle secretName for backward compat
    let finalSecretNames = secretNames
    if (!finalSecretNames && secretName) {
      finalSecretNames = [secretName]
    }

    const extractedUrlSecrets =
      source === 'external' && transportType === 'streamable_http' && serverData.url
        ? buildExtractedExternalUrlSecretMetadata(serverData.url, secretFields)
        : undefined
    const effectiveUrl = extractedUrlSecrets?.sanitizedUrl ?? serverData.url
    const effectiveSecretFields = extractedUrlSecrets?.secretFields ?? secretFields

    const normalizedOauthTemplate =
      source === 'external' && transportType === 'streamable_http' && effectiveUrl
        ? await this.normalizeExternalOAuthTemplateForPersistence(authMode ?? 'none', effectiveUrl, oauthTemplate)
        : oauthTemplate

    if (source === 'external') {
      if (!username?.trim()) {
        throw new McpValidationError('username is required when creating external servers')
      }
      if (transportType !== 'streamable_http') {
        throw new McpValidationError('External servers must use streamable_http transport')
      }
      if (!effectiveUrl) {
        throw new McpValidationError('External servers require a url')
      }
      const knownProviderUrlError = getKnownProviderUrlError(effectiveUrl)
      if (knownProviderUrlError) {
        throw new McpValidationError(knownProviderUrlError)
      }
      await validateExternalMcpUrl(effectiveUrl)
      this.validateExternalOAuthTemplate(authMode ?? 'none', normalizedOauthTemplate, effectiveUrl)
      if (
        (normalizedOauthTemplate?.registrationMode === 'cimd' || normalizedOauthTemplate?.registrationMode === 'dcr') &&
        normalizedOauthTemplate?.manualClientCredentialsAllowed !== true &&
        serverData.oauthClientConfig
      ) {
        throw new McpValidationError('Automatically registered external servers must not store manual client credentials')
      }
      if (
        (normalizedOauthTemplate?.registrationMode === 'cimd' || normalizedOauthTemplate?.registrationMode === 'dcr') &&
        !oauthProvisioningContext
      ) {
        throw new McpValidationError('oauthProvisioningContext is required for CIMD and DCR external servers')
      }
      if ((effectiveSecretFields ?? []).length > 5) {
        throw new McpValidationError('External servers may declare at most 5 secret fields')
      }
      for (const field of effectiveSecretFields ?? []) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,49}$/.test(field.name)) {
          throw new McpValidationError(`Invalid secret field name: ${field.name}`)
        }
      }
    }

    // Prevent adding servers that conflict with built-in external names
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      throw new Error(`Cannot add server with name '${name}' as it conflicts with a built-in server.`)
    }

    // Check if server with this name already exists
    const existingServer = await this.mcpDBClient.findOne({ name })
    if (existingServer) {
      if (source === 'external' && username) {
        const normalizedExistingServer = await this.normalizeServerRecord({
          ...existingServer,
          status: existingServer.status ?? 'disconnected',
          enabled: existingServer.enabled !== false
        })
        const existingUserVisibleServer = await this.getUserServer(username, name)
        throw new McpServerAlreadyExistsError(
          name,
          existingUserVisibleServer ??
            this.toUserVisibleServer(
              normalizedExistingServer,
              await this.userServerInstalls.getInstall(name, username),
              await this.secretsService.listSecretNamesByServerPrefix(name, username)
            )
        )
      }
      throw new McpServerAlreadyExistsError(name, undefined)
    }

    if (
      source === 'external' &&
      authMode === 'oauth2' &&
      normalizedOauthTemplate?.registrationMode === 'dcr'
    ) {
      if (!this.dcrClients || !oauthProvisioningContext || !normalizedOauthTemplate.registrationEndpoint) {
        throw new McpValidationError(`DCR provisioning is not available for server ${name}`)
      }
      await this.dcrClients.getOrRegisterClient({
        issuer: normalizedOauthTemplate.authorizationServerIssuer,
        registrationEndpoint: normalizedOauthTemplate.registrationEndpoint,
        tokenEndpointAuthMethodsSupported: normalizedOauthTemplate.tokenEndpointAuthMethodsSupported,
        oauthProvisioningContext
      })
    }

    let server: MCPServer
    if (transportType === 'streamable_http') {
      if (!effectiveUrl) {
        throw new Error('Streamable HTTP servers require a url.')
      }

      if (source === 'external') {
        await validateExternalMcpUrl(effectiveUrl)
      } else {
        new URL(effectiveUrl)
      }

      server = {
        id: serverData.id,
        name,
        displayName: displayName ?? name,
        description: description ?? '',
        source,
        authMode: source === 'external' ? authMode ?? 'none' : 'none',
        oauthTemplate: normalizedOauthTemplate,
        secretFields: effectiveSecretFields ?? [],
        homepageUrl,
        repositoryUrl,
        licenseName,
        catalogProvider,
        catalogId,
        createdBy: username,
        createdAt: new Date(),
        updatedAt: new Date(),
        transportType: 'streamable_http',
        url: effectiveUrl,
        headers: serverData.headers,
        reconnectionOptions: serverData.reconnectionOptions,
        secretNames: finalSecretNames,  // Use normalized value
        secretName: undefined,          // Don't save old format for new servers
        status: 'disconnected',
        enabled,
        startupTimeout
      }
    } else {
      if (!serverData.command) {
        throw new Error('Stdio servers require a command.')
      }

      server = {
        id: serverData.id,
        name,
        displayName: displayName ?? name,
        description: description ?? '',
        source,
        authMode: 'none',
        secretFields: secretFields ?? [],
        homepageUrl,
        repositoryUrl,
        licenseName,
        catalogProvider,
        catalogId,
        createdBy: username,
        createdAt: new Date(),
        updatedAt: new Date(),
        transportType: 'stdio',
        command: serverData.command,
        args: serverData.args ?? [],
        env: serverData.env ?? {},
        secretNames: finalSecretNames,  // Use normalized value
        secretName: undefined,          // Don't save old format for new servers
        status: 'disconnected',
        enabled,
        startupTimeout
      }
    }

    await this.mcpDBClient.insert(server)

    if (source === 'external' && username) {
      await this.userServerInstalls.upsertInstall({
        serverName: name,
        username,
        enabled,
        authMode: authMode ?? 'none',
        oauthClientId: serverData.oauthClientConfig?.clientId,
        oauthClientSecret: serverData.oauthClientConfig?.clientSecret,
        oauthScopes: serverData.oauthClientConfig?.scopes
      })
      if (extractedUrlSecrets && extractedUrlSecrets.secrets.length > 0) {
        await this.secretsService.saveUserServerSecrets({
          serverName: name,
          username,
          secrets: extractedUrlSecrets.secrets
        })
      }
    }

    if (server.transportType === 'streamable_http') {
      // Streamable HTTP: register definition, connections are lazy per-user
      const serverKey = buildServerKey(server)
      this.servers[serverKey] = { ...server, status: 'disconnected', logs: [] }
      if (!this.serverKeys.includes(serverKey)) {
        this.serverKeys.push(serverKey)
      }
      log({ level: 'info', msg: `[${server.name}] Added streamable HTTP server (lazy per-user connection).` })
    } else {
      await this.connectToServer(server)
      this.fetchToolsForServer(server)
    }

    return server
  }

  public async updateServer(
    name: string,
    serverData: UpdateServerInput
  ): Promise<MCPServer | null> {
    const sharedSessionId = (serverData as UpdateServerInput & { sessionId?: unknown }).sessionId
    // Prevent updating built-in servers
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      throw new Error(`Cannot update built-in server ${name}`)
    }

    const existingRecord = await this.mcpDBClient.findOne({ name })
    if (!existingRecord) {
      throw new Error(`Server with name ${name} not found`)
    }

    const existingServer = await this.normalizeServerRecord({
      ...existingRecord,
      status: existingRecord.status ?? 'disconnected',
      enabled: existingRecord.enabled !== false
    })

    const nextTransportType: MCPTransportType = serverData.transportType ?? existingServer.transportType
    assertTransportConfigCompatible({
      transportType: nextTransportType,
      command: serverData.command,
      args: serverData.args,
      env: serverData.env,
      url: serverData.url,
      headers: serverData.headers,
      sessionId: sharedSessionId,
      reconnectionOptions: serverData.reconnectionOptions
    })

    // Normalize secrets if provided in update
    let finalSecretNames = serverData.secretNames
    if (!finalSecretNames && serverData.secretName) {
      finalSecretNames = [serverData.secretName]
    }

    // Check if enabled state is changing
    const enabledChanged = serverData.enabled !== undefined && serverData.enabled !== existingServer.enabled

    const updateKeys = Object.keys(serverData).filter(
      key => (serverData as Record<string, unknown>)[key] !== undefined
    )

    // If only the enabled state is changing, use the enable/disable methods
    if (enabledChanged && updateKeys.length === 1) {
      if (serverData.enabled) {
        return this.enableServer(name)
      } else {
        return this.disableServer(name)
      }
    }

    const baseServer: Omit<MCPServerBase, 'status'> & { status: MCPServerBase['status'] } = {
      id: existingServer.id,
      name,
      displayName: serverData.displayName ?? existingServer.displayName,
      description: serverData.description ?? existingServer.description,
      source: serverData.source ?? existingServer.source,
      authMode: serverData.authMode ?? existingServer.authMode,
      oauthTemplate: serverData.oauthTemplate ?? existingServer.oauthTemplate,
      secretFields: serverData.secretFields ?? existingServer.secretFields,
      homepageUrl: serverData.homepageUrl ?? existingServer.homepageUrl,
      repositoryUrl: serverData.repositoryUrl ?? existingServer.repositoryUrl,
      licenseName: serverData.licenseName ?? existingServer.licenseName,
      catalogProvider: serverData.catalogProvider ?? existingServer.catalogProvider,
      catalogId: serverData.catalogId ?? existingServer.catalogId,
      createdBy: existingServer.createdBy,
      createdAt: existingServer.createdAt,
      updatedAt: new Date(),
      secretNames: finalSecretNames ?? existingServer.secretNames,
      secretName: undefined, // Remove old format when updating
      status: existingServer.status,
      enabled: serverData.enabled ?? existingServer.enabled,
      startupTimeout: serverData.startupTimeout ?? existingServer.startupTimeout,
      logs: existingServer.logs,
      connection: existingServer.connection,
      toolsList: existingServer.toolsList,
      eventHandlers: existingServer.eventHandlers
    }

    const extractedUpdatedUrlSecrets =
      (baseServer.source ?? 'platform') === 'external' && nextTransportType === 'streamable_http' && (serverData.url ?? (existingServer.transportType === 'streamable_http' ? existingServer.url : undefined))
        ? buildExtractedExternalUrlSecretMetadata(
            serverData.url ?? (existingServer.transportType === 'streamable_http' ? existingServer.url : ''),
            serverData.secretFields ?? existingServer.secretFields
          )
        : undefined

    let updatedServer: MCPServer
    if (nextTransportType === 'streamable_http') {
      const url =
        extractedUpdatedUrlSecrets?.sanitizedUrl ??
        serverData.url ??
        (existingServer.transportType === 'streamable_http' ? existingServer.url : undefined)
      if (!url) {
        throw new Error('Streamable HTTP servers require a url.')
      }
      if ((baseServer.source ?? 'platform') === 'external') {
        const knownProviderUrlError = getKnownProviderUrlError(url)
        if (knownProviderUrlError) {
          throw new McpValidationError(knownProviderUrlError)
        }
        await validateExternalMcpUrl(url)
      } else {
        new URL(url)
      }

      updatedServer = {
        ...baseServer,
        transportType: 'streamable_http',
        url,
        secretFields: extractedUpdatedUrlSecrets?.secretFields ?? baseServer.secretFields,
        headers:
          serverData.headers ??
          (existingServer.transportType === 'streamable_http' ? existingServer.headers : undefined),
        reconnectionOptions:
          serverData.reconnectionOptions ??
          (existingServer.transportType === 'streamable_http' ? existingServer.reconnectionOptions : undefined)
      }
    } else {
      const command =
        serverData.command ?? (existingServer.transportType === 'stdio' ? existingServer.command : undefined)
      if (!command) {
        throw new Error('Stdio servers require a command.')
      }

      updatedServer = {
        ...baseServer,
        transportType: 'stdio',
        command,
        args: serverData.args ?? (existingServer.transportType === 'stdio' ? existingServer.args : []),
        env: serverData.env ?? (existingServer.transportType === 'stdio' ? existingServer.env : {})
      }
    }

    if ((updatedServer.source ?? 'platform') === 'external' && updatedServer.transportType === 'streamable_http') {
      await validateExternalMcpUrl(updatedServer.url)
      const normalizedOauthTemplate = await this.normalizeExternalOAuthTemplateForPersistence(
        updatedServer.authMode ?? 'none',
        updatedServer.url,
        updatedServer.oauthTemplate
      )
      this.validateExternalOAuthTemplate(updatedServer.authMode ?? 'none', normalizedOauthTemplate, updatedServer.url)
      updatedServer = {
        ...updatedServer,
        oauthTemplate: normalizedOauthTemplate
      }
    }

    const resourceUriChanged =
      (existingServer.source ?? 'platform') === 'external' &&
      (existingServer.authMode ?? 'none') === 'oauth2' &&
      updatedServer.transportType === 'streamable_http' &&
      updatedServer.oauthTemplate?.resourceUri !== existingServer.oauthTemplate?.resourceUri

    await this.mcpDBClient.update(updatedServer, { name })

    // Stop existing connections and restart
    const serverKey = buildServerKey(existingServer)
    const sanitizedName = sanitizeString(name)

    // Tear down all user connections for this server
    for (const userKey of Object.keys(this.userConnections) as UserServerKey[]) {
      if (userKey.endsWith(`:${sanitizedName}`)) {
        try {
          await this.teardownUserConnection(userKey, 'server_updated')
        } catch (error) {
          log({ level: 'error', msg: `Error stopping user connection ${userKey}: ${error}` })
        }
      }
    }

    // Tear down shared connection
    if (this.servers[serverKey]) {
      try {
        await this.teardownServerConnection(serverKey)
        delete this.servers[serverKey]
      } catch (error) {
        log({ level: 'error', msg: `Error stopping server ${name}: ${error}` })
      }
    }

    if (updatedServer.transportType === 'streamable_http') {
      // Streamable HTTP: register definition, connections are lazy per-user
      this.servers[serverKey] = { ...updatedServer, status: 'disconnected', logs: [] }
      if (!this.serverKeys.includes(serverKey)) {
        this.serverKeys.push(serverKey)
      }
    } else {
      // Stdio: eagerly connect shared connection
      await this.connectToServer(updatedServer)
      this.fetchToolsForServer(updatedServer)
    }

    if (resourceUriChanged) {
      await this.invalidateExternalOAuthRuntimeState(name)
    }

    return updatedServer
  }

  public async updateServerOAuthTokens(
    name: string,
    username: string,
    input: Omit<McpOAuthTokenInput, 'serverName' | 'username'>
  ): Promise<MCPServer> {
    if (!this.oauthTokensService) {
      throw new Error('OAuth token storage is not configured')
    }
    if (!input.accessToken || !input.clientId || !input.redirectUri) {
      throw new McpValidationError('Missing required OAuth fields: accessToken, clientId, redirectUri')
    }

    const server = await this.getServer(name)
    if (!server) {
      throw new Error(`Server ${name} not found`)
    }
    if (server.transportType !== 'streamable_http') {
      throw new Error(`Server ${name} is not a streamable HTTP server`)
    }

    const tokenType = input.tokenType || 'Bearer'
    await this.oauthTokensService.upsertTokenRecord({
      ...input,
      tokenType,
      serverName: name,
      username
    })

    // Tear down existing user connection so it reconnects with new tokens
    const userKey = buildUserServerKey(username, server.name)
    if (this.userConnections[userKey]) {
      try {
        await this.teardownUserConnection(userKey, 'oauth_updated')
      } catch (error) {
        log({
          level: 'warn',
          msg: `[${username}:${name}] Failed to teardown user connection during OAuth update: ${(error as Error).message}`
        })
      }
    }

    // Strip Authorization headers from shared server config if present
    const sanitizedHeaders = server.headers ? stripAuthorizationHeaders(server.headers) ?? {} : undefined
    if (sanitizedHeaders) {
      await this.mcpDBClient.update({ headers: sanitizedHeaders }, { name })
      const serverKey = buildServerKey(server)
      if (this.servers[serverKey] && this.servers[serverKey].transportType === 'streamable_http') {
        ;(this.servers[serverKey] as MCPServerBase & StreamableHttpServerConfig).headers = sanitizedHeaders
      }
    }

    await this.userServerInstalls.setAuthState(name, username, 'connected')

    return server
  }

  public async deleteServer(name: string): Promise<void> {
    // Prevent deleting built-in servers
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      throw new Error(`Cannot delete built-in server ${name}`)
    }

    const existingRecord = await this.mcpDBClient.findOne({ name })
    if (!existingRecord) {
      throw new Error(`Server with name ${name} not found`)
    }

    const existingServer = await this.normalizeServerRecord({
      ...existingRecord,
      status: existingRecord.status ?? 'disconnected',
      enabled: existingRecord.enabled !== false
    })

    const serverKey = buildServerKey(existingServer)
    const sanitizedName = sanitizeString(name)

    // Tear down all user connections for this server
    for (const userKey of Object.keys(this.userConnections) as UserServerKey[]) {
      if (userKey.endsWith(`:${sanitizedName}`)) {
        try {
          await this.teardownUserConnection(userKey, 'server_deleted')
        } catch (error) {
          log({ level: 'error', msg: `Error stopping user connection ${userKey}: ${error}` })
        }
      }
    }

    // Stop the shared server connection if running
    if (this.servers[serverKey]) {
      try {
        await this.teardownServerConnection(serverKey)
        delete this.servers[serverKey]
      } catch (error) {
        log({ level: 'error', msg: `Error stopping server ${name}: ${error}` })
      }
    }

    const installs = await this.userServerInstalls.listInstallsForServer(name)

    await this.mcpDBClient.delete({ name }, false)
    await this.userServerInstalls.deleteInstallsByServer(name)
    if (this.oauthTokensService) {
      await this.oauthTokensService.deleteTokensByServer(name)
    }
    if (this.userSessionsService) {
      await this.userSessionsService.deleteSessionsByServer(name)
    }
    for (const install of installs) {
      await this.secretsService.deleteSecretsByServerPrefix(name, install.username)
    }
  }

  public async getServer(name: string): Promise<MCPServer | null> {
    // Check built-in servers first by external name
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      const builtInServer = builtInRegistry.getByExternalName(name)
      if (builtInServer) {
        return this.builtInToMCPServer(builtInServer)
      }
    }

    const record = await this.mcpDBClient.findOne({ name })
    if (!record) {
      return null
    }

    return this.normalizeServerRecord({
      ...record,
      status: record.status ?? 'disconnected',
      enabled: record.enabled !== false
    })
  }

  public async enableServer(name: string): Promise<MCPServer | null> {
    // Built-in servers are always enabled
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      return this.getServer(name)
    }

    const record = await this.mcpDBClient.findOne({ name })
    if (!record) {
      throw new Error(`Server ${name} not found`)
    }
    const server = await this.normalizeServerRecord({
      ...record,
      status: record.status ?? 'disconnected',
      enabled: record.enabled !== false
    })
    const updatedServer: MCPServer = { ...server, enabled: true }
    await this.mcpDBClient.update(updatedServer, { name })

    const serverKey = buildServerKey(updatedServer)

    // Update the enabled status in the in-memory server object
    if (this.servers[serverKey]) {
      this.servers[serverKey].enabled = true
    }

    if (updatedServer.transportType === 'streamable_http') {
      // Streamable HTTP: just mark as enabled, connections are lazy per-user
      if (!this.servers[serverKey]) {
        this.servers[serverKey] = { ...updatedServer, status: 'disconnected', logs: [] }
        if (!this.serverKeys.includes(serverKey)) {
          this.serverKeys.push(serverKey)
        }
      }
      log({ level: 'info', msg: `[${name}] Enabled streamable HTTP server (lazy per-user connection).` })
    } else if (
      !this.servers[serverKey] ||
      this.servers[serverKey].status === 'disconnected' ||
      this.servers[serverKey].status === 'error'
    ) {
      await this.connectToServer(updatedServer)
      this.fetchToolsForServer(updatedServer)
    }

    return updatedServer
  }

  public async disableServer(name: string): Promise<MCPServer | null> {
    // Cannot disable built-in servers
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    if (builtInRegistry.isBuiltInByExternalName(name)) {
      throw new Error(`Cannot disable built-in server ${name}`)
    }

    const record = await this.mcpDBClient.findOne({ name })
    if (!record) {
      throw new Error(`Server ${name} not found`)
    }
    const server = await this.normalizeServerRecord({
      ...record,
      status: record.status ?? 'disconnected',
      enabled: record.enabled !== false
    })
    const updatedServer: MCPServer = { ...server, enabled: false }
    await this.mcpDBClient.update(updatedServer, { name })

    const serverKey = buildServerKey(updatedServer)
    const sanitizedName = sanitizeString(name)

    // Update the enabled status in the in-memory server object
    if (this.servers[serverKey]) {
      this.servers[serverKey].enabled = false
    }

    // Tear down all user connections for this server
    for (const userKey of Object.keys(this.userConnections) as UserServerKey[]) {
      if (userKey.endsWith(`:${sanitizedName}`)) {
        try {
          await this.teardownUserConnection(userKey, 'server_disabled')
          log({ level: 'info', msg: `User connection ${userKey} stopped due to server disable` })
        } catch (error) {
          log({ level: 'error', msg: `Error stopping user connection ${userKey}: ${error}` })
        }
      }
    }

    // Tear down shared connection (stdio servers)
    if (this.servers[serverKey] && this.servers[serverKey].status !== 'disconnected') {
      try {
        await this.teardownServerConnection(serverKey)
        this.servers[serverKey].status = 'disconnected'
        log({ level: 'info', msg: `Server ${name} stopped due to being disabled` })
      } catch (error) {
        log({ level: 'error', msg: `Error stopping server ${name}: ${error}` })
      }
    }

    return updatedServer
  }

  public async stop() {
    log({ level: 'info', msg: 'Stopping MCP servers' })

    // Stop built-in servers
    const builtInRegistry = BuiltInServerRegistry.getInstance()
    await builtInRegistry.stopAll()

    // Tear down all per-user connections
    for (const userKey of Object.keys(this.userConnections) as UserServerKey[]) {
      try {
        await this.teardownUserConnection(userKey, 'shutdown')
        log({ level: 'info', msg: `User connection ${userKey} stopped` })
      } catch (error) {
        log({ level: 'error', msg: `${userKey} error stopping user connection: ${error}` })
      }
    }

    // Tear down shared (stdio) server connections
    for (const serverKey in this.servers) {
      const serverStatus = this.servers[serverKey].status
      if (serverStatus != 'disconnected') {
        try {
          await this.teardownServerConnection(serverKey)
          this.servers[serverKey].status = 'disconnected'
          log({ level: 'info', msg: `${this.servers[serverKey].name} stopped` })
        } catch (error) {
          log({ level: 'error', msg: `${serverKey} error stopping: ${error}` })
        }
      }
    }
    await this.mcpDBClient.disconnect()
    if (this.oauthTokensService) {
      await this.oauthTokensService.stop()
    }
    if (this.userSessionsService) {
      await this.userSessionsService.stop()
    }
    if (this.dcrClients) {
      await this.dcrClients.stop()
    }
    await this.userServerInstalls.stop()
  }
}
