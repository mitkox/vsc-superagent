import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { panelContent } from '../src/panel-content.ts'

class Element {
  id = ''; value = ''; textContent = ''; className = ''; disabled = false
  dataset: Record<string, string> = {}; children: Element[] = []
  onclick?: () => unknown; oninput?: () => unknown
  classList = { toggle() {} }
  constructor(readonly tag: string) {}
  append(...children: Element[]) { this.children.push(...children) }
  replaceChildren(...children: Element[]) { this.children = children }
  setAttribute() {}
}
function webview() {
  const content = new Element('main'); content.id = 'content'
  const notice = new Element('div'); notice.id = 'notice'
  const search = new Element('input'); search.id = 'search'
  const tabs = ['Overview', 'Sources', 'Triggers', 'Eval', 'Execution', 'Settings'].map(name => {
    const el = new Element('button'); el.dataset.tab = name; return el
  })
  const roots = [content, notice, search, ...tabs]
  const elements = (): Element[] => {
    const visit = (el: Element): Element[] => [el, ...el.children.flatMap(visit)]
    return roots.flatMap(visit)
  }
  const sent: Record<string, any>[] = []
  let receive!: (event: { data: unknown }) => void
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(panelContent('executed-test'))![1]!
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => sent.push(structuredClone(message) as Record<string, any>) }),
    document: { getElementById: (id: string) => elements().find(el => el.id === id), createElement: (tag: string) => new Element(tag),
      querySelectorAll: (selector: string) => selector === '[data-tab]' ? tabs : [] },
    window: { addEventListener: (_type: string, listener: typeof receive) => { receive = listener } },
  })
  const editor = () => elements().find(el => el.id === 'settings')!
  const control = (label: string) => elements().find(el => el.tag === 'button' && el.textContent === label)!
  return { sent, editor, control, notice,
    receive: (message: unknown) => receive({ data: structuredClone(message) }),
    tab: (name: string) => tabs.find(el => el.dataset.tab === name)!.onclick!(),
    click: (label: string) => { const el = control(label); assert.ok(el, label); if (!el.disabled) el.onclick!() },
    edit: (text: string) => { const el = editor(); assert.equal(el.disabled, false); el.value = text; el.oninput!() },
    search: (text: string) => { search.value = text; search.oninput!() },
  }
}
const value = (members: string[]) => ({ sources: { teams: { allowedActors: members } } })
const state = (revision: number, members: string[]) => ({ type: 'state', value: { settings: { revision, value: value(members) },
  history: [{ revision: 1, value: value(['old-member']) }] } })
const ack = (request: Record<string, any>, revision: number, members: string[]) => ({ type: 'settingsResult', requestId: request.requestId,
  action: request.action, settings: { revision, value: value(members) } })

test('executed settings draft retains its original revision after unrelated native settings changes', () => {
  const f = webview(); f.receive(state(1, ['removed-member'])); f.tab('Settings')
  const draft = JSON.stringify(value(['removed-member', 'draft-member']), null, 2)
  f.edit(draft); f.receive(state(2, [])); f.click('Save settings')
  const request = f.sent.at(-1)!
  assert.equal(request.action, 'saveSettings'); assert.equal(request.revision, 1)
  assert.deepEqual(request.value, JSON.parse(draft)); assert.equal(typeof request.requestId, 'string')
  assert.equal(f.editor().value, draft); assert.equal(f.editor().disabled, true)
  f.receive(state(3, ['latest-member']))
  assert.equal(f.editor().value, draft); assert.equal(f.editor().disabled, true)
  f.receive({ type: 'notice', requestId: request.requestId, action: request.action, text: 'Settings revision conflict' })
  assert.equal(f.editor().disabled, false); assert.equal(f.editor().value, draft)
  f.click('Save settings'); assert.equal(f.sent.at(-1)!.revision, 1)
})

test('executed drafts survive tabs, search, renders and invalid JSON without rebasing', () => {
  const f = webview(); f.receive(state(1, ['original'])); f.tab('Settings'); f.edit('{ invalid draft')
  f.tab('Overview'); f.receive(state(2, ['new'])); f.tab('Settings'); f.search('anything')
  assert.equal(f.editor().value, '{ invalid draft')
  const before = f.sent.length; f.click('Save settings')
  assert.equal(f.sent.length, before); assert.match(f.notice.textContent, /valid JSON/)
  assert.equal(f.editor().value, '{ invalid draft')
  f.edit(JSON.stringify(value(['corrected']))); f.click('Save settings')
  assert.equal(f.sent.at(-1)!.revision, 1)
})

