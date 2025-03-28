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
- **Containerized Deployment**: Docker and Docker Compose support for easy deployment

## Architecture

MCP API acts as a proxy between clients and MCP servers:

1. **Client Requests**: Applications send requests to the HTTP API
2. **Secret Management**: The API retrieves and decrypts user-specific secrets as needed
3. **Package Management**: The API handles installation, configuration, and lifecycle of MCP server packages
4. **MCP Server Communication**: The API communicates with MCP servers using the Model Context Protocol
5. **Response Handling**: Results from MCP servers are returned to clients

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
   cp env.example .env
   ```

4. Configure your environment variables:
   ```
   PORT=8080
   MONGO_USER=username
   MONGO_PASS=password
   MONGO_HOST=localhost:27017
   MONGO_DBNAME=mcp
   SECRETS_KEY=your-random-key
   SECRETS_COLLECTION=secrets
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

### Building the Docker Image

```bash
docker build -t mcp-api .
docker run -p 8080:8080 --env-file .env mcp-api
```

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
  "version": "1.0.0",  // Optional, defaults to "latest"
  "serverName": "unique-server-name",
  "command": "node",  // Optional, auto-detected if not provided
  "args": ["--option1", "--option2"],  // Optional
  "env": {  // Optional
    "NODE_ENV": "production"
  }
}
```

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
  "version": "1.1.0"  // Optional, defaults to latest version
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

#### Call an MCP Tool

```
POST /mcp/tool/call
```

Request body:
```json
{
  "username": "user123",  // Optional, defaults to "default"
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

#### List Available MCP Servers

```
GET /mcp/servers
```

#### List Available MCP Tools

```
GET /mcp/tools
```

### MCP Server Management

#### Add a New MCP Server

```
POST /mcp/servers
```

Request body:
```json
{
  "name": "helper-tools",
  "command": "./node_modules/@missionsquad/mcp-helper-tools/build/index.js",
  "args": ["--option1", "--option2"],  // Optional
  "env": {  // Optional
    "NODE_ENV": "production"
  }
}
```

> **Important Security Note**: Do not include sensitive information like passwords or API keys in the `env` object. Use the secret management endpoints to securely store and manage sensitive credentials.

#### Update an Existing MCP Server

```
PUT /mcp/servers/:name
```

Request body:
```json
{
  "command": "./updated/path/to/server.js",  // Optional
  "args": ["--new-option"],  // Optional
  "env": {  // Optional
    "NODE_ENV": "development"
  }
}
```

#### Delete an MCP Server

```
DELETE /mcp/servers/:name
```

#### Get a Specific MCP Server

```
GET /mcp/servers/:name
```

#### Enable an MCP Server

```
PUT /mcp/servers/:name/enable
```

Enables a previously disabled MCP server.

#### Disable an MCP Server

```
PUT /mcp/servers/:name/disable
```

Disables an MCP server without removing it from the system.

### Secret Management

#### Set a Secret

```
POST /secrets/set
```

Request body:
```json
{
  "username": "user123",  // Optional, defaults to "default"
  "serverName": "mcp-github",
  "secretName": "GITHUB_TOKEN",
  "secretValue": "ghp_xxxxxxxxxxxx"
}
```

#### Delete a Secret

```
POST /secrets/delete
```

Request body:
```json
{
  "username": "user123",  // Optional, defaults to "default"
  "serverName": "mcp-github",
  "secretName": "GITHUB_TOKEN"
}
```

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
