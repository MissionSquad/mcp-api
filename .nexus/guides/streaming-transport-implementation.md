# Streamable HTTP Transport Implementation Guide (mcp-api)

## Scope
This guide defines the exact changes required to add Streamable HTTP transport support to the `mcp-api` Express service while preserving existing stdio behavior. It uses only verified sources from this repository and the installed MCP SDK package.
Backward compatibility is mandatory: stdio remains the default transport for existing servers and for installs unless explicitly overridden, and all existing API contracts must continue to work.

## Verified Inputs
- MCP transport specification: `mcp-api/mcp-spec/base-protocol/transports.md` (Streamable HTTP requirements).
- MCP lifecycle specification: `mcp-api/mcp-spec/base-protocol/lifecycle.md` (initialize flow and protocol version header).
- MCP authorization specification: `mcp-api/mcp-spec/base-protocol/authorization.md` (HTTP auth expectations).
- Current MCP API entrypoint: `mcp-api/src/index.ts`.
- MCP controller: `mcp-api/src/controllers/mcp.ts`.
- MCP service: `mcp-api/src/services/mcp.ts`.
- MCP SDK type: `StreamableHTTPClientTransport` in `mcp-api/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.d.ts`.
- MCP SDK implementation: `StreamableHTTPClientTransport` in `mcp-api/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js`.
- MCP SDK interface: `Transport` in `mcp-api/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/transport.d.ts`.
- MCP SDK behavior: `Client.connect` in `mcp-api/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`.
- MCP SDK optional fallback: `SSEClientTransport` in `mcp-api/node_modules/@modelcontextprotocol/sdk/dist/esm/client/sse.d.ts`.

## Current Behavior (stdio only)
- `MCPService` creates a `Client` and `StdioClientTransport` per server.
- Server configuration is stdio-specific: `command`, `args`, `env`.
- Connection management assumes a subprocess and uses `stderr` for logs.
- `MCPConnection.transport` is typed as `StdioClientTransport`.

## Streamable HTTP Requirements (Client-Side)
From `transports.md` and `lifecycle.md`, the client must support:
- HTTP POST for every JSON-RPC message, with `Accept: application/json, text/event-stream`.
- HTTP GET to open optional SSE streams, with `Accept: text/event-stream`.
- Session ID header handling (`MCP-Session-Id`) when provided by the server.
- Protocol version header (`MCP-Protocol-Version`) on subsequent requests after initialization.
- Response handling for either JSON or SSE streams for requests.

## Verified SDK Capabilities You Must Use
### StreamableHTTPClientTransport (exact signature)
File: `mcp-api/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.d.ts`
- Constructor: `new StreamableHTTPClientTransport(url: URL, opts?: StreamableHTTPClientTransportOptions)`
- Methods: `start(): Promise<void>`, `send(message, options?): Promise<void>`, `close(): Promise<void>`, `finishAuth(authorizationCode: string): Promise<void>`, `terminateSession(): Promise<void>`, `setProtocolVersion(version: string): void`.
- Properties: `sessionId?: string`, `protocolVersion?: string`.

### StreamableHTTPClientTransportOptions (exact fields)
- `authProvider?: OAuthClientProvider`
- `requestInit?: RequestInit`
- `reconnectionOptions?: StreamableHTTPReconnectionOptions`
- `sessionId?: string`

### Client.connect behavior
File: `mcp-api/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`
- `Client.connect(transport: Transport, options?: RequestOptions): Promise<void>`.
- Connect calls `transport.start()`.
- After initialization, it calls `transport.setProtocolVersion(result.protocolVersion)` if available.

## Design Overview
Add a transport-aware server configuration and connection factory so a server can be either:
- `stdio` (existing behavior), or
- `streamable_http` (new behavior) using `StreamableHTTPClientTransport`.

This requires changes to:
- Data model (`MCPServer`, `MCPConnection`).
- Controller request payloads and OpenAPI schema.
- Connection lifecycle in `MCPService`.
- Package install flows to explicitly set or override transport type while defaulting to `stdio`.

