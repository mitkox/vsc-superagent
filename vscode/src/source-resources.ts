import type { ChannelRef } from '../../src/core/index.ts'
import { readSourceContext, type SourceDeliveryCredential } from './delivery.ts'
import { readDefaultBranchChecks, readGitHubChecks, readGitHubThread, type GitHubContext, type InboxItem } from './sources.ts'

interface ResourcePage { resource: string; text: string; next_offset: number | null; next_resource?: string }
interface Snapshot { body: string; next?: string }

/** Read-only source resources retain a snapshot while a model pages through its text. */
export class SourceResources {
  private readonly cache = new Map<string, Snapshot>()
  async read(ticketId: string, target: ChannelRef | undefined, credential: SourceDeliveryCredential,
    request: Record<string, unknown>, signal: AbortSignal, transport: typeof fetch = fetch): Promise<ResourcePage> {
    const resource = typeof request.resource === 'string' ? request.resource : 'source'
    const offset = request.offset ?? 0, limit = request.limit ?? 4000
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 8000) throw new Error('Invalid source resource pagination')
    const identity = credential.provider === 'github' ? [credential.provider, credential.origin, credential.repository] : [credential.provider, credential.tenantId, credential.chatIds, credential.channels]
    const key = JSON.stringify([ticketId, identity, target, resource])
    if (offset === 0) {
      const result = await this.load(resource, target, credential, signal, transport)
      signal.throwIfAborted()
      const snapshot = { body: JSON.stringify(result.value), ...(result.next ? { next: result.next } : {}) }
      if (Buffer.byteLength(snapshot.body) > 4 * 1024 * 1024) throw new Error('Source resource exceeds the snapshot limit')
      this.cache.delete(key); this.cache.set(key, snapshot)
      while (this.cache.size > 20 || [...this.cache.values()].reduce((bytes, row) => bytes + Buffer.byteLength(row.body), 0) > 8 * 1024 * 1024) this.cache.delete(this.cache.keys().next().value!)
    }
    const snapshot = this.cache.get(key)
    if (!snapshot) throw new Error('Source snapshot expired; read this resource from offset zero')
    return { resource, text: snapshot.body.slice(offset as number, (offset as number) + (limit as number)),
      next_offset: (offset as number) + (limit as number) < snapshot.body.length ? (offset as number) + (limit as number) : null,
      ...(snapshot.next ? { next_resource: snapshot.next } : {}) }
  }

  private async load(resource: string, target: ChannelRef | undefined, credential: SourceDeliveryCredential, signal: AbortSignal, transport: typeof fetch): Promise<{ value: unknown; next?: string }> {
    if (resource === 'github/default/checks' && credential.provider === 'github') return { value: await readDefaultBranchChecks(credential, signal, transport) }
    if (resource === 'source' || resource === 'teams' || resource === 'teams/source') {
      if (!target) throw new Error('This ticket has no source conversation')
      return { value: await readSourceContext(target, credential, { signal, transport }) }
    }
    const match = /^github\/(issues|pulls)\/([1-9]\d*)(?:\/(comments|reviews|checks|thread)(?:\/([1-9]\d*))?)?$/.exec(resource)
    if (!match || credential.provider !== 'github') throw new Error('Unknown or unavailable source resource')
    const [, kind, rawNumber, collection, suffix] = match, number = Number(rawNumber)
    if (!Number.isSafeInteger(number)) throw new Error('Invalid GitHub resource number')
    if (collection === 'checks') return { value: await readGitHubChecks(credential, number, signal, transport) }
    const thread = await readGitHubThread(credential, number, signal, transport)
    if (kind === 'pulls' && !thread.some(item => item.context?.provider === 'github' && item.context.isPullRequest)) throw new Error('Requested resource is not a pull request')
    const context = (item: InboxItem) => item.context as GitHubContext
    if (!collection) return { value: thread.find(item => ['issue', 'pull'].includes(context(item).kind)) ?? null }
    if (collection === 'thread') {
      const comment = thread.find(item => context(item).commentId === Number(suffix)), root = comment && context(comment).reviewRootCommentId
      if (!root) throw new Error('Review comment does not belong to this PR')
      return { value: thread.filter(item => context(item).reviewRootCommentId === root).map(sourceItem) }
    }
    const page = Number(suffix ?? '1')
    if (!Number.isSafeInteger(page) || page > 1_000_000) throw new Error('Invalid source page')
    const category = collection === 'reviews' ? 'review' : kind === 'pulls' ? 'review-comment' : 'comment'
    const rows = thread.filter(item => context(item).kind === category).map(sourceItem)
    return { value: rows.slice((page - 1) * 20, page * 20),
      ...(rows.length > page * 20 ? { next: `github/${kind}/${number}/${collection}/${page + 1}` } : {}) }
  }
}

function sourceItem(item: InboxItem) {
  const context = item.context as GitHubContext
  return { id: context.commentId ?? context.reviewId ?? context.number, from: item.actor, at: context.updatedAt ?? context.createdAt,
    text: item.text, ...(context.reviewRootCommentId ? { reply_to: context.reviewRootCommentId } : {}),
    ...(context.path ? { path: context.path } : {}), ...(context.line ? { line: context.line } : {}),
    ...(item.url ? { url: item.url } : {}), ...(context.bot ? { bot: true } : {}), provider: context }
}
