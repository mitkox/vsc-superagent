/** Read-only membership snapshots for an explicitly approved Teams allowlist sync chat. */
import { SourceError, sameGraphPath, sourceRequest, validateTeams, type TeamsSourceConfig } from './sources.ts'

/** The host obtains a delegated native-auth token with this scope before invoking the adapter. */
export const TEAMS_MEMBERS_SCOPE = 'ChatMember.Read'
export interface TeamsMember { id: string; name?: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
function invalid(): never { throw new SourceError('Invalid Teams membership response') }

/**
 * Returns one complete bounded snapshot; a failed or truncated scan never returns a partial allowlist.
 * Native auth is supplied by the caller. Provider data cannot select another tenant, chat, credential or destination.
 */
export async function readTeamsMembers(config: TeamsSourceConfig, chatId: string, signal?: AbortSignal,
  transport: typeof fetch = fetch): Promise<TeamsMember[]> {
  validateTeams(config)
  if (typeof chatId !== 'string' || !config.chatIds.includes(chatId)) throw new SourceError('Teams membership sync chat is not approved')
  const path = `/v1.0/chats/${encodeURIComponent(chatId)}/members`, members = new Map<string, TeamsMember>()
  const seen = new Set<string>()
  let url = new URL(`https://graph.microsoft.com${path}`)
  for (let page = 0; page < 5; page++) {
    if (seen.has(url.href)) invalid()
    seen.add(url.href)
    const { value } = await sourceRequest(url, config.token, signal, transport), envelope = object(value)
    if (!envelope || !Array.isArray(envelope.value) || envelope.value.length > 1000 || !envelope.value.every(object)) invalid()
    for (const value of envelope.value) {
      const member = object(value)!
      // Graph membership IDs are opaque. Only the native Entra userId is an allowed actor identity.
      if (member['@odata.type'] !== '#microsoft.graph.aadUserConversationMember') continue
      if (typeof member.userId !== 'string' || !UUID.test(member.userId)) invalid()
      if (member.tenantId !== undefined && (typeof member.tenantId !== 'string' || !UUID.test(member.tenantId))) invalid()
      if (typeof member.tenantId === 'string' && member.tenantId.toLowerCase() !== config.tenantId.toLowerCase()) continue
      const id = member.userId.toLowerCase()
      const name = typeof member.displayName === 'string'
        ? member.displayName.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 512) : ''
      const previous = members.get(id)
      if (!previous || !previous.name && name) members.set(id, { id, ...(name ? { name } : {}) })
      if (members.size > 1000) throw new SourceError('Teams membership identity limit exceeded')
    }
    const next = envelope['@odata.nextLink']
    if (next === undefined) return [...members.values()].sort((left, right) => left.id.localeCompare(right.id))
    if (typeof next !== 'string' || !next || next.length > 8192) invalid()
    let parsed: URL
    try { parsed = new URL(next) } catch { return invalid() }
    // A continuation can supply an opaque cursor, never a different operation or arbitrary query.
    if (parsed.origin !== 'https://graph.microsoft.com' || parsed.username || parsed.password || parsed.hash
      || !sameGraphPath(parsed.pathname, path) || [...parsed.searchParams.keys()].some(key => key !== '$skiptoken')
      || parsed.searchParams.getAll('$skiptoken').length !== 1 || !parsed.searchParams.get('$skiptoken')) {
      throw new SourceError('Invalid Teams membership pagination address')
    }
    if (page === 4) throw new SourceError('Teams membership pagination limit exceeded')
    // Reconstruct the credential destination locally even after validating the continuation.
    url = new URL(`https://graph.microsoft.com${path}`)
    url.searchParams.set('$skiptoken', parsed.searchParams.get('$skiptoken')!)
  }
  return invalid()
}
