# Technology Choice: Express.js

## Context
MCP API requires a robust, flexible web framework for building a RESTful HTTP API that exposes MCP server functionality. The choice of web framework affects development speed, code organization, performance, and maintainability.

## Decision
Express.js was chosen as the web framework for the MCP API project.

## Rationale

### Lightweight and Flexible
Express.js provides a minimalist approach to web application development:

1. **Unopinionated** - Doesn't enforce a specific project structure or coding style
2. **Modular** - Allows picking and choosing only the middleware needed
3. **Low Overhead** - Minimal performance impact compared to raw Node.js HTTP
4. **Customizable** - Easy to extend with custom middleware and routes

```typescript
// Example of Express.js setup in MCP API
export class API {
  private app: Express = express()
  private resources: Resource[] = []

  constructor() {
    this.app.use(bodyParser.json({ limit: env.PAYLOAD_LIMIT }))
    this.app.use(bodyParser.urlencoded({ extended: false, limit: env.PAYLOAD_LIMIT }))
    log({ level: 'info', msg: `Payload limit is: ${env.PAYLOAD_LIMIT}` })
  }

  public async start() {
    const { app } = this
    
    // Initialize controllers and register routes
    const mcpController = new MCPController({ app, mongoParams })
    await mcpController.init()
    mcpController.registerRoutes()
    
    // Start the server
    app.listen(env.PORT, () => {
      log({ level: 'info', msg: `Server running at http://localhost:${env.PORT}` })
    })
  }
}
```

### Middleware Ecosystem
Express.js has a rich ecosystem of middleware:

1. **Body Parsing** - Built-in support for parsing JSON and URL-encoded bodies
2. **Error Handling** - Easy to implement centralized error handling
3. **Third-party Middleware** - Large selection of community-maintained middleware
4. **Custom Middleware** - Simple to create custom middleware for specific needs

```typescript
// Example of middleware usage in MCP API
this.app.use(bodyParser.json({ limit: env.PAYLOAD_LIMIT }))
this.app.use(bodyParser.urlencoded({ extended: false, limit: env.PAYLOAD_LIMIT }))
```

### Routing System
Express.js provides a powerful routing system:

1. **HTTP Method Support** - Built-in support for all HTTP methods (GET, POST, PUT, DELETE, etc.)
2. **Path Parameters** - Easy to define and access path parameters
3. **Route Organization** - Routes can be organized by controller or feature
4. **Middleware Chains** - Routes can have multiple middleware functions

```typescript
// Example of route registration in MCP API
public registerRoutes(): void {
  this.app.post('/mcp/tool/call', this.callTool.bind(this))
  this.app.get('/mcp/servers', this.getServers.bind(this))
  this.app.get('/mcp/servers/:name', this.getServer.bind(this))
  this.app.post('/mcp/servers', this.addServer.bind(this))
  this.app.put('/mcp/servers/:name', this.updateServer.bind(this))
  this.app.delete('/mcp/servers/:name', this.deleteServer.bind(this))
  this.app.put('/mcp/servers/:name/enable', this.enableServer.bind(this))
  this.app.put('/mcp/servers/:name/disable', this.disableServer.bind(this))
  this.app.get('/mcp/tools', this.getTools.bind(this))
  this.app.post('/secrets/set', this.setSecret.bind(this))
  this.app.post('/secrets/delete', this.deleteSecret.bind(this))
}
```

### TypeScript Integration
Express.js works well with TypeScript:

1. **Type Definitions** - Official type definitions available (@types/express)
2. **Request/Response Typing** - Type-safe access to request and response objects
3. **Middleware Typing** - Type-safe middleware functions
4. **Controller Organization** - TypeScript classes work well for organizing Express.js controllers

```typescript
// Example of TypeScript integration in MCP API
private async callTool(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = req.body as ToolCallRequest
    const { serverName, methodName, args } = body
    const username = body.username ?? 'default'
    log({ level: 'info', msg: `calling tool ${methodName} on server ${serverName} with args ${JSON.stringify(args)}` })
    const result = await this.mcpService.callTool(username, serverName, methodName, args)
    res.json({ success: true, data: result })
  } catch (error) {
    log({ level: 'error', msg: `error calling tool: ${(error as Error).message}` })
    res.status(500).json({ success: false, error: (error as Error).message })
  }
}
```

### Performance
Express.js offers good performance characteristics:

1. **Low Overhead** - Minimal performance impact compared to raw Node.js HTTP
2. **Asynchronous Handling** - Built for Node.js's asynchronous, non-blocking I/O model
3. **Scalability** - Can handle many concurrent connections efficiently
4. **Clustering Support** - Works well with Node.js clustering for multi-core utilization

### Community and Ecosystem
Express.js has a large, active community:

1. **Mature Framework** - Well-established with a long history of production use
2. **Documentation** - Extensive documentation and tutorials available
3. **Community Support** - Large community for help and troubleshooting
4. **Regular Updates** - Maintained and updated regularly

## Implementation Details

### Project Structure

The MCP API project organizes Express.js code using a controller-based approach:

```
src/
  controllers/
    mcp.ts       # MCP server and tool operations
    packages.ts  # Package management operations
  services/
    mcp.ts       # MCP business logic
    packages.ts  # Package management business logic
    secrets.ts   # Secret management business logic
  utils/
    general.ts   # Utility functions
    mongodb.ts   # MongoDB integration
  index.ts       # Application entry point
