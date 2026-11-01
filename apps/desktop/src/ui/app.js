// 设备视图前端（v3 单窗口）。纯静态，只通过 dashboard 的 JSON API 说话；
// 桌面与 Android WebView（M4b）共用同一份文件。
//
// 与 v2 的区别（`设备范围与单窗口界面-设计说明.md` §3.2）：
//   - 页面不再拥有顶栏：本文件只操作 #view-device 里带 dev 前缀的节点，
//     顶栏的连接药丸 / 会话药丸 / 急停按钮归 play.js；
//   - 每个通道一条「通道条」：强度条本身是直控滑杆（POST /api/level），
//     下面是强度范围与频率范围（POST /api/cap），不再有「试跑 15s」；
//   - 直控拖动节流 ~120ms，非零时每 5s keepalive 续期；切走视图、页面隐藏、
//     急停或锁定时立刻停掉 keepalive（切视图/页面隐藏会先发一次 0）。
//
// 视图隐藏时（document.body.dataset.view !== 'device'）所有轮询直接返回；
// `viewchange` 切回设备视图时立即刷新一次。

(() => {
  const token = new URLSearchParams(location.search).get('token') ?? ''
  const LEVEL_THROTTLE_MS = 120
  const LEVEL_KEEPALIVE_MS = 5000
  /** 单条直控命令的时长上限：取通道 maxDurationSec 与 15 的较小值。 */
  const LEVEL_MAX_DURATION_SEC = 15
  const MIN_FREQ = 10
  const MAX_FREQ = 240

  const el = {
    devConnState: document.getElementById('devConnState'),
    devLockState: document.getElementById('devLockState'),
    devLockBanner: document.getElementById('devLockBanner'),
    devUnlock: document.getElementById('devUnlock'),
    devDevices: document.getElementById('devDevices'),
    devAddDevice: document.getElementById('devAddDevice'),
    devAddDialog: document.getElementById('devAddDialog'),
    devAddConfirm: document.getElementById('devAddConfirm'),
    devAddCancel: document.getElementById('devAddCancel'),
    devLogsToggle: document.getElementById('devLogsToggle'),
    devLogPanel: document.getElementById('devLogPanel'),
    devLogs: document.getElementById('devLogs'),
    devAuditToggle: document.getElementById('devAuditToggle'),
    devAuditPanel: document.getElementById('devAuditPanel'),
    devWfName: document.getElementById('devWfName'),
    devWfFrames: document.getElementById('devWfFrames'),
    devWfImport: document.getElementById('devWfImport'),
    devWfGrid: document.getElementById('devWfGrid'),
    devSensors: document.getElementById('devSensors'),
    devErrorsPanel: document.getElementById('devErrorsPanel'),
    devErrors: document.getElementById('devErrors'),
    devStatDevices: document.getElementById('devStatDevices'),
    devStatChannels: document.getElementById('devStatChannels'),
    devDebugToggle: document.getElementById('devDebugToggle'),
    devDebugPanel: document.getElementById('devDebugPanel'),
    devDebugProbes: document.getElementById('devDebugProbes'),
    devRailHome: document.getElementById('devRailHome'),
    devRailOpenLogs: document.getElementById('devRailOpenLogs'),
    devRailOpenAudit: document.getElementById('devRailOpenAudit'),
    devRailOpenDebug: document.getElementById('devRailOpenDebug'),
    devAudit: document.getElementById('devAudit'),
    err: document.getElementById('err'),
  }

  let snapshot = null
  let waveforms = []
  let logsOpen = false
  let auditOpen = false
  /**
   * Process-local debug switch mirrored in this page.
   *
   * Off is the default and the safe state: while it is false the console does
   * not fetch (and therefore cannot render) a single probe number or resolved
   * target. The switch lives on the host (`GET/POST /api/debug`); toggling it
   * never writes audit and never reaches the model.
   */
  let debugEnabled = false
  /** Keys of manifest devices: only these get a 移除 button. */
  let managedKeys = new Set()
  /** 正在编辑的通道控件（device:channel:field）。 */
  const editing = new Set()
  /** 上一次快照的锁定状态，用于「刚锁上」时立即停掉直控 keepalive。 */
  let wasLocked = false

  // ── 视图 ────────────────────────────────────────────────────────────────
  function isDeviceView() {
    return document.body.dataset.view === 'device'
  }

  /** 三个遥测面板都收起时显示右栏入口卡；有面板打开时让位。 */
  function syncRailHome() {
    el.devRailHome.style.display = logsOpen || auditOpen || debugEnabled ? 'none' : ''
  }

  // ── 基础工具 ────────────────────────────────────────────────────────────
  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  /** 错误提示：用底部的 .toast 呈现，几秒后自动收起。 */
  let errorTimer = 0
  function fail(message) {
    el.err.textContent = message
    el.err.classList.add('on')
    clearTimeout(errorTimer)
    errorTimer = setTimeout(() => { el.err.classList.remove('on') }, 6000)
  }

  /** 同一条错误只提示一次，避免 5s keepalive 失败时反复弹 toast。 */
  const lastErrors = new Map()
  function noteError(channel, message) {
    if (lastErrors.get(channel) === message) return
    lastErrors.set(channel, message)
    fail(message)
  }
  function clearError(channel) {
    lastErrors.delete(channel)
  }

  async function api(path, options = {}) {
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 8000
    const { timeoutMs: _ignored, ...init } = options
    const response = await fetch(path, {
      ...init,
      // 每个请求都带超时：一次挂起的 fetch 会让 500ms 轮询不断叠加挂起请求。
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        'x-control-token': token,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      let code
      try {
        const body = await response.json()
        if (body.error) message = body.error
        if (typeof body.code === 'string') code = body.code
      } catch { /* not JSON */ }
      const error = new Error(message)
      error.status = response.status
      if (code !== undefined) error.code = code
      throw error
    }
    return response.json()
  }

  /** 采纳一次写操作返回的快照 / 波形库，不让调用方各自重复判断。 */
  function adopt(result) {
    if (result && result.snapshot && result.snapshot.devices) {
      snapshot = result.snapshot
      renderDevices()
    } else if (result && result.devices && !('snapshot' in result)) {
      snapshot = result
      renderDevices()
    }
    if (result && result.waveforms) {
      waveforms = result.waveforms
      renderWaveforms()
    }
  }

  async function call(promise) {
    try {
      adopt(await promise)
    } catch (error) {
      fail(error.message ?? String(error))
    }
  }

  // ── 直控（POST /api/level） ──────────────────────────────────────────────
  /**
   * 每个通道的直控状态。
   *
   * `percent` 是本地意图（命令服务端的绝对值），`sentPercent` 是最后一次
   * 真正发出的值；两者都在 0 时不再发请求（「0 = 停止」不需要重复续期）。
   */
  const levels = new Map()

  function levelStateOf(deviceId, channelId) {
    const key = `${deviceId}:${channelId}`
    let state = levels.get(key)
    if (state === undefined) {
      state = {
        key,
        deviceId,
        channelId,
        percent: 0,
        pending: 0,
        sentPercent: 0,
        timer: undefined,
        keepalive: undefined,
        lastSent: 0,
      }
      levels.set(key, state)
    }
    return state
  }

  function channelOf(deviceId, channelId) {
    if (snapshot === null || !Array.isArray(snapshot.devices)) return undefined
    const device = snapshot.devices.find(entry => entry.id === deviceId)
    if (device === undefined || device === null) return undefined
    return (Array.isArray(device.channels) ? device.channels : []).find(entry => entry.id === channelId)
  }

  /** 直控命令的 durationSec：通道 maxDurationSec 与 15 的较小值。 */
  function levelDurationSec(channel) {
    const maxDuration = channel !== undefined && channel !== null ? finite(channel.maxDurationSec) : undefined
    if (maxDuration === undefined) return LEVEL_MAX_DURATION_SEC
    return Math.max(1, Math.min(Math.floor(maxDuration), LEVEL_MAX_DURATION_SEC))
  }

  function stopKeepalive(state) {
    if (state.keepalive !== undefined) {
      clearInterval(state.keepalive)
      state.keepalive = undefined
    }
  }

  function startKeepalive(state) {
    if (state.keepalive !== undefined) return
    // 续期必须早于 durationSec 到期：maxDurationSec 很短时（1–4s）固定 5s
    // 会出现输出断档，所以间隔取 duration 的一半、封顶 5s。
    const channel = channelOf(state.deviceId, state.channelId)
    const interval = Math.max(500, Math.min(LEVEL_KEEPALIVE_MS, Math.floor((levelDurationSec(channel) * 1000) / 2)))
    state.keepalive = setInterval(() => {
      // 切走视图 / 页面隐藏 / 已锁定：不再续期，立即归零本地状态。
      if (!isDeviceView() || document.hidden || (snapshot !== null && snapshot.locked === true)) {
        releaseLevel(state, false)
        return
      }
      if (state.percent > 0) void sendLevel(state, state.percent, true)
    }, interval)
  }

  async function sendLevel(state, percent, silent) {
    const channel = channelOf(state.deviceId, state.channelId)
    state.percent = percent
    state.lastSent = Date.now()
    try {
      await api('/api/level', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: state.deviceId,
          channelId: state.channelId,
          percent,
          durationSec: levelDurationSec(channel),
        }),
        timeoutMs: 4000,
      })
      clearError(`level:${state.key}`)
      // 慢响应可能比后来的 0 更晚回来：只有它仍是当前意图时才续期。
      if (percent > 0 && state.percent === percent) startKeepalive(state)
      else if (state.percent === 0) stopKeepalive(state)
    } catch (error) {
      // keepalive 失败只提示一次；同时停止续期，让服务端按 durationSec 到期。
      if (!silent) noteError(`level:${state.key}`, `直控失败：${error.message ?? String(error)}`)
      if (percent > 0 && state.percent === percent) stopKeepalive(state)
      if (error.code === 'LOCKED' || error.status === 403) releaseLevels({ sendZero: false })
    }
  }

  function flushLevel(state) {
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    const percent = state.pending
    // 已经是 0 且最后一次也发过 0：不再发送（0 没有需要续期的输出）。
    if (percent === 0 && state.sentPercent === 0) {
      stopKeepalive(state)
      return
    }
    // input 与紧随其后的 change 常常是同一个值：一个节流窗口内不重复发。
    if (percent === state.sentPercent && Date.now() - state.lastSent < LEVEL_THROTTLE_MS) return
    state.sentPercent = percent
    void sendLevel(state, percent, false)
  }

  /** 拖动节流 ~120ms：首次立即发，之后合并到 120ms 窗口的尾部。 */
  function scheduleLevel(state, percent, immediate) {
    state.percent = percent
    state.pending = percent
    if (immediate) {
      flushLevel(state)
      return
    }
    const elapsed = Date.now() - state.lastSent
    if (elapsed >= LEVEL_THROTTLE_MS) {
      flushLevel(state)
      return
    }
    if (state.timer === undefined) {
      state.timer = setTimeout(() => {
        state.timer = undefined
        flushLevel(state)
      }, LEVEL_THROTTLE_MS - elapsed)
    }
  }

  function releaseLevel(state, sendZero) {
    stopKeepalive(state)
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    const had = state.percent
    state.percent = 0
    state.pending = 0
    if (sendZero && had > 0) {
      state.sentPercent = 0
      void sendLevel(state, 0, true)
    }
  }

  function releaseLevels({ sendZero }) {
    for (const state of levels.values()) releaseLevel(state, sendZero)
  }

  /** 通道级停止：先本地归零（停 keepalive），再让服务端 stop。 */
  function stopChannel(deviceId, channelId) {
    const state = levels.get(`${deviceId}:${channelId}`)
    if (state !== undefined) releaseLevel(state, false)
    void call(api('/api/stop', {
      method: 'POST',
      body: JSON.stringify({ deviceId, channelId }),
    }))
  }

  // ── 通道条控件 ──────────────────────────────────────────────────────────
  function paintRange(input) {
    const min = Number(input.min)
    const max = Number(input.max)
    const value = Number(input.value)
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
    input.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct))}%`)
  }

  /** 通道的边界字段；缺失时返回 undefined，由 UI 显示「—」并禁用。 */
  function capsOf(channel) {
    const minPercent = finite(channel.minPercent)
    const maxPercent = finite(channel.maxPercent)
    const minFreq = finite(channel.minFreq)
    const maxFreq = finite(channel.maxFreq)
    return {
      minPercent,
      maxPercent,
      minFreq,
      maxFreq,
      intensity: minPercent !== undefined && maxPercent !== undefined && maxPercent > minPercent,
      frequency: minFreq !== undefined && maxFreq !== undefined && maxFreq > minFreq,
    }
  }

  /** 强度条 + 叠在上面的直控滑杆；0 = 停止。 */
  function levelControl(deviceId, channel, locked) {
    const row = document.createElement('div')
    row.className = 'level-row'
    const rail = document.createElement('div')
    rail.className = 'level-rail'
    const meter = document.createElement('div')
    meter.className = 'meter tall'
    const fill = document.createElement('i')
    meter.append(fill)
    const floor = document.createElement('span')
    floor.className = 'level-floor'
    const input = document.createElement('input')
    input.type = 'range'
    input.className = 'level-input'
    input.step = '1'

    const readout = document.createElement('span')
    readout.className = 'val level-readout'

    const caps = capsOf(channel)
    const state = levelStateOf(deviceId, channel.id)
    if (!caps.intensity) {
      // 旧宿主还没有 minPercent/maxPercent：显示 —，禁用直控，避免发出超界值。
      input.min = '0'
      input.max = '100'
      input.value = '0'
      input.disabled = true
      rail.setAttribute('title', '宿主尚未提供通道范围；直控暂不可用')
      fill.style.width = '0%'
      readout.textContent = '—'
      rail.append(meter, floor, input)
      row.append(rail, readout)
      return row
    }

    const minPercent = caps.minPercent
    const maxPercent = caps.maxPercent
    const actual = finite(channel.percent)
    const commanded = state.percent > 0 ? state.percent : (actual ?? 0)
    const value = Math.min(maxPercent, Math.max(0, commanded))
    input.min = '0'
    input.max = String(maxPercent)
    input.value = String(value)
    input.disabled = locked
    input.title = `直接控制输出（0 = 停止；有效区间 ${minPercent}%–${maxPercent}%）`
    input.setAttribute('aria-label', `${channel.label ?? channel.id ?? '通道'} 直控强度`)
    rail.style.setProperty('--floor', `${(minPercent / maxPercent) * 100}%`)
    fill.style.width = `${(value / maxPercent) * 100}%`
    readout.textContent = `${value}%`

    const key = `${deviceId}:${channel.id}:level`
    const begin = () => editing.add(key)
    const finish = () => editing.delete(key)
    const paintLocal = next => {
      const snapped = next <= 0 ? 0 : Math.max(minPercent, Math.min(maxPercent, next))
      if (snapped !== next) input.value = String(snapped)
      fill.style.width = `${(snapped / maxPercent) * 100}%`
      readout.textContent = `${snapped}%`
      return snapped
    }
    input.addEventListener('focus', begin)
    input.addEventListener('pointerdown', begin)
    input.addEventListener('pointerup', finish)
    input.addEventListener('blur', finish)
    input.addEventListener('input', () => {
      const next = paintLocal(Number(input.value))
      scheduleLevel(state, next, false)
    })
    input.addEventListener('change', () => {
      finish()
      const next = paintLocal(Number(input.value))
      // 0 必须真的停下来。`sentPercent` 只记录本页发过的值，而正在输出的
      // 可能是模型或另一个客户端（此时 sentPercent 仍是 0），走 flushLevel
      // 的早退会让「拖到 0」静默失效、读数 500ms 后又弹回去。
      if (next === 0) {
        if (state.timer !== undefined) {
          clearTimeout(state.timer)
          state.timer = undefined
        }
        state.pending = 0
        state.sentPercent = 0
        stopKeepalive(state)
        void sendLevel(state, 0, false)
        return
      }
      scheduleLevel(state, next, true)
    })

    rail.append(meter, floor, input)
    row.append(rail, readout)
    return row
  }

  /** 一组 min/max 滑杆（强度范围或频率范围），联动保证 min < max。 */
  function capRange(deviceId, channel, kind, locked) {
    const caps = capsOf(channel)
    const wrap = document.createElement('div')
    wrap.className = 'cap-range'
    const label = document.createElement('span')
    label.className = 'cap-label'
    label.textContent = kind === 'intensity' ? '强度范围' : '频率范围'
    wrap.append(label)

    const available = kind === 'intensity' ? caps.intensity : caps.frequency
    if (!available) {
      const dash = document.createElement('span')
      dash.className = 'val'
      dash.textContent = '—'
      wrap.append(dash)
      wrap.title = '宿主尚未提供该通道范围'
      return wrap
    }

    const intensity = kind === 'intensity'
    const loMin = intensity ? caps.minPercent : caps.minFreq
    const hiMax = intensity ? caps.maxPercent : caps.maxFreq
    const floor = intensity ? 0 : MIN_FREQ
    const ceiling = intensity ? 100 : MAX_FREQ
    // 强度用百分比，频率用协议编码单位（界面上直接写出来，别只藏在 title 里）。
    // 读屏器要能回答「这是哪台设备哪个通道的哪一端」，三组滑杆不能同名。
    const deviceName = (snapshot?.devices ?? []).find(device => device.id === deviceId)?.name ?? deviceId
    const channelName = channel.label ?? channel.id ?? '通道'
    const rangeName = `${deviceName} ${channelName} ${intensity ? '强度' : '频率'}`

    const lo = document.createElement('input')
    lo.type = 'range'
    lo.min = String(floor)
    lo.max = String(hiMax - 1)
    lo.step = '1'
    lo.value = String(loMin)
    lo.disabled = locked
    lo.title = intensity ? '强度下限（必须小于上限）' : '频率下限（编码单位，必须小于上限）'
    lo.setAttribute('aria-label', `${rangeName}下限`)
    const hi = document.createElement('input')
    hi.type = 'range'
    hi.min = String(loMin + 1)
    hi.max = String(ceiling)
    hi.step = '1'
    hi.value = String(hiMax)
    hi.disabled = locked
    hi.title = intensity ? '强度上限（必须大于下限）' : '频率上限（编码单位，必须大于下限）'
    hi.setAttribute('aria-label', `${rangeName}上限`)

    const readout = document.createElement('span')
    readout.className = 'val'
    const key = `${deviceId}:${channel.id}:${kind}`
    const sync = () => {
      lo.max = String(Number(hi.value) - 1)
      hi.min = String(Number(lo.value) + 1)
      if (Number(lo.value) > Number(lo.max)) lo.value = lo.max
      if (Number(hi.value) < Number(hi.min)) hi.value = hi.min
      paintRange(lo)
      paintRange(hi)
      readout.textContent = intensity ? `${lo.value}%–${hi.value}%` : `${lo.value}–${hi.value}（编码）`
    }
    const begin = () => editing.add(key)
    const finish = () => editing.delete(key)
    for (const input of [lo, hi]) {
      input.addEventListener('focus', begin)
      input.addEventListener('pointerdown', begin)
      input.addEventListener('pointerup', finish)
      input.addEventListener('blur', finish)
      input.addEventListener('input', sync)
    }
    lo.addEventListener('change', () => {
      finish()
      sync()
      void call(api('/api/cap', {
        method: 'POST',
        body: JSON.stringify({
          deviceId,
          channelId: channel.id,
          patch: intensity ? { minPercent: Number(lo.value) } : { minFreq: Number(lo.value) },
        }),
      }))
    })
    hi.addEventListener('change', () => {
      finish()
      sync()
      void call(api('/api/cap', {
        method: 'POST',
        body: JSON.stringify({
          deviceId,
          channelId: channel.id,
          patch: intensity ? { maxPercent: Number(hi.value) } : { maxFreq: Number(hi.value) },
        }),
      }))
    })

    sync()
    wrap.append(lo, hi, readout)
    return wrap
  }

  function waveformSelect(deviceId, channel) {
    const select = document.createElement('select')
    const none = document.createElement('option')
    none.value = ''
    none.textContent = '（无波形）'
    select.append(none)
    for (const entry of waveforms) {
      const option = document.createElement('option')
      option.value = entry.id
      option.textContent = `${entry.name} · ${entry.scope === 'session' ? '会话' : '库'}`
      select.append(option)
    }
    select.value = channel.waveform ? channel.waveform.id : ''
    select.setAttribute('aria-label', `${channel.label ?? channel.id ?? '通道'} 波形`)
    select.addEventListener('change', () => {
      call(api('/api/waveforms/select', {
        method: 'POST',
        body: JSON.stringify({ deviceId, channelId: channel.id, waveformId: select.value || null }),
      }))
    })
    return select
  }

  function channelRow(deviceId, channel, locked) {
    const row = document.createElement('div')
    row.className = 'ch'

    const name = document.createElement('div')
    name.className = 'ch-name'
    const title = document.createElement('span')
    title.textContent = channel.label ?? channel.id ?? '通道'
    const small = document.createElement('small')
    const floorText = finite(channel.outputFloorPercent) !== undefined && channel.outputFloorPercent > 0
      ? ` · 最小非零≈${channel.outputFloorPercent}%`
      : ''
    small.textContent = `${channel.id ?? '—'} · ${channel.kind ?? '通道'}${floorText}`
    name.append(title, small)

    const middle = document.createElement('div')
    middle.className = 'ch-mid'
    middle.append(levelControl(deviceId, channel, locked))

    const caps = document.createElement('div')
    caps.className = 'caps'
    caps.append(capRange(deviceId, channel, 'intensity', locked))
    // 频率范围是策略的一部分，所有通道都展示；旧快照缺字段时显示 — 并禁用。
    caps.append(capRange(deviceId, channel, 'frequency', locked))

    const maxDuration = finite(channel.maxDurationSec)
    const dur = document.createElement('label')
    dur.className = 'cap-duration'
    const durInput = document.createElement('input')
    durInput.type = 'number'
    durInput.min = '1'
    durInput.max = '600'
    durInput.value = String(maxDuration ?? 60)
    durInput.disabled = locked || maxDuration === undefined
    durInput.setAttribute('aria-label', `${channel.label ?? channel.id ?? '通道'} 时长上限（秒）`)
    const durKey = `${deviceId}:${channel.id}:dur`
    durInput.addEventListener('focus', () => editing.add(durKey))
    durInput.addEventListener('blur', () => editing.delete(durKey))
    durInput.addEventListener('change', () => {
      editing.delete(durKey)
      call(api('/api/cap', {
        method: 'POST',
        body: JSON.stringify({ deviceId, channelId: channel.id, patch: { maxDurationSec: Number(durInput.value) } }),
      }))
    })
    dur.append('时长上限', durInput, 's')
    caps.append(dur)

    if (channel.supportsWaveform) {
      const wfLabel = document.createElement('label')
      const select = waveformSelect(deviceId, channel)
      select.disabled = locked
      wfLabel.append('波形', select)
      caps.append(wfLabel)
    }

    // 运行中的效果给一个标签（预设 + 剩余时间）。没有效果时不再重复输出百分比：
    // 强度条右侧的读数已经显示当前输出，两个「0%」并排没有信息量。
    const effect = channel.effect
    if (effect !== null && typeof effect === 'object') {
      const state = document.createElement('span')
      state.className = 'tag gold'
      state.textContent = `输出中 · ${effect.preset ?? '—'} · ${Math.ceil((finite(effect.remainingMs) ?? 0) / 1000)}s`
      caps.append(state)
    }
    middle.append(caps)

    const acts = document.createElement('div')
    acts.className = 'acts'
    const stop = document.createElement('button')
    stop.className = 'mini'
    stop.type = 'button'
    stop.textContent = '停止'
    stop.title = '立即停止该通道输出（0 = 停止）'
    stop.addEventListener('click', () => stopChannel(deviceId, channel.id))
    acts.append(stop)

    row.append(name, middle, acts)
    return row
  }

  // ── 设备卡 ──────────────────────────────────────────────────────────────
  function renderDevices() {
    if (snapshot === null) return
    const locked = snapshot.locked === true
    // 刚锁上：直控 keepalive 必须立刻停掉，别再等下一次 5s 续期。
    if (locked && !wasLocked) releaseLevels({ sendZero: false })
    wasLocked = locked

    el.devLockBanner.classList.toggle('on', locked)
    el.devLockState.textContent = locked ? '已锁定' : '未锁定'
    el.devLockState.className = locked ? 'q-bad' : 'q-ok'
    el.devStatDevices.textContent = `${snapshot.devices.length} 台`
    const channelCount = snapshot.devices.reduce(
      (total, device) => total + (Array.isArray(device.channels) ? device.channels.length : 0),
      0,
    )
    el.devStatChannels.textContent = `${channelCount} 路`
    el.devConnState.textContent = `已连接 · ${snapshot.devices.length} 设备`
    el.devConnState.className = 'pill on'

    // 正在设备卡里操作（滑杆拖动、下拉展开、输入框聚焦）时不要重建卡片：
    // 500ms 轮询会把展开的 <select> 和光标一起收掉。状态栏与锁定横幅上面已经更新。
    // 只有「表单控件」聚焦才算编辑——按钮聚焦不能让整张卡停止刷新。
    const active = document.activeElement
    const editingFocus = active !== null && el.devDevices.contains(active)
      && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')
    if (editing.size > 0 || editingFocus) return
    // 按钮焦点在重建后会丢：记下「第几张卡 + 按钮文字」，重建后放回等价按钮，
    // 否则键盘用户在设备卡里每 500ms 就被弹回页面开头。
    const focusHint = active !== null && el.devDevices.contains(active) && active.tagName === 'BUTTON'
      ? { card: [...el.devDevices.querySelectorAll('.device')].indexOf(active.closest('.device')), label: active.textContent }
      : null

    const cards = snapshot.devices.map(device => {
      const card = document.createElement('div')
      card.className = 'device'
      const header = document.createElement('header')
      const title = document.createElement('h2')
      title.textContent = device.name
      const life = document.createElement('span')
      // 链路丢失对操作者只意味着「断开」；连接按钮才会重新开始扫描。
      const shownLife = device.lifecycle === 'failed' ? 'disconnected' : device.lifecycle
      life.className = `life ${shownLife}`
      life.textContent = shownLife
      const actions = document.createElement('div')
      actions.className = 'device-actions'
      header.append(title, life, actions)

      if (device.lifecycle === 'failed' || device.lifecycle === 'disconnected') {
        const connect = document.createElement('button')
        connect.className = 'mini'
        connect.type = 'button'
        connect.textContent = '连接'
        connect.addEventListener('click', () => call(api('/api/connect', {
          method: 'POST',
          body: JSON.stringify({ deviceId: device.id }),
        })))
        actions.append(connect)
      }
      if (device.canScan && device.lifecycle === 'ready') {
        const scan = document.createElement('button')
        scan.className = 'mini'
        scan.type = 'button'
        scan.textContent = '扫描设备'
        scan.addEventListener('click', () => call(api('/api/scan', {
          method: 'POST',
          body: JSON.stringify({ deviceId: device.id, durationMs: 5000 }),
        })))
        actions.append(scan)
      }

      if (managedKeys.has(device.id)) {
        const remove = document.createElement('button')
        remove.className = 'mini'
        remove.type = 'button'
        remove.textContent = '移除'
        remove.style.color = 'var(--bad)'
        remove.addEventListener('click', async () => {
          if (!window.confirm(`移除 ${device.name}？输出会立即停止并断开连接。`)) return
          for (const channel of Array.isArray(device.channels) ? device.channels : []) {
            const state = levels.get(`${device.id}:${channel.id}`)
            if (state !== undefined) releaseLevel(state, false)
          }
          try {
            await api('/api/devices/remove', {
              method: 'POST',
              body: JSON.stringify({ key: device.id }),
            })
            await refresh()
          } catch (error) {
            fail(error.message ?? String(error))
          }
        })
        actions.append(remove)
      }

      const channels = Array.isArray(device.channels) ? device.channels : []
      if (channels.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'empty'
        empty.textContent = device.canScan ? '未发现设备，点「扫描设备」' : '无可用通道'
        card.append(header, empty)
        return card
      }
      card.append(header, ...channels.map(channel => channelRow(device.id, channel, locked)))
      return card
    })

    if (cards.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '还没有设备。用左栏「添加设备」选择协议后手动连接。'
      el.devDevices.replaceChildren(empty)
      return
    }
    el.devDevices.replaceChildren(...cards)
    // 重建后把焦点放回同一张卡上文字相同的按钮。
    if (focusHint !== null && focusHint.card >= 0) {
      const card = el.devDevices.querySelectorAll('.device')[focusHint.card]
      const target = card === undefined
        ? undefined
        : [...card.querySelectorAll('button')].find(button => button.textContent === focusHint.label)
      if (target !== undefined) target.focus()
    }
  }

  function renderWaveforms() {
    if (waveforms.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '还没有波形：粘贴帧序列导入，或让 agent 在会话里创作后「存入库」。'
      el.devWfGrid.replaceChildren(empty)
      return
    }
    el.devWfGrid.replaceChildren(...waveforms.map(entry => {
      const card = document.createElement('div')
      card.className = 'wf-card'
      const row1 = document.createElement('div')
      row1.className = 'row1'
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = entry.name
      const scope = document.createElement('span')
      scope.className = `scope ${entry.scope}`
      scope.textContent = entry.scope === 'session' ? '会话' : '库'
      row1.append(name, scope)

      const meta = document.createElement('div')
      meta.className = 'meta'
      meta.textContent = `${(entry.durationMs / 1000).toFixed(1)}s · 峰值 ${entry.peakIntensity} · 频率 ${entry.minFreq}-${entry.maxFreq}`
      const tags = document.createElement('div')
      tags.className = 'tags'
      for (const tag of entry.tags) {
        const chip = document.createElement('span')
        chip.className = 'tag'
        chip.textContent = tag
        tags.append(chip)
      }
      card.append(row1, meta, tags)

      if (entry.scope === 'session') {
        const promote = document.createElement('button')
        promote.className = 'mini'
        promote.type = 'button'
        promote.style.marginTop = '8px'
        promote.textContent = '存入库'
        promote.addEventListener('click', () => call(api('/api/waveforms/promote', {
          method: 'POST',
          body: JSON.stringify({ id: entry.id }),
        })))
        card.append(promote)
      }
      return card
    }))
  }

  async function renderAudit() {
    if (!auditOpen || !isDeviceView()) return
    try {
      const records = await api('/api/audit')
      if (records.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'hint'
        empty.textContent = '（暂无审计记录）'
        el.devAudit.replaceChildren(empty)
        return
      }
      el.devAudit.replaceChildren(...records.slice().reverse().map(record => {
        const line = document.createElement('div')
        line.className = `r-${record.result ?? 'ok'} a-${record.actor ?? 'system'}`
        const time = (record.ts ?? '').slice(11, 19)
        const extra = record.reason ? ` — ${record.reason}` : ''
        line.textContent = `${time} [${record.actor}] ${record.action} ${record.result}${extra}`
        return line
      }))
    } catch (error) {
      fail(error.message ?? String(error))
    }
  }

  async function renderLogs() {
    if (!logsOpen || !isDeviceView()) return
    try {
      const body = await api('/api/logs')
      const lines = body.lines ?? []
      if (lines.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'hint'
        empty.textContent = '（暂无日志）'
        el.devLogs.replaceChildren(empty)
      } else {
        // 逐行一个 div，才能命中 style.css 里 .log > div 的等宽折行样式。
        el.devLogs.replaceChildren(...lines.map(line => {
          const row = document.createElement('div')
          row.textContent = line
          return row
        }))
      }
      el.devLogs.scrollTop = el.devLogs.scrollHeight
    } catch {
      // The log panel must never take the console down with it.
    }
  }

  async function renderErrors() {
    if (!isDeviceView()) return
    try {
      const records = await api('/api/errors')
      if (!records || records.length === 0) {
        el.devErrorsPanel.style.display = 'none'
        return
      }
      el.devErrorsPanel.style.display = ''
      el.devErrors.replaceChildren(...records.slice().reverse().map(record => {
        const line = document.createElement('div')
        const time = new Date(record.ts).toLocaleTimeString()
        line.textContent = `[${time}] ${record.message}`
        return line
      }))
    } catch {
      // The errors panel must never take the console down with it.
    }
  }

  /** Availability/quality wording; no measured value ever appears here. */
  const QUALITY_TEXT = {
    ok: '可用', dim: '偏暗', bright: '过亮', blocked: '被遮挡', stale: '过旧', unavailable: '不可用',
  }
  const QUALITY_CLASS = {
    ok: 'q-ok', dim: 'q-warn', bright: 'q-warn', blocked: 'q-bad', stale: 'q-warn', unavailable: 'q-bad',
  }

  function renderSensors(sources) {
    if (!Array.isArray(sources) || sources.length === 0) {
      const empty = document.createElement('span')
      empty.className = 'hint'
      empty.textContent = '未注册感知源'
      el.devSensors.replaceChildren(empty)
      return
    }
    el.devSensors.replaceChildren(...sources.map(source => {
      const row = document.createElement('div')
      row.className = 'sensor-row'
      const label = document.createElement('span')
      // 只显示源 id/kind 与质量词：默认控制台从不显示数值特征、probe 差值或解析命令。
      label.textContent = `${source.id} · ${source.kind}`
      const quality = document.createElement('span')
      quality.className = QUALITY_CLASS[source.quality] ?? 'q-warn'
      quality.textContent = QUALITY_TEXT[source.quality] ?? String(source.quality)
      row.append(label, quality)
      return row
    }))
  }

  async function refreshSensors() {
    if (!isDeviceView()) return
    try {
      const body = await api('/api/sensors')
      renderSensors(body.sources ?? [])
    } catch {
      // The perception panel must never take the console down with it.
    }
  }

  /** One debug row: probe numbers plus the resolved target it was dispatched to. */
  function probeLine(probe) {
    const row = document.createElement('div')
    const delta = probe.delta
      ? `Δ运动 ${Number(probe.delta.motion).toFixed(3)} · Δ音频 ${Number(probe.delta.audioPct).toFixed(1)}%`
      : 'Δ 不可比'
    const resolved = (probe.targets ?? [])
      .map(target => `${target.deviceId}:${target.channelId}`)
      .join(', ')
    row.textContent = `${probe.probeId} · ${probe.beatId}/${probe.intentId} · ${probe.verdict} · 方向 ${probe.direction} · 幅度 ${probe.magnitude} · ${delta} · 解析 ${resolved || '无目标'}`
    return row
  }

  function applyDebugState(enabled) {
    debugEnabled = enabled === true
    el.devDebugToggle.classList.toggle('active', debugEnabled)
    el.devDebugToggle.setAttribute('aria-pressed', debugEnabled ? 'true' : 'false')
    syncRailHome()
  }

  async function renderDebugProbes() {
    if (!debugEnabled || !isDeviceView()) {
      // Off means off: no request, no DOM nodes above this one, nothing to
      // screenshot or copy out of the page by accident.
      if (!debugEnabled) {
        el.devDebugProbes.replaceChildren()
        el.devDebugPanel.style.display = 'none'
      }
      return
    }
    el.devDebugPanel.style.display = ''
    try {
      const probes = await api('/api/debug/probes')
      if (!debugEnabled) return
      if (!Array.isArray(probes) || probes.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'hint'
        empty.textContent = '（暂无已结算的 probe）'
        el.devDebugProbes.replaceChildren(empty)
        return
      }
      el.devDebugProbes.replaceChildren(...probes.slice().reverse().map(probeLine))
    } catch (error) {
      // 另一个控制台把调试关掉时服务器返回 403：本页要跟着关，而不是每 2 秒刷一次错误。
      if (error.status === 403) {
        applyDebugState(false)
        return
      }
      fail(error.message ?? String(error))
    }
  }

  async function syncDebug() {
    try {
      applyDebugState((await api('/api/debug')).enabled)
    } catch {
      applyDebugState(false)
    }
    await renderDebugProbes()
  }

  // ── 添加设备弹窗 ────────────────────────────────────────────────────────
  function openAddDialog() {
    el.devAddDialog.style.display = 'flex'
    // 弹窗打开时把焦点送进对话框，关闭后还给「添加设备」按钮。
    const first = el.devAddDialog.querySelector('input[name="addProto"]')
    if (first !== null && first !== undefined) first.focus()
  }
  function closeAddDialog() {
    if (el.devAddDialog === null || el.devAddDialog.style.display === 'none') return
    el.devAddDialog.style.display = 'none'
    el.devAddDevice.focus()
  }

  el.devAddDevice.addEventListener('click', openAddDialog)
  el.devAddCancel.addEventListener('click', closeAddDialog)
  el.devAddDialog.addEventListener('click', event => {
    if (event.target === el.devAddDialog) closeAddDialog()
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAddDialog()
  })
  el.devAddConfirm.addEventListener('click', async () => {
    const checked = document.querySelector('input[name="addProto"]:checked')
    const protocol = checked ? checked.value : 'coyote'
    closeAddDialog()
    try {
      const result = await api('/api/devices', {
        method: 'POST',
        body: JSON.stringify({ protocol }),
      })
      adopt(result)
      await refresh()
    } catch (error) {
      fail(error.message ?? String(error))
    }
  })

  // ── 事件接线 ────────────────────────────────────────────────────────────
  el.devUnlock.addEventListener('click', async () => {
    try {
      adopt(await api('/api/unlock', {
        method: 'POST',
        body: JSON.stringify({ note: 'unlocked from web console' }),
      }))
      await refresh()
    } catch (error) {
      fail(error.message ?? String(error))
    }
  })

  el.devLogsToggle.addEventListener('click', () => {
    logsOpen = !logsOpen
    el.devLogPanel.style.display = logsOpen ? '' : 'none'
    el.devLogsToggle.classList.toggle('active', logsOpen)
    el.devLogsToggle.setAttribute('aria-pressed', logsOpen ? 'true' : 'false')
    syncRailHome()
    if (logsOpen) renderLogs()
  })

  el.devAuditToggle.addEventListener('click', () => {
    auditOpen = !auditOpen
    el.devAuditPanel.style.display = auditOpen ? '' : 'none'
    el.devAuditToggle.classList.toggle('active', auditOpen)
    el.devAuditToggle.setAttribute('aria-pressed', auditOpen ? 'true' : 'false')
    syncRailHome()
    if (auditOpen) renderAudit()
  })

  // 右栏入口卡只是顶栏开关的快捷方式，不改变任何面板语义。
  el.devRailOpenLogs.addEventListener('click', () => el.devLogsToggle.click())
  el.devRailOpenAudit.addEventListener('click', () => el.devAuditToggle.click())
  el.devRailOpenDebug.addEventListener('click', () => el.devDebugToggle.click())

  el.devWfImport.addEventListener('click', async () => {
    try {
      await call(api('/api/waveforms/import', {
        method: 'POST',
        body: JSON.stringify({ name: el.devWfName.value.trim(), frames: el.devWfFrames.value }),
      }))
      el.devWfFrames.value = ''
    } catch (error) {
      fail(error.message ?? String(error))
    }
  })

  el.devDebugToggle.addEventListener('click', async () => {
    try {
      const state = await api('/api/debug', {
        method: 'POST',
        body: JSON.stringify({ enabled: !debugEnabled }),
      })
      applyDebugState(state.enabled)
      await renderDebugProbes()
    } catch (error) {
      fail(error.message ?? String(error))
    }
  })

  async function refresh() {
    if (!isDeviceView()) return
    try {
      const [snap, manager] = await Promise.all([
        api('/api/snapshot'),
        api('/api/devices').catch(() => ({ devices: [] })),
      ])
      snapshot = snap
      managedKeys = new Set((Array.isArray(manager.devices) ? manager.devices : [])
        .map(device => device.key))
      renderDevices()
    } catch (error) {
      el.devConnState.textContent = '连接失败'
      el.devConnState.className = 'pill bad'
      fail(error.message ?? String(error))
    }
  }

  async function loadWaveforms() {
    try {
      const library = await api('/api/waveforms')
      if (Array.isArray(library)) {
        waveforms = library
        renderWaveforms()
      }
    } catch {
      // 波形库加载失败不应阻断控制台；导入/存库成功后仍会通过 call() 刷新。
    }
  }

  /** 切到设备视图时立即拉一次全部面板，不等下一个轮询窗口。 */
  async function activateDevice() {
    closeAddDialog()
    await Promise.all([
      refresh(),
      refreshSensors(),
      renderErrors(),
      syncDebug(),
      loadWaveforms(),
    ])
    if (auditOpen) await renderAudit()
    if (logsOpen) await renderLogs()
  }

  window.addEventListener('viewchange', event => {
    const view = event.detail !== undefined && event.detail !== null ? event.detail.view : undefined
    if (view === 'device') {
      void activateDevice()
      return
    }
    // 切走设备视图：不再续期直控；给仍非零的通道发一次 0，避免坐在游玩页时
    // 输出还要靠 durationSec 自然到期。
    closeAddDialog()
    releaseLevels({ sendZero: true })
  })

  // 顶栏急停只有 play.js 绑定；它派发这个事件，设备视图据此立即松开直控。
  window.addEventListener('embodied:panic', () => {
    releaseLevels({ sendZero: false })
    if (isDeviceView()) void refresh()
  })

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseLevels({ sendZero: true })
  })

  // 页面卸载时也松开 keepalive；stop 请求未必来得及，但服务端会在
  // durationSec 内自然到期（直控命令永远不是无限输出）。
  window.addEventListener('pagehide', () => releaseLevels({ sendZero: false }))

  void (async () => {
    if (token.length < 16) {
      el.devConnState.textContent = '缺少 token'
      el.devConnState.className = 'pill bad'
      fail('URL 缺少 token 参数；请从启动日志打开应用地址')
      return
    }
    // 设备视图默认隐藏：先把轮询装上（回调里会检查视图），当前就在设备视图
    // 时才立即拉一次，避免游玩视图启动时白跑一整轮请求。
    setInterval(() => { void refresh() }, 500)
    setInterval(() => { void renderAudit() }, 3_000)
    setInterval(() => { void renderErrors() }, 3_000)
    setInterval(() => { void renderLogs() }, 2_000)
    setInterval(() => { void refreshSensors() }, 3_000)
    setInterval(() => { void renderDebugProbes() }, 2_000)
    if (isDeviceView()) await activateDevice()
  })()
})()
