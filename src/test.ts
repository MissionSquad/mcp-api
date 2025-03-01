import { MCPServer, MCPService } from './services/mcp'

const globalEnv = {
  ...process.env,
  ...(process.env.PATH ? { PATH: process.env.PATH } : {})
}

const servers:MCPServer[] = [
  {
    name: 'memory',
    command: './node_modules/@modelcontextprotocol/server-memory/dist/index.js',
    args: [],
    env: { ...{}, ...globalEnv },
    status: 'disconnected'
  },
  // {
  //   name: 'gdrive',
  //   command: './node_modules/@modelcontextprotocol/server-gdrive/dist/index.js',
  //   args: [],
  //   env: { ...{}, ...globalEnv },
  //   status: 'disconnected'
  // },
  {
    name: 'github',
    command: './node_modules/@modelcontextprotocol/server-github/dist/index.js',
    args: [],
    env: { ...{}, ...globalEnv },
    status: 'disconnected'
  },
  // {
  //   name: 'google-maps',
  //   command: './node_modules/@modelcontextprotocol/server-google-maps/dist/index.js',
  //   args: [],
  //   env: { ...{ GOOGLE_MAPS_API_KEY: '' }, ...globalEnv },
  //   status: 'disconnected'
  // },
  // {
  //   name: 'slack',
  //   command: './node_modules/@modelcontextprotocol/server-slack/dist/index.js',
  //   args: [],
  //   env: { ...{ SLACK_BOT_TOKEN: '', SLACK_TEAM_ID: '' }, ...globalEnv },
  //   status: 'disconnected'
  // },
  {
    name: 'bitcoin-rpc',
    command: './node_modules/bitcoin-mcp/build/cli.js',
    args: [],
    env: { ...{}, ...globalEnv },
    status: 'disconnected'
  }
]



;(async () => {
  // const mcpServers = new MCPService()
  // await mcpServers.init()
})()