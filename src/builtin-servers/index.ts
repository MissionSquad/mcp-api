import { BuiltInServerRegistry } from './registry'
import { BuiltInSearxngServer } from './servers/searxng'

/**
 * Initialize and register all built-in servers
 */
export function registerBuiltInServers(): void {
  const registry = BuiltInServerRegistry.getInstance()
  
  // Register searxng as the first built-in server
  registry.register(new BuiltInSearxngServer())
  
  // Future built-in servers would be registered here
  // registry.register(new BuiltInAnotherServer())
}

// Re-export for convenience
export { BuiltInServerRegistry } from './registry'
export { BuiltInServer } from './types'
export { BaseBuiltInServer } from './base'
