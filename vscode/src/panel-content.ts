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
let snapshot = {}, tab = 'Overview', dirty = false;
const content = document.getElementById('content');
const send = (action, payload = {}) => api.postMessage({ action, ...payload });
function node(tag, text, parent, cls) { const el = document.createElement(tag); if (text !== undefined)
    el.textContent = String(text); if (cls)
    el.className = cls; if (parent)
    parent.append(el); return el; }
function json(value) { return JSON.stringify(value, null, 2); }
function button(parent, label, action, id) { const el = node('button', label, parent); el.onclick = () => send(action, id ? { id } : {}); return el; }
function rows(name) { return Array.isArray(snapshot[name]) ? snapshot[name] : []; }
function matches(value) { return json(value).toLowerCase().includes(document.getElementById('search').value.toLowerCase()); }
function detail(parent, label, value) { const d = node('details', undefined, parent); node('summary', label, d); node('pre', json(value), d); }
function ticketCard(ticket, parent) { const card = node('article', undefined, parent); node('h2', ticket.title, card); const report = ticket.assignments?.at(-1)?.report; node('div', (ticket.ended?.outcome || report?.state || 'queued') + ' · ' + ticket.id, card, 'badge'); if (ticket.attention)
    node('p', ticket.attention.question, card); if (report)
    node('p', report.summary, card); const actions = node('div', undefined, card, 'toolbar'); button(actions, 'Open worktree', 'openTicket', ticket.id); button(actions, 'Follow-up', 'followup', ticket.id); if (!ticket.ended) {
    button(actions, 'Stop', 'stopTicket', ticket.id);
    if (['blocked', 'failed'].includes(report?.state))
        button(actions, 'Retry', 'retry', ticket.id);
} button(actions, 'Read conversation', 'conversation', ticket.id); const trace = rows('sessions').find(s => s.ticketId === ticket.id); if (trace)
    detail(card, 'Copilot session and transcript', trace); detail(card, 'Ticket, mandate and inputs', ticket); }
function render() {
    const saved = tab === 'Settings' && dirty ? document.getElementById('settings')?.value : undefined;
    content.replaceChildren();
    document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
    const tickets = rows('tickets').filter(matches);
    node('h2', tab, content);
    if (tab === 'Overview') {
        const attention = tickets.filter(t => t.attention || ['ready', 'blocked', 'failed'].includes(t.assignments?.at(-1)?.report?.state));
        node('p', attention.length + ' tickets need attention · ' + tickets.filter(t => !t.ended).length + ' open · ' + rows('effects').filter(e => e.status === 'pending' || e.status === 'running').length + ' queued operations', content);
        const health = snapshot.health;
        if (health && Object.keys(health).length)
            detail(content, 'Service health', health);
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
        detail(content, 'Current policy', snapshot.settings?.value?.sources || {});
        detail(content, 'Source cursors and health', snapshot.sources || snapshot.health || {});
    }
    else if (tab === 'Triggers') {
        for (const trigger of rows('triggers').filter(matches).reverse()) {
            const card = node('article', undefined, content);
            node('strong', trigger.actor?.id + ' · ' + trigger.source, card);
            node('p', trigger.text, card);
            if (trigger.url)
                node('p', trigger.url, card, 'muted');
            detail(card, 'Context and delivery', trigger);
            button(card, 'Evaluate again', 'reevaluate', trigger.id);
        }
        for (const thread of rows('threads').filter(matches)) {
            const card = node('article', undefined, content);
            node('strong', thread.key, card);
            detail(card, 'Thread subscriptions', thread);
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
    else if (tab === 'Settings') {
        node('p', 'Policy, worker concurrency, models, proactive rules and prompt sections. Saving creates a retained revision.', content);
        node('label', 'Settings revision ' + (snapshot.settings?.revision || 0), content);
        const editor = node('textarea', undefined, content);
        editor.id = 'settings';
        editor.setAttribute('aria-label', 'Superagent settings JSON');
        editor.value = saved ?? json(snapshot.settings?.value || {});
        editor.oninput = () => { dirty = true; };
        const tools = node('div', undefined, content, 'toolbar');
        const save = button(tools, 'Save settings', 'unused');
        save.onclick = () => { try {
            const value = JSON.parse(editor.value);
            send('saveSettings', { value, revision: snapshot.settings?.revision || 0 });
            dirty = false;
        }
        catch {
            document.getElementById('notice').textContent = 'Settings must be valid JSON.';
        } };
        button(tools, 'Preview worker prompt', 'previewWorker');
        button(tools, 'Preview assessment prompt', 'previewAssessor');
        if (snapshot.promptDefaultsChanged?.length)
            node('p', 'Updated built-in prompt defaults: ' + snapshot.promptDefaultsChanged.join(', ') + '. Review your saved overrides.', content);
        for (const version of rows('history').slice().reverse()) {
            const card = node('article', undefined, content);
            node('strong', 'Revision ' + version.revision + ' · ' + (version.at || ''), card);
            const restore = button(card, 'Restore this revision', 'unused');
            restore.onclick = () => send('restoreSettings', { revision: version.revision, baseRevision: snapshot.settings?.revision || 0 });
            detail(card, 'Saved settings', version);
        }
    }
}
document.querySelectorAll('[data-action]').forEach(el => el.onclick = () => send(el.dataset.action));
document.querySelectorAll('[data-tab]').forEach(el => el.onclick = () => { tab = el.dataset.tab; render(); });
document.getElementById('search').oninput = render;
window.addEventListener('message', event => { if (event.data.type === 'state') {
    snapshot = event.data.value;
    render();
}
else if (event.data.type === 'notice')
    document.getElementById('notice').textContent = event.data.text; });
send('refresh');
</script></body></html>`
}
