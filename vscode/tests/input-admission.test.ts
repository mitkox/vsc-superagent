import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AssessmentOutcome, OutboundMessage, Ticket, Trigger } from '../../src/core/index.ts'
import type { AgentBackend, AgentRun } from '../src/agent-backend.ts'
import { AutomationService } from '../src/orchestration.ts'
import { TicketRuntime } from '../src/runtime.ts'
import { ticketPermission } from '../src/permissions.ts'
import { automationPolicy } from '../src/settings.ts'
import { sourceTrigger } from '../src/sources.ts'
import type { SourceContext } from '../src/sources.ts'

const tenant = '11111111-1111-1111-1111-111111111111'
const owner = { github: 'owner', teams: '22222222-2222-2222-2222-222222222222' }
const colleague = { github: 'colleague', teams: '33333333-3333-3333-3333-333333333333' }
const outsider = { github: 'outsider', teams: '44444444-4444-4444-4444-444444444444' }
const bot = { github: 'checks[bot]', teams: '55555555-5555-5555-5555-555555555555' }
type Family = keyof typeof owner
type PromptInput = { id: string; kind: string; trigger?: Trigger }
const inputs = (request: AgentRun): PromptInput[] => JSON.parse(request.prompt.split('\n').find(line => line.startsWith('New inputs: '))!.slice('New inputs: '.length))
const invoke = (request: AgentRun, name: string, args: unknown) => request.tools.find(tool => tool.name === name)!.invoke(args)
const waiting = (request: AgentRun) => invoke(request, 'orchestrator_report', { state: 'waiting', summary: 'Waiting for an admitted follow-up' })
const delay = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function eventually(check: () => boolean, message = 'Admission fixture did not settle') {
  const until = Date.now() + 4000
  while (!check()) { if (Date.now() > until) assert.fail(message); await delay(5) }
}
function event(family: Family, id: string, actor: string, text = 'HOSTILE_NEW_INPUT', options: { bot?: boolean; addressed?: boolean; review?: boolean; meta?: Record<string, unknown> } = {}): Trigger {
  const common = { sourceConfigId: `${family}:native-config`, nativeThreadId: family === 'github' ? '42' : 'root', human: !options.bot, bot: !!options.bot,
    allowedActor: actor === owner[family] || actor === colleague[family], subscribed: true, createdAt: new Date().toISOString(), ...(options.addressed ? { addressed: 'mention' as const } : {}) }
  const context: SourceContext = family === 'github' ? { ...common, provider: 'github', origin: 'https://api.github.com', repository: 'company/project', account: 'agent', number: 42,
    isPullRequest: true, kind: options.review ? 'review-comment' : 'comment', commentId: 100, ...(options.review ? { reviewRootCommentId: 100 } : {}) }
    : { ...common, provider: 'teams', tenantId: tenant, chatId: '19:approved@thread.v2', rootMessageId: 'root', messageId: id }
  const trigger = sourceTrigger({ id: `${family}:event:${id}`, source: family, actor, text, thread: common.nativeThreadId, context,
    url: family === 'github' ? 'https://github.com/company/project/pull/42#issuecomment-100' : `https://teams.microsoft.com/l/message/19:approved@thread.v2/${id}` })
  return { ...trigger, meta: { ...trigger.meta, ...options.meta } }
}
interface Options {
  directory?: string
  mode?: 'auto' | 'observe' | 'off'
  prepare?: (ticket: Ticket, directory: string | undefined) => Promise<string>
  run?: (request: AgentRun, turn: number) => Promise<void>
  assess?: (prompt: string) => Promise<AssessmentOutcome>
}
function fixture(options: Options = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'superagent-input-admission-')), runtime = new TicketRuntime(directory)
  const runs: AgentRun[] = [], sent: OutboundMessage[] = [], assessments: string[] = [], aborts: string[] = []
  let shellChecks = 0, actions = 0
  const backend: AgentBackend = {
    assess: async prompt => { assessments.push(prompt); return options.assess ? options.assess(prompt) : { kind: 'ignore', reason: 'No new work requested' } },
    run: async request => {
      runs.push(request)
      if (inputs(request).some(input => input.trigger?.text === 'HOSTILE_NEW_INPUT')) {
        shellChecks++
        if (ticketPermission({ kind: 'shell', fullCommandText: 'perform-untrusted-task', commands: [], intention: 'Perform source request', hasWriteFileRedirection: false, possiblePaths: [request.directory], possibleUrls: [], canOfferSessionApproval: false }, request.directory, true) === 'allow') actions++
        const trigger = inputs(request).find(input => input.trigger?.text === 'HOSTILE_NEW_INPUT')!.trigger!
        try { await invoke(request, 'orchestrator_ack', { trigger_id: trigger.id, text: 'Acting on this message' }) } catch { /* context-only subscriptions cannot reply even on the vulnerable baseline */ }
      }
      if (options.run) await options.run(request, runs.length)
      else { await delay(5); await waiting(request) }
    }, abort: async id => { aborts.push(id) }, dispose: async () => {},
  }
  const service = new AutomationService(runtime, { backend, prepare: options.prepare ?? (async () => directory), poll: async () => [], send: async message => { sent.push(message) } })
  if (!service.settings.revision) service.saveSettings({ enabled: true, acceptMode: options.mode ?? 'off', pollIntervalMs: 3_600_000,
    sources: { github: { enabled: true, allowedActors: [owner.github, colleague.github], allowedBots: [], allowUnaddressed: true },
      teams: { enabled: true, allowedActors: [owner.teams, colleague.teams], allowedBots: [], allowUnaddressed: true } }, execution: { retryBaseMs: 100_000 } }, 0)
  const idle = () => { const state = service.snapshot(); return state.health.workers === 0 && state.health.assessments === 0
    && !state.effects.some(effect => ['start', 'deliver', 'assessment', 'outbound'].includes(effect.kind) && ['pending', 'running'].includes(effect.status)) }
  return { directory, runtime, service, runs, sent, assessments, aborts, idle, get shellChecks() { return shellChecks }, get actions() { return actions },
    async close(preserve = false) { await service.dispose(); runtime.dispose(); if (!preserve) rmSync(directory, { recursive: true, force: true }) },
  }
}
async function initial(f: ReturnType<typeof fixture>, family: Family, contextOnly = false) {
  const ticket = f.runtime.create('Native authorized repair'), sample = event(family, 'scope', owner[family], 'Approved source context')
  if (contextOnly) f.runtime.engine.followForContext(ticket.id, sample.threads[0]!)
  else f.runtime.engine.bindThread(ticket.id, sample.threads[0]!, true)
  f.service.start(); await eventually(() => f.runs.length === 1 && f.idle()); return ticket
}
const idFor = (runtime: TicketRuntime, ticketId: string, triggerId: string) => runtime.get(ticketId).inputs.find(input => input.kind === 'trigger' && input.triggerId === triggerId)!.id

