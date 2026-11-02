import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Trigger } from '../../src/core/index.ts'
import { TicketRuntime } from '../src/runtime.ts'

const capacity = 16 * 1024 * 1024
const stamp = (index: number) => new Date(Date.UTC(2026, 10, 2, 0, 0, index)).toISOString()

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-state-capacity-'))
  const runtime = new TicketRuntime(directory)
  return { directory, runtime, file: join(directory, 'state.json'), close: () => { runtime.dispose(); rmSync(directory, { recursive: true, force: true }) } }
}
function businessBytes(file: string): number {
  const envelope = JSON.parse(readFileSync(file, 'utf8'))
  for (const session of envelope.data.extension.sessions) session.transcript = []
  return Buffer.byteLength(JSON.stringify(envelope))
}

function businessTriggers(bytes: number): Trigger[] {
  const events: Trigger[] = []
  let remaining = bytes
  while (remaining > 512) {
    const index = events.length
    const event: Trigger = { id: `retained-source-${index}`, source: 'github:proved-scope', threads: [{ source: 'github:proved-scope', id: '42' }],
      actor: { source: 'github:proved-scope', id: 'owner' }, human: true, at: stamp(index), text: '', meta: { url: `https://example.invalid/repo/issues/42#comment-${index}` } }
    const overhead = Buffer.byteLength(JSON.stringify(event)) + 1
    event.text = 'b'.repeat(Math.min(90_000, remaining - overhead))
    remaining -= overhead + event.text.length
    events.push(event)
  }
  return events
}

test('business commits reclaim diagnostic space globally without evicting records or reserving business capacity', () => {
  const f = fixture()
  let reopened: TicketRuntime | undefined
  try {
    const ticket = f.runtime.create('Keep the original business records and source URL https://example.invalid/task/42')
    f.runtime.begin(ticket.id)
    const records = f.runtime.repositories.snapshot()
    f.runtime.repositories.mutateAutomation(data => {
      data.sessions = Array.from({ length: 6 }, (_, index) => ({ ticketId: `session-ticket-${index}`, sessionId: `persistent-${index}`, status: 'idle', revisions: [1, 2],
        transcript: Array.from({ length: 10 }, (_, event) => ({ type: 'tool.shell_output', text: `${index}:${event}:` + 'x'.repeat(50_000), at: stamp(index * 10 + event) })) }))
    })
    // Leave only a few KiB below the actual envelope limit. Diagnostic slack must
    // not impose a smaller capacity on business data that itself still fits.
    const business = businessTriggers(capacity - businessBytes(f.file) - 8192)
    f.runtime.repositories.atomic(() => { for (const trigger of business) f.runtime.repositories.triggers.save(trigger) })
    assert.ok(statSync(f.file).size < capacity)
    assert.ok(statSync(f.file).size > capacity - 16_384)
    const expected = { ...records, triggers: [...records.triggers, ...business] }
    assert.deepEqual(f.runtime.repositories.snapshot(), expected)
    const sessions = f.runtime.repositories.automation().sessions
    assert.equal(sessions.length, 6)
    assert.deepEqual(sessions.map(session => session.sessionId), Array.from({ length: 6 }, (_, index) => `persistent-${index}`))
    assert.ok(sessions.every(session => session.transcript.length === 0))
    assert.equal(f.runtime.report(ticket.id, 'ready', 'Successfully recorded after transcript reclamation').ended?.outcome, 'completed')
    const completed = f.runtime.repositories.snapshot()
    assert.deepEqual(completed.triggers, expected.triggers)
    f.runtime.dispose()
    reopened = new TicketRuntime(f.directory)
    assert.deepEqual(reopened.repositories.snapshot(), completed)
    assert.deepEqual(reopened.repositories.automation().sessions, sessions)
  } finally { reopened?.dispose(); f.close() }
})

test('business-only capacity failure rolls back the entire transaction and leaves the durable checksum usable', () => {
  const f = fixture()
  let reopened: TicketRuntime | undefined
  try {
    const ticket = f.runtime.create('Preserve this mandate after an oversized business write')
    f.runtime.repositories.mutateAutomation(data => {
      data.sessions.push({ ticketId: ticket.id, sessionId: 'persistent-capacity-session', status: 'idle', revisions: [1],
        transcript: [{ type: 'assistant.message', text: 'A useful diagnostic tail', at: stamp(1) }] })
    })
    const original = readFileSync(f.file, 'utf8')
    const snapshot = f.runtime.repositories.snapshot(), sessions = f.runtime.repositories.automation().sessions
    const oversized = businessTriggers(capacity + 100_000)
    assert.throws(() => f.runtime.repositories.atomic(() => { for (const trigger of oversized) f.runtime.repositories.triggers.save(trigger) }), /state capacity reached/)
    assert.equal(readFileSync(f.file, 'utf8'), original)
    assert.deepEqual(f.runtime.repositories.snapshot(), snapshot)
    assert.deepEqual(f.runtime.repositories.automation().sessions, sessions)
    assert.equal(f.runtime.repositories.triggers.get(oversized[0]!.id), undefined)
    f.runtime.writeData('subsequent-business', { recorded: true })
    f.runtime.dispose()
    reopened = new TicketRuntime(f.directory)
    assert.deepEqual(reopened.readData('subsequent-business'), { recorded: true })
    assert.equal(reopened.get(ticket.id).mandate.scope, ticket.mandate.scope)
  } finally { reopened?.dispose(); f.close() }
})

test('serialized UTF-8, escaping and shared event references are budgeted per occurrence across sessions', () => {
  const f = fixture()
  try {
    f.runtime.repositories.mutateAutomation(data => {
      const shared = { type: 'tool.execution_complete', text: '\u0000😀"\\'.repeat(7_000), at: stamp(1) }
      data.sessions = Array.from({ length: 30 }, (_, index) => ({ ticketId: `ticket-${index}`, sessionId: `session-${index}`, status: 'idle', revisions: [1],
        transcript: Array.from({ length: 10 }, (_, event) => index === 29 && event === 9 ? { ...shared, at: stamp(299) } : shared) }))
    })
    const sessions = f.runtime.repositories.automation().sessions
    const retained = sessions.flatMap(session => session.transcript)
    assert.ok(retained.length > 0)
    assert.ok(retained.length < 300)
    assert.equal(retained.at(-1)?.at, stamp(299))
    assert.equal(sessions[0]?.transcript.length, 0)
    assert.ok(Buffer.byteLength(JSON.stringify(sessions.map(session => session.transcript))) < 3 * 1024 * 1024)
    assert.ok(statSync(f.file).size < capacity)
    assert.ok(retained.every(event => !event.text.includes('�')))
  } finally { f.close() }
})
