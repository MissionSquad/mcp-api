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
We will integrate OAuth using MissionSquad's existing webhook callback flow and store the resulting access token in the MCP server's HTTP headers. This avoids adding new SDK dependencies to `missionsquad-api` while keeping the OAuth exchange centralized in the webhook controller.

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
4. `WebhookService.updateMCPServerAuth` updates the MCP server config in `mcp-api` by fetching the current server (`GET /mcp/servers/:name`), verifying `transportType === "streamable_http"`, merging existing `headers` with `Authorization: "<token_type> <access_token>"`, and sending `PUT /mcp/servers/:name` with the merged `headers` to restart the server connection.

### Token Refresh Strategy
No automatic refresh is implemented in `mcp-api`. When tokens expire, re-run the OAuth flow and update the MCP server headers via the webhook callback. This is an explicit, manual re-auth requirement until refresh support is added.

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
