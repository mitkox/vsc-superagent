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

function fixture(initial: Record<string, unknown> = {}, storageDirectory?: string) {
  const directory = storageDirectory ?? mkdtempSync(join(tmpdir(), 'superagent-host-'))
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
  return { directory, runtime, values, requests, signins, errors, snapshot, get credentials() { return credentials },
    initialize: () => commands.get('superagent.dashboard')!(),
    start: () => commands.get('superagent.startService')!(),
    save: (value: unknown) => panel.action({ action: 'saveSettings', revision: snapshot().settings.revision, value }),
    restore: (revision: number) => panel.action({ action: 'restoreSettings', revision, baseRevision: snapshot().settings.revision }),
    poll: () => panel.action({ action: 'poll' }),
    respond: (handler: (url: URL) => unknown) => { response = handler },
    onSignIn: (handler: () => void) => { signIn = handler },
    close: async (preserveStorage = false) => { await lifecycle.shutdown(); runtime.dispose(); if (!preserveStorage) rmSync(directory, { recursive: true, force: true }) },
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

test('subscribed Teams human quoted receipts survive polling and durable reopen while authenticated self stays excluded', async () => {
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
    assert.ok(quote, 'Subscribed human quote must be delivered')
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
      assert.equal(host.runtime.get(ticket.id).inputs.filter(input => input.kind === 'trigger' && input.triggerId === quote.id).length, 1)
      assert.deepEqual(host.runtime.repositories.triggers.disposition(quote.id)?.fanout, [ticket.id])
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
