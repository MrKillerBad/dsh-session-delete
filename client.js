/**
 * Session delete — browser half.
 *
 * Adds one row to the shipped Session context menu, after everything the
 * product ships. The menu itself belongs to ui-workspace; this package only
 * contributes an action through the Client `contextMenus` service, which is
 * the seam the product documents for exactly this ("new contributions use the
 * menu service").
 *
 * Two paths lead here, and both must keep working:
 *
 *  - the sidebar Session row (`target: "session"`), including rows under
 *    Ungrouped, which the product renders from a synthetic bucket but which
 *    still dispatch a normal Session menu target;
 *  - nothing else — a Session has exactly one menu.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react')

    /** Locale namespace; also the dictionary key for every visible string. */
    const NS = 'session-delete'

    /** Where the Host half mounted its route. */
    const ROUTE = 'session-delete/api/delete'

    /** Identity of this package's one style tag. */
    const CSS_TAG_ID = 'dsh-session-delete/styles.css'

    /** Ordering: shipped pin/rename/fork/copy/locate/archive end at 600. */
    const ORDER = 700

    const zh = {
      'action.delete': '删除会话',
      'confirm.title': '永久删除会话',
      'confirm.body':
        '这会永久删除“{title}”及其全部对话记录，无法恢复。工作区文件夹不会受到影响。',
      'confirm.cancel': '取消',
      'confirm.accept': '永久删除',
      'confirm.busy': '正在删除…',
      'notice.done': '已删除会话',
      'notice.failed': '删除会话失败',
      'error.session-running': '该会话正在执行任务，请等它停下后再删除。',
      'error.session-missing': '找不到该会话的存储记录。',
      'error.unsafe-path': '会话目录的路径不符合预期，已中止删除。',
    }

    const en = {
      'action.delete': 'Delete session',
      'confirm.title': 'Delete this session permanently',
      'confirm.body':
        'This permanently removes “{title}” and its entire conversation log. It cannot be undone. The workspace folder is not affected.',
      'confirm.cancel': 'Cancel',
      'confirm.accept': 'Delete permanently',
      'confirm.busy': 'Deleting…',
      'notice.done': 'Session deleted',
      'notice.failed': 'Could not delete the session',
      'error.session-running': 'That session is running a turn. Wait for it to stop, then delete it.',
      'error.session-missing': 'No stored record was found for that session.',
      'error.unsafe-path': 'The session directory was not where it was expected, so nothing was deleted.',
    }

    /** Styles are hoisted into the page once and removed with the package. */
    const CSS = `
.session-delete-scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 62%, transparent);
  pointer-events: auto;
}
.session-delete-dialog {
  width: min(28rem, calc(100vw - 3rem));
  padding: 1.25rem;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 0.75rem;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 1rem 3rem color-mix(in srgb, var(--dsw-alias-bg-base) 70%, transparent);
  pointer-events: auto;
}
.session-delete-title {
  margin: 0 0 0.5rem;
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.4;
}
.session-delete-body {
  margin: 0 0 1.25rem;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}
.session-delete-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.session-delete-button {
  padding: 0.375rem 0.875rem;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 0.5rem;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}
.session-delete-button:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
}
.session-delete-button:disabled {
  cursor: default;
  opacity: 0.6;
}
.session-delete-button--danger {
  border-color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-bg-base);
}
.session-delete-button--danger:hover:not(:disabled) {
  background: var(--dsw-alias-state-error-primary);
  filter: brightness(0.94);
}
`

    /**
     * Ask the Host half to delete one Session.
     *
     * The route is resolved against the page's own base so a proxied GUI keeps
     * the request under its prefix — an origin-root path would leave the
     * prefix and 404.
     *
     * @param {string} sessionId - the Session to delete.
     * @returns {Promise<object>} the Host result.
     */
    async function requestDelete(sessionId) {
      const base = new URL(document.baseURI, 'http://dsh.internal/')
      base.search = ''
      base.hash = ''
      if (!base.pathname.endsWith('/')) base.pathname += '/'
      const url = new URL(ROUTE, base.href)
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-session-delete': '1' },
        body: JSON.stringify({ sessionId }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) {
        const error = new Error(payload?.error?.message ?? response.statusText)
        error.code = payload?.error?.code
        throw error
      }
      return payload.result
    }

    /**
     * Remove the deleted Session's row from this browser's catalogue.
     *
     * The Host broadcasts `api-session/removed` when it disposes a Session, and
     * that is usually the path this row takes. It is not a path this package
     * can rely on alone, though: the removal frame is only forwarded while the
     * Session was live in the Host store, and a Session deleted while it was
     * still cold never had one. Applying the removal here makes both cases
     * identical, and the refresh that follows reconciles the full baseline for
     * anything this browser's catalogue held twice.
     *
     * Failures are swallowed on purpose: the deletion itself already succeeded,
     * so a catalogue hiccup must not be reported as a failed delete.
     *
     * @param {object} ctx - client context with `sessions` injected.
     * @param {string} sessionId - the Session that no longer exists.
     */
    function dropRow(ctx, sessionId) {
      closeMainView(ctx, sessionId)
      try {
        ctx.sessions.handleSessionRemoved(sessionId)
      } catch (error) {
        console.error('session-delete: dropping the row failed', error)
      }
      Promise.resolve()
        .then(() => ctx.sessions.refresh())
        .catch(() => {})
    }

    /**
     * Close the conversation pane when the deleted Session is the one on screen.
     *
     * Dropping the row only edits the sidebar catalogue: the main view holds its
     * own `mainView` reference to the Session, so the transcript stays rendered
     * — and stays interactive — from browser memory even though the log is gone
     * from disk. The shipped archive flow clears the view for the same reason
     * (`archiveSession` calls `clearMain()` when the archived Session is the
     * current one), and a permanent delete must not be lazier than archiving.
     *
     * `clearMain` is the workspace browser's own teardown: it drops the
     * reference, clears the selection, and parks the center panel. It is called
     * through the service rather than through an injected name so this package
     * keeps working if the workspace browser is not mounted.
     *
     * @param {object} ctx - client context.
     * @param {string} sessionId - the Session that no longer exists.
     * @returns {boolean} whether a view was actually closed.
     */
    function closeMainView(ctx, sessionId) {
      try {
        const retainInfo = ctx.sessions?.retainInfo?.(sessionId)
        const retainedBy = retainInfo?.getSnapshot?.()?.retainedBy
        if ((retainedBy?.mainView ?? 0) === 0) return false
        const workspace = ctx.get('uiWorkspace')
        if (typeof workspace?.clearMain !== 'function') return false
        workspace.clearMain()
        return true
      } catch (error) {
        console.error('session-delete: closing the open conversation failed', error)
        return false
      }
    }

    /**
     * The confirmation surface.
     *
     * A permanent delete needs a deliberate second act, so this renders its
     * own dialog instead of firing from the menu: the shipped archive flow
     * confirms too, and a delete that silently discards a log would be worse.
     * Rendering lives in `shell.overlay` — the additive frame-wide seat — and
     * the layer is click-through, so this entry opts back into pointer events.
     */
    function ConfirmationDialog({ state, t, onCancel, onAccept }) {
      const busy = state.busy
      const buttonRef = React.useRef(null)

      React.useEffect(() => {
        buttonRef.current?.focus()
      }, [])

      React.useEffect(() => {
        const onKeyDown = event => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            onCancel()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [busy, onCancel])

      const title = state.title
      return React.createElement(
        'div',
        {
          className: 'session-delete-scrim',
          role: 'presentation',
          onMouseDown: event => {
            if (event.target === event.currentTarget && !busy) onCancel()
          },
        },
        React.createElement(
          'div',
          {
            className: 'session-delete-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('confirm.title'),
          },
          React.createElement('h2', { className: 'session-delete-title' }, t('confirm.title')),
          React.createElement(
            'p',
            { className: 'session-delete-body' },
            t('confirm.body', { title }),
          ),
          React.createElement(
            'div',
            { className: 'session-delete-actions' },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'session-delete-button',
                disabled: busy,
                onClick: onCancel,
              },
              t('confirm.cancel'),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                ref: buttonRef,
                className: 'session-delete-button session-delete-button--danger',
                disabled: busy,
                onClick: onAccept,
              },
              busy ? t('confirm.busy') : t('confirm.accept'),
            ),
          ),
        ),
      )
    }

    /**
     * Own the pending confirmation as one piece of state shared by the menu
     * action and the overlay entry.
     *
     * @returns {object} subscribe/read/ask/settle accessors.
     */
    function createConfirmationStore() {
      let current = null
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('session-delete: confirm listener crashed', error)
          }
        }
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        get() {
          return current
        },
        ask(sessionId, title, run) {
          current = { sessionId, title, run, busy: false }
          emit()
        },
        setBusy(busy) {
          if (current === null) return
          current = { ...current, busy }
          emit()
        },
        settle() {
          current = null
          emit()
        },
      }
    }

    return {
      inject: ['slots', 'locale', 'contextMenus', 'sessions', 'uiWorkspace'],

      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'session-delete: zh dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'session-delete: en dictionary')
        const t = ctx.locale.bind(NS)

        const confirmations = createConfirmationStore()

        // The overlay entry renders whatever the menu asked for. Registering it
        // for the whole frame lifetime keeps the dialog out of the menu's own
        // unmount path.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'session-delete:confirm',
              order: 40,
            },
            function SessionDeleteConfirm() {
              const [, force] = React.useReducer(value => value + 1, 0)
              React.useEffect(() => confirmations.subscribe(force), [])
              const state = confirmations.get()
              if (state === null) return null
              const accept = () => {
                confirmations.setBusy(true)
                Promise.resolve()
                  .then(() => state.run())
                  .then(() => {
                    confirmations.settle()
                    ctx.contextMenus.notify(t('notice.done'), true)
                  })
                  .catch(error => {
                    confirmations.settle()
                    const key = `error.${error?.code ?? ''}`
                    const message = error?.code ? t(key) : ''
                    ctx.contextMenus.notify(
                      message === key ? t('notice.failed') : message || t('notice.failed'),
                    )
                  })
              }
              return React.createElement(ConfirmationDialog, {
                state,
                t,
                onCancel: () => {
                  if (!state.busy) confirmations.settle()
                },
                onAccept: accept,
              })
            },
          ),
        )

        // One structured contribution on the Session menu the product already
        // dispatches for both grouped and Ungrouped rows.
        ctx.effect(
          () =>
            ctx.contextMenus.register({
              id: 'session-delete.delete',
              target: 'session',
              order: ORDER,
              resolve: target => {
                const sessionId = target?.sessionId
                if (typeof sessionId !== 'string' || sessionId === '') return []
                const title = target?.displayTitle ?? sessionId
                return [
                  {
                    id: 'delete',
                    label: t('action.delete'),
                    icon: { key: 'session-delete.trash' },
                    danger: true,
                    separatorBefore: true,
                    failureLabel: t('notice.failed'),
                    run: () => {
                      confirmations.ask(sessionId, title, async () => {
                        await requestDelete(sessionId)
                        dropRow(ctx, sessionId)
                      })
                    },
                  },
                ]
              },
            }),
          'session-delete: Session menu contribution',
        )

        ctx.slots.inject('contextMenu.icon', () =>
          ctx.slots.register(
            { name: 'contextMenu.icon', key: 'session-delete.trash' },
            function TrashIcon() {
              return React.createElement(
                'svg',
                {
                  width: 16,
                  height: 16,
                  viewBox: '0 0 16 16',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.4,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                  'aria-hidden': 'true',
                },
                React.createElement('path', { d: 'M2.5 4.5h11' }),
                React.createElement('path', { d: 'M6 4.5V3a.5.5 0 0 1 .5-.5h3A.5.5 0 0 1 10 3v1.5' }),
                React.createElement('path', { d: 'M4 4.5l.6 8a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8' }),
                React.createElement('path', { d: 'M6.6 7v3.9M9.4 7v3.9' }),
              )
            },
          ),
        )

        ctx.effect(() => {
          // Style tag owned by this package, keyed so a reload replaces rather
          // than duplicates it. `styles` is not a service bundles can reach;
          // the shipped bundles inject their CSS exactly this way.
          const selector = `style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`
          const existing = document.querySelector(selector)
          const tag = existing ?? document.createElement('style')
          tag.dataset.plugin = 'dsh-session-delete'
          tag.dataset.pluginCss = CSS_TAG_ID
          if (existing === null) {
            tag.textContent = CSS
            document.head.appendChild(tag)
          }
          return () => {
            tag.remove()
          }
        }, 'session-delete: styles')
      },
    }
  },
})
