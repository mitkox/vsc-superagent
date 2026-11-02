import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { key } from '../../src/core/index.ts'
import type { OutboundMessage, Trigger } from '../../src/core/index.ts'
import type { AgentBackend, AgentRun } from '../src/agent-backend.ts'
import { AutomationService } from '../src/orchestration.ts'
import { TicketRuntime } from '../src/runtime.ts'
import { automationPolicy } from '../src/settings.ts'
import { sourceTrigger } from '../src/sources.ts'
import type { SourceContext } from '../src/sources.ts'

const actors = { github: 'requester', teams: '22222222-2222-2222-2222-222222222222' }
const tenant = '11111111-1111-1111-1111-111111111111'
type Family = keyof typeof actors
const delay = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function eventually(check: () => boolean, label = 'Outbound fixture did not settle') {
  const until = Date.now() + 4000
  while (!check()) { if (Date.now() > until) assert.fail(label); await delay(5) }
}
function source(family: Family, id: string): Trigger {
  const shared = { sourceConfigId: `${family}:native-config`, nativeThreadId: family === 'github' ? '42' : 'root', human: true, bot: false,
    allowedActor: true, subscribed: true, addressed: 'mention' as const, createdAt: new Date().toISOString() }
  const context: SourceContext = family === 'github'
    ? { ...shared, provider: 'github', origin: 'https://api.github.com', repository: 'company/project', account: 'agent', number: 42, isPullRequest: true, kind: 'comment', commentId: 100 }
    : { ...shared, provider: 'teams', tenantId: tenant, chatId: '19:approved@thread.v2', rootMessageId: 'root', messageId: id }
  return sourceTrigger({ id: `${family}:outbound:${id}`, source: family, actor: actors[family], text: 'Repair the authorized defect', thread: shared.nativeThreadId, context,
    url: family === 'github' ? 'https://github.com/company/project/pull/42#issuecomment-100' : `https://teams.microsoft.com/l/message/19:approved@thread.v2/${id}` })
}
interface Attempt { message: OutboundMessage; signal: AbortSignal; credentialChecked: boolean }
interface Options {
  legacy?: boolean
  canSend?: boolean
  submissionBlocked?: boolean
  beforeSubmit?: (service: AutomationService, message: OutboundMessage) => void
  run?: (request: AgentRun) => Promise<void>
}
function fixture(options: Options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-outbound-authorization-')), runtime = new TicketRuntime(directory)
  const credentials = deferred(), submission = deferred(), attempts: Attempt[] = [], posts: OutboundMessage[] = [], runs: AgentRun[] = []
  if (!options.submissionBlocked) submission.resolve()
  let sendingEnabled = options.canSend ?? true, preSubmitChecks = 0, service!: AutomationService
  const backend: AgentBackend = {
    assess: async () => ({ kind: 'ignore', reason: 'No new work requested' }),
    run: async request => { runs.push(request); if (options.run) await options.run(request); else await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'waiting', summary: 'Waiting for authorized follow-up' }) },
    abort: async () => {}, dispose: async () => {},
  }
  // Keep the last authorization check at the actual submit boundary. It is optional only so the unchanged baseline can reproduce the race without a new-method error.
  const assertCurrent = (message: OutboundMessage, signal: AbortSignal) => (service as AutomationService & { assertOutboundAllowed?: (message: OutboundMessage, signal: AbortSignal) => void }).assertOutboundAllowed?.(message, signal)
  const dependencies = { backend, prepare: async () => directory, poll: async () => [] as Trigger[], canSend: () => sendingEnabled,
    send: async (original: OutboundMessage, signal: AbortSignal) => {
      if (options.legacy) {
        // Emulate the persisted pre-attribution format, retaining the original deterministic message ID.
        delete original.triggerId
        runtime.repositories.mutateAutomation(data => { const effect = data.effects.find(effect => effect.message?.id === original.id); if (effect?.message) delete effect.message.triggerId })
      }
      const message = structuredClone(original)
      const attempt = { message, signal, credentialChecked: false }; attempts.push(attempt)
      await credentials.promise
      signal.throwIfAborted(); assertCurrent(message, signal); attempt.credentialChecked = true
      await submission.promise
      options.beforeSubmit?.(service, message)
      preSubmitChecks++; assertCurrent(message, signal); signal.throwIfAborted()
      posts.push(message)
    },
  }
  service = new AutomationService(runtime, dependencies)
  service.saveSettings({ enabled: true, acceptMode: 'off', pollIntervalMs: 3_600_000, execution: { retryBaseMs: 10 },
    sources: { github: { enabled: true, allowedActors: [actors.github], allowUnaddressed: true }, teams: { enabled: true, allowedActors: [actors.teams], allowUnaddressed: true } } }, 0)
  const workerIdle = () => service.snapshot().health.workers === 0
  const effect = (id: string) => service.snapshot().effects.find(effect => effect.kind === 'outbound' && effect.message?.id === id)!
  return { directory, runtime, service, attempts, posts, runs, workerIdle, effect, credentials, submission, get preSubmitChecks() { return preSubmitChecks },
    setDelivery(enabled: boolean) { sendingEnabled = enabled; runtime.writeData('fixture-delivery-enabled', enabled) },
    async close() { credentials.resolve(); submission.resolve(); await service.dispose(); runtime.dispose(); rmSync(directory, { recursive: true, force: true }) },
  }
}
const tool = (request: AgentRun, name: string, args: unknown) => request.tools.find(tool => tool.name === name)!.invoke(args)
async function remoteAcknowledgement(f: ReturnType<typeof fixture>, family: Family) {
  const trigger = source(family, 'request')
  // Create the remote-origin mandate through the real gate/decision path.
  f.runtime.engine.receive(trigger)
  const decision = f.runtime.engine.decide(trigger.id, { kind: 'accept', title: 'Source-authorized repair', scope: 'The admitted requester repair', reason: 'Explicit addressed request' })
  const remote = f.runtime.get(decision.ticketId!)
  f.service.start()
  await eventually(() => f.attempts.length === 1 && f.workerIdle())
  return { ticket: remote, trigger, attempt: f.attempts[0]! }
}
async function nativeFollowupAcknowledgement(f: ReturnType<typeof fixture>, family: Family) {
  const origin = source(family, 'native-origin')
  const ticket = f.runtime.create('Locally authorize work on this source', { source: family, id: origin.id, actor: actors[family], context: origin.meta.provider as SourceContext, url: origin.url })
  f.service.start(); await eventually(() => f.runs.length === 1 && f.workerIdle())
  const trigger = source(family, 'followup')
  f.runtime.engine.receive(trigger)
  await eventually(() => f.attempts.length === 1 && f.workerIdle())
  return { ticket, trigger, attempt: f.attempts[0]! }
}
async function releaseDenied(f: ReturnType<typeof fixture>, attempt: Attempt) {
  await delay(20)
  f.credentials.resolve(); f.submission.resolve()
  await eventually(() => f.effect(attempt.message.id).status !== 'running')
  assert.equal(f.posts.length, 0, 'No provider POST may start after authorization is withdrawn during an await')
  assert.equal(attempt.signal.aborted, true)
}

