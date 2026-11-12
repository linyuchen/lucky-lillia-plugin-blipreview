import { createElement as h, useEffect, useRef, useState } from 'react'
import { SchemaForm, usePluginContext, usePluginStatus } from '@luckylillia/plugin-sdk/webui'

const pending = state => ['generating', 'waiting', 'scanned'].includes(state)
const stack = { display: 'grid', gap: 14 }
const revision = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
const loginValues = value => ({ cookie: value?.cookie ?? null, refreshToken: value?.refreshToken ?? null, loginRevision: value?.loginRevision ?? '' })
const loginDraft = value => ({ account: value?.account, changed: false, original: loginValues(value), credentials: null })

function QrLogin({ account = 'default', onCredentials, onPending, onStart, disabled }) {
  const ctx = usePluginContext()
  const plugin = usePluginStatus()
  const active = !!plugin && !plugin.disabled && plugin.state === 'active'
  const validAccount = typeof account === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(account)
  const endpoint = '/api/blipreview/login/' + encodeURIComponent(account ?? '')
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const actions = useRef(null)
  const ownedId = useRef(null)
  const callbacks = useRef(null)
  callbacks.current = { onCredentials, onStart }

  useEffect(() => { onPending(pending(status?.state) || busy === 'start' || busy === 'credentials') }, [status?.state, busy, onPending])

  useEffect(() => {
    setStatus(null)
    setError('')
    setBusy('')
    if (!active || !validAccount) return
    let disposed = false
    let pendingRequest = false
    let timer
    let synchronizedId
    const controller = new AbortController()
    const call = async (action, id) => {
      const response = await ctx.fetch(endpoint + '/' + action, {
        method: action === 'status' ? 'GET' : 'POST',
        ...(action === 'status' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }),
        signal: controller.signal,
      })
      const result = await response.json()
      if (!response.ok || !result.success) throw new Error(response.status === 404
        ? '登录服务暂不可用，请重载插件后重试。' : result.message || '登录操作失败，请重试。')
      return result.data
    }
    const run = async action => {
      if (disposed || pendingRequest) return
      pendingRequest = true
      clearTimeout(timer)
      setBusy(action)
      let next
      let needsCredentials = false
      try {
        if (action === 'start') {
          ownedId.current = revision()
          callbacks.current.onStart()
        }
        next = await call(action, ownedId.current)
        if (disposed) return
        setStatus(next)
        if (next.state === 'success' && next.id !== synchronizedId) {
          needsCredentials = true
          setBusy('credentials')
          await callbacks.current.onCredentials(controller.signal, next.id === ownedId.current)
          if (disposed) return
          synchronizedId = next.id
          needsCredentials = false
        }
        setError('')
        if (!pending(next.state) || next.id !== ownedId.current) ownedId.current = null
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : '登录操作失败，请重试。')
      } finally {
        pendingRequest = false
        if (!disposed) {
          setBusy('')
          if (pending(next?.state) || ownedId.current || needsCredentials) timer = setTimeout(() => { void run('status') }, 1000)
        }
      }
    }
    actions.current = run
    void run('status')
    return () => {
      disposed = true
      clearTimeout(timer)
      controller.abort()
      actions.current = null
      const id = ownedId.current
      ownedId.current = null
      if (id) void ctx.fetch(endpoint + '/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }), keepalive: true,
      }).catch(() => {})
    }
  }, [ctx, active, validAccount, endpoint])

  const act = action => { void actions.current?.(action) }
  const waiting = pending(status?.state)
  const seconds = status?.expiresAt ? Math.max(0, Math.ceil((status.expiresAt - Date.now()) / 1000)) : 0
  const loginState = status?.loggedIn === true ? 'B站已登录'
    : status?.hasCredentials ? status.loggedIn === false ? 'B站登录已失效，请重新登录' : '已保存登录凭据，当前登录状态未确认' : 'B站未登录'
  const available = active && validAccount

  return h('div', { style: stack },
    !active
      ? h('p', { className: 'text-sm text-theme-muted' }, '启用插件后可以扫码登录，也可以先手动填写 Cookie。')
      : !validAccount
        ? h('p', { className: 'text-sm text-theme-muted' }, '登录服务暂不可用，请重载插件后重试。')
        : h('div', { style: stack },
          h('p', { className: 'text-sm text-theme-secondary', role: 'status', 'aria-live': 'polite' },
            busy === 'start' ? '正在生成二维码…' : status?.message || (status ? loginState : '正在读取登录状态…')),
          error && h('p', { className: 'text-sm text-red-500', role: 'alert' }, error),
          status?.image && waiting && h('div', { style: { display: 'grid', justifyItems: 'center', gap: 8 } },
            h('img', { src: status.image, alt: 'B站登录二维码', style: { width: 260, maxWidth: '100%', borderRadius: 12 } }),
            h('span', { className: 'text-sm text-theme-muted' }, seconds + ' 秒内使用手机 B站 App 扫码确认'),
          ),
        ),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
      available && !waiting && h('button', { type: 'button', className: 'btn-primary', disabled: disabled || !!busy || !!status?.busy, onClick: () => act('start') },
        status?.state === 'expired' || status?.state === 'error' ? '重新获取二维码' : status?.loggedIn ? '重新扫码登录' : '扫码登录'),
      available && waiting && ownedId.current && h('button', { type: 'button', className: 'btn-glass', disabled: !!busy, onClick: () => act('cancel') }, '取消扫码'),
    ),
  )
}

