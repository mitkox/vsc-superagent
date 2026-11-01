import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DeliveryError, deliverSourceReply, readSourceContext, reconcileSourceReply, resolveGitHubReviewThread,
  type GitHubDeliveryCredential, type TeamsDeliveryCredential } from '../src/delivery.ts'
import { sourceTrigger, type GitHubContext, type TeamsContext } from '../src/sources.ts'

const tenantId = '11111111-1111-1111-1111-111111111111'
const accountId = '22222222-2222-2222-2222-222222222222'
const teamId = '33333333-3333-3333-3333-333333333333'
const channelId = '19:channel@thread.tacv2'
const chatId = '19:chat@thread.v2'
const common = { sourceConfigId: 'source-id', human: true, bot: false, allowedActor: true, subscribed: true }
const github: GitHubContext = { ...common, provider: 'github', origin: 'https://api.github.com', repository: 'company/project', account: 'agent',
  nativeThreadId: '7', number: 7, isPullRequest: true, kind: 'review-comment', commentId: 303, reviewRootCommentId: 300 }
const channel: TeamsContext = { ...common, provider: 'teams', tenantId, teamId, channelId, nativeThreadId: '100', rootMessageId: '100', messageId: '102' }
const chat: TeamsContext = { ...common, provider: 'teams', tenantId, chatId, nativeThreadId: '100', rootMessageId: '100', messageId: '102' }
const githubCredential: GitHubDeliveryCredential = { provider: 'github', origin: github.origin, repository: github.repository, account: 'agent', allowedActors: ['alice'], token: 'github-secret', scopes: ['issues:write', 'pull_requests:write'] }
const teamsCredential: TeamsDeliveryCredential = { provider: 'teams', tenantId, accountId, chatIds: [chatId], channels: [{ teamId, channelId }], allowedActors: [], token: 'teams-secret', mode: 'delegated', scopes: ['ChatMessage.Send', 'ChannelMessage.Send'] }
const message = { id: 'outbox-1', text: 'Please confirm the expected result.', kind: 'question' as const }
const json = (value: unknown, headers?: HeadersInit) => new Response(JSON.stringify(value), { headers })

test('a server error after committing a reply remains uncertain and reconciles without a second POST', async () => {
  let posts = 0, stored: Record<string, unknown> | undefined
  const transport: typeof fetch = async (_input, init) => {
    if (init?.method === 'POST') {
      posts++
      const sent = JSON.parse(String(init.body))
      stored = { id: 401, body: sent.body, user: { login: 'agent' }, in_reply_to_id: 300 }
      return new Response('{}', { status: 503 })
    }
    return json(stored ? [stored] : [])
  }
  await assert.rejects(deliverSourceReply(github, message, githubCredential, { transport }), error => error instanceof DeliveryError && error.outcome === 'unknown')
  const recovered = await deliverSourceReply(github, message, githubCredential, { transport, retry: 'reconcile' })
  assert.equal(recovered.messageId, '401')
  assert.equal(posts, 1)
})

test('GitHub inline replies target the native review root and use fixed repository-scoped credentials', async () => {
  const result = await deliverSourceReply(github, message, githubCredential, { transport: async (input, init) => {
    assert.equal(String(input), 'https://api.github.com/repos/company/project/pulls/7/comments/300/replies')
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer github-secret')
    const body = JSON.parse(String(init?.body))
    assert.match(body.body, /^Please confirm the expected result\./)
    assert.match(body.body, /<!-- superagent:[a-f0-9]{64} -->/)
    return json({ id: 400, html_url: 'https://evil.example/stolen' })
  } })
  assert.equal(result.messageId, '400'); assert.equal(result.reconciled, false)
  assert.equal(result.url, 'https://github.com/company/project/pull/7#discussion_r400')
  assert.doesNotMatch(JSON.stringify(result), /github-secret|evil/)
})

test('issue acknowledgements use the conversation endpoint and can consume a persisted ChannelRef', async () => {
  const context: GitHubContext = { ...github, kind: 'comment', reviewRootCommentId: undefined, isPullRequest: false }
  const target = sourceTrigger({ id: 'inbox-1', source: 'github', actor: 'alice', text: 'Request', thread: '7', context }).channel!
  const receipt = await deliverSourceReply(target, { ...message, kind: 'acknowledgement' }, githubCredential, { transport: async input => {
    assert.equal(String(input), 'https://api.github.com/repos/company/project/issues/7/comments')
    return json({ id: 55 })
  } })
  assert.equal(receipt.messageId, '55')
})

