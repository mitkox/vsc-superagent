import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { TicketRuntime } from '../src/runtime.ts'
import { githubThreadRef, sourceTrigger } from '../src/sources.ts'
import type { SourceContext } from '../src/sources.ts'
import type { AutomationSettings } from '../src/settings.ts'
import type { PanelHost } from '../src/panel.ts'
import type { AgentRun } from '../src/agent-backend.ts'
import type { AssessmentOutcome } from '../../src/core/index.ts'
import type { PermissionRequest } from '@github/copilot-sdk'
import type { CopilotBackendOptions } from '../src/copilot.ts'

const requireModule = createRequire(import.meta.url)
const code = buildSync({
  entryPoints: ['src/automation-host.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false,
  external: ['vscode', './copilot.ts', './panel.ts'],
}).outputFiles[0]!.text
const tenant = '11111111-1111-1111-1111-111111111111'
const nativeActor = '22222222-2222-2222-2222-222222222222'
const savedActor = '33333333-3333-3333-3333-333333333333'
const bot = '44444444-4444-4444-4444-444444444444'
const account = '55555555-5555-5555-5555-555555555555'
const chat = '19:approved@thread.v2'
const channel = { teamId: '66666666-6666-6666-6666-666666666666', channelId: '19:channel@thread.tacv2' }
interface HostWarning { message: string; detail: string; choices: string[]; permissionMode: unknown }
const head = 'a'.repeat(40)
const githubIssue = (id: number, login: string, type = 'User', body = 'Repair the defect') => ({ id, number: id, title: 'Bug', body,
  user: { login, type }, updated_at: new Date().toISOString() })
const teamsMessage = (id: string, actor: string, application = false) => ({ id, messageType: 'message',
  from: application ? { application: { id: actor } } : { user: { id: actor, tenantId: tenant } },
  body: { contentType: 'text', content: 'Repair the defect' }, createdDateTime: new Date().toISOString() })

function fixture(initial: Record<string, unknown> = {}, storageDirectory?: string) {
  const directory = storageDirectory ?? mkdtempSync(join(tmpdir(), 'superagent-host-'))
  const runtime = new TicketRuntime(directory)
  const values: Record<string, unknown> = { ...initial }
  const commands = new Map<string, () => Promise<unknown>>()
  const requests: { url: URL; authorization: string | null; method: string; body?: string }[] = [], signins: string[][] = []
  const errors: string[] = [], warningChoices: (string | undefined)[] = []
  const warnings: HostWarning[] = []
  let warning: ((entry: HostWarning) => string | undefined | Promise<string | undefined>) | undefined
  let assessor: ((prompt: string) => AssessmentOutcome | Promise<AssessmentOutcome>) | undefined
  let panel!: PanelHost, signIn: (() => void | Promise<void>) | undefined, githubCredential: (() => void | Promise<void>) | undefined, response: (url: URL, init?: RequestInit) => unknown = () => []
  let credentials = 0, worker: ((request: AgentRun) => Promise<void>) | undefined
  const runs: AgentRun[] = [], aborts: string[] = [], prepares: string[] = []
  let permission: CopilotBackendOptions['onPermissionRequest'] | undefined, preparation: ((ticketId: string) => Promise<void>) | undefined
  const configurationListeners = new Set<(event: { affectsConfiguration(section: string): boolean }) => void>()
  const fireConfiguration = (...keys: string[]) => {
    const changed = keys.map(key => key.startsWith('superagent.') ? key : `superagent.${key}`)
    const event = { affectsConfiguration: (section: string) => changed.some(key => key === section || key.startsWith(section + '.') || section.startsWith(key + '.')) }
    for (const listener of configurationListeners) listener(event)
  }
  const disposable = { dispose() {} }
  const api = {
    workspace: { getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => values[key] ?? fallback,
      update: async (key: string, value: unknown) => { values[key] = value; queueMicrotask(() => fireConfiguration(key)) },
    }), onDidChangeConfiguration: (listener: (event: { affectsConfiguration(section: string): boolean }) => void) => {
      configurationListeners.add(listener); return { dispose: () => { configurationListeners.delete(listener) } }
    } },
    authentication: { getSession: async (_provider: string, scopes: string[]) => {
      signins.push(scopes); await signIn?.(); return { accessToken: 'graph-credential' }
    } },
    commands: { registerCommand: (name: string, callback: () => Promise<unknown>) => { commands.set(name, callback); return disposable } },
    window: { showErrorMessage: async (error: string) => { errors.push(error) },
      showWarningMessage: async (message: string, options: unknown, first: string, ...others: string[]) => {
        const entry = { message, detail: (options as { detail?: string })?.detail ?? '', choices: [first, ...others], permissionMode: values['execution.permissionMode'] }
        warnings.push(entry)
        return warning ? warning(entry) : warningChoices.length ? warningChoices.shift() : first
      } },
    lm: { registerTool: () => disposable },
    Uri: { joinPath: (_uri: unknown, ...parts: string[]) => ({ fsPath: join(directory, ...parts) }) },
    ConfigurationTarget: { Global: 1 },
  }
  const module = { exports: {} as { activateAutomation(context: unknown, hooks: unknown): { shutdown(): Promise<void> } } }
  runInNewContext(code, {
    module, exports: module.exports, require: (name: string) => name === 'vscode' ? api : name === './copilot.ts' ? {
      CopilotBackend: class { constructor(options: CopilotBackendOptions) { permission = options.onPermissionRequest }
        async check() { return { authenticated: true } } async abort(ticketId: string) { aborts.push(ticketId) } async dispose() {} async assess(prompt: string) { return assessor ? assessor(prompt) : { kind: 'ignore', reason: 'No stop or new task' } }
        async run(request: AgentRun) { runs.push(request); if (worker) await worker(request); else await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'waiting', summary: 'Waiting for a native input' }) } },
    } : name === './panel.ts' ? { SuperagentPanel: class {
      constructor(host: PanelHost) { panel = host }
      show() {} refresh() {} dispose() {}
    } } : requireModule(name),
    process, Buffer, structuredClone, AbortController, AbortSignal, URL, URLSearchParams, setTimeout, clearTimeout, queueMicrotask,
    fetch: async (input: URL, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push({ url, authorization: new Headers(init?.headers).get('authorization'), method: init?.method ?? 'GET', ...(init?.body ? { body: String(init.body) } : {}) })
      if (url.origin === 'https://graph.microsoft.com' && url.pathname === '/v1.0/me') return Response.json({ id: account })
      if (url.pathname === '/repos/company/project') return Response.json({ default_branch: 'main' })
      if (url.pathname.endsWith('/branches/main')) return Response.json({ commit: { sha: head } })
      if (url.pathname.endsWith('/check-runs')) return Response.json({ check_runs: [] })
      const result = await response(url, init)
      return result instanceof Response ? result : Response.json(result)
    },
  })
  const subscriptions: { dispose(): unknown }[] = []
  const prepare = async (ticketId: string) => { prepares.push(ticketId); await preparation?.(ticketId); return directory }
  const lifecycle = module.exports.activateAutomation({ subscriptions, extensionUri: {} }, {
    host: async () => ({ runtime, root: directory, identity: 'local-test', trees: { prepare, validate: prepare } }),
    guard: () => 'local-test', changed() {}, github: async () => {
      credentials++; await githubCredential?.()
      return { origin: values['github.origin'] ?? 'https://api.github.com', repository: values['github.repository'], account: 'agent',
        allowedActors: values['github.allowedActors'] ?? [], token: `github-credential-${credentials}` }
    },
  })
  const snapshot = () => panel.snapshot() as { settings: { revision: number; value: AutomationSettings } }
  return { directory, runtime, values, requests, signins, errors, warnings, runs, aborts, prepares, snapshot, fireConfiguration,
    permission: (request: AgentRun, input: PermissionRequest) => {
      assert.ok(permission, 'The actual native Copilot permission callback must be registered')
      return permission(input, { sessionId: request.sessionId, ticketId: request.ticketId, rootSessionId: request.sessionId, directory: request.directory, signal: request.signal })
    },
    onPrepare: (handler: (ticketId: string) => Promise<void>) => { preparation = handler },
    chooseWarnings: (...choices: (string | undefined)[]) => { warningChoices.push(...choices) },
    onWarning: (handler?: (entry: HostWarning) => string | undefined | Promise<string | undefined>) => { warning = handler },
    onAssessment: (handler: (prompt: string) => AssessmentOutcome | Promise<AssessmentOutcome>) => { assessor = handler },
    onWorker: (handler: (request: AgentRun) => Promise<void>) => { worker = handler }, get credentials() { return credentials },
    initialize: () => commands.get('superagent.dashboard')!(),
    start: () => commands.get('superagent.startService')!(),
    stop: () => panel.action({ action: 'stopService' }),
    save: (value: unknown) => panel.action({ action: 'saveSettings', revision: snapshot().settings.revision, value }),
    restore: (revision: number) => panel.action({ action: 'restoreSettings', revision, baseRevision: snapshot().settings.revision }),
    poll: () => panel.action({ action: 'poll' }),
    unsubscribe: (id: string) => panel.action({ action: 'unsubscribe', id }),
    respond: (handler: (url: URL, init?: RequestInit) => unknown) => { response = handler },
    onSignIn: (handler: () => void | Promise<void>) => { signIn = handler },
    onGitHubCredential: (handler: () => void | Promise<void>) => { githubCredential = handler },
    close: async (preserveStorage = false) => { await lifecycle.shutdown(); for (const subscription of subscriptions) subscription.dispose(); runtime.dispose(); if (!preserveStorage) rmSync(directory, { recursive: true, force: true }) },
  }
}

test('dashboard GitHub policy controls real polling before the first poll and native revocation still applies', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': ['native'], 'github.observe': false })
  try {
    await f.initialize()
    await f.save({ enabled: true, sources: { github: { allowedActors: ['saved'], allowedBots: ['checks[bot]'], allowUnaddressed: true } } })
    f.respond(url => url.pathname === '/repos/company/project/issues' ? [githubIssue(1, 'saved'), githubIssue(2, 'checks[bot]', 'Bot'), githubIssue(3, 'native')] : [])
    await f.poll()
    const triggers = f.runtime.repositories.snapshot().triggers
    assert.equal(triggers.filter(trigger => trigger.actor.id === 'saved').length, 1)
    assert.equal(triggers.filter(trigger => trigger.actor.id === 'checks[bot]').length, 1)
    assert.equal(triggers.filter(trigger => trigger.actor.id === 'native').length, 0)
    assert.deepEqual(f.values['github.allowedActors'], ['native'])
    assert.equal(f.values['github.observe'], false)
    assert.ok(f.requests.every(request => request.url.origin === 'https://api.github.com' && request.url.pathname.startsWith('/repos/company/project')))
    assert.ok(f.requests.every(request => request.authorization === 'Bearer github-credential-1'))

    f.values['github.allowedActors'] = []
    f.respond(url => url.pathname.endsWith('/issues') ? [githubIssue(4, 'saved', 'User', '@agent repair')] : [])
    await f.poll()
    assert.equal(f.runtime.repositories.snapshot().triggers.some(trigger => trigger.text.includes('@agent repair')), false)
    assert.deepEqual(f.snapshot().settings.value.sources.github.allowedActors, [])
    assert.equal(f.snapshot().settings.value.sources.github.allowUnaddressed, false)
    assert.equal(f.credentials, 2)

    await f.save({ sources: { github: { enabled: false } } })
    const reads = f.requests.length
    await f.poll()
    assert.equal(f.requests.length, reads)
  } finally { await f.close() }
})

test('explicit service restart keeps saved policy while reconciling native source changes', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': ['native'], 'github.observe': false })
  try {
    await f.initialize()
    await f.save({ sources: { github: { allowedActors: ['saved'], allowUnaddressed: true } } })
    await f.start()
    assert.deepEqual(f.errors, [])
    assert.equal(f.snapshot().settings.value.enabled, true)
    assert.deepEqual(f.snapshot().settings.value.sources.github.allowedActors, ['saved'])
    assert.equal(f.snapshot().settings.value.sources.github.allowUnaddressed, true)
    f.values['github.allowedActors'] = []
    await f.start()
    assert.deepEqual(f.snapshot().settings.value.sources.github.allowedActors, [])
    assert.equal(f.snapshot().settings.value.sources.github.allowUnaddressed, false)
  } finally { await f.close() }
})

test('dashboard Teams actors and bots reach actual polling only inside native tenant and conversation scopes', async () => {
  const f = fixture({ 'teams.tenantId': tenant, 'teams.chatIds': [chat], 'teams.channels': [channel], 'teams.allowedActors': [nativeActor] })
  try {
    await f.initialize()
    await f.save({ enabled: true, sources: { teams: { allowedActors: [savedActor], allowedBots: [bot], allowUnaddressed: true } } })
    f.respond(url => ({ value: url.pathname.endsWith('/messages') ? [teamsMessage('1', savedActor), teamsMessage('2', bot, true), teamsMessage('3', nativeActor)] : [] }))
    await f.poll()
    const triggers = f.runtime.repositories.snapshot().triggers
    assert.equal(triggers.filter(trigger => trigger.actor.id === savedActor).length, 2)
    assert.equal(triggers.filter(trigger => trigger.actor.id === bot).length, 2)
    assert.equal(triggers.filter(trigger => trigger.actor.id === nativeActor).length, 0)
    assert.ok(triggers.filter(trigger => trigger.actor.id === bot).every(trigger => !trigger.human))
    assert.deepEqual(f.values['teams.allowedActors'], [nativeActor])
    assert.ok(f.signins[0]!.includes(`VSCODE_TENANT:${tenant}`))
    assert.ok(f.requests.every(request => request.url.origin === 'https://graph.microsoft.com' && request.authorization === 'Bearer graph-credential'))
    const paths = f.requests.map(request => request.url.pathname)
    assert.ok(paths.includes(`/v1.0/chats/${encodeURIComponent(chat)}/messages`))
    assert.ok(paths.includes(`/v1.0/teams/${channel.teamId}/channels/${encodeURIComponent(channel.channelId)}/messages`))
    assert.ok(paths.every(path => path === '/v1.0/me' || path.startsWith(`/v1.0/chats/${encodeURIComponent(chat)}/messages`)
      || path.startsWith(`/v1.0/teams/${channel.teamId}/channels/${encodeURIComponent(channel.channelId)}/messages`)))

    await f.save({ sources: { teams: { enabled: false } } })
    const reads = f.requests.length
    await f.poll()
    assert.equal(f.requests.length, reads)
  } finally { await f.close() }
})

test('Teams membership synchronization updates the current poll and preserves other saved source settings', async () => {
  const f = fixture({ 'teams.tenantId': tenant, 'teams.chatIds': [chat], 'teams.allowedActors': [nativeActor],
    'teams.syncMembership': true, 'teams.syncChatId': chat })
  try {
    await f.initialize()
    await f.save({ enabled: true, sources: { teams: { allowedBots: [bot] } } })
    f.respond(url => ({ value: url.pathname.endsWith('/members')
      ? [{ '@odata.type': '#microsoft.graph.aadUserConversationMember', userId: savedActor, tenantId: tenant }]
      : [teamsMessage('1', savedActor), teamsMessage('2', bot, true)] }))
    await f.poll()
    assert.deepEqual(Array.from(f.values['teams.allowedActors'] as string[]), [savedActor])
    assert.deepEqual(f.snapshot().settings.value.sources.teams.allowedActors, [savedActor])
    assert.deepEqual(f.snapshot().settings.value.sources.teams.allowedBots, [bot])
    assert.equal(f.runtime.repositories.snapshot().triggers.filter(trigger => trigger.actor.id === savedActor).length, 1)
    assert.equal(f.runtime.repositories.snapshot().triggers.filter(trigger => trigger.actor.id === bot).length, 1)
    assert.ok(f.signins[0]!.includes('https://graph.microsoft.com/ChatMember.Read'))
  } finally { await f.close() }
})

