/**
 * Host half of the session-delete bundle: a recycle bin for Sessions.
 *
 * Trashing moves the Session-owned log directory out of the persistence root
 * into `<DSH_HOME>/session-trash/v1/<sessionId>/data/`, writes a `meta.json`
 * beside it, and detaches the id from its Workspace. Because the log leaves the
 * root, the sidebar, the Session list, and the search index stop seeing the
 * Session immediately — without destroying anything.
 *
 * Restoring moves those files back to their recorded absolute path, drops the
 * bin entry, and re-attaches the id to its Workspace at the remembered
 * position. Purging (manually, or by the retention sweep) removes the bin entry
 * for good.
 *
 * Two authenticated Fetch routes serve the browser half:
 *   POST /api/plugin.session-delete   { sessionId, title }        → trash
 *   POST /api/plugin.session-trash    { action, sessionId? }      → list/restore/purge/empty
 *
 * The persistence seam still has no deletion API by design, so the sweep and
 * purge delete files the backend owns. Guards stay narrow: only canonical
 * Session generations are moved or removed, a Session that is still open in
 * the Host is refused, and a bin entry whose manifest is unreadable is left
 * alone instead of guessed at.
 *
 * @module @local/session-delete
 */
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat as statPath,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** Plugin log prefix. */
export const name = 'session-delete'

/** The route and the services the operation needs. */
export const inject = ['connection', 'sessionPersistence']

const ROUTE_DELETE = '/api/plugin.session-delete'
const ROUTE_TRASH = '/api/plugin.session-trash'

/** Session ids are one safe path segment: letters, digits, underscore, dash. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/

/** A canonical log filename, possibly a released generation or compressed. */
const LOG_FILE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/

/** Anything a Session-owned directory may legitimately contain. */
const LOG_DIR_ENTRY = /^(?:session(?:\.v\d+)?\.jsonl(?:\.zstd)?|session\.lock)$/

/** Manifest version; a raised number means the layout below changed. */
const TRASH_VERSION = 1

const DAY_MS = 86_400_000

/**
 * Register both routes, sweep on activation, and keep a sweep timer.
 * @param ctx - Host context carrying the connection and Session persistence.
 * @param config - `{ retentionDays, sweepMinutes }` from the bundle patch.
 */
export function apply(ctx, config = {}) {
  const settings = {
    retentionDays: positive(config.retentionDays, 3),
    sweepMinutes: positive(config.sweepMinutes, 30),
  }
  const connection = ctx.get('connection')
  if (connection === undefined) return
  ctx.effect(() => {
    const disposers = [
      connection.fetch.register({
        path: ROUTE_DELETE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleDelete(ctx, settings, request),
      }),
      connection.fetch.register({
        path: ROUTE_TRASH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleTrash(ctx, settings, request),
      }),
    ]
    const timer = setInterval(() => {
      void sweep(ctx, settings).catch(() => {})
    }, Math.max(1, settings.sweepMinutes) * 60_000)
    timer.unref?.()
    void sweep(ctx, settings).catch(() => {})
    return () => {
      clearInterval(timer)
      for (const dispose of disposers) void dispose()
    }
  }, 'session-delete: routes and sweep')
}

/**
 * Move one Session into the recycle bin.
 * @param ctx - Host context.
 * @param settings - resolved `{ retentionDays, sweepMinutes }`.
 * @param request - admitted browser request carrying `{ sessionId, title }`.
 * @returns JSON outcome.
 */
