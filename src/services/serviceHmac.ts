import { constants as fsConstants } from 'fs'
import { open } from 'fs/promises'
import { isAbsolute } from 'path'
import { createHash, createHmac, randomBytes } from 'crypto'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { log } from '../utils/general'
import { McpServiceHmacUnavailableError } from './mcpErrors'

export const COMMS_MANAGEMENT_HMAC_PROFILE = 'comms_management' as const
export const COMMS_MANAGEMENT_MCP_URL = 'https://comms-management:8080/internal/mcp' as const
const COMMS_MANAGEMENT_MCP_ORIGIN = 'https://comms-management:8080'
const COMMS_MANAGEMENT_MCP_PATHNAME = '/internal/mcp'

export type ServiceHmacProfile = typeof COMMS_MANAGEMENT_HMAC_PROFILE
export type ServiceHmacClock = () => number
export type ServiceHmacNonceSource = () => Uint8Array

export interface SymmetricKey {
  kid: string
  state: 'active' | 'previous'
  key: Buffer
  notBeforeUnixSeconds: number
  verifyUntilUnixSeconds: number
}

export interface SymmetricKeyring {
  version: '1'
  activeKid: string
  keys: SymmetricKey[]
}

interface ParsedDateTime {
  unixSeconds: number
}

const KEYRING_TOP_LEVEL_KEYS = new Set(['version', 'activeKid', 'keys'])
const KEYRING_KEY_KEYS = new Set(['kid', 'state', 'keyBase64url', 'notBefore', 'verifyUntil'])
const KID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/
const ALLOWED_FILE_MODES = new Set([0o400, 0o440])
const ALLOWED_METHODS = new Set(['POST', 'GET', 'DELETE'])
const RESERVED_HEADER_PREFIX = 'x-msq-'

class ServiceHmacKeyringError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServiceHmacKeyringError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function assertClosedObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  context: string
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ServiceHmacKeyringError(`${context} must be an object.`)
  }
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key))
  if (unknownKey) {
    throw new ServiceHmacKeyringError(`${context} contains an unknown property.`)
  }
}

const parseRfc3339 = (value: unknown, context: string): ParsedDateTime => {
  if (typeof value !== 'string') {
    throw new ServiceHmacKeyringError(`${context} must be an RFC 3339 date-time string.`)
  }
  const match = RFC3339_PATTERN.exec(value)
  if (!match) {
    throw new ServiceHmacKeyringError(`${context} must be an RFC 3339 date-time string.`)
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offset] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const offsetHour = offset === 'Z' ? 0 : Number(offset.slice(1, 3))
  const offsetMinute = offset === 'Z' ? 0 : Number(offset.slice(4, 6))
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new ServiceHmacKeyringError(`${context} must be a valid RFC 3339 date-time string.`)
  }

  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    throw new ServiceHmacKeyringError(`${context} must be a valid RFC 3339 date-time string.`)
  }
  return { unixSeconds: milliseconds / 1000 }
}

const parseKey = (value: unknown, index: number): SymmetricKey => {
  const context = `keys[${index}]`
  assertClosedObject(value, KEYRING_KEY_KEYS, context)

  const { kid, state, keyBase64url, notBefore, verifyUntil } = value
  if (typeof kid !== 'string' || !KID_PATTERN.test(kid)) {
    throw new ServiceHmacKeyringError(`${context}.kid is invalid.`)
  }
  if (state !== 'active' && state !== 'previous') {
    throw new ServiceHmacKeyringError(`${context}.state is invalid.`)
  }
  if (typeof keyBase64url !== 'string' || !BASE64URL_PATTERN.test(keyBase64url)) {
    throw new ServiceHmacKeyringError(`${context}.keyBase64url must be unpadded base64url.`)
  }

  const key = Buffer.from(keyBase64url, 'base64url')
  if (key.length !== 32 || key.toString('base64url') !== keyBase64url) {
    throw new ServiceHmacKeyringError(`${context}.keyBase64url must encode exactly 32 bytes.`)
  }

  const parsedNotBefore = parseRfc3339(notBefore, `${context}.notBefore`)
  const parsedVerifyUntil = parseRfc3339(verifyUntil, `${context}.verifyUntil`)
  if (parsedNotBefore.unixSeconds >= parsedVerifyUntil.unixSeconds) {
    throw new ServiceHmacKeyringError(`${context} must satisfy notBefore < verifyUntil.`)
  }

  return {
    kid,
    state,
    key,
    notBeforeUnixSeconds: parsedNotBefore.unixSeconds,
    verifyUntilUnixSeconds: parsedVerifyUntil.unixSeconds
  }
}

