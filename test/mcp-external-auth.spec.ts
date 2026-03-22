import { requireUsername } from '../src/controllers/mcp'
import {
  MCPService,
  resolveUserConnectionTeardownPolicy,
  assertTransportConfigCompatible,
  buildAuthorizationServerMetadataCandidates,
  buildMergedAuthorizationServerResult,
  buildProtectedResourceMetadataCandidates,
  buildExternalUrlWithSecretQueryParams,
  canonicalizeExternalOAuthResourceUri,
  normalizeAuthorizationServerIssuerOverride,
  parseWwwAuthenticateHeader,
  shouldFallbackToSse
} from '../src/services/mcp'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import dns from 'dns/promises'
import {
  McpServerAlreadyExistsError,
  McpReauthRequiredError,
  McpValidationError,
  toMcpErrorResponse
} from '../src/services/mcpErrors'
import { McpOAuthClientProvider, McpOAuthTokens } from '../src/services/oauthTokens'
import { resolveInitialUserInstallAuthState } from '../src/services/userServerInstalls'
import { resolvePreferredTokenEndpointAuthMethod } from '../src/services/dcrClients'

describe('external MCP request validation', () => {
  test('requireUsername trims and returns non-empty usernames', () => {
    expect(requireUsername('  alice  ', 'tool calls')).toBe('alice')
  })

  test('requireUsername rejects blank usernames', () => {
    expect(() => requireUsername('   ', 'tool calls')).toThrow(McpValidationError)
    expect(() => requireUsername(undefined, 'tool calls')).toThrow('username is required for tool calls')
  })

  test('streamable HTTP server definitions reject shared sessionId fields', () => {
    expect(() =>
      assertTransportConfigCompatible({
        transportType: 'streamable_http',
        url: 'https://example.com/mcp',
        sessionId: 'shared-session'
      })
    ).toThrow('Streamable HTTP server definitions cannot define sessionId')
  })

  test('parses RFC 9728 challenge metadata and scope hints', () => {
    expect(
      parseWwwAuthenticateHeader(
        'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read files:write"'
      )
    ).toEqual({
      resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
      challengedScopes: ['files:read', 'files:write']
    })
  })

  test('builds protected resource metadata fallback candidates in spec order', () => {
    expect(
      buildProtectedResourceMetadataCandidates(new URL('https://example.com/public/mcp'))
    ).toEqual([
      'https://example.com/.well-known/oauth-protected-resource/public/mcp',
      'https://example.com/.well-known/oauth-protected-resource'
    ])
  })

  test('builds authorization server discovery candidates in RFC 8414 / OIDC order', () => {
    expect(
      buildAuthorizationServerMetadataCandidates(new URL('https://auth.example.com/tenant1'))
    ).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/openid-configuration/tenant1',
      'https://auth.example.com/tenant1/.well-known/openid-configuration'
    ])
  })

  test('canonicalizes external OAuth resource URIs by removing query and hash', () => {
    expect(
      canonicalizeExternalOAuthResourceUri('https://example.com/public/mcp?token=123#fragment')
    ).toBe('https://example.com/public/mcp')
  })

  test('normalizes valid issuer override URLs and preserves pathful issuers', () => {
    expect(normalizeAuthorizationServerIssuerOverride('  https://auth.example.com/oauth2/default  ')).toBe(
      'https://auth.example.com/oauth2/default'
    )
  })

  test('rejects malformed issuer override values', () => {
    expect(() => normalizeAuthorizationServerIssuerOverride('auth.example.com')).toThrow(
      'authorizationServerIssuerOverride must be a valid absolute HTTPS URL'
    )
    expect(() => normalizeAuthorizationServerIssuerOverride('http://auth.example.com')).toThrow(
      'authorizationServerIssuerOverride must use https'
    )
    expect(() => normalizeAuthorizationServerIssuerOverride('https://auth.example.com?foo=bar')).toThrow(
      'authorizationServerIssuerOverride must not include a query string'
    )
    expect(() => normalizeAuthorizationServerIssuerOverride('https://user:pass@auth.example.com')).toThrow(
      'authorizationServerIssuerOverride must not include embedded credentials'
    )
    expect(() => normalizeAuthorizationServerIssuerOverride('https://auth.example.com/authorize')).toThrow(
      'authorizationServerIssuerOverride must be an issuer URL, not an authorization, token, or well-known metadata endpoint'
    )
  })

  test('applies external user secrets as query params without mutating the shared base url', () => {
    expect(
      buildExternalUrlWithSecretQueryParams('https://example.com/mcp?mode=connect', {
        token: 'abc123',
        tenant: 'demo'
      })
    ).toBe('https://example.com/mcp?mode=connect&token=abc123&tenant=demo')
  })

  test('merges optional authorization metadata capabilities without overriding primary endpoints', () => {
    expect(
      buildMergedAuthorizationServerResult({
        issuer: 'https://app.asana.com',
        scopesSupported: ['tasks:read'],
        primaryDocuments: [
          {
            url: 'https://app.asana.com/.well-known/oauth-authorization-server',
            document: {
              issuer: 'https://app.asana.com',
              authorization_endpoint: 'https://app.asana.com/-/oauth_authorize',
              token_endpoint: 'https://app.asana.com/-/oauth_token',
              code_challenge_methods_supported: ['S256'],
              token_endpoint_auth_methods_supported: ['client_secret_basic']
            }
          },
          {
            url: 'https://app.asana.com/.well-known/openid-configuration',
            document: {
              registration_endpoint: 'https://app.asana.com/late-registration',
              client_id_metadata_document_supported: false
            }
          }
        ],
        compatibilityDocuments: [
          {
            url: 'https://mcp.asana.com/.well-known/oauth-authorization-server',
            document: {
              registration_endpoint: 'https://mcp.asana.com/register',
              client_id_metadata_document_supported: true
            }
          }
        ]
      })
    ).toEqual({
      issuer: 'https://app.asana.com',
      authorizationServerMetadataUrl: 'https://app.asana.com/.well-known/oauth-authorization-server',
      authorizationEndpoint: 'https://app.asana.com/-/oauth_authorize',
      tokenEndpoint: 'https://app.asana.com/-/oauth_token',
      scopesSupported: ['tasks:read'],
      codeChallengeMethodsSupported: ['S256'],
      clientIdMetadataDocumentSupported: true,
      registrationEndpoint: 'https://app.asana.com/late-registration',
      tokenEndpointAuthMethodsSupported: ['client_secret_basic']
    })
  })

  test('prefers supported DCR token auth methods in the required order', () => {
    expect(resolvePreferredTokenEndpointAuthMethod(['client_secret_basic', 'none'])).toBe('none')
    expect(resolvePreferredTokenEndpointAuthMethod(['client_secret_post', 'client_secret_basic'])).toBe(
      'client_secret_post'
    )
    expect(resolvePreferredTokenEndpointAuthMethod(undefined)).toBe('client_secret_basic')
  })

  test('falls back to SSE when streamable HTTP fails with unexpected html content type', () => {
    expect(
      shouldFallbackToSse(new StreamableHTTPError(-1, 'Unexpected content type: text/html; charset=utf-8'))
    ).toBe(true)
  })
})