test('Teams channel results reply beneath the original root rather than beneath the latest message', async () => {
  const result = await deliverSourceReply(channel, { ...message, kind: 'result' }, teamsCredential, { transport: async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.origin, 'https://graph.microsoft.com')
    assert.equal(url.pathname, `/v1.0/teams/${teamId}/channels/19%3Achannel%40thread.tacv2/messages/100/replies`)
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer teams-secret')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.body.contentType, 'text'); assert.match(body.body.content, /\[superagent:[a-f0-9]{64}\]/)
    return json({ id: '200' })
  } })
  assert.equal(result.provider, 'teams'); assert.equal(result.messageId, '200')
})

test('Teams chat replies use delegated replyWithQuote and explicitly identify the original message', async () => {
  await deliverSourceReply(chat, message, teamsCredential, { transport: async (input, init) => {
    assert.equal(String(input), 'https://graph.microsoft.com/v1.0/chats/19%3Achat%40thread.v2/messages/replyWithQuote')
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body.messageIds, ['100']); assert.equal(body.replyMessage.body.contentType, 'text')
    assert.equal(body.replyToId, undefined)
    return json({ id: '201' })
  } })
})

test('writes deny mismatched origin, repository, tenant, channel, chat, auth mode and missing send scopes before dispatch', async () => {
  const transport: typeof fetch = async () => { assert.fail('scope rejection must occur before dispatch'); return json({}) }
  const inputs: [GitHubContext | TeamsContext, GitHubDeliveryCredential | TeamsDeliveryCredential][] = [
    [{ ...github, origin: 'https://other.example' }, githubCredential],
    [{ ...github, repository: 'company/other' }, githubCredential],
    [{ ...github, reviewRootCommentId: -1 }, githubCredential],
    [github, { ...githubCredential, scopes: ['issues:write'] }],
    [{ ...channel, tenantId: teamId }, teamsCredential],
    [{ ...channel, channelId: 'other' }, teamsCredential],
    [{ ...chat, chatId: 'other' }, teamsCredential],
    [chat, { ...teamsCredential, mode: 'application' as 'delegated' }],
    [chat, { ...teamsCredential, scopes: ['ChannelMessage.Send'] }],
    [channel, { ...teamsCredential, scopes: ['ChatMessage.Send'] }],
    [{ ...channel, rootMessageId: '../me' }, teamsCredential],
  ]
  for (const [target, credential] of inputs) await assert.rejects(deliverSourceReply(target, message, credential, { transport }), /scope rejected/)
})

test('persisted channel namespaces cannot be swapped to move an outbox reply to another scope', async () => {
  const target = sourceTrigger({ id: 'inbox', source: 'teams', actor: accountId, text: 'body', thread: 'root', context: chat }).channel!
  await assert.rejects(deliverSourceReply({ ...target, source: 'teams:other' }, message, teamsCredential), /scope rejected/)
  await assert.rejects(deliverSourceReply({ ...target, thread: `${target.source}:other` }, message, teamsCredential), /scope rejected/)
})

test('ambiguous GitHub POST errors are sanitized and a retry reconciles its receipt without repeating the write', async () => {
  let postedBody = '', posts = 0
  await assert.rejects(deliverSourceReply(github, message, githubCredential, { transport: async (_input, init) => {
    posts++; postedBody = JSON.parse(String(init?.body)).body
    throw new Error('github-secret and arbitrary remote body')
  } }), error => {
    assert.ok(error instanceof DeliveryError); assert.equal(error.outcome, 'unknown')
    assert.doesNotMatch(error.message, /github-secret|arbitrary/); return true
  })
  const result = await deliverSourceReply(github, message, githubCredential, { retry: 'reconcile', transport: async (input, init) => {
    assert.equal(init?.method, 'GET')
    assert.equal(new URL(String(input)).pathname, '/repos/company/project/pulls/7/comments')
    return json([{ id: 400, body: postedBody, in_reply_to_id: 300, user: { login: 'agent' } }])
  } })
  assert.equal(result.reconciled, true); assert.equal(result.messageId, '400'); assert.equal(posts, 1)
})

test('an absent receipt after an ambiguous write remains unknown and never triggers another POST', async () => {
  let reads = 0
  await assert.rejects(deliverSourceReply(chat, message, teamsCredential, { retry: 'reconcile', transport: async (_input, init) => {
    reads++; assert.equal(init?.method, 'GET'); return json({ value: [] })
  } }), error => error instanceof DeliveryError && error.outcome === 'unknown')
  assert.equal(reads, 1)
})