export const parseSymmetricKeyring = (json: string): SymmetricKeyring => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new ServiceHmacKeyringError('Keyring must contain valid JSON.')
  }

  assertClosedObject(parsed, KEYRING_TOP_LEVEL_KEYS, 'Keyring')
  if (parsed.version !== '1') {
    throw new ServiceHmacKeyringError('Keyring.version must equal "1".')
  }
  if (typeof parsed.activeKid !== 'string' || !KID_PATTERN.test(parsed.activeKid)) {
    throw new ServiceHmacKeyringError('Keyring.activeKid is invalid.')
  }
  if (!Array.isArray(parsed.keys) || parsed.keys.length < 1 || parsed.keys.length > 2) {
    throw new ServiceHmacKeyringError('Keyring.keys must contain one or two keys.')
  }

  const keys = parsed.keys.map(parseKey)
  if (new Set(keys.map(({ kid }) => kid)).size !== keys.length) {
    throw new ServiceHmacKeyringError('Keyring kids must be unique.')
  }
  const activeKeys = keys.filter(({ state }) => state === 'active')
  const previousKeys = keys.filter(({ state }) => state === 'previous')
  if (activeKeys.length !== 1 || previousKeys.length > 1) {
    throw new ServiceHmacKeyringError('Keyring must contain exactly one active key and at most one previous key.')
  }
  if (activeKeys[0].kid !== parsed.activeKid) {
    throw new ServiceHmacKeyringError('Keyring.activeKid must match the active key.')
  }

  return {
    version: '1',
    activeKid: parsed.activeKid,
    keys
  }
}