for (const family of ['github', 'teams'] as const) {
  test(`${family} requester removal aborts an active outbound effect after its worker turn ended`, async () => {
    const f = fixture({ run: async request => {
      const ticket = f.runtime.get(request.ticketId)
      await tool(request, 'orchestrator_ack', { trigger_id: ticket.origin.triggerId, text: 'Working on the authorized request' })
      await tool(request, 'orchestrator_report', { state: 'waiting', summary: 'Worker turn finished before credential retrieval' })
    } })
    try {
      const { ticket, attempt } = await remoteAcknowledgement(f, family)
      assert.equal(f.workerIdle(), true)
      f.service.saveSettings({ sources: { [family]: { allowedActors: [] } } }, f.service.settings.revision)
      assert.equal(automationPolicy(f.service.settings.value).revalidate(f.runtime.get(ticket.id).mandate), false)
      await releaseDenied(f, attempt)
      assert.equal(f.effect(attempt.message.id).status, 'cancelled')
    } finally { await f.close() }
  })

  test(`${family} source disable keeps an active reply pending and resumes it exactly once after reenable`, async () => {
    const f = fixture({ run: async request => {
      const ticket = f.runtime.get(request.ticketId)
      await tool(request, 'orchestrator_ack', { trigger_id: ticket.origin.triggerId, text: 'Source acknowledgement' })
      await tool(request, 'orchestrator_report', { state: 'waiting', summary: 'Waiting' })
    } })
    try {
      const { attempt } = await remoteAcknowledgement(f, family)
      f.service.saveSettings({ sources: { [family]: { enabled: false } } }, f.service.settings.revision)
      await releaseDenied(f, attempt)
      assert.equal(f.effect(attempt.message.id).status, 'pending')
      assert.ok(f.effect(attempt.message.id).nextAttemptAt > Date.now() + 1000)
      f.service.saveSettings({ sources: { [family]: { enabled: true } } }, f.service.settings.revision)
      f.runtime.repositories.mutateAutomation(data => { data.effects.find(effect => effect.message?.id === attempt.message.id)!.nextAttemptAt = 0 })
      await eventually(() => f.posts.length === 1 && f.effect(attempt.message.id).status === 'completed')
      assert.equal(f.attempts.length, 2)
      assert.equal(f.posts[0]!.id, attempt.message.id)
    } finally { await f.close() }
  })

  for (const legacy of [false, true]) {
    test(`${family} ${legacy ? 'legacy unattributed' : 'attributed'} followup reply is revoked independently of a still-valid native mandate`, async () => {
      const f = fixture({ legacy, run: async request => {
        const ticket = f.runtime.get(request.ticketId), followup = ticket.inputs.findLast(input => input.kind === 'trigger')
        if (followup?.kind === 'trigger') await tool(request, 'orchestrator_ack', { trigger_id: followup.triggerId, text: 'Followup acknowledgement' })
        await tool(request, 'orchestrator_report', { state: 'waiting', summary: 'Turn complete' })
      } })
      try {
        const { ticket, trigger, attempt } = await nativeFollowupAcknowledgement(f, family)
        if (legacy) { assert.equal(attempt.message.triggerId, undefined); assert.equal(attempt.message.id, key('ack', trigger.id)) }
        f.service.saveSettings({ sources: { [family]: { allowedActors: [] } } }, f.service.settings.revision)
        assert.equal(automationPolicy(f.service.settings.value).revalidate(f.runtime.get(ticket.id).mandate), true)
        await releaseDenied(f, attempt)
        assert.equal(f.effect(attempt.message.id).status, 'cancelled')
      } finally { await f.close() }
    })
  }
}