for (const family of ['github', 'teams'] as const) for (const contextOnly of [false, true]) for (const mode of ['off', 'observe', 'auto'] as const) {
  test(`${family} ${contextOnly ? 'context' : 'own'} subscription in ${mode} mode retains unlisted text without an autonomous turn or action`, async () => {
    const f = fixture({ mode })
    try {
      const ticket = await initial(f, family, contextOnly), denied = event(family, `denied-${mode}`, outsider[family])
      f.runtime.engine.receive(denied)
      await delay(30)
      assert.equal(f.runs.length, 1, 'Subscription membership must not authorize an unlisted sender')
      assert.equal(f.shellChecks, 0); assert.equal(f.actions, 0); assert.equal(f.sent.length, 0)
      assert.equal(f.runtime.get(ticket.id).mandate.actor.source, 'vscode')
      assert.deepEqual(f.runtime.repositories.triggers.get(denied.id), denied)
      assert.equal(f.runtime.repositories.triggers.disposition(denied.id)?.fanout.includes(ticket.id) ?? false, false)
      assert.equal(f.runtime.get(ticket.id).undelivered.length, 0)
    } finally { await f.close() }
  })
}

for (const family of ['github', 'teams'] as const) {
  test(`${family} passive history survives reopen and explicit reading without granting source reply or routing authority`, async () => {
    let current: ReturnType<typeof fixture> | undefined = fixture()
    const directory = current.directory
    try {
      const f = current, ticket = await initial(f, family), denied = event(family, 'retained-passive', outsider[family], 'HOSTILE_NEW_INPUT', { review: true })
      f.runtime.engine.receive(denied); await delay(25)
      assert.equal(f.runs.length, 1)
      await f.close(true); current = undefined
      current = fixture({ directory }); const next = current
      next.service.start(); await delay(25)
      assert.equal(next.runs.length, 0, 'Reopen must not revive passive source text')
      next.runtime.followup(ticket.id, 'Inspect retained source history under the existing mandate')
      await eventually(() => next.runs.length === 1 && next.idle())
      const request = next.runs[0]!, thread = `${denied.threads[0]!.source}:${denied.threads[0]!.id}`
      const read = await invoke(request, 'orchestrator_read', { resource: `thread/${thread}` }) as { text: string }
      assert.ok(read.text.includes('HOSTILE_NEW_INPUT')); assert.ok(read.text.includes(denied.url!))
      assert.ok(!inputs(request).some(input => input.trigger?.id === denied.id))
      for (const [name, args] of [
        ['orchestrator_ack', { trigger_id: denied.id, text: 'Unadmitted acknowledgement' }],
        ['orchestrator_report', { state: 'waiting', summary: 'Unadmitted answer', reply_to_trigger_id: denied.id }],
        ['orchestrator_reply', { purpose: 'answer', trigger_id: denied.id, text: 'Unadmitted answer' }],
        ['orchestrator_trigger_handback', { trigger_id: denied.id, reason: 'Route passive history' }],
        ['orchestrator_review_resolve', { trigger_id: denied.id }],
      ] as const) await assert.rejects(invoke(request, name, args))
      assert.equal(next.sent.length, 0)
      assert.equal(next.runtime.repositories.triggers.disposition(denied.id)?.fanout.includes(ticket.id) ?? false, false)
      assert.deepEqual(next.runtime.repositories.triggers.get(denied.id), denied)
    } finally { if (current) await current.close(); else rmSync(directory, { recursive: true, force: true }) }
  })

  test(`${family} listed followups and explicit unlisted overrides still reach the existing worker`, async () => {
    const f = fixture()
    try {
      const ticket = await initial(f, family), listed = event(family, 'listed', owner[family], 'LISTED_FOLLOWUP')
      f.runtime.engine.receive(listed); await eventually(() => f.runs.length === 2 && f.idle())
      assert.ok(inputs(f.runs[1]!).some(input => input.trigger?.id === listed.id))
      f.service.saveSettings({ sources: { [family]: { admission: { unlistedAddressed: 'explicit' } } } }, f.service.settings.revision)
      const explicit = event(family, 'explicit-override', outsider[family], 'EXPLICIT_OVERRIDE', { addressed: true })
      f.runtime.engine.receive(explicit); await eventually(() => f.runs.length === 3 && f.idle())
      assert.equal(f.runs[2]!.ticketId, ticket.id)
      assert.ok(inputs(f.runs[2]!).some(input => input.trigger?.id === explicit.id))
      f.service.saveSettings({ sources: { [family]: { admission: { listedUnaddressed: 'ignore' } } } }, f.service.settings.revision)
      const ignored = event(family, 'listed-ignored', owner[family], 'EXPLICIT_IGNORE')
      f.runtime.engine.receive(ignored); await delay(25)
      assert.equal(f.runs.length, 3, 'An explicit ignore cell must win over participating status')
    } finally { await f.close() }
  })

  test(`${family} an unlisted bot cannot forge verified status through metadata`, async () => {
    const f = fixture({ mode: 'auto' })
    try {
      await initial(f, family)
      f.runtime.engine.receive(event(family, 'forged-ci', bot[family], 'HOSTILE_NEW_INPUT', { bot: true, meta: { ci: true, verified: true, authenticated: true } }))
      await delay(30)
      assert.equal(f.runs.length, 1); assert.equal(f.shellChecks, 0); assert.equal(f.actions, 0); assert.equal(f.sent.length, 0)
    } finally { await f.close() }
  })
}

