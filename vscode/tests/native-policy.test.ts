import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { projectNativePolicy } from '../src/native-policy.ts'
import type { NativeSources } from '../src/native-policy.ts'
import { validateSettings } from '../src/settings.ts'
import type { AutomationSettings, SettingsVersion } from '../src/settings.ts'

const families = ['github', 'teams'] as const
const fields = ['enabled', 'allowedActors', 'allowedBots', 'allowUnaddressed'] as const
const native = (): NativeSources => ({
  github: { enabled: true, allowedActors: ['NativeGH'], allowedBots: ['NativeBot'], allowUnaddressed: false },
  teams: { enabled: true, allowedActors: ['NativeTeams'], allowedBots: ['NativeTeamsBot'], allowUnaddressed: true },
})
const dashboard = () => validateSettings({ enabled: true, rules: [{ id: 'repair', name: 'Repair', instruction: 'Keep this rule', enabled: true }],
  sources: { github: { enabled: false, allowedActors: ['DashboardGH'], allowedBots: ['DashboardBot'], allowUnaddressed: true,
    admission: { unlistedAddressed: 'explicit' }, admissionByScope: { [`github:${'a'.repeat(64)}:comments`]: { unlistedAddressed: 'ignore' } } },
  teams: { enabled: false, allowedActors: ['DashboardTeams'], allowedBots: ['DashboardTeamsBot'], allowUnaddressed: false,
    admission: { unlistedUnaddressed: 'inferred' } } }, prompts: { worker: 'Keep this prompt' } })
const applied = (current: NativeSources) => projectNativePolicy(dashboard(), current, undefined, undefined, [], true).metadata
const version = (value: AutomationSettings, revision = 1): SettingsVersion => ({ revision, predecessor: revision - 1, origin: 'panel', at: '2026-11-02T00:00:00Z', value })
const legacyHash = (value: NativeSources) => createHash('sha256').update(JSON.stringify({
  github: { enabled: value.github.enabled, allowedActors: value.github.allowedActors, allowedBots: value.github.allowedBots, allowUnaddressed: value.github.allowUnaddressed },
  teams: { enabled: value.teams.enabled, allowedActors: value.teams.allowedActors, allowedBots: value.teams.allowedBots, allowUnaddressed: value.teams.allowUnaddressed },
})).digest('hex')
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const part of Object.values(value)) freeze(part) }
  return value
}

for (const family of families) for (const field of fields) test(`only changed native ${family}.${field} replaces its corresponding saved field`, () => {
  const previous = native(), current = structuredClone(previous), saved = dashboard()
  if (field === 'enabled' || field === 'allowUnaddressed') {
    saved.sources[family][field] = previous[family][field]
    current[family][field] = !previous[family][field]
  } else current[family][field] = ['ChangedNative']
  const before = structuredClone(saved), result = projectNativePolicy(saved, current, applied(previous), undefined, [], false)
  assert.deepEqual(result.patch, { [family]: { [field]: current[family][field] } })
  const expected = structuredClone(before); Object.assign(expected.sources[family], { [field]: current[family][field] })
  assert.deepEqual(result.value, expected); assert.deepEqual(saved, before)
  assert.equal(result.value.prompts, saved.prompts); assert.equal(result.value.rules, saved.rules)
  assert.equal(result.value.sources[family].admissionByScope, saved.sources[family].admissionByScope)
  assert.equal(result.migration, undefined)
})

test('static empty native actor and bot lists preserve dashboard grants when a baseline is known', () => {
  const current = native()
  for (const family of families) { current[family].allowedActors = []; current[family].allowedBots = [] }
  const saved = dashboard(), baseline = applied(current)
  const stable = projectNativePolicy(saved, current, baseline, undefined, [], false)
  assert.deepEqual(stable.patch, {}); assert.deepEqual(stable.value, saved)
  current.github.allowUnaddressed = true
  const changed = projectNativePolicy(saved, current, baseline, undefined, [], false)
  assert.deepEqual(changed.patch, {}) // Dashboard already chose the same observation value.
  assert.deepEqual(changed.value.sources.github.allowedActors, ['DashboardGH'])
  assert.deepEqual(changed.value.sources.teams.allowedBots, ['DashboardTeamsBot'])
})

