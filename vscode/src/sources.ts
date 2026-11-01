import { createHash } from 'node:crypto'
import type { ThreadRef, Trigger } from '../../src/core/model.ts'

interface ProviderContext {
  /** Stable configuration identity, contains no credentials. */
  sourceConfigId: string
  nativeThreadId: string
  originalUrl?: string
  createdAt?: string
  updatedAt?: string
  human: boolean
  bot: boolean
  addressed?: 'mention' | 'direct'
  allowedActor: boolean
  subscribed: boolean
}
export interface GitHubContext extends ProviderContext {
  provider: 'github'
  origin: string
  repository: string
  account: string
  number: number
  isPullRequest: boolean
  kind: 'issue' | 'pull' | 'comment' | 'review-comment' | 'review' | 'checks'
  commentId?: number
  reviewId?: number
  reviewRootCommentId?: number
  reviewThreadId?: string
  inReplyToId?: number
  path?: string
  line?: number
  originalLine?: number
  diffHunk?: string
  commitId?: string
  state?: string
  prAuthor?: string
}
export interface TeamsContext extends ProviderContext {
  provider: 'teams'
  tenantId: string
  chatId?: string
  teamId?: string
  channelId?: string
  rootMessageId: string
  messageId: string
  editedAt?: string
  referencedMessageIds?: string[]
}
export type SourceContext = GitHubContext | TeamsContext

/** Value to persist in subscribedNumbers/subscribedThreads for an approved source thread. */
export function sourceSubscription(context: SourceContext): number | string {
  if (context.provider === 'github') return context.number
  const scope = context.chatId ? `chat:${context.chatId}` : `team:${context.teamId!.toLowerCase()}:channel:${context.channelId}`
  return `${scope}:${context.rootMessageId}`
}

/** Remote content is an inbox candidate only; it never grants execution authority. */
export interface InboxItem {
  id: string
  source: 'github' | 'teams'
  actor: string
  text: string
  url?: string
  thread: string
  /** New provider events always include this; optional for pre-migration persisted inbox entries. */
  context?: SourceContext
}
export interface GitHubSourceConfig {
  /** User/application-scoped setting, never read from a workspace or a model request. */
  origin: string
  repository: string
  account: string
  allowedActors: string[]
  token: string
  since?: string
  subscribedNumbers?: number[]
  observeIssues?: boolean
  observePullRequests?: boolean
  observeComments?: boolean
  observeReviews?: boolean
  observeChecks?: boolean
  /** Bot events are context only, including when explicitly listed here. */
  allowedBots?: string[]
}
export interface TeamsSourceConfig {
  /** Native auth must select this tenant. The caller must never reuse a token entered for another tenant. */
  tenantId: string
  chatIds: string[]
  channels: { teamId: string; channelId: string }[]
  allowedActors: string[]
  token: string
  since?: string
  accountId?: string
  /** Native `thread` values from approved tickets, never taken from a remote message. */
  subscribedThreads?: string[]
  allowedBots?: string[]
}

const MAX_BYTES = 1024 * 1024
const MAX_PAGES = 5
const MAX_TEXT = 50_000
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const REPOSITORY = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_-][a-z\d_.-]{0,99}$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TEAMS_ID = /^[a-zA-Z0-9_:@.-]{1,256}$/
const validNativeTeamsId = (value: string) => TEAMS_ID.test(value) && value !== '.' && value !== '..'
type RecordValue = Record<string, unknown>

export class SourceError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}
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

export function githubBase(origin: string): URL {
  let base: URL
  try { base = new URL(origin) } catch { return fail('Invalid source configuration') }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || !['', '/', '/api/v3', '/api/v3/'].includes(base.pathname)) fail('Invalid source configuration')
  base.pathname = base.pathname.replace(/\/$/, '')
  return base
}