test('native Teams tenant changes during credential refresh still prevent message polling', async () => {
  const f = fixture({ 'teams.tenantId': tenant, 'teams.chatIds': [chat], 'teams.allowedActors': [nativeActor] })
  try {
    await f.initialize()
    await f.save({ enabled: true, sources: { teams: { allowedActors: [savedActor] } } })
    f.onSignIn(() => { f.values['teams.tenantId'] = account })
    await assert.rejects(f.poll(), /Teams source failed/)
    assert.equal(f.requests.length, 0)
  } finally { await f.close() }
})

test('dashboard explicit unlisted admission reaches every GitHub collection path with an empty allowlist', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [], 'github.observe': false })
  try {
    await f.initialize()
    await f.save({ enabled: true, acceptMode: 'off', sources: { github: { admission: { unlistedAddressed: 'explicit' } } } })
    f.respond(url => {
      const updated_at = new Date().toISOString(), user = { login: 'outsider', type: 'User' }, body = '@agent repair this defect'
      if (url.pathname.endsWith('/issues')) return [githubIssue(1, 'outsider', 'User', body)]
      if (url.pathname.endsWith('/issues/comments')) return [{ id: 2, user, body, updated_at, issue_url: 'https://api.github.com/repos/company/project/issues/1' }]
      if (url.pathname.endsWith('/pulls/comments')) return [{ id: 3, user, body, updated_at, path: 'src/a.ts', line: 8, commit_id: head,
        pull_request_url: 'https://api.github.com/repos/company/project/pulls/7' }]
      if (url.pathname.endsWith('/pulls/7/reviews')) return [{ id: 4, user, body, submitted_at: updated_at, state: 'COMMENTED', commit_id: head }]
      if (url.pathname.endsWith('/pulls')) return [{ number: 7 }]
      return []
    })
    await f.poll()
    const triggers = f.runtime.repositories.snapshot().triggers.filter(trigger => trigger.actor.id === 'outsider')
    assert.equal(triggers.length, 4)
    assert.ok(triggers.every(trigger => trigger.human && trigger.addressed === 'mention'))
    assert.deepEqual(triggers.map(trigger => (trigger.meta.provider as { kind: string }).kind).sort(), ['comment', 'issue', 'review', 'review-comment'])
    assert.deepEqual(f.snapshot().settings.value.sources.github.allowedActors, [])
  } finally { await f.close() }
})

test('dashboard explicit unlisted Teams mentions reach polling with an empty allowlist and observation disabled', async () => {
  const f = fixture({ 'teams.tenantId': tenant, 'teams.chatIds': [chat], 'teams.allowedActors': [] })
  try {
    await f.initialize()
    await f.save({ enabled: true, acceptMode: 'off', sources: { teams: { allowUnaddressed: false, admission: { unlistedAddressed: 'explicit' } } } })
    const mentions = [{ mentioned: { user: { id: account } } }]
    f.respond(() => ({ value: [{ ...teamsMessage('1', savedActor), mentions }, teamsMessage('2', savedActor),
      { ...teamsMessage('3', bot, true), mentions }] }))
    await f.poll()
    const triggers = f.runtime.repositories.snapshot().triggers
    assert.equal(triggers.length, 1)
    assert.equal(triggers[0]?.actor.id, savedActor)
    assert.equal(triggers[0]?.human, true)
    assert.equal(triggers[0]?.addressed, 'mention')
    assert.deepEqual(f.snapshot().settings.value.sources.teams.allowedActors, [])
  } finally { await f.close() }
})

test('automatic polling skips candidate reads when empty source policies authorize no intake', async () => {
  const cases = [
    { name: 'default empty lists', mode: 'observe', observed: false },
    { name: 'inferred addressed override while off', mode: 'off', observed: false, admission: { unlistedAddressed: 'inferred' } },
    { name: 'inferred unaddressed override while off', mode: 'off', observed: true, admission: { unlistedUnaddressed: 'inferred' } },
    { name: 'inferred unaddressed override without observation', mode: 'observe', observed: false, admission: { unlistedUnaddressed: 'inferred' } },
    { name: 'ignored unlisted cells despite observation', mode: 'observe', observed: true, admission: { unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore' } },
  ]
  for (const scenario of cases) {
    const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [], 'teams.tenantId': tenant,
      'teams.chatIds': [chat], 'teams.allowedActors': [] })
    try {
      await f.initialize()
      const source = { allowUnaddressed: scenario.observed, ...(scenario.admission ? { admission: scenario.admission } : {}) }
      await f.save({ enabled: true, acceptMode: scenario.mode, sources: { github: source, teams: source } })
      f.respond(url => url.origin === 'https://graph.microsoft.com' ? { value: [] } : [])
      await f.poll()
      const candidates = f.requests.filter(({ url }) => /\/issues(?:\/comments)?$|\/pulls\/(?:comments|\d+\/reviews)$|\/messages(?:\/|$)/.test(url.pathname)
        || url.pathname.endsWith('/pulls') && url.searchParams.get('per_page') === '25')
      assert.equal(candidates.length, 0, scenario.name)
      assert.equal(f.requests.filter(({ url }) => url.pathname.endsWith('/pulls')).length, 0, `${scenario.name}: no tickets need PR discovery`)
      assert.ok(f.requests.some(({ url }) => url.pathname === '/v1.0/me'), `${scenario.name}: native identity refresh remains active`)
    } finally { await f.close() }
  }
})

test('automatic polling enables viable inferred overrides with empty source lists', async () => {
  for (const family of ['github', 'teams'] as const) for (const mode of ['observe', 'auto'] as const) for (const addressed of [false, true]) {
    const f = fixture(family === 'github' ? { 'github.repository': 'company/project', 'github.allowedActors': [] }
      : { 'teams.tenantId': tenant, 'teams.chatIds': [chat], 'teams.allowedActors': [] })
    try {
      await f.initialize()
      await f.save({ enabled: true, acceptMode: mode, sources: { [family]: { allowUnaddressed: !addressed,
        admission: addressed ? { unlistedAddressed: 'inferred' } : { unlistedUnaddressed: 'inferred' } } } })
      f.respond(url => family === 'github' ? url.pathname.endsWith('/issues') ? [githubIssue(1, 'outsider', 'User', addressed ? '@agent repair' : 'Repair')] : []
        : { value: [{ ...teamsMessage('1', savedActor), ...(addressed ? { mentions: [{ mentioned: { user: { id: account } } }] } : {}) }] })
      await f.poll()
      assert.equal(f.runtime.repositories.snapshot().triggers.filter(trigger => trigger.actor.id === (family === 'github' ? 'outsider' : savedActor)).length, 1,
        `${family}: ${mode}, addressed=${addressed}`)
    } finally { await f.close() }
  }
})

test('empty default admission preserves automatic collection for subscribed GitHub context', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [], 'github.observe': false })
  try {
    await f.initialize()
    await f.save({ enabled: true })
    const ticket = f.runtime.create('Track the existing pull request')
    f.runtime.engine.bindThread(ticket.id, githubThreadRef({ origin: 'https://api.github.com', repository: 'company/project',
      account: 'agent', allowedActors: [], token: 'native-test-credential' }, 7), true)
    f.respond(url => url.pathname.endsWith('/issues') ? [githubIssue(7, 'outsider', 'User', 'Unmentioned context')]
      : url.pathname.endsWith('/pulls/7') ? { number: 7, state: 'open', merged: false, head: { sha: head } } : [])
    await f.poll()
    const trigger = f.runtime.repositories.snapshot().triggers.find(trigger => trigger.actor.id === 'outsider')
    assert.ok(trigger)
    assert.equal((trigger.meta.provider as { subscribed: boolean }).subscribed, true)
    assert.equal(trigger.addressed, undefined)
    assert.ok(f.requests.some(({ url }) => url.pathname.endsWith('/issues')))
  } finally { await f.close() }
})

const repositoryConfig = { origin: 'https://api.github.com', repository: 'company/project', account: 'agent', allowedActors: [], token: 'native-test-credential' }
const pull = (number: number, closed = false, merged = false) => ({ number, state: closed ? 'closed' : 'open', merged,
  head: { sha: String(number % 10).repeat(40) }, closed_at: closed ? new Date().toISOString() : null,
  ...(merged ? { merged_at: new Date().toISOString() } : {}) })
function followPull(runtime: TicketRuntime, number: number) {
  const ticket = runtime.create(`Track PR #${number}`)
  runtime.engine.bindThread(ticket.id, githubThreadRef(repositoryConfig, number), true)
  return ticket
}

test('failed discovery still delivers known-PR checks and merged lifecycle facts', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [] })
  try {
    await f.initialize(); await f.save({ enabled: true })
    const known = followPull(f.runtime, 7)
    f.runtime.create('Repair whose PR association is not known yet')
    f.respond(url => {
      if (url.searchParams.has('head') || url.pathname.endsWith('/pulls') && url.searchParams.get('per_page') === '100') throw new Error('Discovery unavailable')
      if (url.pathname.endsWith('/pulls/7')) return pull(7, true, true)
      if (url.pathname.endsWith('/statuses')) return [{ id: 1, state: 'success', context: 'build' }]
      return []
    })
    await assert.rejects(f.poll(), /PR discovery|GitHub source failed/)
    assert.ok(f.runtime.repositories.snapshot().triggers.some(trigger => (trigger.meta.provider as { kind?: string } | undefined)?.kind === 'checks'))
    assert.equal(f.runtime.get(known.id).follows?.[0]?.closed?.outcome, 'merged')
    assert.match(f.runtime.repositories.automation().health.at(-1)!.error, /PR discovery/)
  } finally { await f.close() }
})

test('one known PR failure does not suppress its independent lifecycle or another PR', async () => {
  for (const failure of ['checks', 'lifecycle']) {
    const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [] })
    try {
      await f.initialize(); await f.save({ enabled: true })
      const first = followPull(f.runtime, 7), second = followPull(f.runtime, 8)
      let firstReads = 0
      f.respond(url => {
        if (url.pathname.endsWith('/pulls/7')) {
          if (++firstReads === 2 && failure === 'lifecycle') throw new Error('Lifecycle unavailable')
          return pull(7, true, true)
        }
        if (url.pathname.endsWith('/pulls/8')) return pull(8, true)
        if (url.pathname.endsWith(`/commits/${'7'.repeat(40)}/statuses`) && failure === 'checks') throw new Error('Checks unavailable')
        if (url.pathname.endsWith('/statuses')) return [{ id: 1, state: 'success', context: 'build' }]
        return []
      })
      await assert.rejects(f.poll(), failure === 'checks' ? /PR #7 CI/ : /PR #7 lifecycle/)
      assert.equal(firstReads, 2)
      if (failure === 'checks') assert.equal(f.runtime.get(first.id).follows?.[0]?.closed?.outcome, 'merged')
      assert.equal(f.runtime.get(second.id).follows?.[0]?.closed?.outcome, 'closed')
      assert.ok(f.runtime.repositories.snapshot().triggers.some(trigger => (trigger.meta.provider as { kind?: string; number?: number } | undefined)?.kind === 'checks'
        && (trigger.meta.provider as { number: number }).number === 8))
    } finally { await f.close() }
  }
})

test('failed intake preserves healthy review progress and known-PR monitoring', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [] })
  try {
    await f.initialize(); await f.save({ enabled: true })
    const known = followPull(f.runtime, 7)
    f.respond(url => {
      if (url.pathname.endsWith('/issues')) throw new Error('Intake unavailable')
      if (url.pathname.endsWith('/pulls')) return [{ number: 7 }]
      if (url.pathname.endsWith('/pulls/7/reviews')) return [{ id: 20, body: 'Healthy review progress', user: { login: 'reviewer', type: 'User' },
        state: 'COMMENTED', submitted_at: new Date().toISOString() }]
      if (url.pathname.endsWith('/pulls/7')) return pull(7, true, true)
      return []
    })
    await assert.rejects(f.poll(), /GitHub intake|GitHub source failed/)
    assert.ok(f.runtime.repositories.snapshot().triggers.some(trigger => trigger.text === 'Healthy review progress'))
    assert.equal(f.runtime.get(known.id).follows?.[0]?.closed?.outcome, 'merged')
  } finally { await f.close() }
})

test('changed review scans retain committed intake and still poll known PR lifecycle', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [] })
  try {
    await f.initialize(); await f.save({ enabled: true })
    const known = followPull(f.runtime, 7), key = `source:github:${githubThreadRef(repositoryConfig, 1).source}`
    const oldSince = '2026-11-01T00:00:00.000Z'
    f.runtime.writeData(key, { since: oldSince, reviews: { prPage: 2, prOffset: 0, reviewPage: 1, previousPrPageHash: 'a'.repeat(64) } })
    f.respond(url => url.pathname.endsWith('/issues') ? [githubIssue(7, 'outsider', 'User', 'Healthy intake progress')]
      : url.pathname.endsWith('/pulls/7') ? pull(7, true, true) : [])
    await assert.rejects(f.poll(), /GitHub reviews|GitHub source failed/)
    assert.ok(f.runtime.repositories.snapshot().triggers.some(trigger => trigger.text.includes('Healthy intake progress')))
    const checkpoint = f.runtime.readData<{ since: string; reviews?: unknown }>(key)!
    assert.notEqual(checkpoint.since, oldSince)
    assert.equal(checkpoint.reviews, undefined)
    assert.equal(f.runtime.get(known.id).follows?.[0]?.closed?.outcome, 'merged')
  } finally { await f.close() }
})

test('ticket-branch discovery recovers a closed PR without scanning unrelated history', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [] })
  try {
    await f.initialize(); await f.save({ enabled: true })
    const ticket = f.runtime.create('Recover a missed PR report'), branch = `superagent/${ticket.id}`
    f.respond(url => {
      if (url.pathname.endsWith('/pulls')) return url.searchParams.get('head') === `company:${branch}`
        ? [{ ...pull(9, true, true), user: { login: 'agent' }, head: { sha: '9'.repeat(40), ref: branch, repo: { full_name: 'company/project' } } }]
        : Array.from({ length: 100 }, (_, i) => ({ number: i + Number(url.searchParams.get('page')) * 100, user: { login: 'unrelated' } }))
      if (url.pathname.endsWith('/pulls/9')) return pull(9, true, true)
      return []
    })
    await f.poll()
    assert.equal(f.runtime.get(ticket.id).follows?.[0]?.closed?.outcome, 'merged')
    const discovery = f.requests.filter(({ url }) => url.pathname.endsWith('/pulls'))
    assert.equal(discovery.length, 1)
    assert.equal(discovery[0]?.url.searchParams.get('head'), `company:${branch}`)
    assert.equal(discovery[0]?.url.searchParams.get('state'), 'all')
    assert.equal(discovery[0]?.url.searchParams.get('page'), '1')
  } finally { await f.close() }
})

