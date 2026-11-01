import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { platform } from 'node:os'

const run = promisify(execFile)
const TICKET = /^[a-zA-Z0-9_-]{1,128}$/

/** Only local Git plumbing is executed; no shell, hooks, filters, submodules or network. */
export class Worktrees {
  constructor(private readonly git: string, private readonly source: string, private readonly storage: string) {
    if (![git, source, storage].every(isAbsolute)) throw new Error('Git and workspace paths must be absolute')
  }

  private async command(args: string[], cwd = this.source, signal?: AbortSignal): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      PATH: dirname(this.git), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: platform() === 'win32' ? 'NUL' : '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1',
    }
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]
    const { stdout } = await run(this.git, ['-c', `core.hooksPath=${platform() === 'win32' ? 'NUL' : '/dev/null'}`,
      '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'protocol.file.allow=never',
      '-c', 'protocol.ext.allow=never', ...args], { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, signal })
    return stdout.trim()
  }

  async commonDirectory(): Promise<string> {
    return realpath(await this.command(['rev-parse', '--path-format=absolute', '--git-common-dir']))
  }

  async ticketAt(path: string): Promise<string | undefined> {
    const actual = await realpath(path)
    let root: string
    try { root = await realpath(this.storage) } catch { return undefined }
    if (dirname(actual) !== root) return undefined
    const ticket = actual.slice(root.length + 1)
    if (!TICKET.test(ticket)) return undefined
    const marker = await lstat(join(root, `.${ticket}.ready`)).catch(() => undefined)
    if (!marker?.isFile() || marker.isSymbolicLink()) throw new Error('Worktree preparation is incomplete; inspect it before manually recovering')
    const top = await this.command(['rev-parse', '--show-toplevel'], actual)
    if (await realpath(top) !== actual) return undefined
    const common = await this.command(['rev-parse', '--path-format=absolute', '--git-common-dir'], actual)
    if (await realpath(common) !== await this.commonDirectory()) throw new Error('Worktree belongs to another repository')
    const branch = await this.command(['symbolic-ref', '--quiet', '--short', 'HEAD'], actual).catch(() => '')
    if (branch !== `superagent/${ticket}`) throw new Error('Worktree branch changed or is detached; review it before continuing')
    return ticket
  }

  async prepare(ticket: string, signal?: AbortSignal): Promise<string> {
    if (!TICKET.test(ticket)) throw new Error('Invalid ticket identifier')
    await mkdir(this.storage, { recursive: true, mode: 0o700 })
    if ((await lstat(this.storage)).isSymbolicLink() || await realpath(this.storage) !== resolve(this.storage)) throw new Error('Unsafe worktree storage path')
    const destination = join(this.storage, ticket)
    const branch = `superagent/${ticket}`
    try {
      await lstat(destination)
      if (await this.ticketAt(destination) !== ticket) throw new Error('Worktree path already occupied')
      const current = await this.command(['symbolic-ref', '--short', 'HEAD'], destination)
      if (current !== branch) throw new Error('Worktree branch changed; review it before continuing')
      return destination
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    // Always start at the primary checkout's committed HEAD, preserving its dirty files.
    const entries = await this.command(['worktree', 'list', '--porcelain', '-z'])
    const primary = entries.split('\0').find(line => line.startsWith('worktree '))?.slice(9)
    if (!primary || !isAbsolute(primary)) throw new Error('Cannot determine primary checkout')
    const head = await this.command(['rev-parse', '--verify', 'HEAD'], primary)
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error('Invalid repository HEAD')

    // Repo-defined smudge/process filters can execute programs even with hooks disabled.
    await this.command(['worktree', 'add', '--no-checkout', '-b', branch, '--', destination, head], primary, signal)
    const config = await this.command(['config', '--includes', '--name-only', '--get-regexp', '^filter\\.'], destination).catch(error => {
      if (error.code === 1) return ''
      throw error
    })
    const filters = [...new Set(config.split('\n').map(key => /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(key)?.[1]).filter((x): x is string => !!x))]
    if (filters.some(filter => !/^[a-zA-Z0-9_.-]+$/.test(filter))) throw new Error('Unsupported Git filter configuration')
    const overrides = filters.flatMap(filter => ['-c', `filter.${filter}.smudge=`, '-c', `filter.${filter}.process=`, '-c', `filter.${filter}.required=false`])
    await this.command([...overrides, 'checkout', '--force', 'HEAD', '--', '.'], destination, signal)
    await writeFile(join(this.storage, `.${ticket}.ready`), `${head}\n`, { mode: 0o600, flag: 'wx' })
    return destination
  }
}
