import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Trigger } from '../../src/core/index.ts'
import type { AgentBackend, AgentRun } from '../src/agent-backend.ts'
import { AutomationService } from '../src/orchestration.ts'
import { TicketRuntime } from '../src/runtime.ts'

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repositoryRoot = dirname(extensionRoot)
const artifactRoot = mkdtempSync(join(tmpdir(), 'superagent-generated-prompts-'))
const privateExtension = join(artifactRoot, 'vscode')
let defaults: Record<string, string>, bundledWorker: string
try {
  mkdirSync(privateExtension)
  symlinkSync(join(extensionRoot, 'src'), join(privateExtension, 'src'), 'dir')
  for (const directory of ['prompts', 'skills']) symlinkSync(join(repositoryRoot, directory), join(artifactRoot, directory), 'dir')
  copyFileSync(join(repositoryRoot, 'LICENSE'), join(artifactRoot, 'LICENSE'))
  execFileSync(process.execPath, [join(extensionRoot, 'scripts', 'build.mjs')], { cwd: privateExtension, stdio: 'pipe' })
  defaults = JSON.parse(readFileSync(join(privateExtension, 'dist', 'prompts', 'defaults.json'), 'utf8'))
  bundledWorker = readFileSync(join(privateExtension, 'dist', 'prompts', 'worker.md'), 'utf8')
} catch (error) { rmSync(artifactRoot, { recursive: true, force: true }); throw error }
after(() => rmSync(artifactRoot, { recursive: true, force: true }))
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check()) { if (Date.now() > deadline) assert.fail('Prompt integration did not settle'); await new Promise(resolve => setTimeout(resolve, 5)) }
}
function fixture(parts = true) {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-prompt-runtime-'))
  const runtime = new TicketRuntime(directory), runs: AgentRun[] = [], assessments: string[] = []
  const backend: AgentBackend = {
    assess: async prompt => { assessments.push(prompt); return { kind: 'accept', title: 'Repair the requested defect', scope: 'Implement the authorized repair', reason: 'Explicit request' } },
    run: async request => {
      runs.push(request)
      await request.tools.find(tool => tool.name === 'superagent_report')!.invoke({ state: 'ready', summary: 'Repair verified' })
    },
    abort: async () => {}, dispose: async () => {},
  }
  const service = new AutomationService(runtime, { backend, systemPrompt: bundledWorker, ...(parts ? { promptParts: defaults } : {}),
    prepare: async () => directory, poll: async () => [], send: async () => {} })
  service.saveSettings({ enabled: true, sources: { github: { enabled: true, allowedActors: ['owner'] } } }, 0)
  service.start()
  const settled = (count: number) => eventually(() => runs.length === count && service.snapshot().health.workers === 0)
  return { runtime, service, runs, assessments,
    async local() {
      const count = runs.length + 1, ticket = runtime.create(`Exercise generated prompt ${count}`)
      await settled(count)
      return runs.find(request => request.ticketId === ticket.id)!
    },
    async source() {
      const count = runs.length + 1
      const trigger: Trigger = { id: 'prompt-source-request', source: 'github:scope', threads: [{ source: 'github:scope', id: '1' }],
        actor: { source: 'github:scope', id: 'owner' }, human: true, addressed: 'mention', at: new Date().toISOString(),
        text: 'Please repair the authorized defect', meta: {}, channel: { source: 'github:scope', thread: 'github:scope:1',
          address: { origin: 'https://api.github.com', repository: 'owner/repo', number: '1' } } }
      runtime.engine.receive(trigger)
      await settled(count)
      return runs.at(-1)!
    },
    async close() { await service.dispose(); runtime.dispose(); rmSync(directory, { recursive: true, force: true }) },
  }
}

test('actual worker runs compose every production-generated part with runtime execution exactly once', async () => {
  const execution = defaults['runtime/execution']!
  assert.match(execution, /DSH environment variables are unavailable/)
  assert.match(execution, /original trigger provider context, immutable mandate, actual worktree and host resources/)
  for (const parts of [true, false]) {
    const f = fixture(parts)
    try {
      const request = await f.local()
      for (const [name, content] of Object.entries(defaults)) assert.equal(occurrences(request.systemPrompt, content), 1, `${parts ? 'parts with bundled fallback' : 'bundled fallback'}: ${name}`)
      assert.equal(occurrences(request.systemPrompt, execution), 1)
      assert.match(request.systemPrompt, /Native Copilot permissions and organization policies remain authoritative/)
    } finally { await f.close() }
  }
})

test('runtime execution override and snapshot restore change the actual backend worker prompt', async () => {
  const f = fixture()
  try {
    const builtin = defaults['runtime/execution']!, originalRevision = f.service.settings.revision
    const override = builtin.replace('The host has approved the ticket mandate and configured delivery policy.', 'The host recorded this session’s approved mandate and delivery policy.')
    assert.notEqual(override, builtin)
    f.service.saveSettings({ prompts: { overrides: { 'runtime/execution': { text: override } } } }, originalRevision)
    const changed = await f.local()
    assert.equal(occurrences(changed.systemPrompt, override), 1)
    assert.equal(changed.systemPrompt.includes(builtin), false)
    assert.equal(f.service.settings.value.prompts.overrides?.['runtime/execution']?.base, builtin)
    f.service.restoreSettings(originalRevision, f.service.settings.revision)
    const restored = await f.local()
    assert.equal(occurrences(restored.systemPrompt, builtin), 1)
    assert.equal(restored.systemPrompt.includes(override), false)
    assert.equal(f.service.settings.value.prompts.overrides, undefined)
  } finally { await f.close() }
})

test('actual assessment prompts retain generated scope and routing without worker execution instructions', async () => {
  const f = fixture()
  try {
    const worker = await f.source()
    assert.equal(f.assessments.length, 1)
    const assessor = f.assessments[0]!
    assert.match(assessor, /You assess and route requests/)
    assert.match(assessor, /Never execute repository work/)
    assert.equal(occurrences(assessor, defaults['team/scope']!), 1)
    assert.equal(assessor.includes(defaults['role/worker']!), false)
    assert.equal(assessor.includes(defaults['runtime/execution']!), false)
    assert.equal(assessor.includes(defaults['skill/github']!), false)
    assert.equal(occurrences(worker.systemPrompt, defaults['runtime/execution']!), 1)
  } finally { await f.close() }
})
