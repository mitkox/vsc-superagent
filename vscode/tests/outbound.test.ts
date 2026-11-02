import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { OutboundMessage } from '../../src/core/index.ts'
import { DeliveryError, type GitHubDeliveryCredential, type SourceDeliveryCredential } from '../src/delivery.ts'
import { sendDurableReply } from '../src/outbound.ts'
import { TicketRuntime } from '../src/runtime.ts'
import { sourceTrigger, type GitHubContext, type TeamsContext } from '../src/sources.ts'

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


function outboundFixture(provider: 'github' | 'teams' = 'github') {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-outbound-race-'))
  let runtime = new TicketRuntime(directory)
  const context: GitHubContext | TeamsContext = provider === 'github'
    ? { provider: 'github', sourceConfigId: 'approved', nativeThreadId: '7', number: 7,
      origin: 'https://api.github.com', repository: 'owner/repo', account: 'agent', isPullRequest: false, kind: 'comment', human: true, bot: false, allowedActor: true, subscribed: true }
    : { provider: 'teams', sourceConfigId: 'approved', nativeThreadId: '100', rootMessageId: '100', messageId: '102',
      tenantId: '11111111-1111-1111-1111-111111111111', chatId: '19:chat@thread.v2', human: true, bot: false, allowedActor: true, subscribed: true }
  const channel = sourceTrigger({ id: 'approved-request', source: provider, actor: provider === 'github' ? 'owner' : '33333333-3333-3333-3333-333333333333', text: 'Request', thread: context.nativeThreadId, context }).channel!
  const message: OutboundMessage = { id: 'durable-reply-race', channel, text: 'The approved result.', kind: 'reply' }
  const credential: SourceDeliveryCredential = context.provider === 'github'
    ? { provider: 'github', origin: context.origin, repository: context.repository, account: 'agent', allowedActors: [], token: 'fixture-only', scopes: ['issues:write'] }
    : { provider: 'teams', tenantId: context.tenantId, accountId: '22222222-2222-2222-2222-222222222222', chatIds: [context.chatId!], channels: [],
      allowedActors: [], token: 'fixture-only', mode: 'delegated', scopes: ['ChatMessage.Send'] }
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


function wireReply(provider: 'github' | 'teams', init: RequestInit | undefined) {
  const body = JSON.parse(String(init?.body))
  const raw: string = provider === 'github' ? body.body : body.replyMessage.body.content
  const suffix = (provider === 'github' ? /\n\n<!-- (superagent:[a-f0-9]{64}) -->$/ : /\n\n\[(superagent:[a-f0-9]{64})\]$/).exec(raw)
  assert.ok(suffix)
  return { raw, text: raw.slice(0, suffix.index), marker: suffix[1]! }
}
function fullReport(offset = 0) {
  const head = `HEAD:${'X'.repeat(offset)}😀 BEGIN\n`, tail = '\nTAIL:🚀 END'
  const middle = 50_000 - head.length - tail.length
  return { head, tail, text: head + '😃'.repeat(Math.floor(middle / 2)) + (middle % 2 ? 'X' : '') + tail }
}
function wellFormed(text: string) {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index)
      assert.ok(next >= 0xdc00 && next <= 0xdfff, 'wire output cannot split a surrogate pair')
    } else assert.ok(unit < 0xdc00 || unit > 0xdfff, 'wire output cannot contain an unmatched low surrogate')
  }
}

test('durable source replies keep short and exactly 30000-unit text byte-identical on both providers', async () => {
  for (const provider of ['github', 'teams'] as const) for (const text of ['Short ✅ result.', '😀'.repeat(15_000)]) {
    const f = outboundFixture(provider), message = Object.freeze({ ...f.message, text }), original = structuredClone(message)
    try {
      let posts = 0
      await sendDurableReply(f.runtime, message, f.credential, { transport: async (_url, init) => {
        posts++; assert.equal(init?.method, 'POST')
        assert.equal(wireReply(provider, init).text, text)
        return Response.json({ id: provider === 'github' ? 123 : '123' })
      } })
      assert.equal(posts, 1); assert.deepEqual(message, original)
    } finally { f.close() }
  }
})

