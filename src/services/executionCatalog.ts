import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import contract from './execution-catalog.json'
import type { MCPServer } from './mcp'

/** Public tool metadata for the installed execution contract. This grants no invocation authority. */
export function withExecutionCatalog(server: MCPServer): MCPServer {
  if (server.name !== 'mcp-execution') return server
  if (!process.env.MSQ_EXECUTION_RESOURCE ||
      server.source !== 'platform' || server.transportType !== 'streamable_http' ||
      server.url !== process.env.MSQ_EXECUTION_RESOURCE) return { ...server, toolsList: undefined }
  return { ...server, toolsList: ListToolsResultSchema.parse({ tools: contract.tools }).tools }
}
