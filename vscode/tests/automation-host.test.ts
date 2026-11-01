import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { TicketRuntime } from '../src/runtime.ts'
import { githubThreadRef } from '../src/sources.ts'
import type { AutomationSettings } from '../src/settings.ts'
import type { PanelHost } from '../src/panel.ts'

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
const head = 'a'.repeat(40)
const githubIssue = (id: number, login: string, type = 'User', body = 'Repair the defect') => ({ id, number: id, title: 'Bug', body,
  user: { login, type }, updated_at: new Date().toISOString() })
const teamsMessage = (id: string, actor: string, application = false) => ({ id, messageType: 'message',
  from: application ? { application: { id: actor } } : { user: { id: actor, tenantId: tenant } },
  body: { contentType: 'text', content: 'Repair the defect' }, createdDateTime: new Date().toISOString() })

function fixture(initial: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-host-'))
  const runtime = new TicketRuntime(directory)
  const values: Record<string, unknown> = { ...initial }
  const commands = new Map<string, () => Promise<unknown>>()
  const requests: { url: URL; authorization: string | null }[] = [], signins: string[][] = []
  const errors: string[] = []
  let panel!: PanelHost, signIn: (() => void) | undefined, response: (url: URL) => unknown = () => []
  let credentials = 0
  const disposable = { dispose() {} }
  const api = {
    workspace: { getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => values[key] ?? fallback,
      update: async (key: string, value: unknown) => { values[key] = value },
    }) },
    authentication: { getSession: async (_provider: string, scopes: string[]) => {
      signins.push(scopes); signIn?.(); return { accessToken: 'graph-credential' }
    } },
    commands: { registerCommand: (name: string, callback: () => Promise<unknown>) => { commands.set(name, callback); return disposable } },
    window: { showErrorMessage: async (error: string) => { errors.push(error) },
      showWarningMessage: async (_message: string, _options: unknown, first: string) => first },
    lm: { registerTool: () => disposable },
    Uri: { joinPath: (_uri: unknown, ...parts: string[]) => ({ fsPath: join(directory, ...parts) }) },
    ConfigurationTarget: { Global: 1 },
  }
  const module = { exports: {} as { activateAutomation(context: unknown, hooks: unknown): { shutdown(): Promise<void> } } }
  runInNewContext(code, {
    module, exports: module.exports, require: (name: string) => name === 'vscode' ? api : name === './copilot.ts' ? {
      CopilotBackend: class { async check() { return { authenticated: true } } async dispose() {} },
    } : name === './panel.ts' ? { SuperagentPanel: class {
      constructor(host: PanelHost) { panel = host }
      show() {} refresh() {} dispose() {}
    } } : requireModule(name),
    process, Buffer, structuredClone, AbortController, AbortSignal, URL, URLSearchParams, setTimeout, clearTimeout, queueMicrotask,
    fetch: async (input: URL, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push({ url, authorization: new Headers(init?.headers).get('authorization') })
      if (url.origin === 'https://graph.microsoft.com' && url.pathname === '/v1.0/me') return Response.json({ id: account })
      if (url.pathname === '/repos/company/project') return Response.json({ default_branch: 'main' })
      if (url.pathname.endsWith('/branches/main')) return Response.json({ commit: { sha: head } })
      if (url.pathname.endsWith('/check-runs')) return Response.json({ check_runs: [] })
      return Response.json(response(url))
    },
  })
  const lifecycle = module.exports.activateAutomation({ subscriptions: [], extensionUri: {} }, {
    host: async () => ({ runtime, root: directory, identity: 'local-test', trees: { prepare: async () => directory } }),
    guard: () => 'local-test', changed() {}, github: async () => {
      credentials++
      return { origin: 'https://api.github.com', repository: values['github.repository'], account: 'agent',
        allowedActors: values['github.allowedActors'] ?? [], token: `github-credential-${credentials}` }
    },
  })
  const snapshot = () => panel.snapshot() as { settings: { revision: number; value: AutomationSettings } }
  return { runtime, values, requests, signins, errors, snapshot,
    initialize: () => commands.get('superagent.dashboard')!(),
    start: () => commands.get('superagent.startService')!(),
    save: (value: unknown) => panel.action({ action: 'saveSettings', revision: snapshot().settings.revision, value }),
    poll: () => panel.action({ action: 'poll' }),
    respond: (handler: (url: URL) => unknown) => { response = handler },
    onSignIn: (handler: () => void) => { signIn = handler },
    close: async () => { await lifecycle.shutdown(); runtime.dispose(); rmSync(directory, { recursive: true, force: true }) },
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
    assert.ok(f.requests.some(request => request.authorization === 'Bearer github-credential-2'))

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
      assert.equal(f.requests.filter(({ url }) => url.pathname.endsWith('/pulls')).length, 1, `${scenario.name}: own-PR discovery remains active`)
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
