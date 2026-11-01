import { createHash } from 'node:crypto'

/** Remote content is an inbox candidate only; it never grants execution authority. */
export interface InboxItem {
  id: string
  source: 'github' | 'teams'
  actor: string
  text: string
  url?: string
  thread: string
}
export interface GitHubSourceConfig {
  /** User/application-scoped setting, never read from a workspace or a model request. */
  origin: string
  repository: string
  account: string
  allowedActors: string[]
  token: string
  since?: string
}
export interface TeamsSourceConfig {
  /** Native auth must select this tenant. The caller must never reuse a token entered for another tenant. */
  tenantId: string
  chatIds: string[]
  channels: { teamId: string; channelId: string }[]
  allowedActors: string[]
  token: string
  since?: string
}

const MAX_BYTES = 1024 * 1024
const MAX_PAGES = 5
const MAX_TEXT = 50_000
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const REPOSITORY = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_-][a-z\d_.-]{0,99}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TEAMS_ID = /^[a-zA-Z0-9_:@.-]{1,256}$/
type RecordValue = Record<string, unknown>

export class SourceError extends Error {}
function fail(message: string): never { throw new SourceError(message) }
const object = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const id = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const checkToken = (token: string) => {
  if (typeof token !== 'string' || !token || token.length > 16_384 || /[\x00-\x20\x7f]/.test(token)) fail('Invalid source configuration')
}
const boundedText = (value: string): string => {
  if (value.length > MAX_TEXT) fail('Source message exceeds size limit')
  return value
}
const validSince = (value: string | undefined): boolean => value === undefined || typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value))
function recent(value: unknown, since?: string): boolean {
  if (!since) return true
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('Invalid source response')
  return Date.parse(value) >= Date.parse(since)
}

function githubBase(origin: string): URL {
  let base: URL
  try { base = new URL(origin) } catch { return fail('Invalid source configuration') }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || !['', '/', '/api/v3', '/api/v3/'].includes(base.pathname)) fail('Invalid source configuration')
  base.pathname = base.pathname.replace(/\/$/, '')
  return base
}

/** GET only. A deadline covers both headers and body consumption, and no server-provided URL is followed. */
async function request(url: URL, token: string, signal: AbortSignal | undefined, transport: typeof fetch): Promise<{ value: unknown; headers: Headers }> {
  if (signal?.aborted) fail('Source request cancelled')
  const deadline = AbortSignal.timeout(10_000)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  let response: Response | undefined
  try {
    response = await transport(url, {
      method: 'GET', redirect: 'error', signal: combined,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    })
    if (response.status >= 300 && response.status < 400 || response.redirected) fail('Source redirect rejected')
    if (!response.ok) fail('Source request rejected')
    const advertised = response.headers.get('content-length')
    if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_BYTES)) fail('Source response exceeds size limit')
    if (!response.body) fail('Invalid source response')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (combined.aborted) fail(signal?.aborted ? 'Source request cancelled' : 'Source request timed out')
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > MAX_BYTES) fail('Source response exceeds size limit')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    let value: unknown
    try { value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) } catch { return fail('Invalid source response') }
    return { value, headers: response.headers }
  } catch (error) {
    // Never propagate server bodies, URLs, causes, or arbitrary fetch errors containing credentials.
    if (error instanceof SourceError) throw error
    if (signal?.aborted) fail('Source request cancelled')
    if (deadline.aborted) fail('Source request timed out')
    return fail('Source request failed')
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
  }
}

