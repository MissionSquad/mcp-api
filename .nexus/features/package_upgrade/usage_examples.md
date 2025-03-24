# Package Upgrade Feature: Usage Examples

## Context
This document provides practical usage examples for the package upgrade feature in the MCP API. It demonstrates how to use the new endpoints to check for updates, upgrade specific packages, and upgrade all packages.

## API Usage Examples

### Checking for Available Updates

#### Check for Updates for All Packages

```bash
# Using curl
curl -X GET "http://localhost:8080/packages/updates"

# Using JavaScript fetch
fetch("http://localhost:8080/packages/updates")
  .then(response => response.json())
  .then(data => console.log(data));
```

Example Response:
```json
{
  "success": true,
  "updates": [
    {
      "serverName": "mcp-github",
      "currentVersion": "1.0.0",
      "latestVersion": "1.1.0",
      "updateAvailable": true
    },
    {
      "serverName": "mcp-weather",
      "currentVersion": "2.0.0",
      "latestVersion": "2.0.0",
      "updateAvailable": false
    }
  ]
}
```

#### Check for Updates for a Specific Package

```bash
# Using curl
curl -X GET "http://localhost:8080/packages/updates?name=mcp-github"

# Using JavaScript fetch
fetch("http://localhost:8080/packages/updates?name=mcp-github")
  .then(response => response.json())
  .then(data => console.log(data));
```

Example Response:
```json
{
  "success": true,
  "updates": [
    {
      "serverName": "mcp-github",
      "currentVersion": "1.0.0",
      "latestVersion": "1.1.0",
      "updateAvailable": true
    }
  ]
}
```

### Upgrading a Specific Package

#### Upgrade to Latest Version

```bash
# Using curl
curl -X PUT "http://localhost:8080/packages/mcp-github/upgrade"

# Using JavaScript fetch
fetch("http://localhost:8080/packages/mcp-github/upgrade", {
  method: "PUT"
})
  .then(response => response.json())
  .then(data => console.log(data));
```

Example Response:
```json
{
  "success": true,
  "package": {
    "name": "mcp-github",
    "version": "1.1.0",
    "latestVersion": "1.1.0",
    "updateAvailable": false,
    "installPath": "/path/to/package",
    "status": "installed",
    "installed": "2025-03-01T12:00:00Z",
    "lastUpgraded": "2025-03-23T21:30:00Z",
    "mcpServerId": "mcp-github",
    "enabled": true
  },
  "server": {
    "name": "mcp-github",
    "command": "node",
    "args": ["./path/to/index.js"],
    "enabled": true
  }
}
```

#### Upgrade to Specific Version

```bash
# Using curl
curl -X PUT "http://localhost:8080/packages/mcp-github/upgrade" \
  -H "Content-Type: application/json" \
  -d '{"version": "1.0.5"}'

# Using JavaScript fetch
fetch("http://localhost:8080/packages/mcp-github/upgrade", {
  method: "PUT",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    version: "1.0.5"
  })
})
  .then(response => response.json())
  .then(data => console.log(data));
```

Example Response:
```json
{
  "success": true,
  "package": {
    "name": "mcp-github",
    "version": "1.0.5",
    "latestVersion": "1.1.0",
    "updateAvailable": true,
    "installPath": "/path/to/package",
    "status": "installed",
    "installed": "2025-03-01T12:00:00Z",
    "lastUpgraded": "2025-03-23T21:35:00Z",
    "mcpServerId": "mcp-github",
    "enabled": true
  },
  "server": {
    "name": "mcp-github",
    "command": "node",
    "args": ["./path/to/index.js"],
    "enabled": true
  }
}
```

### Upgrading All Packages

```bash
# Using curl
curl -X PUT "http://localhost:8080/packages/upgrade-all"

# Using JavaScript fetch
fetch("http://localhost:8080/packages/upgrade-all", {
  method: "PUT"
})
  .then(response => response.json())
  .then(data => console.log(data));
```

Example Response:
```json
{
  "success": true,
  "results": [
    {
      "serverName": "mcp-github",
      "success": true
    },
    {
      "serverName": "mcp-weather",
      "success": true
    },
    {
      "serverName": "mcp-filesystem",
      "success": false,
      "error": "Error upgrading package: npm install failed"
    }
  ]
}
```

### Getting Package Information with Version Details

#### List All Packages with Update Check

```bash
# Using curl
curl -X GET "http://localhost:8080/packages?checkUpdates=true"

# Using JavaScript fetch
fetch("http://localhost:8080/packages?checkUpdates=true")
  .then(response => response.json())
  .then(data => console.log(data));
```

Example Response:
```json
{
  "success": true,
  "packages": [
    {
      "name": "mcp-github",
      "version": "1.0.5",
      "latestVersion": "1.1.0",
      "updateAvailable": true,
      "installPath": "/path/to/package",
      "status": "installed",
      "installed": "2025-03-01T12:00:00Z",
      "lastUpgraded": "2025-03-23T21:35:00Z",
      "mcpServerId": "mcp-github",
      "enabled": true
    },
    {
      "name": "mcp-weather",
      "version": "2.0.0",
      "latestVersion": "2.0.0",
      "updateAvailable": false,
      "installPath": "/path/to/package",
      "status": "installed",
      "installed": "2025-03-10T15:00:00Z",
      "lastUpgraded": "2025-03-23T21:40:00Z",
      "mcpServerId": "mcp-weather",
      "enabled": true
    }
  ]
}
```

#### Get Specific Package with Update Check

