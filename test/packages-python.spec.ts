import * as path from 'path'
import * as util from 'util'
import * as childProcess from 'child_process'
import { existsSync, mkdir, readFile, rm } from 'fs-extra'
import { PackageInfo, PackageService } from '../src/services/packages'
import { MCPService } from '../src/services/mcp'
import { MongoConnectionParams } from '../src/utils/mongodb'

jest.mock('child_process', () => {
  const nodeUtil = require('util') as typeof import('util')
  const exec = jest.fn()
  const execFile = jest.fn()
  const execPromisified = jest.fn()
  const execFilePromisified = jest.fn()
  ;(exec as unknown as Record<symbol, unknown>)[nodeUtil.promisify.custom] = execPromisified
  ;(execFile as unknown as Record<symbol, unknown>)[nodeUtil.promisify.custom] = execFilePromisified
  return { exec, execFile }
})

jest.mock('fs-extra', () => ({
  existsSync: jest.fn(),
  mkdir: jest.fn(),
  readFile: jest.fn(),
  rm: jest.fn()
}))

type ExecResult = { stdout: string; stderr: string }

type DbMock = {
  upsert: jest.Mock<Promise<unknown>, [Partial<PackageInfo> | PackageInfo, Record<string, unknown>]>
  update: jest.Mock<Promise<unknown>, [Partial<PackageInfo> | PackageInfo, Record<string, unknown>]>
  find: jest.Mock<Promise<PackageInfo[]>, [Record<string, unknown>]>
  findOne: jest.Mock<Promise<PackageInfo | null>, [Record<string, unknown>]>
  delete: jest.Mock<Promise<unknown>, [Record<string, unknown>, boolean?]>
}

type McpServiceMock = {
  addServer: jest.Mock
  getServer: jest.Mock
  disableServer: jest.Mock
  enableServer: jest.Mock
  updateServer: jest.Mock
  deleteServer: jest.Mock
}

const mongoParams: MongoConnectionParams = {
  host: 'mongodb://localhost:27017',
  db: 'test',
  user: 'test',
  pass: 'test'
}

const execPromisifiedMock = (
  childProcess.exec as unknown as Record<typeof util.promisify.custom, jest.Mock<Promise<ExecResult>, unknown[]>>
)[util.promisify.custom]
const execFilePromisifiedMock = (
  childProcess.execFile as unknown as Record<typeof util.promisify.custom, jest.Mock<Promise<ExecResult>, unknown[]>>
)[util.promisify.custom]
const existsSyncMock = existsSync as unknown as jest.Mock
const mkdirMock = mkdir as unknown as jest.Mock
const readFileMock = readFile as unknown as jest.Mock
const rmMock = rm as unknown as jest.Mock

const createService = (): {
  service: PackageService
  dbMock: DbMock
  mcpMock: McpServiceMock
} => {
  const mcpMock: McpServiceMock = {
    addServer: jest.fn(),
    getServer: jest.fn(),
    disableServer: jest.fn(),
    enableServer: jest.fn(),
    updateServer: jest.fn(),
    deleteServer: jest.fn()
  }
  const service = new PackageService({
    mongoParams,
    mcpService: mcpMock as unknown as MCPService
  })

  const dbMock: DbMock = {
    upsert: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    delete: jest.fn().mockResolvedValue({})
  }

  ;(service as unknown as { packagesDBClient: DbMock }).packagesDBClient = dbMock

  return { service, dbMock, mcpMock }
}

