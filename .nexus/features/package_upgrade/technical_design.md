# Technical Design: Package Upgrade Feature

## Context
This document provides detailed technical design for implementing the package upgrade feature in the MCP API. It builds upon the initial plan and provides specific implementation details.

## Implementation Details

### 1. Data Model Updates

#### PackageInfo Interface Update
```typescript
export interface PackageInfo {
  name: string;
  version: string;
  latestVersion?: string; // New field to track latest available version
  updateAvailable?: boolean; // New field to indicate if an update is available
  installPath: string;
  main?: string;
  status: 'installed' | 'installing' | 'upgrading' | 'error'; // Added 'upgrading' status
  installed: Date;
  lastUpgraded?: Date; // New field to track last upgrade date
  lastUsed?: Date;
  error?: string;
  mcpServerId?: string;
  enabled?: boolean;
}
```

### 2. Core Service Implementation

#### Version Comparison Utility
```typescript
/**
 * Compare two semantic version strings
 * @param version1 First version string (e.g., "1.2.3")
 * @param version2 Second version string (e.g., "1.3.0")
 * @returns -1 if version1 < version2, 0 if version1 == version2, 1 if version1 > version2
 */
function compareVersions(version1: string, version2: string): number {
  const v1Parts = version1.split('.').map(Number);
  const v2Parts = version2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const v1Part = v1Parts[i] || 0;
    const v2Part = v2Parts[i] || 0;
    
    if (v1Part > v2Part) return 1;
    if (v1Part < v2Part) return -1;
  }
  
  return 0;
}
```

#### Check for Updates Method
```typescript
/**
 * Check for available updates for a specific package or all packages
 * @param serverName Optional server name to check for updates
 * @returns Object containing update information for packages
 */
async checkForUpdates(serverName?: string): Promise<{
  updates: Array<{
    serverName: string;
    currentVersion: string;
    latestVersion: string;
    updateAvailable: boolean;
  }>;
}> {
  try {
    // Get packages to check
    let packages: PackageInfo[];
    if (serverName) {
      const pkg = await this.packagesDBClient.findOne({ mcpServerId: serverName });
      packages = pkg ? [pkg] : [];
    } else {
      packages = await this.packagesDBClient.find({});
    }
    
    const updates = [];
    
    // Check each package for updates
    for (const pkg of packages) {
      try {
        // Get the latest version from npm registry
        const npmInfoCmd = `npm view ${pkg.name} version`;
        const { stdout } = await exec(npmInfoCmd, { cwd: process.cwd() });
        const latestVersion = stdout.trim();
        
        // Compare versions
        const updateAvailable = compareVersions(pkg.version, latestVersion) < 0;
        
        // Update package info in database with latest version info
        pkg.latestVersion = latestVersion;
        pkg.updateAvailable = updateAvailable;
        await this.packagesDBClient.update(pkg, { mcpServerId: pkg.mcpServerId });
        
        updates.push({
          serverName: pkg.mcpServerId!,
          currentVersion: pkg.version,
          latestVersion,
          updateAvailable
        });
      } catch (error: any) {
        log({ level: 'error', msg: `Error checking updates for ${pkg.name}: ${error.message}` });
        updates.push({
          serverName: pkg.mcpServerId!,
          currentVersion: pkg.version,
          latestVersion: 'unknown',
          updateAvailable: false
        });
      }
    }
    
    return { updates };
  } catch (error: any) {
    log({ level: 'error', msg: `Error checking for updates: ${error.message}` });
    return { updates: [] };
  }
}
```

