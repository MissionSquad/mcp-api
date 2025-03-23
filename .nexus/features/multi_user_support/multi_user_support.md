# Feature: Multi-user Support

## Context
Traditional MCP servers are designed for single-user usage, with secrets stored directly in environment variables. This limits their usefulness in multi-user environments and presents security challenges. The MCP API addresses this limitation by providing a multi-user architecture that allows multiple users to access the same MCP server instances with their own credentials.

## Goal
Enable multiple users to securely access the same MCP server instances while maintaining proper isolation of their secrets and configurations.

## Implementation Details

### User Identification

The MCP API identifies users through a `username` parameter that can be provided in API requests:

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

If the `username` parameter is omitted, a default value of "default" is used. This allows single users to use the API without specifying a username while still benefiting from encrypted secret storage.

### User-specific Secret Storage

Each user's secrets are stored separately in the database, encrypted with the system's master key. This ensures that:

1. User A's secrets are never exposed to User B
2. Each user can have different credentials for the same MCP server
3. Users can manage their own secrets without affecting others

The secret storage schema includes the username as part of the key:

```typescript
interface UserSecret {
  username: string;
  server: string;
  key: string;
  value: string; // Encrypted value
}
```

### Secret Injection

When a user makes a tool call, the MCP API:

1. Retrieves the user's secrets for the specified server
2. Decrypts the secrets using the system's master key
3. Merges the secrets with the provided arguments
4. Forwards the merged arguments to the MCP server

This process is transparent to the user and ensures that their secrets are only used for their own requests.

```typescript
// In MCPService.callTool
const secrets = await this.secrets.getSecrets(username, serverName);
if (secrets[serverName] != null) {
  args = { ...args, ...secrets[serverName] };
}
```

### API Design

All API endpoints that involve user-specific data accept a `username` parameter:

- `/mcp/tool/call` - Call an MCP tool with user-specific secrets
- `/secrets/set` - Set a user-specific secret
- `/secrets/delete` - Delete a user-specific secret

This consistent design ensures that user isolation is maintained throughout the system.

## Security Considerations

1. **No Authentication** - The current implementation does not include authentication. In production, additional authentication and authorization mechanisms should be implemented.
2. **Secret Isolation** - Each user's secrets are isolated and only accessible to that user.
3. **Encryption** - All secrets are encrypted using AES-256-GCM before storage.
4. **Minimal Exposure** - Decrypted secrets are only held in memory temporarily during tool calls.

## Usage Examples

### Calling a Tool with User-specific Secrets

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

### Setting a User-specific Secret

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

### Deleting a User-specific Secret

```http
POST /secrets/delete
Content-Type: application/json

{
  "username": "user123",
  "serverName": "mcp-github",
  "secretName": "GITHUB_TOKEN"
}
```

## Considerations/Open Questions

- How to implement proper authentication and authorization?
- Should we support user groups or roles for shared access to secrets?
- How to handle user management (creation, deletion, etc.)?
- Should we implement usage quotas or rate limiting per user?

## AI Assistance Notes
- Model Used: Claude 3 Opus
- Prompt: Nexus System onboarding for MCP API project
- Date Generated: 2025-03-23

## Related Nexus Documents
- [System Overview](../architecture/system_overview.md)
- [Secret Management](../architecture/secret_management.md)
- [MCP Controller](../architecture/mcp_controller.md)
- [Secure Secret Management Feature](./secure_secret_management.md)
