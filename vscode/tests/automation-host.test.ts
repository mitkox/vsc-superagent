import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { TicketRuntime } from '../src/runtime.ts'
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
