/**
 * Session delete — Host half.
 *
 * The shipped Session surface offers archive (hide) but never delete: the
 * Workspace README states it outright ("there is no Session delete: sessions
 * can be archived but never deleted"). This plugin adds the missing verb.
 *
 * Deletion is permanent and covers every durable artifact of one Session:
 *
 *  - the Session directory under `<DSH home>/sessions/<project key>/<id>/`,
 *    located from the persistence snapshot's own `location.path` rather than
 *    re-deriving the project key here;
 *  - the thumbnail of that Session in the projection cache, when it exists;
 *  - the Session id inside every Workspace record, plus the archived and
 *    pinned lists, so no stale reference survives the file it pointed at.
 *
 * Removing the files alone is NOT enough, which is subtle and was the first
 * bug this plugin shipped with. `sessionQuery.listSessions()` merges the
 * persistence listing with `ctx.sessions.list()` — the Host's in-memory store
 * of every Session the sidebar has opened since boot. A Session whose log was
 * unlinked but whose store entry survived therefore kept coming back from the
 * list call: the sidebar still had a row for it, that row no longer belonged
 * to any Workspace (we had just detached it), so it fell into Ungrouped, and a
 * second delete attempt found no stored log and reported "no stored Session
 * with that id". The Session was half-deleted and unreachable.
 *
 * So a delete now evicts the live entry as well, through the same teardown the
 * Session's owner would have used: the store's own `detach` capability for the
 * Session, and `detachEntered` for its Agent. Both are single-shot and
 * identity-guarded, and both emit the paired `session/disposed` /
 * `agent/disposed` edges, which is what finally closes the log writer, cleans
 * the projection cache and makes the Host broadcast `api-session/removed`.
 *
 * A Session that is mid-turn is still refused: cancelling a running Agent from
 * here would race the turn it is draining. Everything else — including a
 * Session the sidebar merely opened once — can be deleted.
 *
 * The browser half reaches this code through one prefix route on `webServer`
 * and never through `host.call`, which only exists for dynamic cordis
 * packages.
 */

import { rm, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Route namespace, kept distinct from the shipped `/api` and `/sidebar/api`. */
const ROUTE = '/session-delete/api'

/**
 * Marker header the browser half sets on its own POSTs.
 *
 * The shipped request fence only admits a same-authority http(s) Origin, and
 * the desktop shell serves this GUI from `dsh-app://app/`, so the fence can
 * never admit the plugin's own UI. A marker header replaces it: a cross-site
 * page cannot set one without a preflight, and this route answers no CORS
 * grant, so such a preflight is refused before the request is ever sent.
 */
const FENCE_HEADER = 'x-dsh-session-delete'

/** Guard rails for every path this module is willing to unlink. */
const SESSION_DIR_PATTERN = /^session-[0-9a-f-]{8,}$|^[0-9a-f-]{8,}$/i

/**
 * Error shape returned to the browser half. Codes are stable enough for the
 * Client to translate them; `message` is the Host-side detail for debugging.
 */
class DeleteError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * Read one JSON request body.
 *
 * @param {import('node:http').IncomingMessage} req - the route's request.
 * @param {number} limit - hard cap in bytes; an over-cap body is refused
 * instead of being read to completion.
 * @returns {Promise<unknown>} the parsed JSON value.
 */
async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new DeleteError('too-large', 'request body is too large', 413)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    throw new DeleteError('invalid-body', 'request body is not valid JSON')
  }
}

/**
 * Write one JSON response with the no-sniff/no-store defaults the rest of the
 * Host API uses.
 *
 * @param {import('node:http').ServerResponse} res - response to complete.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serializable payload.
 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(text))
  res.end(text)
}

/**
 * Delete one directory tree, tolerating an already-absent path so a repeated
 * request stays idempotent.
 *
 * @param {string} target - absolute directory path.
 */
async function removeDirectory(target) {
  await rm(target, { recursive: true, force: true, maxRetries: 3 })
}

/**
 * Derive the DSH home directory from a Session's artifact path.
 *
 * The layout is fixed: `<home>/sessions/<project key>/<session id>/<log>`, so
 * four levels up from the log is the home. Returning `undefined` rather than
 * guessing keeps a surprising layout from turning into a delete outside the
 * tree this plugin owns.
 *
 * @param {string} artifactPath - absolute path from the persistence snapshot.
 * @returns {string | undefined} the home directory, when the shape matches.
 */
function homeFromArtifact(artifactPath) {
  const sessionDir = dirname(artifactPath)
  const projectDir = dirname(sessionDir)
  const sessionsDir = dirname(projectDir)
  if (basename(sessionsDir) !== 'sessions') return undefined
  return dirname(sessionsDir)
}

