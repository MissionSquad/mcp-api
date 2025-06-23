import { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { BuiltInServer } from './types'
import { log } from '../utils/general'

/**
 * Base class for built-in servers providing common functionality
 */
export abstract class BaseBuiltInServer implements BuiltInServer {
  abstract name: string
  abstract externalName: string
  abstract version: string
  abstract description?: string
  abstract tools: Tool[]
  
  initialized: boolean = false
  
  /**
   * Default implementation that ensures initialization before tool calls
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    // Ensure server is initialized
    if (!this.initialized && this.init) {
      await this.init()
      this.initialized = true
    }
    
    // Find the tool
    const tool = this.tools.find(t => t.name === toolName)
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true
      }
    }
    
    // Delegate to implementation
    try {
      return await this.handleToolCall(toolName, args)
    } catch (error) {
      log({ 
        level: 'error', 
        msg: `Built-in server ${this.name} error in tool ${toolName}`,
        error 
      })
      return {
        content: [{ 
          type: 'text', 
          text: `Error: ${error instanceof Error ? error.message : String(error)}` 
        }],
        isError: true
      }
    }
  }
  
  /**
   * Subclasses must implement this to handle specific tool calls
   */
  protected abstract handleToolCall(
    toolName: string, 
    args: Record<string, unknown>
  ): Promise<CallToolResult>
  
  /**
   * Optional initialization
   */
  async init?(): Promise<void>
  
  /**
   * Optional cleanup
   */
  async stop?(): Promise<void>
}
