import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { OutboundMessage, ThreadRef, Trigger } from '../../src/core/index.ts'
import type { AgentBackend, AgentRun } from '../src/agent-backend.ts'
import { AutomationService } from '../src/orchestration.ts'
import { TicketRuntime } from '../src/runtime.ts'

const trigger = (id: string, options: Partial<Trigger> = {}): Trigger => ({
  id, source: 'github:scope', threads: [{ source: 'github:scope', id: 'issue-1' }],
  actor: { source: 'github:scope', id: 'owner' }, human: true, addressed: 'mention',
  at: new Date().toISOString(), text: `Fix ${id}`, channel: { source: 'github:scope', thread: 'github:scope:issue-1', address: { origin: 'https://api.github.com', repository: 'owner/repo', number: '1' } }, meta: {}, ...options,
})
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) { if (Date.now() > deadline) assert.fail('Automation did not settle'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
function fixture(run?: (request: AgentRun) => Promise<void>, extra: { send?: (message: OutboundMessage) => Promise<void>; prepare?: () => Promise<string>; resolveThread?: (family: 'github' | 'teams', id: string, signal: AbortSignal) => Promise<ThreadRef> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-automation-'))
  const runtime = new TicketRuntime(directory)
  const inbox: Trigger[] = [], sent: OutboundMessage[] = [], runs: AgentRun[] = []
  const backend: AgentBackend = {
    assess: async () => ({ kind: 'accept', title: 'Requested repair', scope: 'Fix the specified defect', reason: 'Explicit implementation request' }),
    run: async request => { runs.push(request); if (run) await run(request); else await request.tools.find(tool => tool.name === 'superagent_report')!.invoke({ state: 'ready', summary: 'Fixed and verified' }) },
    abort: async () => {}, dispose: async () => {},
  }
  const service = new AutomationService(runtime, { backend, prepare: extra.prepare ?? (async () => directory), resolveThread: extra.resolveThread, poll: async () => inbox.splice(0), send: async message => { if (extra.send) await extra.send(message); sent.push(message) } })
  service.saveSettings({ enabled: true, sources: { github: { enabled: true, allowedActors: ['owner'], allowedBots: [], allowUnaddressed: true }, teams: { enabled: false, allowedActors: [], allowedBots: [], allowUnaddressed: false } }, execution: { retryBaseMs: 10 } }, 0)
  return { directory, runtime, service, inbox, sent, runs, backend, clean: async () => { await service.dispose(); runtime.dispose(); rmSync(directory, { recursive: true, force: true }) } }
}

test('source trigger is assessed, runs in a persistent session and sends the result to its original channel', async () => {
  const f = fixture()
  try {
    f.inbox.push(trigger('first')); f.service.start(); await f.service.pollNow()
    await eventually(() => f.sent.some(message => message.kind === 'reply'))
    const ticket = f.runtime.list()[0]!
    assert.equal(ticket.mandate.actor.source, 'github:scope')
    assert.equal(ticket.ended?.outcome, 'completed')
    assert.equal(f.sent.at(-1)?.channel.thread, 'github:scope:issue-1')
    assert.equal(f.runs[0]?.ticketId, ticket.id)
    assert.equal(f.runs[0]?.sessionId, (f.service.snapshot().sessions as { sessionId: string }[])[0]?.sessionId)
  } finally { await f.clean() }
})

test('a local or Teams-origin worker can resolve an approved GitHub alias for context without new authority', async () => {
  const f = fixture(async request => {
    await request.tools.find(tool => tool.name === 'orchestrator_thread_follow')!.invoke({ thread: 'github:9', reason: 'Related issue' })
    await request.tools.find(tool => tool.name === 'superagent_report')!.invoke({ state: 'waiting', summary: 'Following context' })
  }, { resolveThread: async (family, id) => { assert.equal(family, 'github'); return { source: 'github:configured-repository', id } } })
  try {
    const ticket = f.runtime.create('Investigate using related repository context'); f.service.start()
    await eventually(() => !!f.runtime.repositories.threads.get('github:configured-repository:9'))
    const thread = f.runtime.repositories.threads.get('github:configured-repository:9')!
    assert.ok(thread.context?.includes(ticket.id))
    assert.equal(f.runtime.list().length, 1)
  } finally { await f.clean() }
})

test('a native named followup reaches its provider ticket instead of creating another ticket', async () => {
  const f = fixture(async request => { await request.tools.find(tool => tool.name === 'superagent_report')!.invoke({ state: 'waiting', summary: 'Waiting for feedback' }) })
  try {
    f.inbox.push(trigger('native-followup')); f.service.start(); await f.service.pollNow(); await eventually(() => f.runs.length === 1)
    const ticket = f.runtime.list()[0]!
    f.runtime.followup(ticket.id, 'Re-check the existing repair')
    await eventually(() => f.runs.length === 2)
    assert.equal(f.runtime.list().length, 1)
    assert.equal(f.runs[1]!.ticketId, ticket.id)
    assert.match(f.runs[1]!.prompt, /Re-check the existing repair/)
  } finally { await f.clean() }
})

test('pausing during worktree preparation retains a runnable pending assignment', async () => {
  let release!: () => void, prepares = 0
  const prepared = new Promise<void>(resolve => { release = resolve })
  const f = fixture(undefined, { prepare: async () => { if (++prepares === 1) await prepared; return f.directory } })
  try {
    const ticket = f.runtime.create('Repair after preparation'); f.service.start(); await eventually(() => prepares === 1)
    f.runtime.setPaused(true); release(); await eventually(() => f.service.snapshot().health.workers === 0)
    f.runtime.setPaused(false)
    await eventually(() => !!f.runtime.get(ticket.id).ended)
    assert.equal(f.runs.length, 1)
    assert.equal(f.runtime.get(ticket.id).ended?.outcome, 'completed')
  } finally { release(); await f.clean() }
})

test('stopping and restarting during preparation retains pending work', async () => {
  let release!: () => void, prepares = 0
  const prepared = new Promise<void>(resolve => { release = resolve })
  const f = fixture(undefined, { prepare: async () => { if (++prepares === 1) await prepared; return f.directory } })
  try {
    const ticket = f.runtime.create('Continue after service restart'); f.service.start(); await eventually(() => prepares === 1)
    const stopped = f.service.stop(); release(); await stopped
    f.service.start(); await eventually(() => !!f.runtime.get(ticket.id).ended)
    assert.equal(f.runs.length, 1)
  } finally { release(); await f.clean() }
})

test('unmentioned followups and CI wake an existing subscription without another ticket', async () => {
  const f = fixture(async request => { await request.tools.find(tool => tool.name === 'superagent_report')!.invoke({ state: 'waiting', summary: 'Awaiting CI' }) })
  try {
    f.inbox.push(trigger('initial')); f.service.start(); await f.service.pollNow(); await eventually(() => f.runs.length === 1)
    const session = f.runs[0]!.sessionId
    f.inbox.push(trigger('followup', { addressed: undefined })); await f.service.pollNow(); await eventually(() => f.runs.length === 2)
    f.inbox.push(trigger('ci', { human: false, addressed: undefined, actor: { source: 'github:scope', id: 'unlisted-bot' } })); await f.service.pollNow(); await eventually(() => f.runs.length === 3)
    assert.equal(f.runtime.list().length, 1)
    assert.ok(f.runs.every(run => run.sessionId === session))
  } finally { await f.clean() }
})

test('outbound retries retain a deterministic durable id and duplicate intake does not rerun', async () => {
  let attempts = 0
  const f = fixture(undefined, { send: async () => { if (++attempts === 1) throw new Error('Temporary upstream outage') } })
  try {
    const first = trigger('retry-send'); f.inbox.push(first, first); f.service.start(); await f.service.pollNow()
    await eventually(() => f.sent.length === 1)
    assert.equal(f.runs.length, 1)
    assert.ok(attempts > 1)
    assert.equal(f.service.snapshot().effects.filter(effect => effect.kind === 'outbound').length, 1)
  } finally { await f.clean() }
})

test('observe mode records positive inferred assessment without starting work', async () => {
  const f = fixture()
  try {
    f.service.saveSettings({ acceptMode: 'observe', rules: [{ id: 'repair', name: 'Repair', enabled: true, instruction: 'Fix explicit defects' }] }, 1)
    f.backend.assess = async () => ({ kind: 'accept', title: 'Repair', scope: 'Fix a defect', reason: 'Matched rule', rules: ['repair'] })
    f.inbox.push(trigger('observed', { addressed: undefined })); f.service.start(); await f.service.pollNow()
    await eventually(() => f.service.snapshot().decisions.length === 1)
    assert.equal(f.runtime.list().length, 0)
    assert.equal(f.service.snapshot().decisions[0]?.audit?.wouldAccept, true)
  } finally { await f.clean() }
})

test('settings are versioned, conflict checked, and prompts can be restored', async () => {
  const f = fixture()
  try {
    f.service.saveSettings({ prompts: { communication: 'Be concise.' } }, 1)
    assert.match(f.service.previewPrompt('worker'), /Be concise/)
    assert.throws(() => f.service.saveSettings({ enabled: false }, 1), /revision|conflict/i)
    f.service.restoreSettings(1, 2)
    assert.equal(f.service.settings.revision, 3)
    assert.doesNotMatch(f.service.previewPrompt('worker'), /Be concise/)
  } finally { await f.clean() }
})

test('worker concurrency is bounded and an explicit request uses the reserved human slot', async () => {
  const releases: (() => void)[] = []
  const f = fixture(async request => {
    await new Promise<void>(resolve => { releases.push(resolve); request.signal.addEventListener('abort', () => resolve(), { once: true }) })
    if (!request.signal.aborted) await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'waiting', summary: 'Waiting for the next update' })
  })
  try {
    f.service.saveSettings({ acceptMode: 'auto', rules: [{ id: 'repair', name: 'Repair', instruction: 'Repair explicit defects', enabled: true }], execution: { concurrency: 2, humanReserve: 1 } }, 1)
    f.backend.assess = async () => ({ kind: 'accept', title: 'Repair', scope: 'Repair the defect', reason: 'Matched rule', rules: ['repair'] })
    const item = (id: string, addressed: 'mention' | undefined) => trigger(id, { addressed, threads: [{ source: 'github:scope', id }] })
    f.inbox.push(item('inferred-one', undefined), item('inferred-two', undefined)); f.service.start(); await f.service.pollNow()
    await eventually(() => f.runtime.list().length === 2 && f.runs.length === 1)
    f.inbox.push(item('explicit-three', 'mention')); await f.service.pollNow(); await eventually(() => f.runs.length === 2)
    assert.equal(f.runtime.get(f.runs[1]!.ticketId).mandate.strength, 'explicit')
    assert.equal(f.service.snapshot().health.workers, 2)
    releases[0]!(); await eventually(() => f.runs.length === 3)
    assert.equal(f.service.snapshot().health.workers, 2)
  } finally { await f.clean() }
})

test('pause cancels a running turn and stale tools; resume recovers under the same persistent session', async () => {
  const f = fixture(async request => {
    if (f.runs.length > 1) { await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'waiting', summary: 'Recovered and awaiting input' }); return }
    await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  try {
    f.inbox.push(trigger('pause')); f.service.start(); await f.service.pollNow(); await eventually(() => f.runs.length === 1)
    const prior = f.runs[0]!, session = prior.sessionId
    f.runtime.setPaused(true); await eventually(() => prior.signal.aborted && f.service.snapshot().health.workers === 0)
    await assert.rejects(() => prior.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'ready', summary: 'Unauthorized stale result' }), /abort|paused/i)
    assert.equal(f.runs.length, 1)
    f.runtime.setPaused(false); await eventually(() => f.runs.length === 2)
    assert.equal(f.runs[1]!.sessionId, session)
    assert.match(f.runs[1]!.prompt, /host restarted/i)
  } finally { await f.clean() }
})

