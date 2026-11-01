/** Provider writes are invoked only by the host after its local approval gate. Credentials are supplied afresh per call. */
import { createHash } from 'node:crypto'
import type { ChannelRef } from '../../src/core/model.ts'
import { SourceError, githubBase, readGitHubThread, sourceNamespace, sourceRequest, teamsPages, validateGitHub, validateTeams,
  type GitHubContext, type GitHubSourceConfig, type InboxItem, type SourceContext, type TeamsContext, type TeamsSourceConfig } from './sources.ts'

export interface GitHubDeliveryCredential extends GitHubSourceConfig {
  provider: 'github'
  /** Granted repository permissions as attested by native credential setup, not remote content. */
  scopes: readonly ('issues:write' | 'pull_requests:write')[]
}
export interface TeamsDeliveryCredential extends TeamsSourceConfig {
  provider: 'teams'
  mode: 'delegated'
  scopes: readonly string[]
}
export type SourceDeliveryCredential = GitHubDeliveryCredential | TeamsDeliveryCredential
export interface SourceReply {
  /** Durable outbox operation ID. Persist this before dispatch and reuse it for reconciliation. */
  id: string
  text: string
  kind: 'acknowledgement' | 'reply' | 'notice' | 'question' | 'result'
}
export interface DeliveryReceipt {
  operationId: string
  provider: 'github' | 'teams'
  messageId: string
  marker: string
  reconciled: boolean
  url?: string
}
export class DeliveryError extends SourceError {
  readonly outcome: 'not-sent' | 'unknown'
  constructor(message: string, outcome: 'not-sent' | 'unknown') { super(message); this.outcome = outcome }
}
export interface DeliveryOptions {
  /** An ambiguous POST must only be reconciled; an absent match never automatically repeats the POST. */
  retry?: 'reconcile'
  signal?: AbortSignal
  transport?: typeof fetch
}
type Row = Record<string, unknown>
const object = (value: unknown): Row | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined
const str = (value: unknown): string => typeof value === 'string' ? value : ''
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_:@.-]{1,256}$/.test(value) && value !== '.' && value !== '..'
const reject = (): never => { throw new DeliveryError('Source delivery scope rejected', 'not-sent') }

