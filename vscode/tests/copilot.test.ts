import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { CopilotClientOptions, SessionConfig, ResumeSessionConfig, SessionMetadata } from '@github/copilot-sdk'
import { CopilotBackend, type CopilotBackendOptions, type CopilotClientConnection, type CopilotSessionConnection } from '../src/copilot.ts'
import type { AgentEvent, AgentRun } from '../src/agent-backend.ts'

class FakeSession implements CopilotSessionConnection {
  abortCount = 0
  disconnectCount = 0
  sends = 0
  constructor(readonly sessionId: string, readonly config: SessionConfig | ResumeSessionConfig, private readonly client: FakeClient) {}
  async sendAndWait() { this.sends++; return this.client.send(this.config, this) }
  async abort() { this.abortCount++ }
  async disconnect() { this.disconnectCount++ }
}

class FakeClient implements CopilotClientConnection {
  created: FakeSession[] = []
  resumed: FakeSession[] = []
  deleted: string[] = []
  sessions: SessionMetadata[] = []
  lookupCount = 0
  startCount = 0
  stopCount = 0
  lookupError?: Error
  resumeError?: Error
  createError?: Error
  transientLookups = 0
  send: (config: SessionConfig | ResumeSessionConfig, session: FakeSession) => Promise<unknown> = async () => undefined
  async start() { this.startCount++ }
  async stop() { this.stopCount++; return [] }
  async getAuthStatus() { return { isAuthenticated: true, login: 'test-user' } }
  async getStatus() { return { version: '1.0.105', protocolVersion: 3 } }
  async listSessions() {
    this.lookupCount++
    if (this.transientLookups-- > 0) throw Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' })
    if (this.lookupError) throw this.lookupError
    return this.sessions
  }
  async createSession(config: SessionConfig) {
    if (this.createError) throw this.createError
    const session = new FakeSession(config.sessionId!, config, this)
    this.created.push(session)
    this.sessions.push({ sessionId: session.sessionId, startTime: new Date(), modifiedTime: new Date(), isRemote: false,
      context: { workingDirectory: config.workingDirectory! } })
    return session
  }
  async resumeSession(sessionId: string, config: ResumeSessionConfig) {
    if (this.resumeError) throw this.resumeError
    const session = new FakeSession(sessionId, config, this)
    this.resumed.push(session)
    return session
  }
  async deleteSession(sessionId: string) { this.deleted.push(sessionId) }
}

function fixture(t: TestContext, options: Partial<CopilotBackendOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-copilot-test-'))
  const client = new FakeClient()
  let clientOptions: CopilotClientOptions | undefined
  const backend = new CopilotBackend({
    cliPath: '/installed/copilot',
    onPermissionRequest: () => ({ kind: 'reject' }),
    ...options,
    clientFactory: config => { clientOptions = config; return client },
  })
  const events: AgentEvent[] = []
  const input: AgentRun = {
    ticketId: 'ticket-a', sessionId: 'stable-ticket-a', directory,
    prompt: 'Implement the scoped task', systemPrompt: 'Worker instructions v1',
    tools: [], signal: new AbortController().signal, onEvent: event => events.push(event),
  }
  t.after(async () => { await backend.dispose(); rmSync(directory, { recursive: true, force: true }) })
  return { backend, client, input, events, clientOptions: () => clientOptions! }
}

test('stdio uses the installed CLI and suppresses inherited telemetry exporters', async t => {
  const f = fixture(t)
  const config = f.clientOptions()
  assert.deepEqual(config.connection, { kind: 'stdio', path: '/installed/copilot', args: undefined, env: undefined })
  assert.equal(config.telemetry, undefined)
  assert.equal(config.env?.COPILOT_GITHUB_TELEMETRY_DISABLED, 'true')
  assert.equal(config.env?.OTEL_SDK_DISABLED, 'true')
  assert.equal(config.env?.OTEL_EXPORTER_OTLP_ENDPOINT, undefined)
  assert.deepEqual(await f.backend.check(), { authenticated: true, cliVersion: '1.0.105', protocolVersion: 3, login: 'test-user' })
  assert.equal(f.client.created.length, 0)
})

