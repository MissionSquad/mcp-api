import { MCPService, MCPServer } from './mcp'
import { IndexDefinition, MongoConnectionParams, MongoDBClient } from '../utils/mongodb'
import { log } from '../utils/general'
import * as path from 'path'
import { existsSync, mkdir, readFile, rm } from 'fs-extra'
import { promisify } from 'util'
import { exec as execCallback } from 'child_process'

const exec = promisify(execCallback)

export interface PackageInfo {
  name: string;
  version: string;
  installPath: string;
  main?: string;
  status: 'installed' | 'installing' | 'error';
  installed: Date;
  lastUsed?: Date;
  error?: string;
  mcpServerId?: string;
  enabled?: boolean;
}

export interface InstallPackageRequest {
  name: string;
  version?: string;
  serverName: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

const packageIndexes: IndexDefinition[] = [
  { name: 'name', key: { name: 1 } }
]

export class PackageService {
  private packagesDir: string;
  private packagesDBClient: MongoDBClient<PackageInfo>;
  public mcpService: MCPService;

  constructor({ 
    mongoParams, 
    mcpService, 
    packagesDir = path.join(process.cwd(), 'packages') 
  }: {
    mongoParams: MongoConnectionParams;
    mcpService: MCPService;
    packagesDir?: string;
  }) {
    this.packagesDir = packagesDir;
    this.packagesDBClient = new MongoDBClient<PackageInfo>(mongoParams, packageIndexes);
    this.mcpService = mcpService;
  }

  /**
   * Attempt to install a package for a server that failed to start
   * @param serverName The name of the server that failed to start
   * @returns True if installation was successful, false otherwise
   */
  async installMissingPackage(serverName: string): Promise<boolean> {
    try {
      // Get the server details
      const server = await this.mcpService.getServer(serverName);
      if (!server) {
        log({ level: 'error', msg: `Server ${serverName} not found` });
        return false;
      }

      // Extract package name from command or args
      let packageName: string | undefined;
      
      // Check if the command contains a package name
      if (server.command.includes('node_modules')) {
        const match = server.command.match(/node_modules\/(@?[a-z0-9-_]+(?:\/[a-z0-9-_]+)?)/i);
        if (match) {
          packageName = match[1];
        }
      }
      
      // If not found in command, check args
      if (!packageName && server.args.length > 0) {
        for (const arg of server.args) {
          if (arg.includes('node_modules')) {
            const match = arg.match(/node_modules\/(@?[a-z0-9-_]+(?:\/[a-z0-9-_]+)?)/i);
            if (match) {
              packageName = match[1];
              break;
            }
          }
        }
      }
      
      if (!packageName) {
        log({ level: 'error', msg: `Could not determine package name for server ${serverName}` });
        return false;
      }
      
      // Install the package
      log({ level: 'info', msg: `Attempting to install missing package ${packageName} for server ${serverName}` });
      
      const result = await this.installPackage({
        name: packageName,
        serverName: serverName,
        command: server.command,
        args: server.args,
        env: server.env,
        enabled: false // Install in disabled state by default
      });
      
      return result.success;
    } catch (error: any) {
      log({ level: 'error', msg: `Error installing missing package for server ${serverName}: ${error.message}` });
      return false;
    }
  }

  async init(): Promise<void> {
    await this.packagesDBClient.connect('packages');
    // Ensure packages directory exists
    await mkdir(this.packagesDir, { recursive: true });
    log({ level: 'info', msg: `PackageService initialized with packages directory: ${this.packagesDir}` });
  }

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
    
    // Check if a server with this name already exists in MCPService
    try {
      const existingServer = await this.mcpService.getServer(serverName);
      if (existingServer && existingServer.enabled === false) {
        // Server exists and is disabled, check if package exists
        const existingPackage = await this.getPackageById(serverName);
        if (!existingPackage) {
          // Server exists but package doesn't - delete the server entry first
          log({ level: 'info', msg: `Found disabled server ${serverName} with no package entry. Deleting server entry before reinstalling.` });
          await this.mcpService.deleteServer(serverName);
        }
      }
    } catch (error: any) {
      // Log but continue - this is just a pre-check
      log({ level: 'warn', msg: `Error checking for existing server during package installation: ${error.message}` });
    }
    