function LoginSection({ value, onChange, errors, draft }) {
  const ctx = usePluginContext()
  const plugin = usePluginStatus()
  const active = !!plugin && !plugin.disabled && plugin.state === 'active'
  const endpoint = '/api/blipreview/login/' + encodeURIComponent(value.account ?? 'default') + '/credentials'
  const current = useRef(null)
  current.current = { value, onChange }
  const [loading, setLoading] = useState(active && !draft.current.changed)
  const [loadError, setLoadError] = useState('')
  const [qrPending, setQrPending] = useState(false)
  const [display, setDisplay] = useState(() => draft.current.credentials ?? loginValues(value))
  const scanRevision = useRef(null)

  const readCredentials = async signal => {
    const response = await ctx.fetch(endpoint, { signal })
    const result = await response.json()
    if (!response.ok || !result.success || typeof result.data?.cookie !== 'string' || typeof result.data?.refreshToken !== 'string') {
      throw new Error('读取已保存的 Cookie 失败，请重新打开配置后重试。')
    }
    return result.data
  }
  const fillCredentials = (credentials, ownScan) => {
    const { value: latest, onChange: update } = current.current
    draft.current.credentials = credentials
    setDisplay(credentials)
    // Reading or scanning displays runtime credentials without submitting them as a form edit.
    // Otherwise saving an old dialog could roll back a Cookie that renewed in the background.
    if (ownScan) {
      draft.current.changed = false
      update({ ...latest, ...draft.current.original })
    }
  }

  useEffect(() => {
    setLoadError('')
    if (!active || draft.current.changed) { setLoading(false); return }
    let disposed = false
    const controller = new AbortController()
    setLoading(true)
    void readCredentials(controller.signal).then(credentials => {
      if (!disposed && !draft.current.changed) fillCredentials(credentials, false)
    }).catch(() => {
      if (!disposed) setLoadError('读取已保存的 Cookie 失败，请重新打开配置后重试。')
    }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true; controller.abort() }
  }, [ctx, active, endpoint, draft])

  const syncCredentials = async (signal, ownScan) => {
    if (draft.current.changed && (!ownScan || current.current.value.loginRevision !== scanRevision.current)) return
    const before = current.current.value.loginRevision
    const credentials = await readCredentials(signal)
    signal.throwIfAborted()
    // A late response must not replace a newer manual edit.
    if (current.current.value.loginRevision !== before) return
    fillCredentials(credentials, ownScan)
    setLoadError('')
  }
  const edit = (field, text) => {
    const { value: latest, onChange: update } = current.current
    const credentials = { ...(draft.current.credentials ?? loginValues(latest)), [field]: text.trim() ? text : null,
      // A replacement Cookie cannot reuse the previous login's refresh token.
      ...(field === 'cookie' ? { refreshToken: null } : {}) }
    draft.current.changed = true
    draft.current.credentials = credentials
    setDisplay(credentials)
    update({ ...latest, ...credentials, loginRevision: revision() })
  }
  const input = (field, label, placeholder) => h('label', { style: { display: 'grid', gap: 6 } },
    h('span', { className: 'text-sm text-theme-secondary' }, label),
    h('input', {
      type: 'password', className: 'input-field', 'aria-label': label, 'aria-invalid': !!errors?.[field],
      autoComplete: 'off', spellCheck: false, value: display[field] ?? '', placeholder, disabled: loading || qrPending,
      onFocus: event => { if (display[field] === '********') event.currentTarget.select() },
      onChange: event => edit(field, event.target.value),
    }),
    errors?.[field] && h('span', { className: 'text-xs text-red-500', role: 'alert' }, errors[field]),
  )

  return h('section', { 'aria-label': 'B站登录', className: 'rounded-xl border border-theme-divider p-4', style: stack },
    h('h4', { className: 'text-sm font-medium text-theme' }, 'B站登录'),
    h('label', { className: 'flex items-center justify-between gap-4' },
      h('span', { className: 'text-sm text-theme-secondary' }, '启用「登录B站」指令'),
      h('input', { type: 'checkbox', className: 'switch-toggle', checked: value.qrLogin?.enabled ?? true,
        'aria-invalid': !!errors?.['qrLogin.enabled'],
        onChange: event => onChange({ ...value, qrLogin: { ...value.qrLogin, enabled: event.target.checked } }),
      }),
    ),
    errors?.['qrLogin.enabled'] && h('p', { className: 'text-xs text-red-500', role: 'alert' }, errors['qrLogin.enabled']),
    h('p', { className: 'text-xs text-theme-muted' }, '在聊天窗口发送「登录B站」后，机器人会在该窗口回复二维码，用手机 B站 App 扫码确认即可登录。'),
    h('p', { className: 'text-xs text-theme-muted' },
      '登录指令默认仅主人可用，请先在「',
      h('a', { href: '#commands', className: 'text-pink-500 hover:underline' }, '指令'),
      '」插件中设置主人。'),
    h(QrLogin, { account: value.account, disabled: loading, onPending: setQrPending, onCredentials: syncCredentials,
      onStart: () => { scanRevision.current = current.current.value.loginRevision } }),
    input('cookie', 'Cookie', '扫码后自动填写，也可粘贴包含 SESSDATA 的完整 Cookie'),
    input('refreshToken', 'refresh_token（可选）', '扫码后自动填写，用于自动续期；手动导入可留空'),
    loadError && h('p', { className: 'text-xs text-red-500', role: 'alert' }, loadError),
    h('p', { className: 'text-xs text-theme-muted' }, '扫码成功后自动保存并填入 Cookie；手动修改或清空后，点击下方“保存”生效。'),
    h('p', { className: 'text-xs text-theme-muted' }, '有配套的 refresh_token 时自动续期；无需额外设置。'),
  )
}