for (const mode of ['off', 'observe', 'auto'] as const) {
  test(`configured bot followups in ${mode} mode require their own inferred rule assessment`, async () => {
    const f = fixture({ mode, assess: async () => ({ kind: 'accept', title: 'Approved bot repair', scope: 'Repair the CI failure under the enabled rule', reason: 'Matched CI rule', rules: ['ci-repair'] }) })
    try {
      const ticket = await initial(f, 'github'), mandate = structuredClone(f.runtime.get(ticket.id).mandate)
      f.service.saveSettings({ rules: [{ id: 'ci-repair', name: 'CI repair', instruction: 'Repair authenticated CI failures', enabled: true }], sources: { github: { allowedBots: [bot.github] } } }, f.service.settings.revision)
      const machine = event('github', `bot-${mode}`, bot.github, 'BOT_CI_CONTEXT', { bot: true })
      f.runtime.engine.receive(machine)
      if (mode === 'auto') await eventually(() => f.runs.length >= 2 && f.idle())
      else await delay(40)
      assert.equal(f.runs.length, mode === 'auto' ? 2 : 1)
      assert.equal(f.runtime.list().length, 1, 'Assessed PR feedback must retain the existing ticket')
      assert.deepEqual(f.runtime.get(ticket.id).mandate, mandate, 'A bot receipt cannot grant or replace the human/native mandate')
      if (mode === 'auto') {
        assert.equal(f.runs[1]!.ticketId, ticket.id)
        assert.equal(f.runs[1]!.sessionId, f.runs[0]!.sessionId)
        assert.ok(inputs(f.runs[1]!).some(input => input.trigger?.id === machine.id))
      } else assert.equal(f.runtime.get(ticket.id).inputs.some(input => input.kind === 'trigger' && input.triggerId === machine.id), false)
      if (mode === 'off') assert.equal(f.assessments.length, 0)
      else assert.ok(f.assessments.some(prompt => prompt.includes('BOT_CI_CONTEXT')))
    } finally { await f.close() }
  })
}

