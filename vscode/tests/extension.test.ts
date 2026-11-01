import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const requireModule = createRequire(import.meta.url)
const code = buildSync({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], write: false }).outputFiles[0]!.text

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'superagent-extension-'))
  const root = join(temporary, 'repo'); mkdirSync(root)
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(root, 'file'), 'original'); git('add', '.'); git('commit', '-qm', 'initial')
  const commands = new Map<string, () => Promise<unknown>>()
  const tools = new Map<string, { invoke(options: { input: unknown }, token: { isCancellationRequested: boolean }): Promise<{ content: { value: string }[] }> }>()
  const state = new Map<string, unknown>(), secrets = new Map<string, string>()
  const values: Record<string, unknown> = { 'telemetry.telemetryLevel': 'off' }
  const inputs: string[] = [], choices: string[] = [], errors: string[] = [], requests: URL[] = [], signins: string[][] = []
  const disposable = { dispose() {} }
  let promptCount = 0, gitActivations = 0
  let approve = true
  let onConfirm: (() => void) | undefined, onSignIn: (() => void) | undefined
  let response: unknown = { value: [] }
  const api: any = {
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }],
      getConfiguration(section: string) { return { get: (key: string, fallback?: unknown) => values[`${section}.${key}`] ?? fallback,
        update: async (key: string, value: unknown) => { values[`${section}.${key}`] = value } } },
      openTextDocument: async (input: unknown) => input,
    },
    env: { isTelemetryEnabled: false },
    extensions: { getExtension: () => ({ isActive: false, activate: async () => { gitActivations++; return { getAPI: () => ({ git: { path: '/usr/bin/git' } }) } } }) },
    window: {
      registerTreeDataProvider: () => disposable,
      showInputBox: async () => { promptCount++; return inputs.shift() },
      showWarningMessage: async (_message: string, _options: unknown, label: string) => { promptCount++; onConfirm?.(); return approve ? label : undefined },
      showQuickPick: async (items: any[]) => { promptCount++; const choice = choices.shift(); return choice === 'first' ? items[0] : items.find(item => typeof item === 'string' ? item === choice : item.label === choice) },
      showTextDocument: async () => {}, showInformationMessage: async () => {},
      showErrorMessage: async (message: string) => { errors.push(message) },
    },
    commands: { registerCommand: (name: string, handler: () => Promise<unknown>) => { commands.set(name, handler); return disposable },
      executeCommand: async (name: string, uri: { fsPath: string }) => { if (name === 'vscode.openFolder') api.workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: uri.fsPath } }] } },
    lm: { registerTool: (name: string, tool: any) => { tools.set(name, tool); return disposable } },
    authentication: { getSession: async (_provider: string, scopes: string[]) => { signins.push(scopes); onSignIn?.(); return { accessToken: 'private-graph-token' } } },
    Uri: { file: (path: string) => ({ fsPath: path }) }, ConfigurationTarget: { Global: 1 },
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} }, TreeItem: class {},
    LanguageModelToolResult: class { constructor(public content: unknown[]) {} }, LanguageModelTextPart: class { constructor(public value: string) {} },
  }
  const context: any = { subscriptions: [], globalStorageUri: { fsPath: join(temporary, 'storage') },
    globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value) } },
    secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value) }, delete: async (key: string) => { secrets.delete(key) } } }
  const module = { exports: {} as { activate(context: unknown): void } }
  const sandboxProcess = { ...process, env: { ...process.env } }
  runInNewContext(code, { module, exports: module.exports, require: (name: string) => name === 'vscode' ? api : requireModule(name),
    process: sandboxProcess, Buffer, structuredClone, AbortController, AbortSignal, URL, URLSearchParams, setTimeout, clearTimeout,
    fetch: async (url: URL) => { requests.push(url); return Response.json(typeof response === 'function' ? response(url) : response) } })
  const activate = () => module.exports.activate(context)
  const deactivate = () => { for (const item of context.subscriptions) item.dispose(); context.subscriptions = [] }
  activate()
  return { api, inputs, choices, errors, requests, signins, values, context, state, environment: sandboxProcess.env,
    response: (value: unknown) => { response = value },
    invoke: (name: string, input: unknown = {}, token = { isCancellationRequested: false }) => tools.get(name)!.invoke({ input }, token),
    command: (name: string) => commands.get(`superagent.${name}`)!(),
    approve: (value: boolean) => { approve = value },
    onConfirm: (callback: () => void) => { onConfirm = callback }, onSignIn: (callback: () => void) => { onSignIn = callback },
    get promptCount() { return promptCount }, get gitActivations() { return gitActivations },
    reload() { deactivate(); activate() }, close() { deactivate(); rmSync(temporary, { recursive: true, force: true }) } }
}

