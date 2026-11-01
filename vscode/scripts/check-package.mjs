import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(manifest.dependencies['@github/copilot-sdk'], '1.0.28', 'Pin the reviewed Copilot SDK')
assert.equal(manifest.dependencies.zod, '4.6.6', 'Pin patched schema validation')
assert.equal(manifest.overrides.zod, '4.6.6')
assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false)
assert.equal(manifest.capabilities.virtualWorkspaces, false)
assert.ok(!manifest.enabledApiProposals, 'Only stable VS Code APIs permitted')
for (const property of Object.values(manifest.contributes.configuration.properties)) assert.equal(property.scope, 'application')
const agent = await readFile('agents/superagent.agent.md', 'utf8')
for (const tool of manifest.contributes.languageModelTools) {
  const qualified = `${manifest.publisher}.${manifest.name}/${tool.toolReferenceName}`
  assert.ok(agent.includes(`'${qualified}'`), `Agent must use the canonical extension tool reference: ${qualified}`)
}
const bundle = await readFile('dist/extension.cjs', 'utf8')
assert.ok(!/deepseek-ai|createTelemetryLogger|applicationinsights|sentry|posthog|http\.createServer/.test(bundle), 'Unexpected runtime or telemetry surface')
assert.ok(bundle.includes('forStdio'), 'Use the installed authenticated Copilot CLI over stdio')
assert.ok((await readFile('dist/prompts/worker.md', 'utf8')).includes('Microsoft Teams'))
console.log('Package checks passed: pinned Copilot SDK, patched Zod, no DSH runtime, extension HTTP listener or proposed VS Code APIs.')