export async function handleDelete(ctx, settings, request) {
  const body = await bodyOf(request)
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  const title = typeof body?.title === 'string' ? body.title.slice(0, 200) : ''
  if (!SESSION_ID.test(sessionId)) {
    return reply(400, {
      ok: false,
      error: { code: 'invalid-session', message: '会话标识无效，未执行任何操作。' },
    })
  }
  // Capabilities this build needs before it may move a single file. A missing
  // one would leave a half-trashed Session (log moved, row still visible), so
  // refuse up front with a readable reason instead.
  const missing = missingCapabilities(ctx)
  if (missing.length > 0) {
    return reply(409, {
      ok: false,
      error: {
        code: 'incompatible',
        missing,
        message: `插件与当前 DSH 版本不兼容（缺少 ${missing.join('、')}），未执行任何操作。`,
      },
    })
  }
  // A live Agent object is not the same thing as "open in a window": the Host
  // keeps Agents for Sessions the page merely visited, and those idle Agents do
  // not hold the log file (an idle rename succeeds). What actually blocks a safe
  // move is running work, so ask the composition's own activity providers, and
  // keep the loop's own `status` as a second, independent signal in case that
  // event's providers ever change shape.
  const activity = await activityOf(ctx, sessionId)
  const running = isRunning(ctx, sessionId)
  if (running || (activity === null ? isLive(ctx, sessionId) : activity.length > 0)) {
    return reply(409, busyRefusal(activity ?? [], running))
  }

  try {
    const value = await serialize(() => trashSession(ctx, settings, sessionId, title))
    return reply(200, { ok: true, value })
  } catch (error) {
    if (error?.code === 'session-busy') {
      const kinds = Array.isArray(error.kinds) ? error.kinds : []
      return reply(409, { ok: false, error: { code: 'session-busy', kinds, message: busyMessage(kinds) } })
    }
    return reply(error?.code === 'file-busy' ? 409 : 500, failure(error))
  }
}

/**
 * Serve one recycle-bin operation.
 * @param ctx - Host context.
 * @param settings - resolved retention policy.
 * @param request - admitted browser request carrying `{ action }`.
 * @returns JSON outcome.
 */
export async function handleTrash(ctx, settings, request) {
  const body = await bodyOf(request)
  const action = typeof body?.action === 'string' ? body.action : ''
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''

  if (action === 'list') {
    try {
      await serialize(() => sweep(ctx, settings))
      const value = await listTrash(ctx, settings)
      return reply(200, { ok: true, value })
    } catch (error) {
      return reply(500, failure(error))
    }
  }

  if (action !== 'restore' && action !== 'purge' && action !== 'empty') {
    return reply(400, {
      ok: false,
      error: { code: 'invalid-action', message: '未知的回收站操作。' },
    })
  }
  if (action !== 'empty' && !SESSION_ID.test(sessionId)) {
    return reply(400, {
      ok: false,
      error: { code: 'invalid-session', message: '会话标识无效。' },
    })
  }

  try {
    const value = action === 'empty'
      ? await serialize(() => emptyTrash(ctx))
      : action === 'purge'
        ? await serialize(() => purgeEntry(ctx, sessionId))
        : await serialize(() => restoreSession(ctx, sessionId))
    return reply(200, { ok: true, value })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const missing = message === 'not-found'
    return reply(missing ? 404 : 500, {
      ok: false,
      error: {
        code: missing ? 'not-in-trash' : 'trash-failed',
        message: missing ? '回收站里没有这个会话。' : message,
      },
    })
  }
}

/**
 * Move a Session's log files into the bin and hide the row.
 *
 * Hiding uses the Workspace archive set rather than detaching the account: a
 * detached id falls into the sidebar's "ungrouped" bucket, and the Host keeps
 * listing a Session for as long as an Agent for it lives in memory, so a
 * detached live Session would keep showing up there. Archiving removes the row
 * from the default list for good (the archived filter is the only place it can
 * appear) while keeping its position, which also makes restore exact.
 *
 * @param ctx - Host context.
 * @param settings - resolved retention policy.
 * @param sessionId - Session to trash.
 * @param title - display title recorded for the bin list.
 * @returns the outcome reported to the browser.
 */
