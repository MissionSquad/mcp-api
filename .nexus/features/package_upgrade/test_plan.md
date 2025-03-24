# Test Plan: Package Upgrade Feature

NOTE: Package Upgrade IS NOT BEING TESTING RIGHT NOW. SKIP THIS.

## Context
This document outlines the testing strategy for the package upgrade feature in the MCP API. It defines the test cases, test data, and test environments needed to validate the feature.

## Test Objectives
1. Verify that packages can be upgraded to their latest versions
2. Verify that packages can be upgraded to specific versions
3. Verify that all packages can be upgraded at once
4. Verify that package version information is correctly included in package information endpoints
5. Verify proper error handling for various failure scenarios
6. Verify that the system recovers gracefully from upgrade failures

## Test Environments
1. **Development Environment**
   - Local development setup with MongoDB
   - Test packages with known versions and dependencies

2. **Integration Environment**
   - Staging environment with production-like configuration
   - Real packages from npm registry

## Test Data
1. **Test Packages**
   - Simple package with no dependencies
   - Package with multiple dependencies
   - Package with complex version requirements
   - Package with breaking changes between versions

2. **Test Versions**
   - Latest version
   - Specific older version
   - Non-existent version (for error testing)

## Test Cases

### 1. Check for Updates

#### TC1.1: Check for updates for all packages
- **Precondition**: Multiple packages installed
- **Steps**:
  1. Call `GET /packages/updates`
- **Expected Result**:
  - Response includes update information for all packages
  - Each package has currentVersion, latestVersion, and updateAvailable fields

#### TC1.2: Check for updates for a specific package
- **Precondition**: Package installed
- **Steps**:
  1. Call `GET /packages/updates?name={serverName}`
- **Expected Result**:
  - Response includes update information for the specified package only

#### TC1.3: Check for updates with non-existent package
- **Precondition**: No package with the specified name
- **Steps**:
  1. Call `GET /packages/updates?name={nonExistentServerName}`
- **Expected Result**:
  - Response includes empty updates array
  - No error is thrown

### 2. Upgrade Specific Package

#### TC2.1: Upgrade package to latest version
- **Precondition**: Package installed with older version
- **Steps**:
  1. Call `PUT /packages/{serverName}/upgrade`
- **Expected Result**:
  - Package is upgraded to the latest version
  - Response includes updated package information
  - Package status is 'installed'
  - Package version is updated
  - Server is re-enabled if it was enabled before

#### TC2.2: Upgrade package to specific version
- **Precondition**: Package installed
- **Steps**:
  1. Call `PUT /packages/{serverName}/upgrade` with body `{ "version": "x.y.z" }`
- **Expected Result**:
  - Package is upgraded to the specified version
  - Response includes updated package information
  - Package status is 'installed'
  - Package version is updated to the specified version
  - Server is re-enabled if it was enabled before

#### TC2.3: Upgrade package with non-existent version
- **Precondition**: Package installed
- **Steps**:
  1. Call `PUT /packages/{serverName}/upgrade` with body `{ "version": "999.999.999" }`
- **Expected Result**:
  - Error response with appropriate message
  - Package status is 'error'
  - Server is re-enabled if it was enabled before

#### TC2.4: Upgrade non-existent package
- **Precondition**: No package with the specified name
- **Steps**:
  1. Call `PUT /packages/{nonExistentServerName}/upgrade`
- **Expected Result**:
  - Error response with appropriate message

### 3. Upgrade All Packages

#### TC3.1: Upgrade all packages
- **Precondition**: Multiple packages installed with older versions
- **Steps**:
  1. Call `PUT /packages/upgrade-all`
- **Expected Result**:
  - All packages are upgraded to their latest versions
  - Response includes results for each package
  - Each package status is 'installed'
  - Each package version is updated
  - All servers are re-enabled if they were enabled before

#### TC3.2: Upgrade all packages with some failures
- **Precondition**: Multiple packages installed, some with issues that would cause upgrade failures
- **Steps**:
  1. Call `PUT /packages/upgrade-all`
- **Expected Result**:
  - Successful packages are upgraded
  - Failed packages have error information
  - Response includes results for each package with success/error status
  - Overall success is false

### 4. Package Information Endpoints

#### TC4.1: Get all packages with version information
- **Precondition**: Multiple packages installed, some with updates available
- **Steps**:
  1. Call `GET /packages`
- **Expected Result**:
  - Response includes all packages
  - Each package includes version, latestVersion, and updateAvailable fields

#### TC4.2: Get all packages with update check
- **Precondition**: Multiple packages installed
- **Steps**:
  1. Call `GET /packages?checkUpdates=true`
- **Expected Result**:
  - Response includes all packages
  - Each package includes updated version information
  - latestVersion and updateAvailable fields are updated

#### TC4.3: Get specific package with version information
- **Precondition**: Package installed
- **Steps**:
  1. Call `GET /packages/by-name/{name}` or `GET /packages/by-id/{name}`
- **Expected Result**:
  - Response includes the package
  - Package includes version, latestVersion, and updateAvailable fields

#### TC4.4: Get specific package with update check
- **Precondition**: Package installed
- **Steps**:
  1. Call `GET /packages/by-name/{name}?checkUpdates=true` or `GET /packages/by-id/{name}?checkUpdates=true`
- **Expected Result**:
  - Response includes the package
  - Package includes updated version information
  - latestVersion and updateAvailable fields are updated

### 5. Error Handling and Recovery

#### TC5.1: Server recovery after failed upgrade
- **Precondition**: Package installed and server enabled
- **Steps**:
  1. Simulate upgrade failure (e.g., by using a non-existent version)
  2. Call `PUT /packages/{serverName}/upgrade` with body `{ "version": "999.999.999" }`
- **Expected Result**:
  - Error response with appropriate message
  - Package status is 'error'
  - Server is re-enabled

#### TC5.2: Upgrade after previous failure
- **Precondition**: Package with status 'error' from previous failed upgrade
- **Steps**:
  1. Call `PUT /packages/{serverName}/upgrade`
- **Expected Result**:
  - Package is upgraded successfully
  - Package status is 'installed'
  - Server is re-enabled if it was enabled before

## Integration Tests

### IT1: Full upgrade workflow
- **Precondition**: Package installed with older version
- **Steps**:
  1. Call `GET /packages/updates` to check for updates
  2. Call `PUT /packages/{serverName}/upgrade` to upgrade the package
  3. Call `GET /packages/by-id/{serverName}` to verify the upgrade
- **Expected Result**:
  - Updates are correctly identified
  - Package is upgraded successfully
  - Package information reflects the upgrade

### IT2: Upgrade with server restart
- **Precondition**: Package installed with older version and server enabled
- **Steps**:
  1. Call `PUT /packages/{serverName}/upgrade` to upgrade the package
  2. Verify that the server is temporarily disabled during upgrade
  3. Verify that the server is re-enabled after upgrade
- **Expected Result**:
  - Server is disabled during upgrade
  - Server is re-enabled after upgrade
  - Server is running with the upgraded package

## Performance Tests

### PT1: Upgrade multiple packages
- **Precondition**: Multiple packages installed (10+)
- **Steps**:
  1. Call `PUT /packages/upgrade-all`
  2. Measure the time taken to upgrade all packages
- **Expected Result**:
  - All packages are upgraded successfully
  - Upgrade completes within acceptable time limits

## Security Tests

### ST1: Input validation for version parameter
- **Precondition**: Package installed
- **Steps**:
  1. Call `PUT /packages/{serverName}/upgrade` with various malformed version strings
- **Expected Result**:
  - Proper error handling for invalid inputs
  - No security vulnerabilities exposed

## Test Data Setup

### Test Package 1: Simple Package
- Name: `test-simple-package`
- Initial Version: `1.0.0`
- Latest Version: `1.1.0`
- No dependencies

### Test Package 2: Complex Package
- Name: `test-complex-package`
- Initial Version: `1.0.0`
- Latest Version: `2.0.0` (breaking changes)
- Multiple dependencies

## Test Execution Plan

1. **Unit Tests**
   - Implement unit tests for the version comparison utility
   - Implement unit tests for the package upgrade logic with mocked dependencies

2. **Integration Tests**
   - Set up test environment with test packages
   - Execute integration tests for each endpoint
   - Verify end-to-end workflows

3. **Manual Tests**
   - Perform manual testing for complex scenarios
   - Verify UI interactions if applicable

## Test Reporting

- Document test results in a test report
- Include any issues found during testing
- Provide recommendations for improvements

## AI Assistance Notes
- Model Used: Claude 3 Opus
- Prompt: Create test plan for package upgrade feature
- Date Generated: 2025-03-23

## Related Nexus Documents
- [Package Upgrade Feature Plan](.nexus/features/package_upgrade/initial_plan.md)
- [Package Upgrade Technical Design](.nexus/features/package_upgrade/technical_design.md)
- [System Overview](.nexus/architecture/system_overview.md)
- [Packages Controller](.nexus/architecture/packages_controller.md)
