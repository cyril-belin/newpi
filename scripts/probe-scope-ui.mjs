#!/usr/bin/env node
/**
 * Interface proof for the launch scope: one open project is the single source
 * of truth for the Project Model, Memory and Storage — and "no project open"
 * is an honest, visible state rather than a personal folder dressed as one.
 *
 * This script builds a throwaway world — a temporary `HOME`, a temporary
 * `DSH_HOME` that reuses the installed harness modules by symlink, and two
 * project directories with different on-disk footprints — then starts the real
 * NewPi binary three times against it:
 *
 *   1. project Alpha open  → Memory names Alpha, Storage names Alpha and its root;
 *   2. project Beta open   → both switch to Beta, and Alpha's memory is absent;
 *   3. no project open     → both say "Aucun projet ouvert", and the personal
 *                            folder is named nowhere as a project.
 *
 * A memory is written into Alpha's namespace through the isolated sidecar's own
 * API, so the cross-project check reads real rows, not a mock.
 *
 * Nothing outside the temporary directory is read or written: the user's own
 * NewPi, `projects.json`, PocketBase data and memories are never touched.
 *
 * Usage:
 *   node scripts/probe-scope-ui.mjs [--out-dir .dsh-test/scope-proof]
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(ROOT, 'src-tauri/target/debug/newpi')
const DSH = process.env.NEWPI_DSH_BIN ?? join(homedir(), '.local/bin/dsh')

/** The isolated app currently running, so a failure can still stop it. */
let runningApp = null

/** Log one step. */
function step(message) {
  console.log(`  ${message}`)
}

/** Parse `--name value` arguments. */
function options(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) {
      parsed[argv[index].slice(2)] = argv[index + 1]
      index += 1
    }
  }
  return parsed
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A very small Chrome DevTools Protocol client. */
class Devtools {
  #socket
  #next = 1
  #pending = new Map()
  #listeners = new Map()

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('close', () => {
      for (const [, entry] of this.#pending) entry.reject(new Error('the browser closed'))
      this.#pending.clear()
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const entry = this.#pending.get(message.id)
        if (entry === undefined) return
        this.#pending.delete(message.id)
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
        else entry.resolve(message.result)
        return
      }
      const waiters = this.#listeners.get(message.method)
      if (waiters === undefined) return
      this.#listeners.delete(message.method)
      for (const waiter of waiters) waiter(message.params)
    })
  }

  send(method, params = {}) {
    const id = this.#next
    this.#next += 1
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  once(method) {
    return new Promise((resolve) => {
      const waiters = this.#listeners.get(method) ?? []
      waiters.push(resolve)
      this.#listeners.set(method, waiters)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`the page threw: ${JSON.stringify(result.exceptionDetails)}`)
    }
    return result.result.value
  }
}

/** Build the isolated world: temp HOME, temp harness home, two projects. */
async function buildWorld(base) {
  const home = join(base, 'home')
  const dshHome = join(base, 'dsh-home')
  const stateDir = join(home, 'Library/Application Support/NewPi')
  await mkdir(stateDir, { recursive: true })

  const installed = join(homedir(), '.dsh', 'profiles', 'web')
  const web = join(dshHome, 'profiles', 'web')
  await mkdir(web, { recursive: true })
  for (const name of ['cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml']) {
    const source = join(installed, name)
    if (existsSync(source)) await writeFile(join(web, name), await readFile(source, 'utf8'), 'utf8')
  }
  // The profile's own modules and local plugins are reused by symlink: the
  // isolated world must boot the same harness without copying a package tree,
  // and nothing here writes through the links.
  for (const name of ['node_modules', 'plugins', '.dsh-module-fallback']) {
    const source = join(installed, name)
    if (existsSync(source) && !existsSync(join(web, name))) {
      await symlink(source, join(web, name))
    }
  }
  const modules = join(homedir(), '.dsh', 'profiles', 'node_modules')
  if (!existsSync(join(dshHome, 'profiles', 'node_modules'))) {
    await symlink(modules, join(dshHome, 'profiles', 'node_modules'))
  }

  const alpha = await buildProject(base, 'alpha', 4096)
  const beta = await buildProject(base, 'beta', 16384)
  return { base, home, dshHome, stateDir, alpha, beta }
}

/** One project directory with distinct, measurable project targets. */
async function buildProject(base, name, bytes) {
  const root = join(base, name)
  await mkdir(join(root, 'src-tauri/target/debug'), { recursive: true })
  await mkdir(join(root, 'node_modules/pkg'), { recursive: true })
  await writeFile(join(root, 'src-tauri/target/debug', `${name}.bin`), Buffer.alloc(bytes))
  await writeFile(join(root, 'node_modules/pkg', `${name}.bin`), Buffer.alloc(bytes))
  return root
}

/** Write the Project Model's registry the way its own store does. */
async function writeRegistry(world, currentId, projects) {
  const document = {
    version: 1,
    currentId,
    recent: projects.map((project) => project.id),
    projects: Object.fromEntries(
      projects.map((project) => [
        project.id,
        {
          id: project.id,
          name: project.name,
          rootPath: project.root,
          memoryNamespace: project.namespace,
          settings: { capabilities: { network: false } },
        },
      ]),
    ),
  }
  await writeFile(
    join(world.stateDir, 'projects.json'),
    `${JSON.stringify(document, null, 2)}\n`,
    'utf8',
  )
}

/** Launch the real NewPi binary against the isolated world. */
function launchApp(world) {
  const env = {
    PATH: [join(homedir(), '.local/bin'), process.env.PATH ?? ''].join(':'),
    HOME: world.home,
    DSH_HOME: world.dshHome,
    NEWPI_DSH_BIN: DSH,
    LANG: 'en_US.UTF-8',
  }
  const child = spawn(APP, [], { cwd: world.base, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })
  const stop = async () => {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
    const deadline = Date.now() + 10_000
    while (child.exitCode === null && Date.now() < deadline) await sleep(100)
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  }
  const app = { child, output: () => output, stop }
  runningApp = app
  return app
}

/** Wait for the ready URL the runtime prints. */
async function readyUrl(app, label) {
  const deadline = Date.now() + 240_000
  for (;;) {
    const match = /dsh web: (\S+)/.exec(app.output())
    if (match) return match[1]
    if (app.child.exitCode !== null) {
      throw new Error(`${label}: the app exited early:\n${app.output()}`)
    }
    if (Date.now() > deadline) {
      throw new Error(`${label}: no ready URL after 240s:\n${app.output()}`)
    }
    await sleep(300)
  }
}

/** Open a debugging socket to one Chrome instance. */
async function connect(port) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
  const target = list.find((entry) => entry.type === 'page')
  assert.ok(target, 'Chrome exposed no page to drive')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  return new Devtools(socket)
}

