import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'
import { panelContent } from './panel-content.ts'

/** Native callbacks, never arbitrary commands supplied by a source or webview. */
export interface SettingsActionResult {
  type: 'settings'
  action: 'saveSettings' | 'restoreSettings'
  settings: { revision: number; value: unknown }
}
export interface PanelHost {
  snapshot(): unknown
  action(message: Record<string, unknown>): Promise<SettingsActionResult | void>
}

export class SuperagentPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel
  constructor(private readonly host: PanelHost) {}
  show(): void {
    if (this.panel) { this.panel.reveal(); this.refresh(); return }
    const panel = this.panel = vscode.window.createWebviewPanel('superagent.supervision', 'Superagent', vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true })
    panel.webview.html = panelContent(randomBytes(24).toString('base64url'))
    panel.onDidDispose(() => { this.panel = undefined })
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return
      const input = message as Record<string, unknown>
      const requestId = typeof input.requestId === 'string' && input.requestId.length <= 100 ? input.requestId : undefined
      try {
        const result = await this.host.action(input)
        if (result && result.type === 'settings' && result.action === input.action && requestId)
          await panel.webview.postMessage({ type: 'settingsResult', requestId, action: result.action, settings: result.settings })
        this.refresh()
      } catch { await panel.webview.postMessage({ type: 'notice', requestId, action: input.action, text: 'Operation failed. Check policy, credentials and the service health before retrying.' }) }
    })
  }
  refresh(): void { if (this.panel) void this.panel.webview.postMessage({ type: 'state', value: this.host.snapshot() }) }
  dispose(): void { this.panel?.dispose(); this.panel = undefined }
}
