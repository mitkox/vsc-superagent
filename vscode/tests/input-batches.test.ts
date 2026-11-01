import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Ticket, Trigger } from '../../src/core/index.ts'
import type { AgentBackend, AgentRun } from '../src/agent-backend.ts'
import { AutomationService } from '../src/orchestration.ts'
import { TicketRuntime } from '../src/runtime.ts'

interface PromptInput { id: string; kind: string; trigger?: Trigger; text?: string }
const inputs = (request: AgentRun): PromptInput[] => {
  const line = request.prompt.split('\n').find(line => line.startsWith('New inputs: '))
  assert.ok(line, 'The backend must receive the actual new-input JSON line')
  return JSON.parse(line.slice('New inputs: '.length)) as PromptInput[]
}
const labels = (batch: PromptInput[]) => batch.flatMap(input => input.trigger && ['A', 'B', 'C', 'late'].includes(input.trigger.text) ? [input.trigger.text] : [])
const reportWaiting = (request: AgentRun) => request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'waiting', summary: 'Waiting for the next input' })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) { if (Date.now() > deadline) assert.fail('Input delivery did not settle'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
function fixture(options: { directory?: string; retryBaseMs?: number; prepare?: (ticket: Ticket) => Promise<string>; run?: (request: AgentRun, turn: number) => Promise<void> } = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'superagent-input-batches-'))
  const runtime = new TicketRuntime(directory), runs: AgentRun[] = [], batches: PromptInput[][] = []
  const backend: AgentBackend = {
    assess: async () => ({ kind: 'ignore', reason: 'Ordinary follow-up stays with the existing worker' }),
    run: async request => { runs.push(request); batches.push(inputs(request)); if (options.run) await options.run(request, runs.length); else await reportWaiting(request) },
    abort: async () => {}, dispose: async () => {},
  }
  const service = new AutomationService(runtime, { backend, prepare: options.prepare ?? (async () => directory), poll: async () => [], send: async () => {} })
  if (!service.settings.revision) service.saveSettings({ enabled: true, sources: { github: { enabled: true, allowedActors: ['owner'], allowUnaddressed: true }, teams: { enabled: false } },
    execution: { concurrency: 1, humanReserve: 0, retryBaseMs: options.retryBaseMs ?? 10 }, pollIntervalMs: 3_600_000 }, 0)
  return { directory, runtime, service, runs, batches,
    settled: () => service.snapshot().health.workers === 0 && !service.snapshot().effects.some(effect => ['start', 'deliver'].includes(effect.kind) && ['pending', 'running'].includes(effect.status)),
    async close(preserve = false) { await service.dispose(); runtime.dispose(); if (!preserve) rmSync(directory, { recursive: true, force: true }) },
  }
}
const sourceFollowup = (id: string, text: string): Trigger => ({ id, source: 'github:scope', threads: [{ source: 'github:scope', id: '1' }],
  actor: { source: 'github:scope', id: 'owner' }, human: true, at: new Date().toISOString(), text,
  channel: { source: 'github:scope', thread: 'github:scope:1', address: { origin: 'https://api.github.com', repository: 'owner/repo', number: '1' } }, meta: {} })

test('overlapping busy-worker proposals deliver A then B once while full history stays readable', async () => {
  const initial = deferred(), actions = new Map<string, number>(), history: string[][] = []
  const f = fixture({ run: async (request, turn) => {
    if (turn === 1) await initial.promise
    for (const label of labels(inputs(request))) actions.set(label, (actions.get(label) ?? 0) + 1)
    const context = await request.tools.find(tool => tool.name === 'orchestrator_read')!.invoke({ resource: 'ticket' }) as ReturnType<TicketRuntime['context']>
    history.push(context.messages.map(trigger => trigger.text))
    await reportWaiting(request)
  } })
  try {
    const ticket = f.runtime.create('Initial approved repair')
    f.runtime.engine.bindThread(ticket.id, { source: 'github:scope', id: '1' }, false)
    f.service.start(); await eventually(() => f.runs.length === 1)
    f.runtime.followup(ticket.id, 'A')
    f.runtime.engine.receive(sourceFollowup('source-B', 'B'))
    const proposals = f.service.snapshot().effects.filter(effect => effect.kind === 'deliver')
    assert.deepEqual(proposals.map(effect => effect.inputIds?.length), [1, 2])
    initial.resolve()
    await eventually(() => f.runs.length >= 3 && f.settled())
    assert.deepEqual(f.batches.slice(1).map(labels), [['A'], ['B']])
    assert.deepEqual([...actions], [['A', 1], ['B', 1]])
    assert.ok(history.at(-1)?.includes('A')); assert.ok(history.at(-1)?.includes('B'))
    assert.equal(f.runtime.get(ticket.id).undelivered.length, 0)
    assert.equal(f.runs.length, 3)
  } finally { initial.resolve(); await f.close() }
})