#### Upgrade Package Method
```typescript
/**
 * Upgrade a package to the latest version or a specified version
 * @param serverName The name of the server to upgrade
 * @param version Optional specific version to upgrade to
 * @returns Result of the upgrade operation
 */
async upgradePackage(serverName: string, version?: string): Promise<{
  success: boolean;
  package?: PackageInfo;
  server?: MCPServer;
  error?: string;
}> {
  try {
    // Get package info
    const packageInfo = await this.packagesDBClient.findOne({ mcpServerId: serverName });
    if (!packageInfo) {
      return { success: false, error: `Package ${serverName} not found` };
    }
    
    // Update status to upgrading
    packageInfo.status = 'upgrading';
    await this.packagesDBClient.update(packageInfo, { mcpServerId: serverName });
    
    // Get server info
    const server = await this.mcpService.getServer(serverName);
    if (!server) {
      packageInfo.status = 'error';
      packageInfo.error = `Server ${serverName} not found`;
      await this.packagesDBClient.update(packageInfo, { mcpServerId: serverName });
      return { success: false, error: packageInfo.error };
    }
    
    // Disable server temporarily
    const wasEnabled = server.enabled;
    if (wasEnabled) {
      await this.mcpService.disableServer(serverName);
    }
    
    try {
      // Get the absolute path to the package directory
      const packageDir = path.resolve(process.cwd(), packageInfo.installPath);
      
      // Perform the upgrade
      const upgradeCmd = `npm install ${packageInfo.name}${version ? '@' + version : '@latest'}`;
      log({ level: 'info', msg: `Upgrading package: ${upgradeCmd}` });
      const upgradeResult = await exec(upgradeCmd, { cwd: packageDir });
      
      if (upgradeResult.stderr && !upgradeResult.stderr.includes('npm notice') && !upgradeResult.stderr.includes('npm WARN')) {
        throw new Error(`Error upgrading package: ${upgradeResult.stderr}`);
      }
      
      // Get the new version from package.json
      const nodeModulesPackageJsonPath = path.join(packageDir, 'node_modules', packageInfo.name, 'package.json');
      const nodeModulesPackageJson = JSON.parse(await readFile(nodeModulesPackageJsonPath, 'utf8'));
      const newVersion = nodeModulesPackageJson.version;
      
      // Update package info
      packageInfo.version = newVersion;
      packageInfo.status = 'installed';
      packageInfo.lastUpgraded = new Date();
      packageInfo.updateAvailable = false;
      
      // Check if the package structure has changed
      let serverUpdateNeeded = false;
      let newCommand = server.command;
      let newArgs = [...server.args];
      
      // Check if the package has bin entries
      if (nodeModulesPackageJson.bin) {
        // If bin is a string, use that
        if (typeof nodeModulesPackageJson.bin === 'string') {
          newCommand = 'node';
          // Replace the first arg with the new path
          if (newArgs.length > 0) {
            const relativePackageDir = path.relative(process.cwd(), packageDir);
            newArgs[0] = `./${path.join(relativePackageDir, 'node_modules', packageInfo.name, nodeModulesPackageJson.bin)}`;
            serverUpdateNeeded = true;
          }
        } 
        // If bin is an object, use the first entry
        else if (typeof nodeModulesPackageJson.bin === 'object') {
          const binName = Object.keys(nodeModulesPackageJson.bin)[0];
          newCommand = 'node';
          // Replace the first arg with the new path
          if (newArgs.length > 0) {
            const relativePackageDir = path.relative(process.cwd(), packageDir);
            newArgs[0] = `./${path.join(relativePackageDir, 'node_modules', packageInfo.name, nodeModulesPackageJson.bin[binName])}`;
            serverUpdateNeeded = true;
          }
        }
      } 
      // Fall back to main file
      else if (nodeModulesPackageJson.main) {
        newCommand = 'node';
        // Replace the first arg with the new path
        if (newArgs.length > 0) {
          const relativePackageDir = path.relative(process.cwd(), packageDir);
          newArgs[0] = `./${path.join(relativePackageDir, 'node_modules', packageInfo.name, nodeModulesPackageJson.main)}`;
          serverUpdateNeeded = true;
        }
      }
      
      // Update server configuration if needed
      let updatedServer = server;
      if (serverUpdateNeeded) {
        updatedServer = await this.mcpService.updateServer(serverName, {
          command: newCommand,
          args: newArgs
        });
      }
      
      // Re-enable server if it was enabled before
      if (wasEnabled) {
        updatedServer = await this.mcpService.enableServer(serverName);
      }
      
      // Update package info in database
      await this.packagesDBClient.update(packageInfo, { mcpServerId: serverName });
      
      return { 
        success: true, 
        package: packageInfo, 
        server: updatedServer 
      };
    } catch (error: any) {
      // Handle error, update package status
      log({ level: 'error', msg: `Error upgrading package ${packageInfo.name}: ${error.message}` });
      packageInfo.status = 'error';
      packageInfo.error = error.message;
      await this.packagesDBClient.update(packageInfo, { mcpServerId: serverName });
      
      // Try to re-enable server if it was enabled before
      if (wasEnabled) {
        try {
          await this.mcpService.enableServer(serverName);
        } catch (enableError: any) {
          log({ level: 'error', msg: `Error re-enabling server ${serverName} after failed upgrade: ${enableError.message}` });
        }
      }
      
      return { success: false, error: error.message };
    }
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
```