## Data Model Changes (Required)
Introduce a transport discriminant and a dedicated HTTP config object. Use a discriminated union to prevent invalid combinations.

Suggested TypeScript shape:

```ts
// mcp-api/src/services/mcp.ts
export type MCPTransportType = 'stdio' | 'streamable_http'

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
  sessionId?: string
  reconnectionOptions?: StreamableHTTPReconnectionOptions
}

export type MCPServer = {
  name: string
  secretNames?: string[]
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  enabled: boolean
  startupTimeout?: number
  logs?: string[]
  connection?: MCPConnection
  toolsList?: ToolsList
  eventHandlers?: { /* unchanged */ }
} & (StdioServerConfig | StreamableHttpServerConfig)
```

Key points:
- `transportType` is required for all non-built-in servers.
- `command`, `args`, `env` are only valid for `stdio`.
- `url` and HTTP options are only valid for `streamable_http`.

## API Contract Changes (Required)
Update controller request types and OpenAPI to accept Streamable HTTP configuration.

Required changes:
- `AddServerRequest` and `UpdateServerRequest` in `mcp-api/src/controllers/mcp.ts`.
- `openapi-mcp.json` schema definitions.
- `InstallPackageRequest` in `mcp-api/src/services/packages.ts` and `mcp-api/src/controllers/packages.ts` to allow transport selection at install time.

Recommended request payload shape:

```json
{
  "name": "remote-http-server",
  "transportType": "streamable_http",
  "url": "https://example.com/mcp",
  "headers": {
    "Authorization": "Bearer <token>"
  },
  "enabled": true
}
```

Backward compatibility rules:
- If `transportType` is omitted, treat as `stdio`.
- Existing payloads that only include `command`, `args`, `env` must continue to work without modification.

## Connection Factory (Required)
Create a transport factory and a stable server key builder so all lifecycle operations use the same key regardless of transport.

Example signatures:

```ts
function buildServerKey(server: MCPServer): string
function createTransport(server: MCPServer): Transport
```

Implementation requirements:
- For `stdio`, use `StdioClientTransport` exactly as today.
- For `streamable_http`, use `StreamableHTTPClientTransport` with a `URL` instance and options derived from server config.

Verified instantiation for Streamable HTTP:

```ts
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const transport = new StreamableHTTPClientTransport(new URL(server.url), {
  requestInit: server.headers ? { headers: server.headers } : undefined,
  sessionId: server.sessionId,
  reconnectionOptions: server.reconnectionOptions
})
```

## Connection Lifecycle Updates (Required)
### Start
- Use `await client.connect(transport)` for both transports.
- Do not call `transport.start()` manually for Streamable HTTP.
- For stdio, you can attach `stderr` listeners before calling `client.connect` because `StdioClientTransport.stderr` is available immediately when `stderr: 'pipe'` is used.

### Stop
- For stdio, keep current `transport.close()` and `client.close()` behavior.
- For streamable HTTP, call `transport.close()` and optionally `terminateSession()` if you want explicit session termination.

Safely detect Streamable HTTP transport before calling `terminateSession`:

```ts
if ('terminateSession' in transport && typeof transport.terminateSession === 'function') {
  await transport.terminateSession()
}
```

### Error Handling
- Maintain `transport.onerror` and `transport.onclose` handling to update server status.
- For HTTP failures, do not attempt package installation. That logic is stdio-only.

## Session Management (Required)
Streamable HTTP sessions are managed via the `MCP-Session-Id` header.
- `StreamableHTTPClientTransport` automatically stores `sessionId` from the server response header and includes it in subsequent requests.
- The SDK does not special-case HTTP 404 for expired sessions. The spec requires the client to start a new session if a request with `MCP-Session-Id` returns 404.

Required decision:
- Decide whether to implement explicit 404 handling by wrapping transport errors, clearing the stored session ID, and reconnecting.

If you implement 404 recovery, keep it transport-specific and do not apply it to stdio.