test('Teams reconciliation validates pagination origin and finds stable receipt markers', async () => {
  let posted = ''
  const result = await deliverSourceReply(channel, message, teamsCredential, { transport: async (_input, init) => {
    posted = JSON.parse(String(init?.body)).body.content; return json({ id: '200' })
  } })
  const recovered = await reconcileSourceReply(channel, message, teamsCredential, { transport: async () => json({ value: [{ id: '200', body: { content: posted }, from: { user: { id: accountId, tenantId } } }] }) })
  assert.equal(recovered?.marker, result.marker); assert.equal(recovered?.reconciled, true)
  let requests = 0
  await assert.rejects(reconcileSourceReply(channel, message, teamsCredential, { transport: async () => {
    requests++; return json({ value: [], '@odata.nextLink': 'https://evil.example/steal?$skiptoken=next' })
  } }), /pagination address/)
  assert.equal(requests, 1)
})

test('bounded Teams thread reads fetch the original root and its reply collection', async () => {
  const paths: string[] = []
  const result = await readSourceContext(channel, teamsCredential, { transport: async input => {
    const path = new URL(String(input)).pathname; paths.push(path)
    return path.endsWith('/replies') ? json({ value: [{ id: '102', replyToId: '100' }] }) : json({ id: '100', body: { content: 'original' } })
  } })
  assert.equal(result.provider, 'teams')
  if (result.provider !== 'teams') assert.fail('Teams result required')
  assert.equal(result.root.id, '100'); assert.equal(result.messages[0]!.id, '102')
  assert.ok(paths[0]!.endsWith('/messages/100')); assert.ok(paths[1]!.endsWith('/messages/100/replies'))
})

test('GitHub review resolution verifies the exact repository and PR before using the native GraphQL ID', async () => {
  const calls: unknown[] = []
  const result = await resolveGitHubReviewThread(github, githubCredential, { transport: async (input, init) => {
    assert.equal(String(input), 'https://api.github.com/graphql')
    const body = JSON.parse(String(init?.body)); calls.push(body)
    if (body.query.startsWith('query')) {
      assert.deepEqual(body.variables, { owner: 'company', name: 'project', number: 7, after: null })
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: 'PRRT_safe', isResolved: false, comments: { nodes: [{ databaseId: 300 }] } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } })
    }
    assert.deepEqual(body.variables, { id: 'PRRT_safe' })
    return json({ data: { resolveReviewThread: { thread: { id: 'PRRT_safe', isResolved: true } } } })
  } })
  assert.deepEqual(result, { threadId: 'PRRT_safe', resolved: true }); assert.equal(calls.length, 2)
})

test('review resolution rejects a provider-supplied thread ID that is not proven on the configured PR', async () => {
  let requests = 0
  await assert.rejects(resolveGitHubReviewThread({ ...github, reviewThreadId: 'PRRT_attacker' }, githubCredential, { transport: async () => {
    requests++; return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: 'PRRT_safe', isResolved: true, comments: { nodes: [{ databaseId: 300 }] } }], pageInfo: { hasNextPage: false } } } } } })
  } }), /scope rejected/)
  assert.equal(requests, 1)
})

test('delivery cancellation and limits prevent dispatch and provider errors do not disclose response bodies', async () => {
  const controller = new AbortController(); controller.abort()
  const noDispatch: typeof fetch = async () => { assert.fail('must not dispatch'); return json({}) }
  await assert.rejects(deliverSourceReply(github, message, githubCredential, { signal: controller.signal, transport: noDispatch }), error => error instanceof DeliveryError && error.outcome === 'not-sent')
  await assert.rejects(deliverSourceReply(github, { ...message, text: 'x'.repeat(30_001) }, githubCredential, { transport: noDispatch }), /Invalid source delivery/)
  await assert.rejects(deliverSourceReply(github, message, githubCredential, { transport: async () => new Response('github-secret', { status: 403 }) }), error => {
    assert.ok(error instanceof DeliveryError); assert.equal(error.outcome, 'not-sent'); assert.doesNotMatch(error.message, /github-secret/); return true
  })
})

test('cancellation interrupts a pending provider body read rather than waiting indefinitely', async () => {
  const controller = new AbortController()
  await assert.rejects(readSourceContext(channel, teamsCredential, { signal: controller.signal, transport: async () => {
    const stream = new ReadableStream<Uint8Array>({ start() { setTimeout(() => controller.abort(), 10) } })
    return new Response(stream)
  } }), /Source request cancelled/)
})

test('receipt reconciliation ignores copied markers from other senders', async () => {
  let markerBody = ''
  await deliverSourceReply(github, message, githubCredential, { transport: async (_input, init) => {
    markerBody = JSON.parse(String(init?.body)).body; return json({ id: 400 })
  } })
  assert.equal(await reconcileSourceReply(github, message, githubCredential, { transport: async () => json([
    { id: 401, body: markerBody, in_reply_to_id: 300, user: { login: 'outsider' } },
  ]) }), undefined)
  await assert.rejects(reconcileSourceReply(chat, message, { ...teamsCredential, accountId: undefined }), /authenticated account identity/)
})
