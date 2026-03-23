import dns from 'dns/promises'
import net from 'net'
import { McpValidationError } from '../services/mcpErrors'

const IPV4_PRIVATE_RANGES: Array<[number, number]> = [
  [ipToInt('0.0.0.0'), ipToInt('0.255.255.255')],
  [ipToInt('10.0.0.0'), ipToInt('10.255.255.255')],
  [ipToInt('100.64.0.0'), ipToInt('100.127.255.255')],
  [ipToInt('127.0.0.0'), ipToInt('127.255.255.255')],
  [ipToInt('169.254.0.0'), ipToInt('169.254.255.255')],
  [ipToInt('172.16.0.0'), ipToInt('172.31.255.255')],
  [ipToInt('192.0.0.0'), ipToInt('192.0.0.255')],
  [ipToInt('192.0.2.0'), ipToInt('192.0.2.255')],
  [ipToInt('192.168.0.0'), ipToInt('192.168.255.255')],
  [ipToInt('198.18.0.0'), ipToInt('198.19.255.255')],
  [ipToInt('198.51.100.0'), ipToInt('198.51.100.255')],
  [ipToInt('203.0.113.0'), ipToInt('203.0.113.255')],
  [ipToInt('224.0.0.0'), ipToInt('255.255.255.255')]
]

function ipToInt(value: string): number {
  return value.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
}

function isPrivateIpv4(value: string): boolean {
  const intValue = ipToInt(value)
  return IPV4_PRIVATE_RANGES.some(([start, end]) => intValue >= start && intValue <= end)
}

function isBlockedIpv6(value: string): boolean {
  const normalized = value.toLowerCase()
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  )
}

function assertSafeIp(address: string): void {
  const family = net.isIP(address)
  if (family === 4 && isPrivateIpv4(address)) {
    throw new McpValidationError(`Blocked private or local IPv4 address: ${address}`)
  }
  if (family === 6 && isBlockedIpv6(address)) {
    throw new McpValidationError(`Blocked private or local IPv6 address: ${address}`)
  }
}

export async function validateExternalMcpUrl(urlString: string): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(urlString)
  } catch {
    throw new McpValidationError('External MCP server url must be a valid URL')
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new McpValidationError('External MCP server url must use http or https')
  }

  if (parsed.username || parsed.password) {
    throw new McpValidationError('External MCP server url must not include embedded credentials')
  }

  const hostname = parsed.hostname.trim().toLowerCase()
  if (!hostname) {
    throw new McpValidationError('External MCP server url hostname is required')
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new McpValidationError(`Blocked local hostname: ${hostname}`)
  }

  const literalFamily = net.isIP(hostname)
  if (literalFamily !== 0) {
    assertSafeIp(hostname)
    return parsed
  }

  const resolved = await dns.lookup(hostname, { all: true, verbatim: true })
  if (resolved.length === 0) {
    throw new McpValidationError(`Unable to resolve external MCP hostname: ${hostname}`)
  }

  resolved.forEach(({ address }) => assertSafeIp(address))
  return parsed
}
