import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { OutboundMessage, Trigger } from '../../src/core/index.ts'
import type { AgentBackend, AgentRun } from '../src/agent-backend.ts'
import { deliverSourceReply, type SourceDeliveryCredential } from '../src/delivery.ts'
import { AutomationService } from '../src/orchestration.ts'
import { sendDurableReply } from '../src/outbound.ts'
import { TicketRuntime } from '../src/runtime.ts'
import { sourceTrigger, type SourceContext } from '../src/sources.ts'

type Family = 'github' | 'teams'
const tenant = '11111111-1111-1111-1111-111111111111'
const account = '22222222-2222-2222-2222-222222222222'
const teamsActor = '33333333-3333-3333-3333-333333333333'
const chat = '19:approved@thread.v2'
const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(check: () => boolean, label = 'Report delivery integration did not settle') {
  const until = Date.now() + 4000
  while (!check()) { if (Date.now() > until) assert.fail(label); await delay() }
}
const invoke = (request: AgentRun, args: unknown) => request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke(args)
function request(family: Family): Trigger {
  const common = { sourceConfigId: 'approved-source', human: true, bot: false, allowedActor: true, subscribed: true, addressed: 'mention' as const }
  const context: SourceContext = family === 'github'
    ? { ...common, provider: 'github', origin: 'https://api.github.com', repository: 'company/project', account: 'agent', nativeThreadId: '42', number: 42, isPullRequest: false, kind: 'comment', commentId: 100 }
    : { ...common, provider: 'teams', tenantId: tenant, chatId: chat, nativeThreadId: '100', rootMessageId: '100', messageId: '101' }
  return sourceTrigger({ id: `${family}:size-request`, source: family, actor: family === 'github' ? 'requester' : teamsActor,
    text: 'Repair the authorized defect and report the result', thread: context.nativeThreadId, context,
    url: family === 'github' ? 'https://github.com/company/project/issues/42#issuecomment-100' : `https://teams.microsoft.com/l/message/${encodeURIComponent(chat)}/101` })
}
function credential(family: Family): SourceDeliveryCredential {
  return family === 'github'
    ? { provider: 'github', origin: 'https://api.github.com', repository: 'company/project', account: 'agent', allowedActors: ['requester'], token: 'github-test', scopes: ['issues:write', 'pull_requests:write'] }
    : { provider: 'teams', tenantId: tenant, accountId: account, chatIds: [chat], channels: [], allowedActors: [teamsActor], token: 'teams-test', mode: 'delegated', scopes: ['ChatMessage.Send'] }
}
interface Post { url: string; text: string; marker: string; body: string }
interface Options { directory?: string; delivery?: boolean; legacySender?: boolean; run?: (request: AgentRun) => Promise<void> }
function fixture(family: Family, options: Options = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'superagent-report-delivery-size-'))
  const runtime = new TicketRuntime(directory), posts: Post[] = [], runs: AgentRun[] = []
  let enabled = options.delivery ?? true, service!: AutomationService
  const transport: typeof fetch = async (input, init) => {
    assert.equal(init?.method, 'POST', 'Fresh size-projected replies must use one actual provider POST')
    const url = String(input), payload = JSON.parse(String(init.body))
    const expected = family === 'github' ? 'https://api.github.com/repos/company/project/issues/42/comments'
      : `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chat)}/messages/replyWithQuote`
    assert.equal(url, expected)
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${family}-test`)
    const body: string = family === 'github' ? payload.body : payload.replyMessage.body.content
    if (family === 'teams') { assert.deepEqual(payload.messageIds, ['100']); assert.equal(payload.replyMessage.body.contentType, 'text') }
    const receipt = family === 'github' ? /\n\n<!-- (superagent:[a-f0-9]{64}) -->$/.exec(body) : /\n\n\[(superagent:[a-f0-9]{64})\]$/.exec(body)
    assert.ok(receipt, 'The provider payload retains the deterministic operation marker')
    posts.push({ url, body, text: body.slice(0, receipt.index), marker: receipt[1]! })
    return Response.json({ id: family === 'github' ? 400 + posts.length : String(400 + posts.length) })
  }
  const backend: AgentBackend = {
    assess: async () => ({ kind: 'ignore', reason: 'No new task' }),
    run: async turn => { runs.push(turn); await delay(); if (options.run) await options.run(turn); else await invoke(turn, { state: 'waiting', summary: 'Waiting for the report' }) },
    abort: async () => {}, dispose: async () => {},
  }
  service = new AutomationService(runtime, { backend, prepare: async () => directory, poll: async () => [], canSend: () => enabled,
    send: async (message, signal) => {
      service.assertOutboundAllowed(message, signal)
      const delivery = { signal, transport, beforeSubmit: () => service.assertOutboundAllowed(message, signal) }
      if (options.legacySender) await deliverSourceReply(message.channel, message, credential(family), delivery)
      else await sendDurableReply(runtime, message, credential(family), delivery)
    } })
  if (service.settings.revision === 0) service.saveSettings({ enabled: true, acceptMode: 'off', pollIntervalMs: 3_600_000,
    execution: { retryLimit: 0, retryBaseMs: 10 }, sources: { github: { enabled: true, allowedActors: ['requester'], allowUnaddressed: true },
      teams: { enabled: true, allowedActors: [teamsActor], allowUnaddressed: true } } }, 0)
  const effects = () => service.snapshot().effects.filter(effect => effect.kind === 'outbound')
  const idle = () => service.snapshot().health.workers === 0 && !service.snapshot().effects.some(effect => ['start', 'deliver', 'outbound'].includes(effect.kind) && ['pending', 'running'].includes(effect.status))
  const accept = () => {
    const trigger = request(family); runtime.engine.receive(trigger)
    const decision = runtime.engine.decide(trigger.id, { kind: 'accept', title: 'Approved report size regression', scope: 'Repair the requested defect', reason: 'Explicit authorized request' })
    service.start(); return { trigger, ticketId: decision.ticketId! }
  }
  return { directory, runtime, service, posts, runs, effects, idle, accept, transport,
    setDelivery(value: boolean) { enabled = value; runtime.writeData('size-fixture-delivery', value) },
    async close(preserve = false) { await service.dispose(); runtime.dispose(); if (!preserve) rmSync(directory, { recursive: true, force: true }) },
  }
}
function longSummary(length: number, unicode = false): string {
  const first = 'REPORT START:', last = ':REPORT END', remaining = length - first.length - last.length
  return first + (unicode ? '🧪'.repeat(Math.floor(remaining / 2)) + (remaining % 2 ? 'x' : '') : 'x'.repeat(remaining)) + last
}
function assertWellFormed(text: string) {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) { const next = text.charCodeAt(++index); assert.ok(next >= 0xdc00 && next <= 0xdfff, 'Wire projection must preserve a complete surrogate pair') }
    else assert.ok(code < 0xdc00 || code > 0xdfff, 'Wire projection must not leave an isolated low surrogate')
  }
}
function assertProjection(post: Post, original: string) {
  assert.ok(post.text.length <= 30_000, `Provider text exceeds the delivery contract: ${post.text.length}`)
  assert.ok(post.text.startsWith('REPORT START:')); assert.ok(post.text.endsWith(':REPORT END'))
  assert.match(post.text, /omitt|truncat|excerpt|shorten/i)
  assert.match(post.text, /Supervision/i)
  assertWellFormed(post.text)
  assert.notEqual(post.text, original)
}

for (const family of ['github', 'teams'] as const) {
  test(`${family} accepted 30001 and 50000 character reports complete through real durable provider delivery`, async () => {
    for (const size of [30_001, 50_000]) {
      const summary = longSummary(size, size === 50_000)
      const f = fixture(family, { run: async turn => { await invoke(turn, { state: 'ready', summary }) } })
      try {
        const { ticketId } = f.accept(); await eventually(() => f.runs.length === 1 && f.idle())
        assert.equal(f.posts.length, 1, `Accepted ${size}-character report must reach the provider, rather than fail the outbox guard`)
        assertProjection(f.posts[0]!, summary)
        const ticket = f.runtime.get(ticketId), effect = f.effects()[0]!
        assert.equal(ticket.ended?.outcome, 'completed'); assert.equal(ticket.assignments.at(-1)!.report!.summary, summary)
        assert.equal(effect.status, 'completed'); assert.equal(effect.message!.text, summary)
        const journal = f.runtime.readData<{ attempted: boolean; receipt: { operationId: string; marker: string } }>(`delivery:${effect.message!.id}`)!
        assert.equal(journal.attempted, true); assert.equal(journal.receipt.operationId, effect.message!.id); assert.equal(journal.receipt.marker, f.posts[0]!.marker)
        await sendDurableReply(f.runtime, effect.message!, credential(family), { transport: f.transport })
        f.service.kick(); await delay(15); assert.equal(f.posts.length, 1, 'A completed oversized result must not be posted again')
      } finally { await f.close() }
    }
  })

  test(`${family} an exact 30000 character report reaches the provider unchanged`, async () => {
    const summary = longSummary(30_000), f = fixture(family, { run: async turn => { await invoke(turn, { state: 'ready', summary }) } })
    try {
      f.accept(); await eventually(() => f.runs.length === 1 && f.idle())
      assert.equal(f.posts.length, 1); assert.equal(f.posts[0]!.text, summary); assert.equal(f.effects()[0]!.status, 'completed')
    } finally { await f.close() }
  })

  test(`${family} a long explicit answer and same-conversation result remain one required reply`, async () => {
    const summary = longSummary(50_000, true), origin = request(family)
    const f = fixture(family, { run: async turn => { await invoke(turn, { state: 'ready', summary, reply_to_trigger_id: origin.id }) } })
    try {
      const { ticketId } = f.accept(); await eventually(() => f.runs.length === 1 && f.idle())
      assert.equal(f.posts.length, 1, 'Projection must preserve answer/result coordination')
      assertProjection(f.posts[0]!, summary); assert.equal(f.effects().length, 1); assert.equal(f.effects()[0]!.status, 'completed')
      assert.equal(f.effects()[0]!.message!.text, summary); assert.equal(f.effects()[0]!.message!.triggerId, origin.id)
      assert.equal(f.runtime.get(ticketId).ended?.outcome, 'completed')
      f.service.kick(); await delay(15); assert.equal(f.posts.length, 1)
    } finally { await f.close() }
  })
}

test('a merged result crossing the delivery boundary preserves its final merge fact and full local report', async () => {
  const summary = longSummary(30_000), ref = { source: 'github:verified-owned-pr', id: '7' }
  const f = fixture('teams', { run: async turn => { f.runtime.engine.bindThread(turn.ticketId, ref, true); await invoke(turn, { state: 'ready', summary }) } })
  try {
    const { ticketId } = f.accept(); await eventually(() => f.runs.length === 1 && f.idle())
    assert.equal(f.posts.length, 1); assert.equal(f.posts[0]!.text, summary); assert.equal(f.runtime.get(ticketId).ended, undefined)
    f.runtime.engine.threadClosed(ref, 'merged', new Date().toISOString())
    await eventually(() => f.effects().length === 2 && f.idle())
    assert.equal(f.posts.length, 2, 'The final merged result must not become an oversized failed effect')
    const merged = f.posts[1]!.text
    assert.ok(merged.length <= 30_000); assert.match(merged, /Supervision/i); assert.match(merged, /omitt|truncat|excerpt|shorten/i)
    assert.ok(merged.startsWith('REPORT START:')); assert.ok(merged.endsWith(':REPORT END\nPull request merged.'))
    assert.equal(f.runtime.get(ticketId).ended?.outcome, 'merged'); assert.equal(f.runtime.get(ticketId).assignments.at(-1)!.report!.summary, summary)
    assert.equal(f.effects()[1]!.message!.text, summary + '\nPull request merged.'); assert.equal(f.effects()[1]!.status, 'completed')
  } finally { await f.close() }
})

test('long local progress, blocked and ready reports retain their complete summaries without external delivery', async () => {
  const summary = longSummary(50_000, true)
  const f = fixture('github', { run: async turn => {
    for (const state of ['progress', 'blocked', 'ready']) {
      await invoke(turn, { state, summary })
      assert.equal(f.runtime.get(turn.ticketId).assignments.at(-1)!.report!.summary, summary)
    }
  } })
  try {
    const ticket = f.runtime.create('Locally approved report-only work'); f.service.start()
    await eventually(() => f.runs.length === 1 && f.idle())
    assert.equal(f.runtime.get(ticket.id).ended?.outcome, 'completed'); assert.equal(f.posts.length, 0); assert.equal(f.effects().length, 0)
  } finally { await f.close() }
})

test('a native followup without a channel records its long answer and sends only the original provider result', async () => {
  const summary = longSummary(50_000)
  const f = fixture('github', { run: async turn => {
    if (f.runs.length === 1) await invoke(turn, { state: 'waiting', summary: 'Awaiting the native followup' })
    else {
      const local = f.runtime.context(turn.ticketId).messages.find(message => message.source === 'vscode')!
      await invoke(turn, { state: 'ready', summary, reply_to_trigger_id: local.id })
    }
  } })
  try {
    const { ticketId } = f.accept(); await eventually(() => f.runs.length === 1 && f.idle())
    f.runtime.followup(ticketId, 'Finish the locally approved source repair')
    await eventually(() => f.runs.length === 2 && f.idle())
    assert.equal(f.posts.length, 1); assertProjection(f.posts[0]!, summary)
    assert.equal(f.effects().length, 1); assert.equal(f.effects()[0]!.status, 'completed')
    const local = f.runtime.context(ticketId).messages.find(message => message.source === 'vscode')!
    assert.ok(f.runtime.get(ticketId).answers!.includes(local.id)); assert.equal(local.channel, undefined)
  } finally { await f.close() }
})

test('delivery disabled then enabled sends the same oversized completed result exactly once', async () => {
  const summary = longSummary(50_000), f = fixture('teams', { delivery: false, run: async turn => { await invoke(turn, { state: 'ready', summary }) } })
  try {
    const { ticketId } = f.accept()
    await eventually(() => f.runs.length === 1 && f.service.snapshot().health.workers === 0 && !!f.effects()[0]?.waitingForPermission)
    const original = f.effects()[0]!
    assert.equal(f.runtime.get(ticketId).ended?.outcome, 'completed'); assert.equal(f.posts.length, 0); assert.equal(original.status, 'pending')
    f.setDelivery(true); f.runtime.repositories.mutateAutomation(data => { data.effects.find(effect => effect.id === original.id)!.nextAttemptAt = 0 })
    await eventually(() => f.idle())
    assert.equal(f.posts.length, 1); assertProjection(f.posts[0]!, summary)
    assert.equal(f.effects()[0]!.status, 'completed'); assert.equal(f.effects()[0]!.message!.id, original.message!.id)
  } finally { await f.close() }
})

test('an oversized failed legacy outbox effect recovers after durable reopen and explicit retry without changing its ID', async () => {
  const summary = longSummary(50_000), original = fixture('github', { legacySender: true, run: async turn => { await invoke(turn, { state: 'ready', summary }) } })
  let current: ReturnType<typeof fixture> | undefined = original
  const directory = original.directory
  try {
    const { ticketId } = original.accept(); await eventually(() => original.runs.length === 1 && original.idle())
    const failed = structuredClone(original.effects()[0]!), sessionId = original.service.snapshot().sessions[0]!.sessionId
    assert.equal(failed.status, 'failed'); assert.match(failed.error!, /Invalid source delivery/); assert.equal(original.posts.length, 0)
    assert.equal(original.runtime.readData(`delivery:${failed.message!.id}`), undefined)
    await original.close(true); current = undefined
    current = fixture('github', { directory }); const reopened = current
    assert.equal(reopened.effects()[0]!.id, failed.id); assert.equal(reopened.effects()[0]!.message!.id, failed.message!.id)
    assert.equal(reopened.runtime.get(ticketId).assignments.at(-1)!.report!.summary, summary)
    reopened.service.retryEffect(failed.id); reopened.service.start()
    await eventually(() => reopened.idle())
    assert.equal(reopened.posts.length, 1, 'An old pre-submit size failure must recover through the bounded wire projection')
    assertProjection(reopened.posts[0]!, summary)
    assert.equal(reopened.effects()[0]!.status, 'completed'); assert.equal(reopened.effects()[0]!.message!.text, summary)
    assert.equal(reopened.runtime.get(ticketId).ended?.outcome, 'completed'); assert.equal(reopened.runs.length, 0)
    assert.equal(reopened.service.snapshot().sessions[0]!.sessionId, sessionId)
    const receipt = reopened.runtime.readData<{ receipt: { operationId: string } }>(`delivery:${failed.message!.id}`)!.receipt
    assert.equal(receipt.operationId, failed.message!.id)
    await sendDurableReply(reopened.runtime, failed.message!, credential('github'), { transport: reopened.transport })
    assert.equal(reopened.posts.length, 1)
  } finally { if (current) await current.close(); else rmSync(directory, { recursive: true, force: true }) }
})


test('a worker can correct an over-limit report without mutating its report or sending a failed answer first', async () => {
  const summary = longSummary(50_000)
  const f = fixture('github', { run: async turn => {
    const before = structuredClone(f.runtime.get(turn.ticketId).assignments.at(-1)!)
    await assert.rejects(invoke(turn, { state: 'ready', summary: longSummary(50_001), reply_to_trigger_id: request('github').id }), /Invalid report summary/)
    assert.deepEqual(f.runtime.get(turn.ticketId).assignments.at(-1), before)
    assert.equal(f.effects().length, 0); assert.equal(f.posts.length, 0)
    await invoke(turn, { state: 'ready', summary, reply_to_trigger_id: request('github').id })
  } })
  try {
    const { ticketId } = f.accept(); await eventually(() => f.runs.length === 1 && f.idle())
    assert.equal(f.posts.length, 1, 'The corrected accepted report must reach the source')
    assertProjection(f.posts[0]!, summary); assert.equal(f.effects().length, 1); assert.equal(f.effects()[0]!.status, 'completed')
    assert.equal(f.runtime.get(ticketId).assignments.at(-1)!.report!.summary, summary); assert.equal(f.runtime.get(ticketId).ended?.outcome, 'completed')
  } finally { await f.close() }
})