test('native delivery disable pauses an already-active reply without treating it as permanently revoked', async () => {
  const f = fixture({ run: async request => {
    const ticket = f.runtime.get(request.ticketId)
    await tool(request, 'orchestrator_ack', { trigger_id: ticket.origin.triggerId, text: 'Delivery permission acknowledgement' })
    await tool(request, 'orchestrator_report', { state: 'waiting', summary: 'Turn complete' })
  } })
  try {
    const { attempt } = await remoteAcknowledgement(f, 'github')
    f.setDelivery(false)
    await releaseDenied(f, attempt)
    assert.equal(f.effect(attempt.message.id).status, 'pending')
    assert.ok(f.effect(attempt.message.id).nextAttemptAt > Date.now() + 1000)
    f.setDelivery(true)
    f.runtime.repositories.mutateAutomation(data => { data.effects.find(effect => effect.message?.id === attempt.message.id)!.nextAttemptAt = 0 })
    await eventually(() => f.posts.length === 1 && f.effect(attempt.message.id).status === 'completed')
    assert.equal(f.attempts.length, 2)
  } finally { await f.close() }
})

test('a followup becoming passive while credentials are awaited cancels its reply before submission', async () => {
  const f = fixture({ run: async request => {
    const ticket = f.runtime.get(request.ticketId), input = ticket.inputs.findLast(input => input.kind === 'trigger')
    if (input?.kind === 'trigger') await tool(request, 'orchestrator_ack', { trigger_id: input.triggerId, text: 'Passive transition acknowledgement' })
    await tool(request, 'orchestrator_report', { state: 'waiting', summary: 'Turn complete' })
  } })
  try {
    const { ticket, trigger, attempt } = await nativeFollowupAcknowledgement(f, 'github')
    f.runtime.repositories.atomic(() => {
      const current = f.runtime.get(ticket.id), input = current.inputs.find(input => input.kind === 'trigger' && input.triggerId === trigger.id)!
      input.passive = true; current.undelivered = current.undelivered.filter(id => id !== input.id); f.runtime.repositories.tickets.save(current)
    })
    assert.equal(automationPolicy(f.service.settings.value).revalidate(f.runtime.get(ticket.id).mandate), true)
    await releaseDenied(f, attempt)
    assert.equal(f.effect(attempt.message.id).status, 'cancelled')
  } finally { await f.close() }
})

