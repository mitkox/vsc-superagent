import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, 'Runtime dependencies require security review')
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
assert.ok(!/deepseek-ai|createTelemetryLogger|applicationinsights|sentry|posthog|opentelemetry|http\.createServer/.test(bundle), 'Unexpected runtime or telemetry surface')
console.log('Package security checks passed: no external runtime, dependencies, telemetry SDKs, proposed APIs, or HTTP listener.')
