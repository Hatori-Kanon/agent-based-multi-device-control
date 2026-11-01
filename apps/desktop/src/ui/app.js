// 控制台前端。纯静态，只通过 dashboard 的 JSON API 说话；桌面与 Android
// WebView（M4b）共用同一份文件。

(() => {
  const token = new URLSearchParams(location.search).get('token') ?? ''
  const el = {
    conn: document.getElementById('conn'),
    lockState: document.getElementById('lockState'),
    panic: document.getElementById('panic'),
    lockBanner: document.getElementById('lockBanner'),
    unlock: document.getElementById('unlock'),
    devices: document.getElementById('devices'),
    addDevice: document.getElementById('addDevice'),
    addDialog: document.getElementById('addDialog'),
    addConfirm: document.getElementById('addConfirm'),
    addCancel: document.getElementById('addCancel'),
    logsToggle: document.getElementById('logsToggle'),
    logPanel: document.getElementById('logPanel'),
    logs: document.getElementById('logs'),
    auditToggle: document.getElementById('auditToggle'),
    auditPanel: document.getElementById('auditPanel'),
    wfName: document.getElementById('wfName'),
    wfFrames: document.getElementById('wfFrames'),
    wfImport: document.getElementById('wfImport'),
    wfGrid: document.getElementById('wfGrid'),
    sensors: document.getElementById('sensors'),
    statDevices: document.getElementById('statDevices'),
    statChannels: document.getElementById('statChannels'),
    statLocked: document.getElementById('statLocked'),
    playOpen: document.getElementById('playOpen'),
    debugToggle: document.getElementById('debugToggle'),
    debugPanel: document.getElementById('debugPanel'),
    debugProbes: document.getElementById('debugProbes'),
    railHome: document.getElementById('railHome'),
    railOpenLogs: document.getElementById('railOpenLogs'),
    railOpenAudit: document.getElementById('railOpenAudit'),
    railOpenDebug: document.getElementById('railOpenDebug'),
    audit: document.getElementById('audit'),
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
  const editing = new Set()

  /** 三个遥测面板都收起时显示右栏入口卡；有面板打开时让位。 */
  function syncRailHome() {
    el.railHome.style.display = logsOpen || auditOpen || debugEnabled ? 'none' : ''
  }

  /** 错误提示：用底部的 .toast 呈现，几秒后自动收起。 */
  let errorTimer = 0
  function fail(message) {
    el.err.textContent = message
    el.err.classList.add('on')
    clearTimeout(errorTimer)
    errorTimer = setTimeout(() => { el.err.classList.remove('on') }, 6000)
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
      try {
        const body = await response.json()
        if (body.error) message = body.error
      } catch { /* not JSON */ }
      const error = new Error(message)
      error.status = response.status
      throw error
    }
    return response.json()
  }

  async function call(promise) {
    try {
      const result = await promise
      // Only bare snapshot responses qualify ({locked, devices...}); the
      // add/remove device routes wrap theirs in {snapshot, devices} and are
      // handled by their own explicit handlers.
      if (result && result.devices && !('snapshot' in result)) {
        snapshot = result
        renderDevices()
      }
      if (result && result.waveforms) {
        waveforms = result.waveforms
        renderWaveforms()
      }
    } catch (error) {
      fail(error.message ?? String(error))
    }
  }

  function capControl(deviceId, channel, field, label, max, suffix) {
    const key = `${deviceId}:${channel.id}:${field}`
    const wrap = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'range'
    input.min = '0'
    input.max = String(max)
    input.value = String(channel[field])
    const readout = document.createElement('span')
    readout.className = 'val'
    // 金色轨道进度由 --fill 驱动；读数和填充在拖动时即时同步。
    const sync = () => {
      const pct = max > 0 ? (Number(input.value) / max) * 100 : 0
      input.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct))}%`)
      readout.textContent = `${input.value}${suffix}`
    }
    sync()
    input.addEventListener('pointerdown', () => editing.add(key))
    input.addEventListener('input', sync)
    // 失焦/松手都算编辑结束：只靠 change 的话，点一下没改值会让 editing
    // 永久卡住，500ms 的整卡重绘就被永久跳过。
    input.addEventListener('blur', () => { editing.delete(key) })
    input.addEventListener('pointerup', () => { editing.delete(key) })
    input.addEventListener('change', () => {
      editing.delete(key)
      call(api('/api/cap', {
        method: 'POST',
        body: JSON.stringify({ deviceId, channelId: channel.id, patch: { [field]: Number(input.value) } }),
      }))
    })
    wrap.append(label, input, readout)
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
    select.addEventListener('change', () => {
      call(api('/api/waveforms/select', {
        method: 'POST',
        body: JSON.stringify({ deviceId, channelId: channel.id, waveformId: select.value || null }),
      }))
    })
    return select
  }

  function channelRow(deviceId, channel) {
    const row = document.createElement('div')
    row.className = 'ch'

    const name = document.createElement('div')
    name.className = 'ch-name'
    name.innerHTML = `${channel.label}<small>${channel.id} · ${channel.kind}${channel.outputFloorPercent > 0 ? ` · 最小非零≈${channel.outputFloorPercent}%` : ''}</small>`

    const middle = document.createElement('div')
    middle.className = 'ch-mid'
    const meter = document.createElement('div')
    meter.className = 'meter tall'
    const fill = channel.maxPercent > 0 ? (channel.percent / channel.maxPercent) * 100 : 0
    meter.innerHTML = `<i style="width:${Math.min(100, fill)}%"></i>`

    const caps = document.createElement('div')
    caps.className = 'caps'
    caps.append(capControl(deviceId, channel, 'maxPercent', '强度上限', 100, '%'))
    if (channel.supportsWaveform) {
      caps.append(capControl(deviceId, channel, 'maxWaveIntensity', '脉宽上限', 100, ''))
      const wfLabel = document.createElement('label')
      wfLabel.append('波形', waveformSelect(deviceId, channel))
      caps.append(wfLabel)
    }

    const dur = document.createElement('label')
    const durInput = document.createElement('input')
    durInput.type = 'number'
    durInput.min = '1'
    durInput.max = '600'
    durInput.value = String(channel.maxDurationSec)
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

    // 当前输出：带标签显示，避免一排滑杆末尾出现孤零零的「0%」。
    const state = document.createElement('span')
    state.className = channel.percent > 0 ? 'tag gold' : 'tag'
    state.textContent = channel.effect
      ? `输出中 · ${channel.effect.preset} · ${Math.ceil(channel.effect.remainingMs / 1000)}s`
      : `输出 ${channel.percent}%`
    caps.append(state)
    middle.append(meter, caps)

    const acts = document.createElement('div')
    acts.className = 'acts'
    const demo = document.createElement('button')
    demo.className = 'mini'
    demo.type = 'button'
    demo.textContent = '试跑 15s'
    demo.disabled = snapshot?.locked === true
    demo.addEventListener('click', () => call(api('/api/demo', {
      method: 'POST',
      body: JSON.stringify({ deviceId, channelId: channel.id }),
    })))
    const stop = document.createElement('button')
    stop.className = 'mini'
    stop.type = 'button'
    stop.textContent = '停止'
    stop.addEventListener('click', () => call(api('/api/stop', {
      method: 'POST',
      body: JSON.stringify({ deviceId, channelId: channel.id }),
    })))
    acts.append(demo, stop)

    row.append(name, middle, acts)
    return row
  }

  async function runPattern(deviceId, channelId) {
    const preset = window.prompt('模式（steady / pulse / wave / random / ramp）', 'wave')
    if (!preset) return
    const maxPercent = Number(window.prompt('最大强度 %', '20'))
    const minPercent = Number(window.prompt('最小强度 %', '5'))
    const durationSec = Number(window.prompt('时长（秒）', '15'))
    const periodMs = Number(window.prompt('周期（毫秒）', '2000'))
    const jitter = Number(window.prompt('抖动 0-100', '10'))
    if (!['steady', 'pulse', 'wave', 'random', 'ramp'].includes(preset)) {
      fail('未知模式：' + preset)
      return
    }
    await call(api('/api/pattern', {
      method: 'POST',
      body: JSON.stringify({ deviceId, channelId, preset, minPercent, maxPercent, periodMs, jitter, durationSec }),
    }))
  }

  function renderDevices() {
    const locked = snapshot.locked === true
    el.lockBanner.classList.toggle('on', locked)
    el.lockState.textContent = locked ? '已锁定' : '未锁定'
    el.lockState.className = locked ? 'pill bad' : 'pill off'
    el.statLocked.textContent = locked ? '已锁定' : '未锁定'
    el.statLocked.className = locked ? 'q-bad' : 'q-ok'
    el.statDevices.textContent = `${snapshot.devices.length} 台`
    const channelCount = snapshot.devices.reduce((total, device) => total + device.channels.length, 0)
    el.statChannels.textContent = `${channelCount} 路`
    el.conn.textContent = `已连接 · ${snapshot.devices.length} 设备`
    el.conn.className = 'pill on'

    // 正在设备卡里操作（滑杆拖动、下拉展开、输入框聚焦）时不要重建卡片：
    // 500ms 轮询会把展开的 <select> 和光标一起收掉。状态栏与锁定横幅上面已经更新。
    // 只有「表单控件」聚焦才算编辑——按钮聚焦不能让整张卡停止刷新。
    const active = document.activeElement
    const editingFocus = active !== null && el.devices.contains(active)
      && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.tagName === 'TEXTAREA')
    if (editing.size > 0 || editingFocus) return
    // 按钮焦点在重建后会丢：记下「第几张卡 + 按钮文字」，重建后放回等价按钮，
    // 否则键盘用户在设备卡里每 500ms 就被弹回页面开头。
    const focusHint = active !== null && el.devices.contains(active) && active.tagName === 'BUTTON'
      ? { card: [...el.devices.querySelectorAll('.device')].indexOf(active.closest('.device')), label: active.textContent }
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

      if (device.channels.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'empty'
        empty.textContent = device.canScan ? '未发现设备，点「扫描设备」' : '无可用通道'
        card.append(header, empty)
        return card
      }
      card.append(header, ...device.channels.map(channel => channelRow(device.id, channel)))
      return card
    })

    if (cards.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '还没有设备。用左栏「添加设备」选择协议后手动连接。'
      el.devices.replaceChildren(empty)
      return
    }
    el.devices.replaceChildren(...cards)
    // 重建后把焦点放回同一张卡上文字相同的按钮。
    if (focusHint !== null && focusHint.card >= 0) {
      const card = el.devices.querySelectorAll('.device')[focusHint.card]
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
      el.wfGrid.replaceChildren(empty)
      return
    }
    el.wfGrid.replaceChildren(...waveforms.map(entry => {
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
    if (!auditOpen) return
    try {
      const records = await api('/api/audit')
      if (records.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'hint'
        empty.textContent = '（暂无审计记录）'
        el.audit.replaceChildren(empty)
        return
      }
      el.audit.replaceChildren(...records.slice().reverse().map(record => {
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

  el.panic.addEventListener('click', () => call(api('/api/panic', {
    method: 'POST',
    body: JSON.stringify({ source: 'web-ui' }),
  })))
  el.unlock.addEventListener('click', () => call(api('/api/unlock', {
    method: 'POST',
    body: JSON.stringify({ note: 'unlocked from web console' }),
  })))
  function openAddDialog() {
    el.addDialog.style.display = 'flex'
    // 弹窗打开时把焦点送进对话框，关闭后还给「添加设备」按钮。
    const first = el.addDialog.querySelector('input[name="addProto"]')
    if (first !== null && first !== undefined) first.focus()
  }
  function closeAddDialog() {
    if (el.addDialog.style.display === 'none') return
    el.addDialog.style.display = 'none'
    el.addDevice.focus()
  }
  el.addDevice.addEventListener('click', openAddDialog)
  el.addCancel.addEventListener('click', closeAddDialog)
  el.addDialog.addEventListener('click', event => {
    if (event.target === el.addDialog) closeAddDialog()
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAddDialog()
  })
  el.addConfirm.addEventListener('click', async () => {
    const checked = document.querySelector('input[name="addProto"]:checked')
    const protocol = checked ? checked.value : 'coyote'
    closeAddDialog()
    try {
      const result = await api('/api/devices', {
        method: 'POST',
        body: JSON.stringify({ protocol }),
      })
      if (result && result.snapshot) {
        snapshot = result.snapshot
        renderDevices()
      }
      await refresh()
    } catch (error) {
      fail(error.message ?? String(error))
    }
  })

  el.logsToggle.addEventListener('click', () => {
    logsOpen = !logsOpen
    el.logPanel.style.display = logsOpen ? '' : 'none'
    el.logsToggle.classList.toggle('active', logsOpen)
    el.logsToggle.setAttribute('aria-pressed', logsOpen ? 'true' : 'false')
    syncRailHome()
    if (logsOpen) renderLogs()
  })

  el.auditToggle.addEventListener('click', () => {
    auditOpen = !auditOpen
    el.auditPanel.style.display = auditOpen ? '' : 'none'
    el.auditToggle.classList.toggle('active', auditOpen)
    el.auditToggle.setAttribute('aria-pressed', auditOpen ? 'true' : 'false')
    syncRailHome()
    if (auditOpen) renderAudit()
  })

  // 右栏入口卡只是顶栏开关的快捷方式，不改变任何面板语义。
  el.railOpenLogs.addEventListener('click', () => el.logsToggle.click())
  el.railOpenAudit.addEventListener('click', () => el.auditToggle.click())
  el.railOpenDebug.addEventListener('click', () => el.debugToggle.click())

  async function renderLogs() {
    if (!logsOpen) return
    try {
      const body = await api('/api/logs')
      const lines = body.lines ?? []
      if (lines.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'hint'
        empty.textContent = '（暂无日志）'
        el.logs.replaceChildren(empty)
      } else {
        // 逐行一个 div，才能命中 style.css 里 .log > div 的等宽折行样式。
        el.logs.replaceChildren(...lines.map(line => {
          const row = document.createElement('div')
          row.textContent = line
          return row
        }))
      }
      el.logs.scrollTop = el.logs.scrollHeight
    } catch {
      // The log panel must never take the console down with it.
    }
  }

  el.wfImport.addEventListener('click', async () => {
    try {
      await call(api('/api/waveforms/import', {
        method: 'POST',
        body: JSON.stringify({ name: el.wfName.value.trim(), frames: el.wfFrames.value }),
      }))
      el.wfFrames.value = ''
    } catch (error) {
      fail(error.message ?? String(error))
    }
  })

  async function refresh() {
    try {
      const [snap, manager] = await Promise.all([
        api('/api/snapshot'),
        api('/api/devices').catch(() => ({ devices: [] })),
      ])
      snapshot = snap
      managedKeys = new Set(manager.devices.map(device => device.key))
      renderDevices()
    } catch (error) {
      el.conn.textContent = '连接失败'
      el.conn.className = 'pill bad'
      fail(error.message ?? String(error))
    }
  }

  async function renderErrors() {
    try {
      const records = await api('/api/errors')
      const panel = document.getElementById('errorsPanel')
      const box = document.getElementById('errors')
      if (!records || records.length === 0) {
        panel.style.display = 'none'
        return
      }
      panel.style.display = ''
      box.replaceChildren(...records.slice().reverse().map(record => {
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
      el.sensors.replaceChildren(empty)
      return
    }
    el.sensors.replaceChildren(...sources.map(source => {
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
    el.debugToggle.classList.toggle('active', debugEnabled)
    el.debugToggle.setAttribute('aria-pressed', debugEnabled ? 'true' : 'false')
    syncRailHome()
  }

  async function renderDebugProbes() {
    if (!debugEnabled) {
      // Off means off: no request, no DOM nodes above this one, nothing to
      // screenshot or copy out of the page by accident.
      el.debugProbes.replaceChildren()
      el.debugPanel.style.display = 'none'
      return
    }
    el.debugPanel.style.display = ''
    try {
      const probes = await api('/api/debug/probes')
      if (!debugEnabled) return
      if (!Array.isArray(probes) || probes.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'hint'
        empty.textContent = '（暂无已结算的 probe）'
        el.debugProbes.replaceChildren(empty)
        return
      }
      el.debugProbes.replaceChildren(...probes.slice().reverse().map(probeLine))
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

  // The play page is a sibling console page; the token travels in the query,
  // exactly like the console's own entry URL (no storage, no referrer deps).
  el.playOpen.addEventListener('click', () => {
    window.open(`/play?token=${encodeURIComponent(token)}`, '_blank', 'noopener')
  })

  el.debugToggle.addEventListener('click', async () => {
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

  void (async () => {
    if (token.length < 16) {
      el.conn.textContent = '缺少 token'
      el.conn.className = 'pill bad'
      fail('URL 缺少 token 参数；请从启动日志打开控制台地址')
      return
    }
    await refresh()
    // 轮询先装上：波形库的补拉不阻塞控制台运行（它有自己的超时）。
    setInterval(refresh, 500)
    setInterval(renderAudit, 3_000)
    setInterval(renderErrors, 3_000)
    setInterval(renderLogs, 2_000)
    setInterval(refreshSensors, 3_000)
    setInterval(renderDebugProbes, 2_000)
    // 波形库是 UI 的一部分，但快照不包含它；补一次现有的 GET 让内建波形可见。
    try {
      const library = await api('/api/waveforms')
      if (Array.isArray(library)) {
        waveforms = library
        renderWaveforms()
      }
    } catch {
      // 波形库加载失败不应阻断控制台；导入/存库成功后仍会通过 call() 刷新。
    }
    await renderErrors()
    await refreshSensors()
    await syncDebug()
  })()
})()