```

### Controller Pattern

Each controller is responsible for:

1. **Route Registration** - Registering routes with the Express.js application
2. **Request Handling** - Processing incoming HTTP requests
3. **Response Formatting** - Formatting responses in a consistent way
4. **Error Handling** - Handling and reporting errors

```typescript
export class MCPController implements Resource {
  private app: Express
  private mcpService: MCPService
  
  constructor({ app, mongoParams }: { app: Express, mongoParams: MongoConnectionParams }) {
    this.app = app
    this.mcpService = new MCPService({ mongoParams })
  }
  
  public registerRoutes(): void {
    this.app.post('/mcp/tool/call', this.callTool.bind(this))
    this.app.get('/mcp/servers', this.getServers.bind(this))
    // ...
  }
  
  private async callTool(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Process request
      res.json({ success: true, data: result })
    } catch (error) {
      // Handle error
      res.status(500).json({ success: false, error: (error as Error).message })
    }
  }
  
  // ...
}
```

### Error Handling

The MCP API implements error handling at the controller level:

1. **Try/Catch Blocks** - Each route handler has a try/catch block
2. **Error Logging** - Errors are logged with context information
3. **Error Responses** - Errors are returned as JSON with appropriate HTTP status codes

```typescript
private async callTool(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = req.body as ToolCallRequest
    const { serverName, methodName, args } = body
    const username = body.username ?? 'default'
    log({ level: 'info', msg: `calling tool ${methodName} on server ${serverName} with args ${JSON.stringify(args)}` })
    const result = await this.mcpService.callTool(username, serverName, methodName, args)
    res.json({ success: true, data: result })
  } catch (error) {
    log({ level: 'error', msg: `error calling tool: ${(error as Error).message}` })
    res.status(500).json({ success: false, error: (error as Error).message })
  }
}
```

## Alternatives Considered

### Koa.js
- **Pros**: Modern middleware system with async/await support, lighter weight than Express
- **Cons**: Smaller ecosystem, less community support, less mature

### Fastify
- **Pros**: Better performance than Express, built-in schema validation
- **Cons**: Smaller ecosystem, less community support, steeper learning curve

### NestJS
- **Pros**: Full-featured framework with built-in dependency injection, TypeScript-first
- **Cons**: More opinionated, steeper learning curve, more overhead

### Hapi.js
- **Pros**: Configuration-driven, built-in validation, good for large teams
- **Cons**: More verbose, steeper learning curve, less flexible

## Considerations/Open Questions

- Should we implement a more structured error handling middleware?
- How to handle authentication and authorization middleware?
- Should we consider using a more structured routing system (e.g., express-router)?
- How to handle API versioning in the future?

## AI Assistance Notes
- Model Used: Claude 3 Opus
- Prompt: Nexus System onboarding for MCP API project
- Date Generated: 2025-03-23

## Related Nexus Documents
- [System Overview](../architecture/system_overview.md)
- [HTTP API Feature](../features/http_api.md)
- [TypeScript Technology Choice](./typescript.md)
- [MCP Controller Architecture](../architecture/mcp_controller.md)