test('a stable ticket creates once then resumes in its worktree with current instructions and model', async t => {
  const f = fixture(t, { model: 'configured-model' })
  await f.backend.run(f.input)
  await f.backend.run({ ...f.input, prompt: 'An authorized follow-up', systemPrompt: 'Worker instructions v2', model: 'selected-model' })
  assert.equal(f.client.created.length, 1)
  assert.equal(f.client.resumed.length, 1)
  assert.equal(f.client.created[0]!.sessionId, f.input.sessionId)
  assert.equal(f.client.created[0]!.config.model, 'configured-model')
  const resumed = f.client.resumed[0]!
  assert.equal(resumed.config.workingDirectory, f.input.directory)
  assert.deepEqual(resumed.config.additionalDirectories, [])
  assert.deepEqual(resumed.config.systemMessage, { mode: 'append', content: 'Worker instructions v2' })
  assert.equal(resumed.config.model, 'selected-model')
  assert.equal('continuePendingWork' in resumed.config && resumed.config.continuePendingWork, false)
  assert.equal('allowTranscriptRecovery' in resumed.config && resumed.config.allowTranscriptRecovery, false)
  assert.equal(resumed.disconnectCount, 1)
  assert.deepEqual(f.client.deleted, [])
})

test('a new backend resumes a verified persistent session without relying on process memory', async t => {
  const f = fixture(t)
  f.client.sessions.push({ sessionId: f.input.sessionId, startTime: new Date(), modifiedTime: new Date(), isRemote: false,
    context: { workingDirectory: f.input.directory } })
  await f.backend.run(f.input)
  assert.equal(f.client.resumed.length, 1)
  assert.equal(f.client.created.length, 0)
})

test('provider lookup and resume errors never create replacement conversations', async t => {
  const f = fixture(t)
  f.client.lookupError = new Error('Authentication required')
  await assert.rejects(f.backend.run(f.input), /Authentication required/)
  assert.equal(f.client.lookupCount, 1)
  assert.equal(f.client.created.length, 0)
  f.client.lookupError = undefined
  f.client.sessions.push({ sessionId: f.input.sessionId, startTime: new Date(), modifiedTime: new Date(), isRemote: false,
    context: { workingDirectory: f.input.directory } })
  f.client.resumeError = new Error('Service unavailable during resume')
  await assert.rejects(f.backend.run(f.input), /Service unavailable/)
  assert.equal(f.client.created.length, 0)
})

test('read-only lookups retry transient failures within a bound', async t => {
  const f = fixture(t)
  f.client.transientLookups = 2
  await f.backend.run(f.input)
  assert.equal(f.client.lookupCount, 3)
  assert.equal(f.client.created.length, 1)
  f.client.transientLookups = 9
  await assert.rejects(f.backend.run(f.input), /Connection reset/)
  assert.equal(f.client.lookupCount, 6)
  assert.equal(f.client.resumed.length, 0)
})

test('persisted remote or mismatched worktree sessions fail before execution', async t => {
  const f = fixture(t)
  f.client.sessions.push({ sessionId: f.input.sessionId, startTime: new Date(), modifiedTime: new Date(), isRemote: false,
    context: { workingDirectory: '/another/worktree' } })
  await assert.rejects(f.backend.run(f.input), /does not match/)
  f.client.sessions[0]!.context = { workingDirectory: f.input.directory }
  f.client.sessions[0]!.isRemote = true
  await assert.rejects(f.backend.run(f.input), /does not match/)
  assert.equal(f.client.resumed.length + f.client.created.length, 0)
})

test('a stable session cannot be assigned to another ticket', async t => {
  const f = fixture(t)
  await f.backend.run(f.input)
  await assert.rejects(f.backend.run({ ...f.input, ticketId: 'ticket-b' }), /another ticket/)
})

test('worker custom tools report through host handlers and transcript streams nested assistant output', async t => {
  const f = fixture(t)
  let reports = 0
  f.input.tools = [{ name: 'superagent_report', description: 'Report progress', schema: { type: 'object' }, invoke: async args => { reports++; return args } }]
  f.client.send = async config => {
    const tool = config.tools![0]!
    assert.equal(tool.skipPermission, undefined)
    assert.deepEqual(await tool.handler!({ summary: 'Implemented' }, { sessionId: f.input.sessionId, toolCallId: 'call-a', toolName: tool.name, arguments: {} }), { summary: 'Implemented' })
    config.onEvent!({ type: 'assistant.message_delta', id: 'event-a', parentId: null, timestamp: '2026-11-01T00:00:00Z', ephemeral: true,
      agentId: 'nested-agent', data: { deltaContent: 'Working', messageId: 'message-a' } })
  }
  await f.backend.run(f.input)
  assert.equal(reports, 1)
  assert.deepEqual(f.events, [{ type: 'assistant.message_delta', text: '[nested-agent] Working', at: '2026-11-01T00:00:00Z' }])
})