function contextOf(target: SourceContext | ChannelRef, credential: SourceDeliveryCredential): SourceContext {
  if ('provider' in target) return target
  const address = target.address
  if (!address || typeof address !== 'object') return reject()
  const common = { sourceConfigId: '', nativeThreadId: '', human: false, bot: false, allowedActor: false, subscribed: true }
  const context: SourceContext = credential.provider === 'github'
    ? { ...common, provider: 'github', origin: address.origin!, repository: address.repository!, account: credential.account,
      number: Number(address.number), nativeThreadId: address.number!, isPullRequest: !!address.reviewRootCommentId,
      kind: address.reviewRootCommentId ? 'review-comment' : 'comment',
      ...(address.reviewRootCommentId ? { reviewRootCommentId: Number(address.reviewRootCommentId) } : {}),
      ...(address.reviewThreadId ? { reviewThreadId: address.reviewThreadId } : {}) }
    : { ...common, provider: 'teams', tenantId: address.tenantId!, rootMessageId: address.rootMessageId!, messageId: address.messageId!, nativeThreadId: address.rootMessageId!,
      ...(address.chatId ? { chatId: address.chatId } : { teamId: address.teamId, channelId: address.channelId }) }
  if (target.source !== sourceNamespace(context) || target.thread !== `${target.source}:${context.nativeThreadId}`) return reject()
  return context
}
function authorize(target: SourceContext | ChannelRef, credential: SourceDeliveryCredential, writing: boolean): SourceContext {
  const context = contextOf(target, credential)
  if (context.provider !== credential.provider) return reject()
  if (credential.provider === 'github' && context.provider === 'github') {
    const base = validateGitHub(credential)
    if (githubBase(context.origin).href !== base.href || context.repository.toLowerCase() !== credential.repository.toLowerCase()
      || !positive(context.number) || context.nativeThreadId !== String(context.number)
      || context.reviewRootCommentId !== undefined && !positive(context.reviewRootCommentId)) return reject()
    if (writing && !credential.scopes?.includes(context.reviewRootCommentId ? 'pull_requests:write' : 'issues:write')
      && !(context.isPullRequest && credential.scopes?.includes('pull_requests:write'))) return reject()
  } else if (credential.provider === 'teams' && context.provider === 'teams') {
    validateTeams(credential)
    if (credential.mode !== 'delegated' || context.tenantId.toLowerCase() !== credential.tenantId.toLowerCase()
      || !validId(context.rootMessageId) || !validId(context.messageId) || context.nativeThreadId !== context.rootMessageId) return reject()
    if (context.chatId) {
      if (context.teamId || context.channelId || !credential.chatIds.includes(context.chatId)
        || writing && !credential.scopes?.includes('ChatMessage.Send')) return reject()
    } else if (!context.teamId || !context.channelId || !credential.channels.some(channel => channel.teamId.toLowerCase() === context.teamId!.toLowerCase() && channel.channelId === context.channelId)
      || writing && !credential.scopes?.includes('ChannelMessage.Send')) return reject()
  } else return reject()
  return context
}
function githubPath(context: GitHubContext, suffix: string): URL {
  const base = githubBase(context.origin)
  base.pathname = `${base.pathname.replace(/\/$/, '')}/repos/${context.repository}${suffix}`
  return base
}
function graphMessages(context: TeamsContext): string {
  return context.chatId ? `/v1.0/chats/${encodeURIComponent(context.chatId)}/messages`
    : `/v1.0/teams/${encodeURIComponent(context.teamId!)}/channels/${encodeURIComponent(context.channelId!)}/messages/${encodeURIComponent(context.rootMessageId)}/replies`
}
function operationMarker(context: SourceContext, message: SourceReply): string {
  if (typeof message.id !== 'string' || !message.id || message.id.length > 256 || /[\x00-\x1f\x7f]/.test(message.id)
    || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 30_000
    || !['acknowledgement', 'reply', 'notice', 'question', 'result'].includes(message.kind)) throw new DeliveryError('Invalid source delivery', 'not-sent')
  return `superagent:${createHash('sha256').update(JSON.stringify([sourceNamespace(context), context.nativeThreadId, context.provider === 'github' ? context.reviewRootCommentId ?? '' : '', message.id])).digest('hex')}`
}
function receipt(value: unknown, context: SourceContext, message: SourceReply, marker: string, reconciled: boolean): DeliveryReceipt {
  const row = object(value), native = context.provider === 'github' ? positive(row?.id) ? String(row.id) : '' : validId(row?.id) ? row.id : ''
  if (!native) throw new DeliveryError('Invalid source delivery response; reconcile before retrying', 'unknown')
  // Derive URLs from the approved origin, never from response-supplied destinations.
  const url = context.provider === 'github'
    ? `${githubBase(context.origin).hostname === 'api.github.com' ? 'https://github.com' : githubBase(context.origin).origin}/${context.repository}/${context.isPullRequest ? 'pull' : 'issues'}/${context.number}#${context.reviewRootCommentId ? 'discussion_r' : 'issuecomment-'}${native}` : undefined
  return { operationId: message.id, provider: context.provider, messageId: native, marker, reconciled, ...(url ? { url } : {}) }
}

