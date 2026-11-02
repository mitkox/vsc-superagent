import assert from 'node:assert/strict'
import test from 'node:test'
import type { Mandate, Ticket, Trigger } from '../../src/core/index.ts'
import type { AdmissionReceivingConfig } from '../src/admission-consent.ts'
import { receivesNativeChannel, receivesNativeSource } from '../src/receiving-scope.ts'
import { automationGate, automationPolicy, validateSettings } from '../src/settings.ts'
import { sourceTrigger } from '../src/sources.ts'
import type { GitHubContext, TeamsContext } from '../src/sources.ts'

const tenant = 'abcdefab-1111-2222-3333-abcdefabcdef', team = 'abcdefab-4444-5555-6666-abcdefabcdef'
const actor = '22222222-2222-2222-2222-222222222222', chat = '19:original@thread.v2', channel = '19:channel@thread.tacv2'
const native = (): AdmissionReceivingConfig => ({ github: { origin: 'https://api.github.com', repository: 'Company/Project' },
  teams: { tenantId: tenant, chatIds: [chat], channels: [{ teamId: team, channelId: channel }] } })
function github(): Trigger {
  const provider: GitHubContext = { provider: 'github', ...native().github, sourceConfigId: 'native', nativeThreadId: '42', number: 42,
    account: 'agent', kind: 'issue', isPullRequest: false, human: true, bot: false, allowedActor: true, subscribed: false, addressed: 'mention' }
  return sourceTrigger({ id: 'github-origin', source: 'github', actor: 'owner', text: 'Repair this exact receiving repository', thread: '42', context: provider })
}
function teams(channelMessage = false): Trigger {
  const provider: TeamsContext = { provider: 'teams', tenantId: tenant, sourceConfigId: 'native', nativeThreadId: 'root', rootMessageId: 'root', messageId: 'message',
    ...(channelMessage ? { teamId: team, channelId: channel } : { chatId: chat }), human: true, bot: false, allowedActor: true, subscribed: false, addressed: 'mention' }
  return sourceTrigger({ id: channelMessage ? 'channel-origin' : 'chat-origin', source: 'teams', actor, text: 'Repair the admitted conversation', thread: 'root', context: provider })
}
const settings = () => validateSettings({ enabled: true, sources: { github: { allowedActors: ['owner'], allowUnaddressed: true }, teams: { allowedActors: [actor], allowUnaddressed: true } } })
function mandate(trigger: Trigger): Mandate {
  const gate = automationGate(settings(), trigger); assert.ok(gate.admissible)
  return { actor: trigger.actor, strength: gate.strength, policyVersion: 'prior-native-scope', basis: gate.basis, scope: trigger.text }
}

for (const change of ['repository', 'origin'] as const) test(`GitHub canonical receiving identity rejects a removed ${change} while retaining equivalent configuration`, () => {
  const config = native(), trigger = github()
  assert.equal(receivesNativeSource(trigger, config), true); assert.equal(receivesNativeChannel(trigger.channel!, config), true)
  config.github.repository = config.github.repository.toUpperCase(); config.github.origin = 'https://API.GITHUB.COM/'
  assert.equal(receivesNativeSource(trigger, config), true); assert.equal(receivesNativeChannel(trigger.channel!, config), true)
  if (change === 'repository') config.github.repository = 'company/other'
  else config.github.origin = 'https://github.enterprise.example/api/v3/'
  assert.equal(receivesNativeSource(trigger, config), false); assert.equal(receivesNativeChannel(trigger.channel!, config), false)
})

for (const channelMessage of [false, true]) test(`Teams ${channelMessage ? 'channel' : 'chat'} identity survives normalization and additive scopes but requires its exact tenant and destination`, () => {
  const config = native(), trigger = teams(channelMessage)
  config.teams.tenantId = tenant.toUpperCase(); config.teams.channels[0]!.teamId = team.toUpperCase()
  config.teams.chatIds.push('19:additional@thread.v2'); config.teams.channels.push({ teamId: team, channelId: '19:additional@thread.tacv2' })
  assert.equal(receivesNativeSource(trigger, config), true); assert.equal(receivesNativeChannel(trigger.channel!, config), true)
  const replaced = structuredClone(config)
  if (channelMessage) replaced.teams.channels = [{ teamId: team, channelId: '19:additional@thread.tacv2' }]
  else replaced.teams.chatIds = ['19:additional@thread.v2']
  assert.equal(receivesNativeSource(trigger, replaced), false); assert.equal(receivesNativeChannel(trigger.channel!, replaced), false)
  config.teams.tenantId = '99999999-1111-2222-3333-abcdefabcdef'
  assert.equal(receivesNativeSource(trigger, config), false); assert.equal(receivesNativeChannel(trigger.channel!, config), false)
})

