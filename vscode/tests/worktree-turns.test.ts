import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Ticket } from '../../src/core/index.ts'
import type { AgentBackend, AgentRun } from '../src/agent-backend.ts'
import { AutomationService } from '../src/orchestration.ts'
import { TicketRuntime } from '../src/runtime.ts'
import { Worktrees } from '../src/worktree.ts'

const git = (directory: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function repository(directory: string) {
  mkdirSync(directory, { recursive: true })
  git(directory, 'init', '-q'); git(directory, 'config', 'user.name', 'Test'); git(directory, 'config', 'user.email', 'test@example.invalid')
  writeFileSync(join(directory, 'tracked.txt'), 'committed content\n')
  git(directory, 'add', '.'); git(directory, 'commit', '-qm', 'initial')
}
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) { if (Date.now() > deadline) assert.fail('Worktree delivery did not settle'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
const batch = (request: AgentRun) => JSON.parse(request.prompt.split('\n').find(line => line.startsWith('New inputs: '))!.slice('New inputs: '.length)) as { id: string }[]
function fixture(options: { root?: string; failSecondTurn?: boolean; redirectValidation?: boolean } = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'superagent-worktree-turns-')), source = join(root, 'repository')
  if (!existsSync(source)) { repository(source); writeFileSync(join(source, 'tracked.txt'), 'primary operator changes\n') }
  const runtime = new TicketRuntime(join(root, 'state')), trees = new Worktrees('/usr/bin/git', source, join(root, 'worktrees'))
  const runs: AgentRun[] = []; let preparations = 0
  const prepare = async (ticket: Ticket, saved?: string) => {
    preparations++
    const directory = saved === undefined ? await trees.prepare(ticket.id) : await trees.validate(ticket.id, saved)
    return options.redirectValidation && saved !== undefined ? source : directory
  }
  const backend: AgentBackend = {
    assess: async () => ({ kind: 'ignore', reason: 'Native follow-up belongs to the existing ticket' }),
    run: async request => {
      runs.push(request)
      // Keep the report checkpoint later than delivery so restart retains the same assignment.
      await new Promise(resolve => setTimeout(resolve, 5))
      await request.tools.find(tool => tool.name === 'orchestrator_report')!.invoke({ state: 'waiting', summary: 'Waiting for a follow-up' })
      if (options.failSecondTurn && runs.length === 2) throw new Error('Interrupted after the durable report checkpoint')
    }, abort: async () => {}, dispose: async () => {},
  }
  const service = new AutomationService(runtime, { backend, prepare, poll: async () => [], send: async () => {} })
  if (!service.settings.revision) service.saveSettings({ enabled: true, execution: { retryBaseMs: 100_000 }, pollIntervalMs: 3_600_000 }, 0)
  const effects = () => service.snapshot().effects.filter(effect => effect.kind === 'start' || effect.kind === 'deliver')
  const settled = () => service.snapshot().health.workers === 0 && effects().every(effect => ['completed', 'cancelled'].includes(effect.status))
  return { root, source, runtime, service, runs, effects, settled, get preparations() { return preparations },
    async close(preserve = false) { await service.dispose(); runtime.dispose(); if (!preserve) rmSync(root, { recursive: true, force: true }) },
  }
}
const input = (runtime: TicketRuntime, ticketId: string, text: string) => runtime.get(ticketId).inputs.find(input => input.kind === 'trigger'
  && runtime.repositories.triggers.get(input.triggerId)?.text === text)!.id

for (const mismatch of ['branch', 'detached', 'foreign-repository'] as const) {
  test(`real Git ${mismatch} mismatch blocks a cached turn without changing operator files or pending inputs`, async () => {
    const f = fixture()
    try {
      const ticket = f.runtime.create('Authorized repair'); f.service.start()
      await eventually(() => f.runs.length === 1 && f.settled())
      f.runtime.followup(ticket.id, 'Valid continuation')
      await eventually(() => f.runs.length === 2 && f.settled())
      const directory = f.runs[0]!.directory, sessionId = f.runs[0]!.sessionId
      assert.equal(f.runs[1]!.sessionId, sessionId)
      assert.equal(git(directory, 'branch', '--show-current'), `superagent/${ticket.id}`)
      writeFileSync(join(directory, 'tracked.txt'), 'operator worktree changes\n')
      writeFileSync(join(directory, 'untracked.txt'), 'operator untracked changes\n')
      if (mismatch === 'branch') git(directory, 'switch', '-c', 'unrelated-human-work')
      else if (mismatch === 'detached') git(directory, 'switch', '--detach')
      else {
        const foreign = join(f.root, 'foreign'); repository(foreign)
        git(foreign, 'branch', '-m', `superagent/${ticket.id}`)
        writeFileSync(join(directory, '.git'), `gitdir: ${join(foreign, '.git')}\n`)
      }
      const branch = git(directory, 'branch', '--show-current'), pointer = readFileSync(join(directory, '.git'), 'utf8')
      f.runtime.followup(ticket.id, 'Blocked new input')
      const id = input(f.runtime, ticket.id, 'Blocked new input')
      await eventually(() => f.runs.length > 2 || f.effects().some(effect => effect.inputIds?.includes(id) && effect.attempts > 0 && effect.status === 'pending') && f.service.snapshot().health.workers === 0)
      assert.equal(f.runs.length, 2, 'A mismatching Git checkout must never reach the backend')
      const retained = f.effects().find(effect => effect.inputIds?.includes(id))!
      assert.equal(retained.inputIdsSelected, undefined)
      assert.ok(f.runtime.get(ticket.id).undelivered.includes(id))
      assert.equal(f.preparations, 3)
      assert.equal(git(directory, 'branch', '--show-current'), branch)
      assert.equal(readFileSync(join(directory, '.git'), 'utf8'), pointer)
      assert.equal(readFileSync(join(directory, 'tracked.txt'), 'utf8'), 'operator worktree changes\n')
      assert.equal(readFileSync(join(directory, 'untracked.txt'), 'utf8'), 'operator untracked changes\n')
      assert.equal(readFileSync(join(f.source, 'tracked.txt'), 'utf8'), 'primary operator changes\n')
      assert.equal(f.runtime.repositories.automation().sessions[0]!.sessionId, sessionId)
      assert.equal(f.runtime.repositories.automation().sessions[0]!.directory, directory)
    } finally { await f.close() }
  })
}

