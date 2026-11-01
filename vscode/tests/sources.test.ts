import assert from 'node:assert/strict'
import { pollDefaultBranchChecks } from '../src/sources.ts'
import { test } from 'node:test'
import { pollTeams, pollTeamsBatch, pollGitHub, pollGitHubReviewsBatch, readPullRequest, sourceTrigger, sourceSubscription,
  githubThreadRef, discoverOwnPullRequests, pollGitHubChecks, readGitHubThread, type GitHubSourceConfig } from '../src/sources.ts'

const config: GitHubSourceConfig = {
  origin: 'https://api.github.com', repository: 'company/project', account: 'agent', allowedActors: ['Alice'], token: 'secret-token',
}
const issue = (body = '@agent fix this', overrides = {}) => ({
  id: 1, number: 7, title: 'Bug', body, user: { login: 'alice', type: 'User' },
  updated_at: '2026-11-01T10:00:00Z', ...overrides,
})
const json = (value: unknown, headers?: HeadersInit) => new Response(JSON.stringify(value), { headers })

test('default-branch CI is read at its actual head and emitted as inferred context', async () => {
  const head = 'a'.repeat(40), requests: string[] = []
  const event = await pollDefaultBranchChecks(config, undefined, async input => {
    const path = new URL(String(input)).pathname; requests.push(path)
    if (path === '/repos/company/project') return json({ default_branch: 'main' })
    if (path.endsWith('/branches/main')) return json({ commit: { sha: head } })
    if (path.endsWith('/statuses')) return json([{ id: 5, state: 'failure', context: 'build' }])
    return json({ check_runs: [] })
  })
  assert.equal(event.human, false)
  assert.equal(event.threads[0]?.id, 'branch:main')
  assert.match(event.text, /build: failure/)
  assert.ok(requests.includes(`/repos/company/project/commits/${head}/check-runs`))
})

test('a changed approval state on a subscribed review generates a fresh context event', async () => {
  const read = (state: string) => pollGitHubReviewsBatch({ ...config, subscribedNumbers: [7] }, undefined, undefined, async input =>
    new URL(String(input)).pathname.endsWith('/reviews')
      ? json([{ id: 22, user: { login: 'alice', type: 'User' }, body: '', state, submitted_at: '2026-11-01T00:00:00Z' }])
      : json([{ number: 7 }]))
  const approved = await read('APPROVED'), dismissed = await read('DISMISSED')
  assert.equal(approved.items.length, 1)
  assert.notEqual(approved.items[0]!.id, dismissed.items[0]!.id)
})

test('GitHub scopes credentials and every request to its configured repository and origin', async () => {
  const requests: URL[] = []
  const items = await pollGitHub(config, undefined, async (input, init) => {
    const url = new URL(String(input)); requests.push(url)
    assert.equal(url.origin, config.origin)
    assert.ok(url.pathname.startsWith('/repos/company/project/'))
    assert.equal(init?.method, 'GET')
    assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret-token')
    return json(url.pathname.endsWith('/issues') ? [issue()] : [])
  })
  assert.equal(requests.length, 3)
  assert.equal(items.length, 1)
  assert.equal(items[0]?.thread, '7')
  assert.equal(items[0]?.actor, 'alice')
  assert.equal(items[0]?.url, 'https://github.com/company/project/issues/7')
})

test('GitHub requires exact mention and allowed human actor, excluding the agent itself', async () => {
  const bodies = ['@agent-extra do work', 'email@agent do work', '@agent_other do work', '@AGENT do work']
  const data = bodies.map((body, i) => issue(body, { id: i + 1, number: i + 1 }))
  data.push(issue('@agent do work', { id: 8, user: { login: 'other', type: 'User' } }))
  data.push(issue('@agent do work', { id: 9, user: { login: 'alice', type: 'Bot' } }))
  data.push(issue('@agent do work', { id: 10, user: { login: 'alice[bot]', type: 'User' } }))
  data.push(issue('@agent do work', { id: 11, user: null }))
  data.push(issue('@agent do work', { id: 12, user: { login: 'agent', type: 'User' } }))
  const result = await pollGitHub({ ...config, allowedActors: ['Alice', 'agent'] }, undefined,
    async input => json(new URL(String(input)).pathname.endsWith('/issues') ? data : []))
  assert.equal(result.length, 1)
  assert.equal(result[0]?.thread, '4')
})

