import { createHash, createHmac } from 'crypto'
import { chmod, mkdtemp, rename, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { McpServiceHmacUnavailableError, toMcpErrorResponse } from '../src/services/mcpErrors'
import { MCPService } from '../src/services/mcp'
import {
  COMMS_MANAGEMENT_MCP_URL,
  ServiceHmacProvider,
  loadSymmetricKeyringFile,
  parseSymmetricKeyring
} from '../src/services/serviceHmac'

const FIXED_UNIX_SECONDS = 1_700_000_000
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const ACTIVE_KEY = Buffer.alloc(32, 0x11)

interface KeyFixture {
  kid: string
  state: 'active' | 'previous'
  keyBase64url: string
  notBefore: string
  verifyUntil: string
}

interface CapturedRequest {
  url: URL
  method: string
  headers: Headers
  body: RequestInit['body']
  redirect: RequestInit['redirect']
}

const temporaryDirectories: string[] = []
const providers: ServiceHmacProvider[] = []

const createKey = (
  kid: string,
  state: 'active' | 'previous',
  byte: number,
  overrides: Partial<KeyFixture> = {}
): KeyFixture => ({
  kid,
  state,
  keyBase64url: Buffer.alloc(32, byte).toString('base64url'),
  notBefore: '2023-01-01T00:00:00Z',
  verifyUntil: '2030-01-01T00:00:00Z',
  ...overrides
})

const createKeyringJson = (
  activeKid = 'active-1',
  activeByte = 0x11,
  previous?: KeyFixture
): string =>
  JSON.stringify({
    version: '1',
    activeKid,
    keys: [createKey(activeKid, 'active', activeByte), ...(previous ? [previous] : [])]
  })

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-service-hmac-'))
  temporaryDirectories.push(directory)
  return directory
}

const writeKeyring = async (directory: string, json: string, name = 'keyring.json'): Promise<string> => {
  const path = join(directory, name)
  await writeFile(path, json, { mode: 0o400 })
  await chmod(path, 0o400)
  return path
}

const replaceKeyring = async (path: string, json: string): Promise<void> => {
  const candidatePath = `${path}.candidate`
  await writeFile(candidatePath, json, { mode: 0o400 })
  await chmod(candidatePath, 0o400)
  await rename(candidatePath, path)
}

const bodyBytes = (body: RequestInit['body']): Buffer => {
  if (body === undefined || body === null) {
    return Buffer.alloc(0)
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8')
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body)
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  }
  throw new Error('Receiver was given an unsupported body type')
}

const verifyCapturedRequest = (
  request: CapturedRequest,
  keys: ReadonlyMap<string, Buffer>
): boolean => {
  const kid = request.headers.get('X-MSQ-Key-Id')
  const timestamp = request.headers.get('X-MSQ-Timestamp')
  const nonce = request.headers.get('X-MSQ-Nonce')
  const suppliedBodyHash = request.headers.get('X-MSQ-Body-SHA256')
  const suppliedSignature = request.headers.get('X-MSQ-Signature')
  if (!kid || !timestamp || !nonce || !suppliedBodyHash || !suppliedSignature) {
    return false
  }

  const key = keys.get(kid)
  if (!key) {
    return false
  }
  const computedBodyHash = createHash('sha256').update(bodyBytes(request.body)).digest('hex')
  if (computedBodyHash !== suppliedBodyHash) {
    return false
  }

  const signingString = [
    'v1',
    request.method,
    `${request.url.pathname}${request.url.search}`,
    timestamp,
    nonce,
    suppliedBodyHash
  ].join('\n')
  const computedSignature = createHmac('sha256', key).update(signingString, 'utf8').digest('base64url')
  return computedSignature === suppliedSignature
}

const cloneCapturedRequest = (
  request: CapturedRequest,
  overrides: Partial<Omit<CapturedRequest, 'headers'>> & { headers?: RequestInit['headers'] } = {}
): CapturedRequest => ({
  ...request,
  ...overrides,
  headers: new Headers(overrides.headers ?? request.headers)
})

const createCapturingFetch = (): { fetch: FetchLike; requests: CapturedRequest[] } => {
  const requests: CapturedRequest[] = []
  const fetch: FetchLike = async (url, init) => {
    requests.push({
      url: new URL(url.toString()),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
      redirect: init?.redirect
    })
    return new Response(null, { status: 204 })
  }
  return { fetch, requests }
}

