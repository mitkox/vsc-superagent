import assert from 'node:assert/strict'
import test from 'node:test'
import type { Mandate, Trigger } from '../../src/core/index.ts'
import { automationGate, automationPolicy, automationPolicyVersion, validateSettings } from '../src/settings.ts'
import type { AutomationSettings, SourceFamily } from '../src/settings.ts'

const settings = (family: SourceFamily) => validateSettings({ enabled: true, acceptMode: 'auto',
  rules: [{ id: 'repair', name: 'Repair', instruction: 'Repair defects', enabled: true }],
  sources: { [family]: { enabled: true, allowedActors: ['owner'], allowedBots: ['robot'], allowUnaddressed: false } },
})
const trigger = (family: SourceFamily, actor: string, addressed = true, human = true): Trigger => ({
  id: 'request', source: `${family}:scope`, actor: { source: `${family}:scope`, id: actor }, human,
  ...(addressed ? { addressed: 'mention' as const } : {}), threads: [{ source: `${family}:scope`, id: '1' }],
  at: new Date().toISOString(), text: 'Repair the defect', meta: {},
})
function mandate(value: AutomationSettings, input: Trigger, participating = false): Mandate {
  const result = automationGate(value, input, participating)
  assert.equal(result.admissible, true)
  if (!result.admissible) throw new Error('Expected admission')
  return { strength: result.strength, actor: input.actor, scope: input.text, policyVersion: automationPolicyVersion(value),
    basis: { ...result.basis, ...(result.strength === 'inferred' ? { rules: ['repair'] } : {}) } }
}

for (const family of ['github', 'teams'] as const) {
  test(`${family} admission cells retain explicit, inferred, bot and subscription boundaries`, () => {
    const value = settings(family), source = value.sources[family]
    for (const mode of ['off', 'observe', 'auto'] as const) {
      value.acceptMode = mode
      assert.equal(automationGate(value, trigger(family, 'owner')).admissible, true)
      assert.equal(automationGate(value, trigger(family, 'stranger')).admissible, false)
      source.admission = { unlistedAddressed: 'explicit' }
      const explicit = automationGate(value, trigger(family, 'stranger'))
      assert.equal(explicit.admissible && explicit.strength, 'explicit')
      assert.equal(automationGate(value, trigger(family, 'stranger', true, false)).admissible, false)
      const bot = automationGate(value, trigger(family, 'robot', true, false))
      assert.equal(bot.admissible && bot.strength, mode === 'off' ? false : 'inferred')
      source.admission = { unlistedAddressed: 'inferred', unlistedUnaddressed: 'inferred' }
      const inferred = automationGate(value, trigger(family, 'stranger'))
      assert.equal(inferred.admissible && inferred.strength, mode === 'off' ? false : 'inferred')
      assert.equal(automationGate(value, trigger(family, 'stranger', false)).admissible, false)
      source.allowUnaddressed = true
      const observed = automationGate(value, trigger(family, 'stranger', false))
      assert.equal(observed.admissible && observed.strength, mode === 'off' ? false : 'inferred')
      source.admission = { listedUnaddressed: 'ignore', unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore' }
      assert.equal(automationGate(value, trigger(family, 'owner', false)).admissible, false)
      assert.equal(automationGate(value, trigger(family, 'owner')).admissible, true)
      const followup = automationGate(value, trigger(family, 'owner', false), true)
      assert.equal(followup.admissible && followup.strength, 'explicit')
      source.allowUnaddressed = false
      source.admission = undefined
    }
    value.acceptMode = 'auto'
    source.allowedActors.push('robot')
    const bot = automationGate(value, trigger(family, 'robot', true, false))
    assert.equal(bot.admissible && bot.strength, 'inferred')
    source.enabled = false
    assert.equal(automationGate(value, trigger(family, 'owner')).admissible, false)
  })

  test(`${family} immutable mandates recheck the authorization basis under changed policy`, () => {
    const value = settings(family), source = value.sources[family]
    const addressed = mandate(value, trigger(family, 'owner'))
    const followup = mandate(value, trigger(family, 'owner', false), true)
    assert.equal(automationPolicy(value).revalidate(followup), true)
    source.allowedActors = []
    assert.equal(automationPolicy(value).revalidate(addressed), false)
    assert.equal(automationPolicy(value).revalidate(followup), false)

    source.admission = { unlistedAddressed: 'explicit' }
    const override = mandate(value, trigger(family, 'stranger'))
    assert.equal(automationPolicy(value).revalidate(override), true)
    source.admission.unlistedAddressed = 'ignore'
    assert.equal(automationPolicy(value).revalidate(override), false)
    source.allowedActors = ['stranger']
    assert.equal(automationPolicy(value).revalidate(override), true)

    source.allowedActors = ['owner']; source.allowUnaddressed = true; source.admission = undefined
    const listed = mandate(value, trigger(family, 'owner', false))
    source.allowedActors = []; source.admission = { unlistedUnaddressed: 'inferred' }
    assert.equal(automationPolicy(value).revalidate(listed), false)
    const inferred = mandate(value, trigger(family, 'stranger', false))
    assert.equal(automationPolicy(value).revalidate(inferred), true)
    source.allowUnaddressed = false
    assert.equal(automationPolicy(value).revalidate(inferred), false)
    const contextFollowup = mandate(value, trigger(family, 'stranger', false), true)
    assert.equal(contextFollowup.basis.via, 'followup')
    assert.equal(automationPolicy(value).revalidate(contextFollowup), true)
    value.acceptMode = 'off'
    assert.equal(automationPolicy(value).revalidate(contextFollowup), false)
  })

  test(`${family} bot mandates retain addressing and lose observation, bot or rule authority when revoked`, () => {
    const value = settings(family), source = value.sources[family]
    source.allowUnaddressed = true
    const unaddressed = mandate(value, trigger(family, 'robot', false, false))
    const mentioned = mandate(value, trigger(family, 'robot', true, false))
    assert.equal(mentioned.basis.via === 'bot' && mentioned.basis.addressed, 'mention')
    source.allowUnaddressed = false
    assert.equal(automationPolicy(value).revalidate(unaddressed), false)
    assert.equal(automationPolicy(value).revalidate(mentioned), true)
    source.allowedBots = []
    assert.equal(automationPolicy(value).revalidate(mentioned), false)
    source.allowedBots = ['robot']; value.rules[0]!.enabled = false
    assert.equal(automationPolicy(value).revalidate(mentioned), false)
  })
}