test('activation has no source activity; untrusted or telemetry-enabled workspaces cannot start work', async () => {
  const f = fixture()
  try {
    assert.equal(f.requests.length, 0); assert.equal(f.gitActivations, 0)
    f.api.workspace.isTrusted = false
    await f.command('new')
    await assert.rejects(f.invoke('superagent_snapshot'), /trusted workspace/)
    assert.equal(f.gitActivations, 0); assert.equal(f.promptCount, 0)
    f.api.workspace.isTrusted = true; f.api.env.isTelemetryEnabled = true
    await assert.rejects(f.invoke('superagent_snapshot'), /Disable VS Code telemetry/)
    assert.equal(f.gitActivations, 0); assert.equal(f.requests.length, 0)
  } finally { f.close() }
})

test('Copilot telemetry exporters cannot bypass disabled VS Code product telemetry', async () => {
  const f = fixture()
  try {
    f.values['github.copilot.chat.otel.enabled'] = true
    await assert.rejects(f.invoke('superagent_snapshot'), /OpenTelemetry/)
    f.values['github.copilot.chat.otel.enabled'] = false
    f.environment.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://collector.invalid'
    await assert.rejects(f.invoke('superagent_snapshot'), /OpenTelemetry/)
    assert.equal(f.gitActivations, 0); assert.equal(f.requests.length, 0)
  } finally { f.close() }
})

test('a rejected folder switch retains the prepared ticket and can be retried without reloading', async () => {
  const f = fixture()
  try {
    f.inputs.push('Approved task'); await f.command('new')
    const original = f.api.commands.executeCommand
    f.api.commands.executeCommand = async () => { throw new Error('native failure') }
    f.choices.push('first', 'Open isolated worktree'); await f.command('open')
    assert.match(f.errors.at(-1)!, /Could not open/)
    f.api.commands.executeCommand = original
    f.choices.push('first', 'Open isolated worktree'); await f.command('open'); f.reload()
    const snapshot = JSON.parse((await f.invoke('superagent_snapshot')).content[0]!.value)
    assert.equal(snapshot.messages[0].text, 'Approved task')
  } finally { f.close() }
})

test('an inbox cursor advances only after the candidate is locally decided and approved imports deduplicate', async () => {
  const f = fixture()
  try {
    f.values['superagent.teams.tenantId'] = '11111111-1111-1111-1111-111111111111'
    f.values['superagent.teams.chatIds'] = ['19:intake@thread.v2']
    const actor = '22222222-2222-2222-2222-222222222222'
    f.values['superagent.teams.allowedActors'] = [actor]
    f.response({ value: [{ id: '123', messageType: 'message', lastModifiedDateTime: new Date().toISOString(),
      from: { user: { id: actor } }, body: { contentType: 'text', content: 'External request requires approval' } }] })
    f.choices.push('Decide later'); await f.command('poll')
    assert.equal(f.state.size, 0)
    f.choices.push('Approve new ticket'); await f.command('poll')
    assert.equal(f.errors.length, 0)
    assert.equal(f.state.size, 2)
    await f.command('poll')
    f.choices.push('first', 'Open isolated worktree'); await f.command('open'); f.reload()
    const snapshot = JSON.parse((await f.invoke('superagent_snapshot')).content[0]!.value)
    assert.equal(snapshot.messages.length, 1)
    assert.equal(snapshot.messages[0].text, 'External request requires approval')
  } finally { f.close() }
})

