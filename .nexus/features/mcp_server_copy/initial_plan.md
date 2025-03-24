# Feature: MCP Server Copy - Initial Plan

## Context
- The MCP API currently allows installing and managing MCP servers
- Each MCP server exposes a set of tools that can be called via the API
- Currently, if users want to expose only a subset of tools from a server, they would need to create a custom server implementation

## Goal
- Add the ability to create a "copy" of an existing MCP server that only exposes specified methods
- The copy should use the same package installation as the original server
- This will allow for more granular control over which tools are exposed to different users or applications

## Plan

### 1. Extend the MCPServer Interface
- Add a new property to track if a server is a copy and which server it's copied from
- Add a property to store the list of allowed methods for copied servers

```typescript
export interface MCPServer {
  // Existing properties
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
  };
  
  // New properties for server copies
  isServerCopy?: boolean;
  originalServerName?: string;
  allowedMethods?: string[];
}
```

### 2. Modify the MCPService Class
- Add methods to create and manage server copies
- Implement logic to filter available tools based on the allowedMethods list
- Ensure that server copies use the same package installation as the original

```typescript
// New methods to add to MCPService
async createServerCopy(originalServerName: string, copyName: string, allowedMethods: string[]): Promise<MCPServer>;
async updateServerCopyMethods(copyName: string, allowedMethods: string[]): Promise<MCPServer>;
async deleteServerCopy(copyName: string): Promise<void>;
```

### 3. Update the callTool Method
- Modify the callTool method to check if a server is a copy
- If it is a copy:
  1. Verify that the requested method is in the allowedMethods list
  2. If not in allowedMethods, return an error
  3. If allowed, retrieve the original server object
  4. Get secrets for the original server
  5. Apply those secrets to the tool call
  6. Use the original server's connection to make the actual call
  7. Return the result to the client

### 4. Add New API Endpoints
- Add endpoints to create, update, and delete server copies
- Add endpoints to manage the allowed methods for a server copy

```
POST /mcp/servers/copy
GET /mcp/servers/copies
GET /mcp/servers/copies/:name
PUT /mcp/servers/copies/:name
DELETE /mcp/servers/copies/:name
```

### 5. Update the Database Schema
- Add new fields to the MCP server collection to support server copies
- Ensure backward compatibility with existing servers

### 6. Update Secret Management
- Secrets for copied servers will be shared with the original server
- When a tool is called on a server copy:
  - Retrieve the secrets for the original server
  - Apply those secrets to the tool call
  - Forward the call to the original server's connection

## API Details

### Create a Server Copy
```
POST /mcp/servers/copy
```

Request body:
```json
{
  "originalServerName": "mcp-github",
  "copyName": "mcp-github-issues-only",
  "allowedMethods": ["create_issue", "list_issues", "get_issue"]
}
```

Response:
```json
{
  "success": true,
  "server": {
    "name": "mcp-github-issues-only",
    "isServerCopy": true,
    "originalServerName": "mcp-github",
    "allowedMethods": ["create_issue", "list_issues", "get_issue"],
    "status": "connected",
    "enabled": true
  }
}
```

### Update Server Copy Methods
```
PUT /mcp/servers/copies/:name
```

Request body:
```json
{
  "allowedMethods": ["create_issue", "list_issues"]
}
```

Response:
```json
{
  "success": true,
  "server": {
    "name": "mcp-github-issues-only",
    "isServerCopy": true,
    "originalServerName": "mcp-github",
    "allowedMethods": ["create_issue", "list_issues"],
    "status": "connected",
    "enabled": true
  }
}
```

### List Server Copies
```
GET /mcp/servers/copies
```

Response:
```json
{
  "success": true,
  "copies": [
    {
      "name": "mcp-github-issues-only",
      "isServerCopy": true,
      "originalServerName": "mcp-github",
      "allowedMethods": ["create_issue", "list_issues", "get_issue"],
      "status": "connected",
      "enabled": true
    }
  ]
}
```

## Considerations/Open Questions

All key questions have been resolved:

- **Version updates to the original server**: When the original server is updated, we'll fetch the updated list of available tools and automatically remove any methods from copies that are no longer available in the original server.
- **Copies of copies**: We will only allow copies of original servers, not copies of copies.
- **Handling removed methods**: If a method in the allowedMethods list is removed from the original server, we'll automatically remove it from the copy during version updates.
- **Method-specific environment variables**: We decided not to implement this feature as it's not needed for the current requirements.
- **Secret management**: Copies will share secrets with the original server.

## AI Assistance Notes
- Model Used: Claude
- Prompt: "let's start a new session and plan how to add feature that will enable making a copy of a mcp server, but not actually install a duplicate package - it would use the same installation of the mcp server, and the purpose of this copy is to only only expose specified methods from that server. for example, if we have a server with 10 tools, we want to be able to specify 3 of them to use."
- Date Generated: 2025-03-23

## Related Nexus Documents
- [MCP Server Copy Session](/.nexus/inprogress/mcp_server_copy/session_2025-03-23_23-32-09.md)