/** Start headless Chrome and open the interface. */
async function openPage(url) {
  const profile = await mkdtemp(join(tmpdir(), 'newpi-scope-chrome-'))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1440,1000',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const activePort = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + 20_000
  let port = null
  while (Date.now() < deadline && port === null) {
    port = await readFile(activePort, 'utf8')
      .then((text) => Number(text.split('\n')[0]))
      .catch(() => null)
    if (port === null) await sleep(150)
  }
  assert.ok(port, 'Chrome never reported its debugging port')
  const page = await connect(port)
  const loaded = page.once('Page.loadEventFired')
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Page.navigate', { url })
  await loaded
  const close = async () => {
    await page.send('Browser.close').catch(() => {})
    chrome.kill('SIGTERM')
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
  return { page, close }
}

/** Click an element once it exists. */
async function click(page, selector) {
  await until(
    page,
    `(() => document.querySelector(${JSON.stringify(selector)}) !== null)()`,
    `the ${selector} row`,
    40_000,
  )
  const clicked = await page.evaluate(`
    (() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()
  `)
  assert.ok(clicked, `the interface has no ${selector}`)
  await sleep(1200)
}

/** Poll the page until an expression returns a truthy value. */
async function until(page, expression, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await page.evaluate(expression)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(250)
  }
}

/** Screenshot the page into the output directory. */
async function shot(page, outDir, name) {
  await mkdir(outDir, { recursive: true })
  const image = await page.send('Page.captureScreenshot', { format: 'png' })
  const path = join(outDir, name)
  await writeFile(path, Buffer.from(image.data, 'base64'))
  step(`capture ${name}`)
  return path
}

