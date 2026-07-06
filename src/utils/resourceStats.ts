import { execFile } from 'node:child_process'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

export interface ProcessSample {
  pid: number
  ppid: number
  rssBytes: number
  cpuPercent: number
  command: string
}

export interface SubtreeSample {
  rootPid: number
  command: string
  rssBytes: number
  cpuPercent: number
  processCount: number
}

/**
 * Extracts the OS process id from a stdio client transport.
 *
 * @modelcontextprotocol/sdk 1.13.0 does not expose a public accessor for the
 * spawned child process (verified against dist/cjs/client/stdio.d.ts: `_process`
 * is private and no `pid` getter exists). This helper is the single, isolated
 * place that reaches into that private field, and it validates the value at
 * runtime so an SDK upgrade that changes internals degrades to `undefined`
 * instead of misbehaving.
 */
export function getStdioTransportPid(transport: Transport): number | undefined {
  if (!(transport instanceof StdioClientTransport)) {
    return undefined
  }
  const internals = transport as unknown as { _process?: { pid?: unknown } }
  const pid = internals._process?.pid
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Parses `ps -eo pid=,ppid=,rss=,pcpu=,comm=` output.
 * rss is reported by ps in kilobytes on both Linux (procps) and macOS (BSD ps).
 * The command field may contain spaces, so it is everything after the fourth column.
 */
export function parsePsOutput(output: string): ProcessSample[] {
  const samples: ProcessSample[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/)
    if (!match) continue
    samples.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      cpuPercent: Number(match[4]),
      command: match[5].trim()
    })
  }
  return samples
}

/**
 * Groups every process descending from rootPid into one aggregate per direct
 * child of rootPid: the child's own usage plus everything below it. This keeps
 * one log line per spawned server (or browser) even when it forks helpers of
 * its own (e.g. Chromium renderer processes).
 */
export function aggregateDirectChildSubtrees(samples: ProcessSample[], rootPid: number): SubtreeSample[] {
  const childrenByPpid = new Map<number, ProcessSample[]>()
  for (const sample of samples) {
    const siblings = childrenByPpid.get(sample.ppid)
    if (siblings) {
      siblings.push(sample)
    } else {
      childrenByPpid.set(sample.ppid, [sample])
    }
  }

  const collectSubtree = (pid: number, into: ProcessSample[], seen: Set<number>): void => {
    for (const child of childrenByPpid.get(pid) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      into.push(child)
      collectSubtree(child.pid, into, seen)
    }
  }

  const subtrees: SubtreeSample[] = []
  for (const directChild of childrenByPpid.get(rootPid) ?? []) {
    const members: ProcessSample[] = [directChild]
    collectSubtree(directChild.pid, members, new Set([directChild.pid]))
    subtrees.push({
      rootPid: directChild.pid,
      command: directChild.command,
      rssBytes: members.reduce((sum, m) => sum + m.rssBytes, 0),
      cpuPercent: members.reduce((sum, m) => sum + m.cpuPercent, 0),
      processCount: members.length
    })
  }
  return subtrees
}

/**
 * Samples the full OS process tree with a single `ps` invocation.
 *
 * @throws Error when `ps` is unavailable or exits abnormally.
 */
export function sampleProcessTree(): Promise<ProcessSample[]> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-eo', 'pid=,ppid=,rss=,pcpu=,comm='], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(parsePsOutput(stdout))
    })
  })
}

export function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
