import { createHash } from 'node:crypto'
import type { AutomationSettings, SettingsVersion, SourceAdmission, SourceFamily } from './settings.ts'

const families = ['github', 'teams'] as const
const fields = ['enabled', 'allowedActors', 'allowedBots', 'allowUnaddressed'] as const
type NativeField = typeof fields[number]
type NativeFields = Pick<SourceAdmission, NativeField>
export type NativeSources = Record<SourceFamily, NativeFields>
export type NativePatch = Partial<Record<SourceFamily, Partial<NativeFields>>>
export interface NativeProjection { version: 2; sources: Record<SourceFamily, Record<NativeField, string>> }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const canonical = (value: boolean | string[]) => Array.isArray(value) ? [...new Set(value.map(actor => actor.toLowerCase()))].sort() : value
const semanticHash = (value: boolean | string[]) => hash(canonical(value))

function validField(field: NativeField, value: unknown): boolean {
  return field === 'enabled' || field === 'allowUnaddressed' ? typeof value === 'boolean'
    : Array.isArray(value) && value.length <= 1000 && value.every(actor => typeof actor === 'string' && !!actor.trim() && actor.length <= 1000 && !actor.includes('\0'))
}
function nativeProjection(value: unknown, strict: boolean): NativeSources | undefined {
  if (!record(value) || strict && !exact(value, families)) return
  const result = {} as NativeSources
  for (const family of families) {
    const source = value[family]
    if (!record(source) || strict && !exact(source, fields) || fields.some(field => !validField(field, source[field]))) return
    // This exact field order is also the historical global-fingerprint format.
    result[family] = { enabled: source.enabled as boolean, allowedActors: [...source.allowedActors as string[]],
      allowedBots: [...source.allowedBots as string[]], allowUnaddressed: source.allowUnaddressed as boolean }
  }
  return result
}
function metadataFor(native: NativeSources): NativeProjection {
  const sources = {} as NativeProjection['sources']
  for (const family of families) sources[family] = { enabled: semanticHash(native[family].enabled), allowedActors: semanticHash(native[family].allowedActors),
    allowedBots: semanticHash(native[family].allowedBots), allowUnaddressed: semanticHash(native[family].allowUnaddressed) }
  return { version: 2, sources }
}
function validApplied(value: unknown): value is NativeProjection {
  if (!record(value) || !exact(value, ['version', 'sources']) || value.version !== 2 || !record(value.sources) || !exact(value.sources, families)) return false
  for (const family of families) {
    const source = value.sources[family]
    if (!record(source) || !exact(source, fields) || fields.some(field => typeof source[field] !== 'string' || !/^[a-f0-9]{64}$/.test(source[field] as string))) return false
    for (const field of ['enabled', 'allowUnaddressed'] as const) if (source[field] !== hash(true) && source[field] !== hash(false)) return false
  }
  return true
}

/** Reconcile native edits without replacing unrelated dashboard policy or storing credential/configuration data. */
export function projectNativePolicy(settings: AutomationSettings, native: NativeSources, applied: unknown, legacy: unknown,
  history: readonly SettingsVersion[], fresh: boolean): { value: AutomationSettings; patch: NativePatch; metadata: NativeProjection; migration?: string } {
  const current = nativeProjection(native, true)
  if (!current) throw new Error('Invalid native source policy')
  const metadata = metadataFor(current), patch: NativePatch = {}
  const value = { ...settings, sources: { ...settings.sources } }
  const apply = (family: SourceFamily, field: NativeField, next: NativeFields[NativeField]) => {
    if (semanticHash(settings.sources[family][field]) === semanticHash(next)) return
    const copied = Array.isArray(next) ? [...next] : next
    value.sources[family] = { ...value.sources[family], [field]: copied }
    patch[family] = { ...patch[family], [field]: copied }
  }
  const overlay = (previous?: NativeProjection) => {
    for (const family of families) for (const field of fields) {
      if (!previous || previous.sources[family][field] !== metadata.sources[family][field]) apply(family, field, current[family][field])
    }
  }
  if (fresh) { overlay(); return { value, patch, metadata, migration: 'fresh-native-seed' } }
  if (validApplied(applied)) { overlay(applied); return { value, patch, metadata } }
  if (typeof legacy === 'string' && /^[a-f0-9]{64}$/.test(legacy)) {
    if (hash(current) === legacy) return { value, patch, metadata, migration: 'legacy-fingerprint-matched' }
    for (let index = history.length - 1; index >= 0; index--) {
      const prior = nativeProjection(history[index]?.value?.sources, false)
      if (prior && hash(prior) === legacy) {
        overlay(metadataFor(prior)); return { value, patch, metadata, migration: 'legacy-history-proved' }
      }
    }
  }
  // No baseline proves which field changed: retain only native-confirmed authority, once, before seeding v2.
  for (const family of families) for (const field of fields) {
    if (field === 'allowedActors' || field === 'allowedBots') {
      const allowed = new Set(current[family][field].map(actor => actor.toLowerCase()))
      apply(family, field, settings.sources[family][field].filter(actor => allowed.has(actor.toLowerCase())))
    } else apply(family, field, settings.sources[family][field] && current[family][field])
  }
  return { value, patch, metadata, migration: 'legacy-conservative-narrowing' }
}