test('native approval imports an unlisted source message without inheriting remote requester authority', async () => {
  const f = fixture()
  try {
    const external = event('teams', 'native-approved', outsider.teams, 'HOSTILE_NEW_INPUT')
    const context = external.meta.provider as SourceContext
    const ticket = f.runtime.create(external.text, { source: 'teams', id: external.id, actor: outsider.teams, context, url: external.url })
    f.service.start(); await eventually(() => f.runs.length === 1 && f.idle())
    assert.equal(ticket.mandate.actor.source, 'vscode')
    assert.equal(f.runtime.context(ticket.id).messages[0]!.channel?.thread, external.channel!.thread)
    assert.equal(f.runtime.context(ticket.id).messages[0]!.meta.locallyApproved, true)
    assert.equal(f.runtime.context(ticket.id).messages[0]!.text, external.text)
  } finally { await f.close() }
})

test('sender revocation during asynchronous validation suppresses the queued input before backend dispatch', async () => {
  const validation = deferred(); let validations = 0
  const f = fixture({ prepare: async () => { if (++validations > 1) await validation.promise; return f.directory } })
  try {
    const ticket = await initial(f, 'github'), queued = event('github', 'queued-revocation', owner.github, 'QUEUED_WHILE_AUTHORIZED')
    f.runtime.engine.receive(queued)
    await eventually(() => validations === 2)
    f.service.saveSettings({ sources: { github: { allowedActors: [] } } }, f.service.settings.revision)
    assert.equal(automationPolicy(f.service.settings.value).revalidate(f.runtime.get(ticket.id).mandate), true)
    validation.resolve(); await delay(30)
    assert.equal(f.runs.length, 1)
    assert.equal(f.runtime.get(ticket.id).undelivered.length, 0)
    const retained = f.runtime.get(ticket.id).inputs.find(input => input.kind === 'trigger' && input.triggerId === queued.id)!
    assert.equal(retained.passive, true)
  } finally { validation.resolve(); await f.close() }
})