/** Read the Memory panel: its header and everything it rendered. */
async function readMemory(page) {
  await until(
    page,
    `(() => { const n = document.querySelector('.npc-root .npc-project'); return n && n.textContent.trim().length > 0; })()`,
    'the Memory header',
  )
  return page.evaluate(`
    (() => {
      const root = document.querySelector('.npc-root');
      return { header: document.querySelector('.npc-project').textContent.trim(), text: root.innerText };
    })()
  `)
}

/** Open the Memory section and read it. */
async function memoryPanel(page) {
  await click(page, '[data-newpi-console-nav="memory"]')
  return readMemory(page)
}

/** Open the Storage section and read it. */
async function storagePanel(page) {
  await click(page, '[data-newpi-storage-nav]')
  await until(
    page,
    `(() => { const n = document.querySelector('.nps-root .nps-head .nps-dim'); return n && n.textContent.trim().length > 0; })()`,
    'the Storage header',
  )
  return page.evaluate(`
    (() => {
      const root = document.querySelector('.nps-root');
      return {
        header: document.querySelector('.nps-root .nps-head .nps-dim').textContent.trim(),
        paths: Array.from(document.querySelectorAll('.nps-path')).map((n) => n.textContent),
        text: root.innerText,
      };
    })()
  `)
}

/** The port and credential the isolated sidecar wrote. */
async function sidecar(world) {
  const text = await readFile(join(world.stateDir, 'pocketbase/credentials'), 'utf8')
  const identity = /identity:\s*(\S+)/.exec(text)?.[1]
  const password = /password:\s*(\S+)/.exec(text)?.[1]
  assert.ok(identity && password, 'the isolated sidecar wrote no usable credential')
  return { identity, password }
}

/** Write one memory into a namespace through the sidecar's own superuser API. */
async function seedMemory(world, port, namespace, content) {
  const { identity, password } = await sidecar(world)
  const origin = `http://127.0.0.1:${port}`
  const auth = await fetch(`${origin}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identity, password }),
  }).then((response) => response.json())
  assert.ok(auth.token, `superuser auth failed: ${JSON.stringify(auth)}`)
  const created = await fetch(`${origin}/api/collections/memories/records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth.token },
    body: JSON.stringify({ content, project_id: namespace, kind: 'note' }),
  }).then((response) => response.json())
  assert.ok(created.id, `memory create failed: ${JSON.stringify(created)}`)
  return created.id
}

