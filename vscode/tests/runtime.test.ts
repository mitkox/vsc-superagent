import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TicketRuntime } from '../src/runtime.ts'
import type { TeamsContext } from '../src/sources.ts'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'vsc-superagent-runtime-'))
  const runtime = new TicketRuntime(directory)
  return { directory, runtime, clean: () => { runtime.dispose(); rmSync(directory, { recursive: true, force: true }) } }
}

test('local approval creates a durable pending ticket; beginning delivers its inputs', () => {
  const f = fixture()
  try {
    const ticket = f.runtime.create('Repair the login form validation')
    assert.equal(ticket.assignments.at(-1)?.state, 'pending')
    assert.equal(ticket.mandate.actor.source, 'vscode')
    assert.equal(f.runtime.begin(ticket.id).assignments.at(-1)?.state, 'running')
    assert.equal(f.runtime.get(ticket.id).undelivered.length, 0)
    assert.equal(f.runtime.report(ticket.id, 'ready', 'Validation fixed and tests passed').ended?.outcome, 'completed')
    assert.equal(statSync(join(f.directory, 'state.json')).mode & 0o777, 0o600)
    const audit = JSON.stringify(JSON.parse(readFileSync(join(f.directory, 'state.json'), 'utf8')).data.audit)
    assert.doesNotMatch(audit, /login form|Validation fixed/)
  } finally { f.clean() }
})

test('restart retains tickets and requires retry for interrupted work', () => {
  const f = fixture()
  let reopened: TicketRuntime | undefined
  try {
    const ticket = f.runtime.create('Implement the requested change')
    f.runtime.begin(ticket.id)
    f.runtime.dispose()
    reopened = new TicketRuntime(f.directory)
    assert.equal(reopened.get(ticket.id).assignments.at(-1)?.report?.state, 'blocked')
    assert.throws(() => reopened!.begin(ticket.id), /retry/i)
    assert.equal(reopened.retry(ticket.id).assignments.length, 2)
    assert.equal(reopened.begin(ticket.id).assignments.at(-1)?.state, 'running')
  } finally { reopened?.dispose(); f.clean() }
})

test('pause blocks new execution and retry while preserving reports and stop', () => {
  const f = fixture()
  try {
    const ticket = f.runtime.create('Review access controls')
    f.runtime.setPaused(true)
    assert.throws(() => f.runtime.begin(ticket.id), /paused/i)
    assert.throws(() => f.runtime.create('An additional requested task'), /paused/i)
    f.runtime.setPaused(false)
    f.runtime.begin(ticket.id)
    f.runtime.report(ticket.id, 'failed', 'A person must repair credentials')
    f.runtime.setPaused(true)
    assert.throws(() => f.runtime.retry(ticket.id), /paused/i)
    assert.equal(f.runtime.stop(ticket.id).ended?.by, 'human')
    f.runtime.setPaused(false)
    assert.throws(() => f.runtime.followup(ticket.id, 'Please resume'), /stopped/i)
  } finally { f.clean() }
})

test('followups remain on the existing ticket and stop withdraws authority', () => {
  const f = fixture()
  try {
    const ticket = f.runtime.create('Make the settings accessible')
    f.runtime.begin(ticket.id)
    f.runtime.report(ticket.id, 'waiting', 'Waiting for the requested design')
    const followed = f.runtime.followup(ticket.id, 'Use the provided high contrast design')
    assert.equal(f.runtime.list().length, 1)
    assert.ok(followed.undelivered.length > 0)
    f.runtime.begin(ticket.id)
    assert.equal(f.runtime.get(ticket.id).undelivered.length, 0)
    f.runtime.stop(ticket.id)
    assert.throws(() => f.runtime.begin(ticket.id), /ended|stopped/i)
  } finally { f.clean() }
})

test('a ready ticket follows its pull request until it closes', () => {
  const f = fixture()
  try {
    const ticket = f.runtime.create('Fix the documented regression')
    f.runtime.begin(ticket.id)
    f.runtime.bindPullRequest(ticket.id, 42, true, 'test-repository')
    assert.equal(f.runtime.report(ticket.id, 'ready', 'Pull request 42 ready for review').ended, undefined)
    f.runtime.closePullRequest(42, 'merged', 'test-repository')
    assert.equal(f.runtime.get(ticket.id).ended?.outcome, 'merged')
  } finally { f.clean() }
})