## Session ID Persistence (Required)
Persist `sessionId` so process restarts can resume existing sessions where supported.

Implementation requirements:
1. After `client.connect()` succeeds for `streamable_http`, read `transport.sessionId`.
2. If it differs from `server.sessionId`, update the in-memory server record and persist it to the `mcp` collection (`mcpDBClient.update`).
3. On subsequent startups, pass the stored `sessionId` into `StreamableHTTPClientTransport` via options so the server can resume the session.
4. If a request fails with HTTP 404 due to an invalid session, clear the stored `sessionId` in memory and DB and retry connection once without a session ID.

## Request Flow and Tool Calls (No behavior change required)
- `MCPService.callTool` and `fetchToolsForServer` use `Client.request` and `Client.callTool`. These work for Streamable HTTP because the transport handles SSE and JSON responses.
- Keep request timeouts via `RequestOptions`. Consider enabling `resetTimeoutOnProgress` for long-running tools that emit progress notifications.

## Authentication Options (Decision Required)
Streamable HTTP supports OAuth via `OAuthClientProvider`, but this is not currently implemented in `mcp-api`. You must choose one of these paths:

Option A: Static token via headers (minimal scope)
- Store token in `Secrets` and map it into `headers.Authorization` when building the transport.
- No OAuth flows required.

Option B: OAuth 2.1 via SDK `OAuthClientProvider` (full spec support)
- Implement `OAuthClientProvider` (see `mcp-api/node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.d.ts`).
- Store tokens and client metadata in the `Secrets` service or a new persistence layer.
- Use `StreamableHTTPClientTransport.finishAuth` after redirect-based auth.

## OAuth Decision and Flow (Implemented)
We will integrate OAuth using MissionSquad's existing webhook callback flow and persist OAuth tokens + client metadata in `mcp-api`, then use `OAuthClientProvider` to automatically refresh access tokens. This keeps authentication stable for scheduled tasks without manual re-auth.

### Preconditions
1. The MCP server is already registered in `mcp-api` with `transportType: "streamable_http"` and a valid `url`.
2. The OAuth authorization flow is initiated by a client or UI layer that discovers the authorization server per `authorization.md`, generates `state` and PKCE `code_verifier`, and builds the authorization URL with `resource` and `redirect_uri` set to the MissionSquad webhook callback URL.
3. The OAuth callback webhook is created in MissionSquad with all required OAuth metadata.

### Required Webhook Configuration (MissionSquad)
Create a webhook with `type: "oauth_callback"` and `oauthConfig` fields populated:
1. `provider`: string identifier for the OAuth provider.
2. `state`: the CSRF state value generated during authorization start.
3. `codeVerifier`: PKCE code verifier generated at authorization start.
4. `redirectUri`: the MissionSquad callback URL (`/webhooks/oauth/callback/:webhookId`).
5. `scopes`: array of requested scopes (optional but recommended).
6. `mcpServerName`: the MCP server name in `mcp-api`.
7. `authorizationServer`: authorization server URL (from Protected Resource Metadata).
8. `tokenEndpoint`: token endpoint URL (from Authorization Server Metadata).
9. `clientId`: OAuth client ID used during authorization.

### Callback Handling and MCP Update (MissionSquad → mcp-api)
1. `missionsquad-api` handles the OAuth callback in `WebhookController.handleOAuthCallback`.
2. `WebhookService.exchangeOAuthCode` exchanges the authorization code for tokens (already implemented).
3. `WebhookService.storeOAuthToken` persists the encrypted tokens in MissionSquad (already implemented).
4. `WebhookService.updateMCPServerAuth` sends OAuth metadata and tokens to `mcp-api` using a dedicated endpoint (see OAuth Refresh Implementation), which stores encrypted tokens and client information for refresh.

### Token Refresh Strategy
Automatic refresh is required. `mcp-api` will use `OAuthClientProvider` and the stored `refresh_token` to renew access tokens whenever needed. If refresh fails, the server connection should surface an explicit "reauth required" error.