const createProvider = async ({
  keyringJson = createKeyringJson(),
  nonceSource = () => Uint8Array.from({ length: 16 }, (_, index) => index),
  fetch
}: {
  keyringJson?: string
  nonceSource?: () => Uint8Array
  fetch: FetchLike
}): Promise<{ provider: ServiceHmacProvider; keyFilePath: string }> => {
  const directory = await createTemporaryDirectory()
  const keyFilePath = await writeKeyring(directory, keyringJson)
  const provider = new ServiceHmacProvider({
    keyFilePath,
    clock: () => FIXED_UNIX_SECONDS,
    nonceSource,
    fetch
  })
  providers.push(provider)
  await provider.init()
  return { provider, keyFilePath }
}

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.stop()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('service-HMAC keyring contract', () => {
  test('parses the closed active/previous keyring and preserves previous as verify-only metadata', () => {
    const previous = createKey('previous-1', 'previous', 0x22)
    const parsed = parseSymmetricKeyring(createKeyringJson('active-1', 0x11, previous))

    expect(parsed).toEqual({
      version: '1',
      activeKid: 'active-1',
      keys: [
        expect.objectContaining({ kid: 'active-1', state: 'active', key: ACTIVE_KEY }),
        expect.objectContaining({ kid: 'previous-1', state: 'previous', key: Buffer.alloc(32, 0x22) })
      ]
    })
  })

  test.each([
    ['unknown top-level property', { version: '1', activeKid: 'active-1', keys: [createKey('active-1', 'active', 0x11)], extra: true }],
    ['missing active key', { version: '1', activeKid: 'previous-1', keys: [createKey('previous-1', 'previous', 0x11)] }],
    ['duplicate kids', { version: '1', activeKid: 'duplicate', keys: [createKey('duplicate', 'active', 0x11), createKey('duplicate', 'previous', 0x22)] }],
    ['mismatched activeKid', { version: '1', activeKid: 'other', keys: [createKey('active-1', 'active', 0x11)] }],
    ['padded base64url', { version: '1', activeKid: 'active-1', keys: [createKey('active-1', 'active', 0x11, { keyBase64url: `${ACTIVE_KEY.toString('base64url')}=` })] }],
    ['wrong decoded length', { version: '1', activeKid: 'active-1', keys: [createKey('active-1', 'active', 0x11, { keyBase64url: Buffer.alloc(31, 0x11).toString('base64url') })] }],
    ['unordered window', { version: '1', activeKid: 'active-1', keys: [createKey('active-1', 'active', 0x11, { notBefore: '2030-01-01T00:00:00Z', verifyUntil: '2029-01-01T00:00:00Z' })] }],
    ['invalid calendar date', { version: '1', activeKid: 'active-1', keys: [createKey('active-1', 'active', 0x11, { notBefore: '2023-02-30T00:00:00Z' })] }]
  ])('rejects %s', (_name, keyring) => {
    expect(() => parseSymmetricKeyring(JSON.stringify(keyring))).toThrow()
  })

  test('loads only absolute regular non-symlink files with mode 0400 or 0440', async () => {
    const directory = await createTemporaryDirectory()
    const keyFilePath = await writeKeyring(directory, createKeyringJson())
    await expect(loadSymmetricKeyringFile(keyFilePath)).resolves.toMatchObject({ activeKid: 'active-1' })

    await chmod(keyFilePath, 0o440)
    await expect(loadSymmetricKeyringFile(keyFilePath)).resolves.toMatchObject({ activeKid: 'active-1' })

    await chmod(keyFilePath, 0o600)
    await expect(loadSymmetricKeyringFile(keyFilePath)).rejects.toThrow('mode must be 0400 or 0440')
    await expect(loadSymmetricKeyringFile('relative-keyring.json')).rejects.toThrow('must be absolute')

    const targetPath = await writeKeyring(directory, createKeyringJson(), 'target.json')
    const linkPath = join(directory, 'link.json')
    await symlink(targetPath, linkPath)
    await expect(loadSymmetricKeyringFile(linkPath)).rejects.toThrow('could not be opened securely')
  })
})