test('sent turn failures abort once without replaying custom external writes', async t => {
  const f = fixture(t)
  let writes = 0
  f.client.send = async () => { writes++; throw Object.assign(new Error('connection reset after external write'), { code: 'ECONNRESET' }) }
  await assert.rejects(f.backend.run(f.input), /after external write/)
  assert.equal(writes, 1)
  assert.equal(f.client.created[0]!.abortCount, 1)
})

test('host permission denials and managed interactive one-time approval are enforced', async t => {
  let decision: Awaited<ReturnType<CopilotBackendOptions['onPermissionRequest']>> = { kind: 'reject' }
  const f = fixture(t, { onPermissionRequest: (request, context) => {
    assert.equal(context.ticketId, 'ticket-a')
    assert.equal(context.rootSessionId, 'stable-ticket-a')
    assert.equal(context.sessionId, 'native-child-session')
    assert.equal(context.directory, f.input.directory)
    assert.equal(request.kind, 'read')
    return decision
  } })
  f.client.send = async config => {
    const request = { kind: 'read' as const, intention: 'Inspect', path: f.input.directory, managedApprovalRequired: true }
    const invocation = { sessionId: 'native-child-session', managedSettingsEnabled: true }
    assert.equal((await config.onPermissionRequest!(request, invocation)).kind, 'reject')
    decision = { kind: 'approve-once' }
    assert.equal((await config.onPermissionRequest!(request, invocation)).kind, 'reject')
    decision = { kind: 'approve-once', approvedInteractively: true }
    assert.equal((await config.onPermissionRequest!(request, invocation)).kind, 'approve-once')
  }
  await f.backend.run(f.input)
})

test('abort revokes nested hooks, permission requests, and custom tool handlers before stopping the turn', async t => {
  const f = fixture(t, { onPermissionRequest: () => ({ kind: 'approve-once' }) })
  let started!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  let config!: SessionConfig | ResumeSessionConfig
  f.input.tools = [{ name: 'report', description: 'Report', schema: {}, invoke: async () => { throw new Error('must not invoke') } }]
  f.client.send = async current => { config = current; started(); return new Promise(() => {}) }
  const run = f.backend.run(f.input)
  await running
  await f.backend.abort('ticket-a')
  await assert.rejects(run, /abort/i)
  assert.equal(f.client.created[0]!.abortCount, 1)
  assert.deepEqual(await config.hooks!.onPreToolUse!({ toolName: 'bash', toolArgs: {}, agentId: 'child', sessionId: 'child-session', timestamp: new Date(), workingDirectory: f.input.directory }, { sessionId: 'child-session' }), {
    permissionDecision: 'deny', permissionDecisionReason: 'Ticket authority has ended',
  })
  assert.equal((await config.onPermissionRequest!({ kind: 'read', path: f.input.directory, intention: 'Read' }, { sessionId: 'child-session' })).kind, 'reject')
  await assert.rejects(Promise.resolve().then(() => config.tools![0]!.handler!({}, { sessionId: 'child-session', toolCallId: 'late', toolName: 'report', arguments: {} })), /abort|authority/i)
})

test('an already aborted signal never starts the SDK', async t => {
  const f = fixture(t)
  await assert.rejects(f.backend.run({ ...f.input, signal: AbortSignal.abort() }), /abort/i)
  assert.equal(f.client.startCount, 0)
})

