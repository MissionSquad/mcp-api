import { Express, NextFunction, Request, Response } from 'express'
import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { Resource } from '..'
import { log } from '../utils/general'
import { PackageService, InstallPackageRequest } from '../services/packages'
import { MCPService } from '../services/mcp'
import { env } from '../env'

// Interface for tracking installed packages
export interface InstalledPackage {
  repo: string
  serverName: string
  uninstalled: boolean
}

// Interface for application state
export interface AppState {
  _id?: any
  firstRunCompleted: boolean
  installedPackages: InstalledPackage[]
}

const appStateIndexes: IndexDefinition[] = [{ name: 'firstRunCompleted', key: { firstRunCompleted: 1 } }]

export class PackagesController implements Resource {
  private app: Express
  private packageService: PackageService
  private appStateDBClient: MongoDBClient<AppState>

  constructor({
    app,
    mongoParams,
    mcpService
  }: {
    app: Express
    mongoParams: MongoConnectionParams
    mcpService: MCPService
  }) {
    this.app = app
    this.packageService = new PackageService({ mongoParams, mcpService })
    this.appStateDBClient = new MongoDBClient<AppState>(mongoParams, appStateIndexes)
  }

  /**
   * Get the package service instance
   * @returns The package service instance
   */
  public getPackageService(): PackageService {
    return this.packageService
  }

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

  /**
   * Check if this is the first run of the application
   * @returns True if this is the first run, false otherwise
   */
  private async isFirstRun(): Promise<boolean> {
    const appState = await this.appStateDBClient.findOne({})
    return !appState || !appState.firstRunCompleted
  }

  /**
   * Mark the first run as completed
   */
  private async markFirstRunCompleted(): Promise<void> {
    const appState = await this.appStateDBClient.findOne({})
    if (!appState) {
      await this.appStateDBClient.insert({
        firstRunCompleted: true,
        installedPackages: []
      })
    } else {
      appState.firstRunCompleted = true
      await this.appStateDBClient.update(appState, { _id: appState._id })
    }
    log({ level: 'info', msg: 'First run marked as completed' })
  }

  /**
   * Install predefined packages from INSTALL_ON_START
   */
  private async installPredefinedPackages(): Promise<void> {
    for (const pkg of env.INSTALL_ON_START) {
      try {
        // Check if this package was previously uninstalled
        const wasUninstalled = await this.wasPackageUninstalled(pkg.repo, pkg.name)

        if (wasUninstalled) {
          log({
            level: 'info',
            msg: `Skipping installation of ${pkg.repo} as ${pkg.name} as it was previously uninstalled`
          })
          continue
        }

        log({ level: 'info', msg: `Auto-installing package ${pkg.repo} as ${pkg.name}` })

        const result = await this.packageService.installPackage({
          name: pkg.repo,
          serverName: pkg.name,
          enabled: true
        })

        if (result.success) {
          // Track this package installation
          await this.trackPackageInstallation(pkg.repo, pkg.name)
          log({ level: 'info', msg: `Successfully installed ${pkg.repo} as ${pkg.name}` })
        } else {
          log({ level: 'error', msg: `Failed to install ${pkg.repo} as ${pkg.name}: ${result.error}` })
        }
      } catch (error) {
        log({ level: 'error', msg: `Error installing package ${pkg.repo}: ${(error as any).message}` })
      }
    }
  }

  /**
   * Check if a package was previously uninstalled
   * @param repo Package repository name
   * @param serverName Server name
   * @returns True if the package was previously uninstalled, false otherwise
   */
  private async wasPackageUninstalled(repo: string, serverName: string): Promise<boolean> {
    const appState = await this.appStateDBClient.findOne({})
    if (!appState || !appState.installedPackages) {
      return false
    }

    const installedPackage = appState.installedPackages.find(pkg => pkg.repo === repo && pkg.serverName === serverName)

    return installedPackage ? installedPackage.uninstalled : false
  }

  /**
   * Track package installation in the appState collection
   * @param repo Package repository name
   * @param serverName Server name
   */
  private async trackPackageInstallation(repo: string, serverName: string): Promise<void> {
    const appState = await this.appStateDBClient.findOne({})
    if (!appState) {
      await this.appStateDBClient.insert({
        firstRunCompleted: false,
        installedPackages: [
          {
            repo,
            serverName,
            uninstalled: false
          }
        ]
      })
      return
    }

    if (!appState.installedPackages) {
      appState.installedPackages = []
    }

    // Check if this package is already tracked
    const existingIndex = appState.installedPackages.findIndex(
      pkg => pkg.repo === repo && pkg.serverName === serverName
    )

    if (existingIndex >= 0) {
      // Update existing entry
      appState.installedPackages[existingIndex].uninstalled = false
    } else {
      // Add new entry
      appState.installedPackages.push({
        repo,
        serverName,
        uninstalled: false
      })
    }

    await this.appStateDBClient.update(appState, { _id: appState._id })
  }

  /**
   * Mark a package as uninstalled in the appState collection
   * @param serverName Server name
   */
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

  private async installPackage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = req.body as InstallPackageRequest
      log({ level: 'info', msg: `Installing package ${body.name} as server ${body.serverName}` })

      if (!body.name || !body.serverName) {
        res.status(400).json({
          success: false,
          error: 'Package name and server name are required'
        })
        return
      }

