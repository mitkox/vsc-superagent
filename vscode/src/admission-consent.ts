import type { AdmissionCell } from '../../src/core/index.ts'
import { effectiveAdmission, type AutomationSettings, type SourceFamily } from './settings.ts'
import { githubRepositoryRef } from './sources.ts'

export interface AdmissionReceivingConfig {
  github: { origin: string; repository: string }
  teams: { tenantId: string; chatIds: string[]; channels: { teamId: string; channelId: string }[] }
}
interface ReceivingScope { family: SourceFamily; key: string; label: string; ci?: boolean }
interface Grant { id: string; configured: number; effective: number; text: string }
const cells = ['unlistedAddressed', 'unlistedUnaddressed'] as const
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const nativeId = /^[a-zA-Z0-9_:@.-]{1,256}$/

/** These keys describe configured receiving scopes, never destinations supplied by a message. */
export function admissionReceivingScopes(config: AdmissionReceivingConfig): ReceivingScope[] {
  const result: ReceivingScope[] = []
  if (config.github.repository) {
    try {
      const source = githubRepositoryRef(config.github, 1).source
      for (const row of ['issues', 'pulls', 'comments', 'ci']) result.push({ family: 'github', key: source + ':' + row,
        label: 'GitHub ' + config.github.origin + ' / ' + config.github.repository + ' / ' + row, ...(row === 'ci' ? { ci: true } : {}) })
    } catch { /* Invalid native source configuration cannot receive work. */ }
  }
  const teams = config.teams, tenant = teams.tenantId.toLowerCase()
  if (uuid.test(tenant)) {
    for (const chat of teams.chatIds) if (nativeId.test(chat) && chat !== '.' && chat !== '..') result.push({ family: 'teams',
      key: 'tenant:' + tenant + ':chat:' + chat, label: 'Teams tenant ' + tenant + ' / chat ' + chat })
    for (const channel of teams.channels) if (uuid.test(channel.teamId) && nativeId.test(channel.channelId) && channel.channelId !== '.' && channel.channelId !== '..') result.push({ family: 'teams',
      key: 'tenant:' + tenant + ':team:' + channel.teamId.toLowerCase() + ':channel:' + channel.channelId,
      label: 'Teams tenant ' + tenant + ' / team ' + channel.teamId + ' / channel ' + channel.channelId })
  }
  return [...new Map(result.map(row => [row.key, row])).values()]
}
function permission(settings: AutomationSettings, family: SourceFamily, cell: AdmissionCell, mode: string | undefined) {
  const configured = mode === 'explicit' ? 2 : mode === 'inferred' ? 1 : 0
  const source = settings.sources[family]
  const receivable = source.enabled && (cell === 'unlistedAddressed' || source.allowUnaddressed)
  const effective = !receivable ? 0 : mode === 'explicit' ? 3 : mode === 'inferred' && settings.acceptMode !== 'off' ? settings.acceptMode === 'auto' ? 2 : 1 : 0
  return { configured, effective }
}
function grants(settings: AutomationSettings, config: AdmissionReceivingConfig): Grant[] {
  const result: Grant[] = [], receiving = admissionReceivingScopes(config)
  const add = (family: SourceFamily, key: string, label: string, row?: string, ci = false, fallback = false) => {
    const table = ci ? settings.sources[family].admissionByScope?.[row!] ?? {} : row ? effectiveAdmission(settings.sources[family], row) : settings.sources[family].admission ?? {}
    for (const cell of ci ? ['unlistedUnaddressed'] as const : cells) {
      const mode = table[cell] ?? 'ignore', levels = permission(settings, family, cell, mode)
      if (!levels.configured) continue
      const people = ci ? 'authenticated default-branch CI facts' : cell === 'unlistedAddressed' ? 'people outside allowedActors who address the agent' : 'people outside allowedActors who do not address the agent'
      const condition = mode === 'explicit' ? 'explicit work in every proactive mode' : settings.acceptMode === 'auto' ? 'inferred work only with enabled matching rules' : settings.acceptMode === 'observe' ? 'inferred assessment only; no proactive execution' : 'inferred grant is dormant while proactive mode is off'
      result.push({ id: JSON.stringify([family, key, cell]), ...levels,
        text: label + ': ' + people + ' — ' + condition + (fallback ? '; applies to current and future configured scopes unless a scoped row overrides it' : '')
          + (!settings.sources[family].enabled ? '; source currently disabled' : cell === 'unlistedUnaddressed' && !settings.sources[family].allowUnaddressed ? '; unaddressed reception currently disabled' : '') })
    }
  }
  for (const family of ['github', 'teams'] as const) {
    add(family, 'family-fallback', family === 'github' ? 'GitHub family fallback' : 'Teams family fallback', undefined, false, true)
    const known = receiving.filter(row => row.family === family)
    for (const row of known) add(family, row.key, row.label, row.key, row.ci)
    const active = new Set(known.map(row => row.key))
    for (const row of Object.keys(settings.sources[family].admissionByScope ?? {})) if (!active.has(row)) add(family, row, (family === 'github' ? 'GitHub' : 'Teams') + ' stored scope ' + row + ' (not currently configured)', row, row.endsWith(':ci'))
  }
  return result
}

/** Persistent disclosure includes dormant grants and legacy family-wide policies. */
export function admissionDisclosure(settings: AutomationSettings, config: AdmissionReceivingConfig): string[] {
  return grants(settings, config).map(grant => grant.text)
}
/** A source/mode/reception change or removal of a narrowing row can broaden an existing grant. */
export function broadenedAdmission(before: AutomationSettings, after: AutomationSettings, config: AdmissionReceivingConfig): string[] {
  const previous = new Map(grants(before, config).map(grant => [grant.id, grant]))
  return [...new Set(grants(after, config).filter(grant => {
    const old = previous.get(grant.id)
    return grant.configured > (old?.configured ?? 0) || grant.effective > (old?.effective ?? 0)
  }).map(grant => grant.text))]
}