test('a rejected report leaves its proposed PR binding unmodified', () => {
  const f = fixture()
  try {
    const ticket = f.runtime.create('Fix the regression')
    f.runtime.begin(ticket.id)
    assert.throws(() => f.runtime.reportWithPullRequest(ticket.id, 'ready', 'Ready', 'Open question', 42, 'repo'), /question.*ready/i)
    assert.equal(f.runtime.get(ticket.id).follows?.length ?? 0, 0)
    assert.equal(f.runtime.report(ticket.id, 'ready', 'Ready').ended?.outcome, 'completed')
  } finally { f.clean() }
})

test('closing a PR in one repository cannot complete the same PR number in another repository', () => {
  const f = fixture()
  try {
    const a = f.runtime.create('Fix repository A')
    f.runtime.begin(a.id)
    f.runtime.bindPullRequest(a.id, 42, true, 'https://github.example/a/repo')
    f.runtime.report(a.id, 'ready', 'A ready for review')
    const b = f.runtime.create('Fix repository B')
    f.runtime.begin(b.id)
    f.runtime.bindPullRequest(b.id, 42, true, 'https://github.example/b/repo')
    f.runtime.report(b.id, 'ready', 'B ready for review')
    f.runtime.closePullRequest(42, 'merged', 'https://github.example/a/repo')
    assert.equal(f.runtime.get(a.id).ended?.outcome, 'merged')
    assert.equal(f.runtime.get(b.id).ended, undefined)
  } finally { f.clean() }
})

test('external follow-up reapproval after a host restart appends the event only once', () => {
  const f = fixture()
  try {
    const ticket = f.runtime.create('Approved initial task')
    const origin = { source: 'teams', id: 'immutable-message-version', actor: 'approved-user' }
    f.runtime.followup(ticket.id, 'Approved external follow-up', origin)
    f.runtime.dispose()
    const reopened = new TicketRuntime(f.directory)
    try {
      reopened.followup(ticket.id, 'Approved external follow-up', origin)
      assert.equal(reopened.context(ticket.id).messages.filter(message => message.text === 'Approved external follow-up').length, 1)
    } finally { reopened.dispose() }
  } finally { f.clean() }
})

test('one active assignment is allowed and a blocked worker frees its slot', () => {
  const f = fixture()
  try {
    const first = f.runtime.create('First requested task')
    const second = f.runtime.create('Second requested task')
    f.runtime.begin(first.id)
    assert.throws(() => f.runtime.begin(second.id), /another|concurrency/i)
    f.runtime.report(first.id, 'blocked', 'Awaiting a person')
    assert.equal(f.runtime.begin(second.id).assignments.at(-1)?.state, 'running')
  } finally { f.clean() }
})

test('exclusive ownership prevents two extension hosts writing the same state', () => {
  const f = fixture()
  try { assert.throws(() => new TicketRuntime(f.directory), /lock|another/i) }
  finally { f.clean() }
})

test('corrupt durable data fails closed without replacing the original', () => {
  const f = fixture()
  try {
    f.runtime.create('Persist an authorized request')
    f.runtime.dispose()
    writeFileSync(join(f.directory, 'state.json'), '{broken')
    assert.throws(() => new TicketRuntime(f.directory), /corrupt|state/i)
    assert.equal(readFileSync(join(f.directory, 'state.json'), 'utf8'), '{broken')
  } finally { f.clean() }
})

test('failed durable write rolls back the in-memory ticket mutation', () => {
  const f = fixture()
  try {
    const ticket = f.runtime.create('Maintain transaction integrity')
    rmSync(join(f.directory, 'state.json'))
    // A directory at the target makes the atomic rename fail even for privileged test runners.
    mkdirSync(join(f.directory, 'state.json'))
    assert.throws(() => f.runtime.stop(ticket.id))
    assert.equal(f.runtime.get(ticket.id).ended, undefined)
  } finally { f.clean() }
})