    // Create package directory - sanitize name for directory (replace @ and / with safe characters)
    const sanitizedDirName = name.replace('@', '').replace(/\//g, '-');
    const packageDir = path.join(this.packagesDir, sanitizedDirName);
    // Store relative path instead of absolute path
    const relativeInstallPath = path.relative(process.cwd(), packageDir);
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
      log({ level: 'info', msg: `Initializing package.json for ${name}` });
      const initResult = await exec('npm init -y', { cwd: packageDir });
      if (initResult.stderr) {
        log({ level: 'error', msg: `Error initializing package.json: ${initResult.stderr}` });
      }
      
      // Install the package
      const installCmd = `npm install ${name}${version ? '@' + version : ''}`;
      log({ level: 'info', msg: `Installing package: ${installCmd}` });
      const installResult = await exec(installCmd, { cwd: packageDir });
      if (installResult.stderr && !installResult.stderr.includes('npm notice') && !installResult.stderr.includes('npm WARN')) {
        throw new Error(`Error installing package: ${installResult.stderr}`);
      }
      
      // Get package.json to determine main file if command not provided
      const packageJsonPath = path.join(packageDir, 'package.json');
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
      
      // Determine run command if not provided
      let finalCommand = command;
      if (!finalCommand) {
        // Get the relative package directory path (from project root)
        const relativePackageDir = path.relative(process.cwd(), packageDir);
        
        // Check if the package has bin entries
        const nodeModulesPackageJsonPath = path.join(packageDir, 'node_modules', name, 'package.json');
        if (existsSync(nodeModulesPackageJsonPath)) {
          const nodeModulesPackageJson = JSON.parse(await readFile(nodeModulesPackageJsonPath, 'utf8'));
          
          if (nodeModulesPackageJson.bin) {
            // If bin is a string, use that
            if (typeof nodeModulesPackageJson.bin === 'string') {
              finalCommand = 'node';
              // Use relative path with ./ prefix
              args.unshift(`./${path.join(relativePackageDir, 'node_modules', name, nodeModulesPackageJson.bin)}`);
            } 
            // If bin is an object, use the first entry
            else if (typeof nodeModulesPackageJson.bin === 'object') {
              const binName = Object.keys(nodeModulesPackageJson.bin)[0];
              finalCommand = 'node';
              // Use relative path with ./ prefix
              args.unshift(`./${path.join(relativePackageDir, 'node_modules', name, nodeModulesPackageJson.bin[binName])}`);
            }
          } 
          // Fall back to main file
          else if (nodeModulesPackageJson.main) {
            finalCommand = 'node';
            // Use relative path with ./ prefix
            args.unshift(`./${path.join(relativePackageDir, 'node_modules', name, nodeModulesPackageJson.main)}`);
          }
        }
        
        // If we still don't have a command, use a default
        if (!finalCommand) {
          finalCommand = 'node';
          // Use relative path with ./ prefix
          args.unshift(`./${path.join(relativePackageDir, 'node_modules', name)}`);
        }
      }
      
      // Register as MCP server
      log({ level: 'info', msg: `Registering ${name} as MCP server: ${serverName}` });
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
      log({ level: 'error', msg: `Error installing package ${name}: ${error.message}` });
      packageInfo.status = 'error';
      packageInfo.error = error.message;
      await this.packagesDBClient.update(packageInfo, { name });
      
      return { success: false, error: error.message };
    }
  }
  
  async getPackages(): Promise<PackageInfo[]> {
    return this.packagesDBClient.find({});
  }
  
  async getPackage(name: string): Promise<PackageInfo | null> {
    return this.packagesDBClient.findOne({ name });
  }

  async getPackageById(name: string): Promise<PackageInfo | null> {
    return this.packagesDBClient.findOne({ mcpServerId: name });
  }
  
  async enablePackage(name: string): Promise<{ success: boolean; server?: MCPServer; error?: string }> {
    try {
      const packageInfo = await this.packagesDBClient.findOne({ mcpServerId: name });
      if (!packageInfo) {
        return { success: false, error: `Package ${name} not found` };
      }
      
      // Enable the server
      const server = await this.mcpService.enableServer(name);
      if (!server) {
        return { success: false, error: `Failed to enable server ${name}` };
      }
      
      // Update package info
      packageInfo.enabled = true;
      await this.packagesDBClient.update(packageInfo, { mcpServerId: name });
      
      return { success: true, server };
    } catch (error: any) {
      log({ level: 'error', msg: `Error enabling package ${name}: ${error.message}` });
      return { success: false, error: error.message };
    }
  }
  
  async disablePackage(name: string): Promise<{ success: boolean; server?: MCPServer; error?: string }> {
    try {
      const packageInfo = await this.packagesDBClient.findOne({ mcpServerId: name });
      if (!packageInfo) {
        return { success: false, error: `Package ${name} not found` };
      }
      
      // Disable the server
      const server = await this.mcpService.disableServer(name);
      if (!server) {
        return { success: false, error: `Failed to disable server ${name}` };
      }
      
      // Update package info
      packageInfo.enabled = false;
      await this.packagesDBClient.update(packageInfo, { mcpServerId: name });
      
      return { success: true, server };
    } catch (error: any) {
      log({ level: 'error', msg: `Error disabling package ${name}: ${error.message}` });
      return { success: false, error: error.message };
    }
  }
  
  async uninstallPackage(name: string): Promise<{ success: boolean; error?: string }> {
    try {
      const packageInfo = await this.packagesDBClient.findOne({ mcpServerId: name });
      if (!packageInfo) {
        return { success: false, error: `Package ${name} not found` };
      }
      
      // If registered as MCP server, unregister it
      if (packageInfo.mcpServerId) {
        try {
          await this.mcpService.deleteServer(packageInfo.mcpServerId);
        } catch (error: any) {
          log({ level: 'error', msg: `Error deleting MCP server ${packageInfo.mcpServerId}: ${error.message}` });
          // Continue with uninstallation even if server deletion fails
        }
      }
      
      // Delete package directory - convert relative path to absolute path
      if (packageInfo.installPath) {
        const absoluteInstallPath = path.resolve(process.cwd(), packageInfo.installPath);
        if (existsSync(absoluteInstallPath)) {
          await rm(absoluteInstallPath, { recursive: true, force: true });
        }
      }
      
      // Remove from database
      await this.packagesDBClient.delete({ mcpServerId: name });
      
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
  
  async stop(): Promise<void> {
    await this.packagesDBClient.disconnect();
  }
}