/**
 * Evict one Session (and its Agent) from the Host's in-memory registries.
 *
 * The Session store exposes `liveEntryFor(session)` and `detachEntered(entry)`,
 * and the Agent registry exposes `detachEntered(entry)`: the same single-shot,
 * identity-guarded teardown each registry's own lifecycle owner uses. Both
 * remove the exact entry first, then emit the paired `session/disposed` /
 * `agent/disposed` edge — which is what closes the log writer, flushes the
 * projection cache and makes the Host broadcast `api-session/removed`.
 *
 * What makes this reachable from outside is that these two methods are
 * addressed by *entry identity* rather than by the closure `enter()` returned.
 * The Agent registry keeps no entry accessor, so its entry comes straight out
 * of `store`; the Session store has one and is used instead.
 *
 * The Agent goes first, mirroring `dsh-agent-loop`'s own teardown order, so the
 * Session is never disposed while a live Agent still points at it.
 *
 * Neither call can half-evict or throw: an entry the registry no longer holds
 * is ignored, and listener failures are contained by the registries. What this
 * does NOT do is dispose the idle Agent's own cordis scope — the loop owns that
 * and exposes no per-Agent teardown, so it stays until process shutdown.
 *
 * @param {object} ctx - plugin context with `sessions` and `agents` injected.
 * @param {string} sessionId - the Session to evict.
 * @returns {{agent: boolean, session: boolean}} which entries were removed.
 */
function evictLiveEntries(ctx, sessionId) {
  const evicted = { agent: false, session: false }

  const agentEntry = ctx.agents?.store?.get(sessionId)
  if (agentEntry !== undefined) {
    ctx.agents.detachEntered(agentEntry)
    evicted.agent = true
  }

  const session = ctx.sessions?.get(sessionId)
  if (session !== undefined) {
    ctx.sessions.detachEntered(ctx.sessions.liveEntryFor(session))
    evicted.session = true
  }

  return evicted
}

/**
 * The JSONL backend's bookkeeping, when the injected backend exposes it.
 *
 * A Session the GUI created but never prompted exists only in this tracker: no
 * directory, no log, no store entry once its writer closed — yet
 * `sessionPersistence.list()` still reports it, and that listing is exactly
 * what the sidebar renders. That is the shape the "still there but cannot be
 * deleted" row has, so a delete has to clear this record too.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {object | undefined} the tracker, when the backend is the JSONL one.
 */
function pendingTracker(ctx) {
  const tracker = ctx.sessionPersistence?.tracker
  if (tracker === undefined || tracker === null) return undefined
  return typeof tracker.pendingOf === 'function' ? tracker : undefined
}

/**
 * Whether a Session is a created-but-never-materialized record.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} sessionId - the Session to inspect.
 * @returns {boolean} true when only the in-memory creation record exists.
 */
function hasPendingEntry(ctx, sessionId) {
  return pendingTracker(ctx)?.pendingOf(sessionId) !== undefined
}

/**
 * Drop a Session's created-but-never-materialized record.
 *
 * `materialized(id)` is the tracker's own "forget this pending entry" step; it
 * is a no-op on an id that was never pending, so this is safe to run on every
 * delete.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} sessionId - the Session to forget.
 * @returns {boolean} true when a pending record was actually removed.
 */
function forgetPendingEntry(ctx, sessionId) {
  const tracker = pendingTracker(ctx)
  if (tracker === undefined || tracker.pendingOf(sessionId) === undefined) return false
  tracker.materialized(sessionId)
  return true
}

/**
 * Find the DSH home when the Session itself has no artifact left to point at.
 *
 * A Session that is still live in the store but whose log is already gone has
 * no `location.path`, yet its cached projection may still be on disk. Any other
 * stored Session reveals the same home, because the layout is shared.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {Promise<string | undefined>} the home directory, when discoverable.
 */
async function homeFromStore(ctx) {
  const snapshots = await ctx.sessionPersistence.list()
  for (const snapshot of snapshots ?? []) {
    const probe = snapshot?.location?.path
    if (typeof probe !== 'string') continue
    const home = homeFromArtifact(probe)
    if (home !== undefined) return home
  }
  return undefined
}

/**
 * Remove one Session's cached projection, tolerating an absent file.
 *
 * The cache writes back on `session/disposed`, and that write is asynchronous,
 * so the first attempt can lose the race against the flush our own eviction
 * triggered. A second attempt after a short settle covers it; a checkpoint
 * that still lands later is harmless, since the file is a derived read model
 * nothing lists.
 *
 * @param {string} cachePath - absolute path of the cache document.
 * @returns {Promise<boolean>} whether a file was removed.
 */
async function removeCachedProjection(cachePath) {
  let removed = false
  for (const delay of [0, 150]) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      await unlink(cachePath)
      removed = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return removed
}

/**
 * Build the deletion service over the Host services this plugin injects.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @returns {(sessionId: string) => Promise<object>} the delete operation.
 */