```bash
# Using curl
curl -X GET "http://localhost:8080/packages/by-id/mcp-github?checkUpdates=true"

# Using JavaScript fetch
fetch("http://localhost:8080/packages/by-id/mcp-github?checkUpdates=true")
  .then(response => response.json())
  .then(data => console.log(data));
```

Example Response:
```json
{
  "success": true,
  "package": {
    "name": "mcp-github",
    "version": "1.0.5",
    "latestVersion": "1.1.0",
    "updateAvailable": true,
    "installPath": "/path/to/package",
    "status": "installed",
    "installed": "2025-03-01T12:00:00Z",
    "lastUpgraded": "2025-03-23T21:35:00Z",
    "mcpServerId": "mcp-github",
    "enabled": true
  }
}
```

## Common Use Cases

### Automated Update Workflow

This example demonstrates how to implement an automated update workflow using the package upgrade API:

```javascript
// Check for updates for all packages
async function checkAndUpgradePackages() {
  try {
    // Step 1: Check for available updates
    const updatesResponse = await fetch("http://localhost:8080/packages/updates");
    const updatesData = await updatesResponse.json();
    
    if (!updatesData.success) {
      console.error("Failed to check for updates:", updatesData.error);
      return;
    }
    
    // Step 2: Filter packages that have updates available
    const packagesToUpgrade = updatesData.updates
      .filter(update => update.updateAvailable)
      .map(update => update.serverName);
    
    console.log(`Found ${packagesToUpgrade.length} packages to upgrade`);
    
    // Step 3: Upgrade each package one by one
    for (const packageName of packagesToUpgrade) {
      console.log(`Upgrading ${packageName}...`);
      
      const upgradeResponse = await fetch(`http://localhost:8080/packages/${packageName}/upgrade`, {
        method: "PUT"
      });
      
      const upgradeData = await upgradeResponse.json();
      
      if (upgradeData.success) {
        console.log(`Successfully upgraded ${packageName} to version ${upgradeData.package.version}`);
      } else {
        console.error(`Failed to upgrade ${packageName}: ${upgradeData.error}`);
      }
    }
    
    console.log("Package upgrade process completed");
  } catch (error) {
    console.error("Error during package upgrade process:", error);
  }
}

// Call the function to start the upgrade process
checkAndUpgradePackages();
```

### Scheduled Updates with Notification

This example shows how to implement a scheduled update check that sends notifications when updates are available:

```javascript
// Function to check for updates and send notifications
async function checkForUpdatesAndNotify() {
  try {
    // Check for available updates
    const response = await fetch("http://localhost:8080/packages/updates");
    const data = await response.json();
    
    if (!data.success) {
      console.error("Failed to check for updates:", data.error);
      return;
    }
    
    // Filter packages with updates available
    const packagesWithUpdates = data.updates.filter(update => update.updateAvailable);
    
    if (packagesWithUpdates.length > 0) {
      // Send notification (this is a placeholder - implement your notification method)
      sendNotification({
        title: "MCP Package Updates Available",
        message: `${packagesWithUpdates.length} packages have updates available.`,
        details: packagesWithUpdates.map(pkg => 
          `${pkg.serverName}: ${pkg.currentVersion} → ${pkg.latestVersion}`
        ).join("\n")
      });
    }
  } catch (error) {
    console.error("Error checking for updates:", error);
  }
}

// Function to send a notification (placeholder)
function sendNotification(notification) {
  console.log("NOTIFICATION:", notification.title);
  console.log(notification.message);
  console.log(notification.details);
  
  // Implement your actual notification method here
  // (e.g., email, Slack message, system notification)
}

// Schedule update checks (e.g., once a day)
// In a real implementation, you would use a proper scheduler
setInterval(checkForUpdatesAndNotify, 24 * 60 * 60 * 1000);

// Also run immediately on startup
checkForUpdatesAndNotify();
```

## Error Handling Examples

### Handling Upgrade Failures

```javascript
async function upgradePackageWithErrorHandling(packageName) {
  try {
    const response = await fetch(`http://localhost:8080/packages/${packageName}/upgrade`, {
      method: "PUT"
    });
    
    const data = await response.json();
    
    if (data.success) {
      console.log(`Successfully upgraded ${packageName} to version ${data.package.version}`);
      return true;
    } else {
      console.error(`Failed to upgrade ${packageName}: ${data.error}`);
      
      // Check if the package is in error state
      const packageResponse = await fetch(`http://localhost:8080/packages/by-id/${packageName}`);
      const packageData = await packageResponse.json();
      
      if (packageData.success && packageData.package.status === 'error') {
        console.log(`Package ${packageName} is in error state. Error: ${packageData.package.error}`);
        
        // Implement recovery logic here
        // For example, you might want to disable the package temporarily
        await fetch(`http://localhost:8080/packages/${packageName}/disable`, {
          method: "PUT"
        });
        
        console.log(`Disabled package ${packageName} due to upgrade failure`);
      }
      
      return false;
    }
  } catch (error) {
    console.error(`Error upgrading package ${packageName}:`, error);
    return false;
  }
}

// Usage
upgradePackageWithErrorHandling("mcp-github");
```

## AI Assistance Notes
- Model Used: Claude 3 Opus
- Prompt: Continue the nexus session for package upgrade feature implementation
- Date Generated: 2025-03-23

## Related Nexus Documents
- [Package Upgrade Feature Plan](.nexus/features/package_upgrade/initial_plan.md)
- [Package Upgrade Technical Design](.nexus/features/package_upgrade/technical_design.md)
- [Package Upgrade Test Plan](.nexus/features/package_upgrade/test_plan.md)