test('GitHub source IDs include content version and origin, so edits are visible and repeats deduplicate', async () => {
  const read = (body: string, origin = config.origin) => pollGitHub({ ...config, origin }, undefined,
    async input => json(new URL(String(input)).pathname.endsWith('/issues') ? [issue(body)] : []))
  const first = await read('@agent fix A'), same = await read('@agent fix A'), edited = await read('@agent fix B')
  const enterprise = await read('@agent fix A', 'https://github.corp.example/api/v3')
  assert.equal(first[0]?.id, same[0]?.id)
  assert.notEqual(first[0]?.id, edited[0]?.id)
  assert.notEqual(first[0]?.id, enterprise[0]?.id)
})

test('GitHub ignores response-supplied cross-repository and hostile comment addresses', async () => {
  const comments = [
    { ...issue(), issue_url: 'https://evil.example/repos/company/project/issues/7' },
    { ...issue(), issue_url: 'https://api.github.com/repos/company/other/issues/7' },
    { ...issue(), issue_url: 'https://api.github.com/repos/company/project/issues/7', html_url: 'javascript:bad' },
  ]
  const items = await pollGitHub(config, undefined, async input => {
    const path = new URL(String(input)).pathname
    return json(path.endsWith('/issues/comments') ? comments : [])
  })
  assert.equal(items.length, 1)
  assert.equal(items[0]?.url, 'https://github.com/company/project/issues/7#issuecomment-1')
})

test('GitHub enterprise origin allows the API prefix and rejects unsafe origins and repository path traversal', async () => {
  let calls = 0
  const fetcher: typeof fetch = async input => { calls++; assert.match(String(input), /^https:\/\/github\.corp\.example\/api\/v3\/repos\/company\/project\//); return json([]) }
  await pollGitHub({ ...config, origin: 'https://github.corp.example/api/v3/' }, undefined, fetcher)
  assert.equal(calls, 3)
  for (const origin of ['http://api.github.com', 'https://user:pass@api.github.com', 'https://api.github.com?x=1', 'https://api.github.com/#x', 'https://api.github.com/other']) {
    await assert.rejects(pollGitHub({ ...config, origin }, undefined, fetcher), /Invalid source configuration/)
  }
  for (const repository of ['company/../evil', '../evil', 'company/project?token=x', 'company/project/extra', 'company/.git']) {
    await assert.rejects(pollGitHub({ ...config, repository }, undefined, fetcher), /Invalid source configuration/)
  }
  assert.equal(calls, 3)
})

test('empty actor allowlist does not make network calls', async () => {
  const fetcher: typeof fetch = async () => { assert.fail('network request'); return json([]) }
  assert.deepEqual(await pollGitHub({ ...config, allowedActors: [] }, undefined, fetcher), [])
})

test('pagination never follows response-supplied next URLs with credentials', async () => {
  const requests: URL[] = []
  const items = await pollGitHub(config, undefined, async input => {
    const url = new URL(String(input)); requests.push(url)
    if (url.pathname.endsWith('/issues') && url.searchParams.get('page') === '1') {
      return json([issue()], { link: '<https://evil.example/steal>; rel="next"' })
    }
    return json([])
  })
  assert.equal(items.length, 1)
  assert.ok(requests.every(url => url.origin === config.origin))
  assert.equal(requests[1]?.searchParams.get('page'), '2')
})

test('excessive pages fail visibly instead of silently dropping messages', async () => {
  await assert.rejects(pollGitHub(config, undefined,
    async () => json([issue()], { link: '<https://api.github.com/next>; rel="next"' })), /Source pagination limit exceeded/)
})

test('GitHub since cursor is validated, sent to the API and applied to returned content', async () => {
  const since = '2026-11-01T00:00:00.000Z'
  const result = await pollGitHub({ ...config, since }, undefined, async input => {
    const url = new URL(String(input)); assert.equal(url.searchParams.get('since'), since)
    return json(url.pathname.endsWith('/issues') ? [issue(), issue('@agent old work', { id: 2, updated_at: '2026-10-30T00:00:00Z' })] : [])
  })
  assert.equal(result.length, 1)
  await assert.rejects(pollGitHub({ ...config, since: 'yesterday' }), /Invalid source configuration/)
})

test('redirects, HTTP errors, transport errors and invalid JSON never expose tokens or bodies', async () => {
  const responses = [new Response('secret-token', { status: 302 }), new Response('secret-token', { status: 401 }), new Response('secret-token')]
  for (const response of responses) {
    await assert.rejects(pollGitHub(config, undefined, async () => response), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /secret-token/); return true
    })
  }
  await assert.rejects(pollGitHub(config, undefined, async () => { throw new Error('secret-token') }), /Source request failed/)
})

