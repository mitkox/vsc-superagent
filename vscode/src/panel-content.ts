/** All provider/model text is inserted with textContent; the webview has no network capability. */
export function panelContent(nonce: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(nonce)) throw new Error('Invalid webview nonce')
  return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:24px;max-width:1400px}h1{font-size:23px;margin:0 0 8px}h2{font-size:17px}p{line-height:1.6}nav,.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}button,input,select,textarea{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);padding:8px;border-radius:3px}button{cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.active,button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:1px solid var(--vscode-focusBorder)}section[hidden]{display:none}article{border:1px solid var(--vscode-panel-border);padding:16px;margin:12px 0;border-radius:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;max-height:520px;overflow:auto}textarea{box-sizing:border-box;width:100%;min-height:420px;tab-size:2;font:13px var(--vscode-editor-font-family)}.muted{color:var(--vscode-descriptionForeground)}.error{color:var(--vscode-errorForeground)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.badge{font-size:12px;color:var(--vscode-descriptionForeground)}#notice{min-height:20px}label{display:block;margin:10px 0}details{margin:8px 0}summary{cursor:pointer}a{color:var(--vscode-textLink-foreground)}@media(max-width:600px){body{padding:14px}.toolbar button{flex:1}}
</style></head><body><h1>Superagent</h1><div class="muted">Repository work, conversations and Copilot workers</div>
<div class="toolbar"><button data-action="start" class="primary">Start service</button><button data-action="pause">Pause / resume</button><button data-action="poll">Check sources</button><button data-action="new">New ticket</button><button data-action="stopService">Stop service</button></div>
<div id="notice" role="status"></div><nav aria-label="Superagent sections">${['Overview','Sources','Triggers','Eval','Execution','Settings'].map((name, i) => `<button data-tab="${name}"${i ? '' : ' class="active"'}>${name}</button>`).join('')}</nav>
<label>Search tickets and source events <input id="search" type="search" placeholder="Title, text, source link or ID"></label>
<main id="content"></main>
<script nonce="${nonce}">
const api = acquireVsCodeApi();
let snapshot = {}, tab = 'Overview', draft, pending, nextRequest = 0, composing = false;
const root = document.getElementById('content');
const content = node('section', undefined, root); content.id = 'live-view';
const settingsContent = node('section', undefined, root); settingsContent.id = 'settings-view'; settingsContent.hidden = true;
const viewState = new Map();
let editor, revisionLabel, saveButton, reloadButton, defaultsHint, historyContent, historyFingerprint, admissionHint, scopeHint;
let restoreButtons = [];
const send = (action, payload = {}) => api.postMessage({ action, ...payload });
function node(tag, text, parent, cls) { const el = document.createElement(tag); if (text !== undefined)
    el.textContent = String(text); if (cls)
    el.className = cls; if (parent)
    parent.append(el); return el; }
function json(value) { return JSON.stringify(value, null, 2); }
function loadDraft(settings) { draft = { text: json(settings?.value || {}), baseRevision: settings?.revision || 0, dirty: false }; }
function currentDraft() { if (!draft) loadDraft(snapshot.settings); return draft; }
function settingsAction(action, payload) {
    if (pending || composing) return;
    const current = currentDraft();
    pending = { requestId: 'settings-' + (++nextRequest), action, baseRevision: current.baseRevision };
    document.getElementById('notice').textContent = '';
    send(action, { ...payload, requestId: pending.requestId });
    render();
}
function button(parent, label, action, id) { const el = node('button', label, parent); el.dataset.controlKey = action + ':' + (id || ''); el.onclick = () => send(action, id ? { id } : {}); return el; }
function rows(name) { return Array.isArray(snapshot[name]) ? snapshot[name] : []; }
function matches(value) { return json(value).toLowerCase().includes(document.getElementById('search').value.toLowerCase()); }
function detail(parent, label, value, key) { const d = node('details', undefined, parent); d.dataset.viewKey = JSON.stringify(['detail', key]); const summary = node('summary', label, d); summary.dataset.controlKey = JSON.stringify(['summary', key]); const body = node('pre', json(value), d); body.dataset.viewKey = JSON.stringify(['body', key]); }
function remember(parent) {
    parent.querySelectorAll('[data-view-key]').forEach(el => viewState.set(el.dataset.viewKey, { open: el.tagName === 'DETAILS' ? el.open : undefined, top: el.scrollTop, left: el.scrollLeft }));
    const active = document.activeElement;
    return parent.contains(active) ? active.dataset.controlKey : undefined;
}
function restore(parent, focused) {
    parent.querySelectorAll('[data-view-key]').forEach(el => { const saved = viewState.get(el.dataset.viewKey); if (saved) {
        if (saved.open !== undefined) el.open = saved.open;
        el.scrollTop = saved.top; el.scrollLeft = saved.left;
    } });
    if (focused) Array.from(parent.querySelectorAll('[data-control-key]')).find(el => el.dataset.controlKey === focused)?.focus({ preventScroll: true });
}
function captureEditor() {
    if (pending || !editor) return;
    const current = currentDraft(); current.text = editor.value; current.dirty = true;
}
function finishComposition() {
    if (!composing) return;
    captureEditor(); composing = false;
}
function draftLabel() { const current = currentDraft(); return 'Draft base revision ' + current.baseRevision + ' · Current revision ' + (snapshot.settings?.revision || 0) + (current.dirty ? ' · Unsaved changes' : ''); }
function renderSettings() {
    if (!editor) {
        node('h2', 'Settings', settingsContent);
        node('p', 'Policy, worker concurrency, models, proactive rules and prompt sections. Saving creates a retained revision.', settingsContent);
        node('p', 'Unlisted people are ignored by default. An unlistedAddressed explicit grant lets anyone in that receiving scope start work in every proactive mode. Family admission is a fallback for all current and future configured scopes; admissionByScope can narrow or replace it for a specific scope. Inferred work requires auto and enabled matching rules. Bots and unaddressed messages cannot receive explicit authority.', settingsContent);
        node('strong', 'Committed sender admission', settingsContent);
        admissionHint = node('pre', undefined, settingsContent);
        const scopeDetails = node('details', undefined, settingsContent);
        node('summary', 'Configured receiving scope keys', scopeDetails);
        scopeHint = node('pre', undefined, scopeDetails);
        revisionLabel = node('label', undefined, settingsContent);
        editor = node('textarea', undefined, settingsContent); editor.id = 'settings'; editor.dataset.controlKey = 'settings:editor';
        editor.setAttribute('aria-label', 'Superagent settings JSON');
        editor.oninput = () => { captureEditor(); revisionLabel.textContent = draftLabel(); };
        editor.oncompositionstart = () => { composing = true; captureEditor(); revisionLabel.textContent = draftLabel(); };
        editor.oncompositionend = () => { captureEditor(); composing = false; revisionLabel.textContent = draftLabel(); };
        editor.onblur = () => { if (composing) { finishComposition(); revisionLabel.textContent = draftLabel(); } };
        const tools = node('div', undefined, settingsContent, 'toolbar');
        saveButton = button(tools, 'Save settings', 'unused'); saveButton.dataset.controlKey = 'settings:save';
        saveButton.onclick = () => { if (pending || composing) return; const current = currentDraft(); try {
            settingsAction('saveSettings', { value: JSON.parse(current.text), revision: current.baseRevision });
        } catch { document.getElementById('notice').textContent = 'Settings must be valid JSON.'; } };
        reloadButton = button(tools, 'Reload current settings', 'unused'); reloadButton.dataset.controlKey = 'settings:reload';
        reloadButton.onclick = () => { if (!pending) { finishComposition(); loadDraft(snapshot.settings); render(); } };
        button(tools, 'Preview worker prompt', 'previewWorker');
        button(tools, 'Preview assessment prompt', 'previewAssessor');
        defaultsHint = node('p', undefined, settingsContent);
        historyContent = node('div', undefined, settingsContent);
    }
    const current = currentDraft();
    const admissionText = Array.isArray(snapshot.admissionWarnings) && snapshot.admissionWarnings.length ? snapshot.admissionWarnings.join('\\n\\n') : 'No unlisted admission grant is configured.';
    const scopeText = json(snapshot.admissionScopes || []);
    if (admissionHint.textContent !== admissionText) admissionHint.textContent = admissionText;
    if (scopeHint.textContent !== scopeText) scopeHint.textContent = scopeText;
    revisionLabel.textContent = draftLabel();
    if (!composing && editor.value !== current.text) {
        const start = editor.selectionStart, end = editor.selectionEnd, direction = editor.selectionDirection, top = editor.scrollTop, left = editor.scrollLeft;
        editor.value = current.text;
        editor.setSelectionRange(Math.min(start, current.text.length), Math.min(end, current.text.length), direction);
        editor.scrollTop = top; editor.scrollLeft = left;
    }
    editor.disabled = !!pending; saveButton.disabled = !!pending; reloadButton.disabled = !!pending;
    defaultsHint.textContent = snapshot.promptDefaultsChanged?.length ? 'Updated built-in prompt defaults: ' + snapshot.promptDefaultsChanged.join(', ') + '. Review your saved overrides.' : '';
    const history = rows('history').slice().reverse(), fingerprint = json(history);
    if (fingerprint !== historyFingerprint) {
        const focused = remember(historyContent);
        historyContent.replaceChildren(); restoreButtons = [];
        for (const version of history) {
            const card = node('article', undefined, historyContent);
            node('strong', 'Revision ' + version.revision + ' · ' + (version.at || ''), card);
            const restoreButton = button(card, 'Restore this revision', 'unused'); restoreButton.dataset.controlKey = 'settings:restore:' + version.revision;
            restoreButton.onclick = () => settingsAction('restoreSettings', { revision: version.revision, baseRevision: currentDraft().baseRevision });
            restoreButtons.push(restoreButton);
            detail(card, 'Saved settings', version, 'settings:revision:' + version.revision);
        }
        historyFingerprint = fingerprint;
        restore(historyContent, focused);
    }
    restoreButtons.forEach(el => { el.disabled = !!pending; });
}
function ticketCard(ticket, parent) { const card = node('article', undefined, parent); node('h2', ticket.title, card); const report = ticket.assignments?.at(-1)?.report; node('div', (ticket.ended?.outcome || report?.state || 'queued') + ' · ' + ticket.id, card, 'badge'); if (ticket.attention)
    node('p', ticket.attention.question, card); if (report)
    node('p', report.summary, card); const actions = node('div', undefined, card, 'toolbar'); button(actions, 'Open worktree', 'openTicket', ticket.id); button(actions, 'Follow-up', 'followup', ticket.id); if (!ticket.ended) {
    button(actions, 'Stop', 'stopTicket', ticket.id);
    if (['blocked', 'failed'].includes(report?.state))
        button(actions, 'Retry', 'retry', ticket.id);
} button(actions, 'Read conversation', 'conversation', ticket.id); const trace = rows('sessions').find(s => s.ticketId === ticket.id); if (trace)
    detail(card, 'Copilot session and transcript', trace, 'ticket:' + ticket.id + ':transcript'); detail(card, 'Ticket, mandate and inputs', ticket, 'ticket:' + ticket.id + ':data'); }
function render() {
    const x = window.scrollX, y = window.scrollY;
    const focused = remember(content);
    content.hidden = tab === 'Settings'; settingsContent.hidden = tab !== 'Settings';
    if (tab !== 'Settings') content.replaceChildren();
    document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    const tickets = rows('tickets').filter(matches);
    if (tab !== 'Settings') node('h2', tab, content);
    if (tab === 'Overview') {
        const attention = tickets.filter(t => t.attention || ['ready', 'blocked', 'failed'].includes(t.assignments?.at(-1)?.report?.state));
        node('p', attention.length + ' tickets need attention · ' + tickets.filter(t => !t.ended).length + ' open · ' + rows('effects').filter(e => e.status === 'pending' || e.status === 'running').length + ' queued operations', content);
        const health = snapshot.health;
        if (health && Object.keys(health).length)
            detail(content, 'Service health', health, 'service:health');
        for (const effect of rows('effects').filter(e => e.status === 'failed')) {
            const card = node('article', undefined, content);
            node('strong', 'Failed ' + effect.kind, card);
            node('p', effect.error || 'Needs attention', card, 'error');
            button(card, 'Retry operation', 'retryEffect', effect.id);
        }
        if (!attention.length)
            node('p', 'No tickets need your attention.', content, 'muted');
        attention.forEach(t => ticketCard(t, content));
    }
    else if (tab === 'Execution') {
        tickets.forEach(t => ticketCard(t, content));
        if (!tickets.length)
            node('p', 'No tickets yet. Create a ticket or start an approved source.', content, 'muted');
    }
    else if (tab === 'Sources') {
        node('p', 'Source scope and requester lists are configured at application scope. Source text cannot change policy.', content);
        button(content, 'Configure GitHub / Teams', 'configureSources');
        detail(content, 'Current policy', snapshot.settings?.value?.sources || {}, 'sources:policy');
        detail(content, 'Source cursors and health', snapshot.sources || snapshot.health || {}, 'sources:progress');
    }
    else if (tab === 'Triggers') {
        for (const trigger of rows('triggers').filter(matches).reverse()) {
            const card = node('article', undefined, content);
            node('strong', trigger.actor?.id + ' · ' + trigger.source, card);
            node('p', trigger.text, card);
            if (trigger.url)
                node('p', trigger.url, card, 'muted');
            detail(card, 'Context and delivery', trigger, 'trigger:' + trigger.id);
            button(card, 'Evaluate again', 'reevaluate', trigger.id);
        }
        for (const thread of rows('threads').filter(matches)) {
            const card = node('article', undefined, content);
            node('strong', thread.key, card);
            detail(card, 'Thread subscriptions', thread, 'thread:' + thread.key);
            button(card, 'Unsubscribe tickets', 'unsubscribe', thread.key);
        }
    }
    else if (tab === 'Eval') {
        for (const decision of rows('decisions').filter(matches).reverse()) {
            const card = node('article', undefined, content);
            node('strong', decision.kind + ' · ' + decision.threadKey, card);
            node('pre', json(decision), card);
        }
        if (!rows('decisions').length)
            node('p', 'Decisions will appear after source events are assessed.', content, 'muted');
    }
    else if (tab === 'Settings') renderSettings();
    if (tab !== 'Settings') restore(content, focused);
    window.scrollTo(x, y);
}
document.querySelectorAll('[data-action]').forEach(el => el.onclick = () => send(el.dataset.action));
document.querySelectorAll('[data-tab]').forEach(el => el.onclick = () => { finishComposition(); tab = el.dataset.tab; render(); });
document.getElementById('search').oninput = render;
window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'state') {
        const incoming = message.value, previous = snapshot.settings;
        const fresh = Number.isSafeInteger(incoming.settings?.revision) && incoming.settings.revision >= (previous?.revision || 0);
        snapshot = !fresh && previous ? { ...incoming, settings: previous } : incoming;
        if (draft && !draft.dirty && !pending && !composing && fresh && incoming.settings.revision > draft.baseRevision) loadDraft(incoming.settings);
        render();
    }
    else if (message.type === 'settingsResult') {
        if (!pending || message.requestId !== pending.requestId || message.action !== pending.action
            || message.settings?.revision !== pending.baseRevision + 1 || !message.settings.value || typeof message.settings.value !== 'object' || Array.isArray(message.settings.value)) return;
        loadDraft(message.settings);
        if ((snapshot.settings?.revision || 0) < message.settings.revision) snapshot = { ...snapshot, settings: message.settings };
        pending = undefined;
        render();
    }
    else if (message.type === 'notice') {
        if (message.requestId && (!pending || message.requestId !== pending.requestId || message.action !== pending.action)) return;
        document.getElementById('notice').textContent = message.text;
        if (pending && message.requestId === pending.requestId && message.action === pending.action) {
            draft.dirty = true;
            pending = undefined;
            render();
        }
    }
});
send('refresh');
</script></body></html>`
}