test('case order and duplicate-only native list edits are semantically unchanged', () => {
  const previous = native(), current = native()
  for (const family of families) for (const field of ['allowedActors', 'allowedBots'] as const) {
    previous[family][field] = ['Alice', 'Bob']
    current[family][field] = ['bOb', 'ALICE', 'alice', 'BOB']
  }
  const baseline = applied(previous), saved = dashboard(), result = projectNativePolicy(saved, current, baseline, undefined, [], false)
  assert.deepEqual(result.metadata, baseline); assert.deepEqual(result.patch, {}); assert.deepEqual(result.value, saved)
})

test('native changes already reflected semantically in settings update metadata without a needless settings patch', () => {
  const previous = native(), current = native(), saved = dashboard()
  current.github.allowedActors = ['Bob']; saved.sources.github.allowedActors = ['BOB', 'bob']
  const result = projectNativePolicy(saved, current, applied(previous), undefined, [], false)
  assert.deepEqual(result.patch, {}); assert.deepEqual(result.value.sources.github.allowedActors, ['BOB', 'bob'])
  assert.notDeepEqual(result.metadata, applied(previous))
})

test('fresh revision zero seeds every native public field while retaining rules and admission rows', () => {
  const saved = dashboard(), current = native(), result = projectNativePolicy(saved, current, undefined, undefined, [], true)
  assert.equal(result.migration, 'fresh-native-seed')
  for (const family of families) for (const field of fields) assert.deepEqual(result.patch[family]?.[field], current[family][field])
  assert.deepEqual(result.value.sources.github.admissionByScope, saved.sources.github.admissionByScope)
  assert.equal(result.value.rules, saved.rules); assert.equal(result.value.prompts, saved.prompts)
})

test('an exactly matching legacy fingerprint seeds hashes without rewriting dashboard policy', () => {
  const current = native(), reordered: NativeSources = { teams: current.teams, github: current.github }
  const saved = dashboard(), result = projectNativePolicy(saved, reordered, undefined, legacyHash(current), [], false)
  assert.equal(result.migration, 'legacy-fingerprint-matched'); assert.deepEqual(result.patch, {}); assert.deepEqual(result.value, saved)
  assert.equal(result.metadata.version, 2)
  for (const family of families) for (const field of fields) assert.match(result.metadata.sources[family][field], /^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify(result.metadata), /NativeGH|NativeBot|Dashboard|token|secret/)
})

test('retained hash-proved history recovers only the native field that actually changed', () => {
  const previous = native(), current = native(), saved = dashboard()
  current.github.allowedActors = ['NewNativeActor']
  const historical = validateSettings({ sources: previous, prompts: { worker: 'Extra non-native historical field' } })
  const history = [version(historical), version(dashboard(), 2)]
  const result = projectNativePolicy(saved, current, undefined, legacyHash(previous), history, false)
  assert.equal(result.migration, 'legacy-history-proved')
  assert.deepEqual(result.patch, { github: { allowedActors: ['NewNativeActor'] } })
  assert.deepEqual(result.value.sources.github.allowedBots, ['DashboardBot'])
  assert.deepEqual(result.value.sources.teams, saved.sources.teams)
})

test('history-proved legacy order and case changes keep every saved dashboard override', () => {
  const previous = native(), current = native(), saved = dashboard()
  previous.github.allowedActors = ['Alice', 'Bob']; current.github.allowedActors = ['bob', 'ALICE', 'alice']
  const result = projectNativePolicy(saved, current, undefined, legacyHash(previous), [version(validateSettings({ sources: previous }))], false)
  assert.equal(result.migration, 'legacy-history-proved'); assert.deepEqual(result.patch, {}); assert.deepEqual(result.value, saved)
})