describe('PackageService python runtime support', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    existsSyncMock.mockReturnValue(false)
    mkdirMock.mockResolvedValue(undefined)
    readFileMock.mockResolvedValue('{}')
    rmMock.mockResolvedValue(undefined)
    execPromisifiedMock.mockResolvedValue({ stdout: '', stderr: '' })
    execFilePromisifiedMock.mockResolvedValue({ stdout: '', stderr: '' })
  })

  test('installPackage rejects python runtime without pythonModule', async () => {
    const { service } = createService()

    const result = await service.installPackage({
      name: 'my-python-mcp',
      serverName: 'python-server',
      runtime: 'python'
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('pythonModule is required for python runtime.')
  })

  test('installPackage configures stdio server for python runtime with venv python -m module', async () => {
    const { service, dbMock, mcpMock } = createService()

    execFilePromisifiedMock.mockImplementation(async (...args: unknown[]) => {
      const commandArgs = (args[1] as string[]) ?? []

      if (commandArgs[0] === '-V') {
        return { stdout: 'Python 3.11.9', stderr: '' }
      }
      if (commandArgs[0] === '-m' && commandArgs[1] === 'venv') {
        return { stdout: '', stderr: '' }
      }
      if (commandArgs[0] === 'install') {
        return { stdout: 'Successfully installed my-python-mcp', stderr: '' }
      }
      if (commandArgs[0] === 'show') {
        return {
          stdout: 'Name: my-python-mcp\nVersion: 1.2.3\nSummary: test package\n',
          stderr: ''
        }
      }

      throw new Error(`Unexpected execFile call: ${commandArgs.join(' ')}`)
    })

    mcpMock.addServer.mockResolvedValue({
      name: 'python-server',
      transportType: 'stdio',
      command: '/tmp/venv/bin/python',
      args: ['-u', '-m', 'my_mcp_server', '--port', '0'],
      env: {},
      status: 'disconnected',
      enabled: true
    })

    const result = await service.installPackage({
      name: 'my-python-mcp',
      serverName: 'python-server',
      runtime: 'python',
      pythonModule: 'my_mcp_server',
      pythonArgs: ['--port', '0'],
      env: { PATH: '/usr/bin', CUSTOM_ENV: '1' }
    })

    expect(result.success).toBe(true)
    expect(result.package?.runtime).toBe('python')
    expect(result.package?.version).toBe('1.2.3')
    expect(result.package?.installPath).toBe(path.join('packages/python', 'python-server'))

    expect(dbMock.upsert).toHaveBeenCalled()
    expect(dbMock.update).toHaveBeenCalled()

    expect(mcpMock.addServer).toHaveBeenCalledTimes(1)
    const addServerInput = mcpMock.addServer.mock.calls[0][0] as {
      command: string
      args: string[]
      env: Record<string, string>
    }
    const expectedVenvAbsolutePath = path.resolve(process.cwd(), path.join('packages/python', 'python-server'))
    const expectedPythonCommand = path.join(
      expectedVenvAbsolutePath,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python'
    )
    expect(addServerInput.command).toBe(expectedPythonCommand)
    expect(addServerInput.args).toEqual(['-u', '-m', 'my_mcp_server', '--port', '0'])
    expect(addServerInput.env.CUSTOM_ENV).toBe('1')
    expect(addServerInput.env.PYTHONUNBUFFERED).toBe('1')
    expect(addServerInput.env.VIRTUAL_ENV).toBe(expectedVenvAbsolutePath)
    expect(
      addServerInput.env.PATH.startsWith(
        path.join(expectedVenvAbsolutePath, process.platform === 'win32' ? 'Scripts' : 'bin')
      )
    ).toBe(true)
  })

  test('upgradePackage uses pip for python runtime and does not update server command/args', async () => {
    const { service, dbMock, mcpMock } = createService()
    const pythonPackage: PackageInfo = {
      name: 'my-python-mcp',
      version: '1.0.0',
      installPath: path.join('packages/python', 'python-server'),
      venvPath: path.join('packages/python', 'python-server'),
      status: 'installed',
      installed: new Date('2025-01-01T00:00:00.000Z'),
      mcpServerId: 'python-server',
      enabled: true,
      runtime: 'python',
      pythonModule: 'my_mcp_server'
    }
    dbMock.findOne.mockResolvedValue(pythonPackage)

    mcpMock.getServer.mockResolvedValue({
      name: 'python-server',
      transportType: 'stdio',
      command: '/venv/bin/python',
      args: ['-u', '-m', 'my_mcp_server'],
      env: {},
      status: 'connected',
      enabled: true
    })
    mcpMock.disableServer.mockResolvedValue({
      name: 'python-server',
      transportType: 'stdio',
      command: '/venv/bin/python',
      args: ['-u', '-m', 'my_mcp_server'],
      env: {},
      status: 'disconnected',
      enabled: false
    })
    mcpMock.enableServer.mockResolvedValue({
      name: 'python-server',
      transportType: 'stdio',
      command: '/venv/bin/python',
      args: ['-u', '-m', 'my_mcp_server'],
      env: {},
      status: 'connected',
      enabled: true
    })

    execFilePromisifiedMock.mockImplementation(async (...args: unknown[]) => {
      const commandArgs = (args[1] as string[]) ?? []
      if (commandArgs[0] === 'install') {
        return { stdout: 'upgrade ok', stderr: '' }
      }
      if (commandArgs[0] === 'show') {
        return { stdout: 'Name: my-python-mcp\nVersion: 1.5.0\n', stderr: '' }
      }
      throw new Error(`Unexpected execFile call in upgrade: ${commandArgs.join(' ')}`)
    })

    const result = await service.upgradePackage('python-server')

    expect(result.success).toBe(true)
    expect(result.package?.version).toBe('1.5.0')
    expect(mcpMock.disableServer).toHaveBeenCalledWith('python-server')
    expect(mcpMock.enableServer).toHaveBeenCalledWith('python-server')
    expect(mcpMock.updateServer).not.toHaveBeenCalled()
    const pipInstallCall = execFilePromisifiedMock.mock.calls.find(([, args]) => (args as string[])[0] === 'install')
    expect(pipInstallCall).toBeDefined()
    expect((pipInstallCall?.[1] as string[])).toContain('--upgrade')
  })

  test('checkForUpdates uses pip for python runtime and npm for node runtime', async () => {
    const { service, dbMock } = createService()
    dbMock.find.mockResolvedValue([
      {
        name: 'py-mcp',
        version: '1.0.0',
        installPath: path.join('packages/python', 'py-server'),
        venvPath: path.join('packages/python', 'py-server'),
        status: 'installed',
        installed: new Date('2025-01-01T00:00:00.000Z'),
        mcpServerId: 'py-server',
        enabled: true,
        runtime: 'python'
      },
      {
        name: '@missionsquad/mcp-github',
        version: '1.0.0',
        installPath: 'packages/mcp-github',
        status: 'installed',
        installed: new Date('2025-01-01T00:00:00.000Z'),
        mcpServerId: 'github-server',
        enabled: true,
        runtime: 'node'
      }
    ])

    execFilePromisifiedMock.mockImplementation(async (...args: unknown[]) => {
      const commandArgs = (args[1] as string[]) ?? []
      if (commandArgs[0] === 'index' && commandArgs[1] === 'versions') {
        return { stdout: 'Available versions: 1.2.0, 1.1.0, 1.0.0\n', stderr: '' }
      }
      throw new Error(`Unexpected execFile call in checkForUpdates: ${commandArgs.join(' ')}`)
    })

    execPromisifiedMock.mockImplementation(async (...args: unknown[]) => {
      const command = args[0] as string
      if (command.startsWith('npm view @missionsquad/mcp-github version')) {
        return { stdout: '1.1.0\n', stderr: '' }
      }
      throw new Error(`Unexpected exec call: ${command}`)
    })

    const result = await service.checkForUpdates()

    expect(result.updates).toEqual([
      {
        serverName: 'py-server',
        currentVersion: '1.0.0',
        latestVersion: '1.2.0',
        updateAvailable: true
      },
      {
        serverName: 'github-server',
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        updateAvailable: true
      }
    ])
    expect(execFilePromisifiedMock).toHaveBeenCalled()
    expect(execPromisifiedMock).toHaveBeenCalled()
  })
})
