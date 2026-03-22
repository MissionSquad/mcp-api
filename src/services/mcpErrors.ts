export type McpErrorCode =
  | 'invalid_request'
  | 'server_not_found'
  | 'server_disabled'
  | 'auth_not_connected'
  | 'reauth_required'
  | 'server_already_exists'
  | 'discovery_failed'

export type McpErrorResponseBody = {
  success: false
  error: string
  code?: McpErrorCode | string
  reauthRequired?: boolean
  serverName?: string
  username?: string
  authorizationUrl?: string
  server?: unknown
  attemptedUrls?: string[]
  cause?: string
}

export class McpApiError extends Error {
  public readonly code: McpErrorCode | string
  public readonly statusCode: number
  public readonly details?: Omit<McpErrorResponseBody, 'success' | 'error' | 'code'>

  constructor({
    message,
    code,
    statusCode,
    details
  }: {
    message: string
    code: McpErrorCode | string
    statusCode: number
    details?: Omit<McpErrorResponseBody, 'success' | 'error' | 'code'>
  }) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

export class McpValidationError extends McpApiError {
  constructor(message: string) {
    super({ message, code: 'invalid_request', statusCode: 400 })
  }
}

export class McpServerNotFoundError extends McpApiError {
  constructor(serverName: string) {
    super({
      message: `Server ${serverName} not found`,
      code: 'server_not_found',
      statusCode: 404,
      details: { serverName }
    })
  }
}

export class McpServerDisabledError extends McpApiError {
  constructor(serverName: string) {
    super({
      message: `Server ${serverName} is disabled`,
      code: 'server_disabled',
      statusCode: 409,
      details: { serverName }
    })
  }
}

export class McpAuthNotConnectedError extends McpApiError {
  constructor(serverName: string, username: string) {
    super({
      message: `OAuth is not connected for user ${username} on server ${serverName}`,
      code: 'auth_not_connected',
      statusCode: 409,
      details: { serverName, username }
    })
  }
}

export class McpReauthRequiredError extends McpApiError {
  constructor({
    serverName,
    username,
    authorizationUrl,
    message
  }: {
    serverName: string
    username: string
    authorizationUrl?: string
    message?: string
  }) {
    super({
      message:
        message ??
        `OAuth re-authorization required for user ${username} on external MCP server ${serverName}.`,
      code: 'reauth_required',
      statusCode: 401,
      details: {
        reauthRequired: true,
        serverName,
        username,
        authorizationUrl
      }
    })
  }
}

export class McpServerAlreadyExistsError extends McpApiError {
  constructor(serverName: string, server: unknown) {
    super({
      message: `Server ${serverName} already exists`,
      code: 'server_already_exists',
      statusCode: 409,
      details: {
        serverName,
        server
      }
    })
  }
}

export class McpDiscoveryFailedError extends McpApiError {
  constructor(message: string, attemptedUrls: string[], cause?: string) {
    super({
      message,
      code: 'discovery_failed',
      statusCode: 400,
      details: {
        attemptedUrls,
        ...(cause ? { cause } : {})
      }
    })
  }
}

export const isMcpApiError = (error: unknown): error is McpApiError => error instanceof McpApiError

export const toMcpErrorResponse = (
  error: unknown
): {
  statusCode: number
  body: McpErrorResponseBody
} => {
  if (isMcpApiError(error)) {
    return {
      statusCode: error.statusCode,
      body: {
        success: false,
        error: error.message,
        code: error.code,
        ...(error.details ?? {})
      }
    }
  }

  return {
    statusCode: 500,
    body: {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown MCP error'
    }
  }
}
