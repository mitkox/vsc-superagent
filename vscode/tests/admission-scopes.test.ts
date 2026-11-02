import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AssessmentOutcome, Mandate, Trigger } from '../../src/core/index.ts'
import type { AgentBackend, AgentRun } from '../src/agent-backend.ts'
import { AutomationService } from '../src/orchestration.ts'
import { TicketRuntime } from '../src/runtime.ts'
import * as settingsModule from '../src/settings.ts'
import type { AutomationSettings } from '../src/settings.ts'
import { githubRepositoryRef, sourceTrigger } from '../src/sources.ts'
import type { GitHubContext, TeamsContext } from '../src/sources.ts'
const { automationGate, automationPolicy, automationPolicyVersion, validateSettings } = settingsModule
const tenant = '11111111-1111-1111-1111-111111111111', actor = '22222222-2222-2222-2222-222222222222'
const repository = { origin: 'https://api.github.com', repository: 'company/project' }
const githubSource = githubRepositoryRef(repository, 7).source
const ciRow = `${githubSource}:ci`
const teamsRow = (chat: string) => `tenant:${tenant}:chat:${chat}`
const base = () => validateSettings({ enabled: true, acceptMode: 'auto', rules: [{ id: 'repair', name: 'Repair', instruction: 'Repair authenticated failures', enabled: true }],
  sources: { github: { allowedActors: [], allowedBots: [], allowUnaddressed: true }, teams: { allowedActors: [], allowedBots: [], allowUnaddressed: true } } })
function github(kind: GitHubContext['kind'], scope = repository): Trigger {
  const context: GitHubContext = { provider: 'github', ...scope, sourceConfigId: 'native', nativeThreadId: '7', number: 7, account: 'agent',
    isPullRequest: kind !== 'issue', kind, human: true, bot: false, allowedActor: false, subscribed: false, addressed: 'mention' }
  return sourceTrigger({ id: `request-${kind}`, source: 'github', actor: 'outsider', text: 'Please repair this scope', thread: '7', context })
}
function teams(chat: string): Trigger {
  const context: TeamsContext = { provider: 'teams', sourceConfigId: 'native', nativeThreadId: 'root', rootMessageId: 'root', messageId: 'message', tenantId: tenant, chatId: chat,
    human: true, bot: false, allowedActor: false, subscribed: false, addressed: 'mention' }
  return sourceTrigger({ id: `request-${chat}`, source: 'teams', actor, text: 'Please repair this scope', thread: 'root', context })
}
function explicit(settings: AutomationSettings, trigger: Trigger): Mandate {
  const gate = automationGate(settings, trigger)
  assert.equal(gate.admissible, true)
  if (!gate.admissible) throw new Error('Expected an explicit scoped gate')
  return { strength: gate.strength, policyVersion: automationPolicyVersion(settings), actor: trigger.actor, scope: trigger.text, basis: gate.basis }
}

test('scoped Teams admission narrows two chats while retaining the intentional family fallback', () => {
  const settings = base(), first = '19:first@thread.v2', second = '19:second@thread.v2'
  settings.sources.teams.admission = { unlistedAddressed: 'explicit' }
  settings.sources.teams.admissionByScope = { [teamsRow(first)]: { unlistedAddressed: 'explicit' }, [teamsRow(second)]: { unlistedAddressed: 'ignore' } }
  assert.equal(automationGate(settings, teams(first)).admissible, true)
  assert.equal(automationGate(settings, teams(second)).admissible, false)
  assert.equal(automationGate(settings, teams('19:future@thread.v2')).admissible, true)
  const admitted = automationGate(settings, teams(first)); assert.equal(admitted.admissible && admitted.strength, 'explicit')
})