test('sender revocation aborts an active followup and rejects its tools while the native mandate remains authorized', async () => {
  const turn = deferred()
  const f = fixture({ run: async (request, count) => { if (count === 2) await turn.promise; else { await delay(5); await waiting(request) } } })
  try {
    const ticket = await initial(f, 'teams'), active = event('teams', 'active-revocation', owner.teams, 'AUTHORIZED_ACTIVE_INPUT')
    f.runtime.engine.receive(active); await eventually(() => f.runs.length === 2)
    const sessionId = f.runs[1]!.sessionId
    assert.equal(f.service.permitsWorkerTurn(ticket.id, sessionId), true)
    assert.equal(f.service.permitsWorkerTurn(ticket.id, 'another-session'), false)
    f.service.saveSettings({ sources: { teams: { allowedActors: [] } } }, f.service.settings.revision)
    // Permission checks must observe revocation synchronously, before the next pump aborts the backend.
    assert.equal(f.service.permitsWorkerTurn(ticket.id, sessionId), false)
    assert.equal(automationPolicy(f.service.settings.value).revalidate(f.runtime.get(ticket.id).mandate), true)
    await eventually(() => f.aborts.includes(ticket.id))
    assert.equal(f.runs[1]!.signal.aborted, true)
    await assert.rejects(invoke(f.runs[1]!, 'orchestrator_report', { state: 'ready', summary: 'Stale tool request' }))
    await assert.rejects(invoke(f.runs[1]!, 'orchestrator_ack', { trigger_id: active.id, text: 'Stale acknowledgement' }))
    turn.resolve(); await delay(20)
    assert.equal(f.sent.length, 0)
  } finally { turn.resolve(); await f.close() }
})

test('selected retries keep their durable IDs while revoked source projection stays passive across reopen', async () => {
  let current: ReturnType<typeof fixture> | undefined = fixture({ run: async (request, turn) => { await delay(5); await waiting(request); if (turn === 2) throw new Error('Fail after the selection checkpoint') } })
  const directory = current.directory
  try {
    const f = current, ticket = await initial(f, 'github')
    await f.service.stop()
    const revoked = event('github', 'selected-revoked', owner.github, 'SELECTED_REVOKED'), retained = event('github', 'selected-retained', colleague.github, 'SELECTED_RETAINED')
    f.runtime.engine.receive(revoked); f.runtime.engine.receive(retained)
    const selectedIds = [idFor(f.runtime, ticket.id, revoked.id), idFor(f.runtime, ticket.id, retained.id)], assignmentId = f.runtime.get(ticket.id).assignments.at(-1)!.id
    f.runtime.repositories.mutateAutomation(data => { for (const effect of data.effects) if (effect.kind === 'deliver') effect.status = 'cancelled' })
    f.runtime.repositories.enqueue({ id: 'selected-admission-retry', kind: 'deliver', ticketId: ticket.id, assignmentId, inputIds: selectedIds })
    f.service.start()
    await eventually(() => f.runs.length === 2 && f.service.snapshot().effects.some(effect => effect.id === 'selected-admission-retry' && effect.status === 'pending') && f.service.snapshot().health.workers === 0)
    assert.deepEqual(f.service.snapshot().effects.find(effect => effect.id === 'selected-admission-retry')!.inputIds, selectedIds)
    await f.service.stop()
    f.service.saveSettings({ sources: { github: { allowedActors: [colleague.github] } } }, f.service.settings.revision)
    f.runtime.repositories.mutateAutomation(data => { const effect = data.effects.find(effect => effect.id === 'selected-admission-retry')!; effect.attempts = 0; effect.nextAttemptAt = 0 })
    await f.close(true); current = undefined
    current = fixture({ directory }); const next = current
    next.service.start(); await eventually(() => next.runs.length === 1 && next.idle())
    assert.deepEqual(inputs(next.runs[0]!).map(input => input.id), [selectedIds[1]])
    const durable = next.service.snapshot().effects.find(effect => effect.id === 'selected-admission-retry')!
    assert.deepEqual(durable.inputIds, selectedIds); assert.equal(durable.inputIdsSelected, true)
    assert.equal(next.runtime.get(ticket.id).inputs.find(input => input.id === selectedIds[0])!.passive, true)
    assert.equal(next.runs[0]!.sessionId, f.runs[0]!.sessionId)
    assert.equal(next.runtime.get(ticket.id).undelivered.length, 0)
    assert.ok(next.runtime.context(ticket.id).messages.some(trigger => trigger.id === revoked.id))
  } finally { if (current) await current.close(); else rmSync(directory, { recursive: true, force: true }) }
})


