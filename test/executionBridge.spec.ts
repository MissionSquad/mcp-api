import { expect, test } from '@jest/globals'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { verifyInvocation, type Invocation } from '../src/controllers/execution'

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