/** Bounded JSON transport for locally constructed URLs. Callers must validate provider scope before invoking it. */
export async function sourceRequest(url: URL, token: string, signal: AbortSignal | undefined, transport: typeof fetch,
  write?: { body: unknown }): Promise<{ value: unknown; headers: Headers }> {
  checkToken(token)
  const body = write ? JSON.stringify(write.body) : undefined
  if (body && Buffer.byteLength(body) > MAX_BYTES) fail('Source message exceeds size limit')
  if (signal?.aborted) fail('Source request cancelled')
  const deadline = AbortSignal.timeout(10_000)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  let response: Response | undefined
  try {
    response = await transport(url, {
      method: write ? 'POST' : 'GET', redirect: 'error', signal: combined,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(write ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body } : {}),
    })
    if (response.status >= 300 && response.status < 400 || response.redirected) fail('Source redirect rejected')
    if (!response.ok) throw new SourceError('Source request rejected', response.status)
    const advertised = response.headers.get('content-length')
    if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_BYTES)) fail('Source response exceeds size limit')
    if (!response.body) fail('Invalid source response')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          const abort = () => reject(new SourceError(signal?.aborted ? 'Source request cancelled' : 'Source request timed out'))
          if (combined.aborted) return abort()
          combined.addEventListener('abort', abort, { once: true })
          reader.read().then(resolve, reject).finally(() => combined.removeEventListener('abort', abort)).catch(() => {})
        })
        if (combined.aborted) fail(signal?.aborted ? 'Source request cancelled' : 'Source request timed out')
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > MAX_BYTES) fail('Source response exceeds size limit')
        chunks.push(chunk.value)
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
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
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {})
  }
}
const request = sourceRequest

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
  if (!['User', 'Bot'].includes(text(user?.type)) || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?(?:\[bot\])?$/i.test(login)
    || login.toLowerCase() === config.account.toLowerCase()) return
  return login
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

export function validateGitHub(config: GitHubSourceConfig): URL {
  const base = githubBase(config.origin)
  checkToken(config.token)
  if (!REPOSITORY.test(config.repository) || config.repository.split('/')[1]?.startsWith('.') || !LOGIN.test(config.account)
    || !Array.isArray(config.allowedActors) || config.allowedActors.length > 1000
    || !config.allowedActors.every(actor => LOGIN.test(actor)) || !validSince(config.since)
    || config.subscribedNumbers !== undefined && (!Array.isArray(config.subscribedNumbers) || config.subscribedNumbers.length > 1000 || !config.subscribedNumbers.every(positive))
    || config.allowedBots !== undefined && (!Array.isArray(config.allowedBots) || config.allowedBots.length > 1000 || !config.allowedBots.every(actor => typeof actor === 'string' && /^[a-z\d-]{1,39}(?:\[bot\])?$/i.test(actor)))
    || ['observeIssues', 'observePullRequests', 'observeComments', 'observeReviews', 'observeChecks'].some(key => (config as unknown as RecordValue)[key] !== undefined && typeof (config as unknown as RecordValue)[key] !== 'boolean')) fail('Invalid source configuration')
  return base
}

/** Namespaces provider-native thread IDs by their actual receiving scope. */
export function sourceNamespace(context: SourceContext): string {
  return context.provider === 'github' ? `github:${id(githubBase(context.origin).href, context.repository.toLowerCase())}`
    : `teams:${id(context.tenantId.toLowerCase(), context.chatId ? `chat:${context.chatId}` : `team:${context.teamId?.toLowerCase()}:channel:${context.channelId}`)}`
}
/** Exact repository-scoped domain identity for PR discovery and approved claims. */
export function githubThreadRef(config: GitHubSourceConfig, number: number): ThreadRef {
  const base = validateGitHub(config)
  if (!positive(number)) fail('Invalid source configuration')
  return { source: `github:${id(base.href, config.repository.toLowerCase())}`, id: String(number) }
}

/** Converts provider facts into a domain event. No provider flag grants a local execution mandate. */
export function sourceTrigger(item: InboxItem): Trigger {
  const context = item.context
  if (!context || context.provider !== item.source) fail('Source context missing; refresh the inbox')
  const source = sourceNamespace(context), thread = context.nativeThreadId
  const address: Record<string, string> = context.provider === 'github'
    ? { origin: context.origin, repository: context.repository, number: String(context.number),
      ...(context.reviewRootCommentId ? { reviewRootCommentId: String(context.reviewRootCommentId) } : {}),
      ...(context.reviewThreadId ? { reviewThreadId: context.reviewThreadId } : {}) }
    : { tenantId: context.tenantId, rootMessageId: context.rootMessageId, messageId: context.messageId,
      ...(context.chatId ? { chatId: context.chatId } : { teamId: context.teamId!, channelId: context.channelId! }) }
  if (item.url) address.url = item.url
  const threadIds = context.provider === 'teams' ? [...new Set([thread, ...(context.referencedMessageIds ?? [])])] : [thread]
  return { id: item.id, source, threads: threadIds.map(id => ({ source, id })), actor: { source, id: item.actor }, human: context.human,
    ...(context.addressed ? { addressed: context.addressed } : {}), at: context.updatedAt ?? context.createdAt ?? '1970-01-01T00:00:00.000Z',
    text: item.text, ...(item.url ? { url: item.url } : {}), channel: { source, thread: `${source}:${thread}`, address },
    meta: { provider: { ...context }, sourceConfigId: context.sourceConfigId, allowedActor: context.allowedActor, contextOnly: !context.allowedActor || !context.human } }
}