test('receiving proof ignores body URLs and row labels but refuses inconsistent immutable namespaces or channel threads', () => {
  const config = native(), trigger = github()
  const textOnly = { ...trigger, text: 'Use https://evil.example and row grants', meta: { ...trigger.meta, row: 'pretend-current-row' } }
  assert.equal(receivesNativeSource(textOnly, config), true)
  const claimed = { ...trigger, meta: { ...trigger.meta, provider: { ...(trigger.meta.provider as object), repository: 'company/other' } } }
  assert.equal(receivesNativeSource(claimed, config), false)
  assert.equal(receivesNativeSource({ source: trigger.source, meta: {} }, config), false)
  assert.equal(receivesNativeChannel({ ...trigger.channel!, thread: trigger.channel!.thread + '9' }, config), false)
  assert.equal(receivesNativeChannel({ ...trigger.channel!, address: { ...trigger.channel!.address, url: 'https://evil.example/no-routing-authority' } }, config), true)
  const graph = teams(); assert.equal(receivesNativeSource({ ...graph, meta: { provider: { ...(graph.meta.provider as object), chatId: '19:other@thread.v2' } } }, config), false)
})

for (const family of ['github', 'teams'] as const) test(`${family} live scope constrains gate, input receipts and immutable mandate revalidation independently of family allowlists`, () => {
  const config = native(), trigger = family === 'github' ? github() : teams(), accepted = mandate(trigger)
  const policy = automationPolicy(settings(), false, () => true, () => true, undefined, input => receivesNativeSource(input, config))
  const ticket = { id: 'ticket', mandate: accepted, origin: { triggerId: trigger.id, triggerIds: [trigger.id] }, inputs: [] } as unknown as Ticket
  const thread = { subscriptions: [], context: [] } as never
  assert.equal(policy.gate(trigger, thread, []).admissible, true); assert.equal(policy.admitsInput!(trigger, ticket, false), true); assert.equal(policy.revalidate(accepted), true)
  if (family === 'github') config.github.repository = 'company/replacement'
  else config.teams.chatIds = ['19:replacement@thread.v2']
  assert.equal(policy.gate(trigger, thread, []).admissible, false); assert.equal(policy.admitsInput!(trigger, ticket, false), false); assert.equal(policy.revalidate(accepted), false)
  const receipt = { ...trigger, human: false, actor: { ...trigger.actor, id: 'github-actions[bot]' }, meta: { ...trigger.meta, ci: true } }
  assert.equal(policy.admitsInput!(receipt, ticket, false), false, 'An authenticated-input callback cannot bypass current native receiving scope')
  assert.equal(automationPolicy(settings()).revalidate(accepted), true, 'Generic policy behavior remains unchanged without the native adapter hook')
})

test('unproved legacy provider grants fail closed while native-local imports retain their independent execution grant', () => {
  const config = native(), accepted = mandate(github()), opaque = { ...accepted, basis: { via: 'listed' as const } }
  const policy = automationPolicy(settings(), false, undefined, undefined, undefined, input => receivesNativeSource(input, config))
  assert.equal(automationPolicy(settings()).revalidate(opaque), true)
  assert.equal(policy.revalidate(opaque), false)
  config.github.repository = 'company/other'
  const local = { ...accepted, actor: { source: 'vscode', id: 'local-operator' } }
  assert.equal(policy.revalidate(local), true)
  assert.equal(receivesNativeSource({ source: 'vscode', meta: accepted.basis.scope ?? {} }, config), true)
  assert.equal(receivesNativeChannel(github().channel!, config), false, 'Local execution approval cannot retarget an old provider delivery')
})