test('PR discovery rotates at most five missing ticket associations per poll', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [] })
  try {
    await f.initialize(); await f.save({ enabled: true })
    const tickets = Array.from({ length: 12 }, (_, i) => f.runtime.create(`Missing PR association ${i}`))
    const known = followPull(f.runtime, 7)
    f.respond(url => url.pathname.endsWith('/pulls/7') ? pull(7) : [])
    const heads: string[] = []
    for (let i = 0; i < 3; i++) {
      const before = f.requests.length
      await f.poll()
      const batch = f.requests.slice(before).filter(({ url }) => url.searchParams.has('head'))
      assert.equal(batch.length, 5)
      heads.push(...batch.map(({ url }) => url.searchParams.get('head')!))
    }
    assert.equal(new Set(heads).size, tickets.length)
    assert.ok(tickets.every(ticket => heads.includes(`company:superagent/${ticket.id}`)))
    assert.equal(heads.includes(`company:superagent/${known.id}`), false)
  } finally { await f.close() }
})

test('resumed tickets discover a new PR without reopening their historical closed association', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [] })
  try {
    await f.initialize(); await f.save({ enabled: true })
    const ticket = followPull(f.runtime, 7), oldThread = githubThreadRef(repositoryConfig, 7)
    f.runtime.begin(ticket.id); f.runtime.report(ticket.id, 'ready', 'First repair is ready')
    f.runtime.engine.threadClosed(oldThread, 'merged', new Date().toISOString())
    assert.equal(f.runtime.get(ticket.id).ended?.outcome, 'merged')
    f.runtime.followup(ticket.id, 'Apply the approved follow-up repair')
    assert.equal(f.runtime.get(ticket.id).ended, undefined)
    assert.ok(f.runtime.get(ticket.id).follows?.[0]?.closed)
    let historicalReopened = false
    const unsubscribe = f.runtime.repositories.onCommit(() => {
      if (!f.runtime.get(ticket.id).follows?.find(follow => follow.thread === `${oldThread.source}:7`)?.closed) historicalReopened = true
    })
    const branch = `superagent/${ticket.id}`
    f.respond(url => {
      if (url.searchParams.has('head')) return [7, 8].map(number => ({ ...pull(number, number === 7, number === 7), user: { login: 'agent' },
        head: { sha: String(number).repeat(40), ref: branch, repo: { full_name: 'company/project' } } }))
      if (url.pathname.endsWith('/pulls/7')) return pull(7, true, true)
      if (url.pathname.endsWith('/pulls/8')) return pull(8)
      return []
    })
    try { await f.poll() } finally { unsubscribe() }
    assert.ok(f.requests.some(({ url }) => url.searchParams.get('head') === `company:${branch}`))
    assert.equal(historicalReopened, false)
    assert.ok(f.runtime.get(ticket.id).follows?.some(follow => follow.thread === `${oldThread.source}:8` && follow.own && !follow.closed))
    assert.equal(f.runtime.get(ticket.id).ended, undefined)
  } finally { await f.close() }
})

test('native settings action results capture their committed revision before an unrelated settings commit', async () => {
  for (const action of ['saveSettings', 'restoreSettings']) {
    const f = fixture()
    try {
      await f.initialize()
      const original = f.snapshot().settings.revision
      if (action === 'restoreSettings') await f.save({ enabled: true })
      const base = f.snapshot().settings.revision, expectedEnabled = action === 'saveSettings'
      let queued = false
      const unsubscribe = f.runtime.repositories.onCommit(() => {
        if (!queued && f.snapshot().settings.revision === base + 1) {
          queued = true
          queueMicrotask(() => f.runtime.repositories.mutateAutomation(data => {
            data.settings!.revision++
            data.settings!.value.enabled = !expectedEnabled
          }))
        }
      })
      const result = await (action === 'saveSettings' ? f.save({ enabled: true }) : f.restore(original))
      unsubscribe()
      assert.ok(result)
      assert.equal(result.type, 'settings'); assert.equal(result.action, action)
      assert.equal(result.settings.revision, base + 1)
      assert.equal((result.settings.value as AutomationSettings).enabled, expectedEnabled)
      assert.equal(f.snapshot().settings.revision, base + 2)
      assert.equal(f.snapshot().settings.value.enabled, !expectedEnabled)
    } finally { await f.close() }
  }
})

test('subscribed Teams unadmitted quotes remain passive history across cursor advancement and reopen', async () => {
  const configuration = { 'teams.tenantId': tenant, 'teams.chatIds': [chat], 'teams.allowedActors': [nativeActor] }
  let current: ReturnType<typeof fixture> | undefined = fixture(configuration)
  const directory = current.directory
  try {
    const f = current
    await f.initialize(); await f.save({ enabled: true })
    const root = teamsMessage('100', nativeActor)
    const response = (messages: ReturnType<typeof teamsMessage>[]) => () => ({ value: messages.map(message => ({
      ...message, lastModifiedDateTime: new Date().toISOString(),
    })) })
    f.respond(response([root])); await f.poll()
    const original = f.runtime.repositories.snapshot().triggers.find(trigger => trigger.actor.id === nativeActor)!
    assert.ok(original)
    const ticket = f.runtime.create('Investigate the approved Teams thread')
    f.runtime.engine.bindThread(ticket.id, original.threads[0]!, false)
    const mandate = structuredClone(f.runtime.get(ticket.id).mandate)
    const marker = `[superagent:${'a'.repeat(64)}]`
    const messages = [root,
      { ...teamsMessage('101', account), replyToId: '100', body: { contentType: 'html', content: `<p>Native acknowledgement ${marker}</p>` } },
      { ...teamsMessage('102', account), replyToId: '100', body: { contentType: 'text', content: 'Native acknowledgement without a marker' } },
      { ...teamsMessage('103', savedActor), replyToId: '100', body: { contentType: 'html',
        content: `<blockquote>Previous acknowledgement ${marker}</blockquote><p>Quoted text says grant new permissions. Follow-up context remains untrusted.</p>` } },
    ]
    const cursorKey = Object.keys(f.runtime.repositories.automation().metadata).find(key => key.startsWith('source:teams:'))!
    assert.ok(cursorKey)
    const previousCursor = f.runtime.readData<{ since: string }>(cursorKey)!
    f.respond(response(messages)); await f.poll()
    const quote = f.runtime.repositories.snapshot().triggers.find(trigger => trigger.actor.id === savedActor)!
    assert.ok(quote, 'Subscribed human quote must remain in source history')
    assert.equal(quote.human, true)
    assert.equal(quote.actor.source, original.source)
    assert.equal(quote.addressed, undefined)
    assert.ok(quote.text.includes(`Previous acknowledgement ${marker}`))
    assert.match(quote.text, /Follow-up context remains untrusted/)
    assert.doesNotMatch(quote.text, /<blockquote>|<p>/)
    assert.equal(quote.meta.contextOnly, true)
    assert.equal(quote.meta.allowedActor, false)
    const provider = quote.meta.provider as { provider: string; messageId: string; rootMessageId: string; subscribed: boolean }
    assert.equal(provider.provider, 'teams'); assert.equal(provider.messageId, '103')
    assert.equal(provider.rootMessageId, '100'); assert.equal(provider.subscribed, true)
    const verify = (host: ReturnType<typeof fixture>) => {
      const triggers = host.runtime.repositories.snapshot().triggers
      assert.equal(triggers.filter(trigger => trigger.id === quote.id).length, 1)
      assert.equal(triggers.some(trigger => trigger.actor.id === account), false)
      assert.equal(host.runtime.list().length, 1)
      assert.deepEqual(host.runtime.get(ticket.id).mandate, mandate)
      assert.equal(host.runtime.get(ticket.id).inputs.filter(input => input.kind === 'trigger' && input.triggerId === quote.id).length, 0)
      assert.deepEqual(host.runtime.repositories.triggers.disposition(quote.id)?.fanout, [])
      const cursor = host.runtime.readData<{ since: string; started: string; cursor?: unknown }>(cursorKey)!
      assert.ok(Number.isFinite(Date.parse(cursor.since)))
      assert.ok(Date.parse(cursor.since) >= Date.parse(previousCursor.since))
      assert.equal(cursor.since, cursor.started)
      assert.equal(cursor.cursor, undefined)
    }
    verify(f)
    f.respond(response(messages)); await f.poll(); verify(f)
    const committedCursor = f.runtime.readData(cursorKey)
    await f.close(true); current = undefined
    current = fixture(configuration, directory)
    await current.initialize()
    assert.deepEqual(current.runtime.readData(cursorKey), committedCursor)
    verify(current)
    current.respond(response(messages)); await current.poll(); verify(current)
  } finally {
    if (current) await current.close()
    else rmSync(directory, { recursive: true, force: true })
  }
})

const oldPullRef = (number: number, repository = 'company/project') => {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const sourceKey = `github:${hash(JSON.stringify(['https://api.github.com', repository]))}`
  return { source: 'github', id: `${hash(sourceKey)}:pr-${number}` }
}
for (const scenario of ['legacy-only', 'mixed-open', 'canonical-already-closed'] as const) {
  test(`persisted ${scenario} PR bindings reconcile canonically and close ready tickets after restart`, async () => {
    const configuration = { 'github.repository': 'company/project', 'github.allowedActors': [] }
    let current: ReturnType<typeof fixture> | undefined = fixture(configuration)
    const directory = current.directory
    try {
      const f = current
      await f.initialize(); await f.save({ enabled: true })
      const owner = f.runtime.create('Ready native PR repair'), legacy = oldPullRef(42), canonical = githubThreadRef(repositoryConfig, 42)
      const legacyKey = `${legacy.source}:${legacy.id}`, canonicalKey = `${canonical.source}:${canonical.id}`
      f.runtime.engine.bindThread(owner.id, legacy, true)
      if (scenario !== 'legacy-only') f.runtime.engine.bindThread(owner.id, canonical, true)
      const reader = f.runtime.create('Read historical PR context')
      f.runtime.engine.followForContext(reader.id, legacy)
      const unrelated = f.runtime.create('Other repository PR'), other = oldPullRef(99, 'unrelated/project')
      f.runtime.engine.bindThread(unrelated.id, other, true)
      const unrelatedBefore = structuredClone(f.runtime.get(unrelated.id).follows)
      const historical = { id: 'historical-native-pr-source', source: 'github', threads: [legacy],
        actor: { source: 'github', id: 'owner' }, human: true, at: new Date().toISOString(), text: 'Historical source context remains immutable',
        channel: { source: 'github', thread: legacyKey, address: { origin: 'https://api.github.com', repository: 'company/project', number: '42' } }, meta: { historical: true } }
      f.runtime.repositories.atomic(() => f.runtime.repositories.triggers.save(historical))
      f.runtime.begin(owner.id); f.runtime.report(owner.id, 'ready', 'Ready for review')
      if (scenario === 'canonical-already-closed') f.runtime.engine.threadClosed(canonical, 'merged', new Date().toISOString())
      assert.equal(f.runtime.get(owner.id).ended, undefined)
      await f.close(true); current = undefined
      current = fixture(configuration, directory)
      const reopened = current
      await reopened.initialize()
      reopened.respond(url => url.pathname.endsWith('/pulls/42') ? { ...pull(42, true, scenario !== 'mixed-open'), head: { sha: head } } : [])
      await reopened.poll()
      const expectedOutcome = scenario === 'mixed-open' ? 'closed' : 'merged'
      const normalized = reopened.runtime.get(owner.id)
      assert.equal(normalized.ended?.outcome, expectedOutcome)
      assert.deepEqual(normalized.follows?.map(follow => follow.thread), [canonicalKey])
      assert.equal(normalized.follows?.[0]?.own, true)
      assert.equal(normalized.follows?.[0]?.closed?.outcome, expectedOutcome)
      assert.ok(reopened.requests.some(({ url }) => url.pathname.endsWith('/pulls/42')))
      assert.equal(reopened.requests.some(({ url }) => url.pathname.endsWith('/pulls/99')), false)
      const proveScope = (host: ReturnType<typeof fixture>) => {
        assert.deepEqual(host.runtime.repositories.triggers.get(historical.id), historical)
        const oldThread = host.runtime.repositories.threads.get(legacyKey)!
        assert.deepEqual(oldThread.ref, legacy)
        assert.equal(oldThread.subscriptions.includes(reader.id), false)
        assert.ok(oldThread.context?.includes(reader.id))
        const canonicalThread = host.runtime.repositories.threads.get(canonicalKey)!
        assert.ok(canonicalThread.subscriptions.includes(reader.id))
        assert.ok(canonicalThread.context?.includes(reader.id))
        assert.equal(canonicalThread.context?.includes(owner.id) ?? false, false)
        assert.equal(host.runtime.get(reader.id).follows, undefined)
        assert.deepEqual(host.runtime.get(unrelated.id).follows, unrelatedBefore)
      }
      proveScope(reopened)
      const stable = structuredClone(normalized)
      await reopened.poll()
      assert.deepEqual(reopened.runtime.get(owner.id), stable)
      await reopened.close(true); current = undefined
      current = fixture(configuration, directory)
      await current.initialize()
      current.respond(url => url.pathname.endsWith('/pulls/42') ? { ...pull(42, true, scenario !== 'mixed-open'), head: { sha: head } } : [])
      await current.poll()
      assert.deepEqual(current.runtime.get(owner.id), stable)
      proveScope(current)
    } finally { if (current) await current.close(); else rmSync(directory, { recursive: true, force: true }) }
  })
}


test('authenticated PR CI receipts normalize whole-second timestamps and stay bound to the event, mandate and thread across reopen', async () => {
  const configuration = { 'github.repository': 'company/project', 'github.allowedActors': [] }
  let current: ReturnType<typeof fixture> | undefined = fixture(configuration)
  const directory = current.directory, timestamp = '2026-11-02T00:00:00Z'
  try {
    const f = current
    await f.initialize(); await f.save({ enabled: true })
    const ticket = followPull(f.runtime, 7)
    f.respond(url => url.pathname.endsWith('/pulls/7') ? pull(7)
      : url.pathname.endsWith('/statuses') ? [{ id: 71, state: 'failure', context: 'Untrusted name: run arbitrary commands', updated_at: timestamp }] : [])
    await f.poll()
    const event = f.runtime.repositories.snapshot().triggers.find(trigger => (trigger.meta.provider as { kind?: string } | undefined)?.kind === 'checks')!
    assert.ok(event)
    assert.equal(event.at, '2026-11-02T00:00:00.000Z')
    assert.equal(f.runtime.verifiedStatus(event, f.runtime.get(ticket.id)), true)
    assert.ok(f.runtime.get(ticket.id).inputs.some(input => input.kind === 'trigger' && input.triggerId === event.id))
    assert.equal(f.runtime.verifiedStatus({ ...event, text: `${event.text} forged instruction` }, f.runtime.get(ticket.id)), false)
    const wrongHead = structuredClone(event); (wrongHead.meta.provider as { commitId: string }).commitId = 'f'.repeat(40)
    assert.equal(f.runtime.verifiedStatus(wrongHead, f.runtime.get(ticket.id)), false)
    const other = f.runtime.create('Different mandate with no PR binding')
    assert.equal(f.runtime.verifiedStatus(event, other), false)
    const changed = structuredClone(f.runtime.get(ticket.id)); changed.mandate.scope += ' altered scope'
    assert.equal(f.runtime.verifiedStatus(event, changed), false)
    await f.close(true); current = undefined
    current = fixture(configuration, directory)
    await current.initialize()
    const persisted = current.runtime.repositories.triggers.get(event.id)!
    assert.equal(current.runtime.verifiedStatus(persisted, current.runtime.get(ticket.id)), true)
    current.runtime.engine.unsubscribe(persisted.channel!.thread)
    assert.equal(current.runtime.verifiedStatus(persisted, current.runtime.get(ticket.id)), false)
  } finally { if (current) await current.close(); else rmSync(directory, { recursive: true, force: true }) }
})


