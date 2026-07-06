import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  aggregateDirectChildSubtrees,
  formatMebibytes,
  getStdioTransportPid,
  parsePsOutput,
  sampleProcessTree
} from '../src/utils/resourceStats'

describe('parsePsOutput', () => {
  it('parses pid, ppid, rss (KB -> bytes), pcpu and command', () => {
    const output = [
      '    1     0  1024  0.5 node',
      ' 4321     1 20480 12.3 /usr/local/bin/node dist/index.js',
      ''
    ].join('\n')

    const samples = parsePsOutput(output)
    expect(samples).toEqual([
      { pid: 1, ppid: 0, rssBytes: 1024 * 1024, cpuPercent: 0.5, command: 'node' },
      { pid: 4321, ppid: 1, rssBytes: 20480 * 1024, cpuPercent: 12.3, command: '/usr/local/bin/node dist/index.js' }
    ])
  })

  it('preserves spaces inside the command column', () => {
    const samples = parsePsOutput('99 1 512 0.0 Google Chrome Helper (Renderer)')
    expect(samples).toHaveLength(1)
    expect(samples[0].command).toBe('Google Chrome Helper (Renderer)')
  })

  it('skips malformed lines', () => {
    const samples = parsePsOutput('not a process line\n\n12 abc 100 0.0 zsh')
    expect(samples).toEqual([])
  })
})

describe('aggregateDirectChildSubtrees', () => {
  const sample = (pid: number, ppid: number, rssKb: number, cpu: number, command: string) => ({
    pid,
    ppid,
    rssBytes: rssKb * 1024,
    cpuPercent: cpu,
    command
  })

  it('aggregates each direct child with all of its descendants', () => {
    const root = 100
    const tree = [
      sample(root, 1, 400_000, 2.0, 'node dist/index.js'), // self (excluded from subtrees)
      sample(200, root, 50_000, 0.5, 'node mcp-github'), // stdio server
      sample(300, root, 300_000, 3.0, 'chrome'), // browser
      sample(301, 300, 150_000, 1.5, 'chrome'), // renderer under browser
      sample(302, 301, 10_000, 0.1, 'chrome'), // nested helper
      sample(999, 1, 999_000, 9.9, 'unrelated') // not in our tree
    ]

    const subtrees = aggregateDirectChildSubtrees(tree, root)
    expect(subtrees).toHaveLength(2)

    const server = subtrees.find((s) => s.rootPid === 200)
    expect(server).toEqual({
      rootPid: 200,
      command: 'node mcp-github',
      rssBytes: 50_000 * 1024,
      cpuPercent: 0.5,
      processCount: 1
    })

    const browser = subtrees.find((s) => s.rootPid === 300)
    expect(browser).toBeDefined()
    expect(browser!.rssBytes).toBe((300_000 + 150_000 + 10_000) * 1024)
    expect(browser!.cpuPercent).toBeCloseTo(4.6)
    expect(browser!.processCount).toBe(3)
  })

  it('returns an empty list when the root has no children', () => {
    expect(aggregateDirectChildSubtrees([], 100)).toEqual([])
  })

  it('does not loop forever on cyclic ppid data', () => {
    const tree = [sample(200, 100, 1, 0, 'a'), sample(201, 200, 1, 0, 'b'), sample(200, 201, 1, 0, 'a-again')]
    const subtrees = aggregateDirectChildSubtrees(tree, 100)
    expect(subtrees).toHaveLength(1)
  })
})

describe('getStdioTransportPid', () => {
  it('returns undefined for a transport that has not been started', () => {
    const transport = new StdioClientTransport({ command: 'true' })
    expect(getStdioTransportPid(transport)).toBeUndefined()
  })

  it('returns the pid of a started transport process', () => {
    const transport = Object.create(StdioClientTransport.prototype) as StdioClientTransport
    ;(transport as unknown as { _process: { pid: number } })._process = { pid: 4321 }
    expect(getStdioTransportPid(transport)).toBe(4321)
  })

  it('rejects non-numeric pid values', () => {
    const transport = Object.create(StdioClientTransport.prototype) as StdioClientTransport
    ;(transport as unknown as { _process: { pid: unknown } })._process = { pid: 'nope' }
    expect(getStdioTransportPid(transport)).toBeUndefined()
  })

  it('returns undefined for non-stdio transports', () => {
    const fake = { start: async () => undefined, send: async () => undefined, close: async () => undefined }
    expect(getStdioTransportPid(fake)).toBeUndefined()
  })
})

describe('sampleProcessTree', () => {
  it('samples the live process tree and includes this process', async () => {
    const samples = await sampleProcessTree()
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.some((s) => s.pid === process.pid)).toBe(true)
  })
})

describe('formatMebibytes', () => {
  it('formats bytes as MB with one decimal', () => {
    expect(formatMebibytes(412.3 * 1024 * 1024)).toBe('412.3MB')
    expect(formatMebibytes(0)).toBe('0.0MB')
  })
})