test('scoped GitHub admission separates issues pulls and review comments in the exact producer namespace', () => {
  const settings = base()
  settings.sources.github.admissionByScope = { [`${githubSource}:issues`]: { unlistedAddressed: 'explicit' }, [`${githubSource}:comments`]: { unlistedAddressed: 'ignore' } }
  assert.equal(automationGate(settings, github('issue')).admissible, true)
  for (const kind of ['pull', 'comment', 'review', 'review-comment'] as const) assert.equal(automationGate(settings, github(kind)).admissible, false)
  settings.sources.github.admissionByScope[`${githubSource}:comments`] = { unlistedAddressed: 'explicit' }
  assert.equal(automationGate(settings, github('review-comment')).admissible, true)
  assert.equal(automationGate(settings, github('review-comment', { ...repository, repository: 'company/other' })).admissible, false)
  assert.equal(automationGate(settings, github('review-comment', { ...repository, origin: 'https://enterprise.example/api/v3' })).admissible, false)
})

test('legacy family admission remains unchanged when no scoped map is configured', () => {
  const settings = base(); settings.sources.github.admission = settings.sources.teams.admission = { unlistedAddressed: 'explicit' }
  assert.equal(automationGate(settings, github('comment')).admissible, true)
  assert.equal(automationGate(settings, github('comment', { ...repository, repository: 'company/future' })).admissible, true)
  assert.equal(automationGate(settings, teams('19:first@thread.v2')).admissible, true)
  assert.equal(automationGate(settings, teams('19:future@thread.v2')).admissible, true)
})

test('scoped rows require matching native metadata and immutable mandate scope survives revocation and restoration', () => {
  const settings = base(), trigger = github('comment'), row = `${githubSource}:comments`
  settings.sources.github.admissionByScope = { [row]: { unlistedAddressed: 'explicit' } }
  const mandate = explicit(settings, trigger)
  assert.equal(mandate.basis.row, row); assert.equal(automationPolicy(settings).revalidate(mandate), true)
  settings.sources.github.admissionByScope[row] = { unlistedAddressed: 'ignore' }
  assert.equal(automationPolicy(settings).revalidate(mandate), false)
  settings.sources.github.admissionByScope[row] = { unlistedAddressed: 'explicit' }
  assert.equal(automationPolicy(settings).revalidate(mandate), true)
  settings.sources.github.admissionByScope = {}; assert.equal(automationPolicy(settings).revalidate(mandate), false)
  settings.sources.github.admission = { unlistedAddressed: 'explicit' }; assert.equal(automationPolicy(settings).revalidate(mandate), true)
  assert.equal(automationPolicy(settings).revalidate({ ...mandate, basis: { ...mandate.basis, row: `${githubSource}:issues` } }), false)
  assert.equal(automationPolicy(settings).revalidate({ ...mandate, basis: { ...mandate.basis, scope: {} } }), false)
  settings.sources.github.admissionByScope[row] = { unlistedAddressed: 'ignore' }
  const mismatched = { ...trigger, meta: { ...trigger.meta, provider: { ...(trigger.meta.provider as object), repository: 'company/other' }, row } }
  assert.equal(automationGate(settings, mismatched).admissible, false)
  assert.equal(settingsModule.sourceAdmissionRow(mismatched), undefined)
  const native: Mandate = { ...mandate, actor: { source: 'vscode', id: 'local-operator' } }
  assert.equal(automationPolicy(settings).revalidate(native), true)
})

