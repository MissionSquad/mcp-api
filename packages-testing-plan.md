# Testing Plan for Package Controller Endpoints

Based on my analysis of the `src/controllers/packages.ts` file, I've created a comprehensive testing plan for all endpoints defined in the `registerRoutes` method. This plan includes the URL, HTTP method, request parameters, example values, and expected responses for each endpoint.

## 1. Install Package

- **URL**: `/packages/install`
- **Method**: POST
- **Body Parameters**:
  - `name` (required): Package repository name
  - `serverName` (required): Name to assign to the server
  - `version` (optional): Specific version to install
  - `command` (optional): Custom command to run the server
  - `args` (optional): Array of arguments for the command
  - `env` (optional): Environment variables
  - `enabled` (optional): Whether the server should be enabled after installation
- **Example Request**:

```json
{
  "name": "openai-mcp",
  "serverName": "openai",
  "version": "1.0.0",
  "enabled": true
}
```

- **Expected Response (Success)**:

```json
{
  "success": true,
  "package": {
    "name": "openai-mcp",
    "version": "1.0.0",
    "installPath": "packages/openai-mcp",
    "status": "installed",
    "installed": "2025-04-17T22:25:30.000Z",
    "mcpServerId": "openai",
    "enabled": true
  },
  "server": {
    "name": "openai",
    "command": "node",
    "args": ["./packages/openai-mcp/node_modules/openai-mcp/index.js"],
    "env": {},
    "status": "connected",
    "enabled": true
  }
}
```

- **Expected Response (Error)**:

```json
{
  "success": false,
  "error": "Package name and server name are required"
}
```

## 2. Get All Packages

- **URL**: `/packages`
- **Method**: GET
- **Query Parameters**:
  - `checkUpdates` (optional): Set to "true" to check for updates
- **Example Request**: `/packages?checkUpdates=true`
- **Expected Response**:

```json
{
  "success": true,
  "packages": [
    {
      "name": "openai-mcp",
      "version": "1.0.0",
      "latestVersion": "1.1.0",
      "updateAvailable": true,
      "installPath": "packages/openai-mcp",
      "status": "installed",
      "installed": "2025-04-17T22:25:30.000Z",
      "mcpServerId": "openai",
      "enabled": true
    },
    {
      "name": "github-mcp",
      "version": "0.5.0",
      "latestVersion": "0.5.0",
      "updateAvailable": false,
      "installPath": "packages/github-mcp",
      "status": "installed",
      "installed": "2025-04-17T22:25:30.000Z",
      "mcpServerId": "github",
      "enabled": true
    }
  ]
}
```

## 3. Get Package by Name

- **URL**: `/packages/by-name/:name`
- **Method**: GET
- **Path Parameters**:
  - `name`: Package name
- **Query Parameters**:
  - `checkUpdates` (optional): Set to "true" to check for updates
- **Example Request**: `/packages/by-name/openai-mcp?checkUpdates=true`
- **Expected Response (Success)**:

```json
{
  "success": true,
  "package": {
    "name": "openai-mcp",
    "version": "1.0.0",
    "latestVersion": "1.1.0",
    "updateAvailable": true,
    "installPath": "packages/openai-mcp",
    "status": "installed",
    "installed": "2025-04-17T22:25:30.000Z",
    "mcpServerId": "openai",
    "enabled": true
  }
}
```

- **Expected Response (Error)**:

```json
{
  "success": false,
  "error": "Package openai-mcp not found"
}
```

## 4. Get Package by ID (Server Name)

- **URL**: `/packages/by-id/:name`
- **Method**: GET
- **Path Parameters**:
  - `name`: Server name (mcpServerId)
- **Query Parameters**:
  - `checkUpdates` (optional): Set to "true" to check for updates
- **Example Request**: `/packages/by-id/openai?checkUpdates=true`
- **Expected Response (Success)**:

```json
{
  "success": true,
  "package": {
    "name": "openai-mcp",
    "version": "1.0.0",
    "latestVersion": "1.1.0",
    "updateAvailable": true,
    "installPath": "packages/openai-mcp",
    "status": "installed",
    "installed": "2025-04-17T22:25:30.000Z",
    "mcpServerId": "openai",
    "enabled": true
  }
}
```

- **Expected Response (Error)**:

```json
{
  "success": false,
  "error": "Package openai not found"
}
```

## 5. Uninstall Package

