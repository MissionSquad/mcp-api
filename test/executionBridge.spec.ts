import { expect, test } from '@jest/globals'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import express from 'express'
import { ExecutionBridge, verifyInvocation, type Invocation } from '../src/controllers/execution'

test('signed execution authority binds the token, actor, owner, run, workspace, arguments and freshness', () => {
  const key = Buffer.alloc(32, 9),
    timestamp = 1893456000000,
    bearer = 'ee1.' + Buffer.alloc(32, 7).toString('base64url'),
    resource = 'https://ee.example/mcp'
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const body: Invocation = {
    v: 1,
    timestamp,
    nonce: randomUUID(),
    resource,
    actorId: 'agent:abc',
    ownerId: 'user-id',
    workspaceId: 'workspace-a',
    runId: 'run-one',
    action: 'call',
    name: 'ee_exec',
    args: { command: 'echo hello' }
  }
  const signature = createHmac('sha256', key)
    .update(
      JSON.stringify([
        'msq-execution-invocation-v1',
        timestamp,
        body.nonce,
        resource,
        body.ownerId,
        body.actorId,
        body.runId,
        body.workspaceId,
        hash(bearer),
        body.action,
        body.name,
        hash(JSON.stringify(body.args))
      ])
    )
    .digest('hex')
  expect(verifyInvocation(body, bearer, signature, key, resource, timestamp)).toBe(true)
  for (const changed of [
    { actorId: 'other' },
    { ownerId: 'b' },
    { workspaceId: 'b' },
    { runId: 'b' },
    { nonce: randomUUID() },
    { args: { command: 'other' } },
    { name: 'ee_job' }
  ]) {
    expect(verifyInvocation({ ...body, ...changed }, bearer, signature, key, resource, timestamp)).toBe(false)
  }
  expect(verifyInvocation(body, bearer, signature, key, resource, timestamp + 31000)).toBe(false)
  expect(verifyInvocation(body, bearer, signature, key, 'https://elsewhere.example/mcp', timestamp)).toBe(false)
  expect(
    verifyInvocation(body, 'ee1.' + Buffer.alloc(32, 4).toString('base64url'), signature, key, resource, timestamp)
  ).toBe(false)
})


test('execution transport permits literal RFC1918 HTTP only in explicit test mode', () => {
  const mongo = { host: 'mongodb://127.0.0.1:27017', db: 'unused', user: 'unused', pass: 'unused' }
  const key = Buffer.alloc(32, 9).toString('base64')
  const bridge = (resource: string, options?: { testMode?: boolean }) => new ExecutionBridge(express(), mongo, resource, key, options)
  for (const ip of ['10.0.0.1', '10.1.252.22', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.168.255.254']) {
    const url = `http://${ip}:8080/mcp`
    expect(() => bridge(url)).toThrow('Invalid execution bridge configuration')
    expect(() => bridge(url, { testMode: false })).toThrow('Invalid execution bridge configuration')
    expect(() => bridge(url, { testMode: true })).not.toThrow()
  }
  for (const host of ['172.15.255.255', '172.32.0.0', '192.169.0.1', '169.254.169.254', '100.64.0.1', '8.8.8.8', '0.0.0.0', 'internal.example', '[fc00::1]', '0x0a01fc16', '167902230', '012.1.252.22', '10.1.252.022', '10.1.65558'])
    expect(() => bridge(`http://${host}:8080/mcp`, { testMode: true })).toThrow()
  for (const url of ['http://user:pass@10.1.252.22:8080/mcp', 'http://10.1.252.22:8080/mcp?token=bad', 'http://10.1.252.22:8080/mcp#bad', 'ftp://10.1.252.22/mcp'])
    expect(() => bridge(url, { testMode: true })).toThrow()
  for (const url of ['https://execution.example/mcp', 'http://localhost:8080/mcp', 'http://127.0.0.1:8080/mcp', 'http://[::1]:8080/mcp'])
    expect(() => bridge(url)).not.toThrow()
})
