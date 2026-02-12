import { MCPService, MCPServer, MCPTransportType, assertTransportConfigCompatible } from './mcp'
import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { log, compareVersions } from '../utils/general'
import * as path from 'path'
import { existsSync, mkdir, readFile, rm } from 'fs-extra'
import { promisify } from 'util'
import { exec as execCallback } from 'child_process'
import type { StreamableHTTPReconnectionOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const exec = promisify(execCallback)

export interface PackageInfo {
  name: string
  version: string
  latestVersion?: string // New field to track latest available version
  updateAvailable?: boolean // New field to indicate if an update is available
  installPath: string
  main?: string
  status: 'installed' | 'installing' | 'upgrading' | 'error' // Added 'upgrading' status
  installed: Date
  lastUpgraded?: Date // New field to track last upgrade date
  lastUsed?: Date
  error?: string
  mcpServerId?: string
  enabled?: boolean
}

export interface InstallPackageRequest {
  name: string
  version?: string
  serverName: string
  transportType?: MCPTransportType
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  sessionId?: string
  reconnectionOptions?: StreamableHTTPReconnectionOptions
  secretName?: string
  enabled?: boolean
  failOnWarning?: boolean
}

const packageIndexes: IndexDefinition[] = [{ name: 'name', key: { name: 1 } }]

export class PackageService {
  private packagesDir: string
  private packagesDBClient: MongoDBClient<PackageInfo>
  public mcpService: MCPService

  constructor({
    mongoParams,
    mcpService,
    packagesDir = path.join(process.cwd(), 'packages')
  }: {
    mongoParams: MongoConnectionParams
    mcpService: MCPService
    packagesDir?: string
  }) {
    this.packagesDir = packagesDir
    this.packagesDBClient = new MongoDBClient<PackageInfo>(mongoParams, packageIndexes)
    this.mcpService = mcpService
  }

  /**
   * Attempt to install a package for a server that failed to start
   * @param serverName The name of the server that failed to start
   * @returns True if installation was successful, false otherwise
   */
  async installMissingPackage(serverName: string): Promise<boolean> {
    try {
      // Get the server details
      const server = await this.mcpService.getServer(serverName)
      if (!server) {
        log({ level: 'error', msg: `Server ${serverName} not found` })
        return false
      }
      if (server.transportType !== 'stdio') {
        log({ level: 'warn', msg: `Server ${serverName} is not stdio; skipping package installation.` })
        return false
      }

      // Extract package name from command or args
      let packageName: string | undefined

      // Check if the command contains a package name
      if (server.command.includes('node_modules')) {
        const match = server.command.match(/node_modules\/(@?[a-z0-9-_]+(?:\/[a-z0-9-_]+)?)/i)
        if (match) {
          packageName = match[1]
        }
      }

      // If not found in command, check args
      if (!packageName && server.args.length > 0) {
        for (const arg of server.args) {
          if (arg.includes('node_modules')) {
            const match = arg.match(/node_modules\/(@?[a-z0-9-_]+(?:\/[a-z0-9-_]+)?)/i)
            if (match) {
              packageName = match[1]
              break
            }
          }
        }
      }

      if (!packageName) {
        log({ level: 'error', msg: `Could not determine package name for server ${serverName}` })
        return false
      }

      // Install the package
      log({ level: 'info', msg: `Attempting to install missing package ${packageName} for server ${serverName}` })

      const result = await this.installPackage({
        name: packageName,
        serverName: serverName,
        command: server.command,
        args: server.args,
        env: server.env,
        enabled: false // Install in disabled state by default
      })

      return result.success
    } catch (error) {
      log({
        level: 'error',
        msg: `Error installing missing package for server ${serverName}: ${(error as any).message}`
      })
      return false
    }
  }

  async init(): Promise<void> {
    await this.packagesDBClient.connect('packages')
    // Ensure packages directory exists
    await mkdir(this.packagesDir, { recursive: true })
    log({ level: 'info', msg: `PackageService initialized with packages directory: ${this.packagesDir}` })
  }

  async installPackage(
    request: InstallPackageRequest
  ): Promise<{
    success: boolean
    package?: PackageInfo
    server?: MCPServer
    error?: string
  }> {
    const {
      name,
      version,
      serverName,
      transportType,
      command,
      args,
      env,
      url,
      headers,
      sessionId,
      reconnectionOptions,
      secretName,
      enabled = true,
      failOnWarning = false
    } = request
    const resolvedTransportType: MCPTransportType = transportType ?? 'stdio'

    assertTransportConfigCompatible({
      transportType: resolvedTransportType,
      command,
      args,
      env,
      url,
      headers,
      sessionId,
      reconnectionOptions
    })

    // Validate package name to prevent command injection
    if (!/^[@a-z0-9-_\/\.]+$/.test(name)) {
      return {
        success: false,
        error: `Invalid package name: ${name}. Package names must match npm naming conventions.`
      }
    }

    if (resolvedTransportType === 'streamable_http') {
      if (!url) {
        return { success: false, error: 'Streamable HTTP servers require a url.' }
      }
      new URL(url)
    }

    // Check if a server with this name already exists in MCPService
    try {
      const existingServer = await this.mcpService.getServer(serverName)
      if (existingServer && existingServer.enabled === false) {
        // Server exists and is disabled, check if package exists
        const existingPackage = await this.getPackageById(serverName)
        if (!existingPackage) {
          // Server exists but package doesn't - delete the server entry first
          log({
            level: 'info',
            msg: `Found disabled server ${serverName} with no package entry. Deleting server entry before reinstalling.`
          })
          await this.mcpService.deleteServer(serverName)
        }
      }
    } catch (error) {
      // Log but continue - this is just a pre-check
      log({
        level: 'warn',
        msg: `Error checking for existing server during package installation: ${(error as any).message}`
      })
    }

    // Create package directory - sanitize name for directory (replace @ and / with safe characters)
    const sanitizedDirName = name.replace('@', '').replace(/\//g, '-')
    const packageDir = path.join(this.packagesDir, sanitizedDirName)
    // Store relative path instead of absolute path
    const relativeInstallPath = path.relative(process.cwd(), packageDir)
    const packageInfo: PackageInfo = {
      name,
      version: version || 'latest',
      installPath: relativeInstallPath,
      status: 'installing',
      installed: new Date()
    }

    try {
      // Save initial package info
      await this.packagesDBClient.upsert(packageInfo, { name })

      // Create directory and initialize package
      await mkdir(packageDir, { recursive: true })

      // Initialize package.json
      log({ level: 'info', msg: `Initializing package.json for ${name}` })
      const initResult = await exec('npm init -y', { cwd: packageDir })
      if (initResult.stderr) {
        log({ level: 'error', msg: `Error initializing package.json: ${initResult.stderr}` })
      }

      // Install the package
      const installCmd = `npm install ${name}${version ? '@' + version : ''}`
      log({ level: 'info', msg: `Installing package: ${installCmd}` })
      const installResult = await exec(installCmd, { cwd: packageDir })
      if (
        installResult.stderr &&
        !installResult.stderr.includes('npm notice') &&
        failOnWarning &&
        installResult.stderr.includes('npm WARN')
      ) {
        throw new Error(`Error installing package: ${installResult.stderr}`)
      }

      // Get package.json to determine main file if command not provided
      const packageJsonPath = path.join(packageDir, 'package.json')
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))

      let server: MCPServer
      if (resolvedTransportType === 'streamable_http') {
        // Register as MCP server
        log({ level: 'info', msg: `Registering ${name} as streamable HTTP MCP server: ${serverName}` })
        server = await this.mcpService.addServer({
          name: serverName,
          transportType: 'streamable_http',
          url: url!,
          headers,
          sessionId,
          reconnectionOptions,
          secretName,
          enabled
        })
      } else {
        const stdioArgs = [...(args ?? [])]
        const stdioEnv = env ?? {}

        // Determine run command if not provided
        let finalCommand = command
        if (!finalCommand) {
          // Get the relative package directory path (from project root)
          const relativePackageDir = path.relative(process.cwd(), packageDir)

          // Check if the package has bin entries
          const nodeModulesPackageJsonPath = path.join(packageDir, 'node_modules', name, 'package.json')
          if (existsSync(nodeModulesPackageJsonPath)) {
            const nodeModulesPackageJson = JSON.parse(await readFile(nodeModulesPackageJsonPath, 'utf8'))

            if (nodeModulesPackageJson.bin) {
              // If bin is a string, use that
              if (typeof nodeModulesPackageJson.bin === 'string') {
                finalCommand = 'node'
                // Use relative path with ./ prefix
                stdioArgs.unshift(
                  `./${path.join(relativePackageDir, 'node_modules', name, nodeModulesPackageJson.bin)}`
                )
              }
              // If bin is an object, use the first entry
              else if (typeof nodeModulesPackageJson.bin === 'object') {
                const binName = Object.keys(nodeModulesPackageJson.bin)[0]
                finalCommand = 'node'
                // Use relative path with ./ prefix
                stdioArgs.unshift(
                  `./${path.join(relativePackageDir, 'node_modules', name, nodeModulesPackageJson.bin[binName])}`
                )
              }
            }
            // Fall back to main file
            else if (nodeModulesPackageJson.main) {
              finalCommand = 'node'
              // Use relative path with ./ prefix
              stdioArgs.unshift(
                `./${path.join(relativePackageDir, 'node_modules', name, nodeModulesPackageJson.main)}`
              )
            }
          }

          // If we still don't have a command, use a default
          if (!finalCommand) {
            finalCommand = 'node'
            // Use relative path with ./ prefix
            stdioArgs.unshift(`./${path.join(relativePackageDir, 'node_modules', name)}`)
          }
        }

        // Register as MCP server
        log({ level: 'info', msg: `Registering ${name} as MCP server: ${serverName}` })
        server = await this.mcpService.addServer({
          name: serverName,
          transportType: 'stdio',
          command: finalCommand,
          args: stdioArgs,
          env: stdioEnv,
          secretName,
          enabled
        })
      }

      // Update package info with success
      packageInfo.status = 'installed'
      packageInfo.mcpServerId = serverName
      packageInfo.enabled = enabled
      await this.packagesDBClient.update(packageInfo, { name })

      return { success: true, package: packageInfo, server }
    } catch (error) {
      // Handle error, update package status
      log({ level: 'error', msg: `Error installing package ${name}: ${(error as any).message}` })
      packageInfo.status = 'error'
      packageInfo.error = (error as any).message
      await this.packagesDBClient.update(packageInfo, { name })

      return { success: false, error: (error as any).message }
    }
  }

  async getPackages(): Promise<PackageInfo[]> {
    return this.packagesDBClient.find({})
  }

  async getPackage(name: string): Promise<PackageInfo | null> {
    return this.packagesDBClient.findOne({ name })
  }

  async getPackageById(name: string): Promise<PackageInfo | null> {
    return this.packagesDBClient.findOne({ mcpServerId: name })
  }

  async enablePackage(name: string): Promise<{ success: boolean; server?: MCPServer; error?: string }> {
    try {
      const packageInfo = await this.packagesDBClient.findOne({ mcpServerId: name })
      if (!packageInfo) {
        return { success: false, error: `Package ${name} not found` }
      }

      // Enable the server
      const server = await this.mcpService.enableServer(name)
      if (!server) {
        return { success: false, error: `Failed to enable server ${name}` }
      }

      // Update package info
      packageInfo.enabled = true
      await this.packagesDBClient.update(packageInfo, { mcpServerId: name })

      return { success: true, server }
    } catch (error) {
      log({ level: 'error', msg: `Error enabling package ${name}: ${(error as any).message}` })
      return { success: false, error: (error as any).message }
    }
  }

  async disablePackage(name: string): Promise<{ success: boolean; server?: MCPServer; error?: string }> {
    try {
      const packageInfo = await this.packagesDBClient.findOne({ mcpServerId: name })
      if (!packageInfo) {
        return { success: false, error: `Package ${name} not found` }
      }

      // Disable the server
      const server = await this.mcpService.disableServer(name)
      if (!server) {
        return { success: false, error: `Failed to disable server ${name}` }
      }

      // Update package info
      packageInfo.enabled = false
      await this.packagesDBClient.update(packageInfo, { mcpServerId: name })

      return { success: true, server }
    } catch (error) {
      log({ level: 'error', msg: `Error disabling package ${name}: ${(error as any).message}` })
      return { success: false, error: (error as any).message }
    }
  }

  async uninstallPackage(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      const packageInfo = await this.packagesDBClient.findOne({ mcpServerId: name })
      if (!packageInfo) {
        return { success: false, error: `Package ${name} not found` }
      }

      // If registered as MCP server, unregister it
      if (packageInfo.mcpServerId) {
        try {
          await this.mcpService.deleteServer(packageInfo.mcpServerId)
        } catch (error) {
          log({
            level: 'error',
            msg: `Error deleting MCP server ${packageInfo.mcpServerId}: ${(error as any).message}`
          })
          // Continue with uninstallation even if server deletion fails
        }
      }

      // Delete package directory - convert relative path to absolute path
      if (packageInfo.installPath) {
        const absoluteInstallPath = path.resolve(process.cwd(), packageInfo.installPath)
        if (existsSync(absoluteInstallPath)) {
          await rm(absoluteInstallPath, { recursive: true, force: true })
        }
      }

      // Remove from database
      await this.packagesDBClient.delete({ mcpServerId: name })

      return { success: true }
    } catch (error) {
      return { success: false, error: (error as any).message }
    }
  }

  /**
   * Check for available updates for a specific package or all packages
   * @param serverName Optional server name to check for updates
   * @returns Object containing update information for packages
   */
  async checkForUpdates(
    serverName?: string
  ): Promise<{
    updates: Array<{
      serverName: string
      currentVersion: string
      latestVersion: string
      updateAvailable: boolean
    }>
  }> {
    try {
      // Get packages to check
      let packages: PackageInfo[]
      if (serverName) {
        const pkg = await this.packagesDBClient.findOne({ mcpServerId: serverName })
        packages = pkg ? [pkg] : []
      } else {
        packages = await this.packagesDBClient.find({})
      }

      const updates = []

      // Check each package for updates
      for (const pkg of packages) {
        try {
          // Skip packages without mcpServerId
          if (!pkg.mcpServerId) continue

          // Get the latest version from npm registry
          const npmInfoCmd = `npm view ${pkg.name} version`
          const { stdout } = await exec(npmInfoCmd, { cwd: process.cwd() })
          const latestVersion = stdout.trim()

          // Compare versions
          const updateAvailable = compareVersions(pkg.version, latestVersion) < 0

          // Update package info in database with latest version info
          pkg.latestVersion = latestVersion
          pkg.updateAvailable = updateAvailable
          await this.packagesDBClient.update(pkg, { mcpServerId: pkg.mcpServerId })

          updates.push({
            serverName: pkg.mcpServerId,
            currentVersion: pkg.version,
            latestVersion,
            updateAvailable
          })
        } catch (error) {
          log({ level: 'error', msg: `Error checking updates for ${pkg.name}: ${(error as any).message}` })
          updates.push({
            serverName: pkg.mcpServerId!,
            currentVersion: pkg.version,
            latestVersion: 'unknown',
            updateAvailable: false
          })
        }
      }

      return { updates }
    } catch (error) {
      log({ level: 'error', msg: `Error checking for updates: ${(error as any).message}` })
      return { updates: [] }
    }
  }

  /**
   * Upgrade a package to the latest version or a specified version
   * @param serverName The name of the server to upgrade
   * @param version Optional specific version to upgrade to
   * @returns Result of the upgrade operation
   */
  async upgradePackage(
    serverName: string,
    version?: string
  ): Promise<{
    success: boolean
    package?: PackageInfo
    server?: MCPServer
    error?: string
  }> {
    try {
      // Get package info
      const packageInfo = await this.packagesDBClient.findOne({ mcpServerId: serverName })
      if (!packageInfo) {
        return { success: false, error: `Package ${serverName} not found` }
      }

      // Update status to upgrading
      packageInfo.status = 'upgrading'
      await this.packagesDBClient.update(packageInfo, { mcpServerId: serverName })

      // Get server info
      const server = await this.mcpService.getServer(serverName)
      if (!server) {
        packageInfo.status = 'error'
        packageInfo.error = `Server ${serverName} not found`
        await this.packagesDBClient.update(packageInfo, { mcpServerId: serverName })
        return { success: false, error: packageInfo.error }
      }
      // Disable server temporarily
      const wasEnabled = server.enabled
      if (wasEnabled) {
        await this.mcpService.disableServer(serverName)
      }

      try {
        // Get the absolute path to the package directory
        const packageDir = path.resolve(process.cwd(), packageInfo.installPath)

        // Perform the upgrade
        const upgradeCmd = `npm install ${packageInfo.name}${version ? '@' + version : '@latest'}`
        log({ level: 'info', msg: `Upgrading package: ${upgradeCmd}` })
        const upgradeResult = await exec(upgradeCmd, { cwd: packageDir })

        if (
          upgradeResult.stderr &&
          !upgradeResult.stderr.includes('npm notice') &&
          !upgradeResult.stderr.includes('npm WARN')
        ) {
          throw new Error(`Error upgrading package: ${upgradeResult.stderr}`)
        }

        // Get the new version from package.json
        const nodeModulesPackageJsonPath = path.join(packageDir, 'node_modules', packageInfo.name, 'package.json')
        const nodeModulesPackageJson = JSON.parse(await readFile(nodeModulesPackageJsonPath, 'utf8'))
        const newVersion = nodeModulesPackageJson.version

        // Update package info
        packageInfo.version = newVersion
        packageInfo.status = 'installed'
        packageInfo.lastUpgraded = new Date()
        packageInfo.updateAvailable = false

        let updatedServer: MCPServer = server
        if (server.transportType === 'stdio') {
          // Check if the package structure has changed
          let serverUpdateNeeded = false
          let newCommand = server.command
          let newArgs = [...server.args]

          // Check if the package has bin entries
          if (nodeModulesPackageJson.bin) {
            // If bin is a string, use that
            if (typeof nodeModulesPackageJson.bin === 'string') {
              newCommand = 'node'
              // Replace the first arg with the new path
              if (newArgs.length > 0) {
                const relativePackageDir = path.relative(process.cwd(), packageDir)
                newArgs[0] = `./${path.join(
                  relativePackageDir,
                  'node_modules',
                  packageInfo.name,
                  nodeModulesPackageJson.bin
                )}`
                serverUpdateNeeded = true
              }
            }
            // If bin is an object, use the first entry
            else if (typeof nodeModulesPackageJson.bin === 'object') {
              const binName = Object.keys(nodeModulesPackageJson.bin)[0]
              newCommand = 'node'
              // Replace the first arg with the new path
              if (newArgs.length > 0) {
                const relativePackageDir = path.relative(process.cwd(), packageDir)
                newArgs[0] = `./${path.join(
                  relativePackageDir,
                  'node_modules',
                  packageInfo.name,
                  nodeModulesPackageJson.bin[binName]
                )}`
                serverUpdateNeeded = true
              }
            }
          }
          // Fall back to main file
          else if (nodeModulesPackageJson.main) {
            newCommand = 'node'
            // Replace the first arg with the new path
            if (newArgs.length > 0) {
              const relativePackageDir = path.relative(process.cwd(), packageDir)
              newArgs[0] = `./${path.join(
                relativePackageDir,
                'node_modules',
                packageInfo.name,
                nodeModulesPackageJson.main
              )}`
              serverUpdateNeeded = true
            }
          }

          if (serverUpdateNeeded) {
            const updatedServerResult = await this.mcpService.updateServer(serverName, {
              command: newCommand,
              args: newArgs
            })
            if (!updatedServerResult) {
              throw new Error(`Failed to update server configuration for ${serverName}`)
            }
            if (updatedServerResult.transportType !== 'stdio') {
              throw new Error(`Updated server ${serverName} is not stdio; upgrade cannot continue.`)
            }
            updatedServer = updatedServerResult
          }
        }

        // Re-enable server if it was enabled before
        if (wasEnabled) {
          const enabledServer = await this.mcpService.enableServer(serverName)
          if (!enabledServer) {
            throw new Error(`Failed to re-enable server ${serverName} after upgrade`)
          }
          if (enabledServer.transportType !== server.transportType) {
            throw new Error(`Re-enabled server ${serverName} transport type changed during upgrade.`)
          }
          updatedServer = enabledServer
        }

        // Update package info in database
        await this.packagesDBClient.update(packageInfo, { mcpServerId: serverName })

        return {
          success: true,
          package: packageInfo,
          server: updatedServer
        }
      } catch (error) {
        // Handle error, update package status
        log({ level: 'error', msg: `Error upgrading package ${packageInfo.name}: ${(error as any).message}` })
        packageInfo.status = 'error'
        packageInfo.error = (error as any).message
        await this.packagesDBClient.update(packageInfo, { mcpServerId: serverName })

        // Try to re-enable server if it was enabled before
        if (wasEnabled) {
          try {
            await this.mcpService.enableServer(serverName)
          } catch (enableError) {
            log({
              level: 'error',
              msg: `Error re-enabling server ${serverName} after failed upgrade: ${(enableError as any).message}`
            })
          }
        }

        return { success: false, error: (error as any).message }
      }
    } catch (error) {
      return { success: false, error: (error as any).message }
    }
  }

  /**
   * Upgrade all packages to their latest versions
   * @returns Results of the upgrade operations
   */
  async upgradeAllPackages(): Promise<{
    success: boolean
    results: Array<{
      serverName: string
      success: boolean
      error?: string
    }>
  }> {
    try {
      // Get all packages
      const packages = await this.packagesDBClient.find({})
      const results = []
      let overallSuccess = true

      // Upgrade each package
      for (const pkg of packages) {
        if (!pkg.mcpServerId) continue

        try {
          const result = await this.upgradePackage(pkg.mcpServerId)
          results.push({
            serverName: pkg.mcpServerId,
            success: result.success,
            error: result.error
          })

          if (!result.success) {
            overallSuccess = false
          }
        } catch (error) {
          results.push({
            serverName: pkg.mcpServerId,
            success: false,
            error: (error as any).message
          })
          overallSuccess = false
        }
      }

      return {
        success: overallSuccess,
        results
      }
    } catch (error) {
      log({ level: 'error', msg: `Error upgrading all packages: ${(error as any).message}` })
      return {
        success: false,
        results: []
      }
    }
  }

  async stop(): Promise<void> {
    await this.packagesDBClient.disconnect()
  }
}