test('response limits apply to advertised and actual streamed bytes', async () => {
  await assert.rejects(pollGitHub(config, undefined,
    async () => new Response('[]', { headers: { 'content-length': '1048577' } })), /Source response exceeds size limit/)
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1048577)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(pollGitHub(config, undefined, async () => new Response(stream)), /Source response exceeds size limit/)
  assert.equal(cancelled, true)
})

test('cancellation prevents request dispatch', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(pollGitHub(config, controller.signal, async () => { assert.fail('request should not dispatch'); return json([]) }), /Source request cancelled/)
})

const tenant = '11111111-1111-1111-1111-111111111111'
const actor = '22222222-2222-2222-2222-222222222222'
const teamId = '33333333-3333-3333-3333-333333333333'
const teams = { tenantId: tenant, chatIds: ['19:chat@thread.v2'], channels: [], allowedActors: [actor], token: 'teams-secret' }
const message = (id = '100', overrides = {}) => ({ id, messageType: 'message', from: { user: { id: actor, tenantId: tenant } },
  body: { contentType: 'html', content: '<p>Fix &amp; test<br>please</p><script>steal()</script><img src="https://evil.example/pixel">' }, ...overrides })

test('Teams reads only configured Graph scope and permitted human messages as plain text', async () => {
  const requests: URL[] = []
  const items = await pollTeams(teams, undefined, async (input, init) => {
    const url = new URL(String(input)); requests.push(url)
    assert.equal(url.origin, 'https://graph.microsoft.com')
    assert.equal(url.pathname, '/v1.0/chats/19%3Achat%40thread.v2/messages')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer teams-secret')
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error')
    return json({ value: [message(), message('101', { from: { application: { id: actor }, user: { id: actor } } }),
      message('102', { deletedDateTime: '2026-11-01' }), message('103', { messageType: 'systemEventMessage' }),
      message('104', { from: { user: { id: teamId } } }), message('105', { from: { user: { id: actor, tenantId: teamId } } })] })
  })
  assert.equal(requests.length, 1); assert.equal(items.length, 1)
  assert.equal(items[0]?.text, 'Fix & test\nplease')
  assert.equal(items[0]?.thread, 'chat:19:chat@thread.v2:100')
  assert.equal(items[0]?.source, 'teams')
})

test('Teams event IDs bind configured tenant, scope and edited message text', async () => {
  const read = (input = teams, content = 'First') => pollTeams(input, undefined, async () => json({ value: [message('100', {
    from: { user: { id: actor } }, body: { contentType: 'text', content },
  })] }))
  const first = await read(), repeated = await read(), edited = await read(teams, 'Edited')
  const otherTenant = await read({ ...teams, tenantId: teamId })
  assert.equal(first[0]?.id, repeated[0]?.id); assert.notEqual(first[0]?.id, edited[0]?.id)
  assert.notEqual(first[0]?.id, otherTenant[0]?.id)
})

test('Teams reactions do not create a new event but a text edit does', async () => {
  const read = (modified: string, content: string, edited?: string) => pollTeams(teams, undefined, async () => json({ value: [message('100', {
    lastModifiedDateTime: modified, lastEditedDateTime: edited ?? null, body: { contentType: 'text', content },
  })] }))
  const first = await read('2026-11-01T00:00:00Z', 'Hello')
  const reacted = await read('2026-11-01T00:01:00Z', 'Hello')
  const edited = await read('2026-11-01T00:02:00Z', 'Updated', '2026-11-01T00:02:00Z')
  assert.equal(first[0]?.id, reacted[0]?.id)
  assert.notEqual(first[0]?.id, edited[0]?.id)
})

