# MCP API

A scalable HTTP API for Model Context Protocol (MCP) servers with secure secret management.

## Overview

MCP API addresses a critical limitation in the current MCP server ecosystem: most MCP servers are designed for single-user usage, with secrets (API keys, passwords) stored directly in environment variables. This project enhances security and scalability by:

1. Exposing MCP servers via a unified HTTP API
2. Abstracting secret handling through secure encryption
3. Supporting multi-user access to the same MCP server instances
4. Providing package management for easy installation and configuration of MCP servers

Instead of embedding sensitive credentials in environment variables, MCP API stores them encrypted in MongoDB and retrieves/decrypts them as needed for specific tool operations.

## Features

- **Multi-user Support**: Multiple users can access the same MCP server instances with their own credentials
- **Secure Secret Management**: All sensitive information is stored encrypted in MongoDB
- **User-specific Secret Storage**: Each user's secrets are isolated and encrypted separately
- **Package Management**: Simplified installation and configuration of MCP server packages
- **HTTP API**: Simple REST API for accessing MCP tools and managing secrets
- **Streamable HTTP Transport**: First-class support for `streamable_http` MCP servers with optional SSE fallback
- **Session Persistence**: HTTP session IDs are persisted and resumed across process restarts
- **OAuth Token Refresh**: Streamable HTTP servers can refresh OAuth tokens automatically via stored refresh tokens
- **Containerized Deployment**: Docker and Docker Compose support for easy deployment

## Architecture

MCP API acts as a proxy between clients and MCP servers:

1. **Client Requests**: Applications send requests to the HTTP API
2. **Secret Management**: The API retrieves and decrypts user-specific secrets as needed
3. **Package Management**: The API handles installation, configuration, and lifecycle of MCP server packages
4. **Transport Selection**: Each server uses either stdio or Streamable HTTP transport based on configuration
5. **MCP Server Communication**: The API communicates with MCP servers using the Model Context Protocol
6. **Response Handling**: Results from MCP servers are returned to clients

The system uses AES-256-GCM encryption for all stored secrets, with a separate encryption key for each deployment.

## Installation

### Prerequisites

- Node.js 20 or higher
- MongoDB
- MCP server implementations you wish to expose

### Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/missionsquad/mcp-api.git
   cd mcp-api
   ```

2. Install dependencies:

   ```bash
   yarn install
   ```

3. Create a `.env` file based on the example:

   ```bash
   cp example.env .env
   ```

4. Configure your environment variables:

   ```
   PORT=8080
   MONGO_USER=username
   MONGO_PASS=password
   MONGO_HOST=localhost:27017
   MONGO_DBNAME=mcp
   SECRETS_KEY=your-random-key
   SECRETS_DBNAME=secrets
   PYTHON_BIN=/usr/bin/python3
   PYTHON_VENV_DIR=packages/python
   PIP_INDEX_URL=
   PIP_EXTRA_INDEX_URL=
   ```

5. Build the project:

   ```bash
   yarn build
   ```

6. Start the server:
   ```bash
   yarn start
   ```

## Docker Deployment

### Using Docker Compose

1. Configure your `.env` file as described above
2. Run with Docker Compose:
   ```bash
   docker-compose up -d
   ```
3. The container image includes Python 3.13 and sets `PYTHON_BIN=/usr/local/bin/python3.13` by default for Python MCP package installs.

### Building the Docker Image

```bash
docker build -t mcp-api .
docker run -p 8080:8080 --env-file .env mcp-api
```

For Python MCP servers that require Python 3.13+ (for example `klaviyo-mcp-server`), do not override `PYTHON_BIN` to an older interpreter in container deployments.

## API Reference

### Package Management

#### Install an MCP Package

```
POST /packages/install
```

Request body:

```json
{
  "name": "package-name",
  "version": "1.0.0", // Optional, defaults to "latest"
  "serverName": "unique-server-name",
  "transportType": "stdio",
  "command": "node", // Optional, auto-detected if not provided
  "args": ["--option1", "--option2"], // Optional
  "env": {
    // Optional
    "NODE_ENV": "production"
  }
}
```

Streamable HTTP install example:

```json
{
  "name": "package-name",
  "version": "1.0.0",
  "serverName": "remote-http-server",
  "transportType": "streamable_http",
  "url": "https://example.com/mcp",
  "headers": {
    "X-Custom-Header": "value"
  },
  "enabled": true
}
```

Python stdio install example:

```json
{
  "name": "my-python-mcp",
  "serverName": "python-mcp",
  "runtime": "python",
  "pythonModule": "my_mcp_server",
  "pythonArgs": ["--port", "0"],
  "enabled": true
}
```

If `transportType` is omitted, the API defaults to `stdio`. For `streamable_http`, `command`, `args`, and `env` are ignored.
For `runtime: "python"`, `pythonModule` is required and `transportType` must be `stdio`.
Python installs always use a virtual environment at `packages/python/<serverName>` (or `PYTHON_VENV_DIR` if configured).
Python upgrades run `pip install --upgrade` inside that same virtual environment.
For Python runtime, `installPath` and `venvPath` are the same directory.
If `pipIndexUrl` or `pipExtraIndexUrl` are provided during install, they are persisted and reused for upgrades and update checks.

#### List Installed Packages

```
GET /packages
```

Response includes version information for each package:

```json
{
  "success": true,
  "packages": [
    {
      "name": "package-name",
      "version": "1.0.0",
      "latestVersion": "1.1.0",
      "updateAvailable": true,
      "installPath": "/path/to/package",
      "status": "installed",
      "installed": "2025-03-01T12:00:00Z",
      "lastUpgraded": "2025-03-01T12:00:00Z",
      "mcpServerId": "server-name",
      "enabled": true
    }
  ]
}
```

Optional query parameters:

- `checkUpdates=true` - Check for updates before returning package information

#### Get Package by Name

```
GET /packages/by-name/:name
```

#### Get Package by Server ID

```
GET /packages/by-id/:name
```

Both endpoints return version information and support the `checkUpdates=true` query parameter.

#### Uninstall a Package

```
DELETE /packages/:name
```

#### Check for Package Updates

```
GET /packages/updates
```

Optional query parameters:

- `name=server-name` - Check for updates for a specific package

Response:

```json
{
  "success": true,
  "updates": [
    {
      "serverName": "server-name",
      "currentVersion": "1.0.0",
      "latestVersion": "1.1.0",
      "updateAvailable": true
    }
  ]
}
```

#### Upgrade a Package

```
PUT /packages/:name/upgrade
```

Request body (optional):

```json
{
  "version": "1.1.0" // Optional, defaults to latest version
}
```

Response:

```json
{
  "success": true,
  "package": {
    // Updated package information
  },
  "server": {
    // Updated server information
  }
}
```

Upgrades work for both `stdio` and `streamable_http` servers. Streamable HTTP upgrades preserve `url`, `headers`, `sessionId`, and `reconnectionOptions` and do not attempt stdio command resolution.

#### Upgrade All Packages

```
PUT /packages/upgrade-all
```

Response:

```json
{
  "success": true,
  "results": [
    {
      "serverName": "server-name",
      "success": true
    },
    {
      "serverName": "another-server",
      "success": false,
      "error": "Error message"
    }
  ]
}
```

### MCP Tool Operations

> **Note**: The `username` parameter is optional in all API endpoints. If omitted, "default" will be used. This allows single users to use the API without specifying a username while still benefiting from encrypted secret storage.

#### List Available MCP Tools

```
GET /mcp/tools
```

Returns a list of all available tools across all registered MCP servers, including their names, descriptions, and input schemas.

Response format:

```json
{
  "success": true,
  "tools": [
    {
      "server-name": [
        {
          "name": "tool-name",
          "description": "A human-readable description of what the tool does",
          "inputSchema": {
            "type": "object",
            "properties": {
              "param1": {
                "type": "string",
                "description": "Description of parameter 1"
              },
              "param2": {
                "type": "number",
                "description": "Description of parameter 2"
              },
              "param3": {
                "type": "object",
                "properties": {
                  "nestedParam": {
                    "type": "string"
                  }
                }
              }
            },
            "required": ["param1"]
          }
        }
      ]
    }
  ]
}
```

The response structure contains:

- `success`: Boolean indicating if the request was successful
- `tools`: An array of objects, each containing a server name as the key and an array of tool definitions as the value
  - Each tool definition includes:
    - `name`: The name of the tool (used when calling the tool)
    - `description`: A human-readable description of the tool's functionality
    - `inputSchema`: A JSON Schema object defining the expected parameters for the tool
      - `properties`: Defines the parameters the tool accepts
      - `required`: An array of parameter names that are required

This endpoint is useful for discovering what tools are available and understanding their input requirements before making tool calls.

#### Call an MCP Tool

```
POST /mcp/tool/call
```

Executes a tool on a specified MCP server with the provided arguments.

Request body:

```json
{
  "username": "user123", // Optional, defaults to "default"
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

Parameters:

- `username`: (Optional) The username to use for retrieving secrets. Defaults to "default" if not provided.
- `serverName`: (Required) The name of the MCP server that provides the tool.
- `methodName`: (Required) The name of the tool to call.
- `args`: (Required) An object containing the arguments to pass to the tool.

Response format:

```json
{
  "success": true,
  "data": {
    "content": "Tool execution result",
    "contentType": "text/plain"
  }
}
```

The response structure contains:

- `success`: Boolean indicating if the request was successful
- `data`: The result of the tool execution
  - `content`: The actual result data (can be a string, object, or array)
  - `contentType`: The MIME type of the content (e.g., "text/plain", "application/json")

Error response:

```json
{
  "success": false,
  "error": "Error message"
}
```

##### Secret Handling

A key feature of the `/mcp/tool/call` endpoint is automatic secret injection:

1. When a tool call is made, the system automatically retrieves any stored secrets for the specified username and server
2. These secrets are merged with the provided arguments before the tool is called
3. This means sensitive information like API keys or passwords don't need to be included in the request payload

For example, if you've previously stored a GitHub token using the `/secrets/set` endpoint:

```json
{
  "username": "user123",
  "serverName": "mcp-github",
  "secretName": "GITHUB_TOKEN",
  "secretValue": "ghp_xxxxxxxxxxxx"
}
```

Then when calling a GitHub tool, you don't need to include the token in your request:

```json
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

The system will automatically inject the `GITHUB_TOKEN` into the arguments before calling the tool.

This approach provides several benefits:

- Clients don't need to manage or expose sensitive credentials in their requests
- Each user can have their own set of secrets for the same MCP servers
- Secrets are stored securely (encrypted) and only decrypted when needed

#### List Available MCP Servers

```
GET /mcp/servers
```

Returns a list of all registered MCP servers with their configuration and status information.

Response format:

```json
{
  "success": true,
  "servers": [
    {
      "name": "mcp-github",
      "transportType": "stdio",
      "command": "./node_modules/@missionsquad/mcp-github/build/index.js",
      "args": ["--port", "3000"],
      "env": {
        "NODE_ENV": "production"
      },
      "status": "connected",
      "enabled": true,
      "toolsList": [
        {
          "name": "create_issue",
          "description": "Creates a new issue in a GitHub repository",
          "inputSchema": {
            "type": "object",
            "properties": {
              "owner": {
                "type": "string",
                "description": "Repository owner"
              },
              "repo": {
                "type": "string",
                "description": "Repository name"
              },
              "title": {
                "type": "string",
                "description": "Issue title"
              },
              "body": {
                "type": "string",
                "description": "Issue body"
              },
              "labels": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Labels to apply to the issue"
              },
              "assignees": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Users to assign to the issue"
              }
            },
            "required": ["owner", "repo", "title"]
          }
        }
      ],
      "logs": []
    }
  ]
}
```

The response structure contains:

- `success`: Boolean indicating if the request was successful
- `servers`: An array of server objects, each containing:
  - `name`: The unique name of the MCP server
  - `command`: The command used to start the server
  - `args`: Command-line arguments passed to the server
  - `env`: Environment variables set for the server (excluding secrets)
  - `url`: Streamable HTTP endpoint (streamable_http only)
  - `headers`: Optional HTTP headers (streamable_http only)
  - `sessionId`: Optional persisted MCP session ID (streamable_http only)
  - `reconnectionOptions`: SSE reconnection settings (streamable_http only)
  - `status`: Current connection status ("connected", "connecting", "disconnected", or "error")
  - `enabled`: Whether the server is enabled
  - `toolsList`: Array of tools provided by this server (same format as in `/mcp/tools` response)
  - `logs`: Array of captured log messages if the server encountered any issues

This endpoint is useful for monitoring the status of all MCP servers and understanding their configurations.

### MCP Server Management

#### Get a Specific MCP Server

```
GET /mcp/servers/:name
```

Retrieves detailed information about a specific MCP server.

Parameters:

- `name`: (Required) The name of the MCP server to retrieve

Response format:

```json
{
  "success": true,
  "server": {
    "name": "mcp-github",
    "transportType": "stdio",
    "command": "./node_modules/@missionsquad/mcp-github/build/index.js",
    "args": ["--port", "3000"],
    "env": {
      "NODE_ENV": "production"
    },
    "status": "connected",
    "enabled": true,
    "toolsList": [
      {
        "name": "create_issue",
        "description": "Creates a new issue in a GitHub repository",
        "inputSchema": {
          "type": "object",
          "properties": {
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "title": {
              "type": "string",
              "description": "Issue title"
            },
            "body": {
              "type": "string",
              "description": "Issue body"
            },
            "labels": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Labels to apply to the issue"
            },
            "assignees": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Users to assign to the issue"
            }
          },
          "required": ["owner", "repo", "title"]
        }
      }
    ],
    "logs": []
  }
}
```

Error response (server not found):

```json
{
  "success": false,
  "error": "Server mcp-github not found"
}
```

#### Add a New MCP Server

```
POST /mcp/servers
```

Registers a new MCP server with the system.

Request body:

```json
{
  "name": "helper-tools",
  "transportType": "stdio",
  "command": "./node_modules/@missionsquad/mcp-helper-tools/build/index.js",
  "args": ["--option1", "--option2"], // Optional
  "env": {
    // Optional
    "NODE_ENV": "production"
  },
  "enabled": true // Optional, defaults to true
}
```

Streamable HTTP example:

```json
{
  "name": "remote-http-server",
  "transportType": "streamable_http",
  "url": "https://example.com/mcp",
  "headers": {
    "X-Custom-Header": "value"
  },
  "enabled": true
}
```

Parameters:

- `name`: (Required) A unique name for the MCP server
- `command`: (Required for stdio) The command to execute to start the MCP server
- `args`: (Optional for stdio) An array of command-line arguments to pass to the server
- `env`: (Optional for stdio) An object containing environment variables to set for the server
- `transportType`: (Optional) `stdio` or `streamable_http` (defaults to `stdio`)
- `url`: (Required for streamable_http) The MCP HTTP endpoint
- `headers`: (Optional for streamable_http) Static headers to send with requests
- `sessionId`: (Optional for streamable_http) Persisted session ID to resume
- `reconnectionOptions`: (Optional for streamable_http) SSE reconnection settings
- `enabled`: (Optional) Whether the server should be enabled immediately (defaults to true)

Response format:

```json
{
  "success": true,
  "server": {
    "name": "helper-tools",
    "transportType": "stdio",
    "command": "./node_modules/@missionsquad/mcp-helper-tools/build/index.js",
    "args": ["--option1", "--option2"],
    "env": {
      "NODE_ENV": "production"
    },
    "status": "connected",
    "enabled": true
  }
}
```

Error response (server already exists):

```json
{
  "success": false,
  "error": "Server with name helper-tools already exists"
}
```

> **Important Security Note**: Do not include sensitive information like passwords or API keys in the `env` object. Use the secret management endpoints to securely store and manage sensitive credentials.

For streamable HTTP OAuth, do not store bearer tokens in `headers`. Use the OAuth update endpoint (`POST /mcp/servers/:name/oauth`) so tokens are encrypted and refreshed automatically.

#### Update an Existing MCP Server

```
PUT /mcp/servers/:name
```

Updates the configuration of an existing MCP server.

Parameters:

- `name`: (Required) The name of the MCP server to update

Request body:

```json
{
  "command": "./updated/path/to/server.js", // Optional
  "args": ["--new-option"], // Optional
  "env": {
    // Optional
    "NODE_ENV": "development"
  },
  "enabled": false // Optional
}
```

Streamable HTTP update example:

```json
{
  "transportType": "streamable_http",
  "url": "https://example.com/mcp",
  "headers": {
    "X-Custom-Header": "value"
  },
  "reconnectionOptions": {
    "maxReconnectionDelay": 30000,
    "initialReconnectionDelay": 1000,
    "reconnectionDelayGrowFactor": 1.5,
    "maxRetries": 2
  }
}
```

All fields in the request body are optional. Only the fields that are provided will be updated.

Response format:

```json
{
  "success": true,
  "server": {
    "name": "helper-tools",
    "command": "./updated/path/to/server.js",
    "args": ["--new-option"],
    "env": {
      "NODE_ENV": "development"
    },
    "status": "disconnected",
    "enabled": false
  }
}
```

Error response (server not found):

```json
{
  "success": false,
  "error": "Server with name helper-tools not found"
}
```

When a server configuration is updated, the system will:

1. Stop the server if it's running
2. Update the configuration in the database
3. Restart the server with the new configuration (unless `enabled` is set to `false`)

#### Update Streamable HTTP OAuth Tokens

```
POST /mcp/servers/:name/oauth
```

Stores OAuth tokens and client metadata for a Streamable HTTP server. Tokens are encrypted and used by the SDK for automatic refresh.

Request body:

```json
{
  "tokenType": "Bearer",
  "accessToken": "<access_token>",
  "refreshToken": "<refresh_token>",
  "expiresIn": 3600,
  "scopes": ["read", "write"],
  "clientId": "<client_id>",
  "clientSecret": "<client_secret>",
  "redirectUri": "https://missionsquad.example.com/webhooks/oauth/callback/123",
  "codeVerifier": "<pkce_verifier>"
}
```

#### Delete an MCP Server

```
DELETE /mcp/servers/:name
```

Removes an MCP server from the system.

Parameters:

- `name`: (Required) The name of the MCP server to delete

Response format:

```json
{
  "success": true
}
```

Error response (server not found):

```json
{
  "success": false,
  "error": "Server with name helper-tools not found"
}
```

When a server is deleted, the system will:

1. Stop the server if it's running
2. Remove the server configuration from the database
3. Clean up any resources associated with the server

#### Enable an MCP Server

```
PUT /mcp/servers/:name/enable
```

Enables a previously disabled MCP server.

Parameters:

- `name`: (Required) The name of the MCP server to enable

Response format:

```json
{
  "success": true,
  "server": {
    "name": "helper-tools",
    "command": "./node_modules/@missionsquad/mcp-helper-tools/build/index.js",
    "args": ["--option1", "--option2"],
    "env": {
      "NODE_ENV": "production"
    },
    "status": "connected",
    "enabled": true
  }
}
```

Error response (server not found):

```json
{
  "success": false,
  "error": "Server helper-tools not found"
}
```

When a server is enabled, the system will:

1. Update the `enabled` flag in the database
2. Start the server if it's not already running

#### Disable an MCP Server

```
PUT /mcp/servers/:name/disable
```

Disables an MCP server without removing it from the system.

Parameters:

- `name`: (Required) The name of the MCP server to disable

Response format:

```json
{
  "success": true,
  "server": {
    "name": "helper-tools",
    "command": "./node_modules/@missionsquad/mcp-helper-tools/build/index.js",
    "args": ["--option1", "--option2"],
    "env": {
      "NODE_ENV": "production"
    },
    "status": "disconnected",
    "enabled": false
  }
}
```

Error response (server not found):

```json
{
  "success": false,
  "error": "Server helper-tools not found"
}
```

When a server is disabled, the system will:

1. Update the `enabled` flag in the database
2. Stop the server if it's running

Disabling a server is useful when you want to temporarily stop a server without losing its configuration.

### Secret Management

#### Set a Secret

```
POST /secrets/set
```

Stores a secret value for a specific user and MCP server. The secret is encrypted before being stored in the database.

Request body:

```json
{
  "username": "user123", // Optional, defaults to "default"
  "serverName": "mcp-github",
  "secretName": "GITHUB_TOKEN",
  "secretValue": "ghp_xxxxxxxxxxxx"
}
```

Parameters:

- `username`: (Optional) The username to associate the secret with. Defaults to "default" if not provided.
- `serverName`: (Required) The name of the MCP server that will use this secret.
- `secretName`: (Required) The name of the secret (e.g., "API_KEY", "PASSWORD").
- `secretValue`: (Required) The actual secret value to store.

Response format:

```json
{
  "success": true
}
```

Error response:

```json
{
  "success": false,
  "error": "Error message"
}
```

When a secret is set:

1. The system checks if the specified server exists
2. The secret value is encrypted using AES-256-GCM encryption
3. The encrypted secret is stored in the database, associated with the specified username and server
4. If a secret with the same name already exists for this user and server, it is overwritten

Secrets set with this endpoint are automatically injected into tool calls made with the `/mcp/tool/call` endpoint when the same username and server name are specified.

#### Delete a Secret

```
POST /secrets/delete
```

Removes a stored secret for a specific user and MCP server.

Request body:

```json
{
  "username": "user123", // Optional, defaults to "default"
  "serverName": "mcp-github",
  "secretName": "GITHUB_TOKEN"
}
```

Parameters:

- `username`: (Optional) The username associated with the secret. Defaults to "default" if not provided.
- `serverName`: (Required) The name of the MCP server the secret is associated with.
- `secretName`: (Required) The name of the secret to delete.

Response format:

```json
{
  "success": true
}
```

Error response:

```json
{
  "success": false,
  "error": "Error message"
}
```

When a secret is deleted:

1. The system locates the secret in the database based on the username, server name, and secret name
2. The secret is permanently removed from the database
3. Future tool calls will no longer have this secret automatically injected

#### Secret Security Model

The MCP API implements a robust security model for handling secrets:

1. **Encryption at Rest**: All secrets are encrypted using AES-256-GCM before being stored in the database.
2. **User Isolation**: Each user's secrets are stored separately, allowing multiple users to use the same MCP servers with different credentials.
3. **Just-in-Time Decryption**: Secrets are only decrypted when needed for a specific tool call and are never stored in plaintext in memory for longer than necessary.
4. **Transparent Injection**: Secrets are automatically injected into tool calls, so clients don't need to handle or expose sensitive information in their requests.
5. **No Secret Enumeration**: There is no API endpoint to list all secrets, reducing the risk of information disclosure.

This approach allows for secure multi-user access to shared MCP server instances while maintaining strong isolation between users' credentials.

### Streamable HTTP Transport Behavior

- Streamable HTTP servers use `transportType: "streamable_http"` with `url`, optional `headers`, and optional `reconnectionOptions`.
- `sessionId` is persisted after a successful connection and reused on restart.
- If a request fails with HTTP 404 while a `sessionId` is present, the session ID is cleared and the client retries once without it.
- If Streamable HTTP initialization fails with HTTP 400, 404, or 405, the client automatically falls back to the legacy SSE transport.
- If OAuth tokens are stored for a server, the SDK supplies `Authorization` headers and any static `Authorization` header in `headers` is ignored.

### OAuth2 Authentication Flow

#### Streamable HTTP OAuth (MissionSquad Callback)

This flow applies to `streamable_http` servers that require OAuth 2.1. Tokens are stored in `mcp-api`, refreshed automatically, and never passed through tool arguments.

1. Register the MCP server in `mcp-api` with `transportType: "streamable_http"` and a valid `url`.
2. In MissionSquad, create an `oauth_callback` webhook with `oauthConfig` populated:
   - `provider`, `state`, `codeVerifier`, `redirectUri`, `scopes`, `mcpServerName`, `authorizationServer`, `tokenEndpoint`, `clientId`, optional `clientSecret`.
3. Start the OAuth authorization in your client and direct the user to the authorization URL with `redirect_uri` set to the MissionSquad webhook callback.
4. MissionSquad exchanges the authorization code for tokens and calls:
   - `POST /mcp/servers/:name/oauth`
5. `mcp-api` stores the encrypted tokens and uses the SDK `OAuthClientProvider` for automatic refresh on 401 or expiry.

If refresh fails or tokens are missing, the transport throws a re-auth required error and the MissionSquad flow must be re-run.

#### Stdio OAuth2 (MCP_AUTH_TYPE Example)

For MCP servers that require user-specific OAuth2 authentication (like Google), the API provides a generic, secure, and scalable workflow. This allows users to grant consent once and enables the platform to perform actions on their behalf indefinitely, without the user or the front-end ever handling sensitive tokens.

**How It Works:**

The system uses a "declaration" pattern. An MCP server can declare its need for OAuth2 authentication via an environment variable in its configuration. The `mcp-api` host then orchestrates the flow.

**Full End-to-End Workflow:**

1.  **Prerequisites:**
    *   **Google Cloud Project:** You must have a Google Cloud project with the required APIs (e.g., Gmail API, Calendar API) enabled.
    *   **OAuth Consent Screen:** Configure the consent screen in your Google Cloud project.
    *   **OAuth 2.0 Client ID:** Create an "OAuth 2.0 Client ID" for a "Web application".
        *   **Authorized JavaScript origins:** Add the URL of your front-end application (e.g., `http://localhost:8081`).
        *   **Authorized redirect URIs:** This is the most critical step. Add the full callback URL of your `mcp-api` host. For example: `http://localhost:8080/auth/google/callback`. This must exactly match the URL of the API endpoint that handles the callback.
    *   **Download Credentials:** Download the JSON file containing your `client_id` and `client_secret`.