## OAuth Refresh Implementation (Required)
Implement OAuth refresh in `mcp-api` using `OAuthClientProvider` and a dedicated token store. Do not use `Secrets` for OAuth tokens because `callTool` injects all secrets into tool arguments.

### OAuth Token Store (mcp-api)
Add a new collection, e.g. `mcpOAuthTokens`, with encrypted fields:
1. `serverName`: MCP server identifier.
2. `tokenType`: e.g. `Bearer`.
3. `accessToken`: encrypted.
4. `refreshToken`: encrypted (optional but required for refresh).
5. `expiresAt`: Date (from `expires_in`).
6. `scopes`: string[] (optional).
7. `clientId`: OAuth client ID.
8. `clientSecret`: OAuth client secret (optional).
9. `redirectUri`: MissionSquad callback URL.
10. `createdAt`, `updatedAt`.

Encrypt access/refresh tokens and client secret using `SecretEncryptor` with `SECRETS_KEY`.

### OAuthClientProvider (mcp-api)
Implement `OAuthClientProvider` (see `mcp-api/node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.d.ts`) with:
1. `redirectUrl`: return stored `redirectUri`.
2. `clientMetadata`: include `redirect_uris: [redirectUri]`, optional `client_name`.
3. `clientInformation`: return `{ client_id, client_secret? }` from the token store.
4. `tokens`: return `{ access_token, refresh_token?, token_type, expires_in? }` from stored values.
5. `saveTokens`: update encrypted tokens + `expiresAt` in the token store.
6. `redirectToAuthorization`: throw a descriptive error instructing re-auth via MissionSquad (no UI here).
7. `saveCodeVerifier`/`codeVerifier`: persist and read PKCE verifier if you choose to support full auth in `mcp-api`, otherwise throw when called (refresh flow does not use it).

### Transport Wiring
When creating a `StreamableHTTPClientTransport`:
1. If OAuth tokens exist for the server, pass `authProvider` and omit `Authorization` from static headers (retain other headers).
2. If no OAuth tokens exist, fall back to static header authentication.

### MissionSquad → mcp-api OAuth Update
Add an internal endpoint in `mcp-api` to accept OAuth token updates:
1. `POST /mcp/servers/:name/oauth`
2. Body: `{ tokenType, accessToken, refreshToken?, expiresIn?, scopes?, clientId, clientSecret?, redirectUri, codeVerifier? }`
3. `missionsquad-api` calls this endpoint in `updateMCPServerAuth` after token exchange.

### Scheduled Task Reliability
Because `StreamableHTTPClientTransport` invokes `auth()` when it encounters 401 or needs authorization, refresh tokens will be used automatically, keeping scheduled tasks authenticated without manual intervention.

## Backwards Compatibility (Optional)
If you must support deprecated HTTP+SSE servers, use `SSEClientTransport` as a fallback. The SDK includes an example in `mcp-api/node_modules/@modelcontextprotocol/sdk/dist/esm/examples/client/streamableHttpWithSseFallbackClient.js`.

Required transport import:

```ts
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
```

## SSE Fallback (Required)
Implement client-side fallback to the deprecated HTTP+SSE transport for legacy servers, following `transports.md`:
1. Attempt Streamable HTTP by POSTing the Initialize request via `Client.connect` and `StreamableHTTPClientTransport`.
2. If the POST fails with HTTP `400`, `404`, or `405`, fall back to `SSEClientTransport` using the same server URL.
3. The SSE transport expects an `endpoint` event from the SSE stream and will use it for POST requests automatically.

Implementation details:
1. Detect fallback-eligible errors by parsing the HTTP status from the thrown error message (`Error POSTing to endpoint (HTTP <status>)`).
2. If eligible, discard the failed Streamable HTTP transport and create a fresh `Client` + `SSEClientTransport`.
3. Preserve any configured HTTP headers (e.g., `Authorization`) by passing them as `requestInit.headers` to `SSEClientTransport`.