test('policy revocation and human stop cancel running authority', async () => {
  const f = fixture(async request => { await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true })) })
  try {
    f.inbox.push(trigger('revoke')); f.service.start(); await f.service.pollNow(); await eventually(() => f.runs.length === 1)
    const first = f.runs[0]!
    f.service.saveSettings({ sources: { github: { allowedActors: [] } } }, 1)
    await eventually(() => first.signal.aborted && f.service.snapshot().health.workers === 0)
    assert.equal(f.runtime.get(first.ticketId).assignments.at(-1)?.report?.state, 'blocked')
    await assert.rejects(() => first.tools.find(tool => tool.name === 'orchestrator_ack')!.invoke({ trigger_id: 'revoke', text: 'Stale acknowledgement' }), /abort|revoked/i)
    f.runtime.stop(first.ticketId)
    assert.equal(f.runtime.get(first.ticketId).ended?.by, 'human')
    assert.equal(f.runtime.repositories.automation().sessions[0]?.status, 'interrupted')
  } finally { await f.clean() }
})

test('automated crash recovery preserves the session and replaces unfinished assignments without a manual retry', async () => {
  const f = fixture()
  let reopened: TicketRuntime | undefined, next: AutomationService | undefined
  try {
    f.runtime.repositories.mutateAutomation(data => { data.activated = true })
    f.runtime.engine.receive(trigger('crashed'))
    const decision = f.runtime.engine.decide('crashed', { kind: 'accept', title: 'Unfinished repair', scope: 'Repair the specified defect', reason: 'Authorized request' })
    const ticket = f.runtime.get(decision.ticketId!), assignment = ticket.assignments.at(-1)!
    f.runtime.engine.assignmentStarted(ticket.id, assignment.id)
    f.runtime.repositories.mutateAutomation(data => {
      data.sessions.push({ ticketId: ticket.id, sessionId: 'persistent-crash-session', directory: f.directory, assignmentId: assignment.id, status: 'working', revisions: [1], transcript: [] })
      const effect = data.effects.find(effect => effect.kind === 'start')!; effect.status = 'running'
    })
    f.runtime.dispose()
    reopened = new TicketRuntime(f.directory)
    assert.notEqual(reopened.get(ticket.id).assignments.at(-1)?.report?.state, 'blocked')
    next = new AutomationService(reopened, { backend: f.backend, prepare: async () => f.directory, poll: async () => [], send: async message => { f.sent.push(message) } })
    next.start(); await eventually(() => f.sent.length === 1)
    assert.equal(f.runs[0]?.sessionId, 'persistent-crash-session')
    assert.equal(reopened.get(ticket.id).assignments.length, 2)
    assert.equal(reopened.get(ticket.id).ended?.outcome, 'completed')
  } finally { await next?.dispose(); reopened?.dispose(); await f.clean() }
})