/** @param {import('@luckylillia/plugin-sdk/webui').ConfigEditorProps} props */
function PreviewEditor({ value, onChange, schema, errors }) {
  const draft = useRef(loginDraft(value))
  if (draft.current.account !== value?.account) draft.current = loginDraft(value)
  const fields = Object.keys(schema?.refs?.[schema.uid]?.dict ?? {}).filter(field => !['account', 'requestTimeout', 'loginRevision'].includes(field))
  const summaryIndex = fields.indexOf('summaryMode')
  const before = fields.slice(0, summaryIndex + 1)
  const after = fields.slice(summaryIndex + 1).filter(field => !['model', 'cookie', 'refreshToken', 'maxSubtitleLength', 'qrLogin'].includes(field))
  const form = selected => h(SchemaForm, { schema, value, onChange, errors, fields: selected })
  const enabled = value?.summaryMode === 'official' || value?.summaryMode === 'llm'

  return h('div', { style: { display: 'grid', gap: 20 } },
    form(before),
    value?.summaryMode === 'llm' && form(['model']),
    enabled && h(LoginSection, { value, onChange, errors, draft }),
    value?.summaryMode === 'llm' && form(['maxSubtitleLength']),
    after.length > 0 && form(after),
  )
}

/** @param {import('@luckylillia/plugin-sdk/webui').WebUIContext} ctx */
export default function apply(ctx) {
  ctx.config(PreviewEditor)
}
