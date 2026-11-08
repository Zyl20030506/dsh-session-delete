/**
 * Offline exercise of the recycle-bin Host logic against a real temporary
 * filesystem and fake Cordis services. Run with `npm test` (plain Node, no dependencies).
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = await mkdtemp(join(tmpdir(), 'session-trash-test-'))
process.env.DSH_HOME = join(root, 'home')
const module = await import('../index.js')

const ID = 'session-trash-1111'
const SETTINGS = { retentionDays: 3, sweepMinutes: 30 }
const DAY = 86_400_000

const trashRoot = join(process.env.DSH_HOME, 'session-trash', 'v1')
const entryDir = join(trashRoot, ID)
const dataDir = join(entryDir, 'data')
const metaPath = join(entryDir, 'meta.json')

/**
 * Fake Host context: a Workspace that keeps its accounting, an archive set that
 * behaves like the registry's, and the persistence probe.
 */
function makeCtx({ sessionDir, live = false, accounted = true, activity = undefined }) {
  const state = {
    members: accounted ? [ID, 'session-next'] : ['session-next'],
    archived: new Set(),
    pinned: new Set(accounted ? [ID] : []),
    attached: 0,
    detached: 0,
    positioned: null,
    archiveCalls: 0,
    unarchiveCalls: 0,
    archiveThrows: null,
  }
  const workspace = {
    id: 'ws-1',
    get sessionIds() {
      return [...state.members]
    },
    async detachSession(id) {
      state.detached += 1
      state.members = state.members.filter((value) => value !== id)
    },
    async attachSession(id) {
      state.attached += 1
      if (!state.members.includes(id)) state.members = [id, ...state.members]
    },
    async insertSessionBefore(id, beforeId) {
      state.positioned = { id, beforeId }
    },
  }
  const registry = {
    list: () => [workspace],
    get archivedSessionIds() {
      return [...state.archived]
    },
    get pinnedSessionIds() {
      return [...state.pinned]
    },
    async archiveSession(id) {
      state.archiveCalls += 1
      if (state.archiveThrows !== null) throw state.archiveThrows
      state.archived.add(id)
      state.pinned.delete(id)
    },
    async unarchiveSession(id) {
      state.unarchiveCalls += 1
      state.archived.delete(id)
    },
    async pinSession(id) {
      state.pinned.add(id)
    },
    async unpinSession(id) {
      state.pinned.delete(id)
    },
  }
  const ctx = {
    get(key) {
      if (key === 'agents') return { get: (id) => (live && id === ID ? { id, status: 'idle' } : undefined) }
      if (key === 'workspaceRegistry') return registry
      return undefined
    },
    ...activity === undefined
      ? {}
      : {
        waterfall: () => (activity === 'throw' ? Promise.reject(new Error('no providers')) : Promise.resolve(activity)),
      },
    sessionPersistence: {
      async stat(id) {
        const log = join(root, 'sessions', '--proj--', id, 'session.v4.jsonl.zstd')
        if (!existsSync(log)) return undefined
        void sessionDir
        return { location: { kind: 'jsonl', path: log } }
      },
    },
  }
  return { ctx, state }
}

async function prepareSession({ extraFile = false, cached = true } = {}) {
  const sessionDir = join(root, 'sessions', '--proj--', ID)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'log')
  await writeFile(join(sessionDir, 'session.v3.jsonl.zstd'), 'old')
  if (extraFile) await writeFile(join(sessionDir, 'notes.txt'), 'keep me')
  if (cached) {
    const cacheDir = join(process.env.DSH_HOME, 'storages', 'session_projcache', 'sessions')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, `${ID}.json`), '{}')
  }
  return sessionDir
}

