import { createHash } from 'node:crypto'
import type { AcceptMode, AdmissionCell, GateResult, Mandate, Policy, SourceScope, Trigger } from '../../src/core/index.ts'

export type SourceFamily = 'github' | 'teams'
export interface AutomationRule { id: string; name: string; instruction: string; enabled: boolean }
export interface SourceAdmission {
  enabled: boolean
  allowedActors: string[]
  allowedBots: string[]
  allowUnaddressed: boolean
  admission?: Partial<Record<AdmissionCell, 'explicit' | 'inferred' | 'ignore'>>
}
export interface PromptOverride { text: string; base?: string }
export interface TeamSkill { name: string; description: string; content: string }
export interface AutomationSettings {
  enabled: boolean
  acceptMode: AcceptMode
  sources: Record<SourceFamily, SourceAdmission>
  rules: AutomationRule[]
  execution: { concurrency: number; humanReserve: number; retryLimit: number; retryBaseMs: number; model?: string }
  assessment: { timeoutMs: number; model?: string }
  pollIntervalMs: number
  prompts: { communication: string; ticketScope: string; deliveryRequirements: string; worker: string; assessor: string; overrides?: Record<string, PromptOverride>; skills?: TeamSkill[] }
}
export interface SettingsVersion { revision: number; predecessor: number; at: string; origin: 'panel' | 'restore'; value: AutomationSettings }
export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  enabled: false, acceptMode: 'observe',
  sources: {
    github: { enabled: true, allowedActors: [], allowedBots: [], allowUnaddressed: false },
    teams: { enabled: true, allowedActors: [], allowedBots: [], allowUnaddressed: false },
  },
  rules: [], execution: { concurrency: 3, humanReserve: 1, retryLimit: 4, retryBaseMs: 1000 },
  assessment: { timeoutMs: 120_000 }, pollIntervalMs: 60_000,
  prompts: { communication: '', ticketScope: '', deliveryRequirements: '', worker: '', assessor: '' },
}
export const sourceFamily = (source: string): SourceFamily | undefined => source === 'github' || source.startsWith('github:') ? 'github' : source === 'teams' || source.startsWith('teams:') ? 'teams' : undefined
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Unknown ${label} setting`)
}
function content(value: unknown, label: string, limit = 50_000, empty = true): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0') || value.length > limit || (!empty && !value.trim())) throw new Error(`Invalid ${label}`)
}
function number(value: unknown, label: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`Invalid ${label}: expected ${minimum}-${maximum}`)
}

/** Merge a panel draft with the current full version, then validate without silently dropping fields. */
export function validateSettings(value: unknown, current: AutomationSettings = DEFAULT_AUTOMATION_SETTINGS): AutomationSettings {
  if (!object(value)) throw new Error('Invalid automation settings')
  keys(value, Object.keys(DEFAULT_AUTOMATION_SETTINGS), 'automation')
  const result = structuredClone(current)
  for (const [key, part] of Object.entries(value)) {
    if (['execution', 'assessment', 'prompts'].includes(key)) {
      if (!object(part)) throw new Error(`Invalid ${key}`)
      keys(part, key === 'execution' ? ['concurrency', 'humanReserve', 'retryLimit', 'retryBaseMs', 'model'] : key === 'assessment' ? ['timeoutMs', 'model'] : ['communication', 'ticketScope', 'deliveryRequirements', 'worker', 'assessor', 'overrides', 'skills'], key)
      Object.assign(result[key as 'execution' | 'assessment' | 'prompts'], part)
    } else if (key === 'sources') {
      if (!object(part)) throw new Error('Invalid sources')
      keys(part, ['github', 'teams'], 'source')
      for (const family of ['github', 'teams'] as const) if (part[family] !== undefined) {
        const source = part[family]
        if (!object(source)) throw new Error('Invalid source settings')
        keys(source, ['enabled', 'allowedActors', 'allowedBots', 'allowUnaddressed', 'admission'], 'source')
        Object.assign(result.sources[family], source)
      }
    } else Object.assign(result, { [key]: part })
  }
  if (typeof result.enabled !== 'boolean' || !['off', 'observe', 'auto'].includes(result.acceptMode)) throw new Error('Invalid automation mode')
  for (const source of Object.values(result.sources)) {
    if (typeof source.enabled !== 'boolean' || typeof source.allowUnaddressed !== 'boolean') throw new Error('Invalid source switch')
    for (const list of [source.allowedActors, source.allowedBots]) {
      if (!Array.isArray(list) || list.length > 1000) throw new Error('Invalid source allowed list')
      for (const actor of list) content(actor, 'source identity', 1000, false)
    }
    if (source.admission !== undefined) {
      if (!object(source.admission)) throw new Error('Invalid admission table')
      keys(source.admission, ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed'], 'admission')
      for (const [cell, mode] of Object.entries(source.admission)) {
        if (!['explicit', 'inferred', 'ignore'].includes(mode) || (mode === 'explicit' && cell !== 'unlistedAddressed')) throw new Error('Invalid admission cell')
      }
    }
  }
  if (!Array.isArray(result.rules) || result.rules.length > 100) throw new Error('Invalid rules')
  const ids = new Set<string>()
  for (const rule of result.rules) {
    if (!object(rule)) throw new Error('Invalid rule')
    keys(rule, ['id', 'name', 'instruction', 'enabled'], 'rule')
    if (typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id) || ids.has(rule.id) || typeof rule.enabled !== 'boolean') throw new Error('Invalid or duplicate rule')
    content(rule.name, 'rule name', 200, false); content(rule.instruction, 'rule instruction', 20_000, false); ids.add(rule.id)
  }
  number(result.execution.concurrency, 'concurrency', 1, 16)
  number(result.execution.humanReserve, 'human reserve', 0, result.execution.concurrency)
  number(result.execution.retryLimit, 'retry limit', 0, 20)
  number(result.execution.retryBaseMs, 'retry delay', 10, 300_000)
  number(result.assessment.timeoutMs, 'assessment timeout', 100, 600_000)
  number(result.pollIntervalMs, 'poll interval', 100, 3_600_000)
  for (const model of [result.execution.model, result.assessment.model]) if (model !== undefined) content(model, 'model', 200, false)
  for (const key of ['communication', 'ticketScope', 'deliveryRequirements', 'worker', 'assessor'] as const) content(result.prompts[key], 'prompt')
  if (result.prompts.overrides !== undefined) {
    if (!object(result.prompts.overrides) || Object.keys(result.prompts.overrides).length > 100) throw new Error('Invalid prompt overrides')
    for (const [part, override] of Object.entries(result.prompts.overrides)) {
      if (!/^[a-zA-Z0-9/_-]{1,100}$/.test(part) || !object(override)) throw new Error('Invalid prompt override')
      keys(override, ['text', 'base'], 'prompt override')
      content(override.text, 'prompt override')
      if (override.base !== undefined) content(override.base, 'prompt override base')
    }
  }
  if (result.prompts.skills !== undefined) {
    if (!Array.isArray(result.prompts.skills) || result.prompts.skills.length > 100) throw new Error('Invalid team skills')
    const names = new Set<string>()
    for (const skill of result.prompts.skills) {
      if (!object(skill)) throw new Error('Invalid team skill')
      keys(skill, ['name', 'description', 'content'], 'team skill')
      if (typeof skill.name !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(skill.name) || ['github', 'teams'].includes(skill.name) || names.has(skill.name)) throw new Error('Invalid, duplicate or reserved team skill name')
      names.add(skill.name); content(skill.description, 'skill description', 1000, false); content(skill.content, 'skill content', 50_000, false)
    }
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 512_000) throw new Error('Settings exceed the total size limit')
  return result
}

export const automationPolicyVersion = (settings: AutomationSettings): string => createHash('sha256').update(JSON.stringify({ version: 1, mode: settings.acceptMode, sources: settings.sources, rules: settings.rules })).digest('hex')
const has = (list: string[], id: string) => list.some(value => value.toLowerCase() === id.toLowerCase())
const local = (source: string, id: string) => source === 'vscode' && id === 'local-operator'

export function automationScope(settings: AutomationSettings): SourceScope {
  return { scope(input) {
    if (input.source === 'vscode') return { listened: true, observed: false }
    const family = sourceFamily(input.source), source = family && settings.sources[family]
    return source?.enabled ? { listened: true, observed: source.allowUnaddressed } : { listened: false, reason: 'sourceDisabled' }
  } }
}

export function automationPolicy(settings: AutomationSettings, paused = false): Policy {
  const inferred = (rules: readonly string[]) => settings.acceptMode === 'auto' && rules.length > 0 && rules.every(id => settings.rules.some(rule => rule.enabled && rule.id === id))
  const gate = (trigger: Trigger, participating: boolean): GateResult => {
    if (local(trigger.actor.source, trigger.actor.id) && trigger.source === 'vscode' && trigger.human) return { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct', sender: trigger.actor.id, source: trigger.source } }
    const family = sourceFamily(trigger.source), source = family && settings.sources[family]
    if (!source?.enabled || trigger.actor.source !== trigger.source) return { admissible: false, reason: 'sourceDisabled' }
    const listed = has(source.allowedActors, trigger.actor.id)
    const recorded = { source: trigger.source, scope: trigger.meta, ...(listed ? { sender: trigger.actor.id } : {}) }
    if (trigger.human && listed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
    const cell: AdmissionCell = listed ? 'listedUnaddressed' : trigger.addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
    const admission = source.admission?.[cell] ?? (cell === 'listedUnaddressed' ? 'inferred' : 'ignore')
    const receivable = !!trigger.addressed || source.allowUnaddressed
    const basis = { ...recorded, via: 'admission' as const, cell, ...(trigger.addressed ? { addressed: trigger.addressed } : {}) }
    if (trigger.human && receivable && admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
    if (trigger.human && participating && (listed || settings.acceptMode !== 'off')) return { admissible: true, strength: listed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
    if (settings.acceptMode === 'off' || !receivable) return { admissible: false, reason: 'admissionIgnored' }
    if (!trigger.human) return has(source.allowedBots, trigger.actor.id)
      ? { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'bot', observation: { mode: settings.acceptMode } } }
      : { admissible: false, reason: 'botNotListed' }
    return admission === 'inferred'
      ? { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode: settings.acceptMode } } }
      : { admissible: false, reason: 'actorNotAllowed' }
  }
  return {
    version: automationPolicyVersion(settings), paused: paused || !settings.enabled, evalTimeoutMs: settings.assessment.timeoutMs,
    gate: (trigger, thread, tickets) => gate(trigger, [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id))),
    admitsInferred: inferred,
    revalidate(mandate: Mandate) {
      if (local(mandate.actor.source, mandate.actor.id)) return true
      const family = sourceFamily(mandate.actor.source), source = family && settings.sources[family]
      if (!source?.enabled || (mandate.strength === 'inferred' && !inferred(mandate.basis.rules ?? []))) return false
      if (mandate.basis.via === 'followup') return mandate.strength === 'explicit' || inferred(mandate.basis.rules ?? [])
      if (mandate.basis.via === 'bot') return has(source.allowedBots, mandate.actor.id)
      if (mandate.basis.via === 'admission') {
        const listed = has(source.allowedActors, mandate.actor.id)
        const addressed = mandate.basis.addressed
        const result = gate({ id: '', source: mandate.actor.source, actor: mandate.actor, human: true, addressed, threads: [], at: '', text: '', meta: mandate.basis.scope ?? {} }, false)
        return result.admissible && (mandate.strength === 'inferred' || result.strength === 'explicit') && (mandate.basis.cell !== 'listedUnaddressed' || listed)
      }
      return has(source.allowedActors, mandate.actor.id)
    },
  }
}
