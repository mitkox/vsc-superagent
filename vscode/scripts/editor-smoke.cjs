// Run only in a disposable VS Code test profile with telemetry disabled.
const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')
const vscode = require('vscode')
exports.run = async () => {
  assert.equal(vscode.workspace.getConfiguration('telemetry').get('telemetryLevel'), 'off')
  assert.equal(vscode.env.isTelemetryEnabled, false)
  const extension = vscode.extensions.getExtension('superagent-local.vsc-superagent')
  assert.ok(extension, 'Extension discovered by native host')
  await extension.activate()
  assert.ok(extension.isActive, 'Extension activated')
  assert.ok(vscode.lm.tools.some(tool => tool.name === 'superagent_snapshot'))
  assert.ok(vscode.lm.tools.some(tool => tool.name === 'superagent_report'))
  assert.equal(extension.packageJSON.contributes.chatAgents[0].path, './agents/superagent.agent.md')
  const agent = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extension.extensionUri, 'agents', 'superagent.agent.md'))).toString('utf8')
  for (const tool of extension.packageJSON.contributes.languageModelTools) {
    assert.ok(agent.includes(`'${extension.id}/${tool.toolReferenceName}'`), 'Agent uses canonical public tool references')
  }
  if (process.env.SUPERAGENT_SMOKE_OUTPUT) writeFileSync(process.env.SUPERAGENT_SMOKE_OUTPUT, JSON.stringify({
    passed: true, version: vscode.version, extension: extension.id,
    scope: 'Native extension discovery, activation, stable tool registration and agent contribution; no model or tenant calls.'
  }, null, 2))
}
