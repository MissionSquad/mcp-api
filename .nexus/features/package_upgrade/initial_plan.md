# Feature: Package Upgrade

## Context
- The MCP API currently supports installing, uninstalling, enabling, and disabling packages.
- Packages are installed using npm and registered as MCP servers.
- There is currently no way to upgrade packages to newer versions once they are installed.
- [Link to system architecture](.nexus/architecture/system_overview.md)
- [Link to packages controller architecture](.nexus/architecture/packages_controller.md)

## Goal
Implement a feature that allows:
1. Upgrading all installed packages to their latest versions
2. Upgrading a specific package to its latest version or a specified version
3. Including package version information with package information in existing endpoints

## Plan

### 1. Enhance Data Models
- Update the `PackageInfo` interface to include latest version information
- Add fields to track update availability

### 2. Implement Core Functionality in PackageService
- Add method to check for available updates for a specific package or all packages
- Add method to upgrade a specific package to latest or specified version
- Add method to upgrade all packages to their latest versions
- Implement version comparison logic using semantic versioning

### 3. Add API Endpoints
- Add endpoint to check for available updates: `GET /packages/updates`
- Add endpoint to upgrade a specific package: `PUT /packages/:name/upgrade`
- Add endpoint to upgrade all packages: `PUT /packages/upgrade-all`
- Update existing endpoints to include version information

### 4. Implement Upgrade Process
- Temporarily disable the MCP server during upgrade
- Perform the npm upgrade
- Update server configuration if necessary
- Re-enable the server
- Update package information in the database

### 5. Error Handling and Rollback
- Implement comprehensive error handling for npm installation failures
- Consider implementing a rollback mechanism for failed upgrades

### 6. Testing
- Test upgrading packages with and without version specifications
- Test upgrading all packages
- Test error handling and edge cases

## Code Snippets

### PackageInfo Interface Update
```typescript
export interface PackageInfo {
  name: string;
  version: string;
  latestVersion?: string; // New field to track latest available version
  updateAvailable?: boolean; // New field to indicate if an update is available
  installPath: string;
  main?: string;
  status: 'installed' | 'installing' | 'error';
  installed: Date;
  lastUsed?: Date;
  error?: string;
  mcpServerId?: string;
  enabled?: boolean;
}
```

### New Methods in PackageService
```typescript
// Check for available updates
async checkForUpdates(serverName?: string): Promise<{
  updates: Array<{
    serverName: string;
    currentVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
  }>;
}>

// Upgrade a specific package
async upgradePackage(serverName: string, version?: string): Promise<{
  success: boolean;
  package?: PackageInfo;
  server?: MCPServer;
  error?: string;
}>

// Upgrade all packages
async upgradeAllPackages(): Promise<{
  success: boolean;
  results: Array<{
    serverName: string;
    success: boolean;
    error?: string;
  }>;
}>
```

### New API Endpoints
```typescript
// In registerRoutes method of PackagesController
this.app.get('/packages/updates', this.checkForUpdates.bind(this))
this.app.put('/packages/:name/upgrade', this.upgradePackage.bind(this))
this.app.put('/packages/upgrade-all', this.upgradeAllPackages.bind(this))
```

## API Details

### Check for Updates
```
GET /packages/updates
Response: { 
  "updates": [
    { 
      "serverName": "server1", 
      "currentVersion": "1.0.0", 
      "latestVersion": "1.1.0", 
      "updateAvailable": true 
    },
    { 
      "serverName": "server2", 
      "currentVersion": "2.0.0", 
      "latestVersion": "2.0.0", 
      "updateAvailable": false 
    }
  ]
}
```

### Upgrade a Package
```
PUT /packages/:name/upgrade
Request Body: { "version": "optional-specific-version" }
Response: { 
  "success": true, 
  "package": { ... updated package info ... },
  "server": { ... updated server info ... }
}
```

### Upgrade All Packages
```
PUT /packages/upgrade-all
Response: { 
  "success": true, 
  "results": [
    { "serverName": "server1", "success": true },
    { "serverName": "server2", "success": false, "error": "Error message" }
  ]
}
```

## Considerations/Open Questions
- How should we handle dependencies that might change between versions?
- Should we implement a rollback mechanism for failed upgrades?
- How should we handle breaking changes in newer versions?
- Should we add a way to preview changes before upgrading?
- How should we handle version conflicts between packages?

## AI Assistance Notes
- Model Used: Claude 3 Opus
- Prompt: Plan a new feature that allows installed packages to be upgraded
- Date Generated: 2025-03-23

## Related Nexus Documents
- [System Overview](.nexus/architecture/system_overview.md)
- [Packages Controller](.nexus/architecture/packages_controller.md)