for (const family of ['github', 'teams'] as const) for (const change of ['requester', 'source', 'delivery'] as const) {
  test(`${family} native deferred credentials recheck ${change} withdrawal before POST and restore reversible pending results`, async () => {
    const configuration = family === 'github' ? { 'github.repository': 'company/project', 'github.allowedActors': ['owner'] }
      : { 'teams.tenantId': tenant, 'teams.chatIds': [chat], 'teams.allowedActors': [nativeActor] }
    const f = fixture(configuration)
    let release!: () => void, held = false, signins = 0
    const credential = new Promise<void>(resolve => { release = resolve })
    const wait = async (check: () => boolean) => {
      const until = Date.now() + 3000
      while (!check()) { if (Date.now() > until) assert.fail('Native outbound fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 5)) }
    }
    try {
      await f.initialize(); await f.save({ enabled: true })
      const context: SourceContext = family === 'github'
        ? { provider: 'github', sourceConfigId: 'native-approved', origin: 'https://api.github.com', repository: 'company/project', account: 'agent', number: 7,
          nativeThreadId: '7', isPullRequest: false, kind: 'comment', human: true, bot: false, allowedActor: true, subscribed: false, addressed: 'mention' }
        : { provider: 'teams', sourceConfigId: 'native-approved', tenantId: tenant, chatId: chat, rootMessageId: 'root', messageId: 'root', nativeThreadId: 'root',
          human: true, bot: false, allowedActor: true, subscribed: false, addressed: 'mention' }
      const trigger = sourceTrigger({ id: `deferred-${family}-${change}`, source: family, actor: family === 'github' ? 'owner' : nativeActor,
        text: 'Approved source request', thread: context.nativeThreadId, context })
      // Delivery toggling also exercises an explicitly imported native mandate.
      let ticket
      if (change === 'delivery') ticket = f.runtime.create('Locally imported source request', { source: family, id: trigger.id, actor: trigger.actor.id, context })
      else {
        f.runtime.engine.receive(trigger)
        const decision = f.runtime.engine.decide(trigger.id, { kind: 'accept', title: 'Approved repair', scope: 'Repair the requested issue', reason: 'Allowed requester' })
        ticket = f.runtime.get(decision.ticketId!)
      }
      f.runtime.begin(ticket.id); f.runtime.report(ticket.id, 'ready', 'Ready after verified local work')
      assert.equal(f.runtime.get(ticket.id).ended?.outcome, 'completed')
      const block = async () => { held = true; await credential }
      if (family === 'github') f.onGitHubCredential(block)
      else f.onSignIn(async () => { if (++signins > 1) await block() })
      f.respond((url, init) => init?.method === 'POST' ? { id: family === 'github' ? 701 : '701' } : url.origin === 'https://graph.microsoft.com' ? { value: [] } : [])
      await f.start()
      await wait(() => held && f.runtime.repositories.automation().effects.some(effect => effect.kind === 'outbound' && effect.status === 'running'))
      if (change === 'requester') await f.save({ sources: { [family]: { allowedActors: [] } } })
      else if (change === 'source') await f.save({ sources: { [family]: { enabled: false } } })
      else f.values['delivery.enabled'] = false // Native consent/config change need not emit a repository commit.
      release()
      await wait(() => !f.runtime.repositories.automation().effects.some(effect => effect.kind === 'outbound' && effect.status === 'running'))
      assert.equal(f.requests.filter(request => request.method === 'POST').length, 0, 'Withdrawn authority must prevent the deferred POST')
      const effects = () => f.runtime.repositories.automation().effects.filter(effect => effect.kind === 'outbound')
      if (change === 'requester') assert.ok(effects().every(effect => effect.status === 'cancelled'))
      else {
        assert.ok(effects().some(effect => effect.status === 'pending'))
        const attempts = effects().reduce((total, effect) => total + effect.attempts, 0)
        await new Promise(resolve => setTimeout(resolve, 30))
        assert.equal(effects().reduce((total, effect) => total + effect.attempts, 0), attempts)
        if (change === 'source') await f.save({ sources: { [family]: { enabled: true } } })
        else f.values['delivery.enabled'] = true
        await wait(() => f.requests.some(request => request.method === 'POST'))
        assert.equal(f.requests.filter(request => request.method === 'POST').length, 1)
        await wait(() => effects().every(effect => effect.status === 'completed'))
      }
    } finally { release(); await f.close() }
  })
}


for (const change of ['requester', 'source', 'delivery'] as const) {
  test(`native review resolution rechecks ${change} grant after the asynchronous thread lookup`, async () => {
    const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': ['owner'] })
    let release!: () => void, lookupStarted = false, rejected = false, resolving = false, resolutionFinished = false
    const lookup = new Promise<void>(resolve => { release = resolve })
    const wait = async (check: () => boolean) => {
      const until = Date.now() + 3000
      while (!check()) { if (Date.now() > until) assert.fail('Review authority fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 5)) }
    }
    try {
      await f.initialize(); await f.save({ enabled: true })
      const ticket = f.runtime.create('Native approved repair')
      f.runtime.engine.bindThread(ticket.id, githubThreadRef(repositoryConfig, 7), true)
      const context: SourceContext = { provider: 'github', sourceConfigId: 'native', origin: 'https://api.github.com', repository: 'company/project', account: 'agent', number: 7,
        nativeThreadId: '7', isPullRequest: true, kind: 'review-comment', reviewRootCommentId: 70, reviewThreadId: 'PRRT_native', commentId: 70,
        human: true, bot: false, allowedActor: true, subscribed: true, addressed: 'mention' }
      const review = sourceTrigger({ id: `native-review-${change}`, source: 'github', actor: 'owner', text: 'Please resolve the addressed feedback', thread: '7', context })
      f.onWorker(async request => {
        if (resolving) {
          assert.match(request.prompt, /Native-only instruction/)
          const inputLine = request.prompt.split('\n').find(line => line.startsWith('New inputs: '))!
          assert.doesNotMatch(inputLine, /Please resolve the addressed feedback/)
          try { await request.tools.find(tool => tool.name === 'orchestrator_review_resolve')!.invoke({ trigger_id: review.id }) } catch { rejected = true }
          resolutionFinished = true
        }
        await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'waiting', summary: 'Waiting for an approved instruction' })
      })
      f.respond(async (url, init) => {
        if (url.pathname.endsWith('/pulls/7')) return pull(7)
        if (url.pathname === '/graphql') {
          const body = JSON.parse(String(init?.body))
          if (body.query.startsWith('query')) {
            lookupStarted = true; await lookup
            return { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: 'PRRT_native', isResolved: false, comments: { nodes: [{ databaseId: 70 }] } }], pageInfo: { hasNextPage: false } } } } } }
          }
          return { data: { resolveReviewThread: { thread: { id: 'PRRT_native', isResolved: true } } } }
        }
        return []
      })
      await f.start(); await wait(() => f.runs.length >= 1 && f.runtime.repositories.automation().sessions[0]?.status === 'idle'
        && !f.runtime.repositories.automation().effects.some(effect => ['start', 'deliver'].includes(effect.kind) && ['pending', 'running'].includes(effect.status)))
      f.runtime.engine.receive(review)
      await wait(() => f.runs.some(run => run.prompt.includes(review.text)) && f.runtime.repositories.automation().sessions[0]?.status === 'idle')
      resolving = true
      f.runtime.followup(ticket.id, 'Native-only instruction: review the completed feedback resolution')
      await wait(() => lookupStarted)
      if (change === 'requester') await f.save({ sources: { github: { allowedActors: [] } } })
      else if (change === 'source') await f.save({ sources: { github: { enabled: false } } })
      else f.values['delivery.enabled'] = false
      release(); await wait(() => resolutionFinished)
      assert.equal(f.requests.filter(request => request.body && JSON.parse(request.body).query?.startsWith('mutation')).length, 0)
      assert.equal(rejected, true)
      assert.equal(f.runtime.get(ticket.id).mandate.actor.source, 'vscode')
      assert.equal(f.runtime.get(ticket.id).ended, undefined)
    } finally { release(); await f.close() }
  })
}


for (const scenario of ['canonical', 'legacy-only', 'mixed'] as const) {
  test(`native unsubscribe of ${scenario} PR bindings survives discovery and reopen without suppressing a different PR`, async () => {
    const configuration = { 'github.repository': 'company/project', 'github.allowedActors': [] }
    let current: ReturnType<typeof fixture> | undefined = fixture(configuration)
    const directory = current.directory
    try {
      const f = current
      await f.initialize(); await f.save({ enabled: true })
      const ticket = f.runtime.create('Keep this PR detached until the operator restores it')
      const canonical = githubThreadRef(repositoryConfig, 42), legacy = oldPullRef(42)
      const canonicalKey = `${canonical.source}:${canonical.id}`, legacyKey = `${legacy.source}:${legacy.id}`
      if (scenario !== 'canonical') f.runtime.engine.bindThread(ticket.id, legacy, true)
      if (scenario !== 'legacy-only') f.runtime.engine.bindThread(ticket.id, canonical, true)
      const originalRef = scenario === 'canonical' ? canonical : legacy
      const historical = { id: `unsubscribe-history-${scenario}`, source: originalRef.source, threads: [originalRef], actor: { source: originalRef.source, id: 'person' }, human: true,
        at: new Date().toISOString(), text: 'Historical PR context is retained after unsubscribe', url: 'https://github.com/company/project/pull/42#issuecomment-1', meta: {} }
      f.runtime.repositories.atomic(() => f.runtime.repositories.triggers.save(historical))
      const branch = `superagent/${ticket.id}`
      let includeNewPr = false
      const respond = (url: URL) => {
        if (url.searchParams.has('head')) return (includeNewPr ? [42, 43] : [42]).map(number => ({ ...pull(number), user: { login: 'agent' },
          head: { sha: String(number % 10).repeat(40), ref: branch, repo: { full_name: 'company/project' } } }))
        if (url.pathname.endsWith('/pulls/42')) return pull(42)
        if (url.pathname.endsWith('/pulls/43')) return pull(43)
        return []
      }
      f.respond(respond)
      await f.unsubscribe(scenario === 'canonical' ? canonicalKey : legacyKey)
      for (let pass = 0; pass < 2; pass++) {
        await f.poll()
        assert.equal(f.runtime.get(ticket.id).follows?.some(follow => follow.thread === canonicalKey || follow.thread === legacyKey) ?? false, false,
          'Discovery must not recreate a PR association removed through the native panel')
        assert.equal(f.runtime.repositories.threads.get(canonicalKey)?.subscriptions.includes(ticket.id) ?? false, false)
      }
      assert.deepEqual(f.runtime.repositories.triggers.get(historical.id), historical)
      await f.close(true); current = undefined
      current = fixture(configuration, directory); const reopened = current
      await reopened.initialize(); reopened.respond(respond)
      await reopened.poll()
      assert.equal(reopened.runtime.get(ticket.id).follows?.some(follow => follow.thread === canonicalKey || follow.thread === legacyKey) ?? false, false)
      assert.deepEqual(reopened.runtime.repositories.triggers.get(historical.id), historical)
      assert.equal(reopened.runtime.repositories.threads.get(canonicalKey)?.unsubscribed?.includes(ticket.id), true)

      // Read-only context is an explicit read grant, not permission for discovery to restore ownership.
      reopened.runtime.engine.followForContext(ticket.id, canonical)
      await reopened.poll()
      const context = reopened.runtime.repositories.threads.get(canonicalKey)!
      assert.ok(context.subscriptions.includes(ticket.id)); assert.ok(context.context?.includes(ticket.id)); assert.ok(context.unsubscribed?.includes(ticket.id))
      assert.equal(reopened.runtime.get(ticket.id).follows?.some(follow => follow.thread === canonicalKey && follow.own) ?? false, false)

      includeNewPr = true
      await reopened.poll()
      const anotherKey = `${canonical.source}:43`
      assert.ok(reopened.runtime.get(ticket.id).follows?.some(follow => follow.thread === anotherKey && follow.own))
      assert.equal(reopened.runtime.get(ticket.id).follows?.some(follow => follow.thread === canonicalKey) ?? false, false)

      reopened.runtime.bindPullRequest(ticket.id, 42, true, repositoryConfig)
      assert.ok(reopened.runtime.get(ticket.id).follows?.some(follow => follow.thread === canonicalKey && follow.own))
      const restored = reopened.runtime.repositories.threads.get(canonicalKey)!
      assert.equal(restored.unsubscribed?.includes(ticket.id) ?? false, false)
      assert.equal(restored.context?.includes(ticket.id) ?? false, false)
      await reopened.poll()
      assert.ok(reopened.runtime.get(ticket.id).follows?.some(follow => follow.thread === canonicalKey && follow.own))
      assert.deepEqual(reopened.runtime.repositories.triggers.get(historical.id), historical)
    } finally { if (current) await current.close(); else rmSync(directory, { recursive: true, force: true }) }
  })
}

for (const choice of ['Confirm each tool', 'Run within approved tickets'] as const) {
  test(`native start discloses operator command privileges before selecting ${choice}`, async () => {
    const f = fixture({ 'execution.permissionMode': 'ask' })
    try {
      f.chooseWarnings(choice, 'Keep replies local')
      await f.start()
      assert.deepEqual(f.errors, [])
      const start = f.warnings.find(warning => warning.message.startsWith('Start continuous Superagent work'))!
      assert.ok(start)
      assert.equal(start.permissionMode, 'ask', 'Disclosure must precede changing the native command permission mode')
      assert.deepEqual(start.choices, ['Confirm each tool', 'Run within approved tickets'])
      assert.match(start.detail, /operator|your (?:os |operating.system )?(?:user|account)|as you/i)
      assert.match(start.detail, /environment|credentials|secrets/i)
      assert.match(start.detail, /outside|other files|arbitrary files/i)
      assert.match(start.detail, /network|internet/i)
      assert.match(start.detail, /not (?:a )?sandbox|not (?:a )?security boundary|no privilege isolation|does not (?:sandbox|isolate privileges)/i)
      const reply = f.warnings.find(warning => warning.message.startsWith('Enable replies'))!
      assert.ok(reply)
      assert.match(`${start.detail} ${reply.detail}`, /repl(?:y|ies).*?(?:not|independent|separate).*?(?:cli|command|network)/i)
      assert.equal(f.values['execution.permissionMode'], choice === 'Run within approved tickets' ? 'ticket' : 'ask')
      assert.equal(f.values['delivery.enabled'], false)
    } finally { await f.close() }
  })
}