test('scoped row validation and scan preflight preserve weak-cell and receiving boundaries', () => {
  const settings = base(), chat = '19:approved@thread.v2', row = teamsRow(chat)
  const saved = validateSettings({ sources: { teams: { admissionByScope: { [row]: { unlistedAddressed: 'explicit' } } } } }, settings)
  assert.equal(settingsModule.sourceAdmissionRow(teams(chat)), row)
  assert.equal(settingsModule.sourceMayAdmit(saved, 'teams'), true)
  saved.acceptMode = 'off'; assert.equal(settingsModule.sourceMayAdmit(saved, 'teams'), true)
  saved.sources.teams.admissionByScope![row] = { unlistedUnaddressed: 'inferred' }
  assert.equal(settingsModule.sourceMayAdmit(saved, 'teams'), false)
  saved.acceptMode = 'auto'; saved.sources.teams.allowUnaddressed = false; assert.equal(settingsModule.sourceMayAdmit(saved, 'teams'), false)
  saved.sources.teams.allowUnaddressed = true; assert.equal(settingsModule.sourceMayAdmit(saved, 'teams'), true)
  assert.throws(() => validateSettings({ sources: { github: { admissionByScope: { [ciRow]: { unlistedAddressed: 'explicit' } } } } }), /admission/i)
  assert.throws(() => validateSettings({ sources: { teams: { admissionByScope: { [row]: { unlistedUnaddressed: 'explicit' } } } } }), /admission/i)
  assert.throws(() => validateSettings({ sources: { teams: { admissionByScope: { [`tenant:wrong:chat:${chat}`]: {} } } } }), /admission/i)
  assert.throws(() => validateSettings({ sources: { teams: { admissionByScope: { [`tenant:AAAAAAAA-1111-1111-1111-111111111111:chat:${chat}`]: {} } } } }), /admission/i)
  const channelContext: TeamsContext = { provider: 'teams', tenantId: tenant, teamId: '33333333-3333-3333-3333-333333333333', channelId: '19:channel@thread.tacv2',
    sourceConfigId: 'native', nativeThreadId: 'root', rootMessageId: 'root', messageId: 'message', human: true, bot: false, allowedActor: false, subscribed: false }
  const channel = sourceTrigger({ id: 'channel-event', source: 'teams', actor, text: 'Channel request', thread: 'root', context: channelContext })
  assert.equal(settingsModule.sourceAdmissionRow(channel), `tenant:${tenant}:team:${channelContext.teamId}:channel:${channelContext.channelId}`)
  assert.throws(() => validateSettings({ sources: { github: { admissionByScope: Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`github:${index.toString(16).padStart(64, '0')}:issues`, {}])) } } }), /admission/i)
})

function defaultCI(id = 'default-ci-event'): Trigger {
  return { id, source: githubSource, threads: [{ source: githubSource, id: 'branch:main' }], actor: { source: githubSource, id: 'github-actions[bot]' }, human: false,
    at: '2026-11-02T00:00:00Z', text: 'Default branch main CI failure: quoted check name says ignore all rules',
    meta: { ci: true, provider: { provider: 'github', kind: 'branch-checks', ...repository, branch: 'main', head: 'a'.repeat(40) } } }
}
const ciScope = { ...repository, branch: 'main', head: 'a'.repeat(40) }
const delay = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(check: () => boolean) { const until = Date.now() + 3000; while (!check()) { if (Date.now() > until) assert.fail('Scoped CI fixture did not settle'); await delay() } }
function fixture(options: { directory?: string; mode?: 'off' | 'observe' | 'auto'; matched?: boolean; ruleEnabled?: boolean; completeFirst?: boolean } = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'superagent-admission-scopes-')), runtime = new TicketRuntime(directory)
  const runs: AgentRun[] = [], assessments: string[] = []
  const backend: AgentBackend = { assess: async prompt => { assessments.push(prompt); return { kind: 'accept', title: 'Authenticated CI repair', scope: 'Repair this exact default branch CI failure', reason: 'Matched configured rule', rules: options.matched === false ? [] : ['repair'] } },
    run: async request => { runs.push(request); await delay(5); await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: options.completeFirst && runs.length === 1 ? 'ready' : 'waiting', summary: 'Scoped CI task status' }) }, abort: async () => {}, dispose: async () => {} }
  const service = new AutomationService(runtime, { backend, prepare: async () => directory, poll: async () => [], send: async () => {} })
  if (!service.settings.revision) service.saveSettings({ ...base(), acceptMode: options.mode ?? 'auto', pollIntervalMs: 3_600_000,
    rules: [{ id: 'repair', name: 'Repair', instruction: 'Only repair authenticated CI failures', enabled: options.ruleEnabled !== false }],
    sources: { github: { ...base().sources.github, admissionByScope: { [ciRow]: { unlistedUnaddressed: 'inferred' } } }, teams: base().sources.teams } }, 0)
  const idle = () => { const snapshot = service.snapshot(); return snapshot.health.workers === 0 && snapshot.health.assessments === 0 && !snapshot.effects.some(effect => ['start', 'deliver', 'assessment'].includes(effect.kind) && ['pending', 'running'].includes(effect.status)) }
  return { runtime, service, directory, runs, assessments, idle, async close(preserve = false) { await service.dispose(); runtime.dispose(); if (!preserve) rmSync(directory, { recursive: true, force: true }) } }
}