describe('service-HMAC signed fetch contract', () => {
  test.each([
    {
      method: 'POST',
      path: '?sessionId=abc',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1 }),
      nonce: Uint8Array.from({ length: 16 }, (_, index) => index),
      expectedHash: 'fe46396dd3e614a8ae91a84e50c35548d8a5d7940d74dd33dc20c86f042329bc',
      expectedNonce: 'AAECAwQFBgcICQoLDA0ODw',
      expectedSignature: '4xSjVM1VIKlOm0IM5YPTIZavNnz2wToJ4YNtOGXHpD0'
    },
    {
      method: 'GET',
      path: '',
      body: undefined,
      nonce: Buffer.alloc(16, 0x22),
      expectedHash: EMPTY_SHA256,
      expectedNonce: 'IiIiIiIiIiIiIiIiIiIiIg',
      expectedSignature: 'WKFCwkhBJq-om6ZKRAWD0PRXRqQOdi9OQf4HwC8j7vA'
    },
    {
      method: 'DELETE',
      path: '?sessionId=gone',
      body: undefined,
      nonce: Buffer.alloc(16, 0x33),
      expectedHash: EMPTY_SHA256,
      expectedNonce: 'MzMzMzMzMzMzMzMzMzMzMw',
      expectedSignature: 'uwMe6DyGfQPj6svlu1iyBDXSdmMyhyVFqH0ln3jzWtc'
    }
  ])('matches the independent $method golden vector', async ({ method, path, body, nonce, expectedHash, expectedNonce, expectedSignature }) => {
    const capture = createCapturingFetch()
    const { provider } = await createProvider({ fetch: capture.fetch, nonceSource: () => nonce })

    await provider.createSignedFetch()(`${COMMS_MANAGEMENT_MCP_URL}${path}`, {
      method,
      headers: { Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': 'sdk-session' },
      body
    })

    expect(capture.requests).toHaveLength(1)
    const request = capture.requests[0]
    expect(request.redirect).toBe('error')
    expect(request.method).toBe(method)
    expect(request.headers.get('accept')).toBe('application/json, text/event-stream')
    expect(request.headers.get('mcp-session-id')).toBe('sdk-session')
    expect(request.headers.get('X-MSQ-Key-Id')).toBe('active-1')
    expect(request.headers.get('X-MSQ-Timestamp')).toBe(String(FIXED_UNIX_SECONDS))
    expect(request.headers.get('X-MSQ-Nonce')).toBe(expectedNonce)
    expect(request.headers.get('X-MSQ-Body-SHA256')).toBe(expectedHash)
    expect(request.headers.get('X-MSQ-Signature')).toBe(expectedSignature)
    expect(bodyBytes(request.body)).toEqual(Buffer.from(body ?? '', 'utf8'))
    expect(verifyCapturedRequest(request, new Map([['active-1', ACTIVE_KEY]]))).toBe(true)
  })

  test('binds method, pathname, query, body, timestamp, nonce, key ID, and signature', async () => {
    const capture = createCapturingFetch()
    const { provider } = await createProvider({ fetch: capture.fetch })
    await provider.createSignedFetch()(`${COMMS_MANAGEMENT_MCP_URL}?sessionId=abc`, {
      method: 'POST',
      body: 'body'
    })
    const request = capture.requests[0]
    const keys = new Map([['active-1', ACTIVE_KEY]])
    expect(verifyCapturedRequest(request, keys)).toBe(true)

    const mutations: CapturedRequest[] = [
      cloneCapturedRequest(request, { method: 'DELETE' }),
      cloneCapturedRequest(request, { url: new URL('https://comms-management:8080/internal/other?sessionId=abc') }),
      cloneCapturedRequest(request, { url: new URL(`${COMMS_MANAGEMENT_MCP_URL}?sessionId=changed`) }),
      cloneCapturedRequest(request, { body: 'changed-body' })
    ]
    for (const [header, value] of [
      ['X-MSQ-Timestamp', String(FIXED_UNIX_SECONDS + 1)],
      ['X-MSQ-Nonce', Buffer.alloc(16, 0x77).toString('base64url')],
      ['X-MSQ-Key-Id', 'unknown'],
      ['X-MSQ-Signature', 'invalid']
    ]) {
      const headers = new Headers(request.headers)
      headers.set(header, value)
      mutations.push(cloneCapturedRequest(request, { headers }))
    }

    for (const mutation of mutations) {
      expect(verifyCapturedRequest(mutation, keys)).toBe(false)
    }
  })

  test('creates a fresh nonce and signature for every transport attempt', async () => {
    let nonceCounter = 0
    const capture = createCapturingFetch()
    const { provider } = await createProvider({
      fetch: capture.fetch,
      nonceSource: () => Buffer.alloc(16, ++nonceCounter)
    })
    const signedFetch = provider.createSignedFetch()

    await signedFetch(COMMS_MANAGEMENT_MCP_URL, { method: 'POST', body: 'same-body' })
    await signedFetch(COMMS_MANAGEMENT_MCP_URL, { method: 'POST', body: 'same-body' })

    expect(capture.requests).toHaveLength(2)
    expect(capture.requests[0].headers.get('X-MSQ-Nonce')).not.toBe(capture.requests[1].headers.get('X-MSQ-Nonce'))
    expect(capture.requests[0].headers.get('X-MSQ-Signature')).not.toBe(capture.requests[1].headers.get('X-MSQ-Signature'))
  })

  test('rejects reserved caller headers, redirects, URL drift, methods, and unsupported bodies before disclosure', async () => {
    let nonceCalls = 0
    let underlyingCalls = 0
    const provider = new ServiceHmacProvider({
      clock: () => FIXED_UNIX_SECONDS,
      nonceSource: () => {
        nonceCalls += 1
        return Buffer.alloc(16)
      },
      fetch: async () => {
        underlyingCalls += 1
        return new Response(null, { status: 204 })
      }
    })
    providers.push(provider)
    const signedFetch = provider.createSignedFetch()

    const invalidUrls = [
      'https://comms-management/internal/mcp',
      'https://comms-management:8081/internal/mcp',
      'http://comms-management:8080/internal/mcp',
      'https://other:8080/internal/mcp',
      'https://comms-management:8080/internal/other',
      'https://comms-management:8080/internal/mcp#fragment'
    ]
    for (const url of invalidUrls) {
      await expect(signedFetch(url, { method: 'GET' })).rejects.toThrow('out-of-profile request URL')
    }
    await expect(signedFetch(COMMS_MANAGEMENT_MCP_URL, { method: 'PUT' })).rejects.toThrow('unsupported HTTP method')
    await expect(signedFetch(COMMS_MANAGEMENT_MCP_URL, { method: 'post' })).rejects.toThrow('unsupported HTTP method')
    await expect(signedFetch(COMMS_MANAGEMENT_MCP_URL, { method: 'POST', body: new FormData() })).rejects.toThrow('body type')
    await expect(signedFetch(COMMS_MANAGEMENT_MCP_URL, { method: 'POST', body: new ReadableStream() })).rejects.toThrow('body type')
    await expect(signedFetch(COMMS_MANAGEMENT_MCP_URL, {
      method: 'GET',
      headers: { 'x-MsQ-sIgNaTuRe': 'static' }
    })).rejects.toThrow('caller-supplied authentication header')

    expect(nonceCalls).toBe(0)
    expect(underlyingCalls).toBe(0)
  })

  test('accepts UTF-8 strings and byte arrays without changing transmitted bytes', async () => {
    const capture = createCapturingFetch()
    const { provider } = await createProvider({ fetch: capture.fetch })
    const signedFetch = provider.createSignedFetch()
    const utf8 = 'snowman ☃'
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255])

    await signedFetch(COMMS_MANAGEMENT_MCP_URL, { method: 'POST', body: utf8 })
    await signedFetch(COMMS_MANAGEMENT_MCP_URL, { method: 'POST', body: bytes })

    expect(bodyBytes(capture.requests[0].body)).toEqual(Buffer.from(utf8, 'utf8'))
    expect(bodyBytes(capture.requests[1].body)).toEqual(Buffer.from(bytes))
    expect(capture.requests[0].headers.get('X-MSQ-Body-SHA256')).toBe(
      createHash('sha256').update(Buffer.from(utf8, 'utf8')).digest('hex')
    )
    expect(capture.requests[1].headers.get('X-MSQ-Body-SHA256')).toBe(
      createHash('sha256').update(bytes).digest('hex')
    )
  })
})