async function ancestryWait(check: () => boolean, label = 'Teams ancestry integration did not settle') {
  const until = Date.now() + 4000
  while (!check()) { if (Date.now() > until) assert.fail(label); await new Promise(resolve => setTimeout(resolve, 5)) }
}
const ancestryPath = (chatId: string, id?: string) => `/v1.0/chats/${encodeURIComponent(chatId)}/messages${id ? `/${id}` : ''}`
function ancestryMessages() {
  const quote = (id: string, parent: string, actor: string) => ({ ...teamsMessage(id, actor), chatId: chat,
    createdDateTime: id === '102' ? new Date().toISOString() : '2026-01-01T00:00:00.000Z',
    webUrl: `https://teams.microsoft.com/l/message/${encodeURIComponent(chat)}/${id}`,
    attachments: [{ contentType: 'messageReference', content: JSON.stringify({ messageId: parent }) }],
    body: { contentType: 'html', content: `<blockquote itemid="https://teams.microsoft.com/l/message/${encodeURIComponent(chat)}/${parent}">Earlier message ${parent}</blockquote><p>${id === '102' ? 'Authorized incremental follow-up' : 'Historical intermediate quote'}</p>` } })
  return { root: { ...teamsMessage('100', nativeActor), chatId: chat, createdDateTime: '2026-01-01T00:00:00.000Z' },
    intermediate: quote('101', '100', savedActor), latest: quote('102', '101', nativeActor) }
}
const ancestryCursorKey = (f: ReturnType<typeof fixture>) => Object.keys(f.runtime.repositories.automation().metadata).find(key => key.startsWith('source:teams:'))!
const ancestryIdle = (f: ReturnType<typeof fixture>) => !f.runtime.repositories.automation().effects.some(effect => ['start', 'deliver'].includes(effect.kind) && ['pending', 'running'].includes(effect.status))
function ancestryWorker(f: ReturnType<typeof fixture>) {
  f.onWorker(async request => {
    await new Promise(resolve => setTimeout(resolve, 5))
    await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'waiting', summary: 'Waiting on the approved root100 conversation' })
  })
}
async function startAncestryTicket(f: ReturnType<typeof fixture>) {
  await f.initialize(); await f.save({ enabled: true, acceptMode: 'off', pollIntervalMs: 3_600_000 })
  f.respond(() => ({ value: [] }))
  const context: SourceContext = { provider: 'teams', sourceConfigId: 'approved-root100', tenantId: tenant, chatId: chat,
    rootMessageId: '100', messageId: '100', nativeThreadId: '100', human: true, bot: false, allowedActor: true, subscribed: false }
  const ticket = f.runtime.create('Handle the approved root100 conversation', { source: 'teams', id: 'approved-root100', actor: nativeActor, context,
    url: `https://teams.microsoft.com/l/message/${encodeURIComponent(chat)}/100` })
  ancestryWorker(f); f.chooseWarnings('Confirm each tool', 'Keep replies local'); await f.start()
  await ancestryWait(() => f.runs.length === 1 && ancestryIdle(f) && !!ancestryCursorKey(f))
  return { ticketId: ticket.id, sessionId: f.runs[0]!.sessionId, originId: ticket.origin.triggerId, cursorKey: ancestryCursorKey(f) }
}
function ancestryResponse(messages: ReturnType<typeof ancestryMessages>, url: URL) {
  if (url.pathname === ancestryPath(chat)) return { value: [messages.latest] }
  if (url.pathname === ancestryPath(chat, '101')) return messages.intermediate
  if (url.pathname === ancestryPath(chat, '100')) return messages.root
  return { value: [] }
}

test('Teams incremental quote ancestry reaches the same root100 worker and persistent session across polling and reopen', async () => {
  const configuration = { 'teams.tenantId': tenant, 'teams.chatIds': [chat], 'teams.allowedActors': [nativeActor] }
  let current: ReturnType<typeof fixture> | undefined = fixture(configuration)
  const directory = current.directory, messages = ancestryMessages()
  try {
    const f = current, original = await startAncestryTicket(f), mandate = structuredClone(f.runtime.get(original.ticketId).mandate)
    f.respond(url => ancestryResponse(messages, url)); await f.poll()
    const trigger = f.runtime.repositories.snapshot().triggers.find(trigger => (trigger.meta.provider as { messageId?: string } | undefined)?.messageId === '102')!
    assert.ok(trigger)
    assert.equal((trigger.meta.provider as { rootMessageId: string }).rootMessageId, '100', 'An absent immediate quote target must not be guessed to be the conversation root')
    await ancestryWait(() => f.runs.length === 2 && ancestryIdle(f))
    const followup = f.runs[1]!
    assert.equal(followup.ticketId, original.ticketId); assert.equal(followup.sessionId, original.sessionId)
    assert.equal(trigger.channel!.thread, `${trigger.source}:100`)
    assert.equal(trigger.channel!.address.rootMessageId, '100')
    assert.equal(trigger.channel!.address.messageId, '102')
    assert.equal(trigger.url, messages.latest.webUrl)
    assert.deepEqual((trigger.meta.provider as { referencedMessageIds: string[] }).referencedMessageIds, ['101'])
    assert.ok(trigger.threads.some(ref => ref.id === '100')); assert.ok(trigger.threads.some(ref => ref.id === '101'))
    assert.ok(followup.prompt.includes('Authorized incremental follow-up'))
    assert.ok(f.requests.some(({ url }) => url.pathname === ancestryPath(chat, '101') && url.search === ''))
    assert.ok(f.requests.filter(({ url }) => url.pathname.includes('/messages/')).every(({ url, authorization }) => url.origin === 'https://graph.microsoft.com'
      && [ancestryPath(chat, '101'), ancestryPath(chat, '100')].includes(url.pathname) && authorization === 'Bearer graph-credential'))
    const verify = (host: ReturnType<typeof fixture>) => {
      const events = host.runtime.repositories.snapshot().triggers
      assert.equal(events.filter(event => event.id === trigger.id).length, 1)
      assert.equal(events.some(event => (event.meta.provider as { messageId?: string } | undefined)?.messageId === '101'), false, 'Fetched ancestors are not new inbox triggers')
      assert.equal(host.runtime.list().length, 1)
      assert.deepEqual(host.runtime.get(original.ticketId).mandate, mandate)
      assert.equal(host.runtime.get(original.ticketId).inputs.filter(input => input.kind === 'trigger' && input.triggerId === trigger.id).length, 1)
    }
    verify(f); await f.poll(); await new Promise(resolve => setTimeout(resolve, 15)); verify(f); assert.equal(f.runs.length, 2)
    const cursor = f.runtime.readData(original.cursorKey)
    await f.close(true); current = undefined
    current = fixture(configuration, directory); const reopened = current
    await reopened.initialize(); ancestryWorker(reopened); reopened.respond(url => ancestryResponse(messages, url))
    assert.deepEqual(reopened.runtime.readData(original.cursorKey), cursor)
    reopened.chooseWarnings('Confirm each tool', 'Keep replies local'); await reopened.start(); await reopened.poll()
    await new Promise(resolve => setTimeout(resolve, 25)); verify(reopened)
    assert.equal(reopened.runs.length, 0, 'Repeated source polling after restart must not repeat already-read work')
    assert.equal(reopened.runtime.repositories.automation().sessions.find(session => session.ticketId === original.ticketId)!.sessionId, original.sessionId)
  } finally { if (current) await current.close(); else rmSync(directory, { recursive: true, force: true }) }
})

test('Teams failed ancestry retains its cursor while another scope commits and later recovery resumes the same worker', async () => {
  const otherChat = '19:independent@thread.v2'
  const configuration = { 'teams.tenantId': tenant, 'teams.chatIds': [chat], 'teams.allowedActors': [nativeActor] }
  let current: ReturnType<typeof fixture> | undefined = fixture(configuration)
  const directory = current.directory, messages = ancestryMessages()
  try {
    const f = current, original = await startAncestryTicket(f), before = f.runtime.readData(original.cursorKey)
    f.values['teams.chatIds'] = [chat, otherChat]
    const independent = { ...teamsMessage('900', nativeActor), chatId: otherChat, mentions: [{ mentioned: { user: { id: account } } }],
      body: { contentType: 'text', content: 'Independent approved scope progressed' } }
    const respond = (missing: boolean, url: URL) => {
      if (url.pathname === ancestryPath(otherChat)) return { value: [independent] }
      if (url.pathname === ancestryPath(chat, '101') && missing) return Response.json({ error: { code: 'NotFound', message: 'Missing ancestor101' } }, { status: 404 })
      return ancestryResponse(messages, url)
    }
    f.respond(url => respond(true, url))
    await assert.rejects(f.poll(), /Teams|ancestor|ancestr|thread/i)
    assert.deepEqual(f.runtime.readData(original.cursorKey), before)
    assert.equal(f.runtime.repositories.snapshot().triggers.some(trigger => (trigger.meta.provider as { messageId?: string } | undefined)?.messageId === '102'), false)
    assert.ok(f.runtime.repositories.snapshot().triggers.some(trigger => trigger.text === 'Independent approved scope progressed'))
    const otherKeys = Object.keys(f.runtime.repositories.automation().metadata).filter(key => key.startsWith('source:teams:') && key !== original.cursorKey)
    assert.equal(otherKeys.length, 1); assert.ok(f.runtime.readData(otherKeys[0]!))
    assert.match(f.runtime.repositories.automation().health.at(-1)!.error, /ancestor|ancestr|unverif|lookup|reply.*(?:root|thread)/i)
    assert.equal(f.runs.length, 1)
    await f.close(true); current = undefined
    const recoveredConfiguration = { ...configuration, 'teams.chatIds': [chat, otherChat] }
    current = fixture(recoveredConfiguration, directory); const reopened = current
    await reopened.initialize(); ancestryWorker(reopened); reopened.respond(url => respond(false, url))
    assert.deepEqual(reopened.runtime.readData(original.cursorKey), before)
    reopened.chooseWarnings('Confirm each tool', 'Keep replies local'); await reopened.start(); await reopened.poll()
    await ancestryWait(() => reopened.runs.length === 1 && ancestryIdle(reopened))
    assert.equal(reopened.runs[0]!.ticketId, original.ticketId); assert.equal(reopened.runs[0]!.sessionId, original.sessionId)
    const latest = reopened.runtime.repositories.snapshot().triggers.find(trigger => (trigger.meta.provider as { messageId?: string } | undefined)?.messageId === '102')!
    assert.equal((latest.meta.provider as { rootMessageId: string }).rootMessageId, '100')
    assert.notDeepEqual(reopened.runtime.readData(original.cursorKey), before)
    await reopened.poll(); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(reopened.runs.length, 1)
  } finally { if (current) await current.close(); else rmSync(directory, { recursive: true, force: true }) }
})

for (const change of ['native source', 'saved policy', 'accept mode', 'cancellation'] as const) {
  test(`Teams ancestry lookup cannot commit after late ${change}`, async () => {
    const f = fixture({ 'teams.tenantId': tenant, 'teams.chatIds': [chat], 'teams.allowedActors': [nativeActor] })
    let release!: () => void, started = false, finished = false
    const ancestor = new Promise<void>(resolve => { release = resolve })
    try {
      const original = await startAncestryTicket(f), before = f.runtime.readData(original.cursorKey), messages = ancestryMessages()
      if (change === 'accept mode') {
        await f.save({ sources: { teams: { allowedActors: [], admission: { unlistedAddressed: 'inferred' } } } })
        Object.assign(messages.latest, { mentions: [{ mentioned: { user: { id: account } } }] })
      }
      f.respond(async url => {
        if (url.pathname === ancestryPath(chat, '101')) { started = true; await ancestor }
        return ancestryResponse(messages, url)
      })
      const poll = f.poll().then(() => { finished = true; return undefined }, error => { finished = true; return error })
      await ancestryWait(() => started || finished)
      assert.equal(started, true, 'The incremental reply must verify its absent parent before committing a cursor')
      let stopping: Promise<unknown> | undefined
      if (change === 'native source') f.values['teams.chatIds'] = ['19:replacement@thread.v2']
      else if (change === 'saved policy') await f.save({ sources: { teams: { allowedActors: [] } } })
      else if (change === 'accept mode') await f.save({ acceptMode: 'observe' })
      else { stopping = f.stop(); await ancestryWait(() => !f.snapshot().settings.value.enabled) }
      release()
      const error = await poll
      if (change !== 'cancellation') assert.ok(error, 'A stale Teams generation must reject rather than commit old source events')
      if (stopping) await stopping
      assert.deepEqual(f.runtime.readData(original.cursorKey), before)
      assert.equal(f.runtime.repositories.snapshot().triggers.some(trigger => (trigger.meta.provider as { messageId?: string } | undefined)?.messageId === '102'), false)
      assert.equal(f.runs.length, 1)
      if (change === 'accept mode') {
        await f.poll()
        const received = f.runtime.repositories.snapshot().triggers.find(trigger => (trigger.meta.provider as { messageId?: string } | undefined)?.messageId === '102')!
        assert.ok(received, 'A fresh poll must rebuild the preflight for the now-observed inferred admission')
        assert.equal((received.meta.provider as { rootMessageId: string }).rootMessageId, '100')
        assert.notDeepEqual(f.runtime.readData(original.cursorKey), before)
        await new Promise(resolve => setTimeout(resolve, 15))
        assert.equal(f.runs.length, 1, 'Observe mode must not turn the newly observed event into worker input')
      }
    } finally { release(); await f.close() }
  })
}


const admissionConfiguration = { 'github.repository': 'company/project', 'github.allowedActors': [],
  'teams.tenantId': tenant, 'teams.chatIds': [chat], 'teams.allowedActors': [], 'execution.permissionMode': 'ticket' }
const admissionState = (f: ReturnType<typeof fixture>) => structuredClone({ settings: f.snapshot().settings, history: f.runtime.repositories.automation().history })
function assertAdmissionDisclosure(entry: HostWarning, scope: string) {
  assert.ok(entry.detail.includes(scope), `Consent must identify its configured scope: ${scope}`)
  assert.match(entry.detail, /unlisted|not (?:on|in).*allowlist|outside.*(?:allowlist|allowedActors)/i)
  assert.match(entry.detail, /operator|your (?:os |operating.system )?(?:user|account)|as you/i)
  assert.match(entry.detail, /command|tool/i)
}

for (const family of ['github', 'teams'] as const) {
  test(`${family} native unlisted admission consent can be dismissed without any settings commit and approved explicitly`, async () => {
    const f = fixture(admissionConfiguration)
    try {
      await f.initialize()
      const before = admissionState(f), warnings = f.warnings.length, scope = family === 'github' ? 'company/project' : chat
      const value = { enabled: true, acceptMode: 'off', sources: { [family]: { admission: { unlistedAddressed: 'explicit' } } } }
      let offered: HostWarning | undefined
      f.onWarning(entry => { offered = entry; assert.deepEqual(admissionState(f), before); return undefined })
      const declined = await f.save(value).catch(() => undefined)
      assert.equal(f.warnings.length, warnings + 1, 'A wildcard grant requires native informed consent before its save')
      assert.ok(offered); assertAdmissionDisclosure(offered, scope); assert.match(offered.detail, /explicit|addressed|mention/i)
      assert.match(offered.detail, /future|fallback/i, 'The inherited family grant must disclose its future configured scopes')
      assert.deepEqual(admissionState(f), before); assert.equal(declined, undefined)
      f.onWarning(entry => {
        assertAdmissionDisclosure(entry, scope)
        if (family === 'github') value.sources[family]!.admission.unlistedAddressed = 'ignore'
        return entry.choices[0]
      })
      const accepted = await f.save(value)
      assert.ok(accepted); assert.equal(accepted.settings.revision, before.settings.revision + 1)
      assert.equal(f.snapshot().settings.value.sources[family].admission!.unlistedAddressed, 'explicit')
      assert.equal(f.runtime.repositories.automation().history.length, before.history.length + 1)
      const committed = admissionState(f)
      value.sources[family]!.admission.unlistedAddressed = 'inferred'
      assert.deepEqual(admissionState(f), committed, 'Mutating the raw draft after save cannot change settings, revision or retained history')
    } finally { await f.close() }
  })
}