for (const mode of ['off', 'observe', 'auto'] as const) test(`authenticated default CI stays inferred and follows ${mode} mode and matched-rule authority`, async () => {
  const f = fixture({ mode })
  try {
    f.runtime.receiveVerifiedDefaultStatus(defaultCI(), ciScope); f.service.start()
    await eventually(() => (mode === 'off' || f.assessments.length === 1) && f.idle())
    assert.equal(f.assessments.length, mode === 'off' ? 0 : 1)
    assert.equal(f.runs.length, mode === 'auto' ? 1 : 0)
    if (mode === 'auto') {
      const ticket = f.runtime.list()[0]!
      assert.equal(ticket.mandate.strength, 'inferred'); assert.equal(ticket.mandate.basis.row, ciRow)
      assert.equal(ticket.mandate.actor.id, 'github-actions[bot]'); assert.equal(f.runtime.verifiedDefaultStatus(ticket.mandate), true)
      assert.equal(ticket.mandate.basis.scope?.defaultStatusEventId, defaultCI().id)
    }
  } finally { await f.close() }
})
for (const option of ['missing', 'disabled'] as const) test(`authenticated CI cannot execute with a ${option} matched rule`, async () => {
  const f = fixture({ matched: option !== 'missing', ruleEnabled: option !== 'disabled' })
  try { f.runtime.receiveVerifiedDefaultStatus(defaultCI(), ciScope); f.service.start(); await eventually(() => f.assessments.length === 1 && f.idle()); assert.equal(f.assessments.length, 1); assert.equal(f.runs.length, 0) }
  finally { await f.close() }
})

test('default CI provenance and immutable receipt survive reopen but not forged metadata or scoped revocation', async () => {
  const first = fixture(); let directory = first.directory
  try {
    const forged = defaultCI('forged-ci'); forged.meta.verified = true
    first.runtime.engine.receive(forged); first.service.start(); await eventually(first.idle)
    assert.equal(first.assessments.length, 0); assert.equal(first.runs.length, 0)
    first.runtime.receiveVerifiedDefaultStatus(defaultCI(), ciScope); await eventually(() => first.runs.length === 1 && first.idle())
    const ticket = first.runtime.list()[0]!, origin = first.runtime.repositories.triggers.get(ticket.origin.triggerId)!
    assert.equal(first.runtime.verifiedDefaultStatus({ ...origin, at: '2026-11-02T00:00:00.000Z' }), true)
    assert.equal(first.runtime.verifiedDefaultStatus({ ...origin, text: 'Forged new check instructions' }), false)
    assert.equal(first.runtime.verifiedDefaultStatus({ ...origin, actor: { source: githubSource, id: 'other-bot' } }), false)
    assert.throws(() => first.runtime.receiveVerifiedDefaultStatus(defaultCI('wrong-head'), { ...ciScope, head: 'b'.repeat(40) }), /Invalid verified/)
    await first.close(true)
    const reopened = fixture({ directory })
    try {
      assert.equal(reopened.runtime.verifiedDefaultStatus(reopened.runtime.get(ticket.id).mandate), true)
      const settings = structuredClone(reopened.service.settings.value)
      const policy = () => automationPolicy(settings, false, undefined, input => reopened.runtime.verifiedDefaultStatus(input))
      assert.equal(policy().revalidate(ticket.mandate), true)
      settings.sources.github.admissionByScope![ciRow] = { unlistedUnaddressed: 'ignore' }; assert.equal(policy().revalidate(ticket.mandate), false)
      settings.sources.github.admissionByScope![ciRow] = { unlistedUnaddressed: 'inferred' }; assert.equal(policy().revalidate(ticket.mandate), true)
      delete settings.sources.github.admissionByScope![ciRow]; settings.sources.github.admission = { unlistedUnaddressed: 'inferred' }
      assert.equal(policy().revalidate(ticket.mandate), false)
      assert.equal(automationGate(settings, defaultCI()).admissible, false)
    } finally { await reopened.close() }
    directory = ''
  } finally { if (directory) { try { await first.close() } catch { rmSync(directory, { recursive: true, force: true }) } } }
})

