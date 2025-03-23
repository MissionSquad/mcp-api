# Feature: Package Management

## Context
Installing and configuring MCP servers can be complex, requiring manual installation of npm packages, configuration of environment variables, and management of server lifecycle. The Package Management feature simplifies this process by providing a unified interface for installing, configuring, and managing MCP server packages.

## Goal
Provide a robust, user-friendly system for managing MCP server packages, ensuring proper installation, configuration, and lifecycle management.

## Implementation Details

### Package Installation

The Package Management feature provides an API endpoint for installing MCP server packages:

```http
POST /packages/install
Content-Type: application/json

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

This endpoint:

1. Validates the package name to prevent command injection
2. Creates a dedicated directory for the package
3. Initializes a package.json file
4. Installs the specified npm package
5. Determines the appropriate run command and arguments
6. Registers the package as an MCP server
7. Tracks the installation in the database

```typescript
// In PackageService.installPackage
async installPackage(request: InstallPackageRequest): Promise<{
  success: boolean;
  package?: PackageInfo;
  server?: MCPServer;
  error?: string;
}> {
  const { name, version, serverName, command, args = [], env = {}, enabled = true } = request;
  
  // Validate package name to prevent command injection
  if (!/^[@a-z0-9-_\/\.]+$/.test(name)) {
    return { 
      success: false, 
      error: `Invalid package name: ${name}. Package names must match npm naming conventions.` 
    };
  }
  
  // Create package directory
  const sanitizedDirName = name.replace('@', '').replace(/\//g, '-');
  const packageDir = path.join(this.packagesDir, sanitizedDirName);
  const relativeInstallPath = path.relative(process.cwd(), packageDir);
  
  // Initialize package info
  const packageInfo: PackageInfo = {
    name,
    version: version || 'latest',
    installPath: relativeInstallPath,
    status: 'installing',
    installed: new Date()
  };
  
  try {
    // Save initial package info
    await this.packagesDBClient.upsert(packageInfo, { name });
    
    // Create directory and initialize package
    await mkdir(packageDir, { recursive: true });
    
    // Initialize package.json
    await exec('npm init -y', { cwd: packageDir });
    
    // Install the package
    const installCmd = `npm install ${name}${version ? '@' + version : ''}`;
    await exec(installCmd, { cwd: packageDir });
    
    // Determine run command
    let finalCommand = command;
    if (!finalCommand) {
      // Auto-detect command based on package.json
      // ...
    }
    
    // Register as MCP server
    const server = await this.mcpService.addServer({
      name: serverName,
      command: finalCommand,
      args,
      env,
      enabled
    });
    
    // Update package info with success
    packageInfo.status = 'installed';
    packageInfo.mcpServerId = serverName;
    packageInfo.enabled = enabled;
    await this.packagesDBClient.update(packageInfo, { name });
    
    return { success: true, package: packageInfo, server };
  } catch (error: any) {
    // Handle error, update package status
    packageInfo.status = 'error';
    packageInfo.error = error.message;
    await this.packagesDBClient.update(packageInfo, { name });
    
    return { success: false, error: error.message };
  }
}
```

### Package Management

The Package Management feature provides API endpoints for managing installed packages:

- `GET /packages` - List all installed packages
- `GET /packages/by-name/:name` - Get a package by name
- `GET /packages/by-id/:name` - Get a package by server ID
- `DELETE /packages/:name` - Uninstall a package
- `PUT /packages/:name/enable` - Enable a package
- `PUT /packages/:name/disable` - Disable a package

These endpoints allow users to:

1. View installed packages and their status
2. Uninstall packages when they are no longer needed
3. Enable or disable packages without uninstalling them

### Auto-Installation

The Package Management feature supports auto-installation of predefined packages on first run:

```typescript
// In env.ts
export const env = {
  // ...
  INSTALL_ON_START: (process.env.INSTALL_ON_START || '@missionsquad/mcp-github|github,@missionsquad/mcp-helper-tools|helper-tools').split(',').map((pkg) => {
    const [repo, name] = pkg.split('|')
    return { repo, name }
  })
}
```

```typescript
// In PackagesController.init
public async init(): Promise<void> {
  await this.packageService.init()
  await this.appStateDBClient.connect('appState')
  
  // Check if this is the first run
  const isFirstRun = await this.isFirstRun()
  
  if (isFirstRun) {
    log({ level: 'info', msg: 'First run detected, installing predefined MCP servers' })
    await this.installPredefinedPackages()
    
    // Mark first run as completed
    await this.markFirstRunCompleted()
  }
  
  log({ level: 'info', msg: 'PackagesController initialized' })
}
```

This ensures that essential MCP servers are automatically installed and configured when the MCP API is first run.

### Uninstallation Tracking

The Package Management feature tracks uninstalled packages to prevent auto-reinstallation:

```typescript
// In PackagesController.markPackageAsUninstalled
private async markPackageAsUninstalled(serverName: string): Promise<void> {
  const appState = await this.appStateDBClient.findOne({})
  if (!appState || !appState.installedPackages) {
    return
  }
  
  // Find the package by server name
  const packageIndex = appState.installedPackages.findIndex(pkg => pkg.serverName === serverName)
  if (packageIndex >= 0) {
    appState.installedPackages[packageIndex].uninstalled = true
    await this.appStateDBClient.update(appState, { _id: appState._id })
    log({ level: 'info', msg: `Marked package with server name ${serverName} as uninstalled` })
  }
}
```

This ensures that if a user uninstalls a package, it won't be automatically reinstalled on subsequent runs.

### Missing Package Installation

The Package Management feature can attempt to install missing packages when an MCP server fails to start:

```typescript
// In MCPService.startMCPServer
try {
  // Start server...
} catch (error: any) {
  log({ level: 'error', msg: `Failed to start server ${server.name}: ${error.message}` })
  
  // Attempt to install missing package if PackageService is available
  let installSuccess = false;
  if (this.packageService) {
    log({ level: 'info', msg: `Attempting to install missing package for server ${server.name}` });
    installSuccess = await this.packageService.installMissingPackage(server.name);
  }
  
  // If installation failed or no PackageService, mark as disabled
  if (!installSuccess) {
    // Mark server as disabled in the database
    server.enabled = false;
    await this.mcpDBClient.update(server, { name: server.name });
    log({ level: 'info', msg: `Server ${server.name} has been disabled due to startup failure` });
  }
}
```

This provides a self-healing mechanism for MCP servers that might be missing their underlying packages.

## Usage Examples

### Installing a Package

```http
POST /packages/install
Content-Type: application/json

{
  "name": "@missionsquad/mcp-github",
  "serverName": "github",
  "env": {
    "NODE_ENV": "production"
  }
}
```

Response:
```json
{
  "success": true,
  "package": {
    "name": "@missionsquad/mcp-github",
    "version": "latest",
    "installPath": "packages/missionsquad-mcp-github",
    "status": "installed",
    "installed": "2025-03-23T08:00:00.000Z",
    "mcpServerId": "github",
    "enabled": true
  },
  "server": {
    "name": "github",
    "command": "node",
    "args": ["./packages/missionsquad-mcp-github/node_modules/@missionsquad/mcp-github/build/index.js"],
    "env": {
      "NODE_ENV": "production"
    },
    "status": "connected",
    "enabled": true
  }
}
```

### Listing Installed Packages

```http
GET /packages
```

Response:
```json
{
  "success": true,
  "packages": [
    {
      "name": "@missionsquad/mcp-github",
      "version": "latest",
      "installPath": "packages/missionsquad-mcp-github",
      "status": "installed",
      "installed": "2025-03-23T08:00:00.000Z",
      "mcpServerId": "github",
      "enabled": true
    },
    {
      "name": "@missionsquad/mcp-helper-tools",
      "version": "latest",
      "installPath": "packages/missionsquad-mcp-helper-tools",
      "status": "installed",
      "installed": "2025-03-23T08:00:00.000Z",
      "mcpServerId": "helper-tools",
      "enabled": true
    }
  ]
}
```

### Uninstalling a Package

```http
DELETE /packages/github
```

Response:
```json
{
  "success": true
}
```

## Security Considerations

1. **Input Validation** - Package names are validated to prevent command injection
2. **File System Isolation** - Package files are isolated in a dedicated directory
3. **Environment Variables** - Sensitive environment variables should be set using the Secret Management feature, not in the package installation request

## Considerations/Open Questions

- How to handle package versioning and updates?
- Should we implement a more robust package dependency management system?
- How to handle conflicts between packages?
- Should we implement a package repository for custom MCP servers?

## AI Assistance Notes
- Model Used: Claude 3 Opus
- Prompt: Nexus System onboarding for MCP API project
- Date Generated: 2025-03-23

## Related Nexus Documents
- [System Overview](../architecture/system_overview.md)
- [Packages Controller](../architecture/packages_controller.md)
- [MCP Controller](../architecture/mcp_controller.md)
- [HTTP API Feature](./http_api.md)
