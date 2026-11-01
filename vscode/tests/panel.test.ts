import assert from 'node:assert/strict'
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