- **URL**: `/packages/:name`
- **Method**: DELETE
- **Path Parameters**:
  - `name`: Server name (mcpServerId)
- **Example Request**: `/packages/openai`
- **Expected Response (Success)**:

```json
{
  "success": true
}
```

- **Expected Response (Error)**:

```json
{
  "success": false,
  "error": "Package openai not found"
}
```

## 6. Enable Package

- **URL**: `/packages/:name/enable`
- **Method**: PUT
- **Path Parameters**:
  - `name`: Server name (mcpServerId)
- **Example Request**: `/packages/openai/enable`
- **Expected Response (Success)**:

```json
{
  "success": true,
  "server": {
    "name": "openai",
    "command": "node",
    "args": ["./packages/openai-mcp/node_modules/openai-mcp/index.js"],
    "env": {},
    "status": "connected",
    "enabled": true
  }
}
```

- **Expected Response (Error)**:

```json
{
  "success": false,
  "error": "Package openai not found"
}
```

## 7. Disable Package

- **URL**: `/packages/:name/disable`
- **Method**: PUT
- **Path Parameters**:
  - `name`: Server name (mcpServerId)
- **Example Request**: `/packages/openai/disable`
- **Expected Response (Success)**:

```json
{
  "success": true,
  "server": {
    "name": "openai",
    "command": "node",
    "args": ["./packages/openai-mcp/node_modules/openai-mcp/index.js"],
    "env": {},
    "status": "disconnected",
    "enabled": false
  }
}
```

- **Expected Response (Error)**:

```json
{
  "success": false,
  "error": "Package openai not found"
}
```

## 8. Check for Updates

- **URL**: `/packages/updates`
- **Method**: GET
- **Query Parameters**:
  - `name` (optional): Server name to check for updates
- **Example Request**: `/packages/updates?name=openai`
- **Expected Response**:

```json
{
  "success": true,
  "updates": [
    {
      "serverName": "openai",
      "currentVersion": "1.0.0",
      "latestVersion": "1.1.0",
      "updateAvailable": true
    }
  ]
}
```

## 9. Upgrade Package

- **URL**: `/packages/:name/upgrade`
- **Method**: PUT
- **Path Parameters**:
  - `name`: Server name (mcpServerId)
- **Body Parameters**:
  - `version` (optional): Specific version to upgrade to
- **Example Request**: `/packages/openai/upgrade`
- **Example Body**:

```json
{
  "version": "1.1.0"
}
```

- **Expected Response (Success)**:

```json
{
  "success": true,
  "package": {
    "name": "openai-mcp",
    "version": "1.1.0",
    "latestVersion": "1.1.0",
    "updateAvailable": false,
    "installPath": "packages/openai-mcp",
    "status": "installed",
    "installed": "2025-04-17T22:25:30.000Z",
    "lastUpgraded": "2025-04-17T22:30:00.000Z",
    "mcpServerId": "openai",
    "enabled": true
  },
  "server": {
    "name": "openai",
    "command": "node",
    "args": ["./packages/openai-mcp/node_modules/openai-mcp/index.js"],
    "env": {},
    "status": "connected",
    "enabled": true
  }
}
```

- **Expected Response (Error)**:

```json
{
  "success": false,
  "error": "Package openai not found"
}
```

## 10. Upgrade All Packages

- **URL**: `/packages/upgrade-all`
- **Method**: PUT
- **Example Request**: `/packages/upgrade-all`
- **Expected Response**:

```json
{
  "success": true,
  "results": [
    {
      "serverName": "openai",
      "success": true
    },
    {
      "serverName": "github",
      "success": true
    }
  ]
}
```

## Testing Considerations

1. **Authentication**: The endpoints don't appear to have authentication checks in the controller code. If authentication is implemented at a middleware level, tests should include appropriate authentication tokens.

2. **Error Handling**: Test various error scenarios:

   - Invalid package names
   - Non-existent packages
   - Network failures during installation/upgrade
   - Permission issues

3. **Concurrency**: Test concurrent operations on the same package:

   - Installing while upgrading
   - Uninstalling while upgrading
   - Multiple simultaneous installations

4. **Edge Cases**:

   - Package with very large dependencies
   - Package with complex command requirements
   - Package with specific environment variable requirements

5. **Integration Testing**:
   - Test the full lifecycle: install → enable → check for updates → upgrade → disable → uninstall
   - Test interaction with the MCP service to ensure servers are properly started/stopped
