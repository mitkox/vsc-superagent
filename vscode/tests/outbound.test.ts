import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { OutboundMessage } from '../../src/core/index.ts'
import { DeliveryError, type GitHubDeliveryCredential } from '../src/delivery.ts'
import { sendDurableReply } from '../src/outbound.ts'
import { TicketRuntime } from '../src/runtime.ts'
import { sourceTrigger, type GitHubContext } from '../src/sources.ts'

test('reopening durable state after a committed reply and lost response reconciles without another POST', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-outbound-restart-'))
  let runtime = new TicketRuntime(directory), posts = 0, reads = 0, posted: Record<string, unknown> | undefined
  const context: GitHubContext = { provider: 'github', sourceConfigId: 'approved', nativeThreadId: '7', number: 7,
    origin: 'https://api.github.com', repository: 'owner/repo', account: 'agent', isPullRequest: false, kind: 'comment', human: true, bot: false, allowedActor: true, subscribed: true }
  const channel = sourceTrigger({ id: 'approved-request', source: 'github', actor: 'owner', text: 'Request', thread: '7', context }).channel!
  const message: OutboundMessage = { id: 'durable-reply-1', channel, text: 'The fix is ready for review.', kind: 'reply' }
  const credential: GitHubDeliveryCredential = { provider: 'github', origin: context.origin, repository: context.repository, account: 'agent', allowedActors: [], token: 'fixture-only', scopes: ['issues:write'] }
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      posts++; posted = { id: 123, user: { login: 'agent' }, body: JSON.parse(String(init.body)).body }
      return new Response('{}', { status: 503 })
    }
    reads++; return Response.json(posted ? [posted] : [])
  }
  try {
    await assert.rejects(sendDurableReply(runtime, message, credential, { transport }), error => error instanceof DeliveryError && error.outcome === 'unknown')
    assert.equal(runtime.readData<{ attempted: boolean }>('delivery:durable-reply-1')?.attempted, true)
    runtime.dispose(); runtime = new TicketRuntime(directory)
    await sendDurableReply(runtime, message, credential, { transport })
    assert.equal(posts, 1); assert.equal(reads, 1)
    assert.ok(runtime.readData<{ receipt: unknown }>('delivery:durable-reply-1')?.receipt)
    await sendDurableReply(runtime, message, credential, { transport })
    assert.equal(reads, 1)
  } finally { runtime.dispose(); rmSync(directory, { recursive: true, force: true }) }
})


function outboundFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-outbound-race-'))
  let runtime = new TicketRuntime(directory)
  const context: GitHubContext = { provider: 'github', sourceConfigId: 'approved', nativeThreadId: '7', number: 7,
    origin: 'https://api.github.com', repository: 'owner/repo', account: 'agent', isPullRequest: false, kind: 'comment', human: true, bot: false, allowedActor: true, subscribed: true }
  const channel = sourceTrigger({ id: 'approved-request', source: 'github', actor: 'owner', text: 'Request', thread: '7', context }).channel!
  const message: OutboundMessage = { id: 'durable-reply-race', channel, text: 'The approved result.', kind: 'reply' }
  const credential: GitHubDeliveryCredential = { provider: 'github', origin: context.origin, repository: context.repository, account: 'agent', allowedActors: [], token: 'fixture-only', scopes: ['issues:write'] }
  return { message, credential, get runtime() { return runtime },
    reopen() { runtime.dispose(); runtime = new TicketRuntime(directory) },
    close() { runtime.dispose(); rmSync(directory, { recursive: true, force: true }) } }
}

test('an aborted reconciliation never clears prior uncertainty or permits a duplicate POST after reopen', async () => {
  const f = outboundFixture()
  let posts = 0, reads = 0, posted: Record<string, unknown> | undefined
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      posts++; posted = { id: 123, user: { login: 'agent' }, body: JSON.parse(String(init.body)).body }
      throw new Error('response lost after commit')
    }
    reads++; return Response.json(posted ? [posted] : [])
  }
  try {
    await assert.rejects(sendDurableReply(f.runtime, f.message, f.credential, { transport }), error => error instanceof DeliveryError && error.outcome === 'unknown')
    const controller = new AbortController(); controller.abort()
    await assert.rejects(sendDurableReply(f.runtime, f.message, f.credential, { signal: controller.signal, transport }))
    assert.equal(f.runtime.readData<{ attempted: boolean }>('delivery:durable-reply-race')?.attempted, true)
    assert.equal(posts, 1); assert.equal(reads, 0)
    f.reopen()
    await sendDurableReply(f.runtime, f.message, f.credential, { transport, beforeSubmit: () => assert.fail('reconciliation cannot submit') })
    assert.equal(posts, 1); assert.equal(reads, 1)
    assert.ok(f.runtime.readData<{ receipt: unknown }>('delivery:durable-reply-race')?.receipt)
  } finally { f.close() }
})

