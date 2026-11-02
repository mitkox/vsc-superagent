import { createHash } from 'node:crypto'
import { githubRepositoryRef, sourceNamespace } from './sources.ts'
import type { SourceContext } from './sources.ts'
import { assessmentCohort } from '../../src/core/index.ts'
import type { AcceptMode, AdmissionCell, GateResult, Mandate, Policy, SourceScope, Ticket, Trigger } from '../../src/core/index.ts'

export type SourceFamily = 'github' | 'teams'
export interface AutomationRule { id: string; name: string; instruction: string; enabled: boolean }
export type AdmissionTable = Partial<Record<AdmissionCell, 'explicit' | 'inferred' | 'ignore'>>
export interface SourceAdmission {
  enabled: boolean
  allowedActors: string[]
  allowedBots: string[]
  allowUnaddressed: boolean
  admission?: AdmissionTable
  admissionByScope?: Record<string, AdmissionTable>
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
  const input = structuredClone(value)
  keys(input, Object.keys(DEFAULT_AUTOMATION_SETTINGS), 'automation')
  const result = structuredClone(current)
  for (const [key, part] of Object.entries(input)) {
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
        keys(source, ['enabled', 'allowedActors', 'allowedBots', 'allowUnaddressed', 'admission', 'admissionByScope'], 'source')
        Object.assign(result.sources[family], source)
      }
    } else Object.assign(result, { [key]: part })
  }
  if (typeof result.enabled !== 'boolean' || !['off', 'observe', 'auto'].includes(result.acceptMode)) throw new Error('Invalid automation mode')
  for (const [family, source] of Object.entries(result.sources)) {
    if (typeof source.enabled !== 'boolean' || typeof source.allowUnaddressed !== 'boolean') throw new Error('Invalid source switch')
    for (const list of [source.allowedActors, source.allowedBots]) {
      if (!Array.isArray(list) || list.length > 1000) throw new Error('Invalid source allowed list')
      for (const actor of list) content(actor, 'source identity', 1000, false)
    }
    if (source.admission !== undefined) validateAdmissionTable(source.admission)
    if (source.admissionByScope !== undefined) {
      if (!object(source.admissionByScope) || Object.keys(source.admissionByScope).length > 200) throw new Error('Invalid scoped admission table')
      for (const [row, table] of Object.entries(source.admissionByScope)) {
        if (!validAdmissionRow(family as SourceFamily, row)) throw new Error('Invalid scoped admission row')
        validateAdmissionTable(table, family === 'github' && row.endsWith(':ci'))
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

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const nativeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_:@.-]{1,256}$/.test(value) && value !== '.' && value !== '..'
const branchName = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value)
const sha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
function validAdmissionRow(family: SourceFamily, row: string): boolean {
  if (family === 'github') return /^github:[a-f0-9]{64}:(?:issues|pulls|comments|ci)$/.test(row)
  const chat = /^tenant:([^:]+):chat:(.+)$/.exec(row), channel = /^tenant:([^:]+):team:([^:]+):channel:(.+)$/.exec(row)
  return !!(chat && UUID.test(chat[1]!) && chat[1] === chat[1]!.toLowerCase() && nativeId(chat[2])
    || channel && UUID.test(channel[1]!) && UUID.test(channel[2]!) && channel[1] === channel[1]!.toLowerCase() && channel[2] === channel[2]!.toLowerCase() && nativeId(channel[3]))
}
function validateAdmissionTable(value: unknown, ci = false): void {
  if (!object(value)) throw new Error('Invalid admission table')
  keys(value, ci ? ['unlistedUnaddressed'] : ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed'], 'admission')
  for (const [cell, mode] of Object.entries(value)) if (typeof mode !== 'string' || !['explicit', 'inferred', 'ignore'].includes(mode) || (mode === 'explicit' && cell !== 'unlistedAddressed')) throw new Error('Invalid admission cell')
}
/** A producer-validated receiving row; source text and arbitrary row labels never select policy. */
export function sourceAdmissionRow(trigger: Pick<Trigger, 'source' | 'meta'>): string | undefined {
  const provider = trigger.meta.provider
  if (!object(provider)) return
  try {
    if (provider.provider === 'github' && typeof provider.origin === 'string' && typeof provider.repository === 'string') {
      const kind = provider.kind, category = kind === 'issue' ? 'issues' : kind === 'pull' ? 'pulls'
        : ['comment', 'review', 'review-comment'].includes(String(kind)) ? 'comments' : ['checks', 'branch-checks'].includes(String(kind)) ? 'ci' : undefined
      if (!category || githubRepositoryRef({ origin: provider.origin, repository: provider.repository }, 1).source !== trigger.source) return
      if (kind === 'branch-checks') { if (!branchName(provider.branch) || !sha(provider.head)) return }
      else if (!Number.isSafeInteger(provider.number) || Number(provider.number) <= 0 || provider.nativeThreadId !== String(provider.number)) return
      return `${trigger.source}:${category}`
    }
    if (provider.provider === 'teams' && typeof provider.tenantId === 'string' && UUID.test(provider.tenantId)
      && nativeId(provider.rootMessageId) && nativeId(provider.messageId) && provider.nativeThreadId === provider.rootMessageId) {
      const tenant = provider.tenantId.toLowerCase()
      let row: string
      if (nativeId(provider.chatId) && provider.teamId === undefined && provider.channelId === undefined) row = `tenant:${tenant}:chat:${provider.chatId}`
      else if (provider.chatId === undefined && typeof provider.teamId === 'string' && UUID.test(provider.teamId) && nativeId(provider.channelId)) row = `tenant:${tenant}:team:${provider.teamId.toLowerCase()}:channel:${provider.channelId}`
      else return
      return sourceNamespace(provider as unknown as SourceContext) === trigger.source ? row : undefined
    }
  } catch { return }
}
/** Each scoped cell overrides only that cell; absent rows/cells retain the explicit legacy family fallback. */
export function effectiveAdmission(source: SourceAdmission, row?: string): AdmissionTable {
  return { ...source.admission, ...(row ? source.admissionByScope?.[row] : {}) }
}
/** Candidate scan preflight; source receiving switches still decide the actual provider reads. */
export function sourceMayAdmit(settings: AutomationSettings, family: SourceFamily): boolean {
  const source = settings.sources[family]
  if (!source.enabled) return false
  if (source.allowedActors.length || source.allowedBots.length) return true
  return [source.admission, ...Object.entries(source.admissionByScope ?? {}).filter(([row]) => family !== 'github' || !row.endsWith(':ci')).map(([, table]) => table)].some(table => table?.unlistedAddressed === 'explicit'
    || settings.acceptMode !== 'off' && (table?.unlistedAddressed === 'inferred' || source.allowUnaddressed && table?.unlistedUnaddressed === 'inferred'))
}
function humanCell(source: SourceAdmission, trigger: Pick<Trigger, 'actor' | 'human' | 'addressed'>): AdmissionCell | undefined {
  if (!trigger.human || has(source.allowedActors, trigger.actor.id) && trigger.addressed) return
  return has(source.allowedActors, trigger.actor.id) ? 'listedUnaddressed' : trigger.addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}
function rowNamespace(row: string): string | undefined {
  if (/^github:[a-f0-9]{64}:(?:issues|pulls|comments|ci)$/.test(row)) return row.slice(0, row.lastIndexOf(':'))
  const chat = /^tenant:([^:]+):chat:(.+)$/.exec(row), channel = /^tenant:([^:]+):team:([^:]+):channel:(.+)$/.exec(row)
  if (chat) return sourceNamespace({ provider: 'teams', tenantId: chat[1]!, chatId: chat[2]! } as SourceContext)
  if (channel) return sourceNamespace({ provider: 'teams', tenantId: channel[1]!, teamId: channel[2]!, channelId: channel[3]! } as SourceContext)
}
function narrowsUnprovedHuman(source: SourceAdmission, trigger: Pick<Trigger, 'actor' | 'human' | 'addressed'>): boolean {
  const cell = humanCell(source, trigger)
  if (!cell) return false
  const rank = { ignore: 0, inferred: 1, explicit: 2 }
  const fallback = source.admission?.[cell] ?? (cell === 'listedUnaddressed' ? 'inferred' : 'ignore')
  const namespace = /^(?:github|teams):[a-f0-9]{64}$/.test(trigger.actor.source) ? trigger.actor.source : undefined
  return Object.entries(source.admissionByScope ?? {}).some(([row, table]) => (!namespace || rowNamespace(row) === namespace) && !/^github:[a-f0-9]{64}:ci$/.test(row)
    && table[cell] !== undefined && rank[table[cell]!] < rank[fallback])
}
export type DefaultStatusAuthority = (input: Trigger | Mandate) => boolean

export const automationPolicyVersion = (settings: AutomationSettings): string => createHash('sha256').update(JSON.stringify({ version: 2, mode: settings.acceptMode, sources: settings.sources, rules: settings.rules })).digest('hex')
const has = (list: string[], id: string) => list.some(value => value.toLowerCase() === id.toLowerCase())
const local = (source: string, id: string) => source === 'vscode' && id === 'local-operator'

export function automationScope(settings: AutomationSettings): SourceScope {
  return { scope(input) {
    if (input.source === 'vscode') return { listened: true, observed: false }
    const family = sourceFamily(input.source), source = family && settings.sources[family]
    return source?.enabled ? { listened: true, observed: source.allowUnaddressed } : { listened: false, reason: 'sourceDisabled' }
  } }
}

export function automationGate(settings: AutomationSettings, trigger: Trigger, participating = false, verifiedDefaultStatus?: DefaultStatusAuthority): GateResult {
  if (local(trigger.actor.source, trigger.actor.id) && trigger.source === 'vscode' && trigger.human) return { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct', sender: trigger.actor.id, source: trigger.source } }
  const family = sourceFamily(trigger.source), source = family && settings.sources[family]
  if (!source?.enabled || trigger.actor.source !== trigger.source) return { admissible: false, reason: 'sourceDisabled' }
  const row = sourceAdmissionRow(trigger)
  if (!row && narrowsUnprovedHuman(source, trigger)) return { admissible: false, reason: 'sourceScopeUnproved' }
  const table = effectiveAdmission(source, row)
  const listed = has(source.allowedActors, trigger.actor.id)
  const recorded = { source: trigger.source, scope: trigger.meta, ...(row ? { row } : {}), ...(listed ? { sender: trigger.actor.id } : {}) }
  if (family === 'github' && object(trigger.meta.provider) && trigger.meta.provider.provider === 'github' && trigger.meta.provider.kind === 'branch-checks' && row && source.admissionByScope?.[row]?.unlistedUnaddressed !== undefined) {
    if (trigger.human || trigger.addressed || trigger.actor.id !== 'github-actions[bot]' || !row?.endsWith(':ci') || !verifiedDefaultStatus?.(trigger)) return { admissible: false, reason: 'defaultStatusUnverified' }
    return settings.acceptMode !== 'off' && source.allowUnaddressed && source.admissionByScope[row]?.unlistedUnaddressed === 'inferred'
      ? { admissible: true, strength: 'inferred', basis: { ...recorded, scope: { ...trigger.meta, defaultStatusEventId: trigger.id }, via: 'admission', cell: 'unlistedUnaddressed', observation: { mode: settings.acceptMode } } }
      : { admissible: false, reason: 'admissionIgnored' }
  }
  if (trigger.human && listed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
  const cell: AdmissionCell = listed ? 'listedUnaddressed' : trigger.addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
  const admission = table[cell] ?? (cell === 'listedUnaddressed' ? 'inferred' : 'ignore')
  const receivable = !!trigger.addressed || source.allowUnaddressed
  const basis = { ...recorded, via: 'admission' as const, cell, ...(trigger.addressed ? { addressed: trigger.addressed } : {}) }
  if (trigger.human && receivable && admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
  if (trigger.human && participating && listed && admission !== 'ignore') return { admissible: true, strength: listed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
  if (settings.acceptMode === 'off' || !receivable) return { admissible: false, reason: 'admissionIgnored' }
  if (!trigger.human) return has(source.allowedBots, trigger.actor.id)
    ? { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'bot', ...(trigger.addressed ? { addressed: trigger.addressed } : {}), observation: { mode: settings.acceptMode } } }
    : { admissible: false, reason: 'botNotListed' }
  return admission === 'inferred'
    ? { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode: settings.acceptMode } } }
    : { admissible: false, reason: 'actorNotAllowed' }
}

export function automationPolicy(settings: AutomationSettings, paused = false, verifiedStatus?: (trigger: Trigger, ticket: Ticket) => boolean, verifiedDefaultStatus?: DefaultStatusAuthority, mandateOrigins?: (mandate: Mandate) => readonly (Trigger | undefined)[] | undefined, receives?: (input: Pick<Trigger, 'source' | 'meta'>) => boolean): Policy {
  const inferred = (rules: readonly string[]) => settings.acceptMode === 'auto' && rules.length > 0 && rules.every(id => settings.rules.some(rule => rule.enabled && rule.id === id))
  const gate = (trigger: Trigger, participating: boolean): GateResult => receives?.(trigger) === false
    ? { admissible: false, reason: 'sourceScopeRemoved' } : automationGate(settings, trigger, participating, verifiedDefaultStatus)
  const policy: Policy = {
    version: automationPolicyVersion(settings), paused: paused || !settings.enabled, evalTimeoutMs: settings.assessment.timeoutMs,
    gate: (trigger, thread, tickets) => {
      if (object(trigger.meta.provider) && trigger.meta.provider.kind === 'branch-checks'
        && tickets.some(ticket => !ticket.ended && verifiedStatus?.(trigger, ticket))) return { admissible: false, reason: 'verifiedStatusForExistingTicket' }
      return gate(trigger, [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id)))
    },
    admitsInput(trigger, ticket, contextOnly) {
      if (receives?.(trigger) === false) return false
      const origin = [ticket.origin.triggerId, ...ticket.origin.triggerIds ?? []].includes(trigger.id)
      if (origin && ticket.mandate.strength === 'inferred' && ticket.mandate.actor.source === trigger.actor.source && ticket.mandate.actor.id === trigger.actor.id
        && policy.revalidate(ticket.mandate)) {
        const admitted = gate(trigger, false)
        if (admitted.admissible && admitted.strength === 'inferred') return true
      }
      const family = sourceFamily(trigger.source)
      if (family && settings.sources[family].enabled && !trigger.human && trigger.actor.source === trigger.source && verifiedStatus?.(trigger, ticket)) return true
      const admitted = gate(trigger, !contextOnly)
      // Inferred senders still require an assessment and enabled matching rules, even on subscribed threads.
      return admitted.admissible && admitted.strength === 'explicit'
    },
    admitsInferred: inferred,
    revalidate(mandate: Mandate) {
      if (local(mandate.actor.source, mandate.actor.id)) return true
      if (receives?.({ source: mandate.actor.source, meta: mandate.basis.scope ?? {} }) === false) return false
      // Earlier versions could accept one scope from unrelated senders or receiving rows. The immutable scope cannot be
      // narrowed by retiring just one Input; require every persisted origin to retain one current authority cohort.
      const origins = mandateOrigins?.(mandate)
      if (origins) {
        let cohort: string | undefined
        if (!origins.length) return false
        for (const trigger of origins) {
          if (!trigger || trigger.actor.source !== mandate.actor.source || trigger.actor.id !== mandate.actor.id) return false
          const admitted = gate(trigger, mandate.strength === 'explicit' && mandate.basis.via === 'followup')
          if (!admitted.admissible || (mandate.strength === 'explicit' && admitted.strength !== 'explicit')) return false
          const current = assessmentCohort(trigger, admitted.strength, admitted.basis)
          if (cohort !== undefined && cohort !== current) return false
          cohort = current
        }
      }
      const family = sourceFamily(mandate.actor.source), source = family && settings.sources[family]
      if (!source?.enabled || (mandate.strength === 'inferred' && !inferred(mandate.basis.rules ?? []))) return false
      const row = sourceAdmissionRow({ source: mandate.actor.source, meta: mandate.basis.scope ?? {} })
      if (mandate.basis.row !== undefined && mandate.basis.row !== row) return false
      if (mandate.basis.via === 'admission' && object(mandate.basis.scope?.provider) && mandate.basis.scope.provider.kind === 'branch-checks') return mandate.strength === 'inferred'
        && !!verifiedDefaultStatus?.(mandate) && !!row?.endsWith(':ci') && source.allowUnaddressed && source.admissionByScope?.[row]?.unlistedUnaddressed === 'inferred'
      if (mandate.basis.via === 'followup') {
        // Legacy inferred followup bases never recorded an admission cell or addressing.
        if (mandate.strength !== 'explicit') return false
        const result = gate({ id: '', source: mandate.actor.source, actor: mandate.actor, human: true, threads: [], at: '', text: '', meta: mandate.basis.scope ?? {} }, true)
        return has(source.allowedActors, mandate.actor.id) && result.admissible && result.strength === 'explicit'
      }
      if (mandate.basis.via === 'bot') {
        const result = gate({ id: '', source: mandate.actor.source, actor: mandate.actor, human: false, addressed: mandate.basis.addressed, threads: [], at: '', text: '', meta: mandate.basis.scope ?? {} }, false)
        return mandate.strength === 'inferred' && result.admissible && result.strength === 'inferred'
      }
      if (mandate.basis.via === 'admission') {
        const listed = has(source.allowedActors, mandate.actor.id)
        const addressed = mandate.basis.addressed
        const result = gate({ id: '', source: mandate.actor.source, actor: mandate.actor, human: true, addressed, threads: [], at: '', text: '', meta: mandate.basis.scope ?? {} }, false)
        return result.admissible && (mandate.strength === 'inferred' || result.strength === 'explicit') && (mandate.basis.cell !== 'listedUnaddressed' || listed)
      }
      const addressed = 'addressed' in mandate.basis ? mandate.basis.addressed : undefined
      const legacy = { id: '', source: mandate.actor.source, actor: mandate.actor, human: true, addressed, threads: [], at: '', text: '', meta: mandate.basis.scope ?? {} }
      const cell = humanCell(source, legacy)
      if (cell && (row ? source.admissionByScope?.[row]?.[cell] !== undefined : narrowsUnprovedHuman(source, legacy))) {
        const result = gate(legacy, false)
        return has(source.allowedActors, mandate.actor.id) && result.admissible && (mandate.strength === 'inferred' || result.strength === 'explicit')
      }
      return has(source.allowedActors, mandate.actor.id)
    },
  }
  return policy
}
