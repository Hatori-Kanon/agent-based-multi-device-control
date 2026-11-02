// 设置视图前端（v3 单窗口的第三个视图）。纯静态、无框架、无外链资源，只
// 通过 dashboard 的 `/api/settings*` 说话。token 从地址栏读一次，之后只出现
// 在 `x-control-token` 请求头里 —— 不落本地存储、不写 DOM 文本、不进日志。
//
// 边界（`apps/desktop/src/main/host-settings.ts`）：这里是人类设置，不是安全
// 边界 —— 模型配置与摄像头/麦克风采集开关都只由人操作，agent 没有路径。
//
// 密钥规则：`#setApiKey` 是密码框，任何响应里的密钥字段都不会被填进来；保存
// 成功（或失败）后它的值一律清空。页面只用 `hasApiKey` / `apiKeySource` 显示
// 状态（「已保存」「未设置密钥」），从不回显密钥本身。
//
// 视图生命周期：`shell.js` 切到 `settings` 时派发 `viewchange`，这里刷新一次；
// 页面加载时如果已经停在设置视图则立即拉取。不在设置视图时不做任何轮询 ——
// 设置不是高频数据。
(() => {
  const token = new URLSearchParams(location.search).get('token') ?? ''
  const POLL_TIMEOUT_MS = 8_000
  /** 设备开关/下拉的合并窗口：连续操作只发一次 POST。 */
  const SENSOR_DEBOUNCE_MS = 300

  const el = {
    err: document.getElementById('err'),
    provider: document.getElementById('setProvider'),
    model: document.getElementById('setModel'),
    baseUrl: document.getElementById('setBaseUrl'),
    apiKey: document.getElementById('setApiKey'),
    llmSave: document.getElementById('setLlmSave'),
    llmClearKey: document.getElementById('setLlmClearKey'),
    llmStatus: document.getElementById('setLlmStatus'),
    llmWarning: document.getElementById('setLlmWarning'),
    camEnabled: document.getElementById('setCamEnabled'),
    camDevice: document.getElementById('setCamDevice'),
    camRefresh: document.getElementById('setCamRefresh'),
    camStatus: document.getElementById('setCamStatus'),
    micEnabled: document.getElementById('setMicEnabled'),
    micDevice: document.getElementById('setMicDevice'),
    micRefresh: document.getElementById('setMicRefresh'),
    micStatus: document.getElementById('setMicStatus'),
  }

  // 设置页 markup 由 shell 重写负责；缺 id 时安静退出，不影响其他视图。
  if (el.provider === null || el.camEnabled === null || el.micEnabled === null) return

  /** Last `GET /api/settings` body; `null` until the first successful load. */
  let current = null
  /** In-flight checkbox/select change per sensor, so posts stay ordered. */
  let sensorChain = Promise.resolve()
  let sensorTimer
  let pendingSensor = null
  let errorTimer
  let llmBusy = false
  /** True while the model form holds edits that a background refresh must not wipe. */
  let llmDirty = false

  // ── 基础工具 ────────────────────────────────────────────────────────────
  function showError(message) {
    if (el.err === null) return
    el.err.textContent = message
    el.err.classList.add('on')
    if (errorTimer !== undefined) clearTimeout(errorTimer)
    errorTimer = setTimeout(() => {
      if (el.err.textContent === message) {
        el.err.textContent = ''
        el.err.classList.remove('on')
      }
    }, 8_000)
  }

  function describe(error) {
    if (error === null || error === undefined) return '未知错误'
    if (error.status === 401) return 'token 无效或已更换：请从启动窗口重新打开本页'
    if (typeof error.message === 'string' && error.message !== '') return error.message
    return String(error)
  }

  /** One API call; same token/timeout conventions as play.js. */
  async function api(path, options = {}) {
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : POLL_TIMEOUT_MS
    const { timeoutMs: _ignored, ...init } = options
    const response = await fetch(path, {
      ...init,
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
        if (body && typeof body.error === 'string' && body.error !== '') message = body.error
      } catch {
        // 非 JSON 错误体：保留 HTTP 状态即可
      }
      const error = new Error(message)
      error.status = response.status
      throw error
    }
    return response.json()
  }

  // ── 文案 ────────────────────────────────────────────────────────────────
  const CAPTURE_TEXT = {
    running: '运行中',
    stopped: '已停止',
    unavailable: '不可用',
    error: '采集失败',
  }

  const KEY_SOURCE_TEXT = {
    env: '环境变量',
    file: '设置文件',
  }

  // ── 渲染 ────────────────────────────────────────────────────────────────
  function llmStatusText(payload, note) {
    if (note !== undefined) return note
    if (payload.hasApiKey) return (KEY_SOURCE_TEXT[payload.apiKeySource] ?? '已保存')
    return '未设置密钥'
  }

  function renderLlm(payload) {
    el.provider.value = payload.provider
    el.model.value = payload.model
    el.baseUrl.value = payload.baseUrl ?? ''
    // 密钥永不回填；占位符只表达“已有密钥”。
    el.apiKey.value = ''
    el.apiKey.placeholder = payload.hasApiKey ? '已设置，填新值可替换' : 'sk-…'
    el.llmStatus.textContent = llmStatusText(payload)
    // `hidden` alone loses to `.btn { display: inline-flex }`, so set display too.
    if (el.llmClearKey !== null) {
      el.llmClearKey.hidden = payload.hasApiKey !== true
      el.llmClearKey.style.display = payload.hasApiKey === true ? '' : 'none'
    }
    llmDirty = false
  }

  /** 宿主降级/拆分模式的提示；没有就隐藏这一行。 */
  function renderWarning(warning) {
    if (el.llmWarning === null) return
    el.llmWarning.textContent = typeof warning === 'string' ? warning : ''
    el.llmWarning.hidden = typeof warning !== 'string' || warning === ''
  }

  /** Set one status line; `note` overrides the derived text (saving/error). */
  function renderSensorStatus(node, state, note) {
    if (state.supported !== true) {
      node.textContent = '不可用'
      return
    }
    const text = CAPTURE_TEXT[state.status] ?? state.status
    node.textContent = note !== undefined ? note : (state.error !== undefined ? `${text}：${state.error}` : text)
  }

  /** Fill one device select, keeping the configured id when it is still present. */
  function renderDevices(select, state) {
    const option = (deviceId, label) => {
      const node = document.createElement('option')
      node.value = deviceId
      node.textContent = label
      return node
    }
    // No capture host (headless): nothing to choose, and the status says 不可用.
    if (state.supported !== true) {
      select.replaceChildren(option('', '—'))
      select.value = ''
      return
    }
    const devices = Array.isArray(state.devices) ? state.devices : []
    const options = [option('', '默认设备')]
    for (const device of devices) {
      options.push(option(device.deviceId, device.label || device.deviceId))
    }
    select.replaceChildren(...options)
    const configured = state.deviceId ?? ''
    select.value = devices.some(device => device.deviceId === configured) ? configured : ''
  }

  function renderSensors(payload) {
    const camera = payload.sensors.camera
    const microphone = payload.sensors.microphone
    el.camEnabled.checked = camera.enabled === true
    el.micEnabled.checked = microphone.enabled === true
    el.camEnabled.disabled = camera.supported !== true
    el.micEnabled.disabled = microphone.supported !== true
    el.camDevice.disabled = camera.supported !== true
    el.micDevice.disabled = microphone.supported !== true
    el.camRefresh.disabled = camera.supported !== true
    el.micRefresh.disabled = microphone.supported !== true
    renderDevices(el.camDevice, camera)
    renderDevices(el.micDevice, microphone)
    renderSensorStatus(el.camStatus, camera)
    renderSensorStatus(el.micStatus, microphone)
  }

  function render(payload, options = {}) {
    if (payload === null || typeof payload !== 'object' || payload.llm === undefined) return
    current = payload
    // 后台刷新（刷新按钮 / 切回视图）不得覆盖尚未保存的模型输入。
    if (options.forceLlm === true || !llmDirty) renderLlm(payload.llm)
    renderWarning(payload.llm.warning)
    renderSensors(payload)
  }

  // ── 读取与保存 ──────────────────────────────────────────────────────────
  async function refresh() {
    try {
      render(await api('/api/settings'))
    } catch (error) {
      showError(`设置读取失败：${describe(error)}`)
    }
  }

  /**
   * Re-read device lists without touching the model form.
   *
   * The camera/mic Refresh buttons must not wipe provider/model/baseUrl edits
   * the human has typed but not saved yet.
   */
  async function refreshSensors() {
    try {
      const payload = await api('/api/settings')
      current = payload
      renderWarning(payload.llm.warning)
      renderSensors(payload)
    } catch (error) {
      showError(`设备读取失败：${describe(error)}`)
    }
  }

  async function saveLlm() {
    if (llmBusy) return
    llmBusy = true
    el.llmSave.disabled = true
    el.llmStatus.textContent = '保存中…'
    try {
      const body = {
        provider: el.provider.value,
        model: el.model.value,
        baseUrl: el.baseUrl.value === '' ? null : el.baseUrl.value,
        // 空 = 保留已存密钥（页面从不读取/回显密钥）。
        ...(el.apiKey.value.trim() === '' ? {} : { apiKey: el.apiKey.value.trim() }),
      }
      const payload = await api('/api/settings/llm', { method: 'POST', body: JSON.stringify(body) })
      llmDirty = false
      render(payload, { forceLlm: true })
      el.llmStatus.textContent = '已保存'
    } catch (error) {
      // 失败时保留输入，方便人工修正；状态行给出宿主的原因。
      el.llmStatus.textContent = '保存失败'
      showError(`模型设置保存失败：${describe(error)}`)
    } finally {
      el.apiKey.value = ''
      llmBusy = false
      el.llmSave.disabled = false
    }
  }

  /** Clear the stored file key (the API treats an empty string as "delete"). */
  async function clearKey() {
    if (llmBusy) return
    llmBusy = true
    el.llmSave.disabled = true
    if (el.llmClearKey !== null) el.llmClearKey.disabled = true
    try {
      const payload = await api('/api/settings/llm', {
        method: 'POST',
        body: JSON.stringify({ apiKey: '' }),
      })
      render(payload, { forceLlm: true })
      el.llmStatus.textContent = '密钥已清除'
    } catch (error) {
      showError(`清除密钥失败：${describe(error)}`)
    } finally {
      llmBusy = false
      el.llmSave.disabled = false
      if (el.llmClearKey !== null) el.llmClearKey.disabled = false
    }
  }

  /** Queue one sensor patch; consecutive changes collapse into one POST. */
  function queueSensor(sensor, patch) {
    if (pendingSensor === null) pendingSensor = {}
    pendingSensor[sensor] = { ...(pendingSensor[sensor] ?? {}), ...patch }
    if (sensorTimer !== undefined) clearTimeout(sensorTimer)
    sensorTimer = setTimeout(() => { void flushSensors() }, SENSOR_DEBOUNCE_MS)
  }

  async function flushSensors() {
    if (sensorTimer !== undefined) clearTimeout(sensorTimer)
    sensorTimer = undefined
    const patch = pendingSensor
    pendingSensor = null
    if (patch === null) return
    // Serialise posts: two quick toggles must not land out of order.
    sensorChain = sensorChain.then(async () => {
      try {
        const payload = await api('/api/settings/sensors', { method: 'POST', body: JSON.stringify(patch) })
        render(payload)
      } catch (error) {
        showError(`设备设置保存失败：${describe(error)}`)
        // 失败时回到宿主真实状态，避免界面停在一个没有生效的值上。
        await refresh()
      }
    })
  }

  /** Camera/mic widgets → one patch for the sensor the human just touched. */
  function deviceSelection(select) {
    return select.value === '' ? null : select.value
  }

  el.camEnabled.addEventListener('change', () => {
    queueSensor('camera', { enabled: el.camEnabled.checked })
  })
  el.micEnabled.addEventListener('change', () => {
    queueSensor('microphone', { enabled: el.micEnabled.checked })
  })
  el.camDevice.addEventListener('change', () => {
    queueSensor('camera', { deviceId: deviceSelection(el.camDevice) })
  })
  el.micDevice.addEventListener('change', () => {
    queueSensor('microphone', { deviceId: deviceSelection(el.micDevice) })
  })
  el.camRefresh.addEventListener('click', () => { void refreshSensors() })
  el.micRefresh.addEventListener('click', () => { void refreshSensors() })
  el.llmSave.addEventListener('click', () => { void saveLlm() })
  if (el.llmClearKey !== null) el.llmClearKey.addEventListener('click', () => { void clearKey() })

  // Unsaved model edits survive a background refresh (Refresh buttons/viewchange).
  for (const input of [el.provider, el.model, el.baseUrl, el.apiKey]) {
    input.addEventListener('input', () => { llmDirty = true })
  }

  // 回车提交模型配置（表单里唯一的多行输入是隐藏的，其余都是单行）。
  for (const input of [el.provider, el.model, el.baseUrl, el.apiKey]) {
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      void saveLlm()
    })
  }

  function startIfVisible() {
    if (document.body.dataset.view === 'settings') void refresh()
  }

  window.addEventListener('viewchange', event => {
    if (event.detail?.view === 'settings') {
      void refresh()
      return
    }
    // 离开设置页时把还在 debounce 里的开关/下拉立刻落盘，避免切走后丢失。
    if (pendingSensor !== null) void flushSensors()
  })

  // A page that is being closed/unloaded cannot wait for the debounce timer.
  window.addEventListener('pagehide', () => {
    if (pendingSensor !== null) void flushSensors()
  })
  startIfVisible()
})()
