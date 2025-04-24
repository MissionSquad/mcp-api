# MCP Controller Testing Plan

Based on my analysis of the `src/controllers/mcp.ts` file, I've identified all the routes registered in the `registerRoutes` method and their corresponding input types. Here's a comprehensive testing plan with example URLs and parameters for each endpoint:

## 1. POST `/mcp/tool/call`

- **Description**: Calls a tool on a specified MCP server
- **Input Type**: `ToolCallRequest`
- **Example Request**:

  ```
  POST /mcp/tool/call
  Content-Type: application/json

  {
    "username": "testuser",
    "serverName": "weather-server",
    "methodName": "get_forecast",
    "args": {
      "city": "San Francisco",
      "days": 5
    }
  }
  ```

- **Test Cases**:
  - Valid tool call with all parameters
  - Tool call without optional username (should default to 'default')
  - Invalid server name
  - Invalid method name
  - Invalid arguments format

## 2. GET `/mcp/servers`

- **Description**: Gets a list of all MCP servers
- **Input Type**: None
- **Example Request**:
  ```
  GET /mcp/servers
  ```
- **Test Cases**:
  - Get servers when servers exist
  - Get servers when no servers exist

## 3. GET `/mcp/servers/:name`

- **Description**: Gets details of a specific MCP server
- **Input Type**: Path parameter
- **Example Request**:
  ```
  GET /mcp/servers/weather-server
  ```
- **Test Cases**:
  - Get existing server
  - Get non-existent server (should return 404)

## 4. POST `/mcp/servers`

- **Description**: Adds a new MCP server
- **Input Type**: `AddServerRequest`
- **Example Request**:

  ```
  POST /mcp/servers
  Content-Type: application/json

  {
    "name": "weather-server",
    "command": "node",
    "args": ["weather-server.js"],
    "env": {
      "API_KEY": "abc123",
      "DEBUG": "true"
    },
    "enabled": true
  }
  ```

- **Test Cases**:
  - Add server with all parameters
  - Add server with only required parameters
  - Add server with duplicate name (should fail)
  - Add server with invalid command

## 5. PUT `/mcp/servers/:name`

- **Description**: Updates an existing MCP server
- **Input Type**: Path parameter and `UpdateServerRequest`
- **Example Request**:

  ```
  PUT /mcp/servers/weather-server
  Content-Type: application/json

  {
    "command": "node",
    "args": ["updated-weather-server.js"],
    "env": {
      "API_KEY": "new-key-123",
      "DEBUG": "false"
    },
    "enabled": false
  }
  ```

- **Test Cases**:
  - Update all fields of an existing server
  - Update only some fields (partial update)
  - Update non-existent server (should fail)

## 6. DELETE `/mcp/servers/:name`

- **Description**: Deletes an MCP server
- **Input Type**: Path parameter
- **Example Request**:
  ```
  DELETE /mcp/servers/weather-server
  ```
- **Test Cases**:
  - Delete existing server
  - Delete non-existent server (should handle gracefully)

## 7. PUT `/mcp/servers/:name/enable`

- **Description**: Enables an MCP server
- **Input Type**: Path parameter
- **Example Request**:
  ```
  PUT /mcp/servers/weather-server/enable
  ```
- **Test Cases**:
  - Enable disabled server
  - Enable already enabled server
  - Enable non-existent server (should fail)

## 8. PUT `/mcp/servers/:name/disable`

- **Description**: Disables an MCP server
- **Input Type**: Path parameter
- **Example Request**:
  ```
  PUT /mcp/servers/weather-server/disable
  ```
- **Test Cases**:
  - Disable enabled server
  - Disable already disabled server
  - Disable non-existent server (should fail)

## 9. GET `/mcp/tools`

- **Description**: Gets a list of all tools available across all MCP servers
- **Input Type**: None
- **Example Request**:
  ```
  GET /mcp/tools
  ```
- **Test Cases**:
  - Get tools when servers with tools exist
  - Get tools when no servers exist
  - Get tools when servers exist but have no tools

## 10. POST `/secrets/set`

- **Description**: Sets a secret for a specific server
- **Input Type**: `SetSecretRequest`
- **Example Request**:

  ```
  POST /secrets/set
  Content-Type: application/json

  {
    "username": "testuser",
    "serverName": "weather-server",
    "secretName": "API_KEY",
    "secretValue": "super-secret-key-123"
  }
  ```

- **Test Cases**:
  - Set new secret
  - Update existing secret
  - Set secret for non-existent server (should fail)

## 11. POST `/secrets/delete`

- **Description**: Deletes a secret for a specific server
- **Input Type**: `DeleteSecretRequest`
- **Example Request**:

  ```
  POST /secrets/delete
  Content-Type: application/json

  {
    "username": "testuser",
    "serverName": "weather-server",
    "secretName": "API_KEY"
  }
  ```

- **Test Cases**:
  - Delete existing secret
  - Delete non-existent secret (should handle gracefully)
  - Delete secret for non-existent server (should fail)

## Testing Strategy

For each endpoint, I recommend the following testing approach:

1. **Unit Tests**: Test each controller method in isolation, mocking the MCPService
2. **Integration Tests**: Test the endpoints with a real or mock database
3. **Edge Cases**: Test with invalid inputs, missing required fields, etc.
4. **Error Handling**: Verify appropriate error responses for various failure scenarios
5. **Authentication/Authorization**: If applicable, test with different user permissions