      const result = await this.packageService.installPackage(body)
      if (result.success) {
        // Track this package installation in appState
        await this.trackPackageInstallation(body.name, body.serverName)

        res.json({
          success: true,
          package: result.package,
          server: result.server
        })
      } else {
        res.status(400).json({
          success: false,
          error: result.error
        })
      }
    } catch (error) {
      log({ level: 'error', msg: `Error installing package: ${(error as any).message}` })
      res.status(500).json({ success: false, error: (error as any).message })
    }
  }

  private async getPackages(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const packages = await this.packageService.getPackages()

      // Check for updates if requested
      if (req.query.checkUpdates === 'true') {
        log({ level: 'info', msg: 'Checking for updates for all packages' })
        await this.packageService.checkForUpdates()
      }

      res.json({ success: true, packages })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as any).message })
    }
  }

  private async getPackage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      const packageInfo = await this.packageService.getPackage(name)

      if (!packageInfo) {
        res.status(404).json({ success: false, error: `Package ${name} not found` })
        return
      }

      // Check for updates if requested
      if (req.query.checkUpdates === 'true' && packageInfo.mcpServerId) {
        log({ level: 'info', msg: `Checking for updates for package ${name}` })
        await this.packageService.checkForUpdates(packageInfo.mcpServerId)
        // Refresh package info after update check
        const updatedPackageInfo = await this.packageService.getPackage(name)
        if (updatedPackageInfo) {
          res.json({ success: true, package: updatedPackageInfo })
          return
        }
      }

      res.json({ success: true, package: packageInfo })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as any).message })
    }
  }

  private async getPackageById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      const packageInfo = await this.packageService.getPackageById(name)

      if (!packageInfo) {
        res.status(404).json({ success: false, error: `Package ${name} not found` })
        return
      }

      // Check for updates if requested
      if (req.query.checkUpdates === 'true' && packageInfo.mcpServerId) {
        log({ level: 'info', msg: `Checking for updates for package ${packageInfo.name}` })
        await this.packageService.checkForUpdates(packageInfo.mcpServerId)
        // Refresh package info after update check
        const updatedPackageInfo = await this.packageService.getPackageById(name)
        if (updatedPackageInfo) {
          res.json({ success: true, package: updatedPackageInfo })
          return
        }
      }

      res.json({ success: true, package: packageInfo })
    } catch (error) {
      res.status(500).json({ success: false, error: (error as any).message })
    }
  }

  private async uninstallPackage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      log({ level: 'info', msg: `Uninstalling package ${name}` })

      const result = await this.packageService.uninstallPackage(name)
      if (result.success) {
        // Mark the package as uninstalled in appState
        await this.markPackageAsUninstalled(name)
        res.json({ success: true })
      } else {
        res.status(400).json({ success: false, error: result.error })
      }
    } catch (error) {
      res.status(500).json({ success: false, error: (error as any).message })
    }
  }

  private async enablePackage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      log({ level: 'info', msg: `Enabling package ${name}` })

      const result = await this.packageService.enablePackage(name)
      if (result.success) {
        res.json({ success: true, server: result.server })
      } else {
        res.status(400).json({ success: false, error: result.error })
      }
    } catch (error) {
      log({ level: 'error', msg: `Error enabling package ${req.params.name}: ${(error as any).message}` })
      res.status(500).json({ success: false, error: (error as any).message })
    }
  }

  private async disablePackage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const name = req.params.name
      log({ level: 'info', msg: `Disabling package ${name}` })

      const result = await this.packageService.disablePackage(name)
      if (result.success) {
        res.json({ success: true, server: result.server })
      } else {
        res.status(400).json({ success: false, error: result.error })
      }
    } catch (error) {
      log({ level: 'error', msg: `Error disabling package ${req.params.name}: ${(error as any).message}` })
      res.status(500).json({ success: false, error: (error as any).message })
    }
  }

  /**
   * Check for available updates for packages
   * @param req Express request
   * @param res Express response
   * @param next Express next function
   */
  private async checkForUpdates(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const serverName = req.query.name as string | undefined
      log({ level: 'info', msg: `Checking for updates${serverName ? ` for ${serverName}` : ''}` })

      const updates = await this.packageService.checkForUpdates(serverName)
      res.json({ success: true, ...updates })
    } catch (error) {
      log({ level: 'error', msg: `Error checking for updates: ${(error as any).message}` })
      res.status(500).json({ success: false, error: (error as any).message })
    }
  }

  /**
   * Upgrade a package to the latest version or a specified version
   * @param req Express request
   * @param res Express response
   * @param next Express next function
   */
  private async upgradePackage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const serverName = req.params.name
      const version = req.body.version as string | undefined

      log({ level: 'info', msg: `Upgrading package ${serverName}${version ? ' to version ' + version : ''}` })

      const result = await this.packageService.upgradePackage(serverName, version)
      if (result.success) {
        res.json({
          success: true,
          package: result.package,
          server: result.server
        })
      } else {
        res.status(400).json({
          success: false,
          error: result.error
        })
      }
    } catch (error) {
      log({ level: 'error', msg: `Error upgrading package: ${(error as any).message}` })
      res.status(500).json({ success: false, error: (error as any).message })
    }
  }

  /**
   * Upgrade all packages to their latest versions
   * @param req Express request
   * @param res Express response
   * @param next Express next function
   */
  private async upgradeAllPackages(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      log({ level: 'info', msg: 'Upgrading all packages' })

      const result = await this.packageService.upgradeAllPackages()
      res.json({
        success: result.success,
        results: result.results
      })
    } catch (error) {
      log({ level: 'error', msg: `Error upgrading all packages: ${(error as any).message}` })
      res.status(500).json({ success: false, error: (error as any).message })
    }
  }

  public async stop(): Promise<void> {
    await this.packageService.stop()
    await this.appStateDBClient.disconnect()
  }
}
