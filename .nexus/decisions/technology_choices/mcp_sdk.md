# Technology Choice: Model Context Protocol SDK

## Context
MCP API needs to communicate with MCP servers using the Model Context Protocol. This requires a reliable, type-safe way to establish connections, send requests, and handle responses according to the protocol specification.

## Decision
The `@modelcontextprotocol/sdk` package was chosen as the client library for communicating with MCP servers.

## Rationale

### Official SDK
The `@modelcontextprotocol/sdk` is the official SDK for the Model Context Protocol:

1. **Protocol Compliance** - Ensures compliance with the latest protocol specification
2. **Maintained by Protocol Authors** - Developed and maintained by the same team that created the protocol
3. **Regular Updates** - Receives updates as the protocol evolves
4. **Community Support** - Has community support and documentation

### TypeScript Support
The SDK is written in TypeScript, providing several benefits:

1. **Type Definitions** - Includes comprehensive type definitions for all protocol components
2. **Type Safety** - Enables type-safe communication with MCP servers
3. **IDE Integration** - Works well with TypeScript-aware IDEs for code completion and error checking
4. **Compatibility** - Seamless integration with the TypeScript-based MCP API codebase

```typescript
// Example of TypeScript integration in MCP API
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'

// Type-safe client initialization
const client = new Client(
  { name: 'MSQStdioClient', version: '1.0.0' },
  { capabilities: { prompts: {}, resources: {}, tools: {} } }
)

// Type-safe tool call
const toolResponse = await server.connection!.client.callTool(
  { name: methodName, arguments: args }, 
  CallToolResultSchema
)
```

### Transport Flexibility
The SDK supports multiple transport mechanisms:

1. **Stdio Transport** - Communication via standard input/output streams
2. **WebSocket Transport** - Communication via WebSockets (for future use)
3. **Custom Transports** - Ability to implement custom transport mechanisms

```typescript
// Example of Stdio transport in MCP API
const transport = new StdioClientTransport({ 
  command, 
  args, 
  env: { ...env, ...globalEnv }, 
  stderr: 'pipe' 
})
```

### Protocol Features
The SDK provides access to all Model Context Protocol features:

1. **Tool Calls** - Ability to call tools provided by MCP servers
2. **Resource Access** - Ability to access resources provided by MCP servers
3. **Server Discovery** - Ability to discover available tools and resources
4. **Error Handling** - Standardized error handling for protocol-level errors

```typescript
// Example of tool listing in MCP API
const tools = await this.servers[serverKey].connection!.client.request(
  { method: 'tools/list' }, 
  ListToolsResultSchema
)
```

## Implementation Details

### Client Initialization

The MCP API initializes MCP clients for each server:

```typescript
const client = new Client(
  { name: 'MSQStdioClient', version: '1.0.0' },
  { capabilities: { prompts: {}, resources: {}, tools: {} } }
)
const { command, args, env } = server
const transport = new StdioClientTransport({ command, args, env: { ...env, ...globalEnv }, stderr: 'pipe' })
this.servers[serverKey] = {
  ...server,
  status: 'connecting',
  errors: [],
  connection: { client, transport }
}
```

### Transport Configuration

The MCP API configures the Stdio transport with server-specific parameters:

```typescript
const transport = new StdioClientTransport({ 
  command, 
  args, 
  env: { ...env, ...globalEnv }, 
  stderr: 'pipe' 
})
```

### Event Handling

The MCP API sets up event handlers for transport events:

```typescript
const transportErrorHandler = async (error: Error) => {
  log({ level: 'error', msg: `${serverKey} transport error: ${error}` })
  if (this.servers[serverKey]) {
    this.servers[serverKey].errors?.push(error.message)
  }
}

const transportCloseHandler = async () => {
  log({ level: 'info', msg: `${serverKey} transport closed` })
  if (this.servers[serverKey]) {
    this.servers[serverKey].status = 'disconnected'
  }
}

transport.onerror = transportErrorHandler
transport.onclose = transportCloseHandler
```

### Tool Calls

The MCP API uses the SDK to call tools on MCP servers:

```typescript
public async callTool(username: string, serverName: string, methodName: string, args: Record<string, unknown>) {
  const server = Object.values(this.servers).find((server) => server.name === serverName)
  if (!server) {
    log({ level: 'error', msg: `Server ${serverName} not found` })
    return undefined
  }
  if (server.status != 'connected') {
    log({ level: 'error', msg: `Server ${serverName} not connected. Status: ${server.status}` })
    return undefined
  }
  const secrets = await this.secrets.getSecrets(username, serverName)
  if (secrets[serverName] != null) {
    args = { ...args, ...secrets[serverName] }
    log({ level: 'info', msg: `Secrets applied to tool call - ${serverName}:${methodName} - ${Object.keys(secrets).join(', ')}` })
  }
  log({ level: 'info', msg: `Calling tool - ${serverName}:${methodName}` })
  const toolResponse = await server.connection!.client.callTool({ name: methodName, arguments: args }, CallToolResultSchema)
  log({ level: 'info', msg: `Tool called - ${serverName}:${methodName}` })
  if (Array.isArray(toolResponse.content)) {
    toolResponse.content = toolResponse.content.map((item) => {
      return item
    })
  }
  return toolResponse
}
```

### Tool Discovery

The MCP API uses the SDK to discover available tools:

```typescript
const tools = await this.servers[serverKey].connection!.client.request({ method: 'tools/list' }, ListToolsResultSchema)
this.servers[serverKey].toolsList = tools.tools
```

## Alternatives Considered

### Custom Protocol Implementation
- **Pros**: Complete control over implementation details, potential for optimization
- **Cons**: Risk of protocol incompatibility, maintenance burden, development time

### HTTP-based API Wrapper
- **Pros**: Simpler implementation, familiar HTTP-based API
- **Cons**: Less efficient for local communication, potential for protocol mismatch

### Language-specific Bindings
- **Pros**: Potentially more efficient, better integration with language features
- **Cons**: Limited to specific programming languages, maintenance burden

## Considerations/Open Questions

- How to handle protocol version compatibility as the MCP specification evolves?
- Should we implement a caching layer for frequently used tool responses?
- How to handle long-running tool operations?
- Should we implement a more robust error handling and retry mechanism?

## AI Assistance Notes
- Model Used: Claude 3 Opus
- Prompt: Nexus System onboarding for MCP API project
- Date Generated: 2025-03-23

## Related Nexus Documents
- [System Overview](../architecture/system_overview.md)
- [MCP Controller Architecture](../architecture/mcp_controller.md)
- [TypeScript Technology Choice](./typescript.md)
- [HTTP API Feature](../features/http_api.md)