test('the final submit guard observes synchronous revocation before the pump can abort the send', async () => {
  let changed = false
  const f = fixture({ beforeSubmit: service => {
    changed = true
    service.saveSettings({ sources: { github: { allowedActors: [] } } }, service.settings.revision)
  }, run: async request => {
    const ticket = f.runtime.get(request.ticketId)
    await tool(request, 'orchestrator_ack', { trigger_id: ticket.origin.triggerId, text: 'Final-boundary acknowledgement' })
    await tool(request, 'orchestrator_report', { state: 'waiting', summary: 'Turn complete' })
  } })
  try {
    const { attempt } = await remoteAcknowledgement(f, 'github')
    f.credentials.resolve(); await eventually(() => changed && f.effect(attempt.message.id).status !== 'running')
    assert.equal(f.preSubmitChecks, 1)
    assert.equal(f.posts.length, 0, 'Current authorization must be checked again at the final provider POST boundary')
    assert.equal(f.effect(attempt.message.id).status, 'cancelled')
  } finally { await f.close() }
})

test('human stop still aborts an active send before a provider POST starts', async () => {
  const f = fixture({ run: async request => {
    const ticket = f.runtime.get(request.ticketId)
    await tool(request, 'orchestrator_ack', { trigger_id: ticket.origin.triggerId, text: 'Stop-boundary acknowledgement' })
    await tool(request, 'orchestrator_report', { state: 'waiting', summary: 'Turn complete' })
  } })
  try {
    const { ticket, attempt } = await remoteAcknowledgement(f, 'github')
    f.runtime.stop(ticket.id)
    await releaseDenied(f, attempt)
    assert.equal(f.effect(attempt.message.id).status, 'cancelled')
  } finally { await f.close() }
})

for (const outcome of ['completed', 'merged'] as const) {
  test(`native-approved ${outcome} results remain authorized after the backend turn finishes`, async () => {
    const f = fixture({ run: async request => { await tool(request, 'orchestrator_report', { state: 'ready', summary: 'Authorized repair result' }) } })
    try {
      const origin = source('github', 'native-approved-result')
      f.service.saveSettings({ sources: { github: { allowedActors: [] } } }, f.service.settings.revision)
      const ticket = f.runtime.create(origin.text, { source: 'github', id: origin.id, actor: actors.github, context: origin.meta.provider as SourceContext, url: origin.url })
      if (outcome === 'merged') f.runtime.engine.bindThread(ticket.id, origin.threads[0]!, true)
      f.service.start(); await eventually(() => f.attempts.length >= 1 && f.workerIdle())
      if (outcome === 'merged') {
        f.runtime.engine.threadClosed(origin.threads[0]!, 'merged', new Date().toISOString())
        await eventually(() => f.attempts.length === 2)
      }
      assert.equal(f.runtime.get(ticket.id).ended?.outcome, outcome)
      assert.equal(f.runtime.get(ticket.id).mandate.actor.source, 'vscode')
      f.credentials.resolve()
      await eventually(() => f.posts.length === (outcome === 'merged' ? 2 : 1))
      assert.ok(f.attempts.every(attempt => !attempt.signal.aborted))
      assert.ok(f.posts.every(message => message.channel.thread === origin.channel!.thread))
      if (outcome === 'merged') assert.ok(f.posts.some(message => message.text.includes('Pull request merged.')))
    } finally { await f.close() }
  })
}


test('requester removal during a provider await after credentials passed still prevents the final POST', async () => {
  const f = fixture({ submissionBlocked: true, run: async request => {
    const ticket = f.runtime.get(request.ticketId)
    await tool(request, 'orchestrator_ack', { trigger_id: ticket.origin.triggerId, text: 'Provider-await acknowledgement' })
    await tool(request, 'orchestrator_report', { state: 'waiting', summary: 'Turn complete' })
  } })
  try {
    const { attempt } = await remoteAcknowledgement(f, 'teams')
    f.credentials.resolve(); await eventually(() => attempt.credentialChecked)
    assert.equal(f.preSubmitChecks, 0)
    f.service.saveSettings({ sources: { teams: { allowedActors: [] } } }, f.service.settings.revision)
    await releaseDenied(f, attempt)
    assert.equal(f.effect(attempt.message.id).status, 'cancelled')
  } finally { await f.close() }
})

test('a completed remote-origin result still revalidates its requester before actual submission', async () => {
  const f = fixture({ run: async request => { await tool(request, 'orchestrator_report', { state: 'ready', summary: 'Completed remote repair' }) } })
  try {
    const { ticket, attempt } = await remoteAcknowledgement(f, 'github')
    assert.equal(f.runtime.get(ticket.id).ended?.outcome, 'completed')
    assert.equal(f.workerIdle(), true)
    f.service.saveSettings({ sources: { github: { allowedActors: [] } } }, f.service.settings.revision)
    await releaseDenied(f, attempt)
    assert.equal(f.effect(attempt.message.id).status, 'cancelled')
  } finally { await f.close() }
})