test('source allowlist changes during final follow-up consent prevent importing that message', async () => {
  const f = fixture()
  try {
    f.inputs.push('Local approved task'); await f.command('new')
    const actor = '22222222-2222-2222-2222-222222222222'
    f.values['superagent.teams.tenantId'] = '11111111-1111-1111-1111-111111111111'
    f.values['superagent.teams.chatIds'] = ['19:intake@thread.v2']
    f.values['superagent.teams.allowedActors'] = [actor]
    f.response({ value: [{ id: '123', messageType: 'message', lastModifiedDateTime: new Date().toISOString(),
      from: { user: { id: actor } }, body: { contentType: 'text', content: 'Remote follow-up' } }] })
    let confirmations = 0
    f.onConfirm(() => { if (++confirmations === 2) f.values['superagent.teams.allowedActors'] = [] })
    f.choices.push('Approve follow-up to a ticket', 'first'); await f.command('poll')
    assert.match(f.errors.at(-1)!, /configuration changed/)
    f.onConfirm(() => {})
    f.choices.push('first', 'Open isolated worktree'); await f.command('open'); f.reload()
    const snapshot = JSON.parse((await f.invoke('superagent_snapshot')).content[0]!.value)
    assert.equal(snapshot.messages.length, 1)
    assert.equal(snapshot.messages[0].text, 'Local approved task')
  } finally { f.close() }
})

test('a ticket survives switching to its worktree, supplies only approved inputs and requires report consent', async () => {
  const f = fixture()
  try {
    f.inputs.push('Fix the approved issue'); await f.command('new')
    assert.deepEqual(f.errors, [])
    f.choices.push('first', 'Open isolated worktree'); await f.command('open')
    assert.deepEqual(f.errors, [])
    f.reload()
    const snapshot = JSON.parse((await f.invoke('superagent_snapshot')).content[0]!.value)
    assert.equal(snapshot.messages[0].text, 'Fix the approved issue')
    assert.equal(snapshot.ticket.assignments.at(-1).report.state, 'progress')
    f.approve(false)
    await assert.rejects(f.invoke('superagent_report', { state: 'ready', summary: 'Tests pass; ready for review.' }), /declined/)
    f.approve(true)
    const result = await f.invoke('superagent_report', { state: 'ready', summary: 'Tests pass; ready for review.' })
    assert.equal(JSON.parse(result.content[0]!.value).ended.outcome, 'completed')
    await assert.rejects(f.invoke('superagent_snapshot'), /ended/)
    assert.equal(f.requests.length, 0)
  } finally { f.close() }
})

test('cancellation after native consent prevents beginning ticket execution', async () => {
  const f = fixture()
  try {
    f.inputs.push('Approved task'); await f.command('new')
    f.choices.push('first', 'Open isolated worktree'); await f.command('open'); f.reload()
    const token = { isCancellationRequested: false }
    f.onConfirm(() => { token.isCancellationRequested = true })
    await assert.rejects(f.invoke('superagent_snapshot', {}, token), /cancelled/)
  } finally { f.close() }
})

test('continuing a ready PR ticket requires consent and clears its ready status', async () => {
  const f = fixture()
  try {
    f.values['superagent.github.origin'] = 'https://api.github.com'
    f.values['superagent.github.repository'] = 'approved/repository'
    f.inputs.push('Approved task'); await f.command('new')
    f.choices.push('first', 'Open isolated worktree'); await f.command('open'); f.reload()
    await f.invoke('superagent_snapshot')
    await f.invoke('superagent_report', { state: 'ready', summary: 'Ready for review', pullRequest: 42 })
    f.approve(false)
    await assert.rejects(f.invoke('superagent_snapshot'), /not started|declined/i)
    f.approve(true)
    const snapshot = JSON.parse((await f.invoke('superagent_snapshot')).content[0]!.value)
    assert.equal(snapshot.ticket.assignments.at(-1).report.state, 'progress')
  } finally { f.close() }
})

