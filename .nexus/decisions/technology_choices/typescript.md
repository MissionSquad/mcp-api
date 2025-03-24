# Technology Choice: TypeScript

## Context
MCP API requires a robust, type-safe language for building a scalable HTTP API that interacts with MCP servers. The choice of programming language affects development speed, code quality, maintainability, and runtime performance.

## Decision
TypeScript was chosen as the primary programming language for the MCP API project.

## Rationale

### Type Safety
TypeScript's static typing system provides several benefits:

1. **Compile-time Error Detection** - Catches type-related errors before runtime
2. **Better IDE Support** - Enables intelligent code completion, refactoring, and navigation
3. **Self-documenting Code** - Types serve as documentation for function parameters and return values
4. **Safer Refactoring** - Type checking ensures that changes don't break existing code

```typescript
// Example of type safety in MCP API
interface ToolCallRequest {
  username?: string
  serverName: string
  methodName: string
  args: Record<string, unknown>
}

private async callTool(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = req.body as ToolCallRequest
    const { serverName, methodName, args } = body
    const username = body.username ?? 'default'
    // ...
  } catch (error) {
    // ...
  }
}
```

### JavaScript Ecosystem Compatibility
TypeScript is a superset of JavaScript, which provides:

1. **Access to npm Packages** - Can use the vast ecosystem of JavaScript libraries
2. **Gradual Adoption** - Can mix TypeScript and JavaScript code
3. **Modern JavaScript Features** - Supports the latest ECMAScript features

### Node.js Integration
TypeScript works seamlessly with Node.js:

1. **Server-side Development** - Well-suited for building HTTP APIs
2. **Async/Await Support** - Makes asynchronous code more readable and maintainable
3. **Performance** - Compiles to efficient JavaScript code that runs well on Node.js

```typescript
// Example of async/await in MCP API
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

### Strong Tooling
TypeScript has excellent tooling support:

1. **TSC Compiler** - Compiles TypeScript to JavaScript with configurable options
2. **ESLint Integration** - Works with ESLint for code quality enforcement
3. **Jest Integration** - Works well with Jest for unit testing

## Implementation Details

### Project Configuration

The project uses the following TypeScript configuration:

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "es2020",
    "module": "commonjs",
    "outDir": "./dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "**/*.spec.ts"]
}
```

### Build Process

The project uses the TypeScript compiler (tsc) for building:

```json
// package.json (scripts section)
"scripts": {
  "start": "node --experimental-require-module dist/index.js",
  "build": "rm -rf dist && tsc",
  "dev": "ts-node-dev --respawn --transpile-only src/index.ts",
  "test": "rm -rf data-test && mkdir -p data-test && jest --config jest.config.json"
}
```

### Type Definitions

The project uses several TypeScript type definitions:

1. **Custom Interfaces** - Defines interfaces for API requests, responses, and data models
2. **MongoDB Types** - Uses MongoDB type definitions for type-safe database operations
3. **Express Types** - Uses Express type definitions for type-safe HTTP handling
4. **MCP SDK Types** - Uses MCP SDK type definitions for type-safe MCP operations

```typescript
// Example of custom interfaces
export interface MCPServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  enabled: boolean;
  errors?: string[];
  connection?: MCPConnection;
  toolsList?: ToolsList;
  eventHandlers?: {
    stderrDataHandler?: (data: Buffer) => void;
    transportErrorHandler?: (error: Error) => void;
    transportCloseHandler?: () => void;
  }
}
```

## Alternatives Considered

### JavaScript
- **Pros**: No compilation step, simpler setup
- **Cons**: No static typing, less IDE support, runtime errors instead of compile-time errors

### Go
- **Pros**: Strong typing, excellent performance, built-in concurrency
- **Cons**: Less ecosystem compatibility, steeper learning curve, less flexible than TypeScript

### Python
- **Pros**: Easy to learn, extensive libraries, good for rapid development
- **Cons**: Dynamic typing, slower performance, less suitable for large codebases

## Considerations/Open Questions

- How to ensure consistent TypeScript coding standards across the project?
- Should we use more advanced TypeScript features like decorators for API endpoints?
- How to handle type definitions for external libraries that don't provide them?
- Should we consider stricter TypeScript configuration options for better type safety?

## AI Assistance Notes
- Model Used: Claude 3 Opus
- Prompt: Nexus System onboarding for MCP API project
- Date Generated: 2025-03-23

## Related Nexus Documents
- [System Overview](../architecture/system_overview.md)
- [Express.js Technology Choice](./express.md)
- [MongoDB Technology Choice](./mongodb.md)
- [Model Context Protocol SDK Technology Choice](./mcp_sdk.md)