describe('service-HMAC readiness and reload', () => {
  test('missing and invalid initial keyrings are unavailable without invoking fetch', async () => {
    let underlyingCalls = 0
    const missingProvider = new ServiceHmacProvider({
      clock: () => FIXED_UNIX_SECONDS,
      fetch: async () => {
        underlyingCalls += 1
        return new Response(null, { status: 204 })
      }
    })
    providers.push(missingProvider)
    await missingProvider.init()
    expect(missingProvider.isReady()).toBe(false)
    expect(() => missingProvider.assertReady()).toThrow(McpServiceHmacUnavailableError)
    await expect(missingProvider.createSignedFetch()(COMMS_MANAGEMENT_MCP_URL, { method: 'GET' })).rejects.toThrow(
      McpServiceHmacUnavailableError
    )

    const directory = await createTemporaryDirectory()
    const invalidPath = await writeKeyring(directory, '{"version":"1"}')
    const invalidProvider = new ServiceHmacProvider({ keyFilePath: invalidPath, clock: () => FIXED_UNIX_SECONDS })
    providers.push(invalidProvider)
    await invalidProvider.init()
    expect(invalidProvider.isReady()).toBe(false)
    expect(() => invalidProvider.assertReady()).toThrow(McpServiceHmacUnavailableError)
    expect(underlyingCalls).toBe(0)
  })

  test('unavailable readiness serializes through the typed MCP error contract', () => {
    expect(toMcpErrorResponse(new McpServiceHmacUnavailableError('comms_management'))).toEqual({
      statusCode: 503,
      body: {
        success: false,
        error: 'Service-HMAC profile comms_management is unavailable.',
        code: 'service_unavailable',
        serviceHmacProfile: 'comms_management'
      }
    })
  })

  test('valid reload atomically changes the active signing key and never selects previous', async () => {
    const capture = createCapturingFetch()
    const previous = createKey('previous-1', 'previous', 0x44)
    const { provider, keyFilePath } = await createProvider({
      fetch: capture.fetch,
      keyringJson: createKeyringJson('active-1', 0x11, previous)
    })
    const signedFetch = provider.createSignedFetch()

    await signedFetch(COMMS_MANAGEMENT_MCP_URL, { method: 'GET' })
    expect(capture.requests[0].headers.get('X-MSQ-Key-Id')).toBe('active-1')

    await replaceKeyring(keyFilePath, createKeyringJson('active-2', 0x22, createKey('active-1', 'previous', 0x11)))
    await provider.reload()
    await signedFetch(COMMS_MANAGEMENT_MCP_URL, { method: 'GET' })
    expect(capture.requests[1].headers.get('X-MSQ-Key-Id')).toBe('active-2')
    expect(capture.requests.every((request) => request.headers.get('X-MSQ-Key-Id') !== 'previous-1')).toBe(true)
  })

  test('invalid reload retains the prior candidate for recovery but disables signing until a valid reload', async () => {
    const capture = createCapturingFetch()
    const { provider, keyFilePath } = await createProvider({ fetch: capture.fetch })
    const signedFetch = provider.createSignedFetch()

    await replaceKeyring(keyFilePath, '{"version":"1"}')
    await provider.reload()
    expect(provider.isReady()).toBe(false)
    await expect(signedFetch(COMMS_MANAGEMENT_MCP_URL, { method: 'GET' })).rejects.toThrow(McpServiceHmacUnavailableError)
    expect(capture.requests).toHaveLength(0)

    await replaceKeyring(keyFilePath, createKeyringJson('active-2', 0x22))
    await provider.reload()
    expect(provider.isReady()).toBe(true)
    await signedFetch(COMMS_MANAGEMENT_MCP_URL, { method: 'GET' })
    expect(capture.requests[0].headers.get('X-MSQ-Key-Id')).toBe('active-2')
  })

  test('SIGHUP reloads the candidate and stop removes the owned listener', async () => {
    const initialListeners = process.listenerCount('SIGHUP')
    const capture = createCapturingFetch()
    const { provider, keyFilePath } = await createProvider({ fetch: capture.fetch })
    expect(process.listenerCount('SIGHUP')).toBe(initialListeners + 1)

    await replaceKeyring(keyFilePath, createKeyringJson('active-2', 0x22))
    process.emit('SIGHUP')

    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      await provider.createSignedFetch()(COMMS_MANAGEMENT_MCP_URL, { method: 'GET' })
      if (capture.requests.at(-1)?.headers.get('X-MSQ-Key-Id') === 'active-2') {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(capture.requests.at(-1)?.headers.get('X-MSQ-Key-Id')).toBe('active-2')

    await provider.stop()
    expect(process.listenerCount('SIGHUP')).toBe(initialListeners)
  })
})

describe('service-HMAC MCP service isolation', () => {
  const createMcpService = (serviceHmacProvider?: ServiceHmacProvider): MCPService =>
    new MCPService({
      mongoParams: { host: 'localhost:27017', db: 'test', user: 'user', pass: 'pass' },
      secretsService: {
        getUserServerSecrets: jest.fn().mockResolvedValue({})
      } as never,
      userServerInstalls: {} as never,
      serviceHmacProvider
    })

  const serviceHmacServer = {
    name: 'comms-management',
    source: 'platform' as const,
    transportType: 'streamable_http' as const,
    authMode: 'service_hmac' as const,
    serviceHmacProfile: 'comms_management' as const,
    url: COMMS_MANAGEMENT_MCP_URL,
    status: 'disconnected' as const,
    enabled: true
  }

  test('selects signed fetch only for the validated service profile', async () => {
    const capture = createCapturingFetch()
    const { provider } = await createProvider({ fetch: capture.fetch })
    const signedFetchSpy = jest.spyOn(provider, 'createSignedFetch')
    const service = createMcpService(provider)
    const buildTransportOptions = Reflect.get(service, 'buildTransportOptions').bind(service)

    const signedOptions = await buildTransportOptions(serviceHmacServer, 'runtime-user')
    expect(signedOptions.fetch).toBeInstanceOf(Function)
    expect(signedFetchSpy).toHaveBeenCalledTimes(1)

    const noneOptions = await buildTransportOptions({
      name: 'ordinary-http',
      source: 'platform',
      transportType: 'streamable_http',
      authMode: 'none',
      url: 'https://example.com/mcp',
      headers: { 'X-Existing': 'preserved' },
      status: 'disconnected',
      enabled: true
    })
    const oauthOptions = await buildTransportOptions({
      name: 'ordinary-oauth',
      source: 'external',
      transportType: 'streamable_http',
      authMode: 'oauth2',
      url: 'https://example.com/mcp',
      status: 'disconnected',
      enabled: true
    })
    const stdioOptions = await buildTransportOptions({
      name: 'ordinary-stdio',
      source: 'platform',
      transportType: 'stdio',
      authMode: 'none',
      command: 'node',
      args: ['server.js'],
      env: {},
      status: 'disconnected',
      enabled: true
    })

    expect(noneOptions.fetch).toBeUndefined()
    expect(oauthOptions.fetch).toBeUndefined()
    expect(stdioOptions).toEqual({})
    expect(signedFetchSpy).toHaveBeenCalledTimes(1)
  })

  test('missing signing readiness blocks only service-HMAC transport options', async () => {
    const service = createMcpService()
    const buildTransportOptions = Reflect.get(service, 'buildTransportOptions').bind(service)

    await expect(buildTransportOptions(serviceHmacServer, 'runtime-user')).rejects.toThrow(
      McpServiceHmacUnavailableError
    )
    await expect(buildTransportOptions({
      name: 'ordinary-http',
      source: 'platform',
      transportType: 'streamable_http',
      authMode: 'none',
      url: 'https://example.com/mcp',
      status: 'disconnected',
      enabled: true
    })).resolves.toEqual({})
  })

  test('invalid add configuration fails before database access or network work', async () => {
    const service = createMcpService()
    const findOne = jest.fn()
    const insert = jest.fn()
    Reflect.set(service, 'mcpDBClient', { findOne, insert })

    await expect(service.addServer({
      name: 'invalid-comms',
      source: 'external',
      transportType: 'streamable_http',
      authMode: 'service_hmac',
      serviceHmacProfile: 'comms_management',
      url: COMMS_MANAGEMENT_MCP_URL,
      username: 'alice'
    })).rejects.toThrow('service_hmac requires source platform')
    expect(findOne).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
  })

  test('partial updates validate merged state before database write or network work', async () => {
    const service = createMcpService()
    const update = jest.fn()
    Reflect.set(service, 'mcpDBClient', {
      findOne: jest.fn().mockResolvedValue(serviceHmacServer),
      update
    })

    await expect(service.updateServer('comms-management', {
      url: 'https://comms-management:8080/alternate'
    })).rejects.toThrow(`service_hmac requires url ${COMMS_MANAGEMENT_MCP_URL}`)
    expect(update).not.toHaveBeenCalled()
  })

  test('invalid persisted state is rejected before secret migration or outbound work', async () => {
    const getSecret = jest.fn()
    const service = new MCPService({
      mongoParams: { host: 'localhost:27017', db: 'test', user: 'user', pass: 'pass' },
      secretsService: { getSecret } as never,
      userServerInstalls: {} as never
    })
    const normalizeServerRecord = Reflect.get(service, 'normalizeServerRecord').bind(service)

    await expect(normalizeServerRecord({
      ...serviceHmacServer,
      serviceHmacProfile: undefined
    })).rejects.toThrow('service_hmac requires serviceHmacProfile comms_management')
    expect(getSecret).not.toHaveBeenCalled()
  })
})
