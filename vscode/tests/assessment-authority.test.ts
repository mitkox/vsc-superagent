import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Engine } from '../../src/core/index.ts'
import type { Candidate, Ticket, Trigger } from '../../src/core/index.ts'
import type { AgentBackend, AgentRun } from '../src/agent-backend.ts'
import { AutomationService } from '../src/orchestration.ts'
import { TicketRuntime } from '../src/runtime.ts'
import { automationGate, automationPolicy } from '../src/settings.ts'
import { githubRepositoryRef, sourceTrigger } from '../src/sources.ts'
import type { GitHubContext } from '../src/sources.ts'

const scope = { origin: 'https://api.github.com', repository: 'company/project' }
const row = `${githubRepositoryRef(scope, 7).source}:issues`
const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(check: () => boolean) { const until = Date.now() + 3000; while (!check()) { if (Date.now() > until) assert.fail('Authority fixture did not settle'); await delay() } }
function event(id: string, actor: string, kind: GitHubContext['kind'] = 'comment'): Trigger {
  return sourceTrigger({ id, source: 'github', actor, text: `${actor} ${id} requested scope`, thread: '7',
    context: { provider: 'github', ...scope, account: 'agent', sourceConfigId: 'native', nativeThreadId: '7', number: 7,
      kind, isPullRequest: kind !== 'issue', human: true, bot: false, allowedActor: true, subscribed: false, addressed: 'mention' } })
}
function fixture(directory = mkdtempSync(join(tmpdir(), 'superagent-assessment-authority-')), hold = false) {
  const runtime = new TicketRuntime(directory), runs: AgentRun[] = [], aborted: string[] = []
  const backend: AgentBackend = { assess: async () => ({ kind: 'ignore', reason: 'No new work' }),
    run: async request => { runs.push(request); if (hold) await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
      else await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'waiting', summary: 'Same authority remains active' }) },
    abort: async id => { aborted.push(id) }, dispose: async () => {} }
  const service = new AutomationService(runtime, { backend, prepare: async () => directory, poll: async () => [], send: async () => {} })
  if (!service.settings.revision) service.saveSettings({ enabled: true, acceptMode: 'off', pollIntervalMs: 3_600_000,
    execution: { retryBaseMs: 100_000 }, sources: { github: { allowedActors: ['alice', 'bob'], admission: { unlistedAddressed: 'explicit' } } } }, 0)
  return { runtime, service, runs, aborted, directory, async close(preserve = false) { await service.dispose(); runtime.dispose(); if (!preserve) rmSync(directory, { recursive: true, force: true }) } }
}
/** Reproduce a ticket accepted by the previous generic batching behavior, rather than bypassing current assessment checks. */
function legacyAccept(f: ReturnType<typeof fixture>, triggers: Trigger[], rules?: string[], participating = false): Ticket {
  let candidate: Candidate | undefined
  const engine = new Engine({ repo: f.runtime.repositories,
    policy: () => ({ ...automationPolicy(f.service.settings.value), ...(participating ? { gate: (trigger: Trigger) => automationGate(f.service.settings.value, trigger, true) } : {}), admitsInput: undefined }),
    scope: { scope: () => ({ listened: true, observed: false }) }, assessor: { request: value => { candidate = value } },
    executor: { start: (ticket, assignment) => f.runtime.repositories.enqueue({ id: `start:${assignment.id}`, kind: 'start', ticketId: ticket.id, assignmentId: assignment.id }), deliver: () => {}, stop: () => {} },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} }, emit: () => {} })
  for (const trigger of triggers) engine.receive(trigger)
  engine.evaluateDue(); assert.ok(candidate); assert.equal(candidate.triggers.length, triggers.length)
  const decision = engine.decide(candidate.triggers[0]!.id, { kind: 'accept', title: 'Legacy accepted scope', scope: triggers.map(trigger => trigger.text).join(' AND '), reason: 'Legacy combined assessment', evalId: candidate.evalId, ...(rules ? { rules } : {}) })
  return f.runtime.get(decision.ticketId!)
}

for (const variant of ['different actors', 'same actor different rows'] as const) test(`persisted legacy scope from ${variant} cannot execute after reopen or contributor revocation`, async () => {
  let current: ReturnType<typeof fixture> | undefined = fixture()
  const directory = current.directory
  try {
    const origins = variant === 'different actors' ? [event('alice-request', 'alice'), event('bob-request', 'bob')]
      : [event('issue-request', 'outsider', 'issue'), event('comment-request', 'outsider')]
    const ticket = legacyAccept(current, origins), immutableScope = ticket.mandate.scope
    current.service.start(); await delay(40)
    assert.equal(current.runs.length, 0, 'A primary grant cannot authorize a different contributing sender or receiving row')
    assert.equal(current.runtime.get(ticket.id).assignments.at(-1)?.report?.state, 'blocked')
    if (variant === 'different actors') current.service.saveSettings({ sources: { github: { allowedActors: ['bob'], admission: { unlistedAddressed: 'ignore' } } } }, current.service.settings.revision)
    else current.service.saveSettings({ sources: { github: { admissionByScope: { [row]: { unlistedAddressed: 'ignore' } } } } }, current.service.settings.revision)
    await current.close(true); current = undefined
    current = fixture(directory); current.service.start(); await delay(40)
    assert.equal(current.runs.length, 0)
    const saved = current.runtime.get(ticket.id)
    assert.equal(saved.mandate.scope, immutableScope); assert.deepEqual(saved.origin.triggerIds, origins.map(trigger => trigger.id))
    for (const trigger of origins) assert.deepEqual(current.runtime.repositories.triggers.get(trigger.id), { ...trigger, at: new Date(trigger.at).toISOString() })
  } finally { if (current) await current.close(); else rmSync(directory, { recursive: true, force: true }) }
})

