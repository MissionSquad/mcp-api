import { withExecutionCatalog } from '../src/services/executionCatalog'
import contract from '../src/services/execution-catalog.json'
import type { MCPServer } from '../src/services/mcp'

const resource = 'http://10.1.252.22:8080/mcp'
const server: MCPServer = { name: 'mcp-execution', source: 'platform', authMode: 'none',
  transportType: 'streamable_http', url: resource, enabled: true, status: 'disconnected' }
const previous = process.env.MSQ_EXECUTION_RESOURCE
beforeEach(() => { process.env.MSQ_EXECUTION_RESOURCE = resource })
afterAll(() => {
  if (previous === undefined) delete process.env.MSQ_EXECUTION_RESOURCE
  else process.env.MSQ_EXECUTION_RESOURCE = previous
})
test('all-user execution catalog exposes canonical schemas without shared credentials or a connection', () => {
  const result = withExecutionCatalog(server)
  expect(result.toolsList).toEqual(contract.tools)
  expect(result.toolsList).toHaveLength(19)
  expect(result.status).toBe('disconnected')
  expect(result.transportType).toBe('streamable_http')
  if (result.transportType === 'streamable_http') expect(result.headers).toBeUndefined()
  expect(server.toolsList).toBeUndefined()
  result.toolsList![0].description = 'changed'
  expect(withExecutionCatalog(server).toolsList![0].description).not.toBe('changed')
})
test('catalog projection is restricted to exact configured platform registration', () => {
  for (const changed of [{ name: 'other' }, { source: 'external' as const }, { url: resource + '/other' }]) {
    const other = { ...server, ...changed }
    expect(withExecutionCatalog({ ...other, toolsList: withExecutionCatalog(server).toolsList }).toolsList).toEqual(
      other.name === 'mcp-execution' ? undefined : contract.tools
    )
  }
  const stdio: MCPServer = { name: 'mcp-execution', source: 'platform', transportType: 'stdio',
    command: 'node', args: [], env: {}, enabled: true, status: 'disconnected' }
  expect(withExecutionCatalog(stdio).toolsList).toBeUndefined()
  const populated = withExecutionCatalog(server)
  delete process.env.MSQ_EXECUTION_RESOURCE
  expect(withExecutionCatalog(populated).toolsList).toBeUndefined()
})