test('GitHub finds an edited old review even when the PR has no recent activity', async () => {
  const result = await pollGitHubReviewsBatch({ ...config, since: '2026-11-01T00:00:00Z' }, undefined, undefined, async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/pulls')) return json([{ number: 7, updated_at: '2026-10-01T00:00:00Z' }])
    if (path.endsWith('/reviews')) return json([{ id: 88, body: '@agent edited request', submitted_at: '2026-10-01T00:00:00Z', user: { login: 'alice', type: 'User' } }])
    return json([])
  })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.text, '@agent edited request')
})

test('GitHub review scans detect edits across cycles and keep unchanged reviews deduplicable', async () => {
  let body = '@agent original'
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/pulls')) {
      assert.equal(url.searchParams.get('state'), 'all')
      assert.equal(url.searchParams.get('sort'), 'created')
      assert.equal(url.searchParams.get('direction'), 'asc')
      assert.equal(url.searchParams.has('since'), false)
      return json([{ number: 7, updated_at: '2020-01-01T00:00:00Z' }])
    }
    return json([{ id: 88, body, submitted_at: '2020-01-01T00:00:00Z', user: { login: 'alice', type: 'User' } }])
  }
  const first = await pollGitHubReviewsBatch(config, undefined, undefined, fetcher)
  const repeated = await pollGitHubReviewsBatch(config, undefined, undefined, fetcher)
  body = '@agent edited old review'
  const edited = await pollGitHubReviewsBatch(config, undefined, undefined, fetcher)
  assert.equal(first.items[0]?.id, repeated.items[0]?.id)
  assert.notEqual(first.items[0]?.id, edited.items[0]?.id)
  assert.equal(edited.items[0]?.text, body)
})

test('GitHub review scan resumes beyond 25 PRs and rejects a changed previous page', async () => {
  let changed = false
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)), currentPage = Number(url.searchParams.get('page'))
    assert.equal(url.origin, 'https://api.github.com')
    if (url.pathname.endsWith('/pulls')) {
      const numbers = currentPage === 1 ? Array.from({ length: 25 }, (_, i) => i + 1) : currentPage === 2 ? [26] : []
      if (changed && currentPage === 1) numbers[0] = 1000
      return json(numbers.map(number => ({ number })), currentPage === 1 ? { link: '<https://attacker.invalid>; rel="next"' } : undefined)
    }
    return json(url.pathname.endsWith('/26/reviews') ? [{ id: 1000, body: '@agent old review edit', user: { login: 'alice', type: 'User' } }] : [])
  }
  const first = await pollGitHubReviewsBatch(config, undefined, undefined, fetcher)
  assert.ok(first.next); assert.equal(first.items.length, 0)
  const second = await pollGitHubReviewsBatch(config, first.next, undefined, fetcher)
  assert.equal(second.items[0]?.text, '@agent old review edit')
  assert.equal(second.next, undefined)
  changed = true
  await assert.rejects(pollGitHubReviewsBatch(config, first.next, undefined, fetcher), /restart the scan/)
})

test('GitHub review scan resumes within a PR with more than 25 review pages', async () => {
  let changed = false
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/pulls')) return json([{ number: 7 }])
    const currentPage = Number(url.searchParams.get('page'))
    if (currentPage === 26) return json([{ id: 2601, body: '@agent edited', user: { login: 'alice', type: 'User' } }])
    return json(Array.from({ length: 100 }, (_, i) => ({ id: changed && currentPage === 25 && i === 0 ? 99_999 : (currentPage - 1) * 100 + i + 1, body: 'ordinary review', user: { login: 'alice', type: 'User' } })), { link: '<https://attacker.invalid>; rel="next"' })
  }
  const first = await pollGitHubReviewsBatch(config, undefined, undefined, fetcher)
  assert.equal(first.next?.reviewPage, 26)
  const second = await pollGitHubReviewsBatch(config, first.next, undefined, fetcher)
  assert.equal(second.items[0]?.text, '@agent edited')
  assert.equal(second.next, undefined)
  changed = true
  await assert.rejects(pollGitHubReviewsBatch(config, first.next, undefined, fetcher), /restart the scan/)
})