const inputId = (runtime: TicketRuntime, ticketId: string, label: string) => runtime.get(ticketId).inputs.find(input => input.kind === 'trigger'
  && runtime.repositories.triggers.get(input.triggerId)?.text === label)!.id
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('start selects late arrivals after worktree preparation without another turn', async () => {
  const prepared = deferred(); let preparing = false
  const f = fixture({ prepare: async () => { preparing = true; await prepared.promise; return f.directory } })
  try {
    const ticket = f.runtime.create('Initial approved repair'); f.service.start()
    await eventually(() => preparing)
    f.runtime.followup(ticket.id, 'late')
    prepared.resolve()
    await eventually(() => f.runs.length === 1 && f.settled())
    assert.deepEqual(f.batches.map(labels), [['late']])
    assert.equal(f.runtime.get(ticket.id).undelivered.length, 0)
  } finally { prepared.resolve(); await f.close() }
})

test('delivery rechecks pending inputs after preparation and cancels empty or consumed proposals', async () => {
  const prepared = deferred(); let prepares = 0, preparing = false
  const f = fixture({ prepare: async () => { if (++prepares > 1) { preparing = true; await prepared.promise } return f.directory } })
  try {
    const ticket = f.runtime.create('Initial approved repair'); f.service.start()
    await eventually(() => f.runs.length === 1 && f.settled())
    f.runtime.repositories.mutateAutomation(data => { delete data.sessions[0]!.directory })
    f.runtime.followup(ticket.id, 'A')
    await eventually(() => preparing)
    const id = inputId(f.runtime, ticket.id, 'A'), assignmentId = f.runtime.get(ticket.id).assignments.at(-1)!.id
    f.runtime.repositories.enqueue({ id: 'empty-delivery-proposal', kind: 'deliver', ticketId: ticket.id, assignmentId, inputIds: [] })
    f.runtime.repositories.enqueue({ id: 'consumed-delivery-proposal', kind: 'deliver', ticketId: ticket.id, assignmentId, inputIds: [id] })
    f.runtime.engine.inputsDelivered(ticket.id, assignmentId, [id])
    prepared.resolve()
    await eventually(() => f.settled())
    assert.equal(f.runs.length, 1)
    assert.ok(f.service.snapshot().effects.filter(effect => effect.kind === 'deliver').every(effect => effect.status === 'cancelled'))
  } finally { prepared.resolve(); await f.close() }
})