export const loadSymmetricKeyringFile = async (keyFilePath: string): Promise<SymmetricKeyring> => {
  if (!isAbsolute(keyFilePath)) {
    throw new ServiceHmacKeyringError('The service-HMAC key file path must be absolute.')
  }

  let fileHandle
  try {
    fileHandle = await open(keyFilePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    throw new ServiceHmacKeyringError('The service-HMAC key file could not be opened securely.')
  }

  try {
    const stats = await fileHandle.stat()
    if (!stats.isFile()) {
      throw new ServiceHmacKeyringError('The service-HMAC key file must be a regular file.')
    }
    const mode = stats.mode & 0o7777
    if (!ALLOWED_FILE_MODES.has(mode)) {
      throw new ServiceHmacKeyringError('The service-HMAC key file mode must be 0400 or 0440.')
    }
    return parseSymmetricKeyring(await fileHandle.readFile({ encoding: 'utf8' }))
  } finally {
    await fileHandle.close()
  }
}

const getActiveKey = (keyring: SymmetricKeyring, unixSeconds: number): SymmetricKey | undefined => {
  const activeKey = keyring.keys.find(({ state }) => state === 'active')
  if (
    !activeKey ||
    activeKey.kid !== keyring.activeKid ||
    unixSeconds < activeKey.notBeforeUnixSeconds ||
    unixSeconds >= activeKey.verifyUntilUnixSeconds
  ) {
    return undefined
  }
  return activeKey
}

type RequestBody = RequestInit['body']

interface NormalizedBody {
  bytes: Uint8Array
  body: RequestBody
}

const normalizeBody = (body: RequestBody): NormalizedBody => {
  if (body === undefined || body === null) {
    return { bytes: new Uint8Array(0), body }
  }
  if (typeof body === 'string') {
    return { bytes: Buffer.from(body, 'utf8'), body }
  }
  if (body instanceof ArrayBuffer) {
    const bytes = new Uint8Array(body.slice(0))
    return { bytes, body: bytes }
  }
  if (ArrayBuffer.isView(body)) {
    const bytes = new Uint8Array(body.byteLength)
    bytes.set(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
    return { bytes, body: bytes }
  }
  throw new McpServiceHmacUnavailableError(
    COMMS_MANAGEMENT_HMAC_PROFILE,
    'The service-HMAC transport does not support this request body type.'
  )
}

const resolveRequestUrl = (input: string | URL): URL => {
  let url: URL
  try {
    url = new URL(input.toString())
  } catch {
    throw new McpServiceHmacUnavailableError(
      COMMS_MANAGEMENT_HMAC_PROFILE,
      'The service-HMAC transport received an invalid request URL.'
    )
  }

  if (
    url.origin !== COMMS_MANAGEMENT_MCP_ORIGIN ||
    url.pathname !== COMMS_MANAGEMENT_MCP_PATHNAME ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new McpServiceHmacUnavailableError(
      COMMS_MANAGEMENT_HMAC_PROFILE,
      'The service-HMAC transport rejected an out-of-profile request URL.'
    )
  }
  return url
}

export interface ServiceHmacProviderOptions {
  keyFilePath?: string
  clock?: ServiceHmacClock
  nonceSource?: ServiceHmacNonceSource
  fetch?: FetchLike
}

export class ServiceHmacProvider {
  private readonly keyFilePath?: string
  private readonly clock: ServiceHmacClock
  private readonly nonceSource: ServiceHmacNonceSource
  private readonly underlyingFetch: FetchLike
  private readonly sighupHandler: () => void
  private keyring?: SymmetricKeyring
  private available = false
  private initialized = false
  private reloadQueue: Promise<void> = Promise.resolve()

  constructor({
    keyFilePath,
    clock = () => Math.floor(Date.now() / 1000),
    nonceSource = () => randomBytes(16),
    fetch: fetchImplementation = (url, init) => globalThis.fetch(url, init)
  }: ServiceHmacProviderOptions = {}) {
    this.keyFilePath = keyFilePath
    this.clock = clock
    this.nonceSource = nonceSource
    this.underlyingFetch = fetchImplementation
    this.sighupHandler = () => {
      void this.reload()
    }
  }

  public async init(): Promise<void> {
    if (!this.initialized) {
      process.on('SIGHUP', this.sighupHandler)
      this.initialized = true
    }
    await this.reload()
  }

  public async stop(): Promise<void> {
    if (this.initialized) {
      process.removeListener('SIGHUP', this.sighupHandler)
      this.initialized = false
    }
  }

  public reload(): Promise<void> {
    this.reloadQueue = this.reloadQueue.then(() => this.reloadCandidate())
    return this.reloadQueue
  }

  public isReady(): boolean {
    if (!this.available || !this.keyring) {
      return false
    }
    return getActiveKey(this.keyring, this.readClock()) !== undefined
  }

  public assertReady(): void {
    if (!this.isReady()) {
      throw new McpServiceHmacUnavailableError(COMMS_MANAGEMENT_HMAC_PROFILE)
    }
  }

  public createSignedFetch(): FetchLike {
    return async (input, init) => {
      const url = resolveRequestUrl(input)
      const method = init?.method ?? 'GET'
      if (!ALLOWED_METHODS.has(method)) {
        throw new McpServiceHmacUnavailableError(
          COMMS_MANAGEMENT_HMAC_PROFILE,
          'The service-HMAC transport rejected an unsupported HTTP method.'
        )
      }

      const normalizedBody = normalizeBody(init?.body)
      const headers = new Headers(init?.headers)
      for (const [name] of headers.entries()) {
        if (name.toLowerCase().startsWith(RESERVED_HEADER_PREFIX)) {
          throw new McpServiceHmacUnavailableError(
            COMMS_MANAGEMENT_HMAC_PROFILE,
            'The service-HMAC transport rejected a caller-supplied authentication header.'
          )
        }
      }

      const timestamp = this.readClock()
      const activeKey = this.available && this.keyring ? getActiveKey(this.keyring, timestamp) : undefined
      if (!activeKey) {
        throw new McpServiceHmacUnavailableError(COMMS_MANAGEMENT_HMAC_PROFILE)
      }

      let nonceBytes: Uint8Array
      try {
        nonceBytes = this.nonceSource()
      } catch {
        throw new McpServiceHmacUnavailableError(
          COMMS_MANAGEMENT_HMAC_PROFILE,
          'The service-HMAC nonce source failed.'
        )
      }
      if (nonceBytes.byteLength !== 16) {
        throw new McpServiceHmacUnavailableError(
          COMMS_MANAGEMENT_HMAC_PROFILE,
          'The service-HMAC nonce source did not return 16 bytes.'
        )
      }
      const nonce = Buffer.from(nonceBytes).toString('base64url')
      const bodySha256 = createHash('sha256').update(normalizedBody.bytes).digest('hex')
      const pathnameAndQuery = `${url.pathname}${url.search}`
      const signingString = `v1\n${method}\n${pathnameAndQuery}\n${timestamp}\n${nonce}\n${bodySha256}`
      const signature = createHmac('sha256', activeKey.key).update(signingString, 'utf8').digest('base64url')

      headers.set('X-MSQ-Key-Id', activeKey.kid)
      headers.set('X-MSQ-Timestamp', timestamp.toString())
      headers.set('X-MSQ-Nonce', nonce)
      headers.set('X-MSQ-Body-SHA256', bodySha256)
      headers.set('X-MSQ-Signature', signature)

      return this.underlyingFetch(url, {
        ...init,
        method,
        headers,
        body: normalizedBody.body,
        redirect: 'error'
      })
    }
  }

  private readClock(): number {
    let clockValue: number
    try {
      clockValue = this.clock()
    } catch {
      throw new McpServiceHmacUnavailableError(
        COMMS_MANAGEMENT_HMAC_PROFILE,
        'The service-HMAC clock failed.'
      )
    }
    const timestamp = Math.floor(clockValue)
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new McpServiceHmacUnavailableError(
        COMMS_MANAGEMENT_HMAC_PROFILE,
        'The service-HMAC clock did not return valid Unix seconds.'
      )
    }
    return timestamp
  }

  private async reloadCandidate(): Promise<void> {
    if (!this.keyFilePath) {
      this.available = false
      log({ level: 'warn', msg: 'Service-HMAC profile unavailable: key file is not configured.' })
      return
    }

    try {
      const candidate = await loadSymmetricKeyringFile(this.keyFilePath)
      if (!getActiveKey(candidate, this.readClock())) {
        throw new ServiceHmacKeyringError('The active service-HMAC key is outside its signing window.')
      }
      this.keyring = candidate
      this.available = true
      log({ level: 'info', msg: `Service-HMAC profile keyring loaded (kid ${candidate.activeKid}).` })
    } catch {
      this.available = false
      log({ level: 'warn', msg: 'Service-HMAC profile unavailable: keyring validation failed.' })
    }
  }
}
