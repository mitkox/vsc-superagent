import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { OutboundMessage } from '../../src/core/index.ts'
import { DeliveryError, type GitHubDeliveryCredential } from '../src/delivery.ts'
import { sendDurableReply } from '../src/outbound.ts'
import { TicketRuntime } from '../src/runtime.ts'
import { sourceTrigger, type GitHubContext } from '../src/sources.ts'

test('reopening durable state after a committed reply and lost response reconciles without another POST', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-outbound-restart-'))
  let runtime = new TicketRuntime(directory), posts = 0, reads = 0, posted: Record<string, unknown> | undefined
  const context: GitHubContext = { provider: 'github', sourceConfigId: 'approved', nativeThreadId: '7', number: 7,
    origin: 'https://api.github.com', repository: 'owner/repo', account: 'agent', isPullRequest: false, kind: 'comment', human: true, bot: false, allowedActor: true, subscribed: true }
  const channel = sourceTrigger({ id: 'approved-request', source: 'github', actor: 'owner', text: 'Request', thread: '7', context }).channel!
  const message: OutboundMessage = { id: 'durable-reply-1', channel, text: 'The fix is ready for review.', kind: 'reply' }
  const credential: GitHubDeliveryCredential = { provider: 'github', origin: context.origin, repository: context.repository, account: 'agent', allowedActors: [], token: 'fixture-only', scopes: ['issues:write'] }
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method === 'POST') {
      posts++; posted = { id: 123, user: { login: 'agent' }, body: JSON.parse(String(init.body)).body }
      return new Response('{}', { status: 503 })
    }
    reads++; return Response.json(posted ? [posted] : [])
  }
  try {
    await assert.rejects(sendDurableReply(runtime, message, credential, { transport }), error => error instanceof DeliveryError && error.outcome === 'unknown')
    assert.equal(runtime.readData<{ attempted: boolean }>('delivery:durable-reply-1')?.attempted, true)
    runtime.dispose(); runtime = new TicketRuntime(directory)
    await sendDurableReply(runtime, message, credential, { transport })
    assert.equal(posts, 1); assert.equal(reads, 1)
    assert.ok(runtime.readData<{ receipt: unknown }>('delivery:durable-reply-1')?.receipt)
    await sendDurableReply(runtime, message, credential, { transport })
    assert.equal(reads, 1)
  } finally { runtime.dispose(); rmSync(directory, { recursive: true, force: true }) }
})