test('Teams pagination validates nextLink before forwarding credentials', async () => {
  const path = '/v1.0/chats/19%3Achat%40thread.v2/messages'
  let requests = 0
  const result = await pollTeams(teams, undefined, async input => {
    const url = new URL(String(input)); requests++
    assert.equal(url.origin, 'https://graph.microsoft.com'); assert.equal(url.pathname, path)
    return requests === 1 ? json({ value: [message()], '@odata.nextLink': `https://graph.microsoft.com${decodeURIComponent(path)}?$top=50&$skiptoken=abc%26def` }) : json({ value: [] })
  })
  assert.equal(requests, 2); assert.equal(result.length, 1)
  for (const next of [`https://evil.example${path}?$skiptoken=x`, `https://graph.microsoft.com/v1.0/me/messages?$skiptoken=x`,
    `https://graph.microsoft.com${path}?$skiptoken=x&$filter=evil`, `https://graph.microsoft.com${path}?$skiptoken=x&$top=100`,
    `https://graph.microsoft.com${path}?$skiptoken=x&$skiptoken=y`, `https://user:pass@graph.microsoft.com${path}?$skiptoken=x`]) {
    let calls = 0
    await assert.rejects(pollTeams(teams, undefined, async () => { calls++; return json({ value: [], '@odata.nextLink': next }) }), /Invalid source pagination address/)
    assert.equal(calls, 1)
  }
})

test('Teams channels read replies on locally constructed paths and bind the root thread', async () => {
  const requests: string[] = []
  const result = await pollTeams({ ...teams, chatIds: [], channels: [{ teamId, channelId: '19:channel@thread.tacv2' }] }, undefined,
    async input => { const url = new URL(String(input)); requests.push(url.pathname); return json({ value: url.pathname.endsWith('/replies') ? [message('102')] : [message('101')] }) })
  assert.equal(requests.length, 2); assert.match(requests[1]!, /\/messages\/101\/replies$/)
  assert.equal(result.length, 2); assert.equal(result[0]?.thread, result[1]?.thread)
})

test('channel batches resume across historical roots and retain replies to old roots', async () => {
  const since = '2026-11-01T00:00:00Z'
  const config = { ...teams, chatIds: [], channels: [{ teamId, channelId: '19:channel@thread.tacv2' }], since }
  const roots = Array.from({ length: 26 }, (_, i) => message(String(i + 1), { lastModifiedDateTime: '2026-10-01T00:00:00Z' }))
  const fetcher: typeof fetch = async input => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/26/replies')) return json({ value: [message('1000', { lastModifiedDateTime: '2026-11-01T01:00:00Z' })] })
    return json({ value: path.endsWith('/replies') ? [] : roots })
  }
  const first = await pollTeamsBatch(config, undefined, undefined, fetcher)
  assert.equal(first.items.length, 0); assert.ok(first.next)
  const second = await pollTeamsBatch(config, first.next, undefined, fetcher)
  assert.equal(second.items.length, 1); assert.equal(second.next, undefined)
  assert.match(second.items[0]!.thread, /:26$/)
  const reordered = [roots[25]!, ...roots.slice(0, 25)]
  await assert.rejects(pollTeamsBatch(config, first.next, undefined, async input => json({ value: new URL(String(input)).pathname.endsWith('/replies') ? [] : reordered })), /page changed/)
})

test('channel continuation accepts only validated Graph tokens and rejects pagination loops', async () => {
  const config = { ...teams, chatIds: [], channels: [{ teamId, channelId: '19:channel@thread.tacv2' }] }
  const path = `/v1.0/teams/${teamId}/channels/19%3Achannel%40thread.tacv2/messages`
  const first = await pollTeamsBatch(config, undefined, undefined, async () => json({ value: [], '@odata.nextLink': `https://graph.microsoft.com${path}?$top=50&$skiptoken=next` }))
  assert.deepEqual(first.next, { token: 'next', offset: 0 })
  await assert.rejects(pollTeamsBatch(config, first.next, undefined, async () => json({ value: [], '@odata.nextLink': `https://graph.microsoft.com${path}?$top=50&$skiptoken=next` })), /Invalid source response/)
})

test('Teams rejects hostile scope identifiers and cancellation before network activity', async () => {
  const transport: typeof fetch = async () => { assert.fail('request should not dispatch'); return json({ value: [] }) }
  for (const input of [{ ...teams, tenantId: 'tenant/other' }, { ...teams, chatIds: ['../me'] }, { ...teams, chatIds: ['chat?token=x'] },
    { ...teams, channels: [{ teamId, channelId: '..' }] }, { ...teams, allowedActors: ['alice'] }]) {
    await assert.rejects(pollTeams(input, undefined, transport), /Invalid source configuration/)
  }
  const controller = new AbortController(); controller.abort()
  await assert.rejects(pollTeams(teams, controller.signal, transport), /Source request cancelled/)
})