#### Upgrade All Packages Method
```typescript
/**
 * Upgrade all packages to their latest versions
 * @returns Results of the upgrade operations
 */
async upgradeAllPackages(): Promise<{
  success: boolean;
  results: Array<{
    serverName: string;
    success: boolean;
    error?: string;
  }>;
}> {
  try {
    // Get all packages
    const packages = await this.packagesDBClient.find({});
    const results = [];
    let overallSuccess = true;
    
    // Upgrade each package
    for (const pkg of packages) {
      if (!pkg.mcpServerId) continue;
      
      try {
        const result = await this.upgradePackage(pkg.mcpServerId);
        results.push({
          serverName: pkg.mcpServerId,
          success: result.success,
          error: result.error
        });
        
        if (!result.success) {
          overallSuccess = false;
        }
      } catch (error: any) {
        results.push({
          serverName: pkg.mcpServerId,
          success: false,
          error: error.message
        });
        overallSuccess = false;
      }
    }
    
    return {
      success: overallSuccess,
      results
    };
  } catch (error: any) {
    log({ level: 'error', msg: `Error upgrading all packages: ${error.message}` });
    return {
      success: false,
      results: []
    };
  }
}
```

### 3. Controller Implementation

#### Check for Updates Endpoint
```typescript
/**
 * Check for available updates for packages
 * @param req Express request
 * @param res Express response
 * @param next Express next function
 */
private async checkForUpdates(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const serverName = req.query.name as string | undefined;
    const updates = await this.packageService.checkForUpdates(serverName);
    res.json({ success: true, ...updates });
  } catch (error: any) {
    log({ level: 'error', msg: `Error checking for updates: ${error.message}` });
    res.status(500).json({ success: false, error: error.message });
  }
}
```

#### Upgrade Package Endpoint
```typescript
/**
 * Upgrade a package to the latest version or a specified version
 * @param req Express request
 * @param res Express response
 * @param next Express next function
 */
private async upgradePackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const serverName = req.params.name;
    const version = req.body.version as string | undefined;
    
    log({ level: 'info', msg: `Upgrading package ${serverName}${version ? ' to version ' + version : ''}` });
    
    const result = await this.packageService.upgradePackage(serverName, version);
    if (result.success) {
      res.json({ 
        success: true, 
        package: result.package, 
        server: result.server 
      });
    } else {
      res.status(400).json({ 
        success: false, 
        error: result.error 
      });
    }
  } catch (error: any) {
    log({ level: 'error', msg: `Error upgrading package: ${error.message}` });
    res.status(500).json({ success: false, error: error.message });
  }
}
```

#### Upgrade All Packages Endpoint
```typescript
/**
 * Upgrade all packages to their latest versions
 * @param req Express request
 * @param res Express response
 * @param next Express next function
 */
private async upgradeAllPackages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    log({ level: 'info', msg: 'Upgrading all packages' });
    
    const result = await this.packageService.upgradeAllPackages();
    res.json({ 
      success: result.success, 
      results: result.results 
    });
  } catch (error: any) {
    log({ level: 'error', msg: `Error upgrading all packages: ${error.message}` });
    res.status(500).json({ success: false, error: error.message });
  }
}
```