test('Teams uses tenant-pinned least-privilege native sign-in and configuration changes prevent token dispatch', async () => {
  const f = fixture()
  try {
    const tenant = '11111111-1111-1111-1111-111111111111'
    f.values['superagent.teams.tenantId'] = tenant
    f.values['superagent.teams.chatIds'] = ['19:approved@thread.v2']
    f.values['superagent.teams.allowedActors'] = ['22222222-2222-2222-2222-222222222222']
    await f.command('poll')
    assert.equal(f.errors.length, 0)
    assert.deepEqual([...f.signins[0]!], [`VSCODE_TENANT:${tenant}`, 'https://graph.microsoft.com/Chat.Read'])
    assert.equal(f.requests[0]!.origin, 'https://graph.microsoft.com')
    const before = f.requests.length
    f.onSignIn(() => { f.values['superagent.teams.tenantId'] = '33333333-3333-3333-3333-333333333333' })
    await f.command('poll')
    assert.match(f.errors.at(-1)!, /configuration changed/)
    assert.equal(f.requests.length, before)
    assert.ok(f.errors.every(message => !message.includes('private-graph-token')))
  } finally { f.close() }
})

test('a failing channel does not block a GitHub candidate or its independent cursor', async () => {
  const f = fixture()
  try {
    f.values['superagent.github.origin'] = 'https://api.github.com'
    f.values['superagent.github.repository'] = 'approved/repository'
    f.values['superagent.github.account'] = 'agent'
    f.values['superagent.github.allowedActors'] = ['alice']
    f.values['superagent.teams.tenantId'] = '11111111-1111-1111-1111-111111111111'
    f.values['superagent.teams.channels'] = [{ teamId: '33333333-3333-3333-3333-333333333333', channelId: '19:channel@thread.tacv2' }]
    f.values['superagent.teams.allowedActors'] = ['22222222-2222-2222-2222-222222222222']
    f.inputs.push('fake-token'); await f.command('secrets')
    f.response((url: URL) => url.hostname === 'graph.microsoft.com' ? { invalid: true }
      : url.pathname.endsWith('/issues') ? [{ id: 1, number: 1, title: 'Task', body: '@agent fix it', updated_at: new Date().toISOString(), user: { login: 'alice', type: 'User' } }] : [])
    f.choices.push('Approve new ticket'); await f.command('poll')
    assert.match(f.errors.at(-1)!, /channel.*Invalid source response/)
    f.choices.push('first', 'Open isolated worktree'); await f.command('open'); f.reload()
    const snapshot = JSON.parse((await f.invoke('superagent_snapshot')).content[0]!.value)
    assert.match(snapshot.messages[0].text, /@agent fix it/)
  } finally { f.close() }
})

test('inbox discovers and deduplicates an edited review on an unchanged old PR', async () => {
  const f = fixture()
  try {
    f.values['superagent.github.origin'] = 'https://api.github.com'
    f.values['superagent.github.repository'] = 'approved/repository'
    f.values['superagent.github.account'] = 'agent'
    f.values['superagent.github.allowedActors'] = ['alice']
    f.inputs.push('fake-token'); await f.command('secrets')
    let body = 'No request here'
    f.response((url: URL) => {
      if (url.pathname.endsWith('/pulls')) return [{ number: 7, updated_at: '2020-01-01T00:00:00Z' }]
      if (url.pathname.endsWith('/7/reviews')) return [{ id: 88, submitted_at: '2020-01-01T00:00:00Z', body, user: { login: 'alice', type: 'User' } }]
      return []
    })
    await f.command('poll')
    assert.equal(f.errors.length, 0)
    body = '@agent edited request on an old review'
    f.choices.push('Approve new ticket'); await f.command('poll')
    assert.equal(f.errors.length, 0)
    f.reload()
    await f.command('poll')
    f.choices.push('first', 'Open isolated worktree'); await f.command('open'); f.reload()
    const snapshot = JSON.parse((await f.invoke('superagent_snapshot')).content[0]!.value)
    assert.equal(snapshot.messages.length, 1)
    assert.equal(snapshot.messages[0].text, body)
  } finally { f.close() }
})