for (const family of ['github', 'teams'] as const) {
  test(`${family} passive unlisted text cannot resume a completed ticket`, async () => {
    const f = fixture()
    try {
      const ticket = await initial(f, family), sample = event(family, 'scope-for-close', owner[family], 'Approved context')
      f.runtime.engine.threadClosed(sample.threads[0]!, 'merged', new Date().toISOString())
      const ended = structuredClone(f.runtime.get(ticket.id).ended)
      assert.equal(ended?.outcome, 'merged')
      const denied = event(family, 'after-completion', outsider[family])
      f.runtime.engine.receive(denied); await delay(30)
      assert.equal(f.runs.length, 1)
      assert.deepEqual(f.runtime.get(ticket.id).ended, ended)
      assert.equal(f.runtime.get(ticket.id).undelivered.length, 0)
      assert.deepEqual(f.runtime.repositories.triggers.get(denied.id), denied)
      assert.equal(f.actions, 0); assert.equal(f.sent.length, 0)
    } finally { await f.close() }
  })
}

for (const matching of ['missing', 'disabled'] as const) {
  test(`configured bot feedback with a ${matching} matched rule cannot bypass assessment through a subscription`, async () => {
    const f = fixture({ mode: 'auto', assess: async () => ({ kind: 'accept', title: 'Unapproved bot work', scope: 'Not rule-authorized', reason: 'Proposed repair', rules: matching === 'missing' ? [] : ['disabled-rule'] }) })
    try {
      const ticket = await initial(f, 'github')
      f.service.saveSettings({ sources: { github: { allowedBots: [bot.github] } }, rules: [{ id: 'disabled-rule', name: 'Disabled', instruction: 'Never authorize while disabled', enabled: false }] }, f.service.settings.revision)
      const machine = event('github', `bot-rule-${matching}`, bot.github, 'BOT_WITHOUT_AUTHORIZED_RULE', { bot: true })
      f.runtime.engine.receive(machine); await delay(40)
      assert.ok(f.assessments.some(prompt => prompt.includes('BOT_WITHOUT_AUTHORIZED_RULE')))
      assert.equal(f.runs.length, 1)
      assert.equal(f.runtime.list().length, 1)
      assert.equal(f.runtime.get(ticket.id).inputs.some(input => input.kind === 'trigger' && input.triggerId === machine.id && !input.passive), false)
    } finally { await f.close() }
  })
}

for (const mode of ['off', 'observe', 'auto'] as const) {
  test(`unlisted inferred override in ${mode} mode stays in the separate rule assessment path`, async () => {
    const f = fixture({ mode, assess: async () => ({ kind: 'accept', title: 'Inferred repair', scope: 'Only the rule-admitted repair', reason: 'Matched inference rule', rules: ['inferred-repair'] }) })
    try {
      const ticket = await initial(f, 'teams')
      f.service.saveSettings({ sources: { teams: { admission: { unlistedAddressed: 'inferred' } } }, rules: [{ id: 'inferred-repair', name: 'Inferred repair', instruction: 'Assess concrete source repair requests', enabled: true }] }, f.service.settings.revision)
      const inferred = event('teams', `inferred-${mode}`, outsider.teams, 'INFERRED_OVERRIDDEN_REQUEST', { addressed: true })
      f.runtime.engine.receive(inferred)
      if (mode === 'auto') await eventually(() => f.runs.length >= 2 && f.idle())
      else await delay(40)
      assert.equal(f.runs.length, mode === 'auto' ? 2 : 1)
      assert.equal(f.runtime.get(ticket.id).inputs.some(input => input.kind === 'trigger' && input.triggerId === inferred.id && !input.passive), false)
      if (mode === 'auto') {
        const accepted = f.runtime.list().find(row => row.id !== ticket.id)!
        assert.equal(accepted.mandate.strength, 'inferred')
        assert.deepEqual(accepted.mandate.basis.rules, ['inferred-repair'])
      }
      if (mode === 'observe') assert.ok(f.assessments.some(prompt => prompt.includes('INFERRED_OVERRIDDEN_REQUEST')))
      if (mode === 'off') assert.equal(f.assessments.length, 0)
    } finally { await f.close() }
  })
}


