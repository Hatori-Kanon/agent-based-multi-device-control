// 控制台前端。纯静态，只通过 dashboard 的 JSON API 说话；桌面与 Android
// WebView（M4b）共用同一份文件。

(() => {
  const token = new URLSearchParams(location.search).get('token') ?? ''
  const el = {
    conn: document.getElementById('conn'),
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
    playOpen: document.getElementById('playOpen'),
    debugToggle: document.getElementById('debugToggle'),
    debugPanel: document.getElementById('debugPanel'),
    debugProbes: document.getElementById('debugProbes'),
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

  function fail(message) {
    el.err.textContent = message
    setTimeout(() => { if (el.err.textContent === message) el.err.textContent = '' }, 6000)
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        'x-control-token': token,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      },
    })
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        const body = await response.json()
        if (body.error) message = body.error
      } catch { /* not JSON */ }
      throw new Error(message)
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
    readout.textContent = `${channel[field]}${suffix}`
    input.addEventListener('pointerdown', () => editing.add(key))
    input.addEventListener('input', () => { readout.textContent = `${input.value}${suffix}` })
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
    const meter = document.createElement('div')
    meter.className = 'meter'
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
    durInput.addEventListener('change', () => {
      editing.delete(durKey)
      call(api('/api/cap', {
        method: 'POST',
        body: JSON.stringify({ deviceId, channelId: channel.id, patch: { maxDurationSec: Number(durInput.value) } }),
      }))
    })
    dur.append('时长上限', durInput, 's')
    caps.append(dur)

    const state = document.createElement('span')
    state.className = 'val'
    state.textContent = channel.effect
      ? `${channel.effect.preset} · ${Math.ceil(channel.effect.remainingMs / 1000)}s`
      : `${channel.percent}%`
    caps.append(state)
    middle.append(meter, caps)

    const acts = document.createElement('div')
    acts.className = 'acts'
    const demo = document.createElement('button')
    demo.className = 'mini'
    demo.textContent = '试跑 15s'
    demo.disabled = snapshot?.locked === true
    demo.addEventListener('click', () => call(api('/api/demo', {
      method: 'POST',
      body: JSON.stringify({ deviceId, channelId: channel.id }),
    })))
    const stop = document.createElement('button')
    stop.className = 'mini'
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
    if (editing.size > 0) return
    el.lockBanner.classList.toggle('on', snapshot.locked === true)
    el.conn.textContent = `已连接 · ${snapshot.devices.length} 设备`
    el.conn.classList.add('on')

    el.devices.replaceChildren(...snapshot.devices.map(device => {
      const card = document.createElement('div')
      card.className = 'device'
      const header = document.createElement('header')
      const title = document.createElement('h2')
      title.textContent = device.name
      const life = document.createElement('span')
      // A lost link is just "disconnected" to the operator; the app retries only
      // when they press 连接.
      const shownLife = device.lifecycle === 'failed' ? 'disconnected' : device.lifecycle
      life.className = `life ${shownLife}`
      life.textContent = shownLife
      header.append(title, life)

      if (device.lifecycle === 'failed' || device.lifecycle === 'disconnected') {
        const connect = document.createElement('button')
        connect.className = 'mini'
        connect.textContent = '连接'
        connect.addEventListener('click', () => call(api('/api/connect', {
          method: 'POST',
          body: JSON.stringify({ deviceId: device.id }),
        })))
        header.append(connect)
      }
      if (device.canScan && device.lifecycle === 'ready') {
        const scan = document.createElement('button')
        scan.className = 'mini'
        scan.textContent = '扫描设备'
        scan.addEventListener('click', () => call(api('/api/scan', {
          method: 'POST',
          body: JSON.stringify({ deviceId: device.id, durationMs: 5000 }),
        })))
        header.append(scan)
      }

      if (managedKeys.has(device.id)) {
        const remove = document.createElement('button')
        remove.className = 'mini'
        remove.textContent = '移除'
        remove.style.borderColor = '#7d2642'
        remove.style.color = '#ef8095'
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
        header.append(remove)
      }

      if (device.channels.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'ch'
        empty.style.color = '#5f5f6a'
        empty.textContent = device.canScan ? '未发现设备，点“扫描设备”' : '无可用通道'
        card.append(header, empty)
        return card
      }
      card.append(header, ...device.channels.map(channel => channelRow(device.id, channel)))
      return card
    }))
  }

  function renderWaveforms() {
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
  el.addDevice.addEventListener('click', () => { el.addDialog.style.display = 'flex' })
  el.addCancel.addEventListener('click', () => { el.addDialog.style.display = 'none' })
  el.addDialog.addEventListener('click', event => {
    if (event.target === el.addDialog) el.addDialog.style.display = 'none'
  })
  el.addConfirm.addEventListener('click', async () => {
    const checked = document.querySelector('input[name="addProto"]:checked')
    const protocol = checked ? checked.value : 'coyote'
    el.addDialog.style.display = 'none'
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
    el.logsToggle.textContent = logsOpen ? '收起日志' : '日志'
    if (logsOpen) renderLogs()
  })

  el.auditToggle.addEventListener('click', () => {
    auditOpen = !auditOpen
    el.auditPanel.style.display = auditOpen ? '' : 'none'
    el.auditToggle.textContent = auditOpen ? '收起审计' : '审计'
    if (auditOpen) renderAudit()
  })

  async function renderLogs() {
    if (!logsOpen) return
    try {
      const body = await api('/api/logs')
      const lines = body.lines ?? []
      el.logs.textContent = lines.length === 0 ? '（暂无日志）' : lines.join('\n')
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
      el.conn.classList.remove('on')
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
      const row = document.createElement('span')
      row.className = 'sensor'
      const label = document.createElement('span')
      // Source id/kind plus the quality word only: the default console never
      // shows a numeric feature, probe delta or resolved command.
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
    el.debugToggle.classList.toggle('on', debugEnabled)
    el.debugToggle.setAttribute('aria-pressed', debugEnabled ? 'true' : 'false')
    el.debugToggle.textContent = debugEnabled ? '调试中' : '调试'
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
      el.conn.classList.remove('on')
      fail('URL 缺少 token 参数；请从启动日志打开控制台地址')
      return
    }
    await refresh()
    await renderErrors()
    await refreshSensors()
    await syncDebug()
    setInterval(refresh, 500)
    setInterval(renderAudit, 3_000)
    setInterval(renderErrors, 3_000)
    setInterval(renderLogs, 2_000)
    setInterval(refreshSensors, 3_000)
    setInterval(renderDebugProbes, 2_000)
  })()
})()
