import { env } from '../env'

export interface StringMap {
  [key: string]: string
}

export function log({ level, msg, error }: { level: string; msg: string; error?: any }) {
  if (!env.DEBUG && level === 'debug') return
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}`)
  if (error != null) {
    console.error(error)
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
        // throw error
        console.error(error)
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