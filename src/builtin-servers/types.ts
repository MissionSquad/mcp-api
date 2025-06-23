import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * Interface for built-in MCP servers that run in-process
 * These servers do not require stdio communication or database storage
 */
export interface BuiltInServer {
  /**
   * Unique internal identifier for the built-in server.
   * MUST start with the 'builtin:' prefix.
   */
  name: string

  /**
   * The public-facing name for the server, without any prefix.
   * This is used in API responses and requests.
   */
  externalName: string
  
  /**
   * Version of the built-in server
   */
  version: string
  
  /**
   * Human-readable description
   */
  description?: string
  
  /**
   * List of tools provided by this server
   * Must match the MCP SDK Tool interface exactly
   */
  tools: Tool[]
  
  /**
   * Handle tool calls directly without stdio
   * @param toolName The name of the tool to call
   * @param args The arguments for the tool
   * @returns Promise resolving to CallToolResult from MCP SDK
   */
  callTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult>
  
  /**
   * Optional initialization method
   * Called when the server is first accessed
   */
  init?(): Promise<void>
  
  /**
   * Optional cleanup method
   * Called when mcp-api shuts down
   */
  stop?(): Promise<void>
  
  /**
   * Whether the server has been initialized
   * Used internally to track initialization state
   */
  initialized?: boolean
}

/**
 * Type guard to check if a server name refers to a built-in server
 */
export function isBuiltInServerName(name: string): boolean {
  return name.startsWith('builtin:')
}
