import { build } from 'esbuild'
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
await mkdir('dist', { recursive: true })
await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], legalComments: 'eof', metafile: true })
const bytes = await readFile('dist/extension.cjs')
await writeFile('dist/extension.cjs.sha256', `${createHash('sha256').update(bytes).digest('hex')}  extension.cjs\n`)
await copyFile('../LICENSE', 'LICENSE')
