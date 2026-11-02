import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readTeamsMembers, TEAMS_MEMBERS_SCOPE } from '../src/membership.ts'
import type { TeamsSourceConfig } from '../src/sources.ts'

const tenantId = '11111111-1111-1111-1111-111111111111'
const alice = '22222222-2222-2222-2222-222222222222'
const bob = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
const chatId = '19:sync-chat@thread.v2'
const config: TeamsSourceConfig = { tenantId, chatIds: [chatId], channels: [], allowedActors: [], token: 'teams-private-token' }
const path = '/v1.0/chats/19%3Async-chat%40thread.v2/members'
const json = (value: unknown, headers?: HeadersInit) => new Response(JSON.stringify(value), { headers })
const member = (userId: string, displayName?: string, overrides = {}) => ({ '@odata.type': '#microsoft.graph.aadUserConversationMember',
  id: 'opaque-membership-not-a-user-uuid', userId, tenantId, ...(displayName ? { displayName } : {}), ...overrides })

test('membership sync reads only the configured exact Graph chat with caller-supplied delegated credentials', async () => {
  assert.equal(TEAMS_MEMBERS_SCOPE, 'ChatMember.Read')
  const result = await readTeamsMembers(config, chatId, undefined, async (input, init) => {
    assert.equal(String(input), `https://graph.microsoft.com${path}`)
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.equal(init?.body, undefined)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer teams-private-token')
    return json({ value: [member(alice, 'Alice'), member(bob, 'Bob')] })
  })
  assert.deepEqual(result, [{ id: alice, name: 'Alice' }, { id: bob.toLowerCase(), name: 'Bob' }])
})

test('member identities deduplicate case-insensitively across pages and use userId instead of opaque membership IDs', async () => {
  let requests = 0
  const result = await readTeamsMembers(config, chatId, undefined, async input => {
    const url = new URL(String(input)); requests++
    assert.equal(url.origin, 'https://graph.microsoft.com'); assert.equal(url.pathname, path)
    if (requests === 1) return json({ value: [member(bob), member(alice, 'Alice')],
      '@odata.nextLink': `https://graph.microsoft.com${decodeURIComponent(path)}?$skiptoken=cursor%26opaque` })
    assert.equal(url.searchParams.get('$skiptoken'), 'cursor&opaque')
    return json({ value: [member(bob.toLowerCase(), 'Bob'), member(alice, 'Changed duplicate name')] })
  })
  assert.equal(requests, 2)
  assert.deepEqual(result, [{ id: alice, name: 'Alice' }, { id: bob.toLowerCase(), name: 'Bob' }])
})

test('non-AAD identities and explicit cross-tenant members never enter the synced actor list', async () => {
  const result = await readTeamsMembers(config, chatId, undefined, async () => json({ value: [
    member(alice, 'Alice'), member(bob, 'Foreign', { tenantId: alice }),
    member(bob, 'Bot', { '@odata.type': '#microsoft.graph.conversationMember' }),
    { id: alice, displayName: 'An opaque membership ID is not an actor' },
    { '@odata.type': '#microsoft.graph.anonymousGuestConversationMember', userId: bob },
  ] }))
  assert.deepEqual(result, [{ id: alice, name: 'Alice' }])
})

test('an unapproved sync chat and hostile configuration identifiers are rejected before network activity', async () => {
  const transport: typeof fetch = async () => { assert.fail('must not dispatch'); return json({ value: [] }) }
  for (const chat of ['19:unapproved@thread.v2', '../me', 'chat?token=x', '']) {
    await assert.rejects(readTeamsMembers(config, chat, undefined, transport), /not approved/)
  }
  await assert.rejects(readTeamsMembers({ ...config, chatIds: ['../me'] }, '../me', undefined, transport), /Invalid source configuration/)
})