test('worker PR claims are verified before report mutation and context-only replies are refused', async () => {
  let rejected = false
  const f = fixture(async request => {
    const follow = request.tools.find(tool => tool.name === 'orchestrator_thread_follow')!
    await follow.invoke({ thread: 'github:scope:related', reason: 'Related issue' })
    const report = request.tools.find(tool => tool.name === 'orchestrator_report')!
    await assert.rejects(() => report.invoke({ state: 'ready', summary: 'Unverified pull', pr_number: 12 }), /verification/i)
    rejected = true
    await report.invoke({ state: 'waiting', summary: 'Following related context' })
  })
  try {
    f.inbox.push(trigger('scope')); f.service.start(); await f.service.pollNow(); await eventually(() => rejected)
    assert.equal(f.runtime.list()[0]?.follows?.length ?? 0, 0)
    f.inbox.push(trigger('context', { threads: [{ source: 'github:scope', id: 'related' }], addressed: undefined, actor: { source: 'github:scope', id: 'outsider' } }))
    await f.service.pollNow(); await eventually(() => f.runs.length === 2)
    const ack = f.runs[1]!.tools.find(tool => tool.name === 'orchestrator_ack')!
    await assert.rejects(() => ack.invoke({ trigger_id: 'context', text: 'Cannot claim context as authority' }), /reach|belong|abort/i)
    assert.equal(f.runtime.list().length, 1)
  } finally { await f.clean() }
})