test('explicit reload uses current settings and only a correlated native acknowledgement rebases a save', () => {
  const f = webview(); f.receive(state(1, ['old'])); f.tab('Settings'); f.edit(JSON.stringify(value(['draft'])))
  f.receive(state(2, ['current'])); f.click('Reload current settings')
  assert.deepEqual(JSON.parse(f.editor().value), value(['current']))
  f.click('Save settings'); const first = f.sent.at(-1)!
  assert.equal(first.revision, 2)
  assert.equal(f.control('Reload current settings').disabled, true)
  assert.throws(() => f.edit('{}'))
  f.click('Save settings'); assert.equal(f.sent.at(-1), first)
  f.receive(ack({ ...first, requestId: 'another-request' }, 3, ['unrelated']))
  f.receive({ type: 'notice', text: 'Unrelated action failed' })
  f.receive(state(4, ['membership-sync']))
  assert.equal(f.editor().disabled, true)
  f.receive(ack(first, 4, ['wrong-revision']))
  assert.equal(f.editor().disabled, true)
  f.receive(ack(first, 3, ['confirmed']))
  assert.equal(f.editor().disabled, false)
  assert.deepEqual(JSON.parse(f.editor().value), value(['confirmed']))
  f.edit(JSON.stringify(value(['next-draft']))); f.click('Save settings'); const second = f.sent.at(-1)!
  assert.equal(second.revision, 3)
  f.receive(ack(first, 3, ['old-confirmation']))
  f.receive({ type: 'notice', requestId: first.requestId, action: first.action, text: 'Stale request failed' })
  assert.notEqual(f.notice.textContent, 'Stale request failed')
  assert.equal(f.editor().disabled, true)
  assert.deepEqual(JSON.parse(f.editor().value), value(['next-draft']))
  f.receive({ type: 'notice', requestId: second.requestId, action: second.action, text: 'Conflict' })
  f.click('Save settings'); assert.equal(f.sent.at(-1)!.revision, 3)
})

test('restore retains a dirty base on error and adopts only its confirmed restored settings', () => {
  const f = webview(); f.receive(state(1, ['old'])); f.tab('Settings')
  const draft = JSON.stringify(value(['draft'])); f.edit(draft); f.receive(state(2, ['current']))
  f.click('Restore this revision'); const failed = f.sent.at(-1)!
  assert.equal(failed.action, 'restoreSettings'); assert.equal(failed.baseRevision, 1)
  f.receive(state(3, ['later']))
  f.receive({ type: 'notice', requestId: failed.requestId, action: failed.action, text: 'Restore conflict' })
  assert.equal(f.editor().value, draft)
  f.click('Save settings'); const save = f.sent.at(-1)!
  assert.equal(save.revision, 1)
  f.receive({ type: 'notice', requestId: save.requestId, action: save.action, text: 'Still conflicting' })
  f.click('Reload current settings'); f.click('Restore this revision'); const restored = f.sent.at(-1)!
  assert.equal(restored.baseRevision, 3)
  f.receive(state(5, ['native-change-after-restore']))
  f.receive(ack(restored, 4, ['restored']))
  assert.deepEqual(JSON.parse(f.editor().value), value(['restored']))
  assert.equal(f.editor().disabled, false)
  f.click('Save settings'); assert.equal(f.sent.at(-1)!.revision, 4)
})

test('fresh snapshots update clean editors while older snapshots never undo a newer acknowledgement', () => {
  const f = webview(); f.receive(state(1, ['first'])); f.tab('Settings'); f.receive(state(2, ['second']))
  assert.deepEqual(JSON.parse(f.editor().value), value(['second']))
  f.click('Save settings'); const saved = f.sent.at(-1)!
  assert.equal(saved.revision, 2)
  f.receive(ack(saved, 3, ['confirmed']))
  f.receive(state(1, ['obsolete'])); f.receive(state(2, ['also-obsolete']))
  assert.deepEqual(JSON.parse(f.editor().value), value(['confirmed']))
  f.click('Save settings'); assert.equal(f.sent.at(-1)!.revision, 3)
})

test('failed unedited saves retain their submitted text and base through later fresh snapshots', () => {
  const f = webview(); f.receive(state(1, ['original'])); f.tab('Settings'); f.click('Save settings')
  const request = f.sent.at(-1)!
  f.receive({ type: 'notice', requestId: request.requestId, action: request.action, text: 'Conflict' })
  f.receive(state(2, ['membership-removed']))
  assert.deepEqual(JSON.parse(f.editor().value), value(['original']))
  f.click('Save settings'); assert.equal(f.sent.at(-1)!.revision, 1)
})