test('Teams since cursor filters old content and stops explicitly ordered chat history', async () => {
  let calls = 0
  const result = await pollTeams({ ...teams, since: '2026-11-01T00:00:00.000Z' }, undefined, async input => {
    const url = new URL(String(input)); calls++
    assert.equal(url.searchParams.get('$orderby'), 'lastModifiedDateTime desc')
    return json({ value: [message('100', { lastModifiedDateTime: '2026-10-30T00:00:00Z' })],
      '@odata.nextLink': 'https://evil.example/should-not-follow-old-history' })
  })
  assert.deepEqual(result, []); assert.equal(calls, 1)
  await assert.rejects(pollTeams({ ...teams, since: 'yesterday' }), /Invalid source configuration/)
})

test('PR lifecycle reads use the configured repository and validate provider facts', async () => {
  let requested = ''
  const result = await readPullRequest(config, 7, undefined, async input => {
    requested = String(input)
    return json({ number: 7, state: 'closed', merged: true, head: { sha: 'a'.repeat(40) } })
  })
  assert.equal(requested, 'https://api.github.com/repos/company/project/pulls/7')
  assert.deepEqual(result, { state: 'closed', merged: true, head: 'a'.repeat(40) })
  await assert.rejects(readPullRequest(config, -1), /Invalid source configuration/)
  await assert.rejects(readPullRequest(config, 7, undefined, async () => json({ number: 8, state: 'closed', merged: true, head: { sha: 'a'.repeat(40) } })), /Invalid source response/)
  await assert.rejects(readPullRequest(config, 7, undefined, async () => json({ number: 7, state: 'open', merged: true, head: { sha: 'a'.repeat(40) } })), /Invalid source response/)
})

test('subscribed GitHub review followups retain native review location and do not gain authority', async () => {
  const result = await pollGitHub({ ...config, subscribedNumbers: [7], allowedActors: [] }, undefined, async input => json(
    new URL(String(input)).pathname.endsWith('/pulls/comments') ? [{ id: 303, body: 'Please handle this',
      pull_request_url: 'https://api.github.com/repos/company/project/pulls/7', user: { login: 'reviewer', type: 'User' },
      in_reply_to_id: 300, pull_request_review_id: 90, path: 'src/file.ts', line: 42, original_line: 41,
      diff_hunk: '@@ -1 +1 @@\n-old\n+new', commit_id: 'a'.repeat(40), created_at: '2026-11-01T00:00:00Z' }] : []))
  assert.equal(result.length, 1)
  const context = result[0]!.context!
  assert.equal(context.provider, 'github')
  if (context.provider !== 'github') assert.fail('GitHub context required')
  assert.equal(context.reviewRootCommentId, 300); assert.equal(context.commentId, 303); assert.equal(context.reviewId, 90)
  assert.equal(context.path, 'src/file.ts'); assert.equal(context.line, 42); assert.equal(context.originalLine, 41)
  assert.equal(context.allowedActor, false); assert.equal(context.subscribed, true); assert.equal(context.human, true)
  const trigger = sourceTrigger(result[0]!)
  assert.equal(trigger.threads[0]?.source, trigger.channel?.source)
  assert.equal(trigger.threads[0]?.id, '7'); assert.equal(trigger.channel?.address.reviewRootCommentId, '300')
  assert.equal(trigger.meta.contextOnly, true); assert.equal(trigger.addressed, undefined)
  assert.deepEqual(trigger.threads[0], githubThreadRef(config, 7))
  assert.deepEqual(trigger.meta.provider, context)
})