async function trashSession(ctx, settings, sessionId, title) {
  const entry = entryDir(sessionId)
  if (await exists(metaPath(sessionId))) throw new Error('这个会话已经在回收站里。')
  if (await exists(entry)) await rm(entry, { recursive: true, force: true })

  const sourceDir = await logDirectoryOf(ctx, sessionId)
  const record = workspaceRecord(ctx, sessionId)
  const deletedAt = Date.now()
  const names = sourceDir === undefined ? [] : await readdir(sourceDir).catch(() => [])
  const movable = names.filter((name) => LOG_DIR_ENTRY.test(name))
  const manifest = {
    version: TRASH_VERSION,
    sessionId,
    state: 'moving',
    title,
    deletedAt,
    expiresAt: deletedAt + settings.retentionDays * DAY_MS,
    originalDir: sourceDir ?? null,
    ...record,
  }

  // Nothing durable to keep: hiding the row is the whole operation.
  if (movable.length === 0) {
    await hide(ctx, sessionId)
    await removeProjectionCache(ctx, sessionId)
    return {
      sessionId,
      title,
      trashed: false,
      retentionDays: settings.retentionDays,
      expiresAt: null,
      workspaceIds: record.workspaceIds,
      removedPaths: [],
    }
  }

  const moved = []
  await mkdir(dataDir(sessionId), { recursive: true })
  // The manifest lands before the first move, so an interrupted trash still
  // leaves a recoverable entry instead of files nobody can find.
  await writeFile(metaPath(sessionId), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  try {
    // Hide first, while the log still exists: archive admission probes the
    // Session, and a failure here must not cost the user their history.
    await hide(ctx, sessionId)
    for (const name of movable) {
      await moveFile(join(sourceDir, name), join(dataDir(sessionId), name))
      moved.push(name)
    }
    const left = await readdir(sourceDir).catch(() => [])
    if (left.length === 0) await rmdir(sourceDir).catch(() => {})
    manifest.state = 'ready'
    await writeFile(metaPath(sessionId), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await removeProjectionCache(ctx, sessionId)
  } catch (error) {
    await rollBackMove(sessionId, sourceDir, moved)
    await unhide(ctx, sessionId)
    throw error
  }

  return {
    sessionId,
    title,
    trashed: true,
    retentionDays: settings.retentionDays,
    expiresAt: manifest.expiresAt,
    workspaceIds: record.workspaceIds,
    removedPaths: [dataDir(sessionId)],
  }
}

/**
 * Rename one file, turning an OS sharing violation into an explicit refusal so
 * the browser can say "still in use" instead of showing a raw POSIX code.
 * @param from - current path.
 * @param to - target path.
 */
async function moveFile(from, to) {
  try {
    await rename(from, to)
  } catch (error) {
    if (error?.code === 'EBUSY' || error?.code === 'EPERM' || error?.code === 'EACCES') {
      const busy = new Error('file-busy')
      busy.code = 'file-busy'
      throw busy
    }
    throw error
  }
}

/**
 * Undo a partially moved trash: hand every file back and drop the entry.
 * @param sessionId - entry being rolled back.
 * @param sourceDir - original Session-owned directory.
 * @param moved - file names already moved.
 */
async function rollBackMove(sessionId, sourceDir, moved) {
  for (const name of moved) {
    await rename(join(dataDir(sessionId), name), join(sourceDir, name)).catch(() => {})
  }
  await rm(entryDir(sessionId), { recursive: true, force: true }).catch(() => {})
}

/**
 * Put a binned Session back where it came from and make it visible again.
 * @param ctx - Host context.
 * @param sessionId - Session to restore.
 * @returns the outcome reported to the browser.
 */
async function restoreSession(ctx, sessionId) {
  const meta = await readMeta(sessionId)
  if (meta === undefined) throw new Error('not-found')
  const target = typeof meta.originalDir === 'string' && basename(meta.originalDir) === sessionId
    ? meta.originalDir
    : undefined
  if (target === undefined) throw new Error('回收站记录里没有原始目录，无法恢复。')

  await mkdir(target, { recursive: true })
  const data = dataDir(sessionId)
  const names = await readdir(data).catch(() => [])
  for (const name of names) {
    if (!LOG_DIR_ENTRY.test(name)) continue
    await moveFile(join(data, name), join(target, name))
  }
  await rm(entryDir(sessionId), { recursive: true, force: true })

  await unhide(ctx, sessionId)
  await reaccount(ctx, sessionId, meta)
  if (meta.pinned === true) {
    const registry = ctx.get('workspaceRegistry')
    try {
      await registry?.pinSession?.(sessionId)
    } catch {
      // The pin was best-effort state; the Session itself is back.
    }
  }
  return { sessionId, restored: true, workspaceRestored: true, path: target }
}

/**
 * Remove one bin entry for good.
 * @param ctx - Host context.
 * @param sessionId - Session to purge.
 * @returns the outcome reported to the browser.
 */async function purgeEntry(ctx, sessionId) {
  if (!await exists(entryDir(sessionId))) throw new Error('not-found')
  await rm(entryDir(sessionId), { recursive: true, force: true })
  await forget(ctx, sessionId)
  return { sessionId, purged: true }
}

/**
 * Remove every bin entry for good.
 * @param ctx - Host context.
 * @returns the outcome reported to the browser.
 */
async function emptyTrash(ctx) {
  const entries = await listEntries()
  for (const entry of entries) {
    await rm(entryDir(entry.sessionId), { recursive: true, force: true })
    await forget(ctx, entry.sessionId)
  }
  return { purged: entries.map((entry) => entry.sessionId) }
}

/**
 * Delete bin entries whose retention expired, and drop archive tombstones that
 * no longer hide anything (no log, no live Agent).
 * @param ctx - Host context.
 * @param settings - resolved retention policy.
 */
async function sweep(ctx, settings) {
  const entries = await listEntries()
  const now = Date.now()
  for (const entry of entries) {
    const deadline = Number.isFinite(entry.expiresAt)
      ? entry.expiresAt
      : entry.deletedAt + settings.retentionDays * DAY_MS
    if (deadline > now) continue
    await rm(entryDir(entry.sessionId), { recursive: true, force: true })
    await forget(ctx, entry.sessionId)
  }
  await pruneTombstones(ctx)
  await reconcileEntries(ctx)
}

/**
 * Drop archived ids that hide nothing any more: no log, no Agent, and no bin
 * entry that owns the tombstone.
 *
 * Archived-but-never-trashed Sessions are deliberately skipped: the user's own
 * archive is a different feature, its log still lives in the persistence root,
 * and nothing here may outlive it. A binned entry also keeps its tombstone, so
 * a resident Agent can never push the row back into the sidebar.
 *
 * @param ctx - Host context.
 */
async function pruneTombstones(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || !Array.isArray(registry.archivedSessionIds)) return
  const binned = new Set((await listEntries()).map((entry) => entry.sessionId))
  for (const sessionId of [...registry.archivedSessionIds]) {
    if (binned.has(sessionId)) continue
    if (isLive(ctx, sessionId)) continue
    if (await logDirectoryOf(ctx, sessionId) !== undefined) continue
    try {
      await registry.unarchiveSession(sessionId)
    } catch {
      // A refusing unarchive leaves state unchanged; the next sweep retries.
    }
  }
}

/**
 * Permanently forget a Session: clear its pin, keep it hidden while an Agent
 * still lives (so a live row never falls back into "ungrouped"), and drop the
 * accounting once nothing can bring it back.
 * @param ctx - Host context.
 * @param sessionId - Session leaving the bin.
 */
async function forget(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  try {
    if (Array.isArray(registry.pinnedSessionIds) && registry.pinnedSessionIds.includes(sessionId)) {
      await registry.unpinSession(sessionId)
    }
  } catch {
    // Pin cleanup is cosmetic.
  }
  if (isLive(ctx, sessionId)) return
  await unhide(ctx, sessionId)
  for (const workspace of registry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue
    try {
      if (typeof workspace.detachSession === 'function') await workspace.detachSession(sessionId)
    } catch {
      // A dangling account entry is filtered by the next projection read.
    }
  }
}

/**
 * Hide a Session from the sidebar through the Workspace archive set.
 * @param ctx - Host context.
 * @param sessionId - Session to hide.
 */
async function hide(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  try {
    await registry.archiveSession(sessionId)
  } catch (error) {
    if (error?.name === 'WorkspaceActiveSessionError') {
      const busy = new Error('session-busy')
      busy.code = 'session-busy'
      busy.kinds = [...new Set((error.activity ?? []).map((entry) => String(entry?.kind ?? 'work')))]
      throw busy
    }
    throw error
  }
}

/**
 * Make a hidden Session visible again.
 * @param ctx - Host context.
 * @param sessionId - Session to show.
 */
async function unhide(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  try {
    await registry.unarchiveSession(sessionId)
  } catch {
    // Already visible, or the registry refused; nothing else to do here.
  }
}

/**
 * Put a restored Session back into the Workspace recorded in its manifest when
 * its accounting was already gone. Manifests written before archive-hiding
 * detached the id instead of archiving it, so those restores need this.
 * @param ctx - Host context.
 * @param sessionId - restored Session.
 * @param meta - its bin manifest.
 */
async function reaccount(ctx, sessionId, meta) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof meta.workspaceId !== 'string') return
  const workspaces = registry.list()
  if (workspaces.some((workspace) => workspace.sessionIds.includes(sessionId))) return
  const workspace = workspaces.find((candidate) => String(candidate.id) === meta.workspaceId)
  if (workspace === undefined) return
  try {
    await workspace.attachSession(sessionId)
  } catch {
    return
  }
  const anchor = typeof meta.beforeSessionId === 'string'
    && meta.beforeSessionId !== sessionId
    && workspace.sessionIds.includes(meta.beforeSessionId)
    ? meta.beforeSessionId
    : undefined
  if (anchor === undefined || typeof workspace.insertSessionBefore !== 'function') return
  try {
    await workspace.insertSessionBefore(sessionId, anchor)
  } catch {
    // Position is cosmetic once the Session is accounted again.
  }
}