/** Read-only receipt lookup. A missing receipt after an ambiguous send is not proof that no message was created. */
export async function reconcileSourceReply(target: SourceContext | ChannelRef, message: SourceReply, credential: SourceDeliveryCredential,
  options: Omit<DeliveryOptions, 'retry'> = {}): Promise<DeliveryReceipt | undefined> {
  const context = authorize(target, credential, false), marker = operationMarker(context, message), transport = options.transport ?? fetch
  if (context.provider === 'github') {
    const suffix = context.reviewRootCommentId ? `/pulls/${context.number}/comments` : `/issues/${context.number}/comments`
    for (let page = 1; page <= 5; page++) {
      const url = githubPath(context, suffix)
      url.search = new URLSearchParams({ per_page: '100', page: String(page) }).toString()
      const { value, headers } = await sourceRequest(url, credential.token, options.signal, transport)
      if (!Array.isArray(value) || value.length > 100 || !value.every(object)) throw new SourceError('Invalid source response')
      for (const candidate of value) {
        const row = object(candidate)!
        if (str(object(row.user)?.login).toLowerCase() === (credential as GitHubDeliveryCredential).account.toLowerCase()
          && str(row.body).includes(`<!-- ${marker} -->`)
          && (!context.reviewRootCommentId || row.in_reply_to_id === context.reviewRootCommentId)) return receipt(row, context, message, marker, true)
      }
      if (value.length < 100 && !/rel\s*=\s*"?next\b/i.test(headers.get('link') ?? '')) return
    }
    throw new SourceError('Source pagination limit exceeded')
  }
  const authenticated = (credential as TeamsDeliveryCredential).accountId
  if (!authenticated) throw new SourceError('Source delivery receipt requires authenticated account identity')
  const rows = await teamsPages(graphMessages(context), credential.token, options.signal, transport) as Row[]
  for (const row of rows) {
    const from = object(row.from), user = object(from?.user)
    if (!from?.application && str(user?.id).toLowerCase() === authenticated.toLowerCase()
      && (user?.tenantId === undefined || str(user.tenantId).toLowerCase() === context.tenantId.toLowerCase())
      && str(object(row.body)?.content).includes(`[${marker}]`)) return receipt(row, context, message, marker, true)
  }
}

/** Sends acknowledgements, questions and results to their original provider thread. Never follows a provider URL. */
export async function deliverSourceReply(target: SourceContext | ChannelRef, message: SourceReply, credential: SourceDeliveryCredential,
  options: DeliveryOptions = {}): Promise<DeliveryReceipt> {
  const context = authorize(target, credential, true), marker = operationMarker(context, message)
  if (options.signal?.aborted) throw new DeliveryError('Source request cancelled', 'not-sent')
  if (options.retry === 'reconcile') {
    const existing = await reconcileSourceReply(target, message, credential, options)
    if (existing) return existing
    throw new DeliveryError('Source delivery not yet reconciled; do not resend automatically', 'unknown')
  }
  const transport = options.transport ?? fetch
  let url: URL, body: unknown
  if (context.provider === 'github') {
    url = githubPath(context, context.reviewRootCommentId ? `/pulls/${context.number}/comments/${context.reviewRootCommentId}/replies` : `/issues/${context.number}/comments`)
    body = { body: `${message.text}\n\n<!-- ${marker} -->` }
  } else {
    const content = `${message.text}\n\n[${marker}]`
    // Graph chat replyToId is read-only. replyWithQuote is the delegated API for replying to an existing chat message.
    const path = graphMessages(context)
    url = new URL(`https://graph.microsoft.com${path}${context.chatId ? '/replyWithQuote' : ''}`)
    body = context.chatId ? { messageIds: [context.rootMessageId], replyMessage: { body: { contentType: 'text', content } } }
      : { body: { contentType: 'text', content } }
  }
  try {
    const { value } = await sourceRequest(url, credential.token, options.signal, transport, { body })
    return receipt(value, context, message, marker, false)
  } catch (error) {
    if (error instanceof DeliveryError) throw error
    // A server error or timeout can follow a committed write; only definitive client rejection permits a new POST.
    const rejected = error instanceof SourceError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408
    throw new DeliveryError(rejected ? 'Source delivery rejected' : 'Source delivery outcome unknown; reconcile before retrying', rejected ? 'not-sent' : 'unknown')
  }
}

/** Reads bounded original conversation context using the same exact provider/tenant/repository allowlist as delivery. */
export async function readSourceContext(target: SourceContext | ChannelRef, credential: SourceDeliveryCredential,
  options: Omit<DeliveryOptions, 'retry'> = {}): Promise<{ provider: 'github'; items: InboxItem[] } | { provider: 'teams'; root: Row; messages: Row[] }> {
  const context = authorize(target, credential, false), transport = options.transport ?? fetch
  if (context.provider === 'github' && credential.provider === 'github') return { provider: 'github', items: await readGitHubThread(credential, context.number, options.signal, transport) }
  if (context.provider !== 'teams') return reject()
  const rootPath = context.chatId ? `${graphMessages(context)}/${encodeURIComponent(context.rootMessageId)}`
    : graphMessages(context).replace(/\/replies$/, '')
  const { value } = await sourceRequest(new URL(`https://graph.microsoft.com${rootPath}`), credential.token, options.signal, transport)
  const root = object(value)
  if (!root || root.id !== context.rootMessageId) throw new SourceError('Invalid source response')
  const messages = await teamsPages(graphMessages(context), credential.token, options.signal, transport) as Row[]
  return { provider: 'teams', root, messages }
}

/** Resolves only a review thread proven by a repository-local GraphQL lookup to belong to this exact PR. */
export async function resolveGitHubReviewThread(target: SourceContext | ChannelRef, credential: GitHubDeliveryCredential,
  options: Omit<DeliveryOptions, 'retry'> = {}): Promise<{ threadId: string; resolved: true }> {
  const context = authorize(target, credential, true)
  if (context.provider !== 'github' || !context.reviewRootCommentId) return reject()
  const base = githubBase(context.origin), url = new URL(base)
  url.pathname = base.pathname.startsWith('/api/v3') ? '/api/graphql' : '/graphql'
  const [owner, name] = context.repository.split('/'), transport = options.transport ?? fetch
  let cursor: string | null = null, found: { id: string; resolved: boolean } | undefined
  for (let page = 0; page < 5; page++) {
    const { value } = await sourceRequest(url, credential.token, options.signal, transport, { body: {
      query: 'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{id isResolved comments(first:1){nodes{databaseId}}} pageInfo{hasNextPage endCursor}}}}}',
      variables: { owner, name, number: context.number, after: cursor },
    } })
    const envelope = object(value), threads = object(object(object(object(envelope?.data)?.repository)?.pullRequest)?.reviewThreads), nodes = threads?.nodes, info = object(threads?.pageInfo)
    if (envelope?.errors || !Array.isArray(nodes) || nodes.length > 100 || typeof info?.hasNextPage !== 'boolean') throw new SourceError('Invalid source response')
    for (const value of nodes) {
      const row = object(value), comments = object(row?.comments)?.nodes
      if (Array.isArray(comments) && object(comments[0])?.databaseId === context.reviewRootCommentId && typeof row?.id === 'string' && /^[A-Za-z0-9_=-]{1,256}$/.test(row.id) && typeof row.isResolved === 'boolean') found = { id: row.id, resolved: row.isResolved }
    }
    if (found || !info.hasNextPage) break
    const next = str(info.endCursor)
    if (!next || next.length > 1024 || next === cursor) throw new SourceError('Invalid source response')
    cursor = next
    if (page === 4) throw new SourceError('Source pagination limit exceeded')
  }
  if (!found || context.reviewThreadId && context.reviewThreadId !== found.id) return reject()
  if (!found.resolved) {
    try {
      const { value } = await sourceRequest(url, credential.token, options.signal, transport, { body: {
        query: 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}', variables: { id: found.id },
      } })
      const envelope = object(value), thread = object(object(object(envelope?.data)?.resolveReviewThread)?.thread)
      if (envelope?.errors || thread?.id !== found.id || thread.isResolved !== true) throw new SourceError('Invalid source response')
    } catch { throw new DeliveryError('Review resolution outcome unknown; read the thread before retrying', 'unknown') }
  }
  return { threadId: found.id, resolved: true }
}