test('GitHub subscriptions include unlisted bots as context and still exclude the configured agent', async () => {
  const comments = [
    { id: 30, user: { login: 'checks[bot]', type: 'Bot' }, body: 'CI feedback' },
    { id: 31, user: { login: 'outsider', type: 'User' }, body: 'Followup' },
    { id: 32, user: { login: 'agent', type: 'User' }, body: '@agent own reply' },
  ].map(row => ({ ...row, issue_url: 'https://api.github.com/repos/company/project/issues/7' }))
  const fetcher: typeof fetch = async input => json(new URL(String(input)).pathname.endsWith('/issues/comments') ? comments : [])
  assert.deepEqual(await pollGitHub(config, undefined, fetcher), [])
  const items = await pollGitHub({ ...config, subscribedNumbers: [7] }, undefined, fetcher)
  assert.equal(items.length, 2)
  assert.equal(items[0]!.context?.bot, true); assert.equal(sourceTrigger(items[0]!).human, false)
  assert.equal(items[0]!.context?.allowedActor, false)
  const observed = await pollGitHub({ ...config, observeComments: true, allowedBots: ['checks[bot]'] }, undefined, fetcher)
  assert.equal(observed.length, 1); assert.equal(sourceTrigger(observed[0]!).human, false)
})

test('source identities distinguish repositories and Teams tenants while preserving native thread IDs', async () => {
  const read = (repository: string) => pollGitHub({ ...config, repository }, undefined, async input => json(new URL(String(input)).pathname.endsWith('/issues') ? [issue()] : []))
  const left = sourceTrigger((await read('company/project'))[0]!), right = sourceTrigger((await read('company/other'))[0]!)
  assert.notEqual(left.source, right.source); assert.equal(left.threads[0]!.id, right.threads[0]!.id)
  const [entry] = await pollTeams(teams, undefined, async () => json({ value: [message()] }))
  const trigger = sourceTrigger(entry!)
  assert.equal(trigger.threads[0]!.id, '100')
  assert.equal(trigger.channel!.address.chatId, '19:chat@thread.v2')
  assert.equal(trigger.channel!.address.rootMessageId, '100')
  assert.equal(sourceSubscription(entry!.context!), entry!.thread)
  assert.throws(() => sourceTrigger({ id: 'legacy', source: 'teams', actor, text: 'old', thread: '100' }), /refresh the inbox/)
})

test('subscribed Teams roots receive other humans and bot replies and exclude native self messages', async () => {
  const input = { ...teams, chatIds: [], channels: [{ teamId, channelId: '19:channel@thread.tacv2' }], accountId: actor,
    subscribedThreads: [`team:${teamId}:channel:19:channel@thread.tacv2:100`] }
  const result = await pollTeams(input, undefined, async input => json({ value: new URL(String(input)).pathname.endsWith('/replies') ? [
    message('101', { from: { user: { id: teamId } }, replyToId: '100', createdDateTime: '2026-11-01T00:00:00Z', webUrl: 'https://teams.microsoft.com/l/message/channel/101' }),
    message('102', { from: { application: { id: tenant } }, replyToId: '100' }), message('103'),
  ] : [message()] }))
  assert.equal(result.length, 2)
  const first = result[0]!.context!
  if (first.provider !== 'teams') assert.fail('Teams context required')
  assert.equal(first.messageId, '101'); assert.equal(first.rootMessageId, '100')
  assert.equal(first.teamId, teamId); assert.equal(first.channelId, '19:channel@thread.tacv2')
  assert.equal(first.tenantId, tenant); assert.equal(first.allowedActor, false); assert.equal(first.createdAt, '2026-11-01T00:00:00Z')
  assert.equal(result[1]!.context!.bot, true); assert.equal(sourceTrigger(result[1]!).human, false)
})

test('Teams quoted chat followups bind the original subscribed root and reject cross-chat quote links', async () => {
  const quoted = (chat: string) => `<blockquote itemid="https://teams.microsoft.com/l/message/${encodeURIComponent(chat)}/100">original</blockquote><p>Followup</p>`
  const input = { ...teams, allowedActors: [], subscribedThreads: ['chat:19:chat@thread.v2:100'] }
  const result = await pollTeams(input, undefined, async () => json({ value: [
    message('101', { from: { user: { id: teamId } }, body: { contentType: 'html', content: quoted(teams.chatIds[0]!) } }),
    message('102', { from: { user: { id: teamId } }, body: { contentType: 'html', content: quoted('other-chat') } }),
  ] }))
  assert.equal(result.length, 1); assert.equal(result[0]!.thread, input.subscribedThreads[0])
})

