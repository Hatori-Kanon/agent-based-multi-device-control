// 游玩页前端（B2-T12）。纯静态、无框架、无外链资源：只通过 dashboard 的
// JSON API 说话（`M2-实施计划.md` §4.12）。与控制台共享同一套 token 约定：
// token 从地址栏读一次，之后只出现在 `x-control-token` 请求头里 —— 不落
// 本地存储、不写 DOM 文本、不进日志。
//
// 可见性规则（`导演与写作上下文契约.md`）：本页只渲染玩家能看见的内容 ——
// 台词、选项、阶段、时间。设备强度/上限等数值一律不进 DOM；感知源只显示
// 「可用/质量」；probe 数值与解析目标只在调试开关打开后才请求与显示。
// 开关复用宿主 `/api/debug`，默认关闭；关闭时连请求都不发。
//
// 轮询 2Hz：会话与台词每 500ms，设备/部位每 2s，感知每 3s。所有失败都在
// 页面上显示可读错误，不往 console 裸奔。

(() => {
  const token = new URLSearchParams(location.search).get('token') ?? ''
  const POLL_MS = 500
  const HOLD_MS = 1000

  const el = {
    conn: document.getElementById('conn'),
    panic: document.getElementById('panic'),
    debugToggle: document.getElementById('debugToggle'),
    lockBanner: document.getElementById('lockBanner'),
    unlock: document.getElementById('unlock'),
    err: document.getElementById('err'),
    packSelect: document.getElementById('packSelect'),
    plannedMinutes: document.getElementById('plannedMinutes'),
    ceiling: document.getElementById('ceiling'),
    ceilingVal: document.getElementById('ceilingVal'),
    start: document.getElementById('start'),
    pause: document.getElementById('pause'),
    resume: document.getElementById('resume'),
    end: document.getElementById('end'),
    startHint: document.getElementById('startHint'),
    lobby: document.getElementById('lobby'),
    sessionView: document.getElementById('sessionView'),
    sessionState: document.getElementById('sessionState'),
    nowCard: document.getElementById('nowCard'),
    nowEyebrow: document.getElementById('nowEyebrow'),
    phaseChip: document.getElementById('phaseChip'),
    currentLine: document.getElementById('currentLine'),
    turnInfo: document.getElementById('turnInfo'),
    stageTimer: document.getElementById('stageTimer'),
    lines: document.getElementById('lines'),
    choicesPanel: document.getElementById('choicesPanel'),
    choices: document.getElementById('choices'),
    composer: document.getElementById('composer'),
    message: document.getElementById('message'),
    send: document.getElementById('send'),
    status: document.getElementById('status'),
    devices: document.getElementById('devices'),
    sensors: document.getElementById('sensors'),
    debugPanel: document.getElementById('debugPanel'),
    debugProbes: document.getElementById('debugProbes'),
    holdOverlay: document.getElementById('holdOverlay'),
    holdFill: document.getElementById('holdFill'),
  }

  /** Last `GET /api/session` body; `null` means "no session is open". */
  let session = null
  let sessionId = ''
  /** Last `GET /api/snapshot` body (devices + the locked latch). */
  let snapshot = null
  /** Region labels keyed `device:channel` (`GET /api/region`). */
  let regions = {}
  /** Newest settled assistant turn already appended to the feed. */
  let lastTurnId = 0
  /** Newest `at` already seen; sent back as `?since=` (forward compatible). */
  let lastAt = 0
  /**
   * 最新一条旁白台词。
   *
   * 它已经显示在「现在」卡里，所以先不进对话流；等下一句（或玩家发言）到来
   * 时才落进历史，避免同一句台词在屏幕上出现两次——这也是视觉小说的常见
   * 处理：现在窗口是焦点，对话流是已经过去的台词。
   */
  let pendingLine = ''
  // 渲染签名：只有内容变了才重建 DOM（也避免轮询把输入框从光标下拿走）。
  // 初值用哨兵而不是空串，否则“列表清空”与“从未加载”无法区分。
  let choiceSignature = '\u0000init'
  let deviceSignature = ''
  let packSignature = '\u0000init'
  let debugEnabled = false
  /** A player action (start/message/choice/control) is in flight. */
  let busy = false
  let polling = false
  let ticks = 0
  let errorTimer
  /** Last message shown per error channel, so a failing poll is not spammy. */
  const lastErrors = new Map()

  // ── 文案 ────────────────────────────────────────────────────────────────
  const STATE_TEXT = {
    idle: '进行中',
    planning: '构思中…',
    executing: '执行中…',
    writing: '写作中…',
    settling: '收束中…',
    paused: '已暂停',
    locked: '已锁定',
    ending: '收尾中…',
    ended: '已结束',
  }
  const PHASE_TEXT = {
    scene: '自由发挥',
    opening: '开场',
    probe: '试探',
    build: '推进',
    peak: '高峰',
    resolve: '收束',
    aftercare: '照料',
  }
  /** Availability/quality wording only; no measured value ever appears here. */
  const QUALITY_TEXT = {
    ok: '可用',
    dim: '偏暗',
    bright: '过亮',
    blocked: '被遮挡',
    stale: '过旧',
    unavailable: '不可用',
  }
  const QUALITY_CLASS = {
    ok: 'q-ok',
    dim: 'q-warn',
    bright: 'q-warn',
    blocked: 'q-bad',
    stale: 'q-warn',
    unavailable: 'q-bad',
  }
  const LIFECYCLE_TEXT = {
    ready: '已连接',
    connecting: '连接中',
    disconnected: '未连接',
    failed: '未连接',
    idle: '待连接',
  }

  function stateText(state) {
    return STATE_TEXT[state] ?? String(state ?? '—')
  }

  function phaseText(phase) {
    if (typeof phase !== 'string' || phase === '') return '—'
    return PHASE_TEXT[phase] ?? phase
  }

  // ── 基础工具 ────────────────────────────────────────────────────────────
  function hintNode(text) {
    const node = document.createElement('div')
    node.className = 'hint'
    node.textContent = text
    return node
  }

  function showError(message) {
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

  /** Show one message per error channel; identical repeats are dropped. */
  function noteError(channel, message) {
    if (lastErrors.get(channel) === message) return
    lastErrors.set(channel, message)
    showError(message)
  }

  function clearError(channel) {
    lastErrors.delete(channel)
  }

  const ERROR_TEXT = {
    LOCKED: '输出已锁定：先点「解锁」再继续',
    NO_SESSION: '尚未开局',
    SESSION_OPEN: '本进程已有一局（一次只跑一局）；要重开请重启宿主',
    SESSION_ENDING: '本局正在收尾，请稍候',
    SESSION_ENDED: '本局已结束',
    INVALID_INPUT: '输入不被接受',
  }

  function describe(error) {
    if (error === null || error === undefined) return '未知错误'
    if (error.status === 401) return 'token 无效或已更换：请从启动日志重新打开本页'
    if (error.status === 403) return `被拒绝：${error.message ?? '权限不足'}`
    if (typeof error.code === 'string' && ERROR_TEXT[error.code] !== undefined) {
      return `${ERROR_TEXT[error.code]}（${error.message ?? error.code}）`
    }
    return error.message ?? String(error)
  }

  /**
   * One API call.
   *
   * Every request carries a timeout: without one a single hung fetch would stop
   * the whole 500ms poll loop (`polling` never clears) and the page would look
   * frozen with no error. Turn calls get a longer budget than polls because the
   * engine itself allows 60s for one model call.
   */
  async function api(path, options = {}) {
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 8000
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
      let code
      try {
        const body = await response.json()
        if (body && typeof body.error === 'string' && body.error !== '') message = body.error
        if (body && typeof body.code === 'string') code = body.code
      } catch {
        // 非 JSON 错误体：保留 HTTP 状态即可
      }
      const error = new Error(message)
      error.status = response.status
      if (code !== undefined) error.code = code
      throw error
    }
    return response.json()
  }

  // ── 会话状态 ────────────────────────────────────────────────────────────
  function lockedNow() {
    return (snapshot !== null && snapshot.locked === true)
      || (session !== null && session.state === 'locked')
  }

  function setConnected(ok) {
    el.conn.classList.toggle('on', ok)
    el.conn.classList.toggle('bad', !ok)
    el.conn.textContent = ok ? '已连接' : '连接失败，重试中…'
  }

  function applySession(next) {
    if (next === null || typeof next !== 'object') return
    const nextId = typeof next.sessionId === 'string' ? next.sessionId : ''
    const switched = session !== null && sessionId !== '' && nextId !== sessionId
    if (switched) resetStream()
    // 一次很慢的发言响应可能比新一次轮询更旧；不要让旧快照把选项/阶段拨回去。
    // 但换了一局（sessionId 不同）时必须无条件采纳新快照——turnId 在新会话里
    // 从 1 重新数，用旧的守卫会把页面卡在上一局的回合上。
    if (!switched && session !== null && typeof next.turnId === 'number'
      && typeof session.turnId === 'number' && next.turnId < session.turnId) return
    sessionId = nextId
    session = next
    renderSession()
  }

  function applyNoSession() {
    if (session !== null) {
      session = null
      sessionId = ''
      resetStream()
    }
    renderSession()
  }

  function renderSession() {
    const current = session
    const inSession = current !== null
    const ended = inSession && current.state === 'ended'
    el.lobby.style.display = inSession ? 'none' : ''
    el.sessionView.style.display = inSession ? '' : 'none'

    // 结束态是一个安静的收尾卡，而不是留着金色大字框继续倒计时。
    if (ended) {
      flushPendingLine()
    }
    const lastLine = inSession && typeof current.lastLine === 'string' ? current.lastLine : ''
    const pendingShown = !ended && lastLine === '' ? pendingLine : ''
    const line = ended
      ? '本局已结束。台词与选择已经留在下面的对话流里；要再开一局需要重启宿主。'
      : (lastLine !== '' ? lastLine : (pendingShown !== '' ? pendingShown : (inSession ? '（本回合还没有台词）' : '（尚未开局）')))
    // 只在内容真的变化时写 DOM：这个节点是 aria-live，重复赋值会让读屏器反复播报同一句。
    if (el.currentLine.textContent !== line) el.currentLine.textContent = line
    el.currentLine.classList.toggle('placeholder', ended
      || (!inSession || (lastLine === '' && pendingShown === '')))
    el.nowCard.classList.toggle('is-ended', ended)
    if (el.nowEyebrow !== null) el.nowEyebrow.textContent = ended ? '已结束' : '现在'

    el.phaseChip.textContent = ended ? '已结束' : (inSession ? phaseText(current.phase) : '未开局')
    el.turnInfo.textContent = inSession ? `第 ${current.turnId ?? 0} 回合` : '未开局'
    el.stageTimer.textContent = inSession && !ended ? timerText(current) : '—'

    el.status.replaceChildren(...statusNodes(current))
    renderChoices(current === null ? undefined : current.choices)
    renderLock()
    renderControls()
    renderStartHint()
  }

  /** 时间只进舞台头和状态卡；台词区不重复显示。 */
  function timerText(current) {
    if (typeof current.remainingMin === 'number') {
      return `已过 ${current.elapsedMin ?? 0} 分 · 剩余 ${current.remainingMin} 分`
    }
    return `已过 ${current.elapsedMin ?? 0} 分`
  }

  /** 顶栏的会话状态药丸：未开局 / 进行中 / 已暂停 / 已锁定 / 已结束。 */
  function renderSessionPill() {
    let text = '未开局'
    let kind = 'off'
    if (session !== null) {
      if (lockedNow()) {
        text = '已锁定'
        kind = 'bad'
      } else if (session.state === 'paused') {
        text = '已暂停'
        kind = 'warn'
      } else if (session.state === 'ending') {
        text = '收尾中'
        kind = 'warn'
      } else if (session.state === 'ended') {
        text = '已结束'
        kind = 'off'
      } else {
        text = '进行中'
        kind = 'info'
      }
    }
    if (el.sessionState.getAttribute('class') !== `pill ${kind}`) {
      el.sessionState.className = `pill ${kind}`
    }
    // 这个药丸是 aria-live：每 500ms 无条件重写同一段文字会让读屏器反复播报。
    if (el.sessionState.textContent !== text) el.sessionState.textContent = text
  }

  /** One readable line under the start bar: why "开始" is (not) available. */
  function renderStartHint() {
    if (session === null) {
      el.startHint.textContent = el.packSelect.value === ''
        ? '没有可用的内容包：请先在控制台导入并激活一个包。'
        : '点「开局」后会以已激活版本的内容包开一局；会话上限只在开局时写入。'
      return
    }
    el.startHint.textContent = session.state === 'ended'
      ? '本局已结束：一次只能跑一局，重开需要重启宿主。'
      : '本局进行中：一次只能跑一局；「结束」后需重启宿主才能再开。'
  }

  /**
   * 右轨只放「本局」信息：阶段与时间已经在舞台头，重复一遍会把视线拆成两处。
   * 边界是安全信息，必须一直在。
   */
  function statusNodes(current) {
    const pairs = current === null
      ? [['状态', '未开局'], ['内容包', '—'], ['边界', '—']]
      : [
          ['状态', `${stateText(current.state)}${current.mustResolve === true ? '（下一回合收束）' : ''}`],
          ['内容包', typeof current.packId === 'string' && current.packId !== ''
            ? `${current.packId} @ ${current.packVersion ?? '?'}`
            : '—'],
          // D-6: a pack may declare no boundaries; say so instead of leaving
          // the player to assume the pack has none in force.
          ['边界', Array.isArray(current.boundaries) && current.boundaries.length > 0
            ? current.boundaries.join('、')
            : '使用全局边界'],
        ]
    return pairs.flatMap(([label, value]) => {
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.textContent = value
      return [dt, dd]
    })
  }

  function renderLock() {
    el.lockBanner.classList.toggle('on', lockedNow())
    renderSessionPill()
  }

  function canSend() {
    if (busy || session === null) return false
    if (lockedNow()) return false
    return ['idle', 'planning', 'executing', 'writing', 'settling'].includes(session.state)
  }

  function renderControls() {
    const running = session !== null
    const state = running ? session.state : null
    const locked = lockedNow()
    el.start.disabled = busy || running || el.packSelect.value === ''
    el.pause.disabled = busy || !running || locked || state === 'paused' || state === 'ending'
      || state === 'ended' || state === 'locked'
    el.resume.disabled = busy || !running || locked || state !== 'paused'
    el.end.disabled = busy || !running || state === 'ended'
    el.packSelect.disabled = busy || running
    el.plannedMinutes.disabled = busy || running
    // 大厅里这个滑杆是开局设置；进行中它只受锁定影响（布局上大厅会收起）。
    el.ceiling.disabled = busy || (running && locked)
    el.ceilingVal.textContent = `${el.ceiling.value}%`
    paintCeiling()

    const sendable = canSend()
    el.message.disabled = !sendable
    el.send.disabled = !sendable
    for (const button of el.choices.querySelectorAll('button')) button.disabled = !sendable
    el.message.placeholder = sendable
      ? '说点什么…（Enter 发送，Shift+Enter 换行）'
      : notSendableReason(state, running, locked)
  }

  /** range 的轨道进度：style.css 用 --fill 画金色已选比例。 */
  function paintCeiling() {
    el.ceiling.style.setProperty('--fill', `${el.ceiling.value}%`)
  }

  function notSendableReason(state, running, locked) {
    if (!running) return '开局后可以发言…'
    if (locked || state === 'locked') return '输出已锁定：解锁后可以发言…'
    if (state === 'paused') return '已暂停：点「继续」后可以发言…'
    if (state === 'ended') return '本局已结束…'
    if (state === 'ending') return '本局正在收尾…'
    return '请稍候…'
  }

  // ── 对话流 ──────────────────────────────────────────────────────────────
  function nearBottom() {
    return el.lines.scrollHeight - el.lines.scrollTop - el.lines.clientHeight < 80
  }

  function appendLine(role, text) {
    const stick = nearBottom()
    const stale = el.lines.querySelector('.hint')
    if (stale !== null) stale.remove()
    const row = document.createElement('div')
    row.className = role === 'assistant'
      ? 'bubble bubble--narrator'
      : role === 'player'
        ? 'bubble bubble--player'
        : 'bubble bubble--sys'
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = role === 'assistant' ? '旁白' : role === 'player' ? '你' : '系统'
    const body = document.createElement('span')
    body.className = 'text'
    body.textContent = text
    row.append(who, body)
    el.lines.append(row)
    while (el.lines.childElementCount > 300) el.lines.firstElementChild.remove()
    if (stick) el.lines.scrollTop = el.lines.scrollHeight
    return row
  }

  /**
   * 把「现在」卡上那一句推进对话流，并返回被推进的文本（用于请求失败时回滚）。
   *
   * 玩家发言前先 flush，保证顺序是「旁白 → 你的话」；新一句旁白到来时 flush
   * 上一句，于是对话流里永远只缺最新那句。
   */
  function flushPendingLine() {
    if (pendingLine === '') return ''
    const text = pendingLine
    pendingLine = ''
    appendLine('assistant', text)
    return text
  }

  /**
   * 回滚一次乐观回显：删掉玩家气泡，把刚推进历史的旁白还原成 pending，
   * 于是「现在」卡与历史的关系回到请求前的状态。
   */
  function rollbackPlayerEcho(playerRow, flushed, draft) {
    if (playerRow !== null && typeof playerRow.remove === 'function') playerRow.remove()
    if (flushed !== '') {
      const last = el.lines.lastElementChild
      if (last !== null && last.classList.contains('bubble--narrator')) last.remove()
      pendingLine = flushed
    }
    if (typeof draft === 'string') el.message.value = draft
  }

  function resetStream() {
    el.lines.replaceChildren(hintNode('（台词会依次累积在这里）'))
    el.choicesPanel.style.display = 'none'
    el.choices.replaceChildren()
    lastTurnId = 0
    lastAt = 0
    pendingLine = ''
    choiceSignature = '\u0000init'
  }

  // ── 选项 ────────────────────────────────────────────────────────────────
  function renderChoices(values) {
    const list = Array.isArray(values)
      ? values.filter(choice => choice !== null && typeof choice === 'object'
        && typeof choice.id === 'string' && typeof choice.label === 'string').slice(0, 3)
      : []
    const signature = list.map(choice => `${choice.id}\u0000${choice.label}`).join('\u0001')
    if (signature === choiceSignature) return
    choiceSignature = signature
    el.choicesPanel.style.display = list.length > 0 ? '' : 'none'
    el.choices.replaceChildren(...list.map((choice, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'choice'
      button.title = '点选即是一句玩家发言'
      const number = document.createElement('span')
      number.className = 'choice-index'
      number.textContent = String(index + 1)
      const label = document.createElement('span')
      label.className = 'choice-label'
      label.textContent = choice.label
      button.append(number, label)
      button.addEventListener('click', () => { void pickChoice(choice) })
      return button
    }))
  }

  // ── 设备 / 部位 ─────────────────────────────────────────────────────────
  function deviceSignatureOf(snap, regionMap) {
    if (snap === null || !Array.isArray(snap.devices)) return 'none'
    return JSON.stringify({
      locked: snap.locked === true,
      devices: snap.devices.map(device => ({
        id: device.id,
        name: device.name,
        lifecycle: device.lifecycle,
        channels: (Array.isArray(device.channels) ? device.channels : []).map(channel => ({
          id: channel.id,
          label: channel.label,
          region: channel.region ?? regionMap[`${device.id}:${channel.id}`] ?? null,
        })),
      })),
    })
  }

  function renderDevices() {
    const snap = snapshot
    if (snap === null || !Array.isArray(snap.devices) || snap.devices.length === 0) {
      el.devices.replaceChildren(hintNode('未连接设备（可在控制台添加模拟设备）'))
      return
    }
    el.devices.replaceChildren(...snap.devices.map(device => {
      const card = document.createElement('div')
      card.className = 'device-card'
      const head = document.createElement('div')
      head.className = 'device-head'
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = device.name ?? device.id
      const life = document.createElement('span')
      const lifecycle = typeof device.lifecycle === 'string' ? device.lifecycle : ''
      life.className = lifecycle === '' ? 'life' : `life ${lifecycle}`
      life.textContent = LIFECYCLE_TEXT[device.lifecycle] ?? String(device.lifecycle ?? '—')
      head.append(name, life)
      card.append(head)

      const channels = Array.isArray(device.channels) ? device.channels : []
      if (channels.length === 0) {
        card.append(hintNode('无可用通道'))
        return card
      }
      for (const channel of channels) card.append(regionRow(device.id, channel))
      return card
    }))
  }

  function regionRow(deviceId, channel) {
    const row = document.createElement('div')
    row.className = 'region-row'
    const label = document.createElement('label')
    label.className = 'label'
    label.textContent = channel.label ?? channel.id ?? '通道'
    const input = document.createElement('input')
    input.type = 'text'
    input.value = channel.region ?? regions[`${deviceId}:${channel.id}`] ?? ''
    input.placeholder = '部位（空=全身）'
    input.title = '输入部位标签后回车或失焦即写入；清空表示移除标签'
    input.addEventListener('change', () => { void applyRegion(deviceId, channel.id, input) })
    input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Enter') {
        event.preventDefault()
        input.blur()
      }
    })
    label.append(input)
    row.append(label)
    return row
  }

  async function applyRegion(deviceId, channelId, input) {
    const value = input.value.trim()
    try {
      const body = await api('/api/region', {
        method: 'POST',
        body: JSON.stringify({ deviceId, channelId, region: value === '' ? null : value }),
      })
      if (body !== null && typeof body === 'object' && body.regions !== null && typeof body.regions === 'object') {
        regions = body.regions
      }
      input.value = regions[`${deviceId}:${channelId}`] ?? ''
      // 让下一次快照轮询重画（被跳过的这次渲染不算数）。
      deviceSignature = ''
    } catch (error) {
      noteError('region', `修改部位失败：${describe(error)}`)
    }
  }

  // ── 感知 / 调试 ─────────────────────────────────────────────────────────
  function renderSensors(sources) {
    if (!Array.isArray(sources) || sources.length === 0) {
      el.sensors.replaceChildren(hintNode('未注册感知源'))
      return
    }
    el.sensors.replaceChildren(...sources.map(source => {
      const row = document.createElement('div')
      row.className = 'sensor-row'
      const label = document.createElement('span')
      // 源 id/kind 与质量词，仅此而已：默认视图不含任何测量值。
      label.textContent = `${source.label ?? source.id} · ${source.kind ?? '源'}`
      const quality = document.createElement('span')
      quality.className = QUALITY_CLASS[source.quality] ?? 'q-warn'
      quality.textContent = QUALITY_TEXT[source.quality] ?? String(source.quality ?? '未知')
      row.append(label, quality)
      return row
    }))
  }

  function probeLine(probe) {
    const row = document.createElement('div')
    const motion = probe.delta && typeof probe.delta.motion === 'number' ? probe.delta.motion : undefined
    const audio = probe.delta && typeof probe.delta.audioPct === 'number' ? probe.delta.audioPct : undefined
    const delta = motion === undefined && audio === undefined
      ? 'Δ 不可比'
      : `Δ运动 ${motion === undefined ? '—' : motion.toFixed(3)} · Δ音频 ${audio === undefined ? '—' : `${audio.toFixed(1)}%`}`
    const targets = (Array.isArray(probe.targets) ? probe.targets : [])
      .map(target => `${target.deviceId}:${target.channelId}`)
      .join(', ')
    row.textContent = `${probe.probeId} · ${probe.beatId}/${probe.intentId} · ${probe.verdict} · 方向 ${probe.direction} · 幅度 ${probe.magnitude} · ${delta} · 解析 ${targets !== '' ? targets : '无目标'}`
    return row
  }

  async function applyDebug(enabled) {
    debugEnabled = enabled === true
    el.debugToggle.classList.toggle('on', debugEnabled)
    el.debugToggle.setAttribute('aria-pressed', debugEnabled ? 'true' : 'false')
    el.debugToggle.textContent = debugEnabled ? '调试中' : '调试'
    if (!debugEnabled) {
      // 关就是关：面板收掉、节点清空、之后不再请求 probes。
      el.debugPanel.style.display = 'none'
      el.debugProbes.replaceChildren()
      return
    }
    el.debugPanel.style.display = ''
    await refreshProbes()
  }

  async function refreshProbes() {
    if (!debugEnabled) return
    try {
      const probes = await api('/api/debug/probes')
      if (!debugEnabled) return
      clearError('probes')
      const list = Array.isArray(probes) ? probes : []
      if (list.length === 0) {
        el.debugProbes.replaceChildren(hintNode('（暂无已结算的 probe）'))
        return
      }
      el.debugProbes.replaceChildren(...list.slice().reverse().map(probeLine))
    } catch (error) {
      // 403 表示开关在别处被关掉了：跟随它关掉本页面板，而不是报错。
      if (error.status === 403) {
        await applyDebug(false)
        return
      }
      noteError('probes', `读取调试 probe 失败：${describe(error)}`)
    }
  }

  async function syncDebug() {
    try {
      const body = await api('/api/debug')
      await applyDebug(body !== null && typeof body === 'object' && body.enabled === true)
    } catch {
      await applyDebug(false)
    }
  }

  // ── 数据轮询 ────────────────────────────────────────────────────────────
  async function refreshSession() {
    try {
      const body = await api('/api/session')
      clearError('session')
      setConnected(true)
      applySession(body)
    } catch (error) {
      if (error.status === 404) {
        clearError('session')
        setConnected(true)
        applyNoSession()
        return
      }
      setConnected(false)
      noteError('session', `读取会话失败：${describe(error)}`)
    }
  }

  async function refreshTranscript() {
    try {
      const query = lastAt > 0 ? `?since=${lastAt}` : ''
      const body = await api(`/api/session/transcript${query}`)
      clearError('transcript')
      const entries = body !== null && typeof body === 'object' && Array.isArray(body.transcript)
        ? body.transcript
        : []
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue
        if (typeof entry.turnId !== 'number' || typeof entry.text !== 'string' || entry.text === '') continue
        // 路由目前返回整段转写；按 turnId 去重，未来做增量过滤也依然成立。
        if (entry.turnId <= lastTurnId) continue
        // 上一句「现在」台词先落进历史，最新一句留在「现在」卡里。
        flushPendingLine()
        pendingLine = entry.text
        lastTurnId = entry.turnId
        if (typeof entry.at === 'number') lastAt = Math.max(lastAt, entry.at)
      }
    } catch (error) {
      if (error.status === 404) return
      noteError('transcript', `读取出词失败：${describe(error)}`)
    }
  }

  async function refreshSnapshot() {
    try {
      const [snap, regionBody] = await Promise.all([api('/api/snapshot'), api('/api/region')])
      snapshot = snap
      if (regionBody !== null && typeof regionBody === 'object'
        && regionBody.regions !== null && typeof regionBody.regions === 'object') {
        regions = regionBody.regions
      }
      clearError('snapshot')
      const signature = deviceSignatureOf(snapshot, regions)
      if (signature !== deviceSignature) {
        deviceSignature = signature
        // 正在编辑部位时不重画，避免把输入框从光标下拿走。
        if (!el.devices.contains(document.activeElement)) renderDevices()
      }
      renderLock()
      renderControls()
    } catch (error) {
      noteError('snapshot', `读取设备失败：${describe(error)}`)
    }
  }

  async function refreshSensors() {
    try {
      const body = await api('/api/sensors')
      clearError('sensors')
      renderSensors(body !== null && typeof body === 'object' ? body.sources : [])
    } catch (error) {
      noteError('sensors', `读取感知源失败：${describe(error)}`)
    }
  }

  async function refreshPacks() {
    try {
      const body = await api('/api/packs')
      clearError('packs')
      renderPacks(body !== null && typeof body === 'object' && Array.isArray(body.packs) ? body.packs : [])
    } catch (error) {
      noteError('packs', `读取内容包失败：${describe(error)}`)
    }
  }

  function renderPacks(packs) {
    const signature = packs.map(pack => `${pack.id ?? ''}@${pack.activeVersion ?? ''}`).join('|')
    if (signature === packSignature) return
    packSignature = signature
    const previous = el.packSelect.value
    const options = []
    for (const pack of packs) {
      if (pack === null || typeof pack !== 'object' || typeof pack.id !== 'string') continue
      const option = document.createElement('option')
      option.value = pack.id
      option.textContent = typeof pack.activeVersion === 'string' && pack.activeVersion !== ''
        ? `${pack.id} · ${pack.activeVersion}`
        : `${pack.id}（无 active 版本）`
      option.disabled = !(typeof pack.activeVersion === 'string' && pack.activeVersion !== '')
      options.push(option)
    }
    if (options.length === 0) {
      const option = document.createElement('option')
      option.value = ''
      option.textContent = '（没有已安装的内容包）'
      option.disabled = true
      options.push(option)
    }
    el.packSelect.replaceChildren(...options)
    if (packs.some(pack => pack.id === previous
      && typeof pack.activeVersion === 'string' && pack.activeVersion !== '')) {
      el.packSelect.value = previous
    } else if (el.packSelect.selectedIndex < 0) {
      // 没有可选项时也要把占位文字显示出来：selectedIndex=-1 的 <select> 在
      // Chrome 里是空白的，看起来像页面坏了。
      el.packSelect.selectedIndex = 0
    }
    renderControls()
    renderStartHint()
  }

  async function poll() {
    if (polling) return
    polling = true
    try {
      ticks += 1
      await refreshSession()
      await refreshTranscript()
      if (ticks % 4 === 0) await Promise.all([refreshSnapshot(), refreshSensors()])
      if (ticks % 4 === 2) await refreshProbes()
      if (ticks % 60 === 0) await refreshPacks()
    } finally {
      polling = false
    }
  }

  // ── 人类动作 ────────────────────────────────────────────────────────────
  async function startSession() {
    if (busy) return
    const packId = el.packSelect.value
    if (packId === '') {
      showError('没有可用的内容包：请先在控制台导入并激活一个包')
      return
    }
    const plannedMinutes = Number(el.plannedMinutes.value)
    if (!Number.isFinite(plannedMinutes) || plannedMinutes < 1 || plannedMinutes > 240) {
      showError('计划时长请填 1–240 分钟')
      return
    }
    const ceilingPercent = Number(el.ceiling.value)
    busy = true
    el.start.textContent = '开局中…'
    renderControls()
    try {
      const next = await api('/api/session/start', {
        method: 'POST',
        body: JSON.stringify({ packId, plannedMinutes, ceilingPercent }),
        timeoutMs: 90000, // 开局要跑一整回合，别用轮询的 8s 预算
      })
      resetStream()
      applySession(next)
      await refreshTranscript()
    } catch (error) {
      noteError('action', `开局失败：${describe(error)}`)
    } finally {
      busy = false
      el.start.textContent = '开局'
      renderControls()
    }
  }

  async function control(path, label) {
    if (busy || session === null) return
    busy = true
    renderControls()
    try {
      const next = await api(path, { method: 'POST' })
      applySession(next)
    } catch (error) {
      noteError('action', `${label}失败：${describe(error)}`)
    } finally {
      busy = false
      renderControls()
    }
  }

  async function endSession() {
    if (busy || session === null) return
    if (!window.confirm('结束本局？结束后需要重启宿主才能再开一局。')) return
    if (busy) return
    busy = true
    renderControls()
    try {
      const next = await api('/api/session/end', {
        method: 'POST',
        body: JSON.stringify({ reason: 'completed' }),
      })
      applySession(next)
    } catch (error) {
      noteError('action', `结束失败：${describe(error)}`)
    } finally {
      busy = false
      renderControls()
    }
  }

  async function sendMessage(raw) {
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text === '' || !canSend()) return
    busy = true
    renderControls()
    // 请求发出前就 flush 上一句并回显玩家这句，避免与 500ms 转录轮询竞态
    // （详见 pickChoice 里的说明）；失败时用 rollbackPlayerEcho 原样撤回。
    const flushed = flushPendingLine()
    const draft = el.message.value
    const playerRow = appendLine('player', text)
    el.message.value = ''
    try {
      const next = await api('/api/session/message', {
        method: 'POST',
        body: JSON.stringify({ text }),
        timeoutMs: 90000, // 一回合允许一次 60s 模型调用，留余量
      })
      applySession(next)
    } catch (error) {
      rollbackPlayerEcho(playerRow, flushed, draft)
      noteError('action', `发送失败：${describe(error)}`)
    } finally {
      busy = false
      renderControls()
      el.message.focus()
    }
  }

  async function pickChoice(choice) {
    if (!canSend()) return
    busy = true
    renderControls()
    // 请求发出前就把上一句「现在」台词推进历史，并立刻回显玩家这句：
    // 否则 500ms 的转录轮询可能在响应返回前把下一句拿到手，顺序会变成
    // 「下一句旁白 → 玩家」而且那句在历史/现在卡里各出现一次。
    const flushed = flushPendingLine()
    const playerRow = appendLine('player', choice.label)
    try {
      const next = await api('/api/session/choice', {
        method: 'POST',
        body: JSON.stringify({ choiceId: choice.id }),
        timeoutMs: 90000,
      })
      applySession(next)
    } catch (error) {
      rollbackPlayerEcho(playerRow, flushed)
      noteError('action', `选择失败：${describe(error)}`)
    } finally {
      busy = false
      renderControls()
    }
  }

  async function panic() {
    if (token.length < 16) {
      showError('急停需要控制台 token：请从启动日志打开本页')
      return
    }
    el.panic.disabled = true
    try {
      await api('/api/panic', { method: 'POST', body: JSON.stringify({ source: 'play-ui' }) })
      await Promise.all([refreshSession(), refreshSnapshot()])
    } catch (error) {
      showError(`急停失败：${describe(error)}`)
    } finally {
      el.panic.disabled = false
    }
  }

  async function unlock() {
    try {
      await api('/api/unlock', { method: 'POST', body: JSON.stringify({ note: 'unlocked from play page' }) })
      await Promise.all([refreshSession(), refreshSnapshot()])
    } catch (error) {
      showError(`解锁失败：${describe(error)}`)
    }
  }

  async function setCeiling(percent) {
    try {
      await api('/api/session/ceiling', { method: 'POST', body: JSON.stringify({ percent }) })
      clearError('ceiling')
      el.ceilingVal.textContent = `${percent}%`
    } catch (error) {
      noteError('ceiling', `设置会话上限失败：${describe(error)}`)
    }
  }

  // ── 长按空格急停 ────────────────────────────────────────────────────────
  let holdTimer
  let holding = false

  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false
    const tag = target.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
  }

  /** 可交互控件上的空格是「按下按钮」，不能被我方的长按急停抢走。 */
  function isInteractiveTarget(target) {
    if (!(target instanceof Element)) return false
    return target.closest('button, a, [role="button"], summary, input, select, textarea') !== null
  }

  function startHold() {
    if (holding) return
    holding = true
    el.holdOverlay.classList.add('on')
    el.holdOverlay.setAttribute('aria-hidden', 'false')
    // 每次按下都从头播放 hold-fill：先清掉动画，强制回流后再交还给 CSS。
    el.holdFill.style.animation = 'none'
    void el.holdFill.offsetWidth
    el.holdFill.style.animation = ''
    holdTimer = setTimeout(() => {
      holdTimer = undefined
      holding = false
      el.holdOverlay.classList.remove('on')
      el.holdOverlay.setAttribute('aria-hidden', 'true')
      void panic()
    }, HOLD_MS)
  }

  function cancelHold() {
    if (!holding) return
    holding = false
    if (holdTimer !== undefined) {
      clearTimeout(holdTimer)
      holdTimer = undefined
    }
    el.holdOverlay.classList.remove('on')
    el.holdOverlay.setAttribute('aria-hidden', 'true')
  }

  // ── 事件接线 ────────────────────────────────────────────────────────────
  el.panic.addEventListener('click', () => { void panic() })
  el.unlock.addEventListener('click', () => { void unlock() })
  el.start.addEventListener('click', () => { void startSession() })
  el.pause.addEventListener('click', () => { void control('/api/session/pause', '暂停') })
  el.resume.addEventListener('click', () => { void control('/api/session/resume', '继续') })
  el.end.addEventListener('click', () => { void endSession() })

  el.ceiling.addEventListener('input', () => {
    el.ceilingVal.textContent = `${el.ceiling.value}%`
    paintCeiling()
  })
  el.ceiling.addEventListener('change', () => {
    // 大厅里的滑杆是开局设置，开局时随 start 一起写入；进行中才走 ceiling 接口。
    if (session === null) return
    void setCeiling(Number(el.ceiling.value))
  })

  el.composer.addEventListener('submit', event => {
    event.preventDefault()
    void sendMessage(el.message.value)
  })
  el.message.addEventListener('keydown', event => {
    // 中文输入法用 Enter 确认候选词时不要发送半句话。
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      el.composer.requestSubmit()
    }
  })

  el.debugToggle.addEventListener('click', async () => {
    try {
      const body = await api('/api/debug', {
        method: 'POST',
        body: JSON.stringify({ enabled: !debugEnabled }),
      })
      await applyDebug(body !== null && typeof body === 'object' && body.enabled === true)
    } catch (error) {
      showError(`切换调试失败：${describe(error)}`)
    }
  })

  el.devices.addEventListener('focusout', () => {
    // 输入框失焦后再补一次快照，避免“编辑期间跳过的渲染”一直不补。
    setTimeout(() => {
      if (el.devices.contains(document.activeElement)) return
      deviceSignature = ''
      void refreshSnapshot()
    }, 0)
  })

  window.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.repeat) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // 输入框/下拉里的空格是正常打字，不能触发急停；按钮上的空格要放行给按钮本身。
    if (isTypingTarget(event.target) || isInteractiveTarget(event.target)) return
    event.preventDefault()
    startHold()
  })
  window.addEventListener('keyup', event => {
    if (event.code === 'Space') cancelHold()
  })
  window.addEventListener('blur', cancelHold)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelHold()
  })

  // ── 启动 ────────────────────────────────────────────────────────────────
  async function boot() {
    if (token.length < 16) {
      el.conn.textContent = '缺少 token'
      el.conn.classList.remove('on')
      el.conn.classList.add('bad')
      showError('URL 缺少 token 参数：请从启动日志打开游玩页地址（/play?token=…）')
      renderSession()
      return
    }
    await Promise.all([
      refreshPacks(),
      refreshSession(),
      refreshTranscript(),
      refreshSnapshot(),
      refreshSensors(),
      syncDebug(),
    ])
    window.setInterval(() => { void poll() }, POLL_MS)
  }

  void boot()
})()