async function githubPages(base: URL, path: string, token: string, signal: AbortSignal | undefined, transport: typeof fetch, since?: string): Promise<RecordValue[]> {
  const items: RecordValue[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(base)
    url.pathname = `${base.pathname.replace(/\/$/, '')}${path}`
    url.search = new URLSearchParams({ state: 'all', sort: 'updated', direction: 'desc', per_page: '100', page: String(page) }).toString()
    if (since) url.searchParams.set('since', since)
    const { value, headers } = await request(url, token, signal, transport)
    if (!Array.isArray(value) || !value.every(item => object(item))) fail('Invalid source response')
    items.push(...value as RecordValue[])
    // Only use the presence of a next relation. Generate the next URL locally to prevent credential forwarding.
    if (value.length < 100 && !/rel\s*=\s*"?next\b/i.test(headers.get('link') ?? '')) return items
  }
  return fail('Source pagination limit exceeded')
}

function mentioned(body: string, account: string): boolean {
  // LOGIN validation makes interpolation literal; hyphens and underscores cannot extend a mention.
  return new RegExp(`(?:^|[^a-z0-9_@])@${account}(?![a-z0-9_-])`, 'i').test(body)
}
function githubActor(value: unknown, config: GitHubSourceConfig): string | undefined {
  const user = object(value), login = text(user?.login)
  if (user?.type !== 'User' || !LOGIN.test(login) || login.toLowerCase() === config.account.toLowerCase()) return
  return config.allowedActors.some(actor => actor.toLowerCase() === login.toLowerCase()) ? login : undefined
}
function githubNumber(value: unknown, base: URL, repository: string, resource: 'issues' | 'pulls'): number | undefined {
  if (typeof value !== 'string') return
  let url: URL
  try { url = new URL(value) } catch { return }
  const prefix = `${base.pathname.replace(/\/$/, '')}/repos/${repository}/${resource}/`
  if (url.origin !== base.origin || url.search || url.hash || url.username || url.password || !url.pathname.startsWith(prefix)) return
  const suffix = url.pathname.slice(prefix.length)
  return /^\d+$/.test(suffix) && positive(Number(suffix)) ? Number(suffix) : undefined
}
function githubWeb(base: URL, repository: string, number: number, pull: boolean, anchor = ''): string {
  const origin = base.hostname === 'api.github.com' ? 'https://github.com' : base.origin
  return `${origin}/${repository}/${pull ? 'pull' : 'issues'}/${number}${anchor}`
}

function validateGitHub(config: GitHubSourceConfig): URL {
  const base = githubBase(config.origin)
  checkToken(config.token)
  if (!REPOSITORY.test(config.repository) || config.repository.split('/')[1]?.startsWith('.') || !LOGIN.test(config.account)
    || !Array.isArray(config.allowedActors) || config.allowedActors.length > 1000
    || !config.allowedActors.every(actor => LOGIN.test(actor)) || !validSince(config.since)) fail('Invalid source configuration')
  return base
}

/** Provider facts only; the caller determines which locally approved ticket follows this PR. */
export async function readPullRequest(config: GitHubSourceConfig, number: number, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<{ state: 'open' | 'closed'; merged: boolean; head: string }> {
  const base = validateGitHub(config)
  if (!positive(number)) fail('Invalid source configuration')
  const url = new URL(base)
  url.pathname = `${base.pathname.replace(/\/$/, '')}/repos/${config.repository}/pulls/${number}`
  const { value } = await request(url, config.token, signal, transport)
  const pull = object(value), head = text(object(pull?.head)?.sha)
  if (!pull || pull.number !== number || !['open', 'closed'].includes(text(pull.state))
    || typeof pull.merged !== 'boolean' || pull.state === 'open' && pull.merged
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) fail('Invalid source response')
  return { state: pull.state as 'open' | 'closed', merged: pull.merged, head }
}

/** Explicitly invoked bounded scan. The host persists IDs and obtains native UI approval before creating work. */
export async function pollGitHub(config: GitHubSourceConfig, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<InboxItem[]> {
  const base = validateGitHub(config)
  if (!config.allowedActors.length) return []
  const path = `/repos/${config.repository}`
  // Serial reads bound rate use and make a partial failed scan non-authoritative.
  const issues = await githubPages(base, `${path}/issues`, config.token, signal, transport, config.since)
  const comments = await githubPages(base, `${path}/issues/comments`, config.token, signal, transport, config.since)
  const inline = await githubPages(base, `${path}/pulls/comments`, config.token, signal, transport, config.since)
  const result: InboxItem[] = []
  const add = (item: RecordValue, number: number, kind: string, body: string, pull: boolean, anchor = '') => {
    const actor = githubActor(item.user, config)
    if (!actor || !positive(item.id) || !mentioned(body, config.account)
      || !recent(item.updated_at ?? item.submitted_at ?? item.created_at, config.since)) return
    result.push({ id: `github:${id(base.href, config.repository, kind, String(item.id), actor, text(item.updated_at), body)}`,
      source: 'github', actor, text: boundedText(body), thread: String(number), url: githubWeb(base, config.repository, number, pull, anchor) })
  }
  for (const issue of issues) {
    if (!positive(issue.number)) continue
    add(issue, issue.number, 'issue', `${text(issue.title)}\n\n${text(issue.body)}`, !!object(issue.pull_request))
  }
  for (const comment of comments) {
    const number = githubNumber(comment.issue_url, base, config.repository, 'issues')
    if (number) add(comment, number, 'comment', text(comment.body), false, `#issuecomment-${comment.id}`)
  }
  for (const comment of inline) {
    const number = githubNumber(comment.pull_request_url, base, config.repository, 'pulls')
    if (number) add(comment, number, 'review-comment', text(comment.body), true, `#discussion_r${comment.id}`)
  }
  return [...new Map(result.map(item => [item.id, item])).values()]
}

export interface GitHubReviewCursor {
  prPage: number
  prOffset: number
  prPageHash?: string
  previousPrPageHash?: string
  reviewPage: number
  previousReviewPageHash?: string
}

/** Walk all PRs and their reviews in bounded batches, independently of PR updated_at. */
export async function pollGitHubReviewsBatch(config: GitHubSourceConfig, cursor?: GitHubReviewCursor, signal?: AbortSignal,
  transport: typeof fetch = fetch): Promise<{ items: InboxItem[]; next?: GitHubReviewCursor }> {
  const base = validateGitHub(config)
  if (!config.allowedActors.length) return { items: [] }
  const state: GitHubReviewCursor = cursor ?? { prPage: 1, prOffset: 0, reviewPage: 1 }
  const digestValid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (!positive(state.prPage) || state.prPage > 1_000_000 || !Number.isSafeInteger(state.prOffset) || state.prOffset < 0 || state.prOffset > 25
    || !positive(state.reviewPage) || state.reviewPage > 1_000_000
    || state.prOffset > 0 && !digestValid(state.prPageHash)
    || state.prPage > 1 && !digestValid(state.previousPrPageHash)
    || state.reviewPage > 1 && !digestValid(state.previousReviewPageHash)
    || state.reviewPage > 1 && !digestValid(state.prPageHash)) fail('Invalid source configuration')
  const root = `/repos/${config.repository}/pulls`
  const page = async (path: string, pageNumber: number, size: number, pulls: boolean) => {
    const url = new URL(base)
    url.pathname = `${base.pathname.replace(/\/$/, '')}${path}`
    url.search = new URLSearchParams({ ...(pulls ? { state: 'all', sort: 'created', direction: 'asc' } : {}), per_page: String(size), page: String(pageNumber) }).toString()
    const { value, headers } = await request(url, config.token, signal, transport)
    if (!Array.isArray(value) || value.length > size || !value.every(item => object(item) && positive(pulls ? item.number : item.id))) fail('Invalid source response')
    const rows = value as RecordValue[]
    const hash = id(...rows.map(item => String(pulls ? item.number : item.id)))
    const hasNext = rows.length === size || /rel\s*=\s*"?next\b/i.test(headers.get('link') ?? '')
    return { rows, hash, hasNext }
  }
  if (state.prPage > 1) {
    const previous = await page(root, state.prPage - 1, 25, true)
    if (previous.hash !== state.previousPrPageHash) fail('GitHub review scan changed; restart the scan')
  }
  const pulls = await page(root, state.prPage, 25, true)
  if (state.prOffset > pulls.rows.length || state.prPageHash && state.prPageHash !== pulls.hash) fail('GitHub review scan changed; restart the scan')
  const items: InboxItem[] = []
  let offset = state.prOffset, reviewPage = state.reviewPage, previousReviewPageHash = state.previousReviewPageHash
  let requests = 0
  while (offset < pulls.rows.length && requests < 25) {
    const number = pulls.rows[offset]!.number as number
    const reviewPath = `${root}/${number}/reviews`
    if (reviewPage > 1) {
      const previous = await page(reviewPath, reviewPage - 1, 100, false)
      if (previous.hash !== previousReviewPageHash) fail('GitHub review scan changed; restart the scan')
    }
    const reviews = await page(reviewPath, reviewPage, 100, false)
    requests++
    for (const review of reviews.rows) {
      const actor = githubActor(review.user, config), body = text(review.body)
      if (!actor || !mentioned(body, config.account)) continue
      items.push({ id: `github:${id(base.href, config.repository, 'review', String(review.id), actor, text(review.updated_at), body)}`,
        source: 'github', actor, text: boundedText(body), thread: String(number), url: githubWeb(base, config.repository, number, true, `#pullrequestreview-${review.id}`) })
    }
    if (reviews.hasNext) { reviewPage++; previousReviewPageHash = reviews.hash }
    else { offset++; reviewPage = 1; previousReviewPageHash = undefined }
  }
  let next: GitHubReviewCursor | undefined
  if (offset < pulls.rows.length) next = { ...state, prOffset: offset, prPageHash: pulls.hash, reviewPage, previousReviewPageHash }
  else if (pulls.hasNext) next = { prPage: state.prPage + 1, prOffset: 0, previousPrPageHash: pulls.hash, reviewPage: 1 }
  return { items: [...new Map(items.map(item => [item.id, item])).values()], ...(next ? { next } : {}) }
}

/** Plain-text extraction only; the result is never rendered as HTML or executed. */
function teamsText(body: RecordValue): string {
  const content = boundedText(text(body.content))
  if (body.contentType === 'text') return content
  if (body.contentType !== 'html') return ''
  return content.replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[^]*?-->/g, '').replace(/<\s*br\s*\/?\s*>|<\/\s*(?:p|div|li)\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|[0-9]+);|&(amp|lt|gt|quot|apos|nbsp);/gi, (_match, numeric: string | undefined, named: string | undefined) => {
      if (numeric) {
        const point = numeric[0]?.toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : parseInt(numeric, 10)
        return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : ''
      }
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[named?.toLowerCase() ?? ''] ?? ''
    }).trim()
}
function sameGraphPath(actual: string, expected: string): boolean {
  // Graph emits literal ':'/'@' in nextLink IDs even when the request encoded them.
  const segments = actual.split('/'), target = expected.split('/')
  try { return segments.length === target.length && segments.every((segment, index) => decodeURIComponent(segment) === decodeURIComponent(target[index]!)) }
  catch { return false }
}

async function teamsPages(path: string, token: string, signal: AbortSignal | undefined, transport: typeof fetch, since?: string,
  batch?: { token?: string }): Promise<RecordValue[] | { items: RecordValue[]; next?: string }> {
  let url = new URL(`https://graph.microsoft.com${path}`)
  const ordered = path.startsWith('/v1.0/chats/')
  url.searchParams.set('$top', '50')
  if (ordered) url.searchParams.set('$orderby', 'lastModifiedDateTime desc')
  if (batch?.token) url.searchParams.set('$skiptoken', batch.token)
  const seen = new Set<string>(), items: RecordValue[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (seen.has(url.href)) fail('Invalid source response')
    seen.add(url.href)
    const { value } = await request(url, token, signal, transport), envelope = object(value)
    if (!envelope || !Array.isArray(envelope.value) || !envelope.value.every(item => object(item))) fail('Invalid source response')
    items.push(...envelope.value as RecordValue[])
    // Chat history supports this explicit ordering; no such assumption is made for channel roots or replies.
    if (since && ordered && envelope.value.length && envelope.value.every(item => !recent(item.lastModifiedDateTime ?? item.createdDateTime, since))) return batch ? { items } : items
    const next = envelope['@odata.nextLink']
    if (next === undefined) return batch ? { items } : items
    if (typeof next !== 'string' || next.length > 8192) fail('Invalid source response')
    let parsed: URL
    try { parsed = new URL(next) } catch { return fail('Invalid source response') }
    // A trusted Graph nextLink may contain only the original $top and an opaque skip token.
    if (parsed.origin !== 'https://graph.microsoft.com' || !sameGraphPath(parsed.pathname, path) || parsed.username || parsed.password || parsed.hash
      || [...parsed.searchParams.keys()].some(key => !['$top', '$skiptoken', ...(ordered ? ['$orderby'] : [])].includes(key))
      || parsed.searchParams.getAll('$top').length > 1 || parsed.searchParams.getAll('$skiptoken').length !== 1
      || parsed.searchParams.getAll('$orderby').length > 1 || parsed.searchParams.has('$orderby') && parsed.searchParams.get('$orderby') !== 'lastModifiedDateTime desc'
      || !parsed.searchParams.get('$skiptoken') || parsed.searchParams.has('$top') && parsed.searchParams.get('$top') !== '50') fail('Invalid source pagination address')
    if (batch) {
      const nextToken = parsed.searchParams.get('$skiptoken')!
      if (nextToken === batch.token) fail('Invalid source response')
      return { items, next: nextToken }
    }
    if (page === MAX_PAGES) fail('Source pagination limit exceeded')
    // Reconstruct even the validated continuation to keep the credential destination fixed.
    url = new URL(`https://graph.microsoft.com${path}`)
    url.searchParams.set('$top', '50'); url.searchParams.set('$skiptoken', parsed.searchParams.get('$skiptoken')!)
    if (ordered) url.searchParams.set('$orderby', 'lastModifiedDateTime desc')
  }
  return fail('Source pagination limit exceeded')
}

/** Delegated native-auth token only, scoped to the configured tenant, chats and channels. Read-only. */
export async function pollTeams(config: TeamsSourceConfig, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<InboxItem[]> {
  const batch = await pollTeamsBatch(config, undefined, signal, transport)
  if (batch.next) fail('Source scan requires continuation')
  return batch.items
}

export interface TeamsBatchCursor { token?: string; offset: number; pageHash?: string }
export async function pollTeamsBatch(config: TeamsSourceConfig, cursor?: TeamsBatchCursor, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<{ items: InboxItem[]; next?: TeamsBatchCursor }> {
  checkToken(config.token)
  if (!UUID.test(config.tenantId) || !Array.isArray(config.chatIds) || config.chatIds.length > 50
    || !config.chatIds.every(chat => TEAMS_ID.test(chat) && chat !== '.' && chat !== '..')
    || !Array.isArray(config.channels) || config.channels.length > 50
    || !config.channels.every(channel => UUID.test(channel.teamId) && TEAMS_ID.test(channel.channelId) && channel.channelId !== '.' && channel.channelId !== '..')
    || !Array.isArray(config.allowedActors) || config.allowedActors.length > 1000 || !config.allowedActors.every(actor => UUID.test(actor)) || !validSince(config.since)) fail('Invalid source configuration')
  if (!config.allowedActors.length) return { items: [] }
  if (cursor && (config.chatIds.length !== 0 || config.channels.length !== 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 50
    || cursor.token !== undefined && (typeof cursor.token !== 'string' || !cursor.token || cursor.token.length > 8192)
    || cursor.offset > 0 && (typeof cursor.pageHash !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.pageHash)))) fail('Invalid source configuration')
  const allowed = new Set(config.allowedActors.map(actor => actor.toLowerCase())), items: InboxItem[] = []
  const add = (message: RecordValue, scope: string, root?: string) => {
    const from = object(message.from), user = object(from?.user), body = object(message.body)
    const actor = text(user?.id), messageId = text(message.id)
    if (from?.application || !user || !UUID.test(actor) || !allowed.has(actor.toLowerCase()) || !TEAMS_ID.test(messageId)
      || message.deletedDateTime || message.messageType !== 'message' || !body || user.tenantId !== undefined && text(user.tenantId).toLowerCase() !== config.tenantId.toLowerCase()) return
    if (!recent(message.lastModifiedDateTime ?? message.createdDateTime, config.since)) return
    const content = teamsText(body)
    if (!content.trim()) return
    items.push({ id: `teams:${id(config.tenantId.toLowerCase(), scope, messageId, actor.toLowerCase(), content, text(message.lastEditedDateTime))}`,
      source: 'teams', actor, text: content, thread: `${scope}:${root ?? (text(message.replyToId) || messageId)}` })
  }
  for (const chat of [...new Set(config.chatIds)]) {
    const messages = await teamsPages(`/v1.0/chats/${encodeURIComponent(chat)}/messages`, config.token, signal, transport, config.since)
    for (const message of messages as RecordValue[]) add(message, `chat:${chat}`)
  }
  for (const channel of config.channels) {
    const scope = `team:${channel.teamId.toLowerCase()}:channel:${channel.channelId}`
    const path = `/v1.0/teams/${encodeURIComponent(channel.teamId)}/channels/${encodeURIComponent(channel.channelId)}/messages`
    if (config.chatIds.length || config.channels.length !== 1) fail('Channel scans require one configured source per batch')
    const page = await teamsPages(path, config.token, signal, transport, config.since, { token: cursor?.token }) as { items: RecordValue[]; next?: string }
    const offset = cursor?.offset ?? 0
    if (offset > page.items.length) fail('Source page changed; restart the channel scan')
    const pageHash = id(...page.items.map(item => text(item.id)))
    if (offset && cursor?.pageHash !== pageHash) fail('Source page changed; restart the channel scan')
    const messages = page.items.slice(offset, offset + 25)
    for (const message of messages) {
      add(message, scope)
      const messageId = text(message.id)
      if (!TEAMS_ID.test(messageId) || messageId === '.' || messageId === '..') continue
      const replies = await teamsPages(`${path}/${encodeURIComponent(messageId)}/replies`, config.token, signal, transport, config.since)
      for (const reply of replies as RecordValue[]) add(reply, scope, messageId)
    }
    const nextOffset = offset + messages.length
    const next = nextOffset < page.items.length ? { token: cursor?.token, offset: nextOffset, pageHash }
      : page.next ? { token: page.next, offset: 0 } : undefined
    return { items: [...new Map(items.map(item => [item.id, item])).values()], ...(next ? { next } : {}) }
  }
  return { items: [...new Map(items.map(item => [item.id, item])).values()] }
}