test('durable source delivery projects a full 50000-unit Unicode report with its head tail and supervision notice', async () => {
  for (const provider of ['github', 'teams'] as const) for (const offset of [0, 1]) {
    const f = outboundFixture(provider), report = fullReport(offset)
    const message = Object.freeze({ ...f.message, text: report.text }), original = structuredClone(message)
    assert.equal(message.text.length, 50_000)
    try {
      let posts = 0, marker = ''
      await sendDurableReply(f.runtime, message, f.credential, { transport: async (_url, init) => {
        posts++; assert.equal(init?.method, 'POST')
        const wire = wireReply(provider, init); marker = wire.marker
        assert.ok(wire.text.length <= 30_000)
        assert.ok(wire.text.startsWith(report.head)); assert.ok(wire.text.endsWith(report.tail))
        assert.match(wire.text, /Message shortened for source delivery/)
        assert.match(wire.text, /Full text is available in Superagent supervision/)
        assert.doesNotMatch(wire.text, /https?:\/\/|file:|\/(?:home|tmp|Users)\//)
        wellFormed(wire.text)
        return Response.json({ id: provider === 'github' ? 123 : '123' })
      } })
      assert.equal(posts, 1); assert.deepEqual(message, original)
      const state = f.runtime.readData<{ receipt: { operationId: string; marker: string } }>(`delivery:${message.id}`)
      assert.equal(state?.receipt.operationId, original.id); assert.equal(state?.receipt.marker, marker)
    } finally { f.close() }
  }
})

test('oversized durable replies preserve uncertainty across aborted absent and successful receipt reads after reopen', async () => {
  for (const provider of ['github', 'teams'] as const) {
    const f = outboundFixture(provider), message = Object.freeze({ ...f.message, text: fullReport().text }), original = structuredClone(message)
    let posts = 0, reads = 0, stored: Record<string, unknown> | undefined
    try {
      await assert.rejects(sendDurableReply(f.runtime, message, f.credential, { transport: async (_url, init) => {
        posts++; assert.equal(init?.method, 'POST')
        const wire = wireReply(provider, init); assert.ok(wire.text.length <= 30_000)
        stored = provider === 'github' ? { id: 123, body: wire.raw, user: { login: 'agent' } }
          : { id: '123', body: { content: wire.raw }, from: { user: { id: '22222222-2222-2222-2222-222222222222', tenantId: '11111111-1111-1111-1111-111111111111' } } }
        throw new Error('response lost after provider commit')
      } }), error => error instanceof DeliveryError && error.outcome === 'unknown')
      assert.equal(posts, 1); assert.equal(f.runtime.readData<{ attempted: boolean }>(`delivery:${message.id}`)?.attempted, true)
      f.reopen()
      const abort = new AbortController()
      await assert.rejects(sendDurableReply(f.runtime, message, f.credential, { signal: abort.signal,
        beforeSubmit: () => assert.fail('uncertain send must never POST again'), transport: async (_url, init) => {
          reads++; assert.equal(init?.method, 'GET')
          return new Response(new ReadableStream<Uint8Array>({ start() { setTimeout(() => abort.abort(), 10) } }))
        } }), /Source request cancelled/)
      assert.equal(f.runtime.readData<{ attempted: boolean }>(`delivery:${message.id}`)?.attempted, true)
      await assert.rejects(sendDurableReply(f.runtime, message, f.credential, {
        beforeSubmit: () => assert.fail('absent receipt cannot authorize another POST'), transport: async (_url, init) => {
          reads++; assert.equal(init?.method, 'GET'); return Response.json(provider === 'github' ? [] : { value: [] })
        } }), error => error instanceof DeliveryError && error.outcome === 'unknown')
      assert.equal(f.runtime.readData<{ attempted: boolean }>(`delivery:${message.id}`)?.attempted, true)
      f.reopen()
      await sendDurableReply(f.runtime, message, f.credential, { beforeSubmit: () => assert.fail('reconciliation is read-only'), transport: async (_url, init) => {
        reads++; assert.equal(init?.method, 'GET'); return Response.json(provider === 'github' ? [stored] : { value: [stored] })
      } })
      assert.equal(posts, 1); assert.equal(reads, 3)
      assert.ok(f.runtime.readData<{ receipt: unknown }>(`delivery:${message.id}`)?.receipt)
      f.reopen()
      await sendDurableReply(f.runtime, message, f.credential, { signal: abort.signal,
        beforeSubmit: () => assert.fail('recorded receipt needs no submission'), transport: async () => assert.fail('recorded receipt needs no provider I/O') })
      assert.deepEqual(message, original)
    } finally { f.close() }
  }
})

test('oversized whitespace cannot become a deliverable notice or an attempted POST', async () => {
  for (const provider of ['github', 'teams'] as const) {
    const f = outboundFixture(provider), message = Object.freeze({ ...f.message, text: ' '.repeat(50_000) })
    try {
      await assert.rejects(sendDurableReply(f.runtime, message, f.credential, {
        transport: async () => assert.fail('empty content must not dispatch'),
      }), error => error instanceof DeliveryError && error.outcome === 'not-sent')
      assert.equal(f.runtime.readData(`delivery:${message.id}`), undefined)
      assert.equal(message.text, ' '.repeat(50_000))
    } finally { f.close() }
  }
})