test('prompt parts and team skills are versioned while assessor instructions stay independent of workers', async () => {
  const f = fixture()
  const service = new AutomationService(f.runtime, { backend: f.backend, prepare: async () => f.directory, poll: async () => [], send: async () => {},
    systemPrompt: 'Old worker implementation instructions', assessmentPrompt: 'Route requests using evidence.',
    promptParts: { shared: 'Shared defaults', 'role/worker': 'Implement and verify', 'team/communication': 'Speak briefly', 'team/scope': 'Only the requested defect', 'team/delivery': 'Open a pull request', work: 'Default work instructions', 'skill/github': 'GitHub source skill' } })
  try {
    service.saveSettings({ prompts: { overrides: { work: { text: 'Use the project verification command' } }, skills: [{ name: 'identities', description: 'Account mappings', content: 'The release reviewer is the maintainers group.' }] } }, 1)
    assert.match(service.previewPrompt('worker'), /Use the project verification command/)
    assert.doesNotMatch(service.previewPrompt('worker'), /Default work instructions/)
    assert.match(service.previewPrompt('worker'), /identities: Account mappings/)
    assert.match(service.previewPrompt('assessor'), /Route requests using evidence/)
    assert.doesNotMatch(service.previewPrompt('assessor'), /Open a pull request|Implement and verify|Old worker implementation/)
    assert.throws(() => service.saveSettings({ prompts: { overrides: { unknown: { text: 'Not a valid part' } } } }, 2), /Unknown prompt part/)
    assert.throws(() => service.saveSettings({ prompts: { skills: [{ name: 'github', description: 'Reserved', content: 'Cannot shadow' }] } }, 2), /reserved/i)
    const upgrade = new AutomationService(f.runtime, { backend: f.backend, prepare: async () => f.directory, poll: async () => [], send: async () => {}, promptParts: { work: 'New default work instructions' } })
    assert.deepEqual(upgrade.snapshot().promptDefaultsChanged, ['work'])
    await upgrade.dispose()
  } finally { await service.dispose(); await f.clean() }
})

