import type { Resource } from '..'
import { log } from '../utils/general'
import {
  SubtreeSample,
  aggregateDirectChildSubtrees,
  formatMebibytes,
  sampleProcessTree,
  shortenProcessLabel
} from '../utils/resourceStats'

export interface TrackedProcess {
  name: string
  pid: number
}

export interface ResourceStatsServiceOptions {
  /** Sampling interval in milliseconds. Values <= 0 disable sampling entirely. */
  intervalMs: number
  /** Returns the currently running MCP server child processes to label by name. */
  getTrackedProcesses: () => TrackedProcess[]
}

/**
 * Periodically logs memory/CPU usage for the mcp-api process itself, every
 * child process subtree it has spawned (installed stdio MCP servers, the
 * Puppeteer-managed browser, package installs, ...), and a machine-facing
 * total, so resource consumption is visible in the service logs over time.
 */
export class ResourceStatsService implements Resource {
  private readonly intervalMs: number
  private readonly getTrackedProcesses: () => TrackedProcess[]
  private timer?: NodeJS.Timeout
  private sampling = false
  private samplingPromise?: Promise<void>
  private lastCpuUsage = process.cpuUsage()
  private lastCpuSampleAt = process.hrtime.bigint()
  private treeSamplingBroken = false

  constructor({ intervalMs, getTrackedProcesses }: ResourceStatsServiceOptions) {
    this.intervalMs = intervalMs
    this.getTrackedProcesses = getTrackedProcesses
  }

  public async init(): Promise<void> {
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      log({
        level: 'info',
        msg: `[resource-stats] disabled (RESOURCE_STATS_INTERVAL_MS must be a positive number of ms; got ${this.intervalMs})`
      })
      return
    }
    this.lastCpuUsage = process.cpuUsage()
    this.lastCpuSampleAt = process.hrtime.bigint()
    this.timer = setInterval(() => {
      // Skip this tick if the previous sample is still running (e.g. a slow or
      // blocked `ps`), so overlapping samples never pile up.
      if (this.sampling) {
        return
      }
      this.sampling = true
      this.samplingPromise = this.logSample()
        .catch((error) => {
          log({ level: 'debug', msg: '[resource-stats] sampling failed', error })
        })
        .finally(() => {
          this.sampling = false
          this.samplingPromise = undefined
        })
    }, this.intervalMs)
    // Never keep the process alive just to report stats
    this.timer.unref()
    log({ level: 'info', msg: `[resource-stats] sampling every ${this.intervalMs}ms` })
  }

  public async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    // Wait for any in-flight sample to finish so no sampling (spawning `ps`,
    // logging) overlaps the teardown of the services this samples.
    if (this.samplingPromise) {
      await this.samplingPromise
    }
  }

  private sampleSelfCpuPercent(): number {
    const now = process.hrtime.bigint()
    const elapsedMicros = Number(now - this.lastCpuSampleAt) / 1000
    const usage = process.cpuUsage(this.lastCpuUsage)
    this.lastCpuUsage = process.cpuUsage()
    this.lastCpuSampleAt = now
    if (elapsedMicros <= 0) {
      return 0
    }
    return ((usage.user + usage.system) / elapsedMicros) * 100
  }

  private async logSample(): Promise<void> {
    const memory = process.memoryUsage()
    const cpuPercent = this.sampleSelfCpuPercent()
    log({
      level: 'info',
      msg:
        `[resource-stats] self pid=${process.pid} rss=${formatMebibytes(memory.rss)} ` +
        `heapUsed=${formatMebibytes(memory.heapUsed)} heapTotal=${formatMebibytes(memory.heapTotal)} ` +
        `external=${formatMebibytes(memory.external)} cpu=${cpuPercent.toFixed(1)}%`
    })

    let subtrees: SubtreeSample[]
    try {
      const tree = await sampleProcessTree()
      subtrees = aggregateDirectChildSubtrees(tree, process.pid)
      this.treeSamplingBroken = false
    } catch (error) {
      // Warn once, then stay quiet: without `ps` only self stats are available
      if (!this.treeSamplingBroken) {
        this.treeSamplingBroken = true
        log({ level: 'warn', msg: '[resource-stats] cannot sample child processes (is `ps` available?)', error })
      }
      return
    }

    const nameByPid = new Map<number, string>()
    for (const tracked of this.getTrackedProcesses()) {
      nameByPid.set(tracked.pid, tracked.name)
    }

    for (const subtree of subtrees) {
      const name = nameByPid.get(subtree.rootPid) ?? shortenProcessLabel(subtree.command)
      log({
        level: 'info',
        msg:
          `[resource-stats] child name=${name} pid=${subtree.rootPid} ` +
          `rss=${formatMebibytes(subtree.rssBytes)} cpu=${subtree.cpuPercent.toFixed(1)}% procs=${subtree.processCount}`
      })
    }

    const childRss = subtrees.reduce((sum, subtree) => sum + subtree.rssBytes, 0)
    const childProcs = subtrees.reduce((sum, subtree) => sum + subtree.processCount, 0)
    log({
      level: 'info',
      msg:
        `[resource-stats] total rss=${formatMebibytes(memory.rss + childRss)} ` +
        `procs=${childProcs + 1} (self + ${childProcs} descendants)`
    })
  }
}
