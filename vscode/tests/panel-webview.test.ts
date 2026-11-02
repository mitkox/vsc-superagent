import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { panelContent } from '../src/panel-content.ts'

type DomEvent = { type: string; target?: Element; currentTarget?: Element; bubbles?: boolean; [key: string]: unknown }
type Listener = (event: DomEvent) => unknown
const dataName = (name: string) => name.replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase())
class Element {
  id = ''; className = ''; disabled = false; hidden = false; open = false
  dataset: Record<string, string> = {}; style: Record<string, string> = {}; children: Element[] = []
  parentElement: Element | null = null
  scrollTop = 0; scrollLeft = 0; selectionStart = 0; selectionEnd = 0; selectionDirection = 'none'
  lastFocusOptions?: { preventScroll?: boolean }
  onclick?: Listener; oninput?: Listener; onblur?: Listener; onfocus?: Listener
  oncompositionstart?: Listener; oncompositionend?: Listener; oncompositionupdate?: Listener
  private ownText = ''; private textValue = ''; private attributes = new Map<string, string>()
  private listeners = new Map<string, Set<Listener>>()
  classList = { toggle: (name: string, force?: boolean) => {
    const classes = new Set(this.className.split(/\s+/).filter(Boolean)), enabled = force ?? !classes.has(name)
    if (enabled) classes.add(name); else classes.delete(name)
    this.className = [...classes].join(' '); return enabled
  } }
  constructor(readonly tag: string, readonly ownerDocument: Dom) {}
  get tagName() { return this.tag.toUpperCase() }
  get nodeName() { return this.tagName }
  get parentNode() { return this.parentElement }
  get childNodes() { return this.children }
  get isConnected(): boolean { return this === this.ownerDocument.documentElement || !!this.parentElement?.isConnected }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join('') }
  set textContent(value: string) { this.replaceChildren(); this.ownText = value }
  get value() { return this.textValue }
  set value(value: string) {
    if (value !== this.textValue) { this.textValue = value; this.selectionStart = this.selectionEnd = value.length; this.selectionDirection = 'none' }
  }
  contains(other: Element | null): boolean { return this === other || this.children.some(child => child.contains(other)) }
  append(...children: Element[]) {
    for (const child of children) {
      if (child.tag === '#fragment') { this.append(...child.children.slice()); continue }
      child.remove(); child.parentElement = this; this.children.push(child)
    }
  }
  appendChild(child: Element) { this.append(child); return child }
  prepend(...children: Element[]) { for (const child of [...children].reverse()) this.insertBefore(child, this.children[0] ?? null) }
  removeChild(child: Element) {
    const index = this.children.indexOf(child); assert.notEqual(index, -1)
    this.children.splice(index, 1); child.parentElement = null
    if (child.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body
    return child
  }
  remove() { this.parentElement?.removeChild(this) }
  insertBefore(child: Element, before: Element | null) {
    if (before === null) { this.append(child); return child }
    child.remove(); const index = this.children.indexOf(before); assert.notEqual(index, -1)
    child.parentElement = this; this.children.splice(index, 0, child); return child
  }
  replaceChildren(...children: Element[]) {
    for (const child of this.children.slice()) this.removeChild(child)
    this.ownText = ''; this.append(...children)
  }
  setAttribute(name: string, value: string) {
    if (name === 'id') this.id = value
    else if (name === 'class') this.className = value
    else if (name.startsWith('data-')) this.dataset[dataName(name.slice(5))] = value
    else this.attributes.set(name, String(value))
  }
  getAttribute(name: string): string | null {
    if (name === 'id') return this.id || null
    if (name === 'class') return this.className || null
    if (name.startsWith('data-')) return this.dataset[dataName(name.slice(5))] ?? null
    return this.attributes.get(name) ?? null
  }
  hasAttribute(name: string) { return this.getAttribute(name) !== null }
  removeAttribute(name: string) { if (name.startsWith('data-')) delete this.dataset[dataName(name.slice(5))]; else this.attributes.delete(name) }
  addEventListener(type: string, listener: Listener) { const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners) }
  removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener) }
  dispatchEvent(event: DomEvent) {
    const current = { ...event, target: event.target ?? this, currentTarget: this, preventDefault() {}, stopPropagation() {} }
    const property = (this as unknown as Record<string, unknown>)[`on${event.type}`]
    if (typeof property === 'function') property.call(this, current)
    for (const listener of this.listeners.get(event.type) ?? []) listener(current)
    if (event.bubbles) this.parentElement?.dispatchEvent({ ...current, currentTarget: undefined })
    return true
  }
  focus(options?: { preventScroll?: boolean }) {
    this.lastFocusOptions = options
    if (!this.isConnected || this.disabled || this.ownerDocument.activeElement === this) return
    const previous = this.ownerDocument.activeElement
    this.ownerDocument.activeElement = this
    if (previous && previous !== this.ownerDocument.body) previous.dispatchEvent({ type: 'blur', relatedTarget: this })
    this.dispatchEvent({ type: 'focus', relatedTarget: previous })
  }
  blur() {
    if (this.ownerDocument.activeElement !== this) return
    this.ownerDocument.activeElement = this.ownerDocument.body; this.dispatchEvent({ type: 'blur', relatedTarget: null })
  }
  setSelectionRange(start: number, end: number, direction = 'none') {
    this.selectionStart = Math.min(start, this.value.length); this.selectionEnd = Math.min(end, this.value.length); this.selectionDirection = direction
  }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]).filter(el => selector.split(',').some(part => el.matches(part.trim()))) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
  descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]) }
  matches(selector: string) {
    const match = /^(?:([a-z][a-z0-9-]*)|#([a-zA-Z0-9_-]+))?(?:\[([^=\]]+)(?:=["']([^"']*)["'])?\])?$/.exec(selector)
    if (!match) throw new Error(`Unsupported fixture selector: ${selector}`)
    return (!match[1] || this.tag === match[1]) && (!match[2] || this.id === match[2])
      && (!match[3] || (match[4] === undefined ? this.hasAttribute(match[3]) : this.getAttribute(match[3]) === match[4]))
  }
}
class Dom {
  documentElement = new Element('html', this); body = new Element('body', this)
  activeElement: Element | null = this.body
  constructor() { this.documentElement.append(this.body) }
  createElement(tag: string) { return new Element(tag, this) }
  createDocumentFragment() { return new Element('#fragment', this) }
  getElementById(id: string) { return this.documentElement.descendants().find(el => el.id === id) ?? null }
  querySelectorAll(selector: string) { return this.documentElement.querySelectorAll(selector) }
  querySelector(selector: string) { return this.documentElement.querySelector(selector) }
}
function webview() {
  const document = new Dom(), content = document.createElement('main'); content.id = 'content'
  const notice = document.createElement('div'); notice.id = 'notice'
  const search = document.createElement('input'); search.id = 'search'
  const tabs = ['Overview', 'Sources', 'Triggers', 'Eval', 'Execution', 'Settings'].map(name => {
    const el = document.createElement('button'); el.dataset.tab = name; return el
  })
  document.body.append(content, notice, search, ...tabs)
  const elements = () => document.documentElement.descendants()
  const sent: Record<string, any>[] = [], windowListeners = new Map<string, Set<(event: any) => void>>()
  const window = { scrollX: 0, scrollY: 0,
    scrollTo(x: number | { left?: number; top?: number }, y?: number) { if (typeof x === 'number') { this.scrollX = x; this.scrollY = y ?? 0 } else { this.scrollX = x.left ?? this.scrollX; this.scrollY = x.top ?? this.scrollY } },
    addEventListener(type: string, listener: (event: any) => void) { const listeners = windowListeners.get(type) ?? new Set(); listeners.add(listener); windowListeners.set(type, listeners) },
  }
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(panelContent('executed-test'))![1]!
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => sent.push(structuredClone(message) as Record<string, any>) }),
    document, window,
  })
  const editor = () => document.getElementById('settings')!
  const visible = (el: Element): boolean => !el.hidden && el.style.display !== 'none' && (!el.parentElement || visible(el.parentElement))
  const controls = (label: string) => elements().filter(el => el.tag === 'button' && el.textContent === label && visible(el))
  const control = (label: string) => controls(label)[0]!
  const fire = (el: Element, type: string, fields: Record<string, unknown> = {}) => el.dispatchEvent({ type, ...fields })
  return { sent, editor, control, controls, notice, document, window, elements, fire,
    receive: (message: unknown) => { for (const listener of windowListeners.get('message') ?? []) listener({ data: structuredClone(message) }) },
    tab: (name: string) => { const el = tabs.find(el => el.dataset.tab === name)!; el.focus({ preventScroll: true }); fire(el, 'click') },
    click: (label: string) => { const el = control(label); assert.ok(el, label); if (!el.disabled) { el.focus({ preventScroll: true }); if (el.isConnected && visible(el) && !el.disabled) fire(el, 'click') } },
    edit: (text: string) => { const el = editor(); assert.equal(el.disabled, false); el.focus({ preventScroll: true }); el.value = text; fire(el, 'input', { inputType: 'insertText', isComposing: false }) },
    search: (text: string) => { search.focus({ preventScroll: true }); search.value = text; fire(search, 'input') },
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


const liveState = (revision: number, members: string[], extra: Record<string, unknown> = {}) => ({ ...state(revision, members),
  value: { ...state(revision, members).value, ...extra } })
const selection = (el: Element) => [el.selectionStart, el.selectionEnd, el.selectionDirection]

test('periodic native snapshots preserve the connected focused editor selection and scroll during typing', () => {
  const f = webview(); f.receive(state(1, ['original'])); f.tab('Settings')
  const text = JSON.stringify(value(['draft-' + 'x'.repeat(1000)]), null, 2)
  f.edit(text)
  const editor = f.editor(); editor.setSelectionRange(13, 37, 'backward'); editor.scrollTop = 213; editor.scrollLeft = 17
  f.window.scrollTo(5, 730)
  for (let tick = 0; tick < 3; tick++) {
    f.receive(liveState(2, ['native-change'], { health: { poll: tick } }))
    assert.equal(f.editor(), editor); assert.equal(editor.isConnected, true); assert.equal(f.document.activeElement, editor)
    assert.deepEqual(selection(editor), [13, 37, 'backward']); assert.equal(editor.scrollTop, 213); assert.equal(editor.scrollLeft, 17)
    assert.equal(f.window.scrollY, 730); assert.equal(f.window.scrollX, 5); assert.equal(editor.value, text)
  }
  editor.value = JSON.stringify(value(['typed-after-refresh'])); editor.setSelectionRange(20, 20)
  f.fire(editor, 'input', { inputType: 'insertText', isComposing: false })
  f.receive({ type: 'notice', text: 'Source status remains live' })
  assert.equal(f.notice.textContent, 'Source status remains live')
  f.click('Save settings'); assert.equal(f.sent.at(-1)!.revision, 1)
  assert.deepEqual(f.sent.at(-1)!.value, value(['typed-after-refresh']))
})

test('persistent settings controls apply clean remote values and correlated save results without stale mount closures', () => {
  const f = webview(); f.receive(state(1, ['first'])); f.tab('Settings')
  const editor = f.editor(); editor.focus({ preventScroll: true }); editor.setSelectionRange(5, 14, 'forward'); editor.scrollTop = 81
  f.receive(state(2, ['second']))
  assert.equal(f.editor(), editor); assert.equal(f.document.activeElement, editor)
  assert.deepEqual(JSON.parse(editor.value), value(['second'])); assert.deepEqual(selection(editor), [5, 14, 'forward'])
  assert.equal(editor.scrollTop, 81)
  f.edit(JSON.stringify(value(['dirty']))); f.receive(state(3, ['latest']))
  f.click('Save settings'); const failed = f.sent.at(-1)!
  assert.equal(failed.revision, 2); assert.equal(f.editor(), editor); assert.equal(editor.disabled, true)
  f.receive({ type: 'notice', requestId: failed.requestId, action: failed.action, text: 'Settings conflict' })
  assert.equal(f.editor(), editor); assert.equal(editor.disabled, false); assert.deepEqual(JSON.parse(editor.value), value(['dirty']))
  f.click('Reload current settings'); assert.equal(f.editor(), editor)
  assert.deepEqual(JSON.parse(editor.value), value(['latest']))
  f.click('Save settings'); const saved = f.sent.at(-1)!; assert.equal(saved.revision, 3)
  f.receive(ack(saved, 4, ['confirmed'])); assert.equal(f.editor(), editor)
  assert.deepEqual(JSON.parse(editor.value), value(['confirmed']))
  f.click('Save settings'); assert.equal(f.sent.at(-1)!.revision, 4)
})

function executionState(order: string[], updated = false) {
  return liveState(1, ['member'], {
    tickets: order.map(id => ({ id, title: 'Ticket ' + id, assignments: [{ report: { state: 'waiting', summary: 'Waiting ' + id } }] })),
    sessions: order.map(id => ({ ticketId: id, transcript: updated && id === 'a' ? ['Earlier line', 'New visible transcript line'] : ['Earlier line'] })),
  })
}
function card(f: ReturnType<typeof webview>, title: string) {
  const found = f.elements().find(el => el.tag === 'article' && el.querySelector('h2')?.textContent === title)
  assert.ok(found, title); return found
}
function detail(el: Element, label: string) {
  const found = el.querySelectorAll('details').find(item => item.querySelector('summary')?.textContent === label)
  assert.ok(found, label); return found
}

test('expanded transcripts keep semantic focus and scroll through live text changes and ticket reordering', () => {
  const f = webview(); f.receive(executionState(['a', 'b'])); f.tab('Execution')
  const original = detail(card(f, 'Ticket a'), 'Copilot session and transcript')
  original.open = true; original.querySelector('pre')!.scrollTop = 144; original.querySelector('pre')!.scrollLeft = 9
  const button = card(f, 'Ticket a').querySelectorAll('button').find(el => el.textContent === 'Open worktree')!
  button.focus({ preventScroll: true }); const key = button.dataset.controlKey
  f.window.scrollTo(3, 620)
  f.receive(executionState(['b', 'a'], true))
  const current = detail(card(f, 'Ticket a'), 'Copilot session and transcript'), transcript = current.querySelector('pre')!
  assert.equal(current.open, true); assert.match(transcript.textContent, /New visible transcript line/)
  assert.equal(transcript.scrollTop, 144); assert.equal(transcript.scrollLeft, 9)
  assert.equal(detail(card(f, 'Ticket b'), 'Copilot session and transcript').open, false)
  const focused = f.document.activeElement!
  assert.ok(key); assert.equal(focused.isConnected, true); assert.equal(focused.dataset.controlKey, key)
  assert.equal(focused.closest('article'), card(f, 'Ticket a')); assert.equal(focused.lastFocusOptions?.preventScroll, true)
  assert.equal(f.window.scrollY, 620); assert.equal(f.window.scrollX, 3)
  f.fire(focused, 'click'); assert.equal(f.sent.at(-1)!.action, 'openTicket'); assert.equal(f.sent.at(-1)!.id, 'a')
})

test('tabs and search retain the same connected editor and its draft selection without hiding new native revisions', () => {
  const f = webview(); f.receive(state(1, ['first'])); f.tab('Settings'); f.edit(JSON.stringify(value(['draft'])))
  const editor = f.editor(); editor.setSelectionRange(8, 12, 'backward'); editor.scrollTop = 65
  f.search('not in settings'); assert.equal(f.editor(), editor); assert.equal(editor.isConnected, true)
  f.tab('Overview'); f.receive(state(2, ['current'])); assert.equal(editor.isConnected, true)
  f.receive({ type: 'notice', text: 'Native settings changed' }); assert.equal(f.notice.textContent, 'Native settings changed')
  f.tab('Settings'); assert.equal(f.editor(), editor); assert.deepEqual(JSON.parse(editor.value), value(['draft']))
  assert.deepEqual(selection(editor), [8, 12, 'backward']); assert.equal(editor.scrollTop, 65)
  assert.match(f.document.getElementById('settings-view')!.textContent, /Current revision 2/)
  f.click('Save settings'); assert.equal(f.sent.at(-1)!.revision, 1)
})

for (const finalInput of ['before-end', 'after-end'] as const) test(`IME ${finalInput} pins its original base while native snapshots and notices stay live`, () => {
  const f = webview(); f.receive(state(1, ['original'])); f.tab('Settings')
  const editor = f.editor(); editor.focus({ preventScroll: true }); f.fire(editor, 'compositionstart', { data: '' })
  editor.value = JSON.stringify(value(['interim-に']))
  f.receive(state(2, ['native-removed']))
  f.receive({ type: 'notice', text: 'Source check finished during composition' })
  assert.equal(f.editor(), editor); assert.equal(editor.isConnected, true); assert.equal(f.document.activeElement, editor)
  assert.equal(editor.value, JSON.stringify(value(['interim-に'])))
  assert.match(f.document.getElementById('settings-view')!.textContent, /Current revision 2/)
  assert.equal(f.notice.textContent, 'Source check finished during composition')
  const completed = JSON.stringify(value(['日本語-final']))
  if (finalInput === 'before-end') {
    editor.value = completed; f.fire(editor, 'input', { inputType: 'insertCompositionText', isComposing: true })
    f.fire(editor, 'compositionend', { data: '日本語' })
  } else {
    f.fire(editor, 'compositionend', { data: '日本語' }); f.receive(state(3, ['another-native-change']))
    editor.value = completed; f.fire(editor, 'input', { inputType: 'insertFromComposition', isComposing: false })
  }
  f.receive(state(4, ['latest-native-change']))
  assert.equal(f.editor(), editor); assert.equal(editor.value, completed)
  f.click('Save settings'); assert.equal(f.sent.at(-1)!.revision, 1); assert.deepEqual(f.sent.at(-1)!.value, value(['日本語-final']))
})

for (const cancellation of ['blur', 'tab'] as const) test(`IME ${cancellation} cancellation captures the real editor value and retains the original base`, () => {
  const f = webview(); f.receive(state(1, ['original'])); f.tab('Settings')
  const editor = f.editor(); editor.focus({ preventScroll: true }); f.fire(editor, 'compositionstart', { data: '' })
  editor.value = JSON.stringify(value(['intermediate']))
  f.receive(state(2, ['native-change']))
  // A cancellation may restore text without a final input event; the connected control is authoritative.
  const actual = JSON.stringify(value([cancellation === 'blur' ? 'original' : 'retained-composition-text']))
  editor.value = actual
  if (cancellation === 'blur') editor.blur(); else f.tab('Overview')
  f.receive(state(3, ['more-native-change']))
  f.receive({ type: 'notice', text: 'Live after composition cancellation' })
  if (cancellation === 'tab') f.tab('Settings')
  assert.equal(f.editor(), editor); assert.equal(editor.value, actual)
  assert.equal(f.notice.textContent, 'Live after composition cancellation')
  f.click('Save settings'); assert.equal(f.sent.at(-1)!.revision, 1); assert.deepEqual(f.sent.at(-1)!.value, JSON.parse(actual))
})


test('ending composition on a restore click keeps its connected target and original draft base', () => {
  const f = webview(); f.receive(state(1, ['original'])); f.tab('Settings')
  const editor = f.editor(), restore = f.control('Restore this revision')
  editor.focus({ preventScroll: true }); f.fire(editor, 'compositionstart', { data: '' })
  const actual = JSON.stringify(value(['composed-before-restore']))
  editor.value = actual
  f.receive(state(2, ['native-change']))
  assert.ok(f.control('Restore this revision') === restore, 'unchanged history must retain its interactive restore target')
  f.click('Restore this revision')
  const request = f.sent.at(-1)!
  assert.equal(request.action, 'restoreSettings'); assert.equal(request.baseRevision, 1)
  assert.equal(f.editor(), editor); assert.equal(editor.value, actual); assert.equal(editor.disabled, true)
  f.receive({ type: 'notice', requestId: request.requestId, action: request.action, text: 'Restore conflict' })
  assert.equal(f.editor(), editor); assert.equal(editor.value, actual)
  f.click('Save settings'); assert.equal(f.sent.at(-1)!.revision, 1); assert.deepEqual(f.sent.at(-1)!.value, JSON.parse(actual))
})


test('executed Settings keeps admission disclosures visible and preserves a declined sender-policy draft base', () => {
  const f = webview(), warning = 'GitHub family fallback: people outside allowedActors who address the agent — explicit work in every proactive mode; current and future configured scopes',
    row = 'github:' + 'a'.repeat(64) + ':issues'
  const original = { ...value(['current-member']), acceptMode: 'off' }
  f.receive({ type: 'state', value: { settings: { revision: 1, value: original }, history: [], admissionWarnings: [warning],
    admissionScopes: [{ family: 'github', key: row, label: 'GitHub company/project / issues' }] } })
  f.tab('Settings')
  const settings = f.document.getElementById('settings-view')!
  assert.match(settings.textContent, /unlisted/i); assert.match(settings.textContent, /explicit/i)
  assert.match(settings.textContent, /every|all.*mode/i); assert.match(settings.textContent, /auto/i); assert.match(settings.textContent, /rule/i)
  assert.ok(settings.textContent.includes(warning)); assert.ok(settings.textContent.includes(row))
  assert.ok(f.elements().some(el => el.textContent === warning && !el.closest('details')), 'Persisted grants must be visible before opening any disclosure details')
  const draft = JSON.stringify({ ...original, sources: { teams: { allowedActors: [], admission: { unlistedAddressed: 'explicit' } } } }, null, 2)
  f.edit(draft); f.click('Save settings'); const pending = f.sent.at(-1)!
  assert.equal(pending.revision, 1); assert.equal(f.editor().disabled, true)
  f.receive({ type: 'state', value: { settings: { revision: 2, value: value([]) }, history: [], admissionWarnings: ['The current policy denies unlisted people'], admissionScopes: [] } })
  f.receive({ type: 'notice', requestId: pending.requestId, action: pending.action, text: 'Sender policy authorization cancelled' })
  assert.equal(f.editor().value, draft); assert.equal(f.editor().disabled, false)
  assert.ok(settings.textContent.includes('The current policy denies unlisted people'))
  f.tab('Overview'); f.tab('Settings'); assert.equal(f.editor().value, draft)
  f.click('Save settings'); const retried = f.sent.at(-1)!
  assert.equal(retried.revision, 1, 'A cancelled confirmation cannot adopt an unrelated committed revision')
  assert.deepEqual(retried.value, JSON.parse(draft))
})