describe('external MCP error contract', () => {
  test('reauth errors serialize to a machine-readable response', () => {
    const error = new McpReauthRequiredError({
      serverName: 'remote-shopify',
      username: 'alice',
      authorizationUrl: 'https://example.com/oauth/authorize'
    })

    expect(toMcpErrorResponse(error)).toEqual({
      statusCode: 401,
      body: {
        success: false,
        error: 'OAuth re-authorization required for user alice on external MCP server remote-shopify.',
        code: 'reauth_required',
        reauthRequired: true,
        serverName: 'remote-shopify',
        username: 'alice',
        authorizationUrl: 'https://example.com/oauth/authorize'
      }
    })
  })

  test('oauth provider redirect throws a typed reauth-required error', async () => {
    const tokenStore = new McpOAuthTokens({
      mongoParams: {
        host: 'localhost:27017',
        db: 'test',
        user: 'user',
        pass: 'pass'
      }
    })

    const provider = new McpOAuthClientProvider({
      serverName: 'remote-shopify',
      username: 'alice',
      tokenStore,
      record: {
        serverName: 'remote-shopify',
        username: 'alice',
        tokenType: 'Bearer',
        accessToken: 'access',
        refreshToken: 'refresh',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://missionsquad.example/callback',
        tokenEndpointAuthMethod: 'client_secret_post',
        registrationMode: 'manual',
        createdAt: new Date('2026-03-13T00:00:00.000Z'),
        updatedAt: new Date('2026-03-13T00:00:00.000Z')
      },
      tokenEndpoint: 'https://example.com/oauth/token'
    })

    await expect(
      provider.redirectToAuthorization(new URL('https://example.com/oauth/authorize'))
    ).rejects.toMatchObject({
      code: 'reauth_required',
      statusCode: 401,
      details: {
        reauthRequired: true,
        serverName: 'remote-shopify',
        username: 'alice',
        authorizationUrl: 'https://example.com/oauth/authorize'
      }
    })
  })

  test('oauth provider refresh passes the canonical resource URI to token refresh', async () => {
    const expiredRecord = {
      serverName: 'remote-shopify',
      username: 'alice',
      tokenType: 'Bearer',
      accessToken: 'expired-access',
      refreshToken: 'refresh',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://missionsquad.example/callback',
      tokenEndpointAuthMethod: 'client_secret_post' as const,
      registrationMode: 'manual' as const,
      expiresAt: new Date(Date.now() - 60_000),
      scopes: ['files:read'],
      createdAt: new Date('2026-03-13T00:00:00.000Z'),
      updatedAt: new Date('2026-03-13T00:00:00.000Z')
    }
    const refreshedRecord = {
      ...expiredRecord,
      accessToken: 'fresh-access',
      expiresAt: new Date(Date.now() + 3_600_000),
      updatedAt: new Date('2026-03-13T01:00:00.000Z')
    }
    const tokenStore = {
      getTokenRecord: jest.fn().mockResolvedValue(expiredRecord),
      refreshTokenRecord: jest.fn().mockResolvedValue(refreshedRecord)
    } as unknown as McpOAuthTokens

    const provider = new McpOAuthClientProvider({
      serverName: 'remote-shopify',
      username: 'alice',
      tokenStore,
      record: expiredRecord,
      tokenEndpoint: 'https://example.com/oauth/token',
      resource: 'https://oauth.example.com/resource'
    })

    await provider.tokens()

    expect((tokenStore as unknown as { refreshTokenRecord: jest.Mock }).refreshTokenRecord).toHaveBeenCalledWith({
      serverName: 'remote-shopify',
      username: 'alice',
      tokenEndpoint: 'https://example.com/oauth/token',
      resource: 'https://oauth.example.com/resource'
    })
  })

  test('duplicate shared external servers serialize to the handbook 409 contract', () => {
    const existingServer = {
      name: 'remote-drive',
      displayName: 'Remote Drive',
      description: 'Shared OAuth MCP server',
      source: 'external',
      transportType: 'streamable_http',
      installed: false,
      enabled: true,
      authRequired: true,
      secretFields: [],
      canInstall: true,
      canUninstall: false,
      canConfigure: false,
      canManagePlatformServer: false
    }

    expect(toMcpErrorResponse(new McpServerAlreadyExistsError('remote-drive', existingServer))).toEqual({
      statusCode: 409,
      body: {
        success: false,
        error: 'Server remote-drive already exists',
        code: 'server_already_exists',
        serverName: 'remote-drive',
        server: existingServer
      }
    })
  })
})