test('owned human followups receive stop-only judgement before delivery without new accepts or decisions', async () => {
  const f = fixture(async request => { await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'waiting', summary: 'Waiting for source updates' }) })
  let followupChecks = 0
  const assess = f.backend.assess
  f.backend.assess = async (prompt, signal, model) => {
    if (prompt.includes('stop-only follow-up check')) followupChecks++
    return assess(prompt, signal, model)
  }
  try {
    f.inbox.push(trigger('first-request')); f.service.start(); await f.service.pollNow(); await eventually(() => f.runs.length === 1)
    f.inbox.push(trigger('still-same-work', { addressed: undefined })); await f.service.pollNow(); await eventually(() => f.runs.length === 2)
    assert.equal(followupChecks, 1)
    assert.equal(f.runtime.list().length, 1)
    assert.equal(f.service.snapshot().decisions.length, 1)
    assert.equal(f.runtime.repositories.triggers.disposition('still-same-work')?.evalId, undefined)
  } finally { await f.clean() }
})

test('an authorized remote stop ends the ticket and aborts its running worker before delivering that message', async () => {
  const f = fixture(async request => { await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true })) })
  const assess = f.backend.assess
  f.backend.assess = async (prompt, signal, model) => prompt.includes('stop-only follow-up check')
    ? { kind: 'stop', ticketId: f.runs[0]!.ticketId, reason: 'The requester explicitly asked to stop this ticket' }
    : assess(prompt, signal, model)
  try {
    f.inbox.push(trigger('work')); f.service.start(); await f.service.pollNow(); await eventually(() => f.runs.length === 1)
    f.inbox.push(trigger('remote-stop', { addressed: undefined, text: 'Stop work on this ticket now.' })); await f.service.pollNow()
    await eventually(() => f.runtime.get(f.runs[0]!.ticketId).ended?.by === 'human' && f.runs[0]!.signal.aborted)
    assert.equal(f.runs.length, 1)
    assert.equal(f.service.snapshot().decisions.filter(decision => decision.kind === 'stop').length, 1)
    assert.equal(f.runtime.list().length, 1)
  } finally { await f.clean() }
})

test('unlisted human and bot followups cannot withdraw a ticket even if an assessor proposes stop', async () => {
  const f = fixture(async request => { await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'waiting', summary: 'Still awaiting the requested result' }) })
  const assess = f.backend.assess
  f.backend.assess = async (prompt, signal, model) => f.runs.length
    ? { kind: 'stop', ticketId: f.runs[0]!.ticketId, reason: 'Untrusted stop proposal' }
    : assess(prompt, signal, model)
  try {
    f.inbox.push(trigger('original')); f.service.start(); await f.service.pollNow(); await eventually(() => f.runs.length === 1)
    f.inbox.push(trigger('outsider-stop', { addressed: undefined, actor: { source: 'github:scope', id: 'outsider' }, text: 'Stop' }))
    await f.service.pollNow(); await eventually(() => f.runs.length === 2)
    f.inbox.push(trigger('bot-stop', { addressed: undefined, human: false, actor: { source: 'github:scope', id: 'bot' }, text: 'Stop' }))
    await f.service.pollNow(); await eventually(() => f.runs.length === 3)
    assert.equal(f.runtime.get(f.runs[0]!.ticketId).ended, undefined)
    assert.equal(f.service.snapshot().decisions.filter(decision => decision.kind === 'stop').length, 0)
  } finally { await f.clean() }
})