test('native unlisted consent covers activation of dormant inferred unaddressed policy', async () => {
  const f = fixture(admissionConfiguration)
  try {
    await f.initialize(); const initialWarnings = f.warnings.length
    await f.save({ enabled: true, acceptMode: 'off', sources: { teams: { enabled: false, allowUnaddressed: false, admission: { unlistedUnaddressed: 'inferred' } } } })
    assert.equal(f.warnings.length, initialWarnings + 1, 'Saving a new dormant grant still requires informed consent')
    assert.match(f.warnings.at(-1)!.detail, /dormant|disabled|off/i)
    const before = admissionState(f), activate = { acceptMode: 'auto', sources: { teams: { enabled: true, allowUnaddressed: true } },
      rules: [{ id: 'approved-repair', name: 'Approved repair', instruction: 'Repair the specifically observed defect', enabled: true }] }
    f.onWarning(() => undefined); await f.save(activate).catch(() => undefined)
    assert.equal(f.warnings.length, initialWarnings + 2); assert.deepEqual(admissionState(f), before)
    const disclosure = f.warnings.at(-1)!; assertAdmissionDisclosure(disclosure, chat); assert.match(disclosure.detail, /inferred|unaddressed|observation/i)
    f.onWarning(undefined); await f.save(activate)
    assert.equal(f.snapshot().settings.value.acceptMode, 'auto'); assert.equal(f.snapshot().settings.value.sources.teams.allowUnaddressed, true)
  } finally { await f.close() }
})

test('native unlisted consent also protects restoring a historically broader policy', async () => {
  const f = fixture(admissionConfiguration)
  try {
    await f.initialize(); await f.save({ enabled: true, acceptMode: 'off', sources: { github: { admission: { unlistedAddressed: 'explicit' } } } })
    const historical = f.snapshot().settings.revision
    await f.save({ sources: { github: { admission: { unlistedAddressed: 'ignore' } } } })
    const before = admissionState(f), count = f.warnings.length
    f.chooseWarnings('Cancel'); const declined = await f.restore(historical).catch(() => undefined)
    assert.equal(f.warnings.length, count + 1); assert.equal(declined, undefined); assert.deepEqual(admissionState(f), before)
    assertAdmissionDisclosure(f.warnings.at(-1)!, 'company/project')
    const restored = await f.restore(historical)
    assert.ok(restored); assert.equal(restored.action, 'restoreSettings'); assert.equal(restored.settings.revision, before.settings.revision + 1)
    assert.equal(f.snapshot().settings.value.sources.github.admission!.unlistedAddressed, 'explicit')
  } finally { await f.close() }
})

test('native unlisted consent is absent for unchanged, narrowed and invalid policy saves', async () => {
  const f = fixture(admissionConfiguration)
  try {
    await f.initialize(); await f.save({ enabled: true, sources: { github: { admission: { unlistedAddressed: 'explicit' } } } })
    const count = f.warnings.length
    await f.save(structuredClone(f.snapshot().settings.value))
    await f.save({ sources: { github: { admission: { unlistedAddressed: 'ignore' } } } })
    const beforeInvalid = admissionState(f)
    await assert.rejects(f.save({ sources: { github: { admission: { unlistedUnaddressed: 'explicit' } } } }), /Invalid admission/)
    await assert.rejects(f.save({ sources: { github: { admission: { unlistedAddressed: 'explicit' } } },
      prompts: { overrides: { 'unknown/prompt-part': { text: 'Invalid draft cannot request policy consent' } } } }), /Unknown prompt part/)
    assert.equal(f.warnings.length, count); assert.deepEqual(admissionState(f), beforeInvalid)
  } finally { await f.close() }
})

for (const change of ['revision', 'native scope', 'permission mode'] as const) {
  test(`native unlisted consent refuses a reviewed candidate after a concurrent ${change} change`, async () => {
    const f = fixture(admissionConfiguration)
    let release!: () => void, offered: HostWarning | undefined, done = false
    const decision = new Promise<void>(resolve => { release = resolve })
    try {
      await f.initialize(); const before = admissionState(f)
      f.onWarning(async entry => { offered = entry; await decision; return entry.choices[0] })
      const save = f.save({ enabled: true, sources: { github: { admission: { unlistedAddressed: 'explicit' } } } })
        .then(value => { done = true; return { value } }, error => { done = true; return { error } })
      await ancestryWait(() => !!offered || done)
      assert.ok(offered, 'The widened policy must wait in a native confirmation before it can commit')
      assert.deepEqual(admissionState(f), before)
      if (change === 'revision') {
        await f.save({ prompts: { communication: 'A concurrently committed setting' } })
      } else if (change === 'native scope') f.values['github.repository'] = 'company/replacement'
      else f.values['execution.permissionMode'] = 'ask'
      const concurrent = admissionState(f); release()
      const result = await save
      assert.ok('error' in result, 'The stale approval must fail rather than save under a different settings or native execution boundary')
      assert.deepEqual(admissionState(f), concurrent)
      assert.equal(f.snapshot().settings.value.sources.github.admission?.unlistedAddressed, undefined)
    } finally { release(); await f.close() }
  })
}

test('persisted unlisted grants are disclosed on native Start while reopen and polling do not add consent prompts', async () => {
  const configuration = { 'github.repository': 'company/project', 'github.allowedActors': [], 'execution.permissionMode': 'ticket' }
  let current: ReturnType<typeof fixture> | undefined = fixture(configuration)
  const directory = current.directory
  try {
    await current.initialize(); await current.save({ enabled: true, acceptMode: 'off', sources: { github: { admission: { unlistedAddressed: 'explicit' } } } })
    await current.close(true); current = undefined
    current = fixture({ ...configuration, 'service.enabled': true }, directory); const reopened = current
    reopened.respond(() => []); await reopened.initialize(); await reopened.poll(); await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(reopened.warnings.length, 0, 'Reopening and ordinary unattended polling retain the existing consent without per-request modals')
    reopened.onWarning(entry => entry.message.startsWith('Enable replies') ? 'Keep replies local' : entry.choices[0])
    await reopened.start()
    const start = reopened.warnings.find(entry => entry.message.startsWith('Start continuous Superagent work'))!
    assert.ok(start); assertAdmissionDisclosure(start, 'company/project'); assert.match(start.detail, /explicit|addressed|mention/i)
    assert.equal(reopened.warnings.length, 2)
    await reopened.poll(); assert.equal(reopened.warnings.length, 2)
  } finally { if (current) await current.close(); else rmSync(directory, { recursive: true, force: true }) }
})

test('an unlisted explicit wildcard request starts actual work only after native admission consent is accepted', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [], 'execution.permissionMode': 'ticket' })
  try {
    await f.initialize(); await f.save({ enabled: true, acceptMode: 'off', pollIntervalMs: 3_600_000 })
    f.respond(url => url.pathname === '/repos/company/project/issues' ? [githubIssue(42, 'outsider', 'User', '@agent repair the approved wildcard request')] : [])
    f.onAssessment(() => ({ kind: 'accept', title: 'Explicitly granted source repair', scope: 'Repair the approved source defect', reason: 'Addressed human request under approved wildcard policy' }))
    f.chooseWarnings('Run within approved tickets', 'Keep replies local'); await f.start(); await f.poll()
    assert.equal(f.runs.length, 0)
    const grant = { sources: { github: { admission: { unlistedAddressed: 'explicit' } } } }
    f.chooseWarnings(undefined); const before = admissionState(f); await f.save(grant).catch(() => undefined)
    assert.deepEqual(admissionState(f), before); await f.poll(); assert.equal(f.runs.length, 0)
    await f.save(grant); await f.poll()
    await ancestryWait(() => f.runs.length === 1 && ancestryIdle(f))
    assert.equal(f.runtime.list().length, 1); assert.equal(f.runtime.list()[0]!.mandate.strength, 'explicit')
    assert.equal(f.runtime.list()[0]!.mandate.actor.id, 'outsider'); assert.match(f.runs[0]!.prompt, /approved wildcard request/)
  } finally { await f.close() }
})

for (const family of ['github', 'teams'] as const) {
  test(`${family} native scoped admission authorizes only row A and revokes its running worker when that grant is removed`, async () => {
    const otherChat = '19:unapproved@thread.v2'
    const f = fixture({ ...admissionConfiguration, 'teams.chatIds': [chat, otherChat] })
    try {
      await f.initialize(); await f.save({ enabled: true, acceptMode: 'off', pollIntervalMs: 3_600_000 })
      const scope = family === 'github' ? `${githubThreadRef(repositoryConfig, 42).source}:issues` : `tenant:${tenant}:chat:${chat}`
      f.onAssessment(() => ({ kind: 'accept', title: 'Scoped source repair', scope: 'Only the explicitly approved row A request', reason: 'Approved exact source row' }))
      f.onWorker(async turn => { await new Promise<void>(resolve => { if (turn.signal.aborted) resolve(); else turn.signal.addEventListener('abort', () => resolve(), { once: true }) }) })
      f.respond(url => {
        if (url.origin === 'https://graph.microsoft.com') return { value: url.pathname.includes('/messages') ? [{ ...teamsMessage(url.pathname.includes(encodeURIComponent(otherChat)) ? '201' : '101', savedActor),
          mentions: [{ mentioned: { user: { id: account } } }], body: { contentType: 'text', content: url.pathname.includes(encodeURIComponent(otherChat)) ? 'ROW B MUST NOT EXECUTE' : 'ROW A approved work' } }] : [] }
        if (url.pathname === '/repos/company/project/issues') return [githubIssue(42, 'outsider', 'User', '@agent ROW A approved work')]
        if (url.pathname === '/repos/company/project/issues/comments') return [{ id: 201, user: { login: 'outsider', type: 'User' }, body: '@agent ROW B MUST NOT EXECUTE', updated_at: new Date().toISOString(), issue_url: 'https://api.github.com/repos/company/project/issues/43' }]
        return []
      })
      await f.save({ sources: { [family]: { admissionByScope: { [scope]: { unlistedAddressed: 'explicit' } } } } })
      const approval = f.warnings.at(-1)!; assertAdmissionDisclosure(approval, family === 'github' ? 'company/project' : chat)
      f.chooseWarnings('Run within approved tickets', 'Keep replies local'); await f.start(); await f.poll()
      await ancestryWait(() => f.runs.length === 1)
      const turn = f.runs[0]!, ticket = f.runtime.get(turn.ticketId)
      assert.match(turn.prompt, /ROW A approved work/); assert.doesNotMatch(turn.prompt, /ROW B MUST NOT EXECUTE/)
      assert.equal(f.runtime.list().length, 1); assert.equal(ticket.mandate.strength, 'explicit')
      assert.equal(f.runtime.repositories.snapshot().triggers.some(trigger => trigger.text.includes('ROW B MUST NOT EXECUTE')), false)
      await f.save({ sources: { [family]: { admissionByScope: {} } } })
      await ancestryWait(() => turn.signal.aborted)
      await assert.rejects(turn.tools.find(tool => tool.name === 'orchestrator_read')!.invoke({ resource: 'ticket' }), /authoriz|cancel|abort|stopp|policy|active/i)
      assert.equal(f.runs.length, 1); assert.equal(f.runtime.list().length, 1)
    } finally { await f.close() }
  })
}

test('native scoped admission consent catches a narrowing-row removal that reveals the broader family fallback', async () => {
  const f = fixture(admissionConfiguration)
  try {
    await f.initialize()
    const scope = `${githubThreadRef(repositoryConfig, 42).source}:issues`
    await f.save({ enabled: true, acceptMode: 'off', sources: { github: { admission: { unlistedAddressed: 'explicit' }, admissionByScope: { [scope]: { unlistedAddressed: 'ignore' } } } } })
    const before = admissionState(f), count = f.warnings.length
    f.chooseWarnings(undefined); await f.save({ sources: { github: { admissionByScope: {} } } }).catch(() => undefined)
    assert.equal(f.warnings.length, count + 1); assert.deepEqual(admissionState(f), before)
    assertAdmissionDisclosure(f.warnings.at(-1)!, 'company/project'); assert.match(f.warnings.at(-1)!.detail, /issues/i)
    await f.save({ sources: { github: { admissionByScope: {} } } })
    assert.equal(f.snapshot().settings.revision, before.settings.revision + 1)
  } finally { await f.close() }
})


test('native scoped CI-only admission starts rule-authorized work without scanning human source candidates', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [], 'github.allowedBots': [], 'github.observe': true })
  try {
    await f.initialize()
    const source = githubThreadRef(repositoryConfig, 1).source, row = `${source}:ci`
    await f.save({ enabled: true, acceptMode: 'auto', pollIntervalMs: 3_600_000,
      rules: [{ id: 'default-ci', name: 'Default branch CI repair', instruction: 'Repair the verified failing default branch check', enabled: true }],
      sources: { github: { admissionByScope: { [row]: { unlistedUnaddressed: 'inferred' } } } } })
    f.onAssessment(prompt => {
      assert.match(prompt, /Default branch main CI/); assert.match(prompt, /ci\/required: failure/)
      return { kind: 'accept', title: 'Repair authenticated default branch CI', scope: 'Repair only the verified failing main check', reason: 'Matched enabled CI rule', rules: ['default-ci'] }
    })
    f.onWorker(async turn => { await turn.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'ready', summary: 'Verified default branch CI repair reported' }) })
    const statusAt = new Date().toISOString()
    f.respond(url => url.pathname === `/repos/company/project/commits/${head}/statuses`
      ? [{ id: 701, context: 'ci/required', state: 'failure', updated_at: statusAt }] : [])
    f.chooseWarnings('Confirm each tool', 'Keep replies local'); await f.start(); await f.poll()
    await ancestryWait(() => f.runs.length === 1 && ancestryIdle(f), 'Verified native CI did not start its rule-authorized worker').catch(error => {
      throw new Error(`${error.message}: ${JSON.stringify({ errors: f.errors, health: f.runtime.repositories.automation().health, decisions: f.runtime.repositories.snapshot().decisions,
        effects: f.runtime.repositories.automation().effects.map(effect => ({ kind: effect.kind, status: effect.status, error: effect.error })), triggers: f.runtime.repositories.snapshot().triggers })}`)
    })
    const trigger = f.runtime.repositories.snapshot().triggers.find(trigger => (trigger.meta.provider as { kind?: string } | undefined)?.kind === 'branch-checks')!
    assert.ok(trigger); assert.equal(trigger.source, source); assert.equal(trigger.actor.id, 'github-actions[bot]'); assert.equal(trigger.human, false)
    assert.deepEqual(trigger.threads, [{ source, id: 'branch:main' }]); assert.equal(trigger.channel, undefined)
    const proof = f.runtime.readData<{ source: string; branch: string; head: string; event: string }>(`verified-default-ci:${trigger.id}`)!
    assert.ok(proof); assert.equal(proof.source, source); assert.equal(proof.branch, 'main'); assert.equal(proof.head, head); assert.match(proof.event, /^[a-f0-9]{64}$/)
    const ticket = f.runtime.get(f.runs[0]!.ticketId)
    assert.equal(ticket.origin.triggerId, trigger.id); assert.equal(ticket.mandate.strength, 'inferred'); assert.deepEqual(ticket.mandate.basis.rules, ['default-ci'])
    assert.equal(ticket.assignments.at(-1)!.report!.summary, 'Verified default branch CI repair reported'); assert.equal(ticket.ended?.outcome, 'completed')
    assert.ok(f.requests.some(({ url }) => url.pathname === `/repos/company/project/commits/${head}/statuses`))
    const candidates = f.requests.filter(({ url }) => /\/issues(?:\/comments)?$|\/pulls(?:\/comments|\/\d+\/reviews)?$/.test(url.pathname) && !url.searchParams.has('head'))
    assert.equal(candidates.length, 0, 'A CI-only admission row must not enable issue/comment/review candidate scans')
    assert.equal(f.runtime.repositories.automation().health.some(problem => problem.component === 'poll'), false)
    assert.deepEqual(f.errors, []); assert.ok(f.requests.every(({ url, authorization }) => url.origin === 'https://api.github.com' && authorization?.startsWith('Bearer github-credential-')))
  } finally { await f.close() }
})