2.  **API Environment Configuration:**
    *   In the `.env` file for your `mcp-api` instance, create a new variable named `GOOGLE_OAUTH_CREDENTIALS`.
    *   The value of this variable should be the **entire content** of the JSON file you downloaded from Google, pasted as a single-line string.

3.  **Install and Configure the MCP Server:**
    *   Use the `POST /packages/install` endpoint to install an OAuth2-capable MCP server (e.g., `mcp-google-workspace`).
    *   In the request body, you **must** include the `env` object to declare the authentication type:
        ```json
        {
          "name": "@missionsquad/mcp-google-workspace",
          "serverName": "mcp-google-workspace",
          "env": {
            "MCP_AUTH_TYPE": "OAUTH2_GOOGLE"
          }
        }
        ```
    *   This `MCP_AUTH_TYPE` variable tells the `mcp-api` that this server requires the special OAuth2 token injection flow.

4.  **Initiate User Authentication (Front-End):**
    *   The front-end application provides a "Connect to Google" button or link for the user.
    *   When clicked, this link should direct the user to the `mcp-api`'s login endpoint, including their unique user ID.
    *   **Example Link:** `http://localhost:8080/auth/google/login?user_id=user123`

5.  **Orchestration (API and Google):**
    *   The `mcp-api` receives the request, calls the `auth_get_authorization_url` tool on the `mcp-google-workspace` server, and redirects the user's browser to the unique URL provided by Google.
    *   The user sees the Google consent screen, reviews the requested permissions, and clicks "Allow".
    *   Google redirects the user's browser back to the `redirect_uri` you configured (`http://localhost:8080/auth/google/callback`), including a temporary `authorization_code`.