test('a moved saved worktree is refused without creating a replacement at the old path', async () => {
  const f = fixture()
  try {
    const ticket = f.runtime.create('Keep the saved worktree'); f.service.start()
    await eventually(() => f.runs.length === 1 && f.settled())
    const directory = f.runs[0]!.directory, moved = `${directory}-operator-moved`
    writeFileSync(join(directory, 'operator.txt'), 'preserve the moved files')
    renameSync(directory, moved)
    f.runtime.followup(ticket.id, 'Input after move')
    const id = input(f.runtime, ticket.id, 'Input after move')
    await eventually(() => f.runs.length > 1 || f.effects().some(effect => effect.inputIds?.includes(id) && effect.attempts > 0 && effect.status === 'pending') && f.service.snapshot().health.workers === 0)
    assert.equal(f.runs.length, 1)
    assert.equal(existsSync(directory), false)
    assert.equal(readFileSync(join(moved, 'operator.txt'), 'utf8'), 'preserve the moved files')
    assert.ok(f.runtime.get(ticket.id).undelivered.includes(id))
    assert.equal(f.runtime.repositories.automation().sessions[0]!.directory, directory)
  } finally { await f.close() }
})

test('a revalidator cannot silently move a persistent session to a different directory', async () => {
  const f = fixture({ redirectValidation: true })
  try {
    const ticket = f.runtime.create('Stay in the saved directory'); f.service.start()
    await eventually(() => f.runs.length === 1 && f.settled())
    const session = f.runtime.repositories.automation().sessions[0]!
    f.runtime.followup(ticket.id, 'Second turn')
    const id = input(f.runtime, ticket.id, 'Second turn')
    await eventually(() => f.runs.length > 1 || f.effects().some(effect => effect.inputIds?.includes(id) && effect.attempts > 0 && effect.status === 'pending') && f.service.snapshot().health.workers === 0)
    assert.equal(f.runs.length, 1)
    assert.equal(f.runtime.repositories.automation().sessions[0]!.directory, session.directory)
    assert.equal(f.runtime.repositories.automation().sessions[0]!.sessionId, session.sessionId)
    assert.ok(f.runtime.get(ticket.id).undelivered.includes(id))
  } finally { await f.close() }
})

test('reopened selected retries revalidate Git before reusing the persistent session and exact input batch', async () => {
  let current: ReturnType<typeof fixture> | undefined = fixture({ failSecondTurn: true })
  const root = current.root
  try {
    const f = current, ticket = f.runtime.create('Recover the same session safely'); f.service.start()
    await eventually(() => f.runs.length === 1 && f.settled())
    f.runtime.followup(ticket.id, 'Retained batch')
    const id = input(f.runtime, ticket.id, 'Retained batch')
    await eventually(() => f.runs.length === 2 && f.effects().some(effect => effect.inputIdsSelected && effect.inputIds?.includes(id) && effect.status === 'pending') && f.service.snapshot().health.workers === 0)
    const selected = f.effects().find(effect => effect.inputIds?.includes(id))!, sessionId = f.runs[0]!.sessionId, directory = f.runs[0]!.directory
    await f.service.stop()
    git(directory, 'switch', '-c', 'operator-recovery-branch')
    f.runtime.repositories.mutateAutomation(data => { data.effects.find(effect => effect.id === selected.id)!.nextAttemptAt = 0 })
    await f.close(true); current = undefined
    current = fixture({ root }); const next = current
    next.service.start()
    await eventually(() => next.runs.length > 0 || next.effects().some(effect => effect.id === selected.id && effect.attempts >= 2 && effect.status === 'pending') && next.service.snapshot().health.workers === 0)
    assert.equal(next.runs.length, 0)
    const retained = next.effects().find(effect => effect.id === selected.id)!
    assert.deepEqual(retained.inputIds, [id]); assert.equal(retained.inputIdsSelected, true)
    assert.equal(next.runtime.repositories.automation().sessions[0]!.sessionId, sessionId)
    assert.equal(git(directory, 'branch', '--show-current'), 'operator-recovery-branch')
    // A person repairs the checkout; the service itself never switches or resets it.
    git(directory, 'switch', `superagent/${ticket.id}`)
    next.runtime.repositories.mutateAutomation(data => { data.effects.find(effect => effect.id === selected.id)!.nextAttemptAt = 0 })
    await eventually(() => next.runs.length === 1 && next.settled())
    assert.deepEqual(batch(next.runs[0]!).map(input => input.id), [id])
    assert.equal(next.runs[0]!.sessionId, sessionId)
    assert.equal(next.runs[0]!.directory, directory)
  } finally { if (current) await current.close(); else rmSync(root, { recursive: true, force: true }) }
})