for (const family of ['github', 'teams'] as const) {
  test(`${family} an assessed inferred human origin retains its own read, acknowledgement, question, answer and result authority`, async () => {
    const source = event(family, 'inferred-origin-human', outsider[family], 'INFERRED_ORIGIN_REQUEST', { addressed: true })
    let ticketId = ''
    const f = fixture({ mode: 'auto', assess: async () => ({ kind: 'accept', title: 'Inferred source repair', scope: 'The assessed source request', reason: 'Matched an enabled rule', rules: ['origin-rule'] }),
      run: async request => {
        ticketId = request.ticketId
        const read = await invoke(request, 'orchestrator_read', { resource: `trigger/${source.id}` }) as Trigger
        assert.equal(read.id, source.id)
        await invoke(request, 'orchestrator_ack', { trigger_id: source.id, text: 'Investigating the assessed request' })
        await invoke(request, 'orchestrator_report', { state: 'waiting', summary: 'Need one source detail', human_action: 'Which failing input should be used?', question_for_trigger_id: source.id })
        await eventually(() => f.sent.some(message => message.text === 'Which failing input should be used?'), 'The inferred source question was not delivered')
        await invoke(request, 'orchestrator_report', { state: 'ready', summary: 'Assessed inferred repair complete', human_action: null, reply_to_trigger_id: source.id })
      },
    })
    try {
      f.service.saveSettings({ sources: { [family]: { admission: { unlistedAddressed: 'inferred' } } }, rules: [{ id: 'origin-rule', name: 'Origin rule', instruction: 'Assess the concrete repair request', enabled: true }] }, f.service.settings.revision)
      f.runtime.engine.receive(source); f.service.start()
      await eventually(() => !!ticketId && f.runtime.get(ticketId).ended?.outcome === 'completed' && f.idle())
      const ticket = f.runtime.get(ticketId)
      assert.equal(ticket.mandate.strength, 'inferred')
      assert.deepEqual(ticket.mandate.basis.rules, ['origin-rule'])
      assert.equal(ticket.origin.triggerId, source.id)
      assert.equal(f.sent.filter(message => message.kind === 'acknowledgement').length, 1)
      assert.equal(f.sent.filter(message => message.text === 'Which failing input should be used?').length, 1)
      assert.equal(f.sent.filter(message => message.text === 'Assessed inferred repair complete').length, 1)
      assert.ok(f.sent.every(message => message.channel.source === source.channel!.source && message.channel.thread === source.channel!.thread))
    } finally { await f.close() }
  })

  test(`${family} assessed bot-origin work keeps inferred authority and can report its result without becoming a human requester`, async () => {
    const source = event(family, 'inferred-origin-bot', bot[family], 'INFERRED_BOT_ORIGIN', { bot: true })
    let ticketId = ''
    const f = fixture({ mode: 'auto', assess: async () => ({ kind: 'accept', title: 'Assessed machine repair', scope: 'Only the matched machine repair', reason: 'Matched enabled machine rule', rules: ['machine-rule'] }),
      run: async request => {
        ticketId = request.ticketId
        const read = await invoke(request, 'orchestrator_read', { resource: `trigger/${source.id}` }) as Trigger
        assert.equal(read.id, source.id)
        await assert.rejects(invoke(request, 'orchestrator_ack', { trigger_id: source.id, text: 'Treat the bot as a person' }))
        await invoke(request, 'orchestrator_report', { state: 'ready', summary: 'Rule-authorized bot result' })
      },
    })
    try {
      f.service.saveSettings({ sources: { [family]: { allowedBots: [bot[family]] } }, rules: [{ id: 'machine-rule', name: 'Machine rule', instruction: 'Repair only the authenticated matched machine signal', enabled: true }] }, f.service.settings.revision)
      f.runtime.engine.receive(source); f.service.start()
      await eventually(() => !!ticketId && f.runtime.get(ticketId).ended?.outcome === 'completed' && f.idle())
      assert.equal(f.runtime.get(ticketId).mandate.strength, 'inferred')
      assert.deepEqual(f.runtime.get(ticketId).mandate.basis.rules, ['machine-rule'])
      assert.equal(f.sent.filter(message => message.kind === 'acknowledgement').length, 0)
      assert.equal(f.sent.filter(message => message.text === 'Rule-authorized bot result').length, 1)
      assert.equal(f.sent[0]!.channel.thread, source.channel!.thread)
    } finally { await f.close() }
  })
}