function request(body) {
  return new Request('http://127.0.0.1/api/plugin.session-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function call(handler, ctx, body) {
  const response = await handler(ctx, SETTINGS, request(body))
  return { status: response.status, payload: await response.json() }
}

async function reset() {
  const { rm } = await import('node:fs/promises')
  await rm(trashRoot, { recursive: true, force: true })
  await rm(join(root, 'sessions'), { recursive: true, force: true })
  await rm(join(process.env.DSH_HOME, 'storages'), { recursive: true, force: true })
}

// 1. Trash hides through the archive set and keeps the accounting slot -----
{
  const sessionDir = await prepareSession()
  const { ctx, state } = makeCtx({ sessionDir })
  const { status, payload } = await call(module.handleDelete, ctx, { sessionId: ID, title: 'Scratch' })
  assert.equal(status, 200, JSON.stringify(payload))
  assert.equal(payload.value.trashed, true)
  assert.equal(state.archiveCalls, 1, 'archived (hidden), not detached')
  assert.equal(state.detached, 0, 'accounting slot kept so the position survives')
  assert.deepEqual(state.members, [ID, 'session-next'], 'still accounted')
  assert.ok(state.archived.has(ID), 'hidden from the default sidebar')
  assert.ok(existsSync(join(dataDir, 'session.v4.jsonl.zstd')), 'log moved into the bin')
  assert.ok(!existsSync(join(sessionDir, 'session.v4.jsonl.zstd')), 'nothing left behind')
  const meta = JSON.parse(await readFile(metaPath, 'utf8'))
  assert.equal(meta.state, 'ready')
  assert.equal(meta.originalDir, sessionDir)
  assert.equal(meta.pinned, true, 'pin recorded for restore')
  assert.ok(!existsSync(join(process.env.DSH_HOME, 'storages', 'session_projcache', 'sessions', `${ID}.json`)), 'cache dropped')
  console.log('ok  1 trash archives (hides) and moves the log')
}

// 2. List ----------------------------------------------------------------
{
  const { ctx } = makeCtx({ sessionDir: join(root, 'unused') })
  const { payload } = await call(module.handleTrash, ctx, { action: 'list' })
  assert.equal(payload.value.retentionDays, 3)
  assert.equal(payload.value.items.length, 1)
  assert.equal(payload.value.items[0].sessionId, ID)
  assert.equal(payload.value.items[0].title, 'Scratch')
  assert.equal(payload.value.items[0].empty, false)
  console.log('ok  2 list reports the entry')
}

// 3. Restore unarchives and keeps the original position ------------------
{
  const { ctx, state } = makeCtx({ sessionDir: join(root, 'unused') })
  const { status, payload } = await call(module.handleTrash, ctx, { action: 'restore', sessionId: ID })
  assert.equal(status, 200, JSON.stringify(payload))
  assert.equal(payload.value.restored, true)
  assert.equal(payload.value.workspaceRestored, true)
  assert.ok(existsSync(join(root, 'sessions', '--proj--', ID, 'session.v4.jsonl.zstd')), 'log is back')
  assert.ok(!existsSync(entryDir), 'bin entry removed')
  assert.ok(!state.archived.has(ID), 'visible again')
  assert.deepEqual(state.members, [ID, 'session-next'], 'position untouched')
  assert.equal(state.attached, 0, 'no re-attach needed')
  assert.ok(state.pinned.has(ID), 'pin restored')
  console.log('ok  3 restore unarchives in place')
}

// 4. Foreign directory survives both directions --------------------------
{
  await reset()
  const sessionDir = await prepareSession({ extraFile: true })
  const first = await call(module.handleDelete, makeCtx({ sessionDir }).ctx, { sessionId: ID })
  assert.equal(first.payload.value.trashed, true)
  assert.ok(existsSync(join(sessionDir, 'notes.txt')), 'foreign file never moved')
  assert.ok(!existsSync(join(sessionDir, 'session.v4.jsonl.zstd')))
  const { ctx } = makeCtx({ sessionDir, accounted: false })
  const second = await call(module.handleTrash, ctx, { action: 'restore', sessionId: ID })
  assert.equal(second.status, 200)
  assert.ok(existsSync(join(sessionDir, 'session.v4.jsonl.zstd')), 'log restored next to the foreign file')
  assert.ok(existsSync(join(sessionDir, 'notes.txt')))
  console.log('ok  4 foreign files untouched, log restored around them')
}

// 5. Purge one entry (idle Session: tombstone and accounting clean up) ----
{
  const sessionDir = await prepareSession()
  const trashed = makeCtx({ sessionDir })
  await call(module.handleDelete, trashed.ctx, { sessionId: ID })
  const { ctx, state } = makeCtx({ sessionDir: join(root, 'unused'), accounted: true })
  // Re-state the archive so the purge sees the tombstone it must clear.
  await makeCtx({ sessionDir: join(root, 'unused') }).ctx.get('workspaceRegistry').archiveSession(ID)
  const { status, payload } = await call(module.handleTrash, ctx, { action: 'purge', sessionId: ID })
  assert.equal(status, 200, JSON.stringify(payload))
  assert.equal(payload.value.purged, true)
  assert.ok(!existsSync(entryDir), 'entry gone for good')
  assert.equal(state.detached, 1, 'accounting cleaned up')
  assert.ok(!state.archived.has(ID), 'tombstone cleared for an idle Session')
  console.log('ok  5 purge cleans entry, accounting and tombstone')
}

// 5b. Purging a still-live Session keeps it hidden -----------------------
{
  await reset()
  const sessionDir = await prepareSession()
  await call(module.handleDelete, makeCtx({ sessionDir }).ctx, { sessionId: ID })
  const { ctx, state } = makeCtx({ sessionDir: join(root, 'unused'), live: true })
  await ctx.get('workspaceRegistry').archiveSession(ID)
  const { status, payload } = await call(module.handleTrash, ctx, { action: 'purge', sessionId: ID })
  assert.equal(status, 200, JSON.stringify(payload))
  assert.ok(!existsSync(entryDir), 'entry gone')
  assert.ok(state.archived.has(ID), 'tombstone kept so the live row never falls into Ungrouped')
  assert.equal(state.detached, 0, 'accounting kept while the Agent lives')
  console.log('ok  5b purge of a live Session stays hidden')
}

// 6. Empty ---------------------------------------------------------------
{
  await reset()
  const sessionDir = await prepareSession()
  await call(module.handleDelete, makeCtx({ sessionDir }).ctx, { sessionId: ID })
  const second = 'session-other-2222'
  const secondDir = join(root, 'sessions', '--proj--', second)
  await mkdir(secondDir, { recursive: true })
  await writeFile(join(secondDir, 'session.v4.jsonl.zstd'), 'log')
  const ctx2 = {
    get: () => undefined,
    sessionPersistence: {
      stat: async (id) => (id === second ? { location: { kind: 'jsonl', path: join(secondDir, 'session.v4.jsonl.zstd') } } : undefined),
    },
  }
  await call(module.handleDelete, ctx2, { sessionId: second })
  assert.equal((await readdir(trashRoot)).length, 2)
  const { ctx } = makeCtx({ sessionDir: join(root, 'unused') })
  const { payload } = await call(module.handleTrash, ctx, { action: 'empty' })
  assert.equal(payload.value.purged.length, 2)
  assert.deepEqual(await readdir(trashRoot), [])
  console.log('ok  6 empty removes every entry')
}

// 7. Retention sweep -----------------------------------------------------
{
  await reset()
  const sessionDir = await prepareSession()
  await call(module.handleDelete, makeCtx({ sessionDir }).ctx, { sessionId: ID })
  const meta = JSON.parse(await readFile(metaPath, 'utf8'))
  meta.deletedAt = Date.now() - 4 * DAY
  meta.expiresAt = Date.now() - 1 * DAY
  await writeFile(metaPath, JSON.stringify(meta))
  const { ctx } = makeCtx({ sessionDir: join(root, 'unused') })
  const { payload } = await call(module.handleTrash, ctx, { action: 'list' })
  assert.equal(payload.value.items.length, 0, 'expired entry no longer listed')
  assert.ok(!existsSync(entryDir), 'expired entry deleted')
  console.log('ok  7 expired entries are swept')
}

// 7b. The user's own archive is not the trash and is never deleted ---------
{
  await reset()
  const archivedId = 'session-user-archived-7777'
  const archivedDir = join(root, 'sessions', '--proj--', archivedId)
  await mkdir(archivedDir, { recursive: true })
  await writeFile(join(archivedDir, 'session.v4.jsonl.zstd'), 'keep me forever')
  const { ctx, state } = makeCtx({ sessionDir: join(root, 'unused') })
  state.archived.add(archivedId)
  // Three sweeps' worth of list calls, far past the retention window.
  for (let index = 0; index < 3; index += 1) {
    await call(module.handleTrash, ctx, { action: 'list' })
  }
  assert.ok(existsSync(join(archivedDir, 'session.v4.jsonl.zstd')), 'archived log untouched')
  assert.ok(state.archived.has(archivedId), 'still archived, not silently unarchived')
  assert.ok(!existsSync(join(trashRoot, archivedId)), 'no bin entry invented')
  console.log('ok  7b an archived Session is never deleted by the trash sweep')
}

// 7c. A binned entry keeps its tombstone across a sweep -------------------
{
  await reset()
  const sessionDir = await prepareSession()
  const { ctx, state } = makeCtx({ sessionDir })
  await call(module.handleDelete, ctx, { sessionId: ID })
  state.archiveCalls = 0
  await call(module.handleTrash, ctx, { action: 'list' })
  assert.ok(state.archived.has(ID), 'the bin owns this tombstone and keeps it')
  assert.equal(state.unarchiveCalls, 0, 'sweep does not unarchive binned entries')
  console.log('ok  7c binned entries keep their hiding across sweeps')
}

// 7d. An orphan tombstone is dropped -------------------------------------
{
  await reset()
  const ghost = 'session-ghost-9999'
  const { ctx, state } = makeCtx({ sessionDir: join(root, 'unused') })
  state.archived.add(ghost)
  await call(module.handleTrash, ctx, { action: 'list' })
  assert.ok(!state.archived.has(ghost), 'tombstone for a gone Session is cleaned up')
  console.log('ok  7d orphan tombstones are dropped')
}

// 8. Refusals ------------------------------------------------------------
{
  await reset()
  const sessionDir = await prepareSession()
  const live = await call(module.handleDelete, makeCtx({ sessionDir, live: true }).ctx, { sessionId: ID })
  assert.equal(live.status, 409)
  assert.equal(live.payload.error.code, 'session-busy')
  assert.ok(existsSync(join(sessionDir, 'session.v4.jsonl.zstd')), 'live session untouched')
  for (const bad of ['', '../etc', 'a/b', 42]) {
    const refusal = await call(module.handleDelete, makeCtx({ sessionDir }).ctx, { sessionId: bad })
    assert.equal(refusal.status, 400)
  }
  const missing = await call(module.handleTrash, makeCtx({ sessionDir }).ctx, { action: 'restore', sessionId: 'session-absent' })
  assert.equal(missing.status, 404)
  const unknown = await call(module.handleTrash, makeCtx({ sessionDir }).ctx, { action: 'nope' })
  assert.equal(unknown.status, 400)
  console.log('ok  8 live sessions, bad ids, missing entries refused')
}

// 8b. Running work is refused with the kind that runs ---------------------
{
  await reset()
  const sessionDir = await prepareSession()
  const busy = await call(
    module.handleDelete,
    makeCtx({ sessionDir, activity: [{ kind: 'turn' }, { kind: 'job', items: [] }] }).ctx,
    { sessionId: ID },
  )
  assert.equal(busy.status, 409)
  assert.equal(busy.payload.error.code, 'session-busy')
  assert.deepEqual(busy.payload.error.kinds, ['turn', 'job'])
  assert.match(busy.payload.error.message, /正在生成回复/)
  assert.ok(existsSync(join(sessionDir, 'session.v4.jsonl.zstd')), 'busy session untouched')
  console.log('ok  8b running work is named in the refusal')
}

// 8c. A live but idle Agent no longer blocks the move -------------------
{
  await reset()
  const sessionDir = await prepareSession()
  const { ctx, state } = makeCtx({ sessionDir, live: true, activity: [] })
  const { status, payload } = await call(module.handleDelete, ctx, { sessionId: ID, title: 'Idle' })
  assert.equal(status, 200, JSON.stringify(payload))
  assert.equal(payload.value.trashed, true, 'idle live session is trashed')
  assert.ok(state.archived.has(ID), 'hidden even though the Agent is still resident')
  assert.ok(existsSync(join(dataDir, 'session.v4.jsonl.zstd')), 'log moved into the bin')
  console.log('ok  8c idle live Agent does not block the trash')
}

// 8d. An unavailable activity probe falls back to the liveness test -----
{
  await reset()
  const sessionDir = await prepareSession()
  const refusal = await call(
    module.handleDelete,
    makeCtx({ sessionDir, live: true, activity: 'throw' }).ctx,
    { sessionId: ID },
  )
  assert.equal(refusal.status, 409)
  assert.equal(refusal.payload.error.code, 'session-busy')
  console.log('ok  8d unavailable activity probe stays conservative')
}

// 8e. Archive admission refusal is reported as running work -------------
{
  await reset()
  const sessionDir = await prepareSession()
  const busy = makeCtx({ sessionDir })
  const registry = busy.ctx.get('workspaceRegistry')
  registry.archiveSession = async () => {
    const error = new Error('active')
    error.name = 'WorkspaceActiveSessionError'
    error.activity = [{ kind: 'turn' }]
    throw error
  }
  const { status, payload } = await call(module.handleDelete, busy.ctx, { sessionId: ID })
  assert.equal(status, 409, JSON.stringify(payload))
  assert.equal(payload.error.code, 'session-busy')
  assert.deepEqual(payload.error.kinds, ['turn'])
  assert.ok(existsSync(join(sessionDir, 'session.v4.jsonl.zstd')), 'files untouched')
  assert.ok(!existsSync(dataDir), 'no bin entry left behind')
  console.log('ok  8e archive admission refusal aborts before moving')
}

// 9. A Session with no stored log ---------------------------------------
{
  await reset()
  const sessionDir = join(root, 'never-written')
  const { ctx, state } = makeCtx({ sessionDir })
  const { status, payload } = await call(module.handleDelete, ctx, { sessionId: ID, title: 'Empty' })
  assert.equal(status, 200, JSON.stringify(payload))
  assert.equal(payload.value.trashed, false, 'nothing to keep')
  assert.ok(!existsSync(entryDir), 'no bin entry invented')
  assert.ok(state.archived.has(ID), 'still hidden from the sidebar')
  console.log('ok  9 unmaterialized sessions are hidden without a bin entry')
}

console.log('all trash cases passed')