async function main() {
  const args = options(process.argv.slice(2))
  const outDir = args['out-dir'] ?? join(ROOT, '.dsh-test/scope-proof')
  assert.ok(existsSync(APP), `build the app first: ${APP} is missing`)
  assert.ok(existsSync(CHROME), 'Google Chrome is required')

  const base = await mkdtemp(join(tmpdir(), 'newpi-scope-world-'))
  const world = await buildWorld(base)
  step(`isolated world: ${base}`)
  const captures = []

  const alpha = { id: 'alpha', name: 'Alpha', root: world.alpha, namespace: 'alpha-ns' }
  const beta = { id: 'beta', name: 'Beta', root: world.beta, namespace: 'beta-ns' }

  // The marker is unique to this run, so a match cannot come from stale state.
  const marker = `scope-proof-${Date.now()}`

  try {
    // ---------------------------------------------------------- Alpha open
    console.log('\n1. Alpha open')
    await writeRegistry(world, 'alpha', [alpha, beta])
    let app = launchApp(world)
    let url = await readyUrl(app, 'alpha')
    step(`runtime ready: ${url.split('?')[0]}`)
    let { page, close } = await openPage(url)

    let memory = await memoryPanel(page)
    assert.equal(memory.header, 'Alpha', `Memory must name the open project (got ${memory.header})`)
    captures.push(await shot(page, outDir, '01-alpha-memory.png'))
    let storage = await storagePanel(page)
    assert.equal(storage.header, `projet Alpha · ${world.alpha}`, `Storage header (got ${storage.header})`)
    assert.ok(
      storage.paths.includes(join(world.alpha, 'src-tauri/target')),
      `Storage must measure Alpha's own target (got ${storage.paths.filter((p) => p.includes('target')).join(', ')})`,
    )
    captures.push(await shot(page, outDir, '02-alpha-storage.png'))

    const memoryLine = /\[newpi\/memory\] projet=(\S+)/.exec(app.output())
    assert.equal(memoryLine?.[1], 'alpha', 'the launch log must name the open project')
    const port = Number(/\[newpi\/memory\] projet=\S+ port=(\d+)/.exec(app.output())?.[1])
    assert.ok(port > 0, 'the launch log must name the sidecar port')

    // A real row in Alpha's namespace, written through the sidecar's own API.
    await seedMemory(world, port, 'alpha-ns', `${marker} alpha only`)
    memory = await memoryPanel(page)
    assert.ok(memory.text.includes(marker), "Alpha's Memory must list its own row")
    step(`seeded and read ${marker} in alpha-ns`)

    await close()
    await app.stop()

    // ----------------------------------------------------------- Beta open
    console.log('\n2. Beta open (the switch)')
    await writeRegistry(world, 'beta', [alpha, beta])
    app = launchApp(world)
    url = await readyUrl(app, 'beta')
    ;({ page, close } = await openPage(url))

    memory = await memoryPanel(page)
    assert.equal(memory.header, 'Beta', `Memory must switch to the open project (got ${memory.header})`)
    assert.ok(
      !memory.text.includes(marker),
      "Alpha's memory must never be listed under Beta",
    )
    captures.push(await shot(page, outDir, '03-beta-memory.png'))
    storage = await storagePanel(page)
    assert.equal(storage.header, `projet Beta · ${world.beta}`, `Storage header (got ${storage.header})`)
    assert.ok(
      storage.paths.includes(join(world.beta, 'src-tauri/target')),
      `Storage targets must be recomputed for Beta (got ${storage.paths.filter((p) => p.includes('target')).join(', ')})`,
    )
    assert.ok(
      !storage.paths.includes(join(world.alpha, 'src-tauri/target')),
      "Storage must not keep Alpha's target after the switch",
    )
    captures.push(await shot(page, outDir, '04-beta-storage.png'))

    await close()
    await app.stop()

    // ------------------------------------------------------- no project open
    console.log('\n3. no project open')
    await writeRegistry(world, null, [])
    app = launchApp(world)
    url = await readyUrl(app, 'no-project')
    ;({ page, close } = await openPage(url))

    memory = await memoryPanel(page)
    assert.equal(memory.header, 'Aucun projet ouvert', `Memory header (got ${memory.header})`)
    assert.ok(!memory.text.includes(marker), 'no memory may be listed without a project')
    captures.push(await shot(page, outDir, '05-no-project-memory.png'))
    storage = await storagePanel(page)
    assert.equal(storage.header, 'Aucun projet ouvert', `Storage header (got ${storage.header})`)
    // The global targets (caches, toolchains) are still measured: they belong to
    // no project. What must be gone is every target that hangs from a project
    // root — and the personal folder must not stand in for one.
    for (const forbidden of [
      join(world.home, 'src-tauri/target'),
      join(world.home, 'node_modules'),
      join(world.home, '.pnpm-store'),
      join(world.home, 'target'),
    ]) {
      assert.ok(
        !storage.paths.includes(forbidden),
        `the personal folder must not be measured as a project target: ${forbidden}`,
      )
    }
    assert.ok(
      !storage.paths.some((path) => path.includes('/src-tauri/target') || path.endsWith('/.pnpm-store')),
      'no project-scoped storage target may survive without a project',
    )
    captures.push(await shot(page, outDir, '06-no-project-storage.png'))

    const line = /\[newpi\/memory\] projet=(\S+)/.exec(app.output())
    assert.equal(line?.[1], '(aucun)', 'the launch log must claim no project')
    const homeText = await page.evaluate('document.body.innerText')
    assert.ok(
      !homeText.includes(`projet ${world.home}`),
      'the personal folder must never be labelled a project',
    )
    assert.ok(
      !homeText.includes(`projet Home`) && !homeText.includes(`projet home`),
      'the personal folder name must never stand in for a project name',
    )
    step('no personal folder is presented as a project')

    await close()
    await app.stop()

    console.log(`\nScope interface checks passed on the isolated application.\n`)
    for (const path of captures) console.log(`  ${path}`)
    console.log('')
  } finally {
    if (runningApp !== null) await runningApp.stop().catch(() => {})
    await rm(base, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error('\nScope interface check FAILED\n')
  console.error(error)
  process.exit(1)
})
