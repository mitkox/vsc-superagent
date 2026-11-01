import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import type { PanelHost, SettingsActionResult } from '../src/panel.ts'
import { test } from 'node:test'
import { panelContent } from '../src/panel-content.ts'

test('supervision panel isolates scripts and never interpolates untrusted ticket content as HTML', () => {
  const html = panelContent('test-nonce')
  assert.match(html, /default-src 'none'/)
  assert.match(html, /script-src 'nonce-test-nonce'/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.match(html, /textContent/)
  assert.doesNotMatch(html, /innerHTML|eval\(|new Function/)
  for (const tab of ['Overview', 'Sources', 'Triggers', 'Eval', 'Execution', 'Settings']) assert.ok(html.includes(tab))
})

const requireModule = createRequire(import.meta.url)
const nativeCode = buildSync({ entryPoints: ['src/panel.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], write: false }).outputFiles[0]!.text
function nativePanel(host: PanelHost) {
  const posted: Record<string, any>[] = []
  let receive!: (message: unknown) => Promise<void>
  const panel = { webview: { html: '', onDidReceiveMessage: (callback: typeof receive) => { receive = callback },
    postMessage: async (message: unknown) => { posted.push(structuredClone(message) as Record<string, any>); return true } },
    onDidDispose() {}, reveal() {}, dispose() {} }
  const module = { exports: {} as { SuperagentPanel: new (host: PanelHost) => { show(): void } } }
  runInNewContext(nativeCode, { module, exports: module.exports, require: (name: string) => name === 'vscode'
    ? { window: { createWebviewPanel: () => panel }, ViewColumn: { One: 1 } } : requireModule(name) })
  new module.exports.SuperagentPanel(host).show()
  return { posted, receive: (message: unknown) => receive(message) }
}

test('native panel acknowledges the exact action result rather than a newer generic snapshot', async () => {
  let revision = 1
  const f = nativePanel({ snapshot: () => ({ settings: { revision, value: { member: 'latest' } } }), action: async () => {
    const saved: SettingsActionResult = { type: 'settings', action: 'saveSettings', settings: { revision: 2, value: { member: 'saved' } } }
    revision = 3
    return saved
  } })
  await f.receive({ action: 'saveSettings', requestId: 'settings-1', revision: 1 })
  const result = f.posted.find(message => message.type === 'settingsResult')!
  assert.equal(result.requestId, 'settings-1'); assert.equal(result.action, 'saveSettings')
  assert.deepEqual(result.settings, { revision: 2, value: { member: 'saved' } })
  assert.equal(f.posted.find(message => message.type === 'state')!.value.settings.revision, 3)
})

test('native errors carry correlation while generic refreshes cannot acknowledge settings success', async () => {
  const f = nativePanel({ snapshot: () => ({ settings: { revision: 9, value: {} } }), action: async input => {
    if (input.action === 'restoreSettings') throw new Error('Conflict')
  } })
  await f.receive({ action: 'saveSettings', requestId: 'settings-1', revision: 1 })
  assert.equal(f.posted.some(message => message.type === 'settingsResult'), false)
  assert.equal(f.posted.at(-1)!.type, 'state')
  await f.receive({ action: 'restoreSettings', requestId: 'settings-2', revision: 1, baseRevision: 1 })
  assert.equal(f.posted.at(-1)!.type, 'notice')
  assert.equal(f.posted.at(-1)!.requestId, 'settings-2')
  assert.equal(f.posted.at(-1)!.action, 'restoreSettings')
})