test('durably selected retries retain A after attempts reset and reopen while late C stays separate', async () => {
  let current: ReturnType<typeof fixture> | undefined = fixture({ retryBaseMs: 100_000, run: async (request, turn) => {
    await delay(5); await reportWaiting(request)
    if (turn === 2) throw new Error('Transient failure after the waiting checkpoint')
  } })
  const directory = current.directory
  try {
    const f = current, ticket = f.runtime.create('Initial approved repair'); f.service.start()
    await eventually(() => f.runs.length === 1 && f.settled())
    f.runtime.followup(ticket.id, 'A')
    await eventually(() => f.runs.length === 2 && f.service.snapshot().health.workers === 0)
    const id = inputId(f.runtime, ticket.id, 'A')
    const retained = f.service.snapshot().effects.find(effect => effect.kind === 'deliver' && effect.inputIds?.includes(id))!
    assert.equal(retained.status, 'pending')
    const assignment = f.runtime.get(ticket.id).assignments.at(-1)!
    assert.ok(assignment.report!.at > assignment.deliveredAt!)
    await f.service.stop()
    f.runtime.followup(ticket.id, 'C')
    f.runtime.repositories.mutateAutomation(data => { data.effects.find(effect => effect.id === retained.id)!.status = 'failed' })
    assert.throws(() => f.service.retryEffect(retained.id), /cannot be retried/)
    f.runtime.repositories.mutateAutomation(data => {
      const effect = data.effects.find(effect => effect.id === retained.id)!
      effect.status = 'pending'; effect.attempts = 0; effect.nextAttemptAt = 0
    })
    await f.close(true); current = undefined
    current = fixture({ directory })
    const next = current
    assert.equal(next.runtime.get(ticket.id).assignments.at(-1)!.id, assignment.id)
    next.service.start()
    await eventually(() => next.settled())
    assert.deepEqual(next.batches.map(labels), [['A'], ['C']])
    assert.equal(next.runtime.get(ticket.id).assignments.length, 1)
    assert.equal(next.runtime.get(ticket.id).assignments.at(-1)!.id, assignment.id)
    const selected = next.service.snapshot().effects.find(effect => effect.id === retained.id)!
    assert.deepEqual(selected.inputIds, [id])
    assert.equal(selected.inputIdsSelected, true)
    assert.equal(selected.attempts, 1)
  } finally { if (current) await current.close(); else rmSync(directory, { recursive: true, force: true }) }
})

test('preselection preparation retries reselect current pending IDs despite old proposals and attempts', async () => {
  let prepares = 0
  let current: ReturnType<typeof fixture> | undefined = fixture({ retryBaseMs: 100_000,
    prepare: async () => { if (++prepares > 1) throw new Error('Worktree unavailable before selection'); return current!.directory },
    run: async request => { await delay(5); await reportWaiting(request) },
  })
  const directory = current.directory
  try {
    const f = current, ticket = f.runtime.create('Initial approved repair'); f.service.start()
    await eventually(() => f.runs.length === 1 && f.settled())
    f.runtime.repositories.mutateAutomation(data => { delete data.sessions[0]!.directory })
    f.runtime.followup(ticket.id, 'A')
    const id = inputId(f.runtime, ticket.id, 'A')
    const failed = () => f.service.snapshot().effects.find(effect => effect.kind === 'deliver' && effect.inputIds?.includes(id))!
    await eventually(() => failed().status === 'pending' && failed().attempts === 1 && f.service.snapshot().health.workers === 0)
    f.runtime.repositories.mutateAutomation(data => { data.effects.find(effect => effect.id === failed().id)!.nextAttemptAt = 0 })
    await eventually(() => failed().status === 'pending' && failed().attempts === 2 && f.service.snapshot().health.workers === 0)
    const retainedId = failed().id, assignmentId = f.runtime.get(ticket.id).assignments.at(-1)!.id
    await f.service.stop()
    f.runtime.engine.inputsDelivered(ticket.id, assignmentId, [id])
    await delay(5); f.runtime.report(ticket.id, 'waiting', 'The earlier input was consumed before preparation resumed')
    f.runtime.followup(ticket.id, 'C')
    f.runtime.repositories.mutateAutomation(data => { data.effects.find(effect => effect.id === retainedId)!.nextAttemptAt = 0 })
    await f.close(true); current = undefined
    current = fixture({ directory }); const next = current
    next.service.start()
    await eventually(() => next.runs.length >= 1 && next.settled())
    assert.deepEqual(next.batches.map(labels), [['C']])
    assert.equal(next.service.snapshot().effects.find(effect => effect.id === retainedId)!.status, 'cancelled')
    assert.equal(next.runtime.get(ticket.id).assignments.at(-1)!.id, assignmentId)
  } finally { if (current) await current.close(); else rmSync(directory, { recursive: true, force: true }) }
})