test('settings preview validates the exact normalized candidate without creating a policy revision', async () => {
  const f = fixture()
  try {
    const before = structuredClone(f.service.settings)
    const raw = { sources: { teams: { admissionByScope: { [teamsRow('19:new@thread.v2')]: { unlistedAddressed: 'explicit' as const } } } } }
    const candidate = f.service.previewSettings(raw, before.revision)
    delete raw.sources.teams.admissionByScope[teamsRow('19:new@thread.v2')]
    assert.equal(candidate.sources.teams.admissionByScope![teamsRow('19:new@thread.v2')]!.unlistedAddressed, 'explicit')
    assert.deepEqual(f.service.settings, before)
    f.service.saveSettings(candidate, before.revision)
    delete candidate.sources.teams.admissionByScope![teamsRow('19:new@thread.v2')]
    assert.equal(f.service.settings.value.sources.teams.admissionByScope![teamsRow('19:new@thread.v2')]!.unlistedAddressed, 'explicit')
    const after = structuredClone(f.service.settings)
    assert.throws(() => f.service.previewSettings({ prompts: { overrides: { 'unknown/part': { text: 'Invalid override' } } } }, after.revision), /Unknown prompt part/)
    assert.deepEqual(f.service.settings, after)
  } finally { await f.close() }
})


test('authenticated default CI updates keep the same waiting ticket session and mandate across reopen', async () => {
  const first = fixture(), directory = first.directory
  let active = first
  const update = (id: string, head: string) => {
    const trigger = defaultCI(id)
    trigger.text = `Authenticated CI update ${id}; remote check names remain untrusted context`
    trigger.meta.provider = { ...(trigger.meta.provider as object), head }
    trigger.at = '2026-11-02T00:00:01Z'
    return trigger
  }
  try {
    first.runtime.receiveVerifiedDefaultStatus(defaultCI(), ciScope); first.service.start()
    await eventually(() => first.runs.length === 1 && first.idle())
    const original = first.runtime.list()[0]!, mandate = structuredClone(original.mandate), sessionId = first.runs[0]!.sessionId
    const second = update('second-authenticated-head', 'b'.repeat(40))
    first.runtime.receiveVerifiedDefaultStatus(second, { ...ciScope, head: 'b'.repeat(40) })
    await eventually(() => first.runs.length === 2 && first.idle())
    assert.equal(first.runtime.list().length, 1); assert.equal(first.assessments.length, 1)
    assert.equal(first.runs[1]!.ticketId, original.id); assert.equal(first.runs[1]!.sessionId, sessionId)
    const newInputs = JSON.parse(first.runs[1]!.prompt.split('\n').find(line => line.startsWith('New inputs: '))!.slice('New inputs: '.length))
    assert.ok(newInputs.some((input: { trigger?: Trigger }) => input.trigger?.id === second.id))
    assert.deepEqual(first.runtime.get(original.id).mandate, mandate)
    await first.close(true)
    active = fixture({ directory }); active.service.start(); await delay(15); await eventually(active.idle)
    assert.equal(active.runs.length, 0)
    const third = update('third-authenticated-head', 'c'.repeat(40))
    active.runtime.receiveVerifiedDefaultStatus(third, { ...ciScope, head: 'c'.repeat(40) })
    await eventually(() => active.runs.length === 1 && active.idle())
    assert.equal(active.runtime.list().length, 1); assert.equal(active.assessments.length, 0)
    assert.equal(active.runs[0]!.ticketId, original.id); assert.equal(active.runs[0]!.sessionId, sessionId)
    assert.deepEqual(active.runtime.get(original.id).mandate, mandate)
    const stored = active.runtime.repositories.triggers.get(third.id)!
    assert.equal(active.runtime.verifiedDefaultInput(stored, active.runtime.get(original.id)), true)
    const forged = update('forged-next-update', 'd'.repeat(40)); forged.meta.verified = true
    active.runtime.engine.receive(forged); await delay(20)
    assert.equal(active.runs.length, 1); assert.equal(active.assessments.length, 0)
    assert.equal(active.runtime.verifiedDefaultInput({ ...stored, text: 'Forged freeform instructions' }, active.runtime.get(original.id)), false)
    assert.equal(active.runtime.verifiedDefaultInput({ ...stored, meta: { ...stored.meta, provider: { ...(stored.meta.provider as object), branch: 'other' } } }, active.runtime.get(original.id)), false)
    active.service.saveSettings({ rules: [{ id: 'repair', name: 'Repair', instruction: 'Revoked CI rule', enabled: false }] }, active.service.settings.revision)
    assert.equal(active.runtime.verifiedDefaultInput(stored, active.runtime.get(original.id)), false)
    await assert.rejects(active.runs[0]!.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'waiting', summary: 'Stale tool after rule revocation' }), /authority|revoked/i)
  } finally { await active.close() }
})