## SSE Resumability (Required for Integration Tests)
To validate SSE reconnection, the server must emit SSE events with `id` fields so the client can send `Last-Event-ID` on reconnect. This requires an `eventStore` on `StreamableHTTPServerTransport`.

Implementation requirements:
1. Configure `StreamableHTTPServerTransport` with an in-memory `eventStore` that assigns an ID for each SSE message and can replay events after a given ID.
2. Ensure at least one SSE notification is sent after the SSE stream opens (e.g., `mcpServer.sendToolListChanged()`).
3. Only simulate a disconnect after that notification is received by the client so the client has a resumption token.
4. Verify the client reconnects by observing a second GET to the MCP endpoint.

## Migration Plan (Required)
1. Add `transportType` to all stored servers. Default to `stdio` for existing records.
2. Introduce a migration path similar to `migrateServerSecrets` to normalize transport fields.
3. Ensure `PackageService.installPackage` registers servers with `transportType: 'stdio'` unless explicitly provided.
4. Allow `transportType` to be specified during installation so HTTP servers can be installed and stored without stdio fields.

## OpenAPI Updates (Required)
Update `openapi-mcp.json`:
- Add `transportType` and `url` fields to request schemas.
- Keep `command`, `args`, `env` only for stdio.
- Add `headers`, `sessionId`, and `reconnectionOptions` for Streamable HTTP (if you expose them via API).
- Add `transportType` to package install request schemas to allow override during install.

## Package Upgrades (Required)
HTTP servers installed via `PackageService.installPackage` must be upgradeable without uninstall/reinstall. Implement upgrade support for `streamable_http` packages with the same `npm install <pkg>@version` flow used for stdio packages.

Requirements:
1. Allow `PackageService.upgradePackage` to proceed for both `stdio` and `streamable_http`.
2. For `streamable_http`, perform the npm upgrade and update `PackageInfo` version fields, but do not attempt stdio-specific command/args rewrites.
3. Preserve the existing server configuration (`url`, `headers`, `sessionId`, `reconnectionOptions`) and re-enable the server if it was enabled before the upgrade.
4. Keep upgrade logic DRY and aligned with the stdio flow, while only branching where stdio-specific command resolution is required.

## Testing Plan (Required)
### Unit Tests
- Verify transport selection by server config.
- Verify server key stability across enable/disable/update.
- Verify `streamable_http` config validation rejects stdio-only fields.

### Integration Tests
- Use a local Streamable HTTP MCP server and run:
  - `initialize` and `tools/list`.
  - `tools/call` with streaming response.
  - reconnect behavior when SSE stream is closed.

### Regression Tests
- Existing stdio servers still start, list tools, and call tools.

## Build and Test Commands (Project Baseline)
From `mcp-api/package.json`:
- Build: `npm run build`
- Tests: `npm test`

Run these after implementing the changes.

## Implementation Checklist
1. Add `transportType` and HTTP config types in `mcp-api/src/services/mcp.ts`.
2. Update `MCPConnection.transport` to `Transport` and import from `@modelcontextprotocol/sdk/shared/transport.js`.
3. Add a server key builder that works for both transports.
4. Implement transport factory for stdio and Streamable HTTP.
5. Update `connectToServer` to use the factory and `await client.connect`.
6. Update stop/disable/delete flows to handle HTTP transports (no stdio-only assumptions).
7. Update controller request types and OpenAPI schemas.
8. Add migration logic to default existing servers to `transportType: 'stdio'`.
9. Implement tests for both transport types.
10. Run `npm run build` and `npm test`.
11. Add MissionSquad OAuth callback → MCP server header update flow.
12. Add SSE fallback when Streamable HTTP initialize POST fails with 400/404/405.
13. Persist `sessionId` after successful Streamable HTTP connects and clear it on 404 session errors.
14. Implement OAuth token storage + `OAuthClientProvider` refresh flow and wire MissionSquad callback to the new OAuth update endpoint.