#### Update to registerRoutes Method
```typescript
public registerRoutes(): void {
  this.app.post('/packages/install', this.installPackage.bind(this))
  this.app.get('/packages', this.getPackages.bind(this))
  this.app.get('/packages/by-name/:name', this.getPackage.bind(this))
  this.app.get('/packages/by-id/:name', this.getPackageById.bind(this))
  this.app.delete('/packages/:name', this.uninstallPackage.bind(this))
  this.app.put('/packages/:name/enable', this.enablePackage.bind(this))
  this.app.put('/packages/:name/disable', this.disablePackage.bind(this))
  
  // New endpoints for package upgrades
  this.app.get('/packages/updates', this.checkForUpdates.bind(this))
  this.app.put('/packages/:name/upgrade', this.upgradePackage.bind(this))
  this.app.put('/packages/upgrade-all', this.upgradeAllPackages.bind(this))
  
  log({ level: 'info', msg: 'PackagesController routes registered' })
}
```

### 4. Update to Existing Endpoints

#### Update to getPackages Method
```typescript
private async getPackages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const packages = await this.packageService.getPackages();
    
    // Check for updates if requested
    if (req.query.checkUpdates === 'true') {
      await this.packageService.checkForUpdates();
    }
    
    res.json({ success: true, packages });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
}
```

#### Update to getPackage Method
```typescript
private async getPackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const name = req.params.name;
    const packageInfo = await this.packageService.getPackage(name);
    
    if (!packageInfo) {
      res.status(404).json({ success: false, error: `Package ${name} not found` });
      return;
    }
    
    // Check for updates if requested
    if (req.query.checkUpdates === 'true' && packageInfo.mcpServerId) {
      await this.packageService.checkForUpdates(packageInfo.mcpServerId);
      // Refresh package info after update check
      const updatedPackageInfo = await this.packageService.getPackage(name);
      if (updatedPackageInfo) {
        res.json({ success: true, package: updatedPackageInfo });
        return;
      }
    }
    
    res.json({ success: true, package: packageInfo });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
}
```

## Error Handling Strategy

1. **Validation Errors**
   - Validate input parameters before processing
   - Return 400 Bad Request for invalid inputs

2. **Package Not Found Errors**
   - Check if package exists before attempting operations
   - Return 404 Not Found if package doesn't exist

3. **Upgrade Failures**
   - Catch and log npm installation errors
   - Update package status to 'error' with error message
   - Attempt to restore previous state (re-enable server if it was enabled)
   - Return detailed error information to client

4. **Server Communication Errors**
   - Handle errors when communicating with MCP servers
   - Log detailed error information
   - Return appropriate error response to client

## Rollback Strategy

For the initial implementation, we'll use a simple rollback strategy:

1. If a package upgrade fails, we'll:
   - Set the package status to 'error'
   - Store the error message
   - Re-enable the server if it was enabled before the upgrade

For a more robust rollback mechanism in the future, we could:
1. Back up the package directory before upgrading
2. If the upgrade fails, restore from the backup
3. Track version history to allow explicit rollback to previous versions

## Testing Strategy

1. **Unit Tests**
   - Test version comparison utility
   - Test package upgrade logic with mocked dependencies

2. **Integration Tests**
   - Test the full upgrade flow with test packages
   - Test error handling and recovery

3. **Edge Cases**
   - Test upgrading packages with complex dependencies
   - Test upgrading packages with breaking changes
   - Test upgrading packages with changed entry points

## AI Assistance Notes
- Model Used: Claude 3 Opus
- Prompt: Create technical design for package upgrade feature
- Date Generated: 2025-03-23

## Related Nexus Documents
- [Package Upgrade Feature Plan](.nexus/features/package_upgrade/initial_plan.md)
- [System Overview](.nexus/architecture/system_overview.md)
- [Packages Controller](.nexus/architecture/packages_controller.md)