test('empty and widening scoped maps preserve legacy opaque bases while applicable narrowing fails closed', () => {
  const settings = base(); settings.sources.github.admission = { unlistedAddressed: 'explicit' }
  const opaque: Trigger = { id: 'legacy-opaque', source: 'github:legacy', actor: { source: 'github:legacy', id: 'outsider' }, human: true,
    addressed: 'mention', threads: [], at: new Date().toISOString(), text: 'Legacy request', meta: {} }
  const mandate = explicit(settings, opaque)
  settings.sources.github.admissionByScope = {}
  assert.equal(automationGate(settings, opaque).admissible, true); assert.equal(automationPolicy(settings).revalidate(mandate), true)
  settings.sources.github.admissionByScope[`${githubSource}:comments`] = { unlistedAddressed: 'explicit' }
  assert.equal(automationGate(settings, opaque).admissible, true); assert.equal(automationPolicy(settings).revalidate(mandate), true)
  settings.sources.github.admissionByScope[`${githubSource}:comments`] = { unlistedAddressed: 'ignore' }
  assert.equal(automationGate(settings, opaque).admissible, false); assert.equal(automationPolicy(settings).revalidate(mandate), false)
  const other = githubRepositoryRef({ ...repository, repository: 'company/other' }, 7).source
  const unrelated = { ...opaque, source: other, actor: { source: other, id: 'outsider' } }
  assert.equal(automationGate(settings, unrelated).admissible, true)
  settings.sources.github.allowedActors = ['outsider']
  assert.equal(automationGate(settings, opaque).admissible, true)
})