test('same-sender same-row legacy batch remains executable with its full immutable scope', async () => {
  const f = fixture()
  try {
    const ticket = legacyAccept(f, [event('first', 'bob'), event('second', 'bob')])
    f.service.start(); await eventually(() => f.runs.length === 1 && f.service.snapshot().health.workers === 0)
    assert.equal(f.runs[0]!.ticketId, ticket.id); assert.ok(f.runs[0]!.prompt.includes(ticket.mandate.scope))
    assert.equal(f.runtime.get(ticket.id).assignments.at(-1)?.report?.state, 'waiting')
  } finally { await f.close() }
})

test('an active restored mixed-origin mandate loses backend and custom-tool authority when a contributor is removed', async () => {
  const f = fixture(undefined, true)
  try {
    const bob = event('current-primary', 'bob'), alice = event('legacy-contributor', 'alice')
    const ticket = legacyAccept(f, [bob]); f.service.start(); await eventually(() => f.runs.length === 1)
    // Restore the persisted shape written by the previous mixed-sender accept path while a session is live.
    f.runtime.repositories.atomic(() => {
      f.runtime.repositories.triggers.save(alice)
      const restored = f.runtime.get(ticket.id); restored.origin.triggerIds = [alice.id, bob.id]
      restored.mandate.scope = `${alice.text} AND ${bob.text}`; f.runtime.repositories.tickets.save(restored)
    })
    f.service.saveSettings({ sources: { github: { allowedActors: ['bob'], admission: { unlistedAddressed: 'ignore' } } } }, f.service.settings.revision)
    await delay(30)
    assert.equal(f.runs[0]!.signal.aborted, true, 'A surviving primary cannot keep an old combined scope running')
    await assert.rejects(f.runs[0]!.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'ready', summary: 'Unrelated stale scope must not complete' }))
    assert.equal(f.runs.length, 1)
  } finally { await f.close() }
})

test('native local approval remains its own authority even with retained external origin history', async () => {
  const f = fixture()
  try {
    const ticket = f.runtime.create('Locally approved repair')
    const external = event('context-only-origin', 'outsider')
    f.runtime.repositories.atomic(() => { f.runtime.repositories.triggers.save(external); const saved = f.runtime.get(ticket.id)
      saved.origin.triggerIds.push(external.id); f.runtime.repositories.tickets.save(saved) })
    f.service.start(); await eventually(() => f.runs.length === 1 && f.service.snapshot().health.workers === 0)
    assert.equal(f.runtime.get(ticket.id).mandate.actor.source, 'vscode')
    assert.equal(f.runtime.get(ticket.id).assignments.at(-1)?.report?.state, 'waiting')
  } finally { await f.close() }
})

test('current explicit admission preserves a previously inferred mandate without promoting its authority', async () => {
  const f = fixture()
  try {
    f.service.saveSettings({ acceptMode: 'auto', rules: [{ id: 'repair', name: 'Repair', instruction: 'Repair this scope', enabled: true }],
      sources: { github: { admission: { unlistedAddressed: 'inferred' } } } }, f.service.settings.revision)
    const ticket = legacyAccept(f, [event('inferred-origin', 'outsider')], ['repair'])
    assert.equal(ticket.mandate.strength, 'inferred')
    f.service.saveSettings({ sources: { github: { allowedActors: ['alice', 'bob', 'outsider'] } } }, f.service.settings.revision)
    f.service.start(); await eventually(() => f.runs.length === 1 && f.service.snapshot().health.workers === 0)
    assert.equal(f.runtime.get(ticket.id).mandate.strength, 'inferred')
    assert.equal(f.runtime.get(ticket.id).assignments.at(-1)?.report?.state, 'waiting')
    f.service.saveSettings({ rules: [] }, f.service.settings.revision)
    await assert.rejects(f.runs[0]!.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'ready', summary: 'Removed rules cannot be borrowed' }))
  } finally { await f.close() }
})

test('an explicit listed participating followup retains its recorded grant while inferred legacy followups fail closed', async () => {
  const f = fixture()
  try {
    const trigger = event('handed-back-followup', 'bob'); delete trigger.addressed
    const ticket = legacyAccept(f, [trigger], undefined, true)
    assert.equal(ticket.mandate.strength, 'explicit'); assert.equal(ticket.mandate.basis.via, 'followup')
    f.service.start(); await eventually(() => f.runs.length === 1 && f.service.snapshot().health.workers === 0)
    assert.equal(f.runtime.get(ticket.id).assignments.at(-1)?.report?.state, 'waiting')
    f.service.saveSettings({ sources: { github: { allowedActors: [], admission: { unlistedAddressed: 'ignore' } } } }, f.service.settings.revision)
    await assert.rejects(f.runs[0]!.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'ready', summary: 'Removed followup requester' }))
    assert.equal(automationPolicy(f.service.settings.value).revalidate({ ...ticket.mandate, strength: 'inferred', basis: { via: 'followup', rules: ['repair'] } }), false)
  } finally { await f.close() }
})
