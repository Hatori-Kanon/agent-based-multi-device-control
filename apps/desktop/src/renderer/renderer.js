// Operator surface. Talks to the main process over the narrow bridge in
// preload.cjs and has no Node access of its own.

const host = window.host
const devicesEl = document.getElementById('devices')
const bannerEl = document.getElementById('lockBanner')
const errEl = document.getElementById('err')
const wfBody = document.querySelector('#wfTable tbody')
const auditEl = document.getElementById('auditLog')

let latest = null
let waveforms = []
/** Channels whose controls the operator is actively editing. */
const editing = new Set()

function fail(message) {
  errEl.textContent = message
  setTimeout(() => { if (errEl.textContent === message) errEl.textContent = '' }, 6000)
}

function describe(error) {
  return String(error && error.message ? error.message : error)
}

async function call(promise) {
  try {
    const snapshot = await promise
    if (snapshot && snapshot.devices) render(snapshot)
  } catch (error) {
    fail(describe(error))
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
    call(host.setCap(deviceId, channel.id, { [field]: Number(input.value) }))
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
    call(host.setWaveform(deviceId, channel.id, select.value === '' ? undefined : select.value))
  })
  return select
}

function channelRow(deviceId, channel) {
  const row = document.createElement('div')
  row.className = 'ch'

  const name = document.createElement('div')
  name.className = 'ch-name'
  name.innerHTML = `${channel.label}<div class="ch-kind">${channel.id} · ${channel.kind}</div>`

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
  }

  const durLabel = document.createElement('label')
  const dur = document.createElement('input')
  dur.type = 'number'
  dur.min = '1'
  dur.max = '600'
  dur.value = String(channel.maxDurationSec)
  const durKey = `${deviceId}:${channel.id}:dur`
  dur.addEventListener('focus', () => editing.add(durKey))
  dur.addEventListener('change', () => {
    editing.delete(durKey)
    call(host.setCap(deviceId, channel.id, { maxDurationSec: Number(dur.value) }))
  })
  durLabel.append('时长上限', dur, 's')
  caps.append(durLabel)

  if (channel.supportsWaveform) {
    const wfLabel = document.createElement('label')
    wfLabel.append('波形', waveformSelect(deviceId, channel))
    caps.append(wfLabel)
  }

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
  demo.textContent = '试跑'
  demo.disabled = latest?.locked === true
  demo.addEventListener('click', () => call(host.demo(deviceId, channel.id)))
  const stop = document.createElement('button')
  stop.textContent = '停止'
  stop.addEventListener('click', () => call(host.stop(deviceId, channel.id)))
  acts.append(demo, stop)

  row.append(name, middle, acts)
  return row
}

function render(snapshot) {
  latest = snapshot
  bannerEl.classList.toggle('on', snapshot.locked === true)
  if (editing.size > 0) return

  devicesEl.replaceChildren(...snapshot.devices.map(device => {
    const card = document.createElement('div')
    card.className = 'device'
    const header = document.createElement('header')
    const title = document.createElement('h2')
    title.textContent = device.name
    const life = document.createElement('span')
    life.className = `life ${device.lifecycle}`
    life.textContent = device.lifecycle
    header.append(title, life)
    const needsReconnect = device.lifecycle === 'failed' || device.lifecycle === 'disconnected'
    if (needsReconnect) {
      const reconnect = document.createElement('button')
      reconnect.textContent = device.lifecycle === 'failed' ? '重连' : '连接'
      reconnect.style.marginLeft = 'auto'
      reconnect.style.fontSize = '12px'
      reconnect.style.padding = '4px 10px'
      reconnect.addEventListener('click', () => call(host.connect(device.id)))
      header.append(reconnect)
    }
    if (device.canScan && device.lifecycle === 'ready') {
      const scan = document.createElement('button')
      scan.textContent = '扫描设备'
      scan.style.marginLeft = 'auto'
      scan.style.fontSize = '12px'
      scan.style.padding = '4px 10px'
      scan.disabled = device.lifecycle !== 'ready'
      scan.addEventListener('click', () => call(host.scan(device.id, 5000)))
      header.append(scan)
    }
    if (device.channels.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'ch'
      empty.style.color = '#62626e'
      empty.style.fontSize = '12px'
      empty.textContent = device.canScan ? '未发现设备，点“扫描设备”' : '无可用通道'
      card.append(header, empty)
      return card
    }
    card.append(header, ...device.channels.map(channel => channelRow(device.id, channel)))
    return card
  }))
}

function renderWaveforms() {
  wfBody.replaceChildren(...waveforms.map(entry => {
    const row = document.createElement('tr')
    const tags = entry.tags.map(tag => `<span class="tag">${tag}</span>`).join('')
    row.innerHTML = `
      <td>${entry.name}</td>
      <td><code>${entry.id}</code></td>
      <td class="scope-${entry.scope}">${entry.scope === 'session' ? '会话' : '库'}</td>
      <td>${(entry.durationMs / 1000).toFixed(1)}s</td>
      <td>${entry.peakIntensity}</td>
      <td>${entry.minFreq}–${entry.maxFreq}</td>
      <td>${tags}</td>`
    const actionCell = document.createElement('td')
    if (entry.scope === 'session') {
      const promote = document.createElement('button')
      promote.textContent = '存入库'
      promote.addEventListener('click', async () => {
        try {
          waveforms = await host.promoteWaveform(entry.id)
          renderWaveforms()
        } catch (error) {
          fail(describe(error))
        }
      })
      actionCell.append(promote)
    }
    row.append(actionCell)
    return row
  }))
}

function renderAudit(records) {
  auditEl.replaceChildren(...records.slice().reverse().map(record => {
    const line = document.createElement('div')
    line.className = `r-${record.result ?? 'ok'} a-${record.actor ?? 'system'}`
    const time = (record.ts ?? '').slice(11, 19)
    const extra = record.reason ? ` — ${record.reason}` : ''
    line.textContent = `${time} [${record.actor}] ${record.action} ${record.result}${extra}`
    return line
  }))
}

document.getElementById('panic').addEventListener('click', () => call(host.panic()))
document.getElementById('unlock').addEventListener('click', () => call(host.unlock()))

document.getElementById('wfImport').addEventListener('click', async () => {
  const name = document.getElementById('wfName').value.trim()
  const frames = document.getElementById('wfFrames').value
  try {
    await host.importWaveform(name, frames)
    waveforms = await host.waveforms()
    renderWaveforms()
    document.getElementById('wfFrames').value = ''
  } catch (error) {
    fail(describe(error))
  }
})

host.onChanged(() => { void refresh() })
host.onError(message => { fail(message) })

async function refresh() {
  try {
    const snapshot = await host.snapshot()
    if (snapshot) render(snapshot)
    if (document.getElementById('auditPanel').open) renderAudit(await host.audit())
  } catch (error) {
    fail(describe(error))
  }
}

void (async () => {
  const info = await host.info()
  document.getElementById('accel').textContent = info.accelerator ?? '—'
  document.getElementById('panicAddr').textContent = info.panicAddress
    ? `POST http://${info.panicAddress.host}:${info.panicAddress.port}/panic`
    : '未启动'
  waveforms = await host.waveforms()
  renderWaveforms()
  await refresh()
  setInterval(refresh, 300)
})()
