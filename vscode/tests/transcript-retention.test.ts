import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ResumeSessionConfig, SessionConfig, SessionMetadata } from '@github/copilot-sdk'
import type { AgentBackend, AgentEvent, AgentRun } from '../src/agent-backend.ts'
import { CopilotBackend } from '../src/copilot.ts'
import type { CopilotClientConnection, CopilotSessionConnection } from '../src/copilot.ts'
import { AutomationService } from '../src/orchestration.ts'
import { TicketRuntime } from '../src/runtime.ts'

const capacity = 16 * 1024 * 1024
const eventTime = (sequence: number) => new Date(Date.UTC(2026, 10, 2, 0, 0, 0, sequence)).toISOString()
const message = (prefix: string, index: number, fill = 'x') => {
  const start = `${prefix}-${String(index).padStart(4, '0')}:`
  return start + fill.repeat(Math.ceil((50_000 - start.length) / fill.length)).slice(0, 50_000 - start.length)
}
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 30_000
  while (!check()) { if (Date.now() > deadline) assert.fail('The worker did not complete after its bounded event stream'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
const ready = (request: AgentRun) => request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'ready', summary: 'Verified business completion' })

function fixture(emit: (request: AgentRun, turn: number, record: (event: AgentEvent) => boolean) => Promise<void> | void) {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-transcript-retention-')), runtime = new TicketRuntime(directory)
  const runs: AgentRun[] = [], callbackErrors: string[] = [], reportErrors: string[] = []
  let recoveredAfterFailure = false
  // A failing baseline must report the real capacity error and terminate, rather than leave a poisoned asynchronous pump running.
  const recoverFixture = () => {
    recoveredAfterFailure = true
    runtime.repositories.mutateAutomation(data => { for (const session of data.sessions) session.transcript = [] })
  }
  const backend: AgentBackend = {
    assess: async () => ({ kind: 'ignore', reason: 'Native ticket already has its mandate' }),
    run: async request => {
      runs.push(request)
      const record = (event: AgentEvent) => {
        try { request.onEvent(event); return true } catch (error) { callbackErrors.push(String(error)); return false }
      }
      await emit(request, runs.length, record)
      try { await ready(request) }
      catch (error) { reportErrors.push(String(error)); recoverFixture(); await ready(request) }
      if (callbackErrors.length && !recoveredAfterFailure) recoverFixture()
    }, abort: async () => {}, dispose: async () => {},
  }
  const service = new AutomationService(runtime, { backend, prepare: async () => directory, poll: async () => [], send: async () => {} })
  service.saveSettings({ enabled: true, pollIntervalMs: 3_600_000, execution: { concurrency: 1, humanReserve: 0, retryLimit: 0 } }, 0)
  const settings = structuredClone(service.settings)
  runtime.writeData('business-sentinel', { cursor: 'provider-progress', operation: 'do-not-prune', values: [1, 2, 3] })
  service.start()
  return { directory, runtime, service, runs, callbackErrors, reportErrors, settings,
    async execute(title: string) {
      const ticket = runtime.create(title)
      await eventually(() => runtime.get(ticket.id).ended?.outcome === 'completed' && service.snapshot().health.workers === 0)
      return ticket.id
    },
    async close(preserve = false) { await service.dispose(); runtime.dispose(); if (!preserve) rmSync(directory, { recursive: true, force: true }) },
  }
}
function durable(runtime: TicketRuntime, directory: string) {
  const filename = join(directory, 'state.json'), body = readFileSync(filename, 'utf8')
  assert.ok(statSync(filename).size < capacity, 'The complete persisted state must remain below its business-state capacity')
  const parsed = JSON.parse(body)
  assert.equal(parsed.checksum, createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex'))
  assert.deepEqual(runtime.readData('business-sentinel'), { cursor: 'provider-progress', operation: 'do-not-prune', values: [1, 2, 3] })
}
async function verifyReopen(f: ReturnType<typeof fixture>, ids: string[], tail: string) {
  assert.deepEqual(f.callbackErrors, [], 'Diagnostic callbacks must not throw capacity errors before eviction can run')
  assert.deepEqual(f.reportErrors, [], 'Diagnostic retention must leave space for the real worker report')
  assert.deepEqual(f.service.settings, f.settings)
  assert.ok(ids.every(id => f.runtime.get(id).ended?.outcome === 'completed'))
  const sessions = f.runtime.repositories.automation().sessions
  assert.equal(sessions.length, ids.length)
  const identities = sessions.map(session => ({ ticketId: session.ticketId, sessionId: session.sessionId, directory: session.directory, revisions: session.revisions }))
  assert.ok(sessions.at(-1)!.transcript.some(event => event.text === tail), 'The recent diagnostic tail should survive byte eviction')
  assert.ok(sessions.every(session => session.transcript.length <= 500))
  assert.ok(sessions.every(session => session.transcript.every(event => event.text.length <= 50_000)))
  durable(f.runtime, f.directory)
  await f.close(true)
  const reopened = new TicketRuntime(f.directory)
  try {
    durable(reopened, f.directory)
    assert.deepEqual(reopened.repositories.automation().sessions.map(session => ({ ticketId: session.ticketId, sessionId: session.sessionId, directory: session.directory, revisions: session.revisions })), identities)
    assert.ok(ids.every(id => reopened.get(id).ended?.outcome === 'completed'))
    assert.ok(reopened.repositories.automation().sessions.at(-1)!.transcript.some(event => event.text === tail))
    assert.equal(reopened.repositories.snapshot().tickets.length, ids.length)
  } finally { reopened.dispose() }
}

test('more than335 maximum ASCII transcript callbacks preserve the latest tail and real completion across reopen', async () => {
  let attempted = 0
  const tail = 'ASCII-RECENT-TAIL'
  const f = fixture((_request, _turn, record) => {
    for (let index = 0; index < 360; index++) {
      attempted++
      record({ type: 'session.info', text: message('ASCII', index), at: eventTime(index) })
      if (f.callbackErrors.length >= 3) break
    }
    record({ type: 'session.info', text: tail, at: eventTime(361) })
  })
  try {
    const id = await f.execute('Keep the actual repair report durable while ASCII diagnostics grow')
    await verifyReopen(f, [id], tail)
    assert.equal(attempted, 360)
    assert.equal(f.runs[0]!.ticketId, id)
  } finally { await f.close() }
})

test('serialized multibyte and escaped transcript text cannot exhaust report capacity', async () => {
  const unit = '界🚀' + String.fromCharCode(0, 34, 92, 10), tail = 'MULTIBYTE-RECENT-TAIL'
  const sample = message('UNICODE', 0, unit)
  assert.ok(Buffer.byteLength(JSON.stringify({ text: sample }), 'utf8') > sample.length * 2, 'Exercise serialized bytes rather than character count')
  const f = fixture((_request, _turn, record) => {
    for (let index = 0; index < 160; index++) {
      record({ type: 'session.warning', text: message('UNICODE', index, unit), at: eventTime(index) })
      if (f.callbackErrors.length >= 3) break
    }
    record({ type: 'session.info', text: tail, at: eventTime(161) })
  })
  try {
    const id = await f.execute('Preserve business work under multibyte and JSON escaping pressure')
    await verifyReopen(f, [id], tail)
  } finally { await f.close() }
})

test('many persistent sessions share retention without pruning ticket, session or settings identity', async () => {
  const ids: string[] = [], tail = 'GLOBAL-SESSIONS-RECENT-TAIL'
  const f = fixture((_request, turn, record) => {
    for (let index = 0; index < 9; index++) {
      record({ type: 'session.info', text: message(`SESSION-${turn}`, index), at: eventTime(turn * 10 + index) })
      if (f.callbackErrors.length >= 3) break
    }
    record({ type: 'session.info', text: turn === 40 ? tail : `SESSION-${turn}-TAIL`, at: eventTime(turn * 10 + 9) })
  })
  try {
    for (let index = 0; index < 40; index++) ids.push(await f.execute(`Retain completed work and session identity ${index}`))
    assert.equal(f.runs.length, 40)
    await verifyReopen(f, ids, tail)
  } finally { await f.close() }
})

class MockSession implements CopilotSessionConnection {
  constructor(readonly sessionId: string, readonly config: SessionConfig | ResumeSessionConfig, private readonly send: (config: SessionConfig | ResumeSessionConfig, sessionId: string) => Promise<void>) {}
  async sendAndWait() { await this.send(this.config, this.sessionId) }
  async abort() {} async disconnect() {}
}
class MockClient implements CopilotClientConnection {
  readonly sessions: SessionMetadata[] = []
  constructor(private readonly send: (config: SessionConfig | ResumeSessionConfig, sessionId: string) => Promise<void>) {}
  async start() {} async stop() { return [] }
  async getAuthStatus() { return { isAuthenticated: true, login: 'fixture' } }
  async getStatus() { return { version: '1.0.105', protocolVersion: 3 } }
  async listSessions() { return this.sessions }
  async createSession(config: SessionConfig) {
    this.sessions.push({ sessionId: config.sessionId!, startTime: new Date(), modifiedTime: new Date(), isRemote: false, context: { workingDirectory: config.workingDirectory! } })
    return new MockSession(config.sessionId!, config, this.send)
  }
  async resumeSession(sessionId: string, config: ResumeSessionConfig) { return new MockSession(sessionId, config, this.send) }
  async deleteSession() {}
}

test('a huge SDK tool result is reduced before persistence and its worker can still report completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-sdk-transcript-retention-')), runtime = new TicketRuntime(directory)
  const tail = 'SDK-RECENT-TAIL', client = new MockClient(async (config, sessionId) => {
    config.onEvent!({ type: 'tool.execution_complete', id: 'large-tool-result', parentId: null, timestamp: eventTime(0),
      data: { toolCallId: 'large-tool-call', success: true, result: { content: 'HUGE-TOOL-RESULT:' + 'x'.repeat(4 * 1024 * 1024) } } })
    config.onEvent!({ type: 'assistant.message_delta', id: 'tail', parentId: null, timestamp: eventTime(1), ephemeral: true, data: { messageId: 'tail-message', deltaContent: tail } })
    await config.tools!.find(tool => tool.name === 'orchestrator_report')!.handler!({ state: 'ready', summary: 'Huge SDK result handled and verified' },
      { sessionId, toolCallId: 'report-call', toolName: 'orchestrator_report', arguments: {} })
  })
  const backend = new CopilotBackend({ cliPath: '/installed/copilot', clientFactory: () => client, onPermissionRequest: () => ({ kind: 'reject' }) })
  const service = new AutomationService(runtime, { backend, prepare: async () => directory, poll: async () => [], send: async () => {} })
  let reopened: TicketRuntime | undefined
  try {
    service.saveSettings({ enabled: true, pollIntervalMs: 3_600_000 }, 0)
    runtime.writeData('business-sentinel', { cursor: 'provider-progress', operation: 'do-not-prune', values: [1, 2, 3] })
    const ticket = runtime.create('Process a large tool result without retaining the whole SDK payload'); service.start()
    await eventually(() => runtime.get(ticket.id).ended?.outcome === 'completed' && service.snapshot().health.workers === 0)
    const session = runtime.repositories.automation().sessions[0]!
    const tool = session.transcript.find(event => event.type === 'tool.execution_complete')!
    assert.ok(tool.text.includes('HUGE-TOOL-RESULT:'))
    assert.ok(tool.text.length <= 50_000)
    assert.ok(session.transcript.some(event => event.text === tail))
    durable(runtime, directory)
    await service.dispose(); runtime.dispose()
    reopened = new TicketRuntime(directory)
    durable(reopened, directory)
    assert.equal(reopened.get(ticket.id).ended?.outcome, 'completed')
    assert.equal(reopened.repositories.automation().sessions[0]!.sessionId, session.sessionId)
    assert.ok(reopened.repositories.automation().sessions[0]!.transcript.some(event => event.text === tail))
  } finally { await service.dispose(); runtime.dispose(); reopened?.dispose(); rmSync(directory, { recursive: true, force: true }) }
})