/**
 * Keep binned Sessions hidden. A Session whose Agent is still resident is
 * listed by the live-preferred query, so an entry without an archive tombstone
 * would surface as an "ungrouped" row. Manifests written before archive-hiding
 * need this repair; new trashes archive up front.
 * @param ctx - Host context.
 */
async function reconcileEntries(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || !Array.isArray(registry.archivedSessionIds)) return
  for (const entry of await listEntries()) {
    if (registry.archivedSessionIds.includes(entry.sessionId)) continue
    if (!isLive(ctx, entry.sessionId)) continue
    try {
      await registry.archiveSession(entry.sessionId)
    } catch {
      // Refusing admission leaves the entry as it was.
    }
  }
}

/**
 * Read the bin for the browser.
 * @param ctx - Host context, for the capability self-check.
 * @param settings - resolved retention policy.
 * @returns items, the retention the list was filtered by, and missing capabilities.
 */
async function listTrash(ctx, settings) {
  const entries = await listEntries()
  entries.sort((left, right) => right.deletedAt - left.deletedAt)
  return {
    retentionDays: settings.retentionDays,
    missing: missingCapabilities(ctx),
    items: entries.map((entry) => ({
      sessionId: entry.sessionId,
      title: typeof entry.title === 'string' ? entry.title : '',
      deletedAt: entry.deletedAt,
      expiresAt: entry.expiresAt,
      empty: entry.empty,
    })),
  }
}

