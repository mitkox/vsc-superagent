import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import type { AgentBackend, AgentRun } from '../src/agent-backend.ts'
import { AutomationService } from '../src/orchestration.ts'
import { TicketRuntime } from '../src/runtime.ts'
import type { AutomationData } from '../src/state.ts'

const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function eventually(check: () => boolean, label = 'Streaming persistence did not settle', timeout = 5000) {
  const until = Date.now() + timeout
  while (!check()) { if (Date.now() > until) assert.fail(label); await delay() }
}
const report = (request: AgentRun, state = 'ready', summary = 'Streamed work completed and verified') => request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state, summary })
const emit = (request: AgentRun, text: string, type = 'assistant.message_delta') => request.onEvent({ type, text, at: new Date().toISOString() })
const awaitRelease = (request: AgentRun, gate: Promise<void>) => Promise.race([gate, new Promise<void>(resolve => { if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true }) })])
function fixture(run: (request: AgentRun, turn: number) => Promise<void>, concurrency = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-stream-persistence-')), runtime = new TicketRuntime(directory)
  const runs: AgentRun[] = [], changedProblems: string[][] = []
  let service!: AutomationService
  const backend: AgentBackend = { assess: async () => ({ kind: 'ignore', reason: 'Native mandate already exists' }),
    run: async request => { runs.push(request); await run(request, runs.length) }, abort: async () => {}, dispose: async () => {} }
  service = new AutomationService(runtime, { backend, prepare: async () => directory, poll: async () => [], send: async () => {},
    changed: () => { if (service) changedProblems.push(service.snapshot().health.problems.map(problem => problem.component)) } })
  service.saveSettings({ enabled: true, pollIntervalMs: 3_600_000, execution: { concurrency, humanReserve: 0, retryLimit: 0 } }, 0)
  runtime.writeData('stream-business-sentinel', { cursor: 'retain-provider-position', operation: 'retain-business-operation' })
  runtime.writeData('delivery:uncertain-stream-sentinel', { attempted: true })
  const idle = () => service.snapshot().health.workers === 0 && !service.snapshot().effects.some(effect => ['start', 'deliver'].includes(effect.kind) && ['pending', 'running'].includes(effect.status))
  return { directory, runtime, service, runs, idle, changedProblems,
    async close(preserve = false) { await service.dispose(); runtime.dispose(); if (!preserve) rmSync(directory, { recursive: true, force: true }) },
  }
}
const transcript = (f: ReturnType<typeof fixture>, ticketId: string) => f.runtime.repositories.automation().sessions.find(session => session.ticketId === ticketId)!.transcript
function assertDurable(runtime: TicketRuntime, directory: string) {
  const body = readFileSync(join(directory, 'state.json'), 'utf8'), parsed = JSON.parse(body)
  assert.ok(Buffer.byteLength(body) < 16 * 1024 * 1024)
  assert.equal(parsed.checksum, createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex'))
  assert.deepEqual(runtime.readData('stream-business-sentinel'), { cursor: 'retain-provider-position', operation: 'retain-business-operation' })
  assert.deepEqual(runtime.readData('delivery:uncertain-stream-sentinel'), { attempted: true })
  const sessions = runtime.repositories.automation().sessions
  assert.ok(Buffer.byteLength(JSON.stringify(sessions.map(session => session.transcript))) <= 2 * 1024 * 1024)
  assert.ok(sessions.every(session => session.transcript.length <= 500 && session.transcript.every(event => event.text.length <= 50_000)))
}
async function reopen(f: ReturnType<typeof fixture>, tails: { ticketId: string; text: string }[]) {
  const before = f.runtime.repositories.automation().sessions.map(session => ({ ticketId: session.ticketId, sessionId: session.sessionId, directory: session.directory, revisions: session.revisions }))
  assertDurable(f.runtime, f.directory)
  for (const tail of tails) assert.ok(transcript(f, tail.ticketId).some(event => event.text === tail.text), tail.text)
  await f.close(true)
  const recovered = new TicketRuntime(f.directory)
  try {
    assertDurable(recovered, f.directory)
    assert.deepEqual(recovered.repositories.automation().sessions.map(session => ({ ticketId: session.ticketId, sessionId: session.sessionId, directory: session.directory, revisions: session.revisions })), before)
    for (const tail of tails) assert.ok(recovered.repositories.automation().sessions.find(session => session.ticketId === tail.ticketId)!.transcript.some(event => event.text === tail.text), tail.text)
    return recovered.repositories.snapshot().tickets
  } finally { recovered.dispose() }
}

test('100 assistant deltas over a retained1.8MB transcript avoid per-delta durable commits and yield to a real timer', async t => {
  let synchronousCommits = 0, elapsed = 0, timerProgress = false
  const f = fixture(async request => {
    f.runtime.repositories.mutateAutomation(data => { data.sessions.find(session => session.ticketId === request.ticketId)!.transcript = Array.from({ length: 36 }, (_, index) => ({ type: 'seed', text: `seed-${index}:` + 'x'.repeat(49_990), at: new Date().toISOString() })) })
    const unsubscribe = f.runtime.repositories.onCommit(() => { synchronousCommits++ })
    const timer = setTimeout(() => { timerProgress = true }, 0), started = performance.now()
    try { for (let index = 0; index < 100; index++) emit(request, `assistant-delta-${index}`) }
    finally { elapsed = performance.now() - started; unsubscribe() }
    await delay(5); clearTimeout(timer)
    await report(request)
  })
  try {
    const ticket = f.runtime.create('Keep normal token streaming responsive with retained diagnostic history'); f.service.start()
    await eventually(() => f.runtime.get(ticket.id).ended?.outcome === 'completed' && f.idle())
    t.diagnostic(`100 deltas: ${synchronousCommits} synchronous commits, ${elapsed.toFixed(1)}ms callback loop`)
    assert.ok(synchronousCommits <= 4, `Streaming100 deltas caused ${synchronousCommits} synchronous durable commits`)
    assert.equal(timerProgress, true)
    const records = await reopen(f, [{ ticketId: ticket.id, text: 'assistant-delta-99' }])
    assert.equal(records.find(record => record.id === ticket.id)!.ended?.outcome, 'completed')
  } finally { await f.close() }
})

test('assistant, tool, custom-tool and turn-end callbacks share one read transition per delivered batch', async () => {
  const f = fixture(async (request, turn) => {
    emit(request, `shared-assistant-${turn}`); emit(request, `shared-tool-${turn}`, 'tool.execution_complete')
    for (let index = 0; index < 3; index++) await request.tools.find(tool => tool.name === 'orchestrator_read')!.invoke({ resource: 'ticket' })
    await delay(5); await report(request, 'waiting', `Waiting after batch${turn}`)
  })
  const reads: { ticketId: string; ids: string[] }[] = [], original = f.runtime.engine.inputsRead.bind(f.runtime.engine)
  f.runtime.engine.inputsRead = (ticketId, ids) => { reads.push({ ticketId, ids: [...ids] }); original(ticketId, ids) }
  try {
    const ticket = f.runtime.create('Read each approved input batch once'); f.runtime.followup(ticket.id, 'FIRST_BATCH_INPUT'); f.service.start()
    await eventually(() => f.runs.length === 1 && f.idle())
    assert.equal(reads.length, 1, 'The first stream/tools/end-of-turn path must share its single read transition')
    assert.ok(reads[0]!.ids.length > 0)
    f.runtime.followup(ticket.id, 'SECOND_BATCH_INPUT')
    await eventually(() => f.runs.length === 2 && f.idle())
    assert.equal(reads.length, 2); assert.equal(f.runs[1]!.sessionId, f.runs[0]!.sessionId)
    assert.ok(reads[1]!.ids.length > 0); assert.ok(reads[1]!.ids.every(id => !reads[0]!.ids.includes(id)))
    assert.ok(f.runtime.get(ticket.id).inputs.filter(input => reads.some(read => read.ids.includes(input.id))).every(input => input.kind !== 'trigger' || !!input.readAt))
    f.runtime.setPaused(true)
    await assert.rejects(f.runs[1]!.tools.find(tool => tool.name === 'orchestrator_read')!.invoke({ resource: 'ticket' }), /paused|revoked|ended|abort/i)
    assert.equal(reads.length, 2, 'Per-tool authorization must still run before the shared read transition')
    await reopen(f, [{ ticketId: ticket.id, text: 'shared-tool-2' }])
  } finally { await f.close() }
})

for (const ending of ['success', 'failure', 'abort', 'stop', 'dispose'] as const) {
  test(`diagnostic tails survive ${ending} and durable reopen with their session and business state`, async () => {
    const tail = `TERMINAL-${ending}-TAIL`, gate = deferred()
    const f = fixture(async request => {
      for (let index = 0; index < 8; index++) emit(request, `terminal-${ending}-${index}`, 'session.info')
      emit(request, tail)
      if (ending === 'success') await report(request)
      else if (ending === 'failure') throw new Error('Fixture backend failure after its final diagnostic')
      else await awaitRelease(request, gate.promise)
    })
    try {
      const ticket = f.runtime.create(`Retain the ${ending} diagnostic checkpoint`); f.service.start()
      await eventually(() => f.runs.length === 1)
      if (ending === 'abort') f.runtime.stop(ticket.id)
      else if (ending === 'stop') await f.service.stop()
      else if (ending === 'dispose') await f.service.dispose()
      await eventually(() => f.service.snapshot().health.workers === 0)
      if (ending === 'success') assert.equal(f.runtime.get(ticket.id).ended?.outcome, 'completed')
      if (ending === 'failure') { assert.equal(f.runtime.get(ticket.id).assignments.at(-1)!.report!.state, 'failed'); assert.ok(f.runtime.get(ticket.id).assignments.at(-1)!.report!.summary.includes('Fixture backend failure')) }
      if (['abort', 'stop', 'dispose'].includes(ending)) assert.equal(f.runs[0]!.signal.aborted, true)
      const records = await reopen(f, [{ ticketId: ticket.id, text: tail }])
      assert.ok(records.some(record => record.id === ticket.id))
      if (ending === 'stop' || ending === 'dispose') await delay(300)
    } finally { gate.resolve(); await f.close() }
  })
}

test('two concurrent streams bound oversized multibyte diagnostics without synchronous persistence or lost business reports', async () => {
  const gate = deferred(), f = fixture(async request => { await awaitRelease(request, gate.promise); if (!request.signal.aborted) await report(request) }, 2)
  let commits = 0
  try {
    const tickets = [f.runtime.create('Concurrent Unicode stream A'), f.runtime.create('Concurrent Unicode stream B')]; f.service.start()
    await eventually(() => f.runs.length === 2)
    f.runtime.repositories.mutateAutomation(data => { for (const session of data.sessions) session.transcript = [] })
    const unsubscribe = f.runtime.repositories.onCommit(() => { commits++ }), huge = ('界🚀' + String.fromCharCode(0, 34, 92, 10)).repeat(40_000)
    try {
      for (let index = 0; index < 45; index++) for (const request of f.runs) emit(request, `${request.ticketId}-${index}:` + huge)
      for (let index = 0; index < 600; index++) emit(f.runs[0]!, `per-session-tiny-${index}`, 'session.info')
      for (const request of f.runs) emit(request, `CONCURRENT-${request.ticketId}-TAIL`, 'session.info')
    } finally { unsubscribe() }
    assert.ok(commits <= 4, `Concurrent diagnostic bursts caused ${commits} synchronous persistence commits`)
    await eventually(() => f.runs.every(request => transcript(f, request.ticketId).some(event => event.text === `CONCURRENT-${request.ticketId}-TAIL`)))
    assertDurable(f.runtime, f.directory)
    assert.ok(transcript(f, f.runs[0]!.ticketId).length <= 500)
    gate.resolve(); await eventually(() => f.idle())
    assert.ok(tickets.every(ticket => f.runtime.get(ticket.id).ended?.outcome === 'completed'))
    await reopen(f, f.runs.map(request => ({ ticketId: request.ticketId, text: `CONCURRENT-${request.ticketId}-TAIL` })))
  } finally { gate.resolve(); await f.close() }
})

test('a burst spanning seven active sessions retains at most2000 queued tiny events at its first durable drain', async () => {
  const gate = deferred(), f = fixture(async request => { await awaitRelease(request, gate.promise); if (!request.signal.aborted) await report(request) }, 7)
  let commits = 0
  try {
    for (let index = 0; index < 7; index++) f.runtime.create(`Tiny stream${index}`)
    f.service.start(); await eventually(() => f.runs.length === 7)
    f.runtime.repositories.mutateAutomation(data => { for (const session of data.sessions) session.transcript = [] })
    const unsubscribe = f.runtime.repositories.onCommit(() => { commits++ })
    try { for (let index = 0; index < 301; index++) for (const request of f.runs) emit(request, `TINY-${request.ticketId}-${index}`, 'session.info') }
    finally { unsubscribe() }
    await eventually(() => f.runs.every(request => transcript(f, request.ticketId).some(event => event.text === `TINY-${request.ticketId}-300`)))
    const events = f.runtime.repositories.automation().sessions.flatMap(session => session.transcript).filter(event => event.text.startsWith('TINY-'))
    assert.ok(events.length <= 2000, `The first drain retained ${events.length} queued tiny events`)
    assert.ok(events.length > 1000, 'The queue should retain useful recent diagnostics rather than erase the streams')
    assert.ok(commits <= 2, `Tiny diagnostic bursts caused ${commits} synchronous commits`)
    gate.resolve(); await eventually(() => f.idle())
    await reopen(f, f.runs.map(request => ({ ticketId: request.ticketId, text: `TINY-${request.ticketId}-300` })))
  } finally { gate.resolve(); await f.close() }
})

test('a failed timer drain retains its bounded tail, reports transient health and publishes recovery without extra error writes', async () => {
  const gate = deferred(), f = fixture(async request => { await awaitRelease(request, gate.promise); if (!request.signal.aborted) await report(request) })
  const repository = f.runtime.repositories, mutate = repository.mutateAutomation.bind(repository)
  let failNext = true, failures = 0, commits = 0, unsubscribe = () => {}
  try {
    const ticket = f.runtime.create('Recover diagnostic-only timer persistence'); f.service.start(); await eventually(() => f.runs.length === 1); await delay(20)
    emit(f.runs[0]!, 'RETRY-TIMER-TAIL', 'session.info')
    repository.mutateAutomation = <T>(work: (data: AutomationData) => T): T => {
      if (failNext) { failNext = false; failures++; throw new Error('Fixture transient diagnostic persistence failure') }
      return mutate(work)
    }
    unsubscribe = repository.onCommit(() => { commits++ })
    await eventually(() => f.service.snapshot().health.problems.some(problem => problem.component === 'transcript'), 'The timed diagnostic write failure was not surfaced', 2500)
    assert.equal(failures, 1); assert.equal(commits, 0, 'Reporting a diagnostic persistence failure must not add a business-state write')
    assert.ok(f.changedProblems.at(-1)!.includes('transcript'))
    await eventually(() => transcript(f, ticket.id).some(event => event.text === 'RETRY-TIMER-TAIL') && !f.service.snapshot().health.problems.some(problem => problem.component === 'transcript'), 'The bounded timed retry did not recover its pending tail', 3000)
    assert.equal(f.changedProblems.at(-1)!.includes('transcript'), false, 'The successful commit notification must publish cleared transient health')
    repository.mutateAutomation = mutate; unsubscribe(); unsubscribe = () => {}
    gate.resolve(); await eventually(() => f.idle()); assert.equal(f.runtime.get(ticket.id).ended?.outcome, 'completed')
    await reopen(f, [{ ticketId: ticket.id, text: 'RETRY-TIMER-TAIL' }]); await delay(300)
  } finally { repository.mutateAutomation = mutate; unsubscribe(); gate.resolve(); await f.close() }
})