test('hostile member continuations are rejected before forwarding credentials', async () => {
  const nextLinks = [
    `https://evil.example${path}?$skiptoken=x`,
    `https://graph.microsoft.com/v1.0/chats/other/members?$skiptoken=x`,
    `https://graph.microsoft.com${path}/extra?$skiptoken=x`,
    `https://graph.microsoft.com${path}?$skiptoken=x&$select=userId`,
    `https://graph.microsoft.com${path}?$skiptoken=x&$skiptoken=y`,
    `https://graph.microsoft.com${path}?$skiptoken=`,
    `https://graph.microsoft.com${path}?$top=100`,
    `https://user:password@graph.microsoft.com${path}?$skiptoken=x`,
    `https://graph.microsoft.com${path}?$skiptoken=x#fragment`,
    `http://graph.microsoft.com${path}?$skiptoken=x`,
  ]
  for (const next of nextLinks) {
    let calls = 0
    await assert.rejects(readTeamsMembers(config, chatId, undefined, async () => {
      calls++; return json({ value: [member(alice)], '@odata.nextLink': next })
    }), /membership pagination address/)
    assert.equal(calls, 1)
  }
})

test('membership continuation loops and more than five pages fail without returning a partial snapshot', async () => {
  let calls = 0
  await assert.rejects(readTeamsMembers(config, chatId, undefined, async () => {
    calls++; return json({ value: [member(alice)], '@odata.nextLink': `https://graph.microsoft.com${path}?$skiptoken=repeat` })
  }), /Invalid Teams membership response/)
  assert.equal(calls, 2)
  calls = 0
  await assert.rejects(readTeamsMembers(config, chatId, undefined, async () => {
    calls++; return json({ value: [member(alice)], '@odata.nextLink': `https://graph.microsoft.com${path}?$skiptoken=page${calls}` })
  }), /membership pagination limit/)
  assert.equal(calls, 5)
})

test('the complete snapshot is bounded to 1000 native UUID identities', async () => {
  const users = Array.from({ length: 1001 }, (_, index) => member(`${index.toString(16).padStart(8, '0')}-0000-0000-0000-000000000001`))
  let calls = 0
  await assert.rejects(readTeamsMembers(config, chatId, undefined, async () => {
    calls++
    return calls === 1 ? json({ value: users.slice(0, 1000), '@odata.nextLink': `https://graph.microsoft.com${path}?$skiptoken=next` })
      : json({ value: users.slice(1000) })
  }), /membership identity limit/)
  assert.equal(calls, 2)
  const complete = await readTeamsMembers(config, chatId, undefined, async () => json({ value: users.slice(0, 1000) }))
  assert.equal(complete.length, 1000)
})

test('malformed AAD identities and response envelopes fail the complete sync rather than returning a partial list', async () => {
  for (const value of [{ value: [member('not-a-uuid')] }, { value: [member(alice, 'Alice', { tenantId: 'other' })] },
    { value: [null] }, { value: {} }, [], { value: [], '@odata.nextLink': 42 }]) {
    await assert.rejects(readTeamsMembers(config, chatId, undefined, async () => json(value)), /Invalid Teams membership response/)
  }
})

test('member display names remain bounded display data with control characters flattened', async () => {
  const result = await readTeamsMembers(config, chatId, undefined, async () => json({ value: [member(alice, 'Alice\n\t\0Example'), member(bob, 'X'.repeat(1000))] }))
  assert.equal(result[0]?.name, 'Alice Example'); assert.equal(result[1]?.name?.length, 512)
})

test('cancellation, redirects, provider errors and arbitrary transport errors remain sanitized', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(readTeamsMembers(config, chatId, controller.signal, async () => { assert.fail('must not dispatch'); return json({}) }), /cancelled/)
  for (const transport of [async () => new Response('teams-private-token', { status: 403 }),
    async () => new Response('teams-private-token', { status: 302 }), async () => { throw new Error('teams-private-token') }]) {
    await assert.rejects(readTeamsMembers(config, chatId, undefined, transport), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /teams-private-token/); return true
    })
  }
})