function createSessionDeleter(ctx) {
  return async function deleteSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new DeleteError('invalid-session', 'a Session id is required')
    }

    // A Session mid-turn would keep appending to the log we are about to
    // remove, so a running Agent is refused outright.
    const agent = ctx.agents?.get(sessionId)
    if (agent?.status === 'running') {
      throw new DeleteError(
        'session-running',
        'this Session is running a turn; stop it before deleting it',
        409,
      )
    }

    const snapshot = await ctx.sessionPersistence.stat(sessionId)
    const artifactPath = snapshot?.location?.path
    // Two states can leave nothing on disk yet still be a real row in the
    // sidebar: a Session live in the store whose log an earlier version of this
    // plugin already removed, and a Session created but never prompted, which
    // only the persistence backend's pending table knows about.
    const stored = artifactPath !== undefined
    const pending = hasPendingEntry(ctx, sessionId)
    if (!stored && !pending && ctx.sessions?.get(sessionId) === undefined) {
      throw new DeleteError('session-missing', 'no stored Session with that id', 404)
    }

    let sessionDir
    if (stored) {
      sessionDir = dirname(artifactPath)
      if (!SESSION_DIR_PATTERN.test(basename(sessionDir))) {
        throw new DeleteError(
          'unsafe-path',
          `refusing to delete an unexpected artifact directory: ${sessionDir}`,
        )
      }
    }

    // Evict before touching the files: the eviction is what closes the log
    // writer and tells the Host to broadcast `api-session/removed`. Removing
    // the directory first would let a late flush recreate it.
    const evicted = evictLiveEntries(ctx, sessionId)

    if (stored) await removeDirectory(sessionDir)

    // A created-but-never-prompted Session has no artifact and no store entry,
    // so its row lives on in the pending table alone. Clearing that record is
    // what makes `sessionPersistence.list()` — and therefore the sidebar —
    // stop reporting it.
    const forgotten = forgetPendingEntry(ctx, sessionId)

    // The projection cache is a derived read model, removed after the
    // eviction so the cache's own on-dispose flush lands first. A Session that
    // is still live in the store but already lost its log has no artifact to
    // derive the home from, so another stored Session supplies it.
    const home = stored ? homeFromArtifact(artifactPath) : await homeFromStore(ctx)
    let cacheRemoved = false
    if (home !== undefined) {
      const cachePath = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
      cacheRemoved = await removeCachedProjection(cachePath)
    }

    // Drop every durable reference. The archive and pin sets are registry
    // globals while the accounting lives on each Workspace record, so both
    // need clearing: an id left behind would resurface the row this call was
    // asked to remove.
    const workspaces = ctx.workspaceRegistry
    let detached = 0
    let unarchived = false
    let unpinned = false
    if ((workspaces.archivedSessionIds ?? []).includes(sessionId)) {
      await workspaces.unarchiveSession(sessionId)
      unarchived = true
    }
    if ((workspaces.pinnedSessionIds ?? []).includes(sessionId)) {
      await workspaces.unpinSession(sessionId)
      unpinned = true
    }
    for (const workspace of workspaces.list()) {
      if (workspace.sessionIds.includes(sessionId)) {
        await workspace.detachSession(sessionId)
        detached += 1
      }
    }

    return {
      deleted: true,
      sessionId,
      sessionDirectory: sessionDir,
      projectionCacheRemoved: cacheRemoved,
      workspacesDetached: detached,
      unarchived,
      unpinned,
      evictedAgent: evicted.agent,
      evictedSession: evicted.session,
      pendingRecordRemoved: forgotten,
    }
  }
}

/**
 * Whether this request may mutate durable state.
 *
 * The shipped fence (`connection.requestRejection`) admits an authenticated
 * browser Peer, but it also demands a same-authority http(s) Origin. The
 * desktop shell serves this GUI from `dsh-app://app/`, whose Origin is never
 * an http(s) authority, so that fence can never admit the very UI this plugin
 * belongs to.
 *
 * A marker header replaces it. The threat this route has to refuse is a
 * cross-site page riding the user's browser: such a page cannot set a custom
 * header without a CORS preflight, and this route answers no CORS grant, so
 * the preflight is refused before the request is ever sent. A local process
 * that could set the header already has the file access this route performs.
 *
 * @param {import('node:http').IncomingMessage} req - the route's request.
 * @returns {boolean} true for this package's own browser half.
 */
function isAuthorized(req) {
  return req.headers[FENCE_HEADER] === '1'
}

/**
 * Mount the delete route for this plugin's browser half.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const deleteSession = createSessionDeleter(ctx)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          if (!isAuthorized(req)) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          if (req.method !== 'POST') {
            res.setHeader('allow', 'POST')
            writeJson(res, 405, {
              ok: false,
              error: { code: 'method', message: 'only POST is supported' },
            })
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(`${ROUTE}/`) ? pathname.slice(ROUTE.length + 1) : undefined
          if (method !== 'delete') {
            writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
            return
          }
          try {
            const body = await readJsonBody(req)
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
            const result = await deleteSession(sessionId)
            writeJson(res, 200, { ok: true, result })
          } catch (error) {
            const status = error instanceof DeleteError ? error.status : 500
            const code = error instanceof DeleteError ? error.code : 'failed'
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger?.warn?.(`session-delete: delete failed: ${message}`)
            writeJson(res, status, { ok: false, error: { code, message } })
          }
        },
      }),
    'dsh-session-delete: delete route',
  )
}

/** The Host half only needs these services; the package parks without them. */
export const inject = [
  'agents',
  'sessionPersistence',
  'sessions',
  'webServer',
  'workspaceRegistry',
]