test('cancellation while creating a session aborts the returned session before any prompt is sent', async t => {
  const f = fixture(t)
  let created!: () => void
  let release!: () => void
  const creation = new Promise<void>(resolve => { created = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const create = f.client.createSession.bind(f.client)
  f.client.createSession = async config => { const session = await create(config); created(); await gate; return session }
  const controller = new AbortController()
  const running = f.backend.run({ ...f.input, signal: controller.signal })
  await creation
  controller.abort()
  release()
  await assert.rejects(running, /abort/i)
  assert.equal(f.client.created[0]!.sends, 0)
  assert.equal(f.client.created[0]!.abortCount, 1)
})

test('a permission approval that arrives after cancellation is rejected', async t => {
  let allow!: () => void
  const approval = new Promise<void>(resolve => { allow = resolve })
  const f = fixture(t, { onPermissionRequest: async () => { await approval; return { kind: 'approve-once', approvedInteractively: true } } })
  let requested!: () => void
  const request = new Promise<void>(resolve => { requested = resolve })
  let result: Promise<unknown> | undefined
  f.client.send = async config => {
    result = Promise.resolve(config.onPermissionRequest!({ kind: 'read', path: f.input.directory, intention: 'Read' }, { sessionId: f.input.sessionId }))
    requested()
    return new Promise(() => {})
  }
  const running = f.backend.run(f.input)
  await request
  await f.backend.abort(f.input.ticketId)
  allow()
  await assert.rejects(running, /abort/i)
  assert.deepEqual(await result, { kind: 'reject', feedback: 'Ticket authority has ended' })
})

test('assessment has an isolated empty worktree and exactly one structured terminal tool', async t => {
  const f = fixture(t)
  f.client.send = async config => {
    assert.notEqual(config.workingDirectory, f.input.directory)
    assert.deepEqual(config.availableTools, ['custom:superagent_assessment_outcome'])
    assert.deepEqual(config.excludedTools, ['builtin:*', 'mcp:*'])
    assert.equal(config.enableFileHooks, false)
    assert.equal(config.enableConfigDiscovery, false)
    assert.equal(config.enableHostGitOperations, false)
    assert.equal(config.enableSkills, false)
    const tool = config.tools![0]!
    assert.equal(tool.isTerminal, true)
    assert.equal((await config.onPermissionRequest!({ kind: 'read', path: '/etc/passwd', intention: 'Read' }, { sessionId: 'assessment' })).kind, 'reject')
    const blocked = await config.hooks!.onPreToolUse!({ toolName: 'bash', toolArgs: {}, sessionId: 'assessment', timestamp: new Date(), workingDirectory: config.workingDirectory! }, { sessionId: 'assessment' })
    assert.equal(blocked?.permissionDecision, 'deny')
    assert.throws(() => tool.handler!({ kind: 'accept', title: 'Missing scope', reason: 'Requested' }, { sessionId: 'assessment', toolCallId: 'invalid', toolName: tool.name, arguments: {} }))
    await tool.handler!({ kind: 'accept', title: 'Repair the form', scope: 'Form validation', reason: { code: 'said', values: { text: 'Requested explicitly' } }, rules: ['explicit'] },
      { sessionId: 'assessment', toolCallId: 'valid', toolName: tool.name, arguments: {} })
    assert.throws(() => tool.handler!({ kind: 'ignore', reason: 'Second outcome' }, { sessionId: 'assessment', toolCallId: 'duplicate', toolName: tool.name, arguments: {} }), /no longer/)
  }
  assert.deepEqual(await f.backend.assess('Candidate facts', new AbortController().signal, 'assessor-model'), {
    kind: 'accept', title: 'Repair the form', scope: 'Form validation', reason: { code: 'said', values: { text: 'Requested explicitly' } }, rules: ['explicit'],
  })
  assert.equal(f.client.created[0]!.config.model, 'assessor-model')
  assert.deepEqual(f.client.deleted, [f.client.created[0]!.sessionId])
  assert.equal(f.client.resumed.length, 0)
})

test('assessment refuses unstructured text and malformed terminal outcomes', async t => {
  const f = fixture(t)
  f.client.send = async () => ({ data: { content: '{"kind":"accept","reason":"Guess"}' } })
  await assert.rejects(f.backend.assess('Candidate', new AbortController().signal), /without a valid structured outcome/)
  assert.equal(f.client.created[0]!.abortCount, 1)
  assert.equal(f.client.deleted.length, 1)
})

test('dispose revokes active work and rejects future runs', async t => {
  const f = fixture(t)
  await f.backend.dispose()
  await assert.rejects(f.backend.run(f.input), /disposed/)
  await assert.rejects(f.backend.assess('Facts', new AbortController().signal), /disposed/)
  assert.equal(f.client.stopCount, 1)
})