/**
 * Capabilities a safe trash needs. `sessionPersistence.stat` locates the log,
 * and the Workspace registry both hides and restores the row; without them this
 * build would move history while leaving the sidebar inconsistent.
 * @param ctx - Host context.
 * @returns human-readable names of the missing capabilities.
 */
function missingCapabilities(ctx) {
  const registry = ctx.get('workspaceRegistry')
  const missing = []
  if (typeof ctx?.sessionPersistence?.stat !== 'function') missing.push('sessionPersistence.stat')
  if (typeof registry?.archiveSession !== 'function') missing.push('workspaceRegistry.archiveSession')
  if (typeof registry?.unarchiveSession !== 'function') missing.push('workspaceRegistry.unarchiveSession')
  if (typeof registry?.list !== 'function') missing.push('workspaceRegistry.list')
  if (typeof ctx?.waterfall !== 'function') missing.push('events.waterfall')
  return missing
}

/**
 * Read every usable bin entry. A directory whose manifest is missing or
 * unreadable is skipped: guessing would risk deleting or restoring the wrong
 * files.
 * @returns bin entries with a file count.
 */
async function listEntries() {
  const root = trashRoot()
  const names = await readdir(root, { withFileTypes: true }).catch(() => [])
  const entries = []
  for (const dirent of names) {
    if (!dirent.isDirectory() || !SESSION_ID.test(dirent.name)) continue
    const meta = await readMeta(dirent.name)
    if (meta === undefined) continue
    const files = await readdir(dataDir(dirent.name)).catch(() => [])
    entries.push({
      ...meta,
      sessionId: dirent.name,
      deletedAt: Number(meta.deletedAt) || 0,
      expiresAt: Number(meta.expiresAt) || 0,
      empty: files.length === 0,
    })
  }
  return entries
}

/**
 * Read and validate one manifest.
 * @param sessionId - candidate entry id.
 * @returns the manifest, or undefined when absent or unusable.
 */