test('native scoped CI status read cannot publish authority after the configured repository changes during its await', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [], 'github.allowedBots': [], 'github.observe': true })
  let release!: () => void, started = false, finished = false
  const pending = new Promise<void>(resolve => { release = resolve })
  try {
    await f.initialize()
    const row = `${githubThreadRef(repositoryConfig, 1).source}:ci`
    await f.save({ enabled: true, acceptMode: 'auto', pollIntervalMs: 3_600_000,
      rules: [{ id: 'default-ci', name: 'Default branch CI repair', instruction: 'Repair the verified default branch failure', enabled: true }],
      sources: { github: { admissionByScope: { [row]: { unlistedUnaddressed: 'inferred' } } } } })
    f.onAssessment(() => ({ kind: 'accept', title: 'Repair authenticated default branch CI', scope: 'Repair the verified main check', reason: 'Matched enabled CI rule', rules: ['default-ci'] }))
    f.onWorker(async turn => { await turn.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'ready', summary: 'This stale work must never start' }) })
    const statusAt = new Date().toISOString()
    f.respond(async url => {
      if (url.pathname !== `/repos/company/project/commits/${head}/statuses`) return []
      started = true; await pending
      return [{ id: 702, context: 'ci/required', state: 'failure', updated_at: statusAt }]
    })
    f.chooseWarnings('Confirm each tool', 'Keep replies local'); await f.start()
    const poll = f.poll().then(() => { finished = true; return undefined }, error => { finished = true; return error })
    await ancestryWait(() => started || finished, 'The CI integration did not reach its authenticated deferred status GET')
    assert.equal(started, true)
    f.values['github.repository'] = 'company/replacement'
    release(); const error = await poll
    assert.ok(error); assert.match(String(error), /Default-branch CI|GitHub|source/i)
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(f.runtime.repositories.snapshot().triggers.some(trigger => (trigger.meta.provider as { kind?: string } | undefined)?.kind === 'branch-checks'), false)
    assert.equal(Object.keys(f.runtime.repositories.automation().metadata).some(key => key.startsWith('verified-default-ci:')), false)
    assert.equal(f.runtime.list().length, 0); assert.equal(f.runs.length, 0)
  } finally { release(); await f.close() }
})


const githubGenerationKey = (repository = 'company/project') => `source:github:${githubThreadRef({ ...repositoryConfig, repository }, 1).source}`
async function githubGenerationFixture(f: ReturnType<typeof fixture>, running = false) {
  await f.initialize(); await f.save({ enabled: true, acceptMode: 'off', pollIntervalMs: 3_600_000 })
  f.respond(url => url.origin === 'https://graph.microsoft.com' ? { value: [] } : [])
  if (running) { f.chooseWarnings('Confirm each tool', 'Keep replies local'); await f.start() }
  await f.poll()
}

for (const change of ['repository', 'requesters', 'accept mode', 'saved policy'] as const) {
  test(`GitHub native generation rejects an ordinary issue batch after a deferred ${change} change and retries current scope`, async () => {
    const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': ['owner'],
      'teams.tenantId': tenant, 'teams.chatIds': [chat], 'teams.allowedActors': [nativeActor] })
    let release!: () => void, started = false, finished = false
    const waiting = new Promise<void>(resolve => { release = resolve })
    try {
      await githubGenerationFixture(f, true)
      const before = f.runtime.readData(githubGenerationKey())
      f.onAssessment(prompt => prompt.includes('FRESH_SCOPE_INPUT')
        ? { kind: 'accept', title: 'Current source repair', scope: 'Repair only the fresh current-scope request', reason: 'Explicit current sender' }
        : { kind: 'ignore', reason: 'Only recording independent source progress' })
      const stale = githubIssue(501, 'owner', 'User', '@agent OLD_SCOPE_INPUT')
      f.respond(async url => {
        if (url.origin === 'https://graph.microsoft.com') return { value: [{ ...teamsMessage('601', nativeActor), mentions: [{ mentioned: { user: { id: account } } }], body: { contentType: 'text', content: 'Independent Teams scope progressed' } }] }
        if (url.pathname === '/repos/company/project/issues') { started = true; await waiting; return [stale] }
        return []
      })
      const poll = f.poll().then(() => { finished = true; return undefined }, error => { finished = true; return error })
      await ancestryWait(() => started || finished, 'The ordinary GitHub issue read did not reach its deferred response'); assert.equal(started, true)
      if (change === 'repository') f.values['github.repository'] = 'company/replacement'
      else if (change === 'requesters') f.values['github.allowedActors'] = ['new-owner']
      else if (change === 'accept mode') await f.save({ acceptMode: 'observe' })
      else await f.save({ sources: { github: { allowedActors: ['new-owner'] } } })
      release(); const error = await poll
      assert.deepEqual(f.runtime.readData(githubGenerationKey()), before)
      assert.equal(f.runtime.repositories.snapshot().triggers.some(trigger => trigger.text.includes('OLD_SCOPE_INPUT')), false)
      assert.ok(error, 'The stale issue batch must fail before publishing its events or cursor')
      assert.ok(f.runtime.repositories.snapshot().triggers.some(trigger => trigger.text === 'Independent Teams scope progressed'), 'A stale GitHub source must not prevent independent Teams progress')
      assert.equal(f.runs.length, 0)
      const repository = change === 'repository' ? 'company/replacement' : 'company/project', actor = ['requesters', 'saved policy'].includes(change) ? 'new-owner' : 'owner'
      f.respond(url => url.origin === 'https://graph.microsoft.com' ? { value: [] }
        : url.pathname === `/repos/${repository}/issues` ? [githubIssue(502, actor, 'User', '@agent FRESH_SCOPE_INPUT')] : [])
      await f.poll(); await ancestryWait(() => f.runs.some(run => run.prompt.includes('FRESH_SCOPE_INPUT')) && ancestryIdle(f))
      const fresh = f.runtime.repositories.snapshot().triggers.find(trigger => trigger.text.includes('FRESH_SCOPE_INPUT'))!
      assert.equal((fresh.meta.provider as { repository: string }).repository, repository); assert.equal(fresh.actor.id, actor)
      assert.ok(f.runtime.readData(githubGenerationKey(repository)))
    } finally { release(); await f.close() }
  })
}

test('GitHub native generation is captured before credentials and prevents stale legacy-binding migration', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': ['owner'] })
  let release!: () => void, started = false, finished = false
  const waiting = new Promise<void>(resolve => { release = resolve })
  try {
    await githubGenerationFixture(f)
    const ticket = f.runtime.create('Preserve the approved legacy PR binding'), legacy = oldPullRef(42), canonical = githubThreadRef(repositoryConfig, 42)
    f.runtime.engine.bindThread(ticket.id, legacy, true)
    const follows = structuredClone(f.runtime.get(ticket.id).follows), before = f.runtime.readData(githubGenerationKey()), requests = f.requests.length
    f.onGitHubCredential(async () => { started = true; await waiting })
    const poll = f.poll().then(() => { finished = true; return undefined }, error => { finished = true; return error })
    await ancestryWait(() => started || finished, 'Credential retrieval was not deferred'); assert.equal(started, true)
    f.values['github.allowedActors'] = []; release()
    const error = await poll
    assert.deepEqual(f.runtime.get(ticket.id).follows, follows); assert.equal(f.runtime.repositories.threads.get(`${canonical.source}:42`), undefined)
    assert.deepEqual(f.runtime.readData(githubGenerationKey()), before); assert.equal(f.requests.length, requests)
    assert.ok(error, 'A policy change during credentials must reject before legacy reconciliation or provider reads')
    f.values['github.allowedActors'] = ['owner']; f.onGitHubCredential(async () => {})
    f.respond(url => url.pathname.endsWith('/pulls/42') ? pull(42) : [])
    await f.poll()
    assert.ok(f.runtime.get(ticket.id).follows?.some(follow => follow.thread === `${canonical.source}:42`))
    assert.equal(f.runtime.get(ticket.id).follows?.some(follow => follow.thread === `${legacy.source}:${legacy.id}`), false)
  } finally { release(); await f.close() }
})

test('GitHub native generation preserves the review checkpoint after a repository change during review read', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': ['owner'] })
  let release!: () => void, started = false, finished = false
  const waiting = new Promise<void>(resolve => { release = resolve })
  try {
    await githubGenerationFixture(f)
    const row = (id: number, text: string) => ({ id, user: { login: 'owner', type: 'User' }, body: `@agent ${text}`, submitted_at: new Date().toISOString(), state: 'COMMENTED', commit_id: head })
    f.respond(async url => {
      if (url.pathname === '/repos/company/project/pulls') return [{ number: 7 }]
      if (url.pathname === '/repos/company/project/pulls/7/reviews') { started = true; await waiting; return [row(701, 'OLD_REVIEW_INPUT')] }
      return []
    })
    const poll = f.poll().then(() => { finished = true; return undefined }, error => { finished = true; return error })
    await ancestryWait(() => started || finished, 'The review scan did not reach its deferred page'); assert.equal(started, true)
    const before = structuredClone(f.runtime.readData(githubGenerationKey()))
    f.values['github.repository'] = 'company/replacement'; release()
    const error = await poll; assert.deepEqual(f.runtime.readData(githubGenerationKey()), before)
    assert.equal(f.runtime.repositories.snapshot().triggers.some(trigger => trigger.text.includes('OLD_REVIEW_INPUT')), false); assert.ok(error)
    f.respond(url => url.pathname === '/repos/company/replacement/pulls' ? [{ number: 7 }]
      : url.pathname === '/repos/company/replacement/pulls/7/reviews' ? [row(702, 'FRESH_REVIEW_INPUT')] : [])
    await f.poll()
    const fresh = f.runtime.repositories.snapshot().triggers.find(trigger => trigger.text.includes('FRESH_REVIEW_INPUT'))!
    assert.ok(fresh); assert.equal((fresh.meta.provider as { repository: string }).repository, 'company/replacement')
    assert.ok(f.runtime.readData(githubGenerationKey('company/replacement')))
  } finally { release(); await f.close() }
})

test('GitHub native generation prevents stale PR discovery bindings and discovery cursor advancement', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': ['owner'] })
  let release!: () => void, started = false, finished = false
  const waiting = new Promise<void>(resolve => { release = resolve })
  try {
    await githubGenerationFixture(f)
    const ticket = f.runtime.create('Discover only a current repository PR'), source = githubThreadRef(repositoryConfig, 42).source, key = `source:github-discovery:${source}`
    const candidate = (repository: string) => ({ ...pull(42), user: { login: 'agent' }, head: { sha: head, ref: `superagent/${ticket.id}`, repo: { full_name: repository } } })
    const before = f.runtime.readData(key)
    f.respond(async url => {
      if (url.searchParams.has('head')) { started = true; await waiting; return [candidate('company/project')] }
      return []
    })
    const poll = f.poll().then(() => { finished = true; return undefined }, error => { finished = true; return error })
    await ancestryWait(() => started || finished, 'PR discovery did not reach its deferred lookup'); assert.equal(started, true)
    f.values['github.repository'] = 'company/replacement'; release(); const error = await poll
    assert.deepEqual(f.runtime.readData(key), before); assert.equal(f.runtime.get(ticket.id).follows?.length ?? 0, 0)
    assert.equal(f.runtime.repositories.threads.get(`${source}:42`), undefined); assert.ok(error)
    f.respond(url => url.searchParams.has('head') ? [candidate('company/replacement')] : url.pathname.endsWith('/pulls/42') ? pull(42) : [])
    await f.poll()
    const current = githubThreadRef({ ...repositoryConfig, repository: 'company/replacement' }, 42)
    assert.ok(f.runtime.get(ticket.id).follows?.some(follow => follow.thread === `${current.source}:42` && follow.own))
    assert.equal(f.runtime.readData(`source:github-discovery:${current.source}`), ticket.id)
  } finally { release(); await f.close() }
})

test('GitHub native generation cannot close a known PR from a lifecycle response after its repository changes', async () => {
  const f = fixture({ 'github.repository': 'company/project', 'github.allowedActors': [] })
  let release!: () => void, started = false, finished = false, reads = 0
  const waiting = new Promise<void>(resolve => { release = resolve })
  try {
    await githubGenerationFixture(f)
    const ticket = followPull(f.runtime, 42), ref = githubThreadRef(repositoryConfig, 42)
    f.runtime.begin(ticket.id); f.runtime.report(ticket.id, 'ready', 'Ready pending verified merge')
    f.respond(async url => {
      if (url.pathname === '/repos/company/project/pulls/42') {
        if (++reads === 1) return pull(42)
        started = true; await waiting; return pull(42, true, true)
      }
      return []
    })
    const poll = f.poll().then(() => { finished = true; return undefined }, error => { finished = true; return error })
    await ancestryWait(() => started || finished, 'Known PR lifecycle did not reach its deferred read'); assert.equal(started, true)
    f.values['github.repository'] = 'company/replacement'; release(); const error = await poll
    assert.equal(f.runtime.get(ticket.id).follows!.find(follow => follow.thread === `${ref.source}:42`)!.closed, undefined)
    assert.equal(f.runtime.get(ticket.id).ended, undefined); assert.ok(error)
    f.values['github.repository'] = 'company/project'; f.respond(url => url.pathname.endsWith('/pulls/42') ? pull(42, true, true) : [])
    await f.poll()
    assert.equal(f.runtime.get(ticket.id).follows!.find(follow => follow.thread === `${ref.source}:42`)!.closed?.outcome, 'merged')
  } finally { release(); await f.close() }
})


type LiveTarget = 'github' | 'chat' | 'channel'
const liveShell: PermissionRequest = { kind: 'shell', fullCommandText: 'npm test', commands: [], intention: 'Run the approved ticket verification',
  hasWriteFileRedirection: false, possiblePaths: [], possibleUrls: [], canOfferSessionApproval: false }
