import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceResources } from '../src/source-resources.ts'
import type { GitHubDeliveryCredential } from '../src/delivery.ts'

const credential: GitHubDeliveryCredential = { provider: 'github', origin: 'https://api.github.com', repository: 'owner/repo', account: 'agent', allowedActors: ['alice'], token: 'not-a-live-token', scopes: [] }
const signal = new AbortController().signal
const head = 'a'.repeat(40)
function provider() {
  const requests: URL[] = []
  const transport: typeof fetch = async input => {
    const url = new URL(String(input)); requests.push(url)
    if (url.pathname.endsWith('/pulls/9')) return Response.json({ number: 9, state: 'open', merged: false, head: { sha: head } })
    if (url.pathname.endsWith('/statuses')) return Response.json([{ id: 1, state: 'success', context: 'unit-tests' }])
    if (url.pathname.endsWith('/check-runs')) return Response.json({ check_runs: [] })
    if (url.pathname.endsWith('/issues/9')) return Response.json({ id: 10, number: 9, title: 'Another PR', body: 'Its real description', user: { login: 'alice', type: 'User' }, pull_request: {} })
    if (url.pathname.endsWith('/pulls/9/comments')) return Response.json(Array.from({ length: 21 }, (_, index) => ({ id: index + 100, body: `review ${index}`, user: { login: 'alice', type: 'User' }, path: 'src/example.ts', line: 12, ...(index === 1 ? { in_reply_to_id: 100 } : {}) })))
    return Response.json([])
  }
  return { requests, transport }
}
test('source resource paths select the requested PR, checks and native review thread', async () => {
  const { transport, requests } = provider(), resources = new SourceResources()
  const checks = await resources.read('ticket', undefined, credential, { resource: 'github/pulls/9/checks' }, signal, transport)
  assert.equal(JSON.parse(checks.text).head, head)
  assert.ok(requests.some(url => url.pathname.endsWith(`/commits/${head}/statuses`)))
  const thread = await resources.read('ticket', undefined, credential, { resource: 'github/pulls/9/thread/101' }, signal, transport)
  assert.deepEqual(JSON.parse(thread.text).map((row: { id: number }) => row.id), [100, 101])
  assert.equal(JSON.parse(thread.text)[0].path, 'src/example.ts')
})
test('source entry pages expose next_resource and text offsets retain their original snapshot', async () => {
  const { transport, requests } = provider(), resources = new SourceResources()
  const resource = 'github/pulls/9/comments/1'
  const first = await resources.read('ticket', undefined, credential, { resource, limit: 100 }, signal, transport)
  assert.equal(first.next_resource, 'github/pulls/9/comments/2')
  const calls = requests.length
  const second = await resources.read('ticket', undefined, credential, { resource, offset: first.next_offset, limit: 100 }, signal, transport)
  assert.equal(requests.length, calls)
  assert.equal(second.text.length, 100)
  const last = await resources.read('ticket', undefined, credential, { resource: first.next_resource }, signal, transport)
  assert.equal(JSON.parse(last.text)[0].id, 120)
  await assert.rejects(resources.read('ticket', undefined, credential, { resource: 'github/pulls/10/comments/1', offset: 100 }, signal, transport), /snapshot expired/)
})
