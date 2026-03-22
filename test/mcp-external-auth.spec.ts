import { requireUsername } from '../src/controllers/mcp'
import {
  resolveUserConnectionTeardownPolicy,
  assertTransportConfigCompatible,
  buildAuthorizationServerMetadataCandidates,
  buildMergedAuthorizationServerResult,
  buildProtectedResourceMetadataCandidates,
  buildExternalUrlWithSecretQueryParams,
  canonicalizeExternalOAuthResourceUri,
  parseWwwAuthenticateHeader,
  shouldFallbackToSse
} from '../src/services/mcp'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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