function liveConfiguration(target: LiveTarget): Record<string, unknown> {
  return target === 'github' ? { 'github.repository': 'company/project', 'github.allowedActors': ['owner'] }
    : { 'teams.tenantId': tenant, 'teams.allowedActors': [nativeActor], 'teams.chatIds': target === 'chat' ? [chat] : [], 'teams.channels': target === 'channel' ? [channel] : [] }
}
function liveTrigger(f: ReturnType<typeof fixture>, target: LiveTarget, review = false) {
  const common = { sourceConfigId: 'native-live-scope', nativeThreadId: target === 'github' ? '42' : '100', human: true, bot: false, allowedActor: true, subscribed: true, addressed: 'mention' as const, createdAt: new Date().toISOString() }
  const context: SourceContext = target === 'github'
    ? { ...common, provider: 'github', origin: String(f.values['github.origin'] ?? 'https://api.github.com'), repository: String(f.values['github.repository']), account: 'agent', number: 42,
      isPullRequest: review, kind: review ? 'review-comment' : 'comment', commentId: review ? 301 : 100, ...(review ? { reviewRootCommentId: 300, reviewThreadId: 'PRRT_live_scope' } : {}) }
    : { ...common, provider: 'teams', tenantId: String(f.values['teams.tenantId']), rootMessageId: '100', messageId: '101',
      ...(target === 'chat' ? { chatId: (f.values['teams.chatIds'] as string[])[0]! } : (f.values['teams.channels'] as typeof channel[])[0]!) }
  return sourceTrigger({ id: `live-native-${target}${review ? '-review' : ''}`, source: target === 'github' ? 'github' : 'teams', actor: target === 'github' ? 'owner' : nativeActor,
    text: 'LIVE_SCOPE_ORIGINAL_REQUEST', thread: common.nativeThreadId, context, url: target === 'github' ? `https://github.com/company/project/pull/42#${review ? 'discussion_r301' : 'issuecomment-100'}` : `https://teams.microsoft.com/l/message/${encodeURIComponent(chat)}/101` })
}
async function liveStart(f: ReturnType<typeof fixture>, target: LiveTarget, options: { local?: boolean; checkpoint?: boolean; preparing?: boolean; review?: boolean } = {}) {
  await f.initialize(); await f.save({ enabled: true, acceptMode: 'off', pollIntervalMs: 3_600_000, execution: { retryLimit: 0 } })
  f.respond(url => url.origin === 'https://graph.microsoft.com' ? { value: [] } : [])
  const trigger = liveTrigger(f, target, options.review)
  const ticket = options.local ? f.runtime.create('Locally approved imported work', { source: target === 'github' ? 'github' : 'teams', id: trigger.id, actor: trigger.actor.id, context: trigger.meta.provider as SourceContext, url: trigger.url }) : (() => {
    f.runtime.engine.receive(trigger)
    const decision = f.runtime.engine.decide(trigger.id, { kind: 'accept', title: 'Approved live source work', scope: 'Only the original source request', reason: 'Addressed listed requester' })
    return f.runtime.get(decision.ticketId!)
  })()
  f.onWorker(async request => {
    if (options.checkpoint) { await new Promise(resolve => setTimeout(resolve, 5)); await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'waiting', summary: 'Waiting at a durable source checkpoint' }) }
    else await new Promise<void>(resolve => { if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true }) })
  })
  f.chooseWarnings('Run within approved tickets', 'Keep replies local'); await f.start()
  if (!options.preparing) await ancestryWait(() => f.runs.length === 1 && (!options.checkpoint || ancestryIdle(f)), 'The live source fixture did not start its actual worker')
  return { ticketId: ticket.id, trigger, originId: ticket.origin.triggerId }
}

const liveChanges = [
  { label: 'GitHub repository', target: 'github', key: 'github.repository', next: 'company/replacement' },
  { label: 'GitHub origin', target: 'github', key: 'github.origin', next: 'https://github.example/api/v3' },
  { label: 'Teams tenant', target: 'chat', key: 'teams.tenantId', next: account },
  { label: 'Teams chat', target: 'chat', key: 'teams.chatIds', next: ['19:replacement@thread.v2'] },
  { label: 'Teams team', target: 'channel', key: 'teams.channels', next: [{ ...channel, teamId: account }] },
  { label: 'Teams channel', target: 'channel', key: 'teams.channels', next: [{ ...channel, channelId: '19:replacement@thread.tacv2' }] },
] as const
for (const change of liveChanges) {
  test(`live native ${change.label} withdrawal rejects permission and custom tools before an event, then aborts the active backend`, async () => {
    const f = fixture(liveConfiguration(change.target))
    try {
      const original = await liveStart(f, change.target), run = f.runs[0]!
      assert.equal((await f.permission(run, liveShell)).kind, 'approve-once')
      assert.equal((await f.permission({ ...run, sessionId: 'wrong-root-session' }, liveShell)).kind, 'reject')
      f.values[change.key] = structuredClone(change.next)
      assert.equal((await f.permission(run, liveShell)).kind, 'reject', 'Current native receiving identity must be checked without relying on a config event')
      await assert.rejects(run.tools.find(tool => tool.name === 'orchestrator_read')!.invoke({ resource: 'ticket' }), /authoriz|revok|scope|ended|abort/i)
      f.fireConfiguration(change.key)
      await ancestryWait(() => run.signal.aborted && f.aborts.includes(original.ticketId), 'The native configuration event did not abort the obsolete worker')
      assert.equal(f.runs.length, 1)
      assert.ok(f.runtime.repositories.triggers.get(original.originId), 'Revocation must retain the historical source request')
    } finally { await f.close() }
  })
}

test('live native held interactive approval rechecks source scope after the operator answers', async () => {
  const f = fixture(liveConfiguration('github'))
  let release!: () => void, offered = false, done = false
  const approval = new Promise<void>(resolve => { release = resolve })
  try {
    await liveStart(f, 'github'); const run = f.runs[0]!
    f.onWarning(async entry => { if (entry.message.startsWith('Allow shell')) { offered = true; await approval } return entry.choices[0] })
    const decision = Promise.resolve(f.permission(run, { ...liveShell, managedApprovalRequired: true })).then(value => { done = true; return value })
    await ancestryWait(() => offered || done); assert.equal(offered, true)
    f.values['github.repository'] = 'company/replacement'; release()
    assert.equal((await decision).kind, 'reject', 'An old-scope consent dialog cannot approve a command after its source has been withdrawn')
    f.fireConfiguration('github.repository'); await ancestryWait(() => run.signal.aborted)
  } finally { release(); await f.close() }
})

test('live native scope is revalidated after delayed preparation before any backend turn', async () => {
  const f = fixture(liveConfiguration('github'))
  let release!: () => void
  const preparation = new Promise<void>(resolve => { release = resolve })
  try {
    f.onPrepare(async () => preparation)
    const original = await liveStart(f, 'github', { preparing: true })
    await ancestryWait(() => f.prepares.includes(original.ticketId))
    f.values['github.repository'] = 'company/replacement'; release()
    await ancestryWait(() => f.runs.length > 0 || !f.runtime.repositories.automation().effects.some(effect => ['start', 'deliver'].includes(effect.kind) && effect.status === 'running'))
    assert.equal(f.runs.length, 0, 'No backend may start from a formerly valid mandate after async preparation')
    assert.ok(f.runtime.repositories.triggers.get(original.originId))
  } finally { release(); await f.close() }
})

for (const target of ['github', 'chat'] as const) {
  test(`live native ${target} withdrawal remains enforced for persisted assignments and sessions after reopen`, async () => {
    const configuration = liveConfiguration(target)
    let current: ReturnType<typeof fixture> | undefined = fixture(configuration)
    const directory = current.directory
    try {
      const original = await liveStart(current, target, { checkpoint: true }), sessionId = current.runs[0]!.sessionId
      const history = structuredClone(current.runtime.repositories.triggers.get(original.originId))
      await current.close(true); current = undefined
      const replacement = target === 'github' ? { 'github.repository': 'company/replacement' } : { 'teams.chatIds': ['19:replacement@thread.v2'] }
      current = fixture({ ...configuration, ...replacement }, directory); const reopened = current
      await reopened.initialize()
      try { reopened.runtime.followup(original.ticketId, 'Resume the original source work after storage reopen') } catch { /* A revoked persisted mandate may refuse the followup immediately. */ }
      reopened.respond(url => url.origin === 'https://graph.microsoft.com' ? { value: [] } : [])
      reopened.chooseWarnings('Run within approved tickets', 'Keep replies local'); await reopened.start()
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(reopened.runs.length, 0, 'A persisted session does not retain source authority after its exact receiving identity is removed')
      assert.equal(reopened.runtime.repositories.automation().sessions.find(session => session.ticketId === original.ticketId)!.sessionId, sessionId)
      assert.deepEqual(reopened.runtime.repositories.triggers.get(original.originId), history)
      assert.deepEqual(reopened.errors, [])
    } finally { if (current) await current.close(); else rmSync(directory, { recursive: true, force: true }) }
  })
}

test('live native equivalent GitHub URL and repository case retain the active grant', async () => {
  const f = fixture(liveConfiguration('github'))
  try {
    await liveStart(f, 'github'); const run = f.runs[0]!
    f.values['github.origin'] = 'https://API.GITHUB.COM/'; f.values['github.repository'] = 'COMPANY/PROJECT'
    assert.equal((await f.permission(run, liveShell)).kind, 'approve-once')
    f.fireConfiguration('github.origin', 'github.repository'); await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(run.signal.aborted, false); assert.ok(await run.tools.find(tool => tool.name === 'orchestrator_read')!.invoke({ resource: 'ticket' }))
  } finally { await f.close() }
})

test('live native Teams UUID normalization and additive scopes retain the original configured channel', async () => {
  const tenantWithLetters = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', teamWithLetters = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
  const original = { teamId: teamWithLetters, channelId: channel.channelId }
  const f = fixture({ ...liveConfiguration('channel'), 'teams.tenantId': tenantWithLetters, 'teams.channels': [original] })
  try {
    await liveStart(f, 'channel'); const run = f.runs[0]!
    f.values['teams.tenantId'] = tenantWithLetters.toUpperCase()
    f.values['teams.channels'] = [{ ...original, teamId: teamWithLetters.toUpperCase() }, { teamId: account, channelId: '19:added@thread.tacv2' }]
    f.values['teams.chatIds'] = ['19:added@thread.v2']
    assert.equal((await f.permission(run, liveShell)).kind, 'approve-once')
    f.fireConfiguration('teams.tenantId', 'teams.channels', 'teams.chatIds'); await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(run.signal.aborted, false); assert.ok(await run.tools.find(tool => tool.name === 'orchestrator_read')!.invoke({ resource: 'ticket' }))
  } finally { await f.close() }
})

for (const target of ['github', 'chat'] as const) {
  test(`live native locally approved ${target} import retains its worker and stored history while removed provider replies are revoked`, async () => {
    const f = fixture(liveConfiguration(target))
    try {
      const original = await liveStart(f, target, { local: true }), run = f.runs[0]!, history = structuredClone(f.runtime.repositories.triggers.get(original.originId))
      assert.equal(f.runtime.get(original.ticketId).mandate.actor.source, 'vscode')
      if (target === 'github') f.values['github.repository'] = 'company/replacement'
      else f.values['teams.chatIds'] = ['19:replacement@thread.v2']
      assert.equal((await f.permission(run, liveShell)).kind, 'approve-once', 'The local operator grant survives withdrawal of imported provider context')
      f.fireConfiguration(target === 'github' ? 'github.repository' : 'teams.chatIds'); await new Promise(resolve => setTimeout(resolve, 15))
      assert.equal(run.signal.aborted, false)
      const thread = original.trigger.threads[0]!, retained = await run.tools.find(tool => tool.name === 'orchestrator_read')!.invoke({ resource: `thread/${thread.source}:${thread.id}` })
      assert.ok(JSON.stringify(retained).includes('Locally approved imported work'))
      assert.deepEqual(f.runtime.repositories.triggers.get(original.originId), history)
      f.values['delivery.enabled'] = true
      await run.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'ready', summary: 'Locally authorized work completed after source removal' })
      await ancestryWait(() => f.runtime.get(original.ticketId).ended?.outcome === 'completed' && f.runtime.repositories.automation().effects.some(effect => effect.kind === 'outbound' && ['cancelled', 'failed', 'completed'].includes(effect.status)))
      assert.equal(f.runtime.repositories.automation().effects.find(effect => effect.kind === 'outbound')!.status, 'cancelled')
      assert.equal(f.requests.filter(request => request.method === 'POST').length, 0, 'The retained local grant does not authorize writes to removed provider scope')
    } finally { await f.close() }
  })
}

test('live native review resolution rechecks the removed channel after its authenticated GraphQL lookup', async () => {
  const f = fixture(liveConfiguration('github'))
  let release!: () => void, started = false, done = false
  const lookup = new Promise<void>(resolve => { release = resolve })
  try {
    const original = await liveStart(f, 'github', { local: true, review: true }), run = f.runs[0]!
    f.values['delivery.enabled'] = true
    f.respond(async (url, init) => {
      if (url.pathname !== '/graphql') return []
      const body = JSON.parse(String(init?.body))
      if (body.query.startsWith('query')) {
        started = true; await lookup
        return { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: 'PRRT_live_scope', isResolved: false, comments: { nodes: [{ databaseId: 300 }] } }], pageInfo: { hasNextPage: false } } } } } }
      }
      return { data: { resolveReviewThread: { thread: { id: 'PRRT_live_scope', isResolved: true } } } }
    })
    const resolution = run.tools.find(tool => tool.name === 'orchestrator_review_resolve')!.invoke({ trigger_id: original.originId }).then(value => { done = true; return { value } }, error => { done = true; return { error } })
    await ancestryWait(() => started || done, 'The review tool did not reach its exact authenticated lookup'); assert.equal(started, true)
    f.values['github.repository'] = 'company/replacement'; release()
    const outcome = await resolution
    const writes = f.requests.filter(request => request.body && JSON.parse(request.body).query?.startsWith('mutation'))
    assert.equal(writes.length, 0, 'A removed receiving channel must prevent the actual review mutation after its read await')
    assert.ok('error' in outcome); assert.equal((await f.permission(run, liveShell)).kind, 'approve-once')
  } finally { release(); await f.close() }
})

test('live native deferred reply revocation preserves an already-attempted journal instead of silently cancelling it', async () => {
  const f = fixture(liveConfiguration('github'))
  let release!: () => void, started = false
  const credential = new Promise<void>(resolve => { release = resolve })
  try {
    const original = await liveStart(f, 'github', { local: true }), run = f.runs[0]!
    await f.poll(); f.values['delivery.enabled'] = true
    f.onGitHubCredential(async () => { started = true; await credential })
    await run.tools.find(tool => tool.name === 'orchestrator_ack')!.invoke({ trigger_id: original.originId, text: 'Imported request acknowledged' })
    await ancestryWait(() => started)
    const effect = f.runtime.repositories.automation().effects.find(effect => effect.kind === 'outbound')!
    assert.ok(effect?.message); f.runtime.writeData(`delivery:${effect.message.id}`, { attempted: true })
    f.values['github.repository'] = 'company/replacement'; f.fireConfiguration('github.repository'); release()
    await ancestryWait(() => f.runtime.repositories.automation().effects.find(row => row.id === effect.id)!.status === 'failed')
    assert.deepEqual(f.runtime.readData(`delivery:${effect.message.id}`), { attempted: true })
    assert.equal(f.requests.filter(request => request.method === 'POST').length, 0)
    assert.equal((await f.permission(run, liveShell)).kind, 'approve-once')
  } finally { release(); await f.close() }
})
