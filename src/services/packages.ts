import { MCPService, MCPServer, MCPTransportType, assertTransportConfigCompatible } from './mcp'
import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { log, compareVersions } from '../utils/general'
import { env } from '../env'
import * as path from 'path'
import { existsSync, mkdir, readFile, rm } from 'fs-extra'
import { promisify } from 'util'
import { exec as execCallback, execFile as execFileCallback } from 'child_process'
import type { StreamableHTTPReconnectionOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const exec = promisify(execCallback)
const execFile = promisify(execFileCallback)

export type PackageRuntime = 'node' | 'python'

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
  runtime?: PackageRuntime
  pythonModule?: string
  pythonArgs?: string[]
  venvPath?: string
  pipIndexUrl?: string
  pipExtraIndexUrl?: string
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
  runtime?: PackageRuntime
  pythonModule?: string
  pythonArgs?: string[]
  pipIndexUrl?: string
  pipExtraIndexUrl?: string
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

  private sanitizeServerName(serverName: string): string {
    return serverName.replace(/[^a-zA-Z0-9_-]/g, '-')
  }

  private async resolvePythonExecutable(): Promise<string> {
    const candidates = [env.PYTHON_BIN, 'python3', 'python'].filter(Boolean) as string[]
    for (const candidate of candidates) {
      try {
        await execFile(candidate, ['-V'])
        return candidate
      } catch {
        // Try next candidate
      }
    }
    throw new Error('Python executable not found. Set PYTHON_BIN or install python3.')
  }

  private resolveVenvPaths(serverName: string): { absolute: string; relative: string } {
    const sanitized = this.sanitizeServerName(serverName)
    const relative = path.join(env.PYTHON_VENV_DIR || 'packages/python', sanitized)
    const absolute = path.resolve(process.cwd(), relative)
    return { absolute, relative }
  }

  private venvBinDir(): string {
    return process.platform === 'win32' ? 'Scripts' : 'bin'
  }

  private venvPythonPath(venvAbsolutePath: string): string {
    const binDir = this.venvBinDir()
    const exeName = process.platform === 'win32' ? 'python.exe' : 'python'
    return path.join(venvAbsolutePath, binDir, exeName)
  }

  private venvPipPath(venvAbsolutePath: string): string {
    const binDir = this.venvBinDir()
    const exeName = process.platform === 'win32' ? 'pip.exe' : 'pip'
    return path.join(venvAbsolutePath, binDir, exeName)
  }

  private async ensureVenv(pythonExecutable: string, venvAbsolutePath: string): Promise<void> {
    const pythonPath = this.venvPythonPath(venvAbsolutePath)
    if (existsSync(pythonPath)) {
      return
    }
    await mkdir(venvAbsolutePath, { recursive: true })
    await execFile(pythonExecutable, ['-m', 'venv', venvAbsolutePath])
  }

  private async pipInstall(
    venvAbsolutePath: string,
    spec: string,
    options: { indexUrl?: string; extraIndexUrl?: string },
    extraArgs: string[] = []
  ): Promise<void> {
    const pipPath = this.venvPipPath(venvAbsolutePath)
    const args = ['install', ...extraArgs, spec]
    if (options.indexUrl) {
      args.push('--index-url', options.indexUrl)
    }
    if (options.extraIndexUrl) {
      args.push('--extra-index-url', options.extraIndexUrl)
    }
    await execFile(pipPath, args)
  }

  private async pipShowVersion(venvAbsolutePath: string, name: string): Promise<string> {
    const pipPath = this.venvPipPath(venvAbsolutePath)
    const { stdout } = await execFile(pipPath, ['show', name])
    const versionLine = stdout.split('\n').find(line => line.startsWith('Version:'))
    if (!versionLine) {
      throw new Error(`Unable to determine installed version for ${name}`)
    }
    return versionLine.replace('Version:', '').trim()
  }

  private async pipIndexLatestVersion(
    venvAbsolutePath: string,
    name: string,
    options: { indexUrl?: string; extraIndexUrl?: string }
  ): Promise<string | undefined> {
    try {
      const pipPath = this.venvPipPath(venvAbsolutePath)
      const args = ['index', 'versions', name]
      if (options.indexUrl) {
        args.push('--index-url', options.indexUrl)
      }
      if (options.extraIndexUrl) {
        args.push('--extra-index-url', options.extraIndexUrl)
      }
      const { stdout } = await execFile(pipPath, args)
      const line = stdout.split('\n').find(entry => entry.startsWith('Available versions:'))
      if (!line) {
        return undefined
      }
      const versions = line.replace('Available versions:', '').split(',').map(v => v.trim())
      return versions[0]
    } catch {
      // Older pip may not support `index versions`
      return undefined
    }
  }

  private buildPythonArgs(pythonModule: string, pythonArgs?: string[]): string[] {
    return ['-u', '-m', pythonModule, ...(pythonArgs ?? [])]
  }

  private buildPythonEnv(venvAbsolutePath: string, customEnv?: Record<string, string>): Record<string, string> {
    const venvBin = path.join(venvAbsolutePath, this.venvBinDir())
    const existingPath = customEnv?.PATH ?? process.env.PATH ?? ''
    return {
      ...customEnv,
      PYTHONUNBUFFERED: '1',
      VIRTUAL_ENV: venvAbsolutePath,
      PATH: `${venvBin}${path.delimiter}${existingPath}`
    }
  }

  /**
   * Attempt to install a package for a server that failed to start
   * @param serverName The name of the server that failed to start
   * @returns True if installation was successful, false otherwise
   */
  async installMissingPackage(serverName: string): Promise<boolean> {
    try {
      const existingPackage = await this.getPackageById(serverName)
      if (existingPackage?.runtime === 'python') {
        log({ level: 'warn', msg: `Server ${serverName} is Python; automatic reinstall is not supported.` })
        return false
      }

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
      env: envVars,
      url,
      headers,
      sessionId,
      reconnectionOptions,
      secretName,
      enabled = true,
      failOnWarning = false
    } = request
    const resolvedTransportType: MCPTransportType = transportType ?? 'stdio'
    const runtime: PackageRuntime = request.runtime ?? 'node'

    if (runtime === 'python') {
      if (!request.pythonModule) {
        return { success: false, error: 'pythonModule is required for python runtime.' }
      }
      if (!/^[a-zA-Z0-9_.]+$/.test(request.pythonModule)) {
        return { success: false, error: `Invalid pythonModule: ${request.pythonModule}` }
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
        return { success: false, error: `Invalid Python package name: ${name}` }
      }
      if (resolvedTransportType !== 'stdio') {
        return { success: false, error: 'Python runtime only supports stdio transport.' }
      }
      if (url || headers || sessionId || reconnectionOptions) {
        return { success: false, error: 'Streamable HTTP fields are not allowed for python runtime.' }
      }

      const { absolute: venvAbsolutePath, relative: venvRelativePath } = this.resolveVenvPaths(serverName)
      const pythonPackageInfo: PackageInfo = {
        name,
        version: version || 'latest',
        installPath: venvRelativePath,
        venvPath: venvRelativePath,
        status: 'installing',
        installed: new Date(),
        mcpServerId: serverName,
        enabled,
        runtime: 'python',
        pythonModule: request.pythonModule,
        pythonArgs: request.pythonArgs,
        pipIndexUrl: request.pipIndexUrl ?? env.PIP_INDEX_URL,
        pipExtraIndexUrl: request.pipExtraIndexUrl ?? env.PIP_EXTRA_INDEX_URL
      }

      await this.packagesDBClient.upsert(pythonPackageInfo, { name })

      try {
        const pythonExecutable = await this.resolvePythonExecutable()
        await this.ensureVenv(pythonExecutable, venvAbsolutePath)

        const spec = version ? `${name}==${version}` : name
        await this.pipInstall(venvAbsolutePath, spec, {
          indexUrl: pythonPackageInfo.pipIndexUrl,
          extraIndexUrl: pythonPackageInfo.pipExtraIndexUrl
        })

        const installedVersion = await this.pipShowVersion(venvAbsolutePath, name)
        const pythonCommand = this.venvPythonPath(venvAbsolutePath)
        const pythonArgs = this.buildPythonArgs(request.pythonModule, request.pythonArgs)
        const pythonEnv = this.buildPythonEnv(venvAbsolutePath, envVars)

        const server = await this.mcpService.addServer({
          name: serverName,
          transportType: 'stdio',
          command: pythonCommand,
          args: pythonArgs,
          env: pythonEnv,
          secretName,
          enabled
        })

        pythonPackageInfo.version = installedVersion
        pythonPackageInfo.status = 'installed'
        await this.packagesDBClient.update(pythonPackageInfo, { name })

        return { success: true, package: pythonPackageInfo, server }
      } catch (error) {
        pythonPackageInfo.status = 'error'
        pythonPackageInfo.error = (error as Error).message
        await this.packagesDBClient.update(pythonPackageInfo, { name })
        return { success: false, error: (error as Error).message }
      }
    }

    assertTransportConfigCompatible({
      transportType: resolvedTransportType,
      command,
      args,
      env: envVars,
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
        const stdioEnv = envVars ?? {}

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
      packageInfo.runtime = 'node'
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

      const installPath = packageInfo.venvPath ?? packageInfo.installPath
      if (installPath) {
        const absoluteInstallPath = path.resolve(process.cwd(), installPath)
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

          if (pkg.runtime === 'python') {
            const venvAbsolutePath = pkg.venvPath
              ? path.resolve(process.cwd(), pkg.venvPath)
              : path.resolve(process.cwd(), pkg.installPath)
            const latest = await this.pipIndexLatestVersion(venvAbsolutePath, pkg.name, {
              indexUrl: pkg.pipIndexUrl ?? env.PIP_INDEX_URL,
              extraIndexUrl: pkg.pipExtraIndexUrl ?? env.PIP_EXTRA_INDEX_URL
            })
            const latestVersion = latest ?? 'unknown'
            const updateAvailable = latest ? latest !== pkg.version : false
            pkg.latestVersion = latestVersion
            pkg.updateAvailable = updateAvailable
            await this.packagesDBClient.update(pkg, { mcpServerId: pkg.mcpServerId })
            updates.push({
              serverName: pkg.mcpServerId,
              currentVersion: pkg.version,
              latestVersion,
              updateAvailable
            })
            continue
          }

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
        const runtime: PackageRuntime = packageInfo.runtime ?? 'node'
        if (runtime === 'python') {
          const venvAbsolutePath = packageInfo.venvPath
            ? path.resolve(process.cwd(), packageInfo.venvPath)
            : path.resolve(process.cwd(), packageInfo.installPath)

          const spec = version ? `${packageInfo.name}==${version}` : packageInfo.name
          await this.pipInstall(
            venvAbsolutePath,
            spec,
            {
              indexUrl: packageInfo.pipIndexUrl ?? env.PIP_INDEX_URL,
              extraIndexUrl: packageInfo.pipExtraIndexUrl ?? env.PIP_EXTRA_INDEX_URL
            },
            ['--upgrade']
          )

          const newVersion = await this.pipShowVersion(venvAbsolutePath, packageInfo.name)
          packageInfo.version = newVersion
          packageInfo.status = 'installed'
          packageInfo.lastUpgraded = new Date()
          packageInfo.updateAvailable = false

          let updatedServer: MCPServer = server
          if (wasEnabled) {
            const enabledServer = await this.mcpService.enableServer(serverName)
            if (!enabledServer) {
              throw new Error(`Failed to re-enable server ${serverName} after upgrade`)
            }
            updatedServer = enabledServer
          }

          await this.packagesDBClient.update(packageInfo, { mcpServerId: serverName })
          return { success: true, package: packageInfo, server: updatedServer }
        }

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
