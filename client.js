/**
 * Client half of the session-delete bundle: a recycle bin for Sessions.
 *
 * Three surfaces, all plain React over the host's theme tokens:
 *  - a red "Delete session" row in the sidebar Session menu (moves to the bin);
 *  - a trash button at the sidebar foot with a pending count;
 *  - the trash dialog itself (restore, delete now, empty).
 *
 * The Host owns the filesystem and the retention sweep; every screen action is
 * one authenticated POST to a route registered by `index.js`. After a move or a
 * restore the Session catalog is refreshed so the sidebar row appears or
 * disappears without a page reload.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react')

    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    /** Document-relative: the page may be mounted below the origin root. */
    const ROUTE_DELETE = 'api/plugin.session-delete'
    const ROUTE_TRASH = 'api/plugin.session-trash'

    const dictionaries = {
      en: {
        'menu.delete': 'Delete session',
        'dialog.title': 'Move this session to the trash?',
        'dialog.desc': '“{title}” moves to the trash and is deleted automatically after {days} days. Until then you can restore it from the trash at the foot of the sidebar.',
        'dialog.descUntitled': 'This session moves to the trash and is deleted automatically after {days} days. Until then you can restore it from the trash at the foot of the sidebar.',
        'dialog.cancel': 'Cancel',
        'dialog.confirm': 'Move to trash',
        'dialog.pending': 'Moving to trash…',
        'bin.title': 'Trash',
        'bin.hint': 'A session is deleted for good {days} days after it was moved here.',
        'bin.incompatible': 'Some DSH capabilities this plugin needs are missing: {names}. Deleting is disabled; restoring and purging still work.',
        'bin.loading': 'Loading…',
        'bin.empty': 'The trash is empty.',
        'bin.restore': 'Restore',
        'bin.purge': 'Delete now',
        'bin.purgeAgain': 'Delete permanently?',
        'bin.emptyTrash': 'Empty trash',
        'bin.emptyAgain': 'Empty permanently?',
        'bin.close': 'Close',
        'bin.restored': '“{title}” was restored.',
        'bin.purged': '“{title}” was deleted permanently.',
        'bin.emptied': 'The trash was emptied.',
        'bin.remaining': '{n} days left',
        'bin.remainingToday': 'removed today',
        'bin.deletedAt': 'Deleted {time}',
        'bin.none': 'Untitled session',
        'footer.label': 'Trash',
        'footer.badge': 'Trash, {n} sessions',
        'error.network': 'Could not reach the local service. Nothing was changed.',
        'error.generic': 'The operation failed.',
        'error.busy': 'This session still has work running ({kinds}). Stop it first, then delete.',
        'error.locked': 'The session log is still in use. Try again, or restart the app and delete it.',
        'error.incompatible': 'This plugin does not match this DSH build (missing {names}). Nothing was changed.',
        'error.current': 'This is the session the window is showing. Switch to another session first, then delete it.',
        'kind.turn': 'a reply in progress',
        'kind.subagent': 'subagents running',
        'kind.job': 'background jobs',
        'kind.schedule': 'a schedule',
      },
      zh: {
        'menu.delete': '删除会话',
        'dialog.title': '把该会话移入回收站？',
        'dialog.desc': '“{title}”将移入回收站，{days} 天后自动清除；期间可以在侧栏底部的回收站里恢复。',
        'dialog.descUntitled': '该会话将移入回收站，{days} 天后自动清除；期间可以在侧栏底部的回收站里恢复。',
        'dialog.cancel': '取消',
        'dialog.confirm': '移入回收站',
        'dialog.pending': '正在移入回收站…',
        'bin.title': '回收站',
        'bin.hint': '删除后保留 {days} 天，到期自动清除。',
        'bin.incompatible': '当前 DSH 缺少本插件需要的能力：{names}。删除功能已停用，回收站里的恢复与清除仍可用。',
        'bin.loading': '正在读取…',
        'bin.empty': '回收站是空的。',
        'bin.restore': '恢复',
        'bin.purge': '立即清除',
        'bin.purgeAgain': '确认清除？',
        'bin.emptyTrash': '清空回收站',
        'bin.emptyAgain': '确认清空？',
        'bin.close': '关闭',
        'bin.restored': '已恢复“{title}”。',
        'bin.purged': '已清除“{title}”。',
        'bin.emptied': '回收站已清空。',
        'bin.remaining': '还剩 {n} 天',
        'bin.remainingToday': '今天清除',
        'bin.deletedAt': '{time} 删除',
        'bin.none': '未命名会话',
        'footer.label': '回收站',
        'footer.badge': '回收站，{n} 个会话',
        'error.network': '无法连接到本地服务，没有做任何改动。',
        'error.generic': '操作失败。',
        'error.busy': '这个会话还有正在运行的工作（{kinds}），先停止再删除。',
        'error.locked': '会话日志文件仍被占用，请稍后再试；如果还不行，重启应用后再删除。',
        'error.incompatible': '插件与当前 DSH 版本不兼容（缺少 {names}），未执行任何操作。',
        'error.current': '这是当前正在查看的会话。先切换到其他会话，再删除它。',
        'kind.turn': '正在生成回复',
        'kind.subagent': '子任务在运行',
        'kind.job': '后台任务',
        'kind.schedule': '定时提醒',
      },
      ja: {
        'menu.delete': 'セッションを削除',
        'dialog.title': 'このセッションをゴミ箱に移動しますか？',
        'dialog.desc': '「{title}」はゴミ箱に移動し、{days} 日後に自動で削除されます。それまではサイドバー下部のゴミ箱から復元できます。',
        'dialog.descUntitled': 'このセッションはゴミ箱に移動し、{days} 日後に自動で削除されます。それまではサイドバー下部のゴミ箱から復元できます。',
        'dialog.cancel': 'キャンセル',
        'dialog.confirm': 'ゴミ箱に移動',
        'dialog.pending': 'ゴミ箱に移動しています…',
        'bin.title': 'ゴミ箱',
        'bin.hint': '削除から {days} 日後に完全に削除されます。',
        'bin.incompatible': 'この DSH には必要な機能がありません：{names}。削除は無効ですが、復元と完全削除は使えます。',
        'bin.loading': '読み込み中…',
        'bin.empty': 'ゴミ箱は空です。',
        'bin.restore': '復元',
        'bin.purge': '今すぐ削除',
        'bin.purgeAgain': '完全に削除しますか？',
        'bin.emptyTrash': 'ゴミ箱を空にする',
        'bin.emptyAgain': '完全に空にしますか？',
        'bin.close': '閉じる',
        'bin.restored': '「{title}」を復元しました。',
        'bin.purged': '「{title}」を完全に削除しました。',
        'bin.emptied': 'ゴミ箱を空にしました。',
        'bin.remaining': '残り {n} 日',
        'bin.remainingToday': '本日削除',
        'bin.deletedAt': '{time} に削除',
        'bin.none': '無題のセッション',
        'footer.label': 'ゴミ箱',
        'footer.badge': 'ゴミ箱、{n} 件',
        'error.network': 'ローカルサービスに接続できませんでした。何も変更されていません。',
        'error.generic': '操作に失敗しました。',
        'error.busy': 'このセッションにはまだ実行中の作業があります（{kinds}）。停止してから削除してください。',
        'error.locked': 'セッションログがまだ使用中です。しばらくしてから再試行するか、アプリを再起動してから削除してください。',
        'error.incompatible': 'このプラグインは現在の DSH と一致しません（{names} が不足）。何も変更されていません。',
        'error.current': 'これはいま表示中のセッションです。別のセッションに切り替えてから削除してください。',
        'kind.turn': '応答を生成中',
        'kind.subagent': 'サブエージェント実行中',
        'kind.job': 'バックグラウンドジョブ',
        'kind.schedule': 'スケジュール',
      },
    }

    /**
     * A tiny observable with a stable `getSnapshot` identity.
     * @param initial - first value.
     * @returns read, replace, and subscribe.
     */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set: (next) => {
          if (next === value) return
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /** Pending delete confirmation: `{ sessionId, title }` or null. */
    const confirm = createStore(null)

    /** Trash dialog state. */
    const binState = createStore({
      open: false,
      status: 'idle',
      items: [],
      retentionDays: 3,
      missing: [],
      notice: null,
      error: null,
      busyId: null,
      emptying: false,
    })

    /** Badge count survives closing the dialog. */
    const count = createStore(0)

    const DAY_MS = 86_400_000

    const CSS = `
.sd-scrim{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgb(0 0 0 / .32);pointer-events:auto}
.sd-panel{width:min(420px,100%);box-sizing:border-box;padding:20px 20px 16px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 18px 48px rgb(0 0 0 / .28);font:400 14px/20px var(--dsw-font-family-sans,system-ui,sans-serif)}
.sd-panel-wide{width:min(560px,100%)}
.sd-title{margin:0 0 8px;font-size:16px;line-height:22px;font-weight:600}
.sd-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.sd-status{margin-top:12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.sd-error{margin-top:12px;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.sd-notice{margin-top:12px;color:var(--dsw-alias-state-success-primary);font-size:13px;line-height:20px}
.sd-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
.sd-list{margin-top:14px;max-height:46vh;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1)}
.sd-row{display:flex;align-items:center;gap:12px;padding:10px 2px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sd-row-main{flex:1;min-width:0}
.sd-row-title{font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sd-row-meta{margin-top:2px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.sd-row-actions{display:flex;gap:6px;flex:none}
.sd-mini{font:inherit;font-size:12px;line-height:16px;padding:4px 10px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}
.sd-mini:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.sd-mini:disabled{opacity:.55;cursor:default}
.sd-mini-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent)}
.sd-mini-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.sd-empty{padding:26px 0;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary)}
.sd-btn{font:inherit;font-size:13px;line-height:18px;padding:6px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}
.sd-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.sd-btn:disabled{opacity:.55;cursor:default}
.sd-btn-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);color:var(--dsw-alias-state-error-primary)}
.sd-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.sd-foot{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.sd-foot:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sd-foot-rail{display:inline-flex;align-items:center;justify-content:center;position:relative;width:32px;height:32px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sd-foot-rail:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sd-badge{min-width:16px;height:16px;padding:0 5px;box-sizing:border-box;border-radius:8px;background:var(--dsw-alias-brand-primary);color:#fff;font-size:10px;line-height:16px;text-align:center}
.sd-badge-float{position:absolute;top:-1px;right:-1px;min-width:15px;height:15px;line-height:15px}
.sd-warn{margin-top:12px;color:var(--dsw-alias-state-warn-primary);font-size:13px;line-height:20px}
`

    /**
     * Register one slot entry, keeping a broken extension point from taking the
     * rest of the plugin down with it. A newer DSH that renames a slot or changes
     * its registration shape leaves the other surfaces working and says so in
     * the console.
     * @param ctx - browser plugin context.
     * @param slot - target slot name.
     * @param options - registration options besides `name`.
     * @param Component - React component for the entry.
     */
    function registerIn(ctx, slot, options, Component) {
      try {
        ctx.slots.inject(slot, () => {
          try {
            return ctx.slots.register({ name: slot, ...options }, Component)
          } catch (error) {
            console.warn(`[session-delete] ${slot} entry failed; continuing without it.`, error)
            return () => {}
          }
        })
      } catch (error) {
        console.warn(`[session-delete] ${slot} injection failed; continuing without it.`, error)
      }
    }

    /**
     * POST one operation to a Host route.
     * @param route - document-relative route.
     * @param body - JSON payload.
     * @returns the `value` of an ok envelope.
     * @throws an Error carrying the Host's message, code, kinds and missing capabilities.
     */
    async function post(route, body) {
      const response = await fetch(route, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) {
        const failure = new Error(payload?.error?.message ?? 'request-failed')
        failure.code = payload?.error?.code
        failure.kinds = payload?.error?.kinds
        failure.missing = payload?.error?.missing
        throw failure
      }
      return payload.value
    }

    /**
     * Turn one Host refusal into a sentence.
     * @param t - translator of the active request.
     * @param failure - the thrown error, carrying `code` and `kinds`.
     * @returns display text.
     */
    function describeFailure(t, failure) {
      const code = failure?.code
      if (code === 'session-busy') {
        const kinds = Array.isArray(failure.kinds) ? failure.kinds : []
        const names = kinds.map((kind) => {
          const key = `kind.${kind}`
          try {
            const translated = t(key)
            if (typeof translated === 'string' && translated.length > 0 && translated !== key) return translated
          } catch {
            // fall through to the raw provider key
          }
          return String(kind)
        }).join('、')
        return t('error.busy', { kinds: names.length > 0 ? names : '—' })
      }
      if (code === 'file-busy') return t('error.locked')
      if (code === 'incompatible') {
        const missing = Array.isArray(failure.missing) ? failure.missing : []
        return t('error.incompatible', { names: missing.length > 0 ? missing.join('、') : '?' })
      }
      return typeof failure?.message === 'string' && failure.message.length > 0 && failure.message !== 'request-failed'
        ? failure.message
        : t('error.generic')
    }

    /**
     * One 16px bin glyph in `currentColor`.
     * @param props - `size` in pixels.
     * @returns the svg element.
     */
    function TrashGlyph({ size = 16 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', { d: 'M2.5 4.5h11' }),
        h('path', { d: 'M6.5 4.5V3.2c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.3' }),
        h('path', { d: 'M4 4.5l.6 8.1c0 .6.5 1.1 1.1 1.1h4.6c.6 0 1.1-.5 1.1-1.1l.6-8.1' }),
        h('path', { d: 'M6.7 7v4.2' }),
        h('path', { d: 'M9.3 7v4.2' }),
      )
    }

    /**
     * One dialog shell: scrim, panel, Escape and backdrop dismissal.
     * @param props - `title`, `description`, `footer`, `wide`, `onClose`, `children`.
     * @returns the dialog tree.
     */
    function Shell({ title, description, footer, wide = false, onClose, children }) {
      const panelRef = useRef(null)
      const onKeyDown = useCallback((event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }, [onClose])
      useEffect(() => {
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [onKeyDown])
      useEffect(() => {
        const first = panelRef.current?.querySelector('button')
        first?.focus()
      }, [])
      return h(
        'div',
        {
          className: 'sd-scrim',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          {
            className: wide ? 'sd-panel sd-panel-wide' : 'sd-panel',
            ref: panelRef,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
          },
          h('style', null, CSS),
          h('div', { className: 'sd-title' }, title),
          description === undefined || description === null ? null : h('p', { className: 'sd-desc' }, description),
          children,
          footer === undefined || footer === null ? null : h('div', { className: 'sd-footer' }, footer),
        ),
      )
    }

    /**
     * Confirmation for moving one Session to the trash.
     * @param props - `t` from the locale seat, `refresh` from the inject face, and
     * the shell overlay's `useSessions` standard prop.
     * @returns the dialog, or null.
     */
    function DeleteDialog({ t, refresh, useSessions }) {
      const request = useSyncExternalStore(confirm.subscribe, confirm.get)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const sessions = useSessions ? useSessions((state) => state) : undefined

      useEffect(() => {
        if (request === null) return
        setBusy(false)
        setError(null)
      }, [request])

      if (request === null) return null

      /**
       * The Session the main column is showing: deleting it would leave that
       * view writing into a log that no longer exists.
       */
      const shownInMainView = (sessions?.byId?.[request.sessionId]?.retainedBy?.mainView ?? 0) > 0

      const close = () => {
        if (busy) return
        confirm.set(null)
      }

      const submit = async () => {
        if (busy) return
        if (shownInMainView) {
          setError(t('error.current'))
          return
        }
        setBusy(true)
        setError(null)
        try {
          await post(ROUTE_DELETE, { sessionId: request.sessionId, title: request.title })
          confirm.set(null)
          await refresh()
          void refreshBadge()
        } catch (failure) {
          setBusy(false)
          setError(describeFailure(t, failure))
        }
      }

      const days = binState.get().retentionDays

      return h(
        Shell,
        {
          title: t('dialog.title'),
          description: request.title.length > 0
            ? t('dialog.desc', { title: request.title, days })
            : t('dialog.descUntitled', { days }),
          onClose: close,
          footer: [
            h('button', { key: 'cancel', type: 'button', className: 'sd-btn', disabled: busy, onClick: close }, t('dialog.cancel')),
            h('button', {
              key: 'confirm',
              type: 'button',
              className: 'sd-btn sd-btn-danger',
              disabled: busy,
              onClick: () => {
                void submit()
              },
            }, t('dialog.confirm')),
          ],
        },
        busy ? h('div', { className: 'sd-status', role: 'status' }, t('dialog.pending')) : null,
        error === null ? null : h('div', { className: 'sd-error', role: 'alert' }, error),
      )
    }

    /**
     * The trash dialog: restore, delete one entry, or empty everything.
     * @param props - `t` from the locale seat and `refresh` from the inject face.
     * @returns the dialog, or null.
     */
    function BinDialog({ t, refresh }) {
      const state = useSyncExternalStore(binState.subscribe, binState.get)
      const [armed, setArmed] = useState(null)
      const armTimer = useRef(null)

      useEffect(() => () => clearTimeout(armTimer.current), [])

      if (!state.open) return null

      const patch = (next) => binState.set({ ...binState.get(), ...next })

      const close = () => {
        if (state.busyId !== null || state.emptying) return
        patch({ open: false, notice: null, error: null })
      }

      const arm = (key) => {
        setArmed(key)
        clearTimeout(armTimer.current)
        armTimer.current = setTimeout(() => setArmed(null), 4000)
      }

      const restore = async (item) => {
        patch({ busyId: item.sessionId, error: null, notice: null })
        try {
          await post(ROUTE_TRASH, { action: 'restore', sessionId: item.sessionId })
          await loadBin(t)
          await refresh()
          void refreshBadge()
          binState.set({ ...binState.get(), notice: t('bin.restored', { title: item.title || t('bin.none') }) })
        } catch (failure) {
          binState.set({ ...binState.get(), busyId: null, error: describeFailure(t, failure) })
        }
      }

      const purge = async (item) => {
        if (armed !== item.sessionId) {
          arm(item.sessionId)
          return
        }
        setArmed(null)
        patch({ busyId: item.sessionId, error: null, notice: null })
        try {
          await post(ROUTE_TRASH, { action: 'purge', sessionId: item.sessionId })
          await loadBin(t)
          void refreshBadge()
          binState.set({ ...binState.get(), notice: t('bin.purged', { title: item.title || t('bin.none') }) })
        } catch (failure) {
          binState.set({ ...binState.get(), busyId: null, error: describeFailure(t, failure) })
        }
      }

      const emptyAll = async () => {
        if (armed !== 'empty') {
          arm('empty')
          return
        }
        setArmed(null)
        patch({ emptying: true, error: null, notice: null })
        try {
          await post(ROUTE_TRASH, { action: 'empty' })
          await loadBin(t)
          void refreshBadge()
          binState.set({ ...binState.get(), emptying: false, notice: t('bin.emptied') })
        } catch (failure) {
          binState.set({ ...binState.get(), emptying: false, error: describeFailure(t, failure) })
        }
      }

      const busy = state.busyId !== null || state.emptying
      const remaining = (item) => {
        const days = Math.ceil((item.expiresAt - Date.now()) / DAY_MS)
        return days <= 0 ? t('bin.remainingToday') : t('bin.remaining', { n: days })
      }

      const rows = state.items.length === 0
        ? [h('div', { key: 'empty', className: 'sd-empty' }, state.status === 'loading' ? t('bin.loading') : t('bin.empty'))]
        : state.items.map((item) => h(
          'div',
          { className: 'sd-row', key: item.sessionId, role: 'listitem' },
          h('div', { className: 'sd-row-main' },
            h('div', { className: 'sd-row-title', title: item.title || t('bin.none') }, item.title || t('bin.none')),
            h(
              'div',
              { className: 'sd-row-meta' },
              `${t('bin.deletedAt', { time: new Date(item.deletedAt).toLocaleString() })} · ${remaining(item)}`,
            ),
          ),
          h('div', { className: 'sd-row-actions' },
            h('button', {
              type: 'button',
              className: 'sd-mini',
              disabled: busy,
              onClick: () => {
                void restore(item)
              },
            }, t('bin.restore')),
            h('button', {
              type: 'button',
              className: 'sd-mini sd-mini-danger',
              disabled: busy,
              onClick: () => {
                void purge(item)
              },
            }, armed === item.sessionId ? t('bin.purgeAgain') : t('bin.purge')),
          ),
        ))

      return h(
        Shell,
        {
          wide: true,
          title: t('bin.title'),
          description: t('bin.hint', { days: state.retentionDays }),
          onClose: close,
          footer: [
            h('button', {
              key: 'empty',
              type: 'button',
              className: 'sd-btn sd-btn-danger',
              disabled: busy || state.items.length === 0,
              onClick: () => {
                void emptyAll()
              },
            }, armed === 'empty' ? t('bin.emptyAgain') : t('bin.emptyTrash')),
            h('button', { key: 'close', type: 'button', className: 'sd-btn', disabled: state.emptying, onClick: close }, t('bin.close')),
          ],
        },
        state.missing.length > 0
          ? h('div', { className: 'sd-warn', role: 'status' }, t('bin.incompatible', { names: state.missing.join('、') }))
          : null,
        h('div', { className: 'sd-list', role: 'list' }, rows),
        state.notice === null ? null : h('div', { className: 'sd-notice', role: 'status' }, state.notice),
        state.error === null ? null : h('div', { className: 'sd-error', role: 'alert' }, state.error),
      )
    }

    /**
     * The sidebar-foot trash button, with its pending count.
     * @param props - `wide` from the column, `t` from the locale seat, `openBin` from the inject face.
     * @returns the button.
     */
    function TrashButton({ wide, t, openBin }) {
      const pending = useSyncExternalStore(count.subscribe, count.get)
      const label = pending > 0 ? t('footer.badge', { n: pending }) : t('footer.label')
      const badge = pending > 0 ? (pending > 99 ? '99+' : String(pending)) : null
      const style = h('style', { key: 'style' }, CSS)
      if (!wide) {
        return h(
          React.Fragment,
          null,
          style,
          h(
            'button',
            {
              type: 'button',
              className: 'sd-foot-rail',
              'aria-label': label,
              title: label,
              onClick: openBin,
            },
            h(TrashGlyph, { size: 18 }),
            badge === null ? null : h('span', { className: 'sd-badge sd-badge-float' }, badge),
          ),
        )
      }
      return h(
        React.Fragment,
        null,
        style,
        h(
          'button',
          { type: 'button', className: 'sd-foot', 'aria-label': label, title: label, onClick: openBin },
          h(TrashGlyph, { size: 16 }),
          h('span', null, t('footer.label')),
          badge === null ? null : h('span', { className: 'sd-badge' }, badge),
        ),
      )
    }

    /**
     * Read the bin into the dialog store.
     * @param t - translator of the active request.
     */
    async function loadBin(t) {
      binState.set({ ...binState.get(), status: 'loading', error: null })
      try {
        const value = await post(ROUTE_TRASH, { action: 'list' })
        binState.set({
          ...binState.get(),
          status: 'ready',
          items: Array.isArray(value?.items) ? value.items : [],
          retentionDays: Number(value?.retentionDays) > 0 ? Number(value.retentionDays) : 3,
          missing: Array.isArray(value?.missing) ? value.missing : [],
          busyId: null,
        })
        count.set(Array.isArray(value?.items) ? value.items.length : 0)
      } catch (failure) {
        binState.set({ ...binState.get(), status: 'error', error: describeFailure(t, failure), busyId: null })
      }
    }

    /** Refresh the badge without opening the dialog. */
    async function refreshBadge() {
      try {
        const value = await post(ROUTE_TRASH, { action: 'list' })
        count.set(Array.isArray(value?.items) ? value.items.length : 0)
        const days = Number(value?.retentionDays)
        if (Number.isFinite(days) && days > 0) {
          binState.set({ ...binState.get(), retentionDays: days })
        }
      } catch {
        // A stale badge is harmless; the dialog reloads on open.
      }
    }

    /**
     * Services the browser half needs before it can register anything.
     *
     * The Session-menu service is deliberately absent from this list: another
     * plugin provides it, and on a cold boot that plugin can activate *after*
     * this module. A one-shot `ctx.get('contextMenus')` then reads undefined and
     * the menu row silently never registers — which is exactly why the row went
     * missing after a restart. The menu is contributed inside `ctx.inject`
     * instead, which waits for the service and unregisters when it goes away.
     */
    const inject = ['slots', 'locale', 'sessions']

    /**
     * Register the menu row, the glyph, the footer button, and both dialogs.
     * @param ctx - browser plugin context.
     */
    function apply(ctx) {
      const namespace = 'sessionDelete'
      ctx.effect(() => ctx.locale.register(namespace, dictionaries), 'session-delete: locale')

      /**
       * A menu label that can never take the whole contribution down: a missing
       * dictionary or a throwing translator must degrade to readable text, not
       * to a silently absent row.
       * @param key - dictionary key.
       * @param fallback - text used when translation is unavailable.
       * @returns the label.
       */
      const label = (key, fallback) => {
        try {
          const value = ctx.locale.bind(namespace)(key)
          return typeof value === 'string' && value.length > 0 && value !== key ? value : fallback
        } catch {
          return fallback
        }
      }

      const refresh = async () => {
        try {
          await ctx.sessions.refresh()
        } catch {
          window.location.reload()
        }
      }

      const openBin = () => {
        binState.set({ ...binState.get(), open: true, notice: null, error: null })
        void loadBin(ctx.locale.bind(namespace))
      }

      // Each surface is registered on its own, so a future DSH that renames one
      // extension point leaves the others working instead of blanking the whole
      // plugin.
      try {
        ctx.inject(['contextMenus'], (scope) => {
          try {
            scope.effect(() => scope.contextMenus.register({
              id: 'session.delete',
              target: 'session',
              order: 700,
              observe: () => [],
              resolve: (target) => [{
                id: 'delete',
                label: label('menu.delete', 'Delete session'),
                icon: { key: 'session-delete.trash' },
                danger: true,
                afterContent: true,
                run: () => {
                  confirm.set({
                    sessionId: String(target.sessionId),
                    title: typeof target.displayTitle === 'string' ? target.displayTitle : '',
                  })
                },
              }],
            }), 'session-delete: session menu')
          } catch (error) {
            console.warn('[session-delete] session menu contribution failed; the footer trash still works.', error)
          }
        })
      } catch (error) {
        console.warn('[session-delete] contextMenus injection failed; the footer trash still works.', error)
      }

      registerIn(ctx, 'contextMenu.icon', { key: 'session-delete.trash' }, TrashGlyph)
      registerIn(ctx, 'sidebar.footer.action', {
        id: 'session-delete.trash',
        order: 0,
        locale: namespace,
        inject: () => ({ openBin }),
      }, TrashButton)
      registerIn(ctx, 'shell.overlay', {
        id: 'session-delete.confirm',
        locale: namespace,
        inject: () => ({ refresh }),
      }, DeleteDialog)
      registerIn(ctx, 'shell.overlay', {
        id: 'session-delete.bin',
        locale: namespace,
        inject: () => ({ refresh }),
      }, BinDialog)

      void refreshBadge()
    }

    return { inject, apply }
  },
})