function githubItem(config: GitHubSourceConfig, base: URL, item: RecordValue, number: number,
  kind: GitHubContext['kind'], body: string, pull: boolean, anchor = '', force = false): InboxItem | undefined {
  const actor = githubActor(item.user, config) ?? (force && text(object(item.user)?.login).toLowerCase() === config.account.toLowerCase() ? config.account : undefined)
  if (!actor || !positive(item.id)) return
  const user = object(item.user), human = user?.type === 'User' && !actor.endsWith('[bot]') && actor.toLowerCase() !== config.account.toLowerCase()
  const allowedActor = human && config.allowedActors.some(value => value.toLowerCase() === actor.toLowerCase())
  const subscribed = config.subscribedNumbers?.includes(number) ?? false
  const addressed = mentioned(body, config.account)
  const observed = kind === 'issue' ? config.observeIssues : kind === 'pull' ? config.observePullRequests
    : kind === 'review' || kind === 'review-comment' ? config.observeReviews : config.observeComments
  const listedBot = config.allowedBots?.some(value => value.toLowerCase() === actor.toLowerCase()) ?? false
  if (!force && !subscribed && !(human && allowedActor && (addressed || observed)) && !(listedBot && observed)) return
  let url = githubWeb(base, config.repository, number, pull, anchor)
  if (typeof item.html_url === 'string') {
    try {
      const original = new URL(item.html_url), expected = new URL(url)
      if (original.origin === expected.origin && !original.username && !original.password && !original.search
        && [`/${config.repository}/issues/${number}`, `/${config.repository}/pull/${number}`].includes(original.pathname)
        && original.hash === expected.hash) { url = original.href; pull = original.pathname.includes('/pull/') }
    } catch {}
  }
  const context: GitHubContext = { provider: 'github', sourceConfigId: `github:${id(base.href, config.repository.toLowerCase(), config.account.toLowerCase())}`,
    origin: base.href.replace(/\/$/, ''), repository: config.repository, account: config.account, number, nativeThreadId: String(number),
    originalUrl: url, isPullRequest: pull, kind, human, bot: !human, allowedActor, subscribed,
    ...(addressed ? { addressed: 'mention' } : {}), ...(text(item.created_at ?? item.submitted_at) ? { createdAt: text(item.created_at ?? item.submitted_at) } : {}),
    ...(text(item.updated_at) ? { updatedAt: text(item.updated_at) } : {}),
    ...(kind === 'comment' || kind === 'review-comment' ? { commentId: item.id } : {}),
    ...(kind === 'review' ? { reviewId: item.id } : positive(item.pull_request_review_id) ? { reviewId: item.pull_request_review_id } : {}),
    ...(kind === 'review-comment' ? { reviewRootCommentId: positive(item.in_reply_to_id) ? item.in_reply_to_id : item.id } : {}),
    ...(positive(item.in_reply_to_id) ? { inReplyToId: item.in_reply_to_id } : {}),
    ...(typeof item.path === 'string' ? { path: boundedText(item.path) } : {}), ...(positive(item.line) ? { line: item.line } : {}),
    ...(positive(item.original_line) ? { originalLine: item.original_line } : {}), ...(typeof item.diff_hunk === 'string' ? { diffHunk: boundedText(item.diff_hunk) } : {}),
    ...(typeof item.commit_id === 'string' ? { commitId: item.commit_id } : {}), ...(typeof item.state === 'string' ? { state: item.state } : {}) }
  return { id: `github:${id(base.href, config.repository, kind, String(item.id), actor, text(item.updated_at), body,
    ...(kind === 'review' ? [text(item.state), text(item.commit_id)] : []))}`,
    source: 'github', actor, text: boundedText(body), thread: String(number), url, context }
}

