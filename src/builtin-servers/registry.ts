import { BuiltInServer } from './types'
import { log } from '../utils/general'

/**
 * Singleton registry for all built-in MCP servers
 */
export class BuiltInServerRegistry {
  private static instance: BuiltInServerRegistry
  private servers: Map<string, BuiltInServer> = new Map()
  private externalNameToInternal: Map<string, string> = new Map()
  
  private constructor() {}
  
  /**
   * Get the singleton instance
   */
  static getInstance(): BuiltInServerRegistry {
    if (!BuiltInServerRegistry.instance) {
      BuiltInServerRegistry.instance = new BuiltInServerRegistry()
    }
    return BuiltInServerRegistry.instance
  }
  
  /**
   * Register a built-in server
   * @param server The server to register
   * @throws Error if a server with the same name already exists
   */
  register(server: BuiltInServer): void {
    if (this.servers.has(server.name)) {
      throw new Error(`Built-in server ${server.name} is already registered`)
    }
    
    // Ensure server name follows convention
    if (!server.name.startsWith('builtin:')) {
      throw new Error(`Built-in server names must start with 'builtin:' prefix`)
    }
    
    if (this.externalNameToInternal.has(server.externalName)) {
      throw new Error(`Built-in server with external name ${server.externalName} is already registered`)
    }
    
    this.servers.set(server.name, server)
    this.externalNameToInternal.set(server.externalName, server.name)
    log({ 
      level: 'info', 
      msg: `Registered built-in server: ${server.name} (external: ${server.externalName}) v${server.version}` 
    })
  }
  
  /**
   * Get a built-in server by its internal name (e.g., 'builtin:searxng')
   */
  get(name: string): BuiltInServer | undefined {
    return this.servers.get(name)
  }

  /**
   * Get a built-in server by its external name (e.g., 'searxng')
   */
  getByExternalName(externalName: string): BuiltInServer | undefined {
    const internalName = this.externalNameToInternal.get(externalName)
    if (internalName) {
      return this.get(internalName)
    }
    return undefined
  }
  
  /**
   * List all registered built-in servers
   */
  list(): BuiltInServer[] {
    return Array.from(this.servers.values())
  }
  
  /**
   * Check if a server name refers to a built-in server by its internal name
   */
  isBuiltIn(name: string): boolean {
    return this.servers.has(name)
  }

  /**
   * Check if a server name refers to a built-in server by its external name
   */
  isBuiltInByExternalName(externalName: string): boolean {
    return this.externalNameToInternal.has(externalName)
  }
  
  /**
   * Initialize all registered servers
   */
  async initAll(): Promise<void> {
    for (const server of this.servers.values()) {
      if (server.init && !server.initialized) {
        try {
          await server.init()
          server.initialized = true
          log({ level: 'info', msg: `Initialized built-in server: ${server.name}` })
        } catch (error) {
          log({ 
            level: 'error', 
            msg: `Failed to initialize built-in server: ${server.name}`,
            error 
          })
        }
      }
    }
  }
  
  /**
   * Stop all registered servers
   */
  async stopAll(): Promise<void> {
    for (const server of this.servers.values()) {
      if (server.stop) {
        try {
          await server.stop()
          log({ level: 'info', msg: `Stopped built-in server: ${server.name}` })
        } catch (error) {
          log({ 
            level: 'error', 
            msg: `Error stopping built-in server: ${server.name}`,
            error 
          })
        }
      }
    }
  }
}