for (const legacy of [undefined, 'f'.repeat(64), 'invalid-fingerprint']) test(`unproved migration ${legacy ?? 'missing'} narrows once without granting new native authority`, () => {
  const saved = dashboard(), current = native()
  saved.sources.github.enabled = true; current.github.enabled = false
  saved.sources.github.allowedActors = ['Alice', 'DashboardOnly']; current.github.allowedActors = ['alice', 'NativeOnly']
  saved.sources.github.allowedBots = ['KeptBot', 'RemovedBot']; current.github.allowedBots = ['keptbot', 'NewBot']
  const result = projectNativePolicy(saved, current, undefined, legacy, [], false)
  assert.equal(result.migration, 'legacy-conservative-narrowing')
  assert.equal(result.value.sources.github.enabled, false)
  assert.deepEqual(result.value.sources.github.allowedActors, ['Alice']); assert.deepEqual(result.value.sources.github.allowedBots, ['KeptBot'])
  assert.equal(result.value.sources.teams.enabled, false); assert.equal(result.value.sources.teams.allowUnaddressed, false)
  assert.deepEqual(result.value.sources.github.admissionByScope, saved.sources.github.admissionByScope)
  const next = { ...result.value, sources: { ...result.value.sources, github: { ...result.value.sources.github, allowedActors: ['NewDashboardGrant'] } } }
  const stable = projectNativePolicy(next, current, result.metadata, legacy, [], false)
  assert.deepEqual(stable.patch, {}); assert.deepEqual(stable.value.sources.github.allowedActors, ['NewDashboardGrant'])
  assert.equal(stable.migration, undefined)
})

test('malformed applied metadata is never trusted as a partial field baseline', () => {
  const current = native(), saved = dashboard(), malformed = structuredClone(applied(current)) as any
  delete malformed.sources.github.allowedActors
  const result = projectNativePolicy(saved, current, malformed, undefined, [], false)
  assert.equal(result.migration, 'legacy-conservative-narrowing'); assert.deepEqual(result.value.sources.github.allowedActors, [])
  const matched = projectNativePolicy(saved, current, malformed, legacyHash(current), [], false)
  assert.equal(matched.migration, 'legacy-fingerprint-matched'); assert.deepEqual(matched.patch, {})
})

test('projection is pure with frozen input and applying its metadata is idempotent', () => {
  const previous = native(), current = native(), saved = dashboard(), history = [version(dashboard())], baseline = applied(previous)
  current.teams.allowedActors = ['ChangedNativeTeam']
  const snapshot = structuredClone({ saved, current, history, baseline })
  freeze(saved); freeze(current); freeze(history); freeze(baseline)
  const first = projectNativePolicy(saved, current, baseline, 'f'.repeat(64), history, false)
  assert.deepEqual({ saved, current, history, baseline }, snapshot)
  const second = projectNativePolicy(first.value, current, first.metadata, undefined, history, false)
  assert.deepEqual(second.value, first.value); assert.deepEqual(second.patch, {}); assert.deepEqual(second.metadata, first.metadata)
  assert.equal(second.migration, undefined)
})

test('invalid native fields and unexpected secret-bearing shape fail before producing a plan', () => {
  const saved = dashboard()
  for (const corrupt of [
    (value: any) => { value.github.enabled = 'true' },
    (value: any) => { value.github.allowedActors = [''] },
    (value: any) => { value.teams.allowedBots = [42] },
    (value: any) => { value.teams.allowUnaddressed = 1 },
    (value: any) => { value.github.token = 'never-store-this-secret' },
    (value: any) => { value.teams.allowedActors = Array.from({ length: 1001 }, () => 'actor') },
  ]) {
    const current = native(); corrupt(current)
    assert.throws(() => projectNativePolicy(saved, current, undefined, undefined, [], false), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /Invalid native source policy/); assert.doesNotMatch(error.message, /never-store/); return true
    })
  }
})