async function readMeta(sessionId) {
  if (!SESSION_ID.test(sessionId)) return undefined
  try {
    const value = JSON.parse(await readFile(metaPath(sessionId), 'utf8'))
    if (value === null || typeof value !== 'object') return undefined
    if (value.version !== TRASH_VERSION) return undefined
    if (value.sessionId !== sessionId) return undefined
    return value
  } catch {
    return undefined
  }
}

/**
 * The Workspace that accounted the Session, with the neighbours needed to put
 * it back in place.
 * @param ctx - Host context.
 * @param sessionId - Session being trashed.
 * @returns recorded position and tombstones.
 */
function workspaceRecord(ctx, sessionId) {
  const record = {
    workspaceIds: [],
    workspaceId: null,
    workspaceIndex: -1,
    beforeSessionId: null,
    archived: false,
    pinned: false,
  }
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return record
  if (Array.isArray(registry.archivedSessionIds)) record.archived = registry.archivedSessionIds.includes(sessionId)
  if (Array.isArray(registry.pinnedSessionIds)) record.pinned = registry.pinnedSessionIds.includes(sessionId)
  for (const workspace of registry.list()) {
    const ids = workspace.sessionIds
    if (!ids.includes(sessionId)) continue
    record.workspaceIds.push(String(workspace.id))
    if (record.workspaceId === null) {
      record.workspaceId = String(workspace.id)
      record.workspaceIndex = ids.indexOf(sessionId)
      record.beforeSessionId = ids[ids.indexOf(sessionId) + 1] ?? null
    }
  }
  return record
}

/**
 * Where the backend says this Session's log file lives.
 * @param ctx - Host context.
 * @param sessionId - Session to locate.
 * @returns the Session-owned directory, or undefined when nothing is stored.
 */
async function logDirectoryOf(ctx, sessionId) {
  let snapshot
  try {
    snapshot = await ctx.sessionPersistence.stat(sessionId)
  } catch {
    snapshot = undefined
  }
  const location = snapshot?.location
  const logPath = location?.kind === 'jsonl' ? location.path : undefined
  if (typeof logPath !== 'string' || !LOG_FILE.test(basename(logPath))) return undefined
  return dirname(logPath)
}

/**
 * Remove the derived projection cache written for this id. The cache is a
 * disposable artifact of the storage backend, keyed by the Session id.
 * @param ctx - Host context.
 * @param sessionId - Session whose cache entry is removed.
 */
async function removeProjectionCache(ctx, sessionId) {
  const path = join(storageRoot(ctx), 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    const info = await statPath(path)
    if (!info.isFile()) return
  } catch {
    return
  }
  await rm(path, { force: true })
}

/**
 * The root the JSON storage backend writes its units under: the composed
 * `storage-json` row's `root` when the profile states one, else the default
 * `<DSH_HOME>/storages`.
 * @param ctx - Host context.
 * @returns an absolute directory path.
 */
function storageRoot(ctx) {
  try {
    const editor = ctx.get('configEditor')
    for (const row of editor?.configuration?.() ?? []) {
      const options = row?.entry?.options ?? {}
      if (options.name !== '@deepseek-ai/dsh-storage-json') continue
      const root = row?.override?.root ?? options.config?.root ?? row?.inherited?.root
      if (typeof root === 'string' && root.length > 0) return root
    }
  } catch {
    // A profile without the config editor keeps the default layout.
  }
  return join(dshHome(), 'storages')
}

/**
 * The bin root. It lives outside the persistence root so a binned Session is
 * invisible to the backend, the sidebar, and the search index at once.
 * @returns the bin directory.
 */
function trashRoot() {
  return join(dshHome(), 'session-trash', 'v1')
}

/**
 * @param sessionId - entry id.
 * @returns the entry directory.
 */
function entryDir(sessionId) {
  return join(trashRoot(), sessionId)
}

/**
 * @param sessionId - entry id.
 * @returns the moved log files' directory.
 */
function dataDir(sessionId) {
  return join(entryDir(sessionId), 'data')
}

/**
 * @param sessionId - entry id.
 * @returns the manifest path.
 */
function metaPath(sessionId) {
  return join(entryDir(sessionId), 'meta.json')
}

/**
 * @param path - filesystem path.
 * @returns whether anything exists there.
 */