test('runtime validates tool arguments and refuses operations after disposal', () => {
  const f = fixture()
  try {
    assert.throws(() => f.runtime.create(''), /text/i)
    assert.throws(() => f.runtime.create('x'.repeat(51_000)), /text/i)
    assert.throws(() => f.runtime.get('../outside'), /ticket/i)
    const ticket = f.runtime.create('Validate every public command')
    assert.throws(() => f.runtime.bindPullRequest(ticket.id, -1, true, 'test-repository'), /pull request/i)
    assert.throws(() => f.runtime.report(ticket.id, 'arbitrary' as never, 'invalid'), /state/i)
    f.runtime.dispose()
    assert.throws(() => f.runtime.create('A request after disposal'), /disposed/i)
  } finally { f.clean() }
})

test('reimporting an approved external event is idempotent across restart', () => {
  const f = fixture()
  let reopened: TicketRuntime | undefined
  try {
    const origin = { source: 'github', id: 'comment-42', actor: 'allowed-user' }
    const first = f.runtime.create('Repair the login error', origin)
    assert.equal(f.runtime.create('Repair the login error', origin).id, first.id)
    f.runtime.dispose()
    reopened = new TicketRuntime(f.directory)
    assert.equal(reopened.create('Repair the login error', origin).id, first.id)
    assert.equal(reopened.list().length, 1)
  } finally { reopened?.dispose(); f.clean() }
})

test('a completed ticket can resume from a locally approved followup and persist it', () => {
  const f = fixture()
  let reopened: TicketRuntime | undefined
  try {
    const ticket = f.runtime.create('Make the requested improvement')
    f.runtime.begin(ticket.id)
    f.runtime.report(ticket.id, 'ready', 'The improvement is ready')
    const resumed = f.runtime.followup(ticket.id, 'Please add keyboard support')
    assert.equal(resumed.ended, undefined)
    assert.equal(resumed.assignments.at(-1)?.state, 'pending')
    f.runtime.dispose()
    reopened = new TicketRuntime(f.directory)
    assert.match(reopened.context(ticket.id).messages.at(-1)!.text, /keyboard support/)
  } finally { reopened?.dispose(); f.clean() }
})

test('native approval preserves provider channels, subscriptions and full source context across restart', () => {
  const f = fixture()
  let reopened: TicketRuntime | undefined
  try {
    const context: TeamsContext = { provider: 'teams', tenantId: 'approved-tenant', chatId: 'approved-chat', rootMessageId: 'root-1', messageId: 'reply-2', sourceConfigId: 'teams:config', nativeThreadId: 'root-1', human: true, bot: false, allowedActor: true, subscribed: false, addressed: 'mention' }
    const ticket = f.runtime.create('Fix the deployment issue', { source: 'teams', id: 'event-2', actor: 'requester', thread: 'root-1', url: 'https://teams.microsoft.com/l/message/root-1', context })
    assert.equal(ticket.mandate.actor.source, 'vscode')
    assert.match(ticket.channels[0]?.source ?? '', /^teams:/)
    assert.equal(ticket.channels[0]?.address.messageId, 'reply-2')
    f.runtime.dispose()
    reopened = new TicketRuntime(f.directory)
    const message = reopened.context(ticket.id).messages[0]!
    assert.equal(message.source, 'vscode')
    assert.equal(message.url, 'https://teams.microsoft.com/l/message/root-1')
    assert.deepEqual(message.meta.provider, context)
    assert.ok(reopened.repositories.threads.list().some(thread => thread.ref.source.startsWith('teams:') && thread.subscriptions.includes(ticket.id)))
  } finally { reopened?.dispose(); f.clean() }
})

test('source cursor metadata extends legacy state under the same checksum and lock', () => {
  const f = fixture()
  let reopened: TicketRuntime | undefined
  try {
    f.runtime.create('Legacy local ticket')
    assert.equal(JSON.parse(readFileSync(join(f.directory, 'state.json'), 'utf8')).data.extension, undefined)
    f.runtime.writeData('source:github:cursor', { since: '2026-11-01T00:00:00Z', ids: ['event-1'] })
    assert.throws(() => f.runtime.writeData('__proto__', {}), /metadata key/i)
    f.runtime.dispose(); reopened = new TicketRuntime(f.directory)
    assert.deepEqual(reopened.readData('source:github:cursor'), { since: '2026-11-01T00:00:00Z', ids: ['event-1'] })
    const state = JSON.parse(readFileSync(join(f.directory, 'state.json'), 'utf8'))
    assert.equal(state.version, 1)
    assert.equal(state.data.extension.version, 1)
  } finally { reopened?.dispose(); f.clean() }
})