/** Provider facts only; the caller determines which locally approved ticket follows this PR. */
export interface PullRequestState {
  state: 'open' | 'closed'
  merged: boolean
  head: string
  author?: string
  branch?: string
  draft?: boolean
  closedAt?: string
  mergedAt?: string
}
export async function readPullRequest(config: GitHubSourceConfig, number: number, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<PullRequestState> {
  const base = validateGitHub(config)
  if (!positive(number)) fail('Invalid source configuration')
  const url = new URL(base)
  url.pathname = `${base.pathname.replace(/\/$/, '')}/repos/${config.repository}/pulls/${number}`
  const { value } = await request(url, config.token, signal, transport)
  const pull = object(value), head = text(object(pull?.head)?.sha)
  if (!pull || pull.number !== number || !['open', 'closed'].includes(text(pull.state))
    || typeof pull.merged !== 'boolean' || pull.state === 'open' && pull.merged
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) fail('Invalid source response')
  const author = text(object(pull.user)?.login), branch = text(object(pull.head)?.ref)
  return { state: pull.state as 'open' | 'closed', merged: pull.merged, head,
    ...(author ? { author: boundedText(author) } : {}), ...(branch ? { branch: boundedText(branch) } : {}),
    ...(typeof pull.draft === 'boolean' ? { draft: pull.draft } : {}),
    ...(typeof pull.closed_at === 'string' ? { closedAt: pull.closed_at } : {}), ...(typeof pull.merged_at === 'string' ? { mergedAt: pull.merged_at } : {}) }
}

/** Explicitly invoked bounded scan. The host persists IDs and obtains native UI approval before creating work. */
export async function pollGitHub(config: GitHubSourceConfig, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<InboxItem[]> {
  const base = validateGitHub(config)
  if (!config.allowedActors.length && !config.subscribedNumbers?.length && !config.allowedBots?.length) return []
  const path = `/repos/${config.repository}`
  // Serial reads bound rate use and make a partial failed scan non-authoritative.
  const issues = await githubPages(base, `${path}/issues`, config.token, signal, transport, config.since)
  const comments = await githubPages(base, `${path}/issues/comments`, config.token, signal, transport, config.since)
  const inline = await githubPages(base, `${path}/pulls/comments`, config.token, signal, transport, config.since)
  const result: InboxItem[] = []
  const add = (item: RecordValue, number: number, kind: string, body: string, pull: boolean, anchor = '') => {
    if (!recent(item.updated_at ?? item.submitted_at ?? item.created_at, config.since)) return
    const candidate = githubItem(config, base, item, number, kind as GitHubContext['kind'], body, pull, anchor)
    if (candidate) result.push(candidate)
  }
  for (const issue of issues) {
    if (!positive(issue.number)) continue
    add(issue, issue.number, object(issue.pull_request) ? 'pull' : 'issue', `${text(issue.title)}\n\n${text(issue.body)}`, !!object(issue.pull_request))
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
  if (!config.allowedActors.length && !config.subscribedNumbers?.length && !config.allowedBots?.length) return { items: [] }
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
      const candidate = githubItem(config, base, review, number, 'review', text(review.body), true, `#pullrequestreview-${review.id}`)
      if (candidate) items.push(candidate)
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
export function sameGraphPath(actual: string, expected: string): boolean {
  // Graph emits literal ':'/'@' in nextLink IDs even when the request encoded them.
  const segments = actual.split('/'), target = expected.split('/')
  try { return segments.length === target.length && segments.every((segment, index) => decodeURIComponent(segment) === decodeURIComponent(target[index]!)) }
  catch { return false }
}

export async function teamsPages(path: string, token: string, signal: AbortSignal | undefined, transport: typeof fetch, since?: string,
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
/** Graph quote replies carry messageReference attachments; older clients also emit Teams message links. */
function teamsReferences(message: RecordValue, chatId: string): string[] {
  const references: string[] = []
  if (Array.isArray(message.attachments)) for (const value of message.attachments.slice(0, 10)) {
    const attachment = object(value)
    if (attachment?.contentType !== 'messageReference' || typeof attachment.content !== 'string' || attachment.content.length > MAX_TEXT) continue
    try { const messageId = text(object(JSON.parse(attachment.content))?.messageId); if (validNativeTeamsId(messageId)) references.push(messageId) } catch {}
  }
  const body = object(message.body)
  const quoted = body?.contentType === 'html' ? /<blockquote\b[^>]*\bitemid=["']([^"']+)["']/i.exec(text(body.content))?.[1] : undefined
  if (quoted) {
    try { const link = new URL(quoted), segments = link.pathname.split('/')
      if (link.protocol === 'https:' && link.hostname === 'teams.microsoft.com' && segments[1] === 'l' && segments[2] === 'message'
        && decodeURIComponent(segments[3] ?? '') === chatId && validNativeTeamsId(decodeURIComponent(segments[4] ?? ''))) references.push(decodeURIComponent(segments[4]!))
    } catch {}
  }
  return [...new Set(references)]
}
export function validateTeams(config: TeamsSourceConfig): void {
  checkToken(config.token)
  if (!UUID.test(config.tenantId) || !Array.isArray(config.chatIds) || config.chatIds.length > 50
    || !config.chatIds.every(chat => TEAMS_ID.test(chat) && chat !== '.' && chat !== '..')
    || !Array.isArray(config.channels) || config.channels.length > 50
    || !config.channels.every(channel => UUID.test(channel.teamId) && TEAMS_ID.test(channel.channelId) && channel.channelId !== '.' && channel.channelId !== '..')
    || !Array.isArray(config.allowedActors) || config.allowedActors.length > 1000 || !config.allowedActors.every(actor => UUID.test(actor)) || !validSince(config.since)
    || config.accountId !== undefined && !UUID.test(config.accountId)
    || config.allowedBots !== undefined && (!Array.isArray(config.allowedBots) || config.allowedBots.length > 1000 || !config.allowedBots.every(actor => UUID.test(actor)))
    || config.subscribedThreads !== undefined && (!Array.isArray(config.subscribedThreads) || config.subscribedThreads.length > 1000 || !config.subscribedThreads.every(thread => typeof thread === 'string' && thread.length <= 1024 && /^(?:chat:|team:)/.test(thread)))) fail('Invalid source configuration')
}
export async function pollTeamsBatch(config: TeamsSourceConfig, cursor?: TeamsBatchCursor, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<{ items: InboxItem[]; next?: TeamsBatchCursor }> {
  validateTeams(config)
  if (!config.allowedActors.length && !config.subscribedThreads?.length) return { items: [] }
  if (cursor && (config.chatIds.length !== 0 || config.channels.length !== 1 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 50
    || cursor.token !== undefined && (typeof cursor.token !== 'string' || !cursor.token || cursor.token.length > 8192)
    || cursor.offset > 0 && (typeof cursor.pageHash !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.pageHash)))) fail('Invalid source configuration')
  const allowed = new Set(config.allowedActors.map(actor => actor.toLowerCase())), items: InboxItem[] = []
  const add = (message: RecordValue, receiving: { chatId: string } | { teamId: string; channelId: string }, root?: string) => {
    const scope = 'chatId' in receiving ? `chat:${receiving.chatId}` : `team:${receiving.teamId.toLowerCase()}:channel:${receiving.channelId}`
    const from = object(message.from), user = object(from?.user), application = object(from?.application), body = object(message.body)
    const actor = text(application?.id ?? user?.id), messageId = text(message.id)
    const references = 'chatId' in receiving ? teamsReferences(message, receiving.chatId) : []
    const rootMessageId = root ?? (text(message.replyToId) || references[0] || messageId)
    const human = !!user && !application, allowedActor = human && allowed.has(actor.toLowerCase())
    const subscribed = config.subscribedThreads?.includes(`${scope}:${rootMessageId}`) ?? false
    if (!UUID.test(actor) || actor.toLowerCase() === config.accountId?.toLowerCase() || !TEAMS_ID.test(messageId) || ['.', '..'].includes(messageId)
      || !TEAMS_ID.test(rootMessageId) || ['.', '..'].includes(rootMessageId) || !subscribed && !allowedActor
      || message.deletedDateTime || message.messageType !== 'message' || !body || user?.tenantId !== undefined && text(user.tenantId).toLowerCase() !== config.tenantId.toLowerCase()) return
    if (!recent(message.lastModifiedDateTime ?? message.createdDateTime, config.since)) return
    const content = teamsText(body)
    if (!content.trim()) return
    // Our own deterministic delivery marker is excluded even when native auth has not supplied an account ID yet.
    if (/\[superagent:[a-f0-9]{64}\]/.test(content)) return
    let url: string | undefined
    if (typeof message.webUrl === 'string') {
      try { const parsed = new URL(message.webUrl); if (parsed.protocol === 'https:' && ['teams.microsoft.com', 'teams.cloud.microsoft'].includes(parsed.hostname) && !parsed.username && !parsed.password) url = parsed.href } catch {}
    }
    const mentions = Array.isArray(message.mentions) && message.mentions.some(mention => text(object(object(object(mention)?.mentioned)?.user)?.id).toLowerCase() === config.accountId?.toLowerCase())
    const context: TeamsContext = { provider: 'teams', sourceConfigId: `teams:${id(config.tenantId.toLowerCase(), scope)}`,
      tenantId: config.tenantId, ...receiving, nativeThreadId: rootMessageId, rootMessageId, messageId, human, bot: !human,
      ...(references.length ? { referencedMessageIds: references } : {}),
      allowedActor, subscribed, ...(mentions ? { addressed: 'mention' } : {}), ...(url ? { originalUrl: url } : {}),
      ...(text(message.createdDateTime) ? { createdAt: text(message.createdDateTime) } : {}),
      ...(text(message.lastModifiedDateTime) ? { updatedAt: text(message.lastModifiedDateTime) } : {}),
      ...(text(message.lastEditedDateTime) ? { editedAt: text(message.lastEditedDateTime) } : {}) }
    items.push({ id: `teams:${id(config.tenantId.toLowerCase(), scope, messageId, actor.toLowerCase(), content, text(message.lastEditedDateTime))}`,
      source: 'teams', actor, text: content, thread: `${scope}:${rootMessageId}`, ...(url ? { url } : {}), context })
  }
  for (const chat of [...new Set(config.chatIds)]) {
    const messages = await teamsPages(`/v1.0/chats/${encodeURIComponent(chat)}/messages`, config.token, signal, transport, config.since) as RecordValue[]
    const byId = new Map(messages.map(message => [text(message.id), message]))
    const rootOf = (message: RecordValue): string | undefined => {
      let root = text(message.replyToId) || teamsReferences(message, chat)[0]
      if (!root) return
      const seen = new Set([text(message.id)])
      for (let depth = 0; depth < 20; depth++) {
        if (seen.has(root)) return // Cyclic remote references cannot define an original thread.
        seen.add(root)
        const previous = byId.get(root), next = previous && (text(previous.replyToId) || teamsReferences(previous, chat)[0])
        if (!next) return root
        root = next
      }
      return
    }
    for (const message of messages) add(message, { chatId: chat }, rootOf(message))
  }
  for (const channel of config.channels) {
    const path = `/v1.0/teams/${encodeURIComponent(channel.teamId)}/channels/${encodeURIComponent(channel.channelId)}/messages`
    if (config.chatIds.length || config.channels.length !== 1) fail('Channel scans require one configured source per batch')
    const page = await teamsPages(path, config.token, signal, transport, config.since, { token: cursor?.token }) as { items: RecordValue[]; next?: string }
    const offset = cursor?.offset ?? 0
    if (offset > page.items.length) fail('Source page changed; restart the channel scan')
    const pageHash = id(...page.items.map(item => text(item.id)))
    if (offset && cursor?.pageHash !== pageHash) fail('Source page changed; restart the channel scan')
    const messages = page.items.slice(offset, offset + 25)
    for (const message of messages) {
      add(message, channel)
      const messageId = text(message.id)
      if (!TEAMS_ID.test(messageId) || messageId === '.' || messageId === '..') continue
      const replies = await teamsPages(`${path}/${encodeURIComponent(messageId)}/replies`, config.token, signal, transport, config.since)
      for (const reply of replies as RecordValue[]) add(reply, channel, messageId)
    }
    const nextOffset = offset + messages.length
    const next = nextOffset < page.items.length ? { token: cursor?.token, offset: nextOffset, pageHash }
      : page.next ? { token: page.next, offset: 0 } : undefined
    return { items: [...new Map(items.map(item => [item.id, item])).values()], ...(next ? { next } : {}) }
  }
  return { items: [...new Map(items.map(item => [item.id, item])).values()] }
}


export interface PullRequestDiscovery {
  number: number
  head: string
  branch: string
  state: 'open' | 'closed'
  url: string
  author: string
}
/** Bounded repository-local discovery; no search API or response-supplied URLs are followed. */
export async function discoverOwnPullRequests(config: GitHubSourceConfig, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<PullRequestDiscovery[]> {
  const base = validateGitHub(config)
  const rows = await githubPages(base, `/repos/${config.repository}/pulls`, config.token, signal, transport)
  return rows.filter(pull => text(object(pull.user)?.login).toLowerCase() === config.account.toLowerCase()).map(pull => {
    const head = object(pull.head)
    if (!positive(pull.number) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(text(head?.sha)) || !['open', 'closed'].includes(text(pull.state))) fail('Invalid source response')
    return { number: pull.number, head: text(head?.sha), branch: boundedText(text(head?.ref)), state: pull.state as 'open' | 'closed',
      url: githubWeb(base, config.repository, pull.number, true), author: text(object(pull.user)?.login) }
  })
}

/** Full issue/PR conversation, reviews and inline comments. Oversized histories fail visibly at five pages per collection. */
export async function readGitHubThread(config: GitHubSourceConfig, number: number, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<InboxItem[]> {
  const base = validateGitHub(config)
  if (!positive(number)) fail('Invalid source configuration')
  const path = `/repos/${config.repository}`, url = new URL(base)
  url.pathname = `${base.pathname.replace(/\/$/, '')}${path}/issues/${number}`
  const { value } = await request(url, config.token, signal, transport), issue = object(value)
  if (!issue || issue.number !== number) fail('Invalid source response')
  const pull = !!object(issue.pull_request), items: InboxItem[] = []
  const append = (row: RecordValue, kind: GitHubContext['kind'], body: string, anchor = '') => {
    const candidate = githubItem(config, base, row, number, kind, body, pull, anchor, true)
    if (candidate) items.push(candidate)
  }
  append(issue, pull ? 'pull' : 'issue', `${text(issue.title)}\n\n${text(issue.body)}`)
  for (const row of await githubPages(base, `${path}/issues/${number}/comments`, config.token, signal, transport)) append(row, 'comment', text(row.body), `#issuecomment-${row.id}`)
  if (pull) {
    for (const row of await githubPages(base, `${path}/pulls/${number}/reviews`, config.token, signal, transport)) append(row, 'review', text(row.body), `#pullrequestreview-${row.id}`)
    for (const row of await githubPages(base, `${path}/pulls/${number}/comments`, config.token, signal, transport)) append(row, 'review-comment', text(row.body), `#discussion_r${row.id}`)
  }
  return items
}

export interface GitHubCheck {
  kind: 'status' | 'check'
  id: string
  name: string
  state: string
  conclusion?: string
  at?: string
}
export interface GitHubChecks { number: number; head: string; checks: GitHubCheck[] }
/** Reads CI against the current exact PR head, with bounded independent status/check pagination. */
export async function readGitHubChecks(config: GitHubSourceConfig, number: number, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<GitHubChecks> {
  const pull = await readPullRequest(config, number, signal, transport)
  return { number, ...(await readCommitChecks(config, pull.head, signal, transport)) }
}
async function readCommitChecks(config: GitHubSourceConfig, head: string, signal: AbortSignal | undefined, transport: typeof fetch): Promise<Omit<GitHubChecks, 'number'>> {
  const base = validateGitHub(config)
  const path = `/repos/${config.repository}/commits/${head}`
  const statuses = await githubPages(base, `${path}/statuses`, config.token, signal, transport), checks: GitHubCheck[] = []
  for (const status of statuses) {
    if (!positive(status.id) || !['pending', 'success', 'error', 'failure'].includes(text(status.state))) fail('Invalid source response')
    // Status history is newest-first; retain the newest status for each context.
    const name = boundedText(text(status.context))
    if (!checks.some(check => check.kind === 'status' && check.name === name)) checks.push({ kind: 'status', id: String(status.id), name, state: text(status.state), ...(text(status.updated_at ?? status.created_at) ? { at: text(status.updated_at ?? status.created_at) } : {}) })
  }
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(base)
    url.pathname = `${base.pathname.replace(/\/$/, '')}${path}/check-runs`
    url.search = new URLSearchParams({ per_page: '100', page: String(page) }).toString()
    const { value, headers } = await request(url, config.token, signal, transport), envelope = object(value)
    if (!envelope || !Array.isArray(envelope.check_runs) || envelope.check_runs.length > 100) fail('Invalid source response')
    for (const row of envelope.check_runs) {
      const check = object(row)
      if (!check || !positive(check.id) || !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(text(check.status))) fail('Invalid source response')
      checks.push({ kind: 'check', id: String(check.id), name: boundedText(text(check.name)), state: text(check.status),
        ...(text(check.conclusion) ? { conclusion: text(check.conclusion) } : {}), ...(text(check.completed_at ?? check.started_at) ? { at: text(check.completed_at ?? check.started_at) } : {}) })
    }
    if (envelope.check_runs.length < 100 && !/rel\s*=\s*"?next\b/i.test(headers.get('link') ?? '')) return { head, checks }
  }
  return fail('Source pagination limit exceeded')
}

export async function readDefaultBranchChecks(config: GitHubSourceConfig, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<{ branch: string; head: string; checks: GitHubCheck[] }> {
  const base = validateGitHub(config), repository = new URL(base)
  repository.pathname = `${base.pathname.replace(/\/$/, '')}/repos/${config.repository}`
  const metadata = object((await sourceRequest(repository, config.token, signal, transport)).value), branch = text(metadata?.default_branch)
  if (!branch || branch.length > 256 || /[\x00-\x20\x7f]/.test(branch)) fail('Invalid source response')
  const branchUrl = new URL(base)
  branchUrl.pathname = `${repository.pathname}/branches/${encodeURIComponent(branch)}`
  const details = object((await sourceRequest(branchUrl, config.token, signal, transport)).value), head = text(object(details?.commit)?.sha)
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) fail('Invalid source response')
  return { branch, ...(await readCommitChecks(config, head, signal, transport)) }
}

/** Default-branch CI is an inferred source event and can only create work through enabled proactive rules. */
export async function pollDefaultBranchChecks(config: GitHubSourceConfig, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<Trigger> {
  const snapshot = await readDefaultBranchChecks(config, signal, transport), source = githubThreadRef(config, 1).source
  return { id: `github:${id(config.origin, config.repository, 'default-ci', JSON.stringify(snapshot))}`, source,
    threads: [{ source, id: `branch:${snapshot.branch}` }], actor: { source, id: 'github-actions[bot]' }, human: false,
    at: snapshot.checks.map(check => check.at ?? '').sort().at(-1) || '1970-01-01T00:00:00.000Z',
    text: `Default branch ${snapshot.branch} CI for ${snapshot.head}\n${snapshot.checks.map(check => `${check.name}: ${check.conclusion ?? check.state}`).join('\n')}`,
    meta: { provider: { provider: 'github', kind: 'branch-checks', origin: config.origin, repository: config.repository, branch: snapshot.branch, head: snapshot.head }, ci: true } }
}

/** CI events are context, never human requests. Equal exact-head snapshots retain the same event ID. */
export async function pollGitHubChecks(config: GitHubSourceConfig, numbers: number[] = config.subscribedNumbers ?? [], signal?: AbortSignal, transport: typeof fetch = fetch): Promise<InboxItem[]> {
  const base = validateGitHub(config)
  if (!Array.isArray(numbers) || numbers.length > 100 || !numbers.every(positive)) fail('Invalid source configuration')
  const result: InboxItem[] = []
  for (const number of [...new Set(numbers)]) {
    const snapshot = await readGitHubChecks(config, number, signal, transport), url = githubWeb(base, config.repository, number, true)
    const context: GitHubContext = { provider: 'github', sourceConfigId: `github:${id(base.href, config.repository.toLowerCase(), config.account.toLowerCase())}`,
      origin: base.href.replace(/\/$/, ''), repository: config.repository, account: config.account, number, nativeThreadId: String(number), originalUrl: url,
      kind: 'checks', isPullRequest: true, human: false, bot: true, allowedActor: false, subscribed: config.subscribedNumbers?.includes(number) ?? false,
      commitId: snapshot.head, updatedAt: snapshot.checks.map(check => check.at ?? '').sort().at(-1) || '1970-01-01T00:00:00.000Z' }
    result.push({ id: `github:${id(base.href, config.repository, 'checks', JSON.stringify(snapshot))}`, source: 'github', actor: 'github-actions[bot]',
      thread: String(number), url, context, text: boundedText(`CI for ${snapshot.head}\n${snapshot.checks.map(check => `${check.name}: ${check.conclusion ?? check.state}`).join('\n') || 'No checks reported'}`) })
  }
  return result
}