6.  **Token Exchange and Storage (API):**
    *   The `mcp-api`'s callback endpoint receives the `authorization_code`.
    *   It calls the `auth_exchange_code` tool on the `mcp-google-workspace` server to exchange the code for a long-lived `refresh_token` and a short-lived `access_token`.
    *   The API then securely saves the entire JSON object of these tokens into the encrypted `Secrets` database, associated with `user123` and the `mcp-google-workspace` server.
    *   The user is shown a success message and can close the tab.

7.  **Subsequent Tool Calls (Seamless and Secure):**
    *   From now on, whenever the front-end makes a `POST /mcp/tool/call` request for `user123` to the `mcp-google-workspace` server (e.g., to query emails), the `mcp-api` automatically:
        1.  Recognizes that this server requires `OAUTH2_GOOGLE` auth.
        2.  Retrieves the user's encrypted tokens from the `Secrets` database.
        3.  Retrieves the global application credentials from the `GOOGLE_OAUTH_CREDENTIALS` environment variable.
        4.  Injects both sets of credentials as hidden parameters into the tool call.
    *   The `mcp-google-workspace` server receives these credentials, creates a temporary authenticated client, and executes the tool. The front-end never handles any tokens.

## Security Considerations

- The `SECRETS_KEY` environment variable is used to encrypt all secrets. Keep this secure and unique for each deployment.
- Use HTTPS in production to protect data in transit.
- Consider implementing additional authentication mechanisms for the API endpoints.
- Regularly rotate encryption keys and update stored secrets.

## Adapting MCP Servers

Some MCP servers may need modification to work with this API:

1. Remove hardcoded environment variable references for secrets
2. Update to accept secrets as parameters to tool methods
3. Ensure tools properly validate required parameters

## Contributing

This project is a work in progress and will improve over time. Contributions are welcome! If you have ideas for improvements, bug fixes, or new features, please feel free to:

- Open issues for bugs or feature requests
- Submit pull requests with improvements
- Share your feedback and suggestions

We're particularly interested in:

- Enhancing security features
- Improving performance and scalability
- Adding support for additional MCP server types
- Expanding the API functionality

## License

Apache-2.0