test('a failed first precondition leaves no attempted marker and can later make its first authorized POST', async () => {
  const f = outboundFixture()
  let checks = 0, posts = 0
  const transport: typeof fetch = async (_url, init) => {
    assert.equal(init?.method, 'POST'); posts++
    assert.equal(f.runtime.readData<{ attempted: boolean }>('delivery:durable-reply-race')?.attempted, true)
    return Response.json({ id: 123 })
  }
  try {
    await assert.rejects(sendDurableReply(f.runtime, f.message, f.credential, { transport, beforeSubmit: () => { checks++; throw new Error('authority revoked') } }),
      error => error instanceof DeliveryError && error.outcome === 'not-sent')
    assert.equal(checks, 1); assert.equal(posts, 0)
    assert.equal(f.runtime.readData('delivery:durable-reply-race'), undefined)
    f.reopen()
    await sendDurableReply(f.runtime, f.message, f.credential, { transport, beforeSubmit: () => { checks++ } })
    assert.equal(checks, 2); assert.equal(posts, 1)
  } finally { f.close() }
})

test('cancelling a submitted POST keeps uncertainty until its receipt is reconciled', async () => {
  const f = outboundFixture(), controller = new AbortController()
  let posts = 0, posted: Record<string, unknown> | undefined
  try {
    await assert.rejects(sendDurableReply(f.runtime, f.message, f.credential, { signal: controller.signal, transport: async (_url, init) => {
      posts++; posted = { id: 123, user: { login: 'agent' }, body: JSON.parse(String(init?.body)).body }
      controller.abort(); throw new DOMException('cancelled after submission', 'AbortError')
    } }), error => error instanceof DeliveryError && error.outcome === 'unknown')
    assert.equal(f.runtime.readData<{ attempted: boolean }>('delivery:durable-reply-race')?.attempted, true)
    f.reopen()
    await sendDurableReply(f.runtime, f.message, f.credential, { transport: async (_url, init) => {
      assert.equal(init?.method, 'GET'); return Response.json([posted])
    } })
    assert.equal(posts, 1)
    assert.ok(f.runtime.readData<{ receipt: unknown }>('delivery:durable-reply-race')?.receipt)
  } finally { f.close() }
})

test('a valid late provider receipt is persisted even after the submitted operation is cancelled', async () => {
  const f = outboundFixture(), controller = new AbortController()
  let posts = 0
  let entered!: () => void, complete!: (response: Response) => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const response = new Promise<Response>(resolve => { complete = resolve })
  try {
    const sending = sendDurableReply(f.runtime, f.message, f.credential, { signal: controller.signal, transport: async (_url, init) => {
      posts++; assert.equal(init?.method, 'POST'); entered(); return response
    } })
    await started; controller.abort(); complete(Response.json({ id: 123 }))
    await sending
    assert.equal(posts, 1)
    assert.ok(f.runtime.readData<{ receipt: unknown }>('delivery:durable-reply-race')?.receipt)
    f.reopen()
    await sendDurableReply(f.runtime, f.message, f.credential, { signal: controller.signal, transport: async () => assert.fail('receipt already recorded') })
  } finally { f.close() }
})

test('definitive client rejection remains retryable as a new POST', async () => {
  const f = outboundFixture()
  let posts = 0
  const transport: typeof fetch = async () => ++posts === 1 ? new Response('{}', { status: 403 }) : Response.json({ id: 123 })
  try {
    await assert.rejects(sendDurableReply(f.runtime, f.message, f.credential, { transport }), error => error instanceof DeliveryError && error.outcome === 'not-sent')
    assert.equal(f.runtime.readData<{ attempted: boolean }>('delivery:durable-reply-race')?.attempted, false)
    f.reopen(); await sendDurableReply(f.runtime, f.message, f.credential, { transport })
    assert.equal(posts, 2)
  } finally { f.close() }
})


test('an already cancelled first send or precondition cancellation never records an attempted POST', async () => {
  for (const cancelBeforeCall of [true, false]) {
    const f = outboundFixture(), controller = new AbortController()
    let checks = 0
    if (cancelBeforeCall) controller.abort()
    try {
      await assert.rejects(sendDurableReply(f.runtime, f.message, f.credential, {
        signal: controller.signal, beforeSubmit: () => { checks++; controller.abort() },
        transport: async () => assert.fail('cancelled first attempt must not submit'),
      }), error => error instanceof DeliveryError && error.outcome === 'not-sent')
      assert.equal(checks, cancelBeforeCall ? 0 : 1)
      assert.equal(f.runtime.readData('delivery:durable-reply-race'), undefined)
    } finally { f.close() }
  }
})
