# Feature: HTTP API

## Context
MCP servers are typically accessed directly through the Model Context Protocol, which requires direct process communication. This limits their usefulness in distributed environments and makes it difficult to share MCP servers across multiple clients. The HTTP API feature addresses these limitations by providing a RESTful API for accessing MCP servers.

## Goal
Create a scalable, secure HTTP API that enables multiple clients to access MCP servers while providing proper error handling, security, and multi-user support.

## Implementation Details

### API Architecture

The HTTP API is built using Express.js and follows RESTful principles. It consists of several controllers that handle different aspects of the API:

1. **MCPController** - Handles MCP server management and tool operations
2. **PackagesController** - Handles package management operations
3. **SecretsController** - Integrated into MCPController, handles secret management

```typescript
// In index.ts
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
    
    // Initialize MCP controller
    const mcpController = new MCPController({ app, mongoParams })
    await mcpController.init()
    mcpController.registerRoutes()
    this.resources.push(mcpController)
    
    // Initialize Packages controller
    const packagesController = new PackagesController({ 
      app, 
      mongoParams, 
      mcpService: mcpController.getMcpService() 
    })
    await packagesController.init()
    packagesController.registerRoutes()
    this.resources.push(packagesController)
    
    // Set up circular dependency between MCPService and PackageService
    mcpController.getMcpService().setPackageService(packagesController.getPackageService())

    // Start the server
    app.listen(env.PORT, () => {
      log({ level: 'info', msg: `Server running at http://localhost:${env.PORT}` })
    })
  }
}
```

### API Endpoints

The HTTP API exposes the following endpoints:

#### MCP Server Management
- `GET /mcp/servers` - List all MCP servers
- `GET /mcp/servers/:name` - Get a specific MCP server
- `POST /mcp/servers` - Add a new MCP server
- `PUT /mcp/servers/:name` - Update an existing MCP server
- `DELETE /mcp/servers/:name` - Delete an MCP server
- `PUT /mcp/servers/:name/enable` - Enable an MCP server
- `PUT /mcp/servers/:name/disable` - Disable an MCP server

#### MCP Tool Operations
- `GET /mcp/tools` - List all available MCP tools
- `POST /mcp/tool/call` - Call an MCP tool

#### Package Management
- `POST /packages/install` - Install a new MCP server package
- `GET /packages` - List all installed packages
- `GET /packages/by-name/:name` - Get a package by name
- `GET /packages/by-id/:name` - Get a package by server ID
- `DELETE /packages/:name` - Uninstall a package
- `PUT /packages/:name/enable` - Enable a package
- `PUT /packages/:name/disable` - Disable a package

#### Secret Management
- `POST /secrets/set` - Set a secret
- `POST /secrets/delete` - Delete a secret

### Request/Response Format

All API endpoints use JSON for request and response bodies. Responses follow a consistent format:

#### Success Response
```json
{
  "success": true,
  "data": { ... }  // or other field name depending on the endpoint
}
```

#### Error Response
```json
{
  "success": false,
  "error": "Error message"
}
```

### Error Handling

The HTTP API implements comprehensive error handling:

1. **Request Validation** - Validates incoming requests and returns appropriate error responses
2. **Service Errors** - Catches and logs errors from the underlying services
3. **HTTP Status Codes** - Returns appropriate HTTP status codes for different error conditions:
   - 400 Bad Request - Invalid request parameters
   - 404 Not Found - Resource not found
   - 500 Internal Server Error - Unexpected errors

```typescript
// Example error handling in MCPController.callTool
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

### Multi-user Support

The HTTP API supports multi-user access through the `username` parameter:

```typescript
// Example in MCPController.callTool
const username = body.username ?? 'default'
const result = await this.mcpService.callTool(username, serverName, methodName, args)
```

If the `username` parameter is omitted, a default value of "default" is used. This allows single users to use the API without specifying a username while still benefiting from encrypted secret storage.

## Usage Examples

### Calling an MCP Tool

```http
POST /mcp/tool/call
Content-Type: application/json

{
  "username": "user123",
  "serverName": "mcp-github",
  "methodName": "create_issue",
  "args": {
    "owner": "username",
    "repo": "repo-name",
    "title": "Issue title",
    "body": "Issue description"
  }
}
```

Response:
```json
{
  "success": true,
  "data": {
    "content": [
      {
        "type": "text",
        "text": "Issue created: https://github.com/username/repo-name/issues/1"
      }
    ]
  }
}
```

### Listing MCP Servers

```http
GET /mcp/servers
```

Response:
```json
{
  "success": true,
  "servers": [
    {
      "name": "github",
      "command": "node",
      "args": ["./packages/missionsquad-mcp-github/node_modules/@missionsquad/mcp-github/build/index.js"],
      "env": {
        "NODE_ENV": "production"
      },
      "status": "connected",
      "enabled": true,
      "toolsList": [
        {
          "name": "create_issue",
          "description": "Create a GitHub issue",
          "inputSchema": {
            "type": "object",
            "properties": {
              "owner": {
                "type": "string"
              },
              "repo": {
                "type": "string"
              },
              "title": {
                "type": "string"
              },
              "body": {
                "type": "string"
              }
            },
            "required": ["owner", "repo", "title"]
          }
        }
      ]
    }
  ]
}
```

### Setting a Secret

```http
POST /secrets/set
Content-Type: application/json

{
  "username": "user123",
  "serverName": "mcp-github",
  "secretName": "GITHUB_TOKEN",
  "secretValue": "ghp_xxxxxxxxxxxx"
}
```

Response:
```json
{
  "success": true
}
```

## Security Considerations

1. **No Authentication** - The current implementation does not include authentication. In production, additional authentication and authorization mechanisms should be implemented.
2. **HTTPS** - The API should be deployed behind HTTPS in production to protect data in transit.
3. **Input Validation** - All request parameters are validated before processing to prevent injection attacks.
4. **Secret Handling** - Secrets are never exposed in responses or logs.

## Deployment Considerations

1. **Load Balancing** - The API can be deployed behind a load balancer for horizontal scaling.
2. **Containerization** - The API can be deployed in Docker containers for easy scaling and management.
3. **Environment Variables** - Configuration is done through environment variables for flexibility.

## Considerations/Open Questions

- How to implement proper authentication and authorization?
- Should we implement rate limiting to prevent abuse?
- How to handle long-running tool operations?
- Should we implement a caching layer for frequently used tool responses?

## AI Assistance Notes
- Model Used: Claude 3 Opus
- Prompt: Nexus System onboarding for MCP API project
- Date Generated: 2025-03-23

## Related Nexus Documents
- [System Overview](../architecture/system_overview.md)
- [MCP Controller](../architecture/mcp_controller.md)
- [Packages Controller](../architecture/packages_controller.md)
- [Multi-user Support Feature](./multi_user_support.md)
- [Package Management Feature](./package_management.md)