test('configured generic bot rules remain independent of scoped human-ignore cells', () => {
  const settings = base(), trigger = github('comment')
  trigger.human = false; trigger.actor.id = 'checks[bot]'
  settings.sources.github.allowedBots = ['checks[bot]']
  settings.sources.github.admissionByScope = { [`${githubSource}:comments`]: { unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore' } }
  const gate = automationGate(settings, trigger)
  assert.equal(gate.admissible && gate.strength, 'inferred')
  if (!gate.admissible) throw new Error('Configured bot must remain inferred')
  const mandate: Mandate = { actor: trigger.actor, strength: gate.strength, scope: 'Configured bot repair', policyVersion: automationPolicyVersion(settings), basis: { ...gate.basis, rules: ['repair'] } }
  assert.equal(automationPolicy(settings).revalidate(mandate), true)
  settings.sources.github.allowedBots = []; assert.equal(automationPolicy(settings).revalidate(mandate), false)
})


test('trusted default CI opt-in never broadens legacy family or generic message collection', () => {
  const settings = base(), trigger = defaultCI()
  settings.sources.github.admission = { unlistedUnaddressed: 'inferred' }
  assert.equal(automationGate(settings, trigger).admissible, false)
  settings.sources.github.allowedBots = ['github-actions[bot]']
  const legacy = automationGate(settings, trigger); assert.equal(legacy.admissible && legacy.strength, 'inferred')
  settings.sources.github.allowedBots = []; settings.sources.github.admission = undefined
  settings.sources.github.admissionByScope = { [ciRow]: { unlistedUnaddressed: 'inferred' } }
  assert.equal(automationGate(settings, trigger).admissible, false)
  const trusted = automationPolicy(settings, false, undefined, () => true).gate(trigger, { key: 'branch', ref: trigger.threads[0]!, createdAt: trigger.at, subscriptions: [], correlated: [], pending: [], meta: {} }, [])
  assert.equal(trusted.admissible && trusted.strength, 'inferred')
  assert.equal(settingsModule.sourceMayAdmit(settings, 'github'), false)
  settings.sources.github.allowedBots = ['github-actions[bot]']
  assert.equal(automationGate(settings, trigger).admissible, false)
  assert.equal(settingsModule.sourceMayAdmit(settings, 'github'), true)
})


test('new verified CI facts after completion need a fresh inferred mandate and never revive stopped or revoked work', async () => {
  const f = fixture({ completeFirst: true })
  const next = (id: string, head: string) => { const trigger = defaultCI(id); trigger.meta.provider = { ...(trigger.meta.provider as object), head }; trigger.text = `New authenticated default branch fact ${id}`; return trigger }
  try {
    f.runtime.receiveVerifiedDefaultStatus(defaultCI(), ciScope); f.service.start()
    await eventually(() => f.runs.length === 1 && f.idle())
    const completed = f.runtime.list()[0]!, originalSession = f.runs[0]!.sessionId
    assert.equal(completed.ended?.outcome, 'completed')
    const second = next('ci-after-completion', 'b'.repeat(40))
    f.runtime.receiveVerifiedDefaultStatus(second, { ...ciScope, head: 'b'.repeat(40) })
    await eventually(() => f.runs.length === 2 && f.idle())
    assert.equal(f.assessments.length, 2); assert.equal(f.runtime.list().length, 2)
    const fresh = f.runtime.list().find(ticket => ticket.id !== completed.id)!
    assert.equal(fresh.origin.triggerId, second.id); assert.equal(fresh.mandate.strength, 'inferred')
    assert.notEqual(f.runs[1]!.sessionId, originalSession); assert.equal(f.runs[1]!.ticketId, fresh.id)
    assert.deepEqual(f.runtime.get(completed.id).ended, completed.ended)
    assert.equal(f.runtime.get(completed.id).assignments.length, 1)
    f.runtime.receiveVerifiedDefaultStatus(second, { ...ciScope, head: 'b'.repeat(40) }); await delay(20)
    assert.equal(f.runs.length, 2); assert.equal(f.assessments.length, 2)
    f.runtime.engine.stopTicket(fresh.id, 'Native operator stopped this CI repair')
    f.service.saveSettings({ rules: [{ id: 'repair', name: 'Repair', instruction: 'No longer authorized', enabled: false }] }, f.service.settings.revision)
    const third = next('ci-after-stop-and-revocation', 'c'.repeat(40))
    f.runtime.receiveVerifiedDefaultStatus(third, { ...ciScope, head: 'c'.repeat(40) })
    await eventually(() => f.assessments.length === 3 && f.idle())
    assert.equal(f.runs.length, 2); assert.equal(f.runtime.list().length, 2)
    assert.equal(f.runtime.get(fresh.id).ended?.by, 'human'); assert.equal(f.runtime.get(fresh.id).ended?.outcome, 'stopped')
    assert.equal(f.runtime.get(fresh.id).assignments.length, 1)
    assert.deepEqual(f.runtime.get(completed.id).ended, completed.ended)
  } finally { await f.close() }
})