test('bounded thread history reads retain reviews and comments regardless of intake actor gates', async () => {
  const calls: string[] = []
  const items = await readGitHubThread({ ...config, allowedActors: [] }, 7, undefined, async input => {
    const path = new URL(String(input)).pathname; calls.push(path)
    if (path.endsWith('/issues/7')) return json(issue('Description', { pull_request: {} }))
    if (path.endsWith('/issues/7/comments')) return json([{ id: 10, body: 'Unlisted comment', user: { login: 'other', type: 'User' } }])
    if (path.endsWith('/reviews')) return json([{ id: 11, body: 'Changes requested', state: 'CHANGES_REQUESTED', user: { login: 'other', type: 'User' } }])
    return json([{ id: 12, body: 'Inline', path: 'file.ts', line: 8, user: { login: 'other', type: 'User' } }])
  })
  assert.equal(items.length, 4); assert.equal(calls.length, 4)
  assert.ok(calls.every(path => path.startsWith('/repos/company/project/')))
  assert.equal(items[2]!.context!.provider === 'github' && items[2]!.context!.state, 'CHANGES_REQUESTED')
})

test('PR discovery filters by native author and lifecycle reads retain claim evidence', async () => {
  const data = { number: 7, state: 'open', merged: false, draft: true, user: { login: 'agent' }, head: { sha: 'b'.repeat(40), ref: 'superagent/ticket-1' } }
  const discovered = await discoverOwnPullRequests(config, undefined, async input => {
    assert.equal(new URL(String(input)).pathname, '/repos/company/project/pulls')
    return json([data, { ...data, number: 8, user: { login: 'other' } }])
  })
  assert.equal(discovered.length, 1); assert.equal(discovered[0]!.branch, 'superagent/ticket-1')
  const pull = await readPullRequest(config, 7, undefined, async () => json(data))
  assert.equal(pull.author, 'agent'); assert.equal(pull.branch, 'superagent/ticket-1'); assert.equal(pull.draft, true)
})

test('CI polling reads statuses and checks for the exact head and produces stable context-only events', async () => {
  const head = 'a'.repeat(40), calls: string[] = []
  const fetcher: typeof fetch = async input => {
    const path = new URL(String(input)).pathname; calls.push(path)
    if (path.endsWith('/pulls/7')) return json({ number: 7, state: 'open', merged: false, head: { sha: head } })
    if (path.endsWith('/statuses')) return json([{ id: 1, context: 'lint', state: 'success', updated_at: '2026-11-01T00:00:00Z' }])
    assert.equal(path, `/repos/company/project/commits/${head}/check-runs`)
    return json({ check_runs: [{ id: 2, name: 'test', status: 'completed', conclusion: 'failure', completed_at: '2026-11-01T00:00:01Z' }] })
  }
  const input = { ...config, subscribedNumbers: [7] }
  const first = await pollGitHubChecks(input, undefined, undefined, fetcher), repeated = await pollGitHubChecks(input, undefined, undefined, fetcher)
  assert.equal(calls.length, 6); assert.equal(first[0]!.id, repeated[0]!.id)
  assert.match(first[0]!.text, /lint: success/); assert.match(first[0]!.text, /test: failure/)
  const trigger = sourceTrigger(first[0]!)
  assert.equal(trigger.human, false); assert.equal(trigger.meta.contextOnly, true)
  assert.equal(first[0]!.context!.provider === 'github' && first[0]!.context!.commitId, head)
})

test('Graph messageReference attachments and quote chains preserve the subscribed original chat thread', async () => {
  const reference = (messageId: string) => [{ contentType: 'messageReference', content: JSON.stringify({ messageId, messagePreview: 'Untrusted quoted text' }) }]
  const result = await pollTeams({ ...teams, allowedActors: [], subscribedThreads: ['chat:19:chat@thread.v2:100'] }, undefined, async () => json({ value: [
    message('102', { from: { user: { id: teamId } }, attachments: reference('101') }),
    message('101', { from: { user: { id: teamId } }, attachments: reference('100') }),
    message('100', { from: { user: { id: teamId } } }),
  ] }))
  assert.equal(result.length, 3)
  assert.ok(result.every(item => item.thread === 'chat:19:chat@thread.v2:100'))
  const context = result[0]!.context!
  assert.equal(context.provider === 'teams' && context.rootMessageId, '100')
  assert.deepEqual(context.provider === 'teams' && context.referencedMessageIds, ['101'])
  assert.deepEqual(sourceTrigger(result[0]!).threads.map(thread => thread.id), ['100', '101'])
})
