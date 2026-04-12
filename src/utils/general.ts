import { env } from '../env'

export interface StringMap {
  [key: string]: string
}

function summarizeUrlForErrorLog(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  try {
    const parsed = new URL(value)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return value
  }
}

export function summarizeErrorForLog(error: any): string {
  if (error == null) {
    return 'unknown error'
  }
  if (typeof error === 'string') {
    return error
  }
  if (error instanceof Error) {
    const axiosLike = error as Error & {
      code?: string
      status?: number
      config?: { method?: string; url?: string }
      response?: { status?: number; statusText?: string }
    }
    const method = axiosLike.config?.method?.toUpperCase()
    const url = summarizeUrlForErrorLog(axiosLike.config?.url)
    const status = axiosLike.response?.status ?? axiosLike.status
    const statusText = axiosLike.response?.statusText
    const code = axiosLike.code
    return JSON.stringify({
      name: axiosLike.name,
      message: axiosLike.message,
      code,
      status,
      statusText,
      method,
      url
    })
  }
  if (typeof error === 'object') {
    const objectError = error as {
      message?: string
      code?: string
      status?: number
      method?: string
      url?: string
      response?: { status?: number; statusText?: string }
      config?: { method?: string; url?: string }
    }
    return JSON.stringify({
      message: objectError.message,
      code: objectError.code,
      status: objectError.response?.status ?? objectError.status,
      statusText: objectError.response?.statusText,
      method: objectError.config?.method?.toUpperCase() ?? objectError.method,
      url: summarizeUrlForErrorLog(objectError.config?.url ?? objectError.url)
    })
  }
  return String(error)
}

export function log({ level, msg, error }: { level: string; msg: string; error?: any }) {
  if (!env.DEBUG && level === 'debug') return
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`)
  if (error != null) {
    console.error(summarizeErrorForLog(error))
  }
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export function sanitizeString(input: string) {
  input = input.replace('./node_modules/', '')
  return input.replace(/[^a-zA-Z0-9_\-\.]/g, '-')
}

export function stringToBase64(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64')
}

export function base64ToString(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8')
}

export function objectToBase64(input: object): string {
  const jsonString = JSON.stringify(input)
  return stringToBase64(jsonString)
}

export function base64ToObject<T>(base64: string): T {
  const jsonString = base64ToString(base64)
  return JSON.parse(jsonString) as T
}

/**
 * Compare two semantic version strings
 * @param version1 First version string (e.g., "1.2.3")
 * @param version2 Second version string (e.g., "1.3.0")
 * @returns -1 if version1 < version2, 0 if version1 == version2, 1 if version1 > version2
 */
export function compareVersions(version1: string, version2: string): number {
  const v1Parts = version1.split('.').map(Number)
  const v2Parts = version2.split('.').map(Number)
  
  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const v1Part = v1Parts[i] || 0
    const v2Part = v2Parts[i] || 0
    
    if (v1Part > v2Part) return 1
    if (v1Part < v2Part) return -1
  }
  
  return 0
}

export function retryWithExponentialBackoff(
  fn: (...args: any) => Promise<any>,
  onRetry: () => any = () => null,
  maxAttempts = 5,
  baseDelayMs = 500
) {
  let attempt = 1

  const execute = async (): Promise<any> => {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= maxAttempts) {
        console.error(summarizeErrorForLog(error))
        return { error }
      }

      const delayMs = baseDelayMs * 2 ** attempt
      log({ level: 'warn', msg: `Retry attempt ${attempt} after ${delayMs}ms`, error })
      try {
        onRetry()
      } catch (error) {
        log({ level: 'error', msg: `could not execute onRetry`, error })
      }
      await sleep(delayMs)

      attempt++
      return execute()
    }
  }

  return execute()
}