describe('external MCP teardown policy', () => {
  test('shutdown preserves resumable sessions', () => {
    expect(resolveUserConnectionTeardownPolicy('shutdown')).toEqual({
      terminateSession: false,
      clearPersistedSession: false
    })
  })

  test('oauth updates clear persisted sessions without terminating the remote session', () => {
    expect(resolveUserConnectionTeardownPolicy('oauth_updated')).toEqual({
      terminateSession: false,
      clearPersistedSession: true
    })
  })

  test('server disable clears persisted sessions and terminates the remote session', () => {
    expect(resolveUserConnectionTeardownPolicy('server_disabled')).toEqual({
      terminateSession: true,
      clearPersistedSession: true
    })
  })

  test('oauth installs always start disconnected while no-auth installs remain not_required', () => {
    expect(resolveInitialUserInstallAuthState(undefined, 'oauth2')).toBe('not_connected')
    expect(resolveInitialUserInstallAuthState(undefined, 'none')).toBe('not_required')
    expect(resolveInitialUserInstallAuthState('connected', 'oauth2')).toBe('connected')
  })
})

describe('external MCP issuer-override discovery', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    jest.restoreAllMocks()
    global.fetch = originalFetch
  })

  test('discovers auth metadata from an issuer override when PRM is unavailable', async () => {
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never)

    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

      if (url === 'https://mcp.example.com/v1/mcp') {
        return new Response(
          JSON.stringify({ error: 'invalid_token' }),
          {
            status: 401,
            headers: {
              'content-type': 'application/json',
              'www-authenticate': 'Bearer scope="files:read files:write"'
            }
          }
        )
      }

      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/oauth/token',
            code_challenge_methods_supported: ['S256']
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
      }

      if (url === 'https://auth.example.com/.well-known/openid-configuration') {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.example.com',
            registration_endpoint: 'https://auth.example.com/register',
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post']
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
      }

      return new Response('Not Found', { status: 404 })
    }) as typeof global.fetch

    const service = new MCPService({
      mongoParams: { host: 'localhost:27017', db: 'test', user: 'user', pass: 'pass' },
      secretsService: {} as never,
      userServerInstalls: {} as never
    })

    const result = await service.discoverExternalAuthorization({
      url: 'https://mcp.example.com/v1/mcp',
      authorizationServerIssuerOverride: 'https://auth.example.com'
    })

    expect(result).toMatchObject({
      serverUrl: 'https://mcp.example.com/v1/mcp',
      resourceUri: 'https://mcp.example.com/v1/mcp',
      discoverySource: 'issuer_override',
      challengedScopes: ['files:read', 'files:write'],
      authorizationServers: [
        {
          issuer: 'https://auth.example.com',
          authorizationServerMetadataUrl: 'https://auth.example.com/.well-known/oauth-authorization-server',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/oauth/token',
          codeChallengeMethodsSupported: ['S256'],
          registrationEndpoint: 'https://auth.example.com/register',
          tokenEndpointAuthMethodsSupported: ['client_secret_basic']
        }
      ],
      recommendedRegistrationMode: 'dcr'
    })
  })

  test('normalizes legacy discovery-backed templates to PRM mode at runtime', () => {
    const service = new MCPService({
      mongoParams: { host: 'localhost:27017', db: 'test', user: 'user', pass: 'pass' },
      secretsService: {} as never,
      userServerInstalls: {} as never
    })

    const normalized = (service as any).normalizeExternalOAuthTemplateForRuntime({
      name: 'remote-drive',
      source: 'external',
      authMode: 'oauth2',
      transportType: 'streamable_http',
      url: 'https://mcp.example.com/v1/mcp?token=123',
      status: 'disconnected',
      enabled: true,
      oauthTemplate: {
        authorizationServerIssuer: 'https://auth.example.com',
        authorizationServerMetadataUrl: 'https://auth.example.com/.well-known/oauth-authorization-server',
        resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp',
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/oauth/token',
        codeChallengeMethodsSupported: ['S256'],
        pkceRequired: true,
        discoveryMode: 'auto',
        registrationMode: 'manual'
      }
    })

    expect(normalized).toMatchObject({
      discoverySource: 'prm',
      resourceUri: 'https://mcp.example.com/v1/mcp'
    })
  })

  test('rejects issuer-override templates that carry a PRM resource metadata url', () => {
    const service = new MCPService({
      mongoParams: { host: 'localhost:27017', db: 'test', user: 'user', pass: 'pass' },
      secretsService: {} as never,
      userServerInstalls: {} as never
    })

    expect(() =>
      (service as any).validateExternalOAuthTemplate(
        'oauth2',
        {
          authorizationServerIssuer: 'https://auth.example.com',
          authorizationServerMetadataUrl: 'https://auth.example.com/.well-known/oauth-authorization-server',
          resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp',
          resourceUri: 'https://mcp.example.com/v1/mcp',
          authorizationEndpoint: 'https://auth.example.com/authorize',
          tokenEndpoint: 'https://auth.example.com/oauth/token',
          codeChallengeMethodsSupported: ['S256'],
          pkceRequired: true,
          discoveryMode: 'auto',
          discoverySource: 'issuer_override',
          registrationMode: 'manual'
        },
        'https://mcp.example.com/v1/mcp'
      )
    ).toThrow('oauthTemplate.resourceMetadataUrl must be omitted for issuer-override discovery mode')
  })
})