test('a source PR merge relays one final completion notice to the original Teams conversation', async () => {
  const f = fixture(async request => {
    f.runtime.engine.bindThread(request.ticketId, { source: 'github:scope', id: '42' }, true)
    await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'ready', summary: 'The repair is verified and ready for review.' })
  })
  try {
    f.service.saveSettings({ sources: { teams: { enabled: true, allowedActors: ['owner'] } } }, 1)
    f.inbox.push(trigger('teams-origin', { source: 'teams:scope', threads: [{ source: 'teams:scope', id: 'chat-root' }], actor: { source: 'teams:scope', id: 'owner' }, channel: { source: 'teams:scope', thread: 'teams:scope:chat-root', address: { tenantId: 'tenant', chatId: 'chat', rootMessageId: 'root', messageId: 'request' } } }))
    f.service.start(); await f.service.pollNow(); await eventually(() => f.sent.length === 1)
    assert.equal(f.runtime.list()[0]!.ended, undefined)
    f.runtime.engine.threadClosed({ source: 'github:scope', id: '42' }, 'merged', new Date().toISOString())
    await eventually(() => f.sent.length === 2)
    assert.match(f.sent[1]!.text, /merged/i)
    assert.equal(f.sent[1]!.channel.thread, 'teams:scope:chat-root')
    f.service.kick(); await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(f.sent.length, 2)
    assert.equal(f.runtime.list()[0]!.ended?.outcome, 'merged')
  } finally { await f.clean() }
})

test('a genuinely crashed host leaves a dead owner lock that is recovered with its persistent session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-crash-'))
  const runtimeModule = new URL('../src/runtime.ts', import.meta.url).href
  const script = `import { TicketRuntime } from ${JSON.stringify(runtimeModule)}; const runtime = new TicketRuntime(process.argv[1], { automation: true }); runtime.repositories.mutateAutomation(data => { data.activated = true }); const ticket = runtime.create('Recover after an actual process crash'); runtime.begin(ticket.id); runtime.repositories.mutateAutomation(data => data.sessions.push({ ticketId: ticket.id, sessionId: 'crash-owned-session', directory: process.argv[1], assignmentId: ticket.assignments[0].id, status: 'working', revisions: [], transcript: [] })); process.send({ ticketId: ticket.id }); setInterval(() => {}, 1000);`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let runtime: TicketRuntime | undefined, service: AutomationService | undefined
  try {
    const ready = await Promise.race([once(child, 'message'), once(child, 'error').then(([error]) => { throw error }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Crash fixture failed to start')), 3000); timer.unref() })])
    const ticketId = (ready[0] as { ticketId: string }).ticketId
    const owner = readFileSync(join(directory, 'state.lock'), 'utf8')
    assert.throws(() => new TicketRuntime(directory), /another host|owner cannot be verified/i)
    assert.equal(readFileSync(join(directory, 'state.lock'), 'utf8'), owner)
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    runtime = new TicketRuntime(directory)
    const runs: AgentRun[] = []
    const backend: AgentBackend = { assess: async () => ({ kind: 'ignore', reason: 'No new requests' }), run: async request => { runs.push(request); await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'ready', summary: 'Recovered and verified' }) }, abort: async () => {}, dispose: async () => {} }
    service = new AutomationService(runtime, { backend, prepare: async () => directory, poll: async () => [], send: async () => {} })
    service.saveSettings({ enabled: true }, 0); service.start()
    await eventually(() => runtime!.get(ticketId).ended?.outcome === 'completed')
    assert.equal(runs[0]!.sessionId, 'crash-owned-session')
    assert.equal(runtime.get(ticketId).assignments.length, 2)
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
    await service?.dispose(); runtime?.dispose(); rmSync(directory, { recursive: true, force: true })
  }
})

test('unverifiable lock owners and interrupted acquisition guards are preserved with actionable errors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-unknown-lock-'))
  try {
    const lock = join(directory, 'state.lock'), body = JSON.stringify({ pid: 12345678, token: 'legacy-with-no-host-identity' })
    writeFileSync(lock, body, { mode: 0o600 })
    assert.throws(() => new TicketRuntime(directory), /owner cannot be verified/i)
    assert.equal(readFileSync(lock, 'utf8'), body)
    writeFileSync(`${lock}.acquire`, 'interrupted-acquisition', { mode: 0o600 })
    assert.throws(() => new TicketRuntime(directory), /acquisition.*interrupted|state.lock.acquire/i)
    assert.equal(readFileSync(`${lock}.acquire`, 'utf8'), 'interrupted-acquisition')
    assert.equal(readFileSync(lock, 'utf8'), body)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