test('review discovery resumes after reload and defers its checkpoint until a decision', async () => {
  const f = fixture()
  try {
    f.values['superagent.github.origin'] = 'https://api.github.com'
    f.values['superagent.github.repository'] = 'approved/repository'
    f.values['superagent.github.account'] = 'agent'
    f.values['superagent.github.allowedActors'] = ['alice']
    f.inputs.push('fake-token'); await f.command('secrets')
    f.response((url: URL) => {
      if (url.pathname.endsWith('/pulls')) return Number(url.searchParams.get('page')) === 1
        ? Array.from({ length: 25 }, (_, i) => ({ number: i + 1 })) : [{ number: 26 }]
      if (url.pathname.endsWith('/26/reviews')) return [{ id: 88, body: '@agent edited old review', user: { login: 'alice', type: 'User' } }]
      return []
    })
    await f.command('poll')
    f.reload()
    f.choices.push('Decide later'); await f.command('poll')
    f.reload()
    f.choices.push('Approve new ticket'); await f.command('poll')
    assert.deepEqual(f.errors, [])
    f.choices.push('first', 'Open isolated worktree'); await f.command('open'); f.reload()
    const snapshot = JSON.parse((await f.invoke('superagent_snapshot')).content[0]!.value)
    assert.equal(snapshot.messages[0].text, '@agent edited old review')
  } finally { f.close() }
})

test('channel scan resumes after reload without losing an old root with a new reply', async () => {
  const f = fixture()
  try {
    const actor = '22222222-2222-2222-2222-222222222222'
    f.values['superagent.teams.tenantId'] = '11111111-1111-1111-1111-111111111111'
    f.values['superagent.teams.channels'] = [{ teamId: '33333333-3333-3333-3333-333333333333', channelId: '19:channel@thread.tacv2' }]
    f.values['superagent.teams.allowedActors'] = [actor]
    const old = '2020-01-01T00:00:00Z'
    const message = (id: string, at: string) => ({ id, messageType: 'message', lastModifiedDateTime: at, from: { user: { id: actor } }, body: { contentType: 'text', content: 'Approved reply' } })
    f.response((url: URL) => ({ value: url.pathname.endsWith('/26/replies') ? [message('1000', new Date().toISOString())]
      : url.pathname.endsWith('/replies') ? [] : Array.from({ length: 26 }, (_, i) => message(String(i + 1), old)) }))
    await f.command('poll')
    assert.equal(f.errors.length, 0)
    f.reload()
    f.choices.push('Approve new ticket'); await f.command('poll')
    assert.equal(f.errors.length, 0)
    f.choices.push('first', 'Open isolated worktree'); await f.command('open'); f.reload()
    const snapshot = JSON.parse((await f.invoke('superagent_snapshot')).content[0]!.value)
    assert.equal(snapshot.messages[0].text, 'Approved reply')
  } finally { f.close() }
})

test('GitHub source changes during SecretStorage retrieval and credential removal never dispatch the old token', async () => {
  const f = fixture()
  try {
    f.values['superagent.github.origin'] = 'https://api.github.com'
    f.values['superagent.github.repository'] = 'approved/repository'
    f.values['superagent.github.account'] = 'agent'
    f.values['superagent.github.allowedActors'] = ['alice']
    f.inputs.push('fake-test-read-token'); await f.command('secrets')
    const get = f.context.secrets.get
    f.context.secrets.get = async (key: string) => {
      const value = await get(key)
      f.values['superagent.github.origin'] = 'https://changed.example/api/v3'
      return value
    }
    await f.command('poll')
    assert.match(f.errors.at(-1)!, /configuration changed/)
    assert.equal(f.requests.length, 0)
    f.context.secrets.get = get
    f.values['superagent.github.origin'] = 'https://api.github.com'
    f.inputs.push(''); await f.command('secrets')
    await f.command('poll')
    assert.match(f.errors.at(-1)!, /Configure a GitHub read credential/)
    assert.equal(f.requests.length, 0)
    assert.ok(f.errors.every(message => !message.includes('fake-test-read-token')))
  } finally { f.close() }
})