async function exists(path) {
  try {
    await statPath(path)
    return true
  } catch {
    return false
  }
}

/**
 * The deployment home that owns `sessions/`, `storages/`, and the bin.
 * @returns the configured `DSH_HOME`, or the default `~/.dsh`.
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : join(homedir(), '.dsh')
}

/**
 * One parsed JSON body, or undefined when the request carries none.
 * @param request - browser request.
 * @returns the parsed body.
 */
async function bodyOf(request) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/**
 * Whether a live Agent still owns this Session.
 * @param ctx - Host context.
 * @param sessionId - Session to probe.
 * @returns true while the Host keeps an Agent for the Session.
 */
function isLive(ctx, sessionId) {
  const agents = ctx.get('agents')
  return agents !== undefined && agents.get(sessionId) !== undefined
}

/**
 * Whether the loop itself reports a turn in flight. Independent of the activity
 * waterfall, so a renamed or reshaped provider cannot silently weaken the guard.
 * @param ctx - Host context.
 * @param sessionId - Session to probe.
 * @returns true while the Agent's status is `running`.
 */
function isRunning(ctx, sessionId) {
  const agents = ctx.get('agents')
  return agents?.get?.(sessionId)?.status === 'running'
}

/**
 * What is actually running for this Session, from the same provider waterfall
 * the Workspace archive flow consults. `null` means the question could not be
 * asked in this composition, so callers fall back to the liveness test.
 * @param ctx - Host context.
 * @param sessionId - Session to inspect.
 * @returns the activity list, or null when unavailable.
 */
async function activityOf(ctx, sessionId) {
  if (typeof ctx.waterfall !== 'function') return null
  try {
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    return Array.isArray(activity) ? activity : []
  } catch {
    return null
  }
}

/**
 * One readable name per activity family.
 * @param kind - provider-defined family key.
 * @returns Chinese label for the dialog.
 */
function kindLabel(kind) {
  switch (kind) {
    case 'turn': return '正在生成回复'
    case 'subagent': return '子任务在运行'
    case 'job': return '后台任务'
    case 'schedule': return '定时提醒'
    default: return String(kind)
  }
}

/**
 * The sentence shown for running work.
 * @param kinds - provider family keys.
 * @returns the message.
 */
function busyMessage(kinds) {
  const names = (kinds ?? []).map(kindLabel).join('、')
  return names.length > 0
    ? `这个会话还有正在运行的工作（${names}），先停止再删除。`
    : '这个会话仍被一个活动的 Harness 实例占用，请稍后再试或重启应用后删除。'
}

/**
 * The refusal shown for a Session that still has running work.
 * @param activity - what the providers reported.
 * @param running - whether the Agent's own status says a turn is in flight.
 * @returns a reply payload.
 */
function busyRefusal(activity, running = false) {
  const kinds = [...new Set((activity ?? []).map((entry) => String(entry?.kind ?? 'work')))]
  if (kinds.length === 0 && running) kinds.push('turn')
  return {
    ok: false,
    error: {
      code: 'session-busy',
      kinds,
      message: busyMessage(kinds),
    },
  }
}

/**
 * Build one failure envelope.
 * @param error - caught value.
 * @returns a reply payload.
 */
function failure(error) {
  const code = error?.code === 'file-busy' ? 'file-busy' : 'trash-failed'
  return {
    ok: false,
    error: {
      code,
      message: code === 'file-busy'
        ? '会话日志文件仍被占用，请稍后再试；如果仍失败，重启应用后再删除。'
        : error instanceof Error ? error.message : String(error),
    },
  }
}

/**
 * A positive number from configuration, or the fallback.
 * @param value - candidate.
 * @param fallback - default.
 * @returns the resolved number.
 */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Serializes bin mutations so two clicks cannot race the same entry. */
let chain = Promise.resolve()

/**
 * Run one mutation after the previous one settled.
 * @param task - operation.
 * @returns the operation's result.
 */
function serialize(task) {
  const run = chain.then(task, task)
  chain = run.then(() => {}, () => {})
  return run
}

/**
 * Build one JSON response.
 * @param status - HTTP status.
 * @param payload - JSON-compatible envelope.
 * @returns the response for the Fetch bridge.
 */
function reply(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
