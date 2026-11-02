// 游玩视图前端（v3 单窗口）。纯静态、无框架、无外链资源：只通过 dashboard
// 的 JSON API 说话。token 从地址栏读一次，之后只出现在 `x-control-token`
// 请求头里 —— 不落本地存储、不写 DOM 文本、不进日志。
//
// 可见性规则（`导演与写作上下文契约.md`）：本视图只渲染玩家能看见的内容 ——
// 台词、选项、阶段、时间。v5 把「部位」并入「软上限」：大厅的 #softCapsLobby
// 与舞台右轨的 #devices 用同一个渲染器，每台设备一张卡、每个通道一块 ——
// 部位选择 + 强度范围 + 频率范围放在一起（`设备范围与单窗口界面-设计说明.md`
// §3.3）。部位词表按「内容包 + 版本」拉取（GET /api/packs/regions），只显示
// 内容包作者写的 label，提交的是稳定 id；同一个包换版本会重拉，加载失败不
// 缓存成「已加载」，下一次刷新会自动重试。
// 强度按通道的原生单位显示（Coyote 0-200，其它 0-100%），频率显示物理 Hz；
// 单位元数据由宿主快照给出，缺强度元数据时按百分比降级，读不到 Hz 则该行
// 显示「—」并禁用。
//
// 轮询 2Hz：会话与台词每 500ms，设备/部位/软上限每 2s，内容包每 30s；部位
// 词表只随内容包/版本变化单独拉取，不进 500ms 轮询。设备/设置视图打开时
// （document.body.dataset.view !== 'play'）本视图停止轮询；切回时 `viewchange`
// 监听器立即刷新一次。所有失败都在页面上显示可读错误，不往 console 裸奔。

(() => {
  const token = new URLSearchParams(location.search).get('token') ?? ''
  const POLL_MS = 500
  const HOLD_MS = 1000

  const el = {
    conn: document.getElementById('conn'),
    panic: document.getElementById('panic'),
    lockBanner: document.getElementById('lockBanner'),
    unlock: document.getElementById('unlock'),
    err: document.getElementById('err'),
    packSelect: document.getElementById('packSelect'),
    plannedMinutes: document.getElementById('plannedMinutes'),
    start: document.getElementById('start'),
    pause: document.getElementById('pause'),
    resume: document.getElementById('resume'),
    end: document.getElementById('end'),
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
    softCapsLobby: document.getElementById('softCapsLobby'),
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
  /**
   * 当前内容包版本声明的部位词表；`null` = 还没成功加载（picker 只给「未指定」
   * 与通道当前值）。
   */
  let regionVocabulary = null
  /** 已加载词表对应的 `${packId}@${version}`；与设置用的包不同就重新拉。 */
  let vocabularyPackKey = ''
  /** 词表请求进行中的 pack key；`null` = 空闲（避免重复发请求）。 */
  let vocabularyLoading = null
  /** 上次加载失败：置 true 让下一次 boot/refreshAll/viewchange 等自动重试。 */
  let vocabularyRetry = false
  /** 上次失败的时间戳（`Date.now()`）；限制自动重试频率，避免 2Hz 轮询打爆宿主。 */
  let vocabularyRetryAt = 0
  /** 自动重试的最小间隔；`force`（换包/包列表变化）不受此限制。 */
  const VOCABULARY_RETRY_MS = 15_000
  /** 大厅下拉框里每个内容包的 active 版本；`renderPacks` 从 versions/activeVersion 取。 */
  const packVersions = new Map()
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
  let packSignature = '\u0000init'
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
    if (error.status === 401) return 'token 无效或已更换：请从启动窗口重新打开本页'
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
    // 会话的包与版本决定部位词表；与已加载的 key 不同（或还没加载成功）就换。
    if (setupPackKey() !== vocabularyPackKey || regionVocabulary === null) {
      void refreshVocabulary()
    }
  }

  function applyNoSession() {
    if (session !== null) {
      session = null
      sessionId = ''
      resetStream()
    }
    renderSession()
    // 回到大厅：设置用的包变回下拉框的选择，词表不一致就换回来（失败时重试）。
    if (setupPackKey() !== vocabularyPackKey || regionVocabulary === null) void refreshVocabulary()
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
      ? '已结束'
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

  /**
   * 右轨只放「本局」信息：阶段与时间已经在舞台头，重复一遍会把视线拆成两处。
   */
  function statusNodes(current) {
    const pairs = current === null
      ? [['状态', '未开局'], ['内容包', '—']]
      : [
          ['状态', `${stateText(current.state)}${current.mustResolve === true ? '（下一回合收束）' : ''}`],
          ['内容包', typeof current.packId === 'string' && current.packId !== ''
            ? `${current.packId} @ ${current.packVersion ?? '?'}`
            : '—'],
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

    const sendable = canSend()
    el.message.disabled = !sendable
    el.send.disabled = !sendable
    for (const button of el.choices.querySelectorAll('button')) button.disabled = !sendable
    el.message.placeholder = sendable ? '说点什么…' : notSendableReason(state, running, locked)
  }

  function notSendableReason(state, running, locked) {
    if (!running) return '开局后可发言'
    if (locked || state === 'locked') return '输出已锁定'
    if (state === 'paused') return '已暂停'
    if (state === 'ended') return '已结束'
    if (state === 'ending') return '收尾中…'
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
    el.lines.replaceChildren(hintNode('还没有台词'))
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

  // ── 设备 / 部位 / 软上限（同一张卡） ───────────────────────────────────
  // 大厅的 #softCapsLobby 与舞台右轨的 #devices 用同一个渲染器：每台设备一张
  // 卡，卡里按通道分段，每段一行「部位」选择 + 强度范围 + 频率范围。数据来自
  // /api/snapshot；部位词表来自 /api/packs/regions，部位修改走 /api/region，
  // 边界修改走 /api/cap —— 只有人类能改这些（D4 不变）。
  /** 每个挂载点各自的重绘签名；大厅与右轨互不影响。 */
  const setupSignatures = new Map()

  function setupMounts() {
    return [el.softCapsLobby, el.devices].filter(mount => mount !== null)
  }

  /** 部位存储键，与 /api/region 返回的 regions 字段一致。 */
  function regionKey(deviceId, channelId) {
    return `${deviceId}:${channelId}`
  }

  /** 每个通道最近一次部位提交的序号；乱序响应据此丢弃。 */
  const regionRequests = new Map()

  /** 词表里是否有这个部位 id；加载完成前 `regionVocabulary` 为 null。 */
  function vocabularyHas(id) {
    return Array.isArray(regionVocabulary) && regionVocabulary.some(entry => entry.id === id)
  }

  /**
   * 合并卡的渲染签名。
   *
   * 只要设备/通道/部位/边界/词表/锁定有一处变化就重建；两个挂载点各自记住
   * 自己的签名，互不牵连。
   */
  function setupSignatureOf(snap) {
    if (snap === null || !Array.isArray(snap.devices)) return 'none'
    return JSON.stringify({
      locked: snap.locked === true,
      vocabularyPackKey,
      vocabulary: Array.isArray(regionVocabulary)
        ? regionVocabulary.map(entry => [entry.id, entry.label])
        : null,
      devices: snap.devices.map(device => ({
        id: device.id,
        name: device.name,
        lifecycle: device.lifecycle,
        channels: (Array.isArray(device.channels) ? device.channels : []).map(channel => {
          const caps = capsOf(channel)
          return {
            id: channel.id,
            label: channel.label,
            kind: channel.kind,
            supportsWaveform: channel.supportsWaveform === true,
            region: channel.region ?? regions[regionKey(device.id, channel.id)] ?? null,
            minPercent: caps.minPercent,
            maxPercent: caps.maxPercent,
            minFreqHz: caps.minFreqHz,
            maxFreqHz: caps.maxFreqHz,
            intensityUnit: caps.intensityUnit,
            intensityMax: caps.intensityMax,
          }
        }),
      })),
    })
  }

  function renderSetup() {
    const mounts = setupMounts()
    if (mounts.length === 0) return
    const signature = setupSignatureOf(snapshot)
    const active = document.activeElement
    for (const mount of mounts) {
      if (setupSignatures.get(mount) === signature) continue
      // 正在这个容器里编辑（拖滑杆/选部位）时不要重建；失焦或下一轮轮询再补。
      if (active !== null && mount.contains(active)
        && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) continue
      setupSignatures.set(mount, signature)
      mount.replaceChildren(...setupNodes(snapshot))
    }
  }

  function setupNodes(snap) {
    if (snap === null) return [hintNode('正在读取…')]
    const devices = Array.isArray(snap.devices) ? snap.devices : []
    if (devices.length === 0) return [hintNode('还没有设备')]
    const nodes = []
    for (const device of devices) {
      const channels = Array.isArray(device.channels) ? device.channels : []
      // 一台设备一张卡，卡里再按通道分段：重复设备名读起来像列表被复制了两遍。
      if (channels.length > 0) nodes.push(setupCard(device, channels, snap.locked === true))
    }
    if (nodes.length === 0) return [hintNode('还没有通道')]
    return nodes
  }

  function setupCard(device, channels, locked) {
    const card = document.createElement('div')
    card.className = 'soft-cap'
    const head = document.createElement('div')
    head.className = 'soft-cap-head'
    const name = document.createElement('span')
    name.className = 'soft-cap-name'
    name.textContent = device.name ?? device.id ?? '设备'
    const state = document.createElement('span')
    const lifecycle = typeof device.lifecycle === 'string' ? device.lifecycle : ''
    state.className = lifecycle === '' ? 'soft-cap-state' : `soft-cap-state ${lifecycle}`
    state.textContent = LIFECYCLE_TEXT[device.lifecycle] ?? String(device.lifecycle ?? '—')
    head.append(name, state)
    card.append(head)
    for (const channel of channels) card.append(setupChannel(device, channel, locked))
    return card
  }

  /** 一个通道块：部位选择 + 强度范围 +（波形通道）频率范围。 */
  function setupChannel(device, channel, locked) {
    const block = document.createElement('div')
    block.className = 'soft-cap-channel'
    const head = document.createElement('div')
    head.className = 'soft-cap-channel-head'
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = channel.label ?? channel.id ?? '通道'
    head.append(tag)

    const deviceName = device.name ?? device.id ?? '设备'
    const channelName = channel.label ?? channel.id ?? '通道'
    const current = currentRegionOf(device.id, channel)
    const pick = regionPicker(device.id, channel.id, deviceName, channelName, current)
    pick.addEventListener('change', () => { void applyRegion(device, channel, pick, head) })
    head.append(pick)
    if (regionNeedsWarning(current)) head.append(regionWarningNode())
    block.append(head)

    const caps = capsOf(channel)
    const names = { device: deviceName, channel: channelName }
    block.append(softCapRow(device.id, channel.id, 'intensity', caps, locked, names))
    // 频率范围只有波形通道（郊狼）才有意义；其它后端的滑杆不生效，不显示。
    if (channel.supportsWaveform === true) {
      block.append(softCapRow(device.id, channel.id, 'frequency', caps, locked, names))
    }
    return block
  }

  /** 通道当前的部位值；快照值优先，其次是人类设置的 regions 映射。 */
  function currentRegionOf(deviceId, channel) {
    const stored = channel.region ?? regions[regionKey(deviceId, channel.id)]
    return typeof stored === 'string' ? stored : ''
  }

  /** 部位不是词表里的 id（旧包/后端声明的值）时提示，但别把原始 id 露给玩家。 */
  function regionNeedsWarning(value) {
    if (!Array.isArray(regionVocabulary)) return false
    return value !== '' && !vocabularyHas(value)
  }

  function regionWarningNode() {
    const warn = document.createElement('span')
    warn.className = 'region-warn'
    warn.textContent = '内容包未声明'
    return warn
  }

  /** 部位下拉：词表里的 label 给玩家看，提交的是稳定 id。 */
  function regionPicker(deviceId, channelId, deviceName, channelName, current) {
    const pick = document.createElement('select')
    pick.className = 'region-pick'
    pick.setAttribute('aria-label', `${deviceName} ${channelName} 部位`)
    const options = []
    const none = document.createElement('option')
    none.value = ''
    none.textContent = '未指定'
    options.push(none)
    const vocabulary = Array.isArray(regionVocabulary) ? regionVocabulary : []
    for (const entry of vocabulary) {
      const option = document.createElement('option')
      option.value = entry.id
      option.textContent = entry.label
      options.push(option)
    }
    // 存档里可能是旧包/后端声明的部位：给一个不带原始 id 的已选项。
    if (current !== '' && !vocabularyHas(current)) {
      const stale = document.createElement('option')
      stale.value = current
      stale.textContent = '已设置的部位'
      options.push(stale)
    }
    pick.replaceChildren(...options)
    pick.value = current
    // 部位不是安全边界：锁定时仍可编辑（后端接受）。
    return pick
  }

  /** 就地同步部位下拉旁边的「内容包未声明」提示。 */
  function updateRegionWarning(head, value) {
    const existing = head.querySelector('.region-warn')
    if (regionNeedsWarning(value)) {
      if (existing === null) head.append(regionWarningNode())
      return
    }
    if (existing !== null) existing.remove()
  }

  async function applyRegion(device, channel, pick, head) {
    const deviceId = device.id
    const channelId = channel.id
    const key = regionKey(deviceId, channelId)
    // 提交前的值：失败时回滚到它（而不是可能已被旧响应改过的 regions 映射）。
    const before = currentRegionOf(deviceId, channel)
    const wanted = pick.value === '' ? null : pick.value
    // 每个通道一个请求序号：只有最新一次提交的响应有权改 UI/回滚，快速连续
    // 修改时旧响应直接丢弃，避免标签被乱序响应拨回去。
    const seq = (regionRequests.get(key) ?? 0) + 1
    regionRequests.set(key, seq)
    try {
      const body = await api('/api/region', {
        method: 'POST',
        body: JSON.stringify({ deviceId, channelId, region: wanted }),
      })
      if (regionRequests.get(key) !== seq) return
      clearError('region')
      if (body !== null && typeof body === 'object' && body.regions !== null && typeof body.regions === 'object') {
        regions = body.regions
      }
      const applied = regions[key] ?? ''
      // 快照要等下一轮才更新；先把本地这份的 region 改成服务端生效值，避免
      // 「失焦后立刻重画」把刚选的部位画回旧值。
      channel.region = applied === '' ? undefined : applied
      pick.value = applied
      updateRegionWarning(head, applied)
      // 让下一次快照轮询重画（被跳过的这次渲染不算数）。
      setupSignatures.clear()
      if (document.activeElement !== pick) renderSetup()
    } catch (error) {
      if (regionRequests.get(key) !== seq) return
      noteError('region', `修改部位失败：${describe(error)}`)
      pick.value = before
      channel.region = before === '' ? undefined : before
      updateRegionWarning(head, pick.value)
    }
  }

  // ── 软上限（人类持有的通道边界） ────────────────────────────────────────
  // 大厅与舞台右轨各有一个挂载点，内容相同：按 设备 → 通道 列出强度/频率
  // 范围。数据来自 /api/snapshot；修改只由这里的滑杆 change 事件发出，走
  // POST /api/cap（只有人类能改边界，D4 不变）。
  //
  // 单位：强度用通道原生单位（DG-LAB Coyote 是 0-200 的「强度」，步进 2；
  // 其它通道是 0-100%，步进 1），写入时换算回 percent；频率用宿主给出的
  // 物理频率 Hz（1-100），写入时用 Hz 字段。缺强度元数据时沿用旧行为，按
  // 百分比显示；旧宿主只给协议编码时读不到 Hz，频率行降级为「—」并禁用 ——
  // 宁可不显示，也不把协议编码当 Hz 展示。
  const MIN_FREQ_HZ = 1
  const MAX_FREQ_HZ = 100
  /** 百分比的满量程：/api/level 与 /api/cap 的 percent 域。 */
  const PERCENT_MAX = 100

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  /** range 的轨道进度：style.css 用 --fill 画金色已选比例。 */
  function paintRange(input) {
    const min = Number(input.min)
    const max = Number(input.max)
    const value = Number(input.value)
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
    input.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct))}%`)
  }

  /**
   * 通道强度的原生单位。
   *
   * Coyote 的强度是 0-200 的「力度」（intensityUnit='strength'），其它后端
   * 仍是 0-100%。`scale` 是原生值对百分比的倍数（Coyote 2、其它 1），滑杆
   * 的 step 也用它，于是原生值总与整数百分比一一对应。
   * 缺字段时保持旧行为：没有 intensityUnit 按 percent 显示；没有
   * intensityMax 时 strength 兜底 200、percent 固定 100。
   */
  function intensityUnitOf(channel) {
    const unit = channel.intensityUnit === 'strength' ? 'strength' : 'percent'
    const declared = finite(channel.intensityMax)
    const maxNative = unit === 'strength'
      ? (declared !== undefined && declared > 0 ? Math.round(declared) : PERCENT_MAX * 2)
      : PERCENT_MAX
    return { unit, maxNative, scale: maxNative / PERCENT_MAX }
  }

  /**
   * 一个通道的边界字段。
   *
   * 强度：`minPercent/maxPercent`（0-100）是线上的百分比，界面按原生单位
   * 显示；频率：`minFreqHz/maxFreqHz` 是物理频率，不是协议编码。频率字段
   * 缺失时该行不可用，由 UI 显示「—」。
   */
  function capsOf(channel) {
    const minPercent = finite(channel.minPercent)
    const maxPercent = finite(channel.maxPercent)
    const minFreqHz = finite(channel.minFreqHz)
    const maxFreqHz = finite(channel.maxFreqHz)
    const { unit, maxNative, scale } = intensityUnitOf(channel)
    return {
      minPercent,
      maxPercent,
      minFreqHz,
      maxFreqHz,
      intensityUnit: unit,
      intensityMax: maxNative,
      scale,
      intensity: minPercent !== undefined && maxPercent !== undefined && maxPercent > minPercent,
      frequency: minFreqHz !== undefined && maxFreqHz !== undefined
        && minFreqHz >= MIN_FREQ_HZ && maxFreqHz <= MAX_FREQ_HZ && maxFreqHz > minFreqHz,
    }
  }

  function softCapRow(deviceId, channelId, kind, caps, locked, names) {
    const row = document.createElement('div')
    row.className = 'soft-cap-row'
    const label = document.createElement('span')
    label.className = 'soft-cap-label'
    label.textContent = kind === 'intensity' ? '强度' : '频率'
    row.append(label)

    const intensity = kind === 'intensity'
    const available = intensity ? caps.intensity : caps.frequency
    if (!available) {
      // 频率读不到 Hz（旧宿主只给协议编码）或缺 min/max：不猜、不换算，直接显示「—」。
      const readout = document.createElement('span')
      readout.className = 'val'
      readout.textContent = '—'
      row.append(readout)
      return row
    }

    // 原生单位域：强度 [0, intensityMax]（strength 步进 2，percent 步进 1）；
    // 频率 [1, 100] Hz，步进 1。
    const scale = intensity ? caps.scale : 1
    const step = intensity ? scale : 1
    const floor = intensity ? 0 : MIN_FREQ_HZ
    const ceiling = intensity ? caps.intensityMax : MAX_FREQ_HZ
    const loMin = intensity ? caps.minPercent * scale : caps.minFreqHz
    const hiMax = intensity ? caps.maxPercent * scale : caps.maxFreqHz
    const rangeName = `${names?.device ?? deviceId} ${names?.channel ?? channelId} ${intensity ? '强度' : '频率'}`

    const lo = document.createElement('input')
    lo.type = 'range'
    lo.min = String(floor)
    lo.max = String(hiMax - step)
    lo.step = String(step)
    lo.value = String(loMin)
    lo.disabled = locked
    lo.title = intensity ? '强度下限' : '频率下限'
    lo.setAttribute('aria-label', `${rangeName}下限`)
    const hi = document.createElement('input')
    hi.type = 'range'
    hi.min = String(loMin + step)
    hi.max = String(ceiling)
    hi.step = String(step)
    hi.value = String(hiMax)
    hi.disabled = locked
    hi.title = intensity ? '强度上限' : '频率上限'
    hi.setAttribute('aria-label', `${rangeName}上限`)

    const readout = document.createElement('span')
    readout.className = 'val soft-cap-val'

    /** 原生强度 → 线上的 percent（strength 0-200 → 0-100）。 */
    const toPercent = value => Math.round(value / scale)
    const sync = () => {
      // 联动保证 min < max：下限滑杆的右端永远比上限少一个步进，反之亦然。
      lo.max = String(Number(hi.value) - step)
      hi.min = String(Number(lo.value) + step)
      if (Number(lo.value) > Number(lo.max)) lo.value = lo.max
      if (Number(hi.value) < Number(hi.min)) hi.value = hi.min
      paintRange(lo)
      paintRange(hi)
      readout.textContent = intensity
        ? (caps.intensityUnit === 'strength'
            ? `${lo.value}–${hi.value}`
            : `${lo.value}%–${hi.value}%`)
        : `${lo.value}–${hi.value} Hz`
    }
    lo.addEventListener('input', sync)
    hi.addEventListener('input', sync)
    lo.addEventListener('change', () => {
      sync()
      void postCap(deviceId, channelId, intensity
        ? { minPercent: toPercent(Number(lo.value)) }
        : { minFreqHz: Number(lo.value) })
    })
    hi.addEventListener('change', () => {
      sync()
      void postCap(deviceId, channelId, intensity
        ? { maxPercent: toPercent(Number(hi.value)) }
        : { maxFreqHz: Number(hi.value) })
    })

    sync()
    row.append(lo, hi, readout)
    return row
  }

  async function postCap(deviceId, channelId, patch) {
    try {
      const body = await api('/api/cap', {
        method: 'POST',
        body: JSON.stringify({ deviceId, channelId, patch }),
      })
      clearError('cap')
      // 旧宿主可能只返回快照；新宿主同样如此。拿不到就重新拉一次。
      if (body !== null && typeof body === 'object' && Array.isArray(body.devices)) applySnapshot(body)
      else await refreshSnapshot()
    } catch (error) {
      noteError('cap', `修改软上限失败：${describe(error)}`)
      // 失败时把界面拉回服务端的真实值（本地滑杆可能已经先动了）；清掉
      // 签名才能保证即使服务端值没变也会重画。
      setupSignatures.clear()
      await refreshSnapshot()
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

  /** 采纳一份快照：设备/部位/软上限、锁定状态与按钮可用性一起更新。 */
  function applySnapshot(snap) {
    if (snap === null || typeof snap !== 'object') return
    snapshot = snap
    renderSetup()
    renderLock()
    renderControls()
  }

  async function refreshSnapshot() {
    try {
      const [snap, regionBody] = await Promise.all([api('/api/snapshot'), api('/api/region')])
      if (regionBody !== null && typeof regionBody === 'object'
        && regionBody.regions !== null && typeof regionBody.regions === 'object') {
        regions = regionBody.regions
      }
      clearError('snapshot')
      applySnapshot(snap)
    } catch (error) {
      noteError('snapshot', `读取设备失败：${describe(error)}`)
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
    // 词表按 `${packId}@${version}` 缓存，所以先把每个包的 active 版本记下来。
    // `activeVersion` 是注册表给下一次会话用的版本；`versions[].active` 是同一
    // 信息的明细，两者都兼容。
    packVersions.clear()
    for (const pack of packs) {
      if (pack === null || typeof pack !== 'object' || typeof pack.id !== 'string') continue
      let activeVersion = typeof pack.activeVersion === 'string' ? pack.activeVersion : ''
      if (activeVersion === '' && Array.isArray(pack.versions)) {
        const active = pack.versions.find(entry => entry !== null && typeof entry === 'object'
          && entry.active === true && typeof entry.version === 'string' && entry.version !== '')
        if (active !== undefined) activeVersion = active.version
      }
      if (activeVersion !== '') packVersions.set(pack.id, activeVersion)
    }
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
    // 内容包列表/active 版本变了：同一 id 换版本也可能改 `regions`，所以这里
    // 强制重拉词表；列表没变时上面的签名检查会提前返回，不会每 30s 重读包。
    void refreshVocabulary(currentSetupPack(), true)
  }

  // ── 部位词表（随内容包版本变化，不进 500ms 轮询） ───────────────────────
  /**
   * 当前设置用的内容包：有会话时用会话的包与版本（避免会话中途后台激活了
   * 别的版本导致 picker 标签漂移），否则用大厅下拉框的选择。
   */
  function currentSetupPack() {
    if (session !== null && typeof session.packId === 'string' && session.packId !== '') {
      return {
        id: session.packId,
        version: typeof session.packVersion === 'string' ? session.packVersion : '',
      }
    }
    const picked = el.packSelect.value
    const id = typeof picked === 'string' ? picked : ''
    return { id, version: packVersions.get(id) ?? '' }
  }

  /** 词表缓存键：同一包的不同版本也要重拉（包内 regions 可能变）。 */
  function setupPackKey(pack = currentSetupPack()) {
    return `${pack.id}@${pack.version}`
  }

  /**
   * 拉取某个内容包版本声明的部位词表。
   *
   * 缓存键是 `${packId}@${version}`：同一版本已加载成功就跳过（`force` 除外），
   * 同一版本的请求进行中也跳过（防止重复发请求）。404 = 包没装/没有 active
   * 版本，是确定的「没有词表」，缓存空数组且不打扰玩家；500/超时/断网不算
   * 已加载：置 `vocabularyRetry`，让下一次 boot/refreshAll/viewchange/
   * applySession/applyNoSession 的调用重试。失败期间如果同 key 已有一份好
   * 词表就继续用（force 失败不会清掉好数据），否则退回 null（picker 只剩
   * 「未指定」与通道当前值）。
   */
  async function refreshVocabulary(pack = currentSetupPack(), force = false) {
    const wanted = pack !== null && typeof pack === 'object' ? pack : { id: '', version: '' }
    const id = typeof wanted.id === 'string' ? wanted.id : ''
    const version = typeof wanted.version === 'string' ? wanted.version : ''
    const key = `${id}@${version}`
    // applySession/applyNoSession 由 500ms 轮询驱动；失败后不要每 500ms 重试。
    if (!force && vocabularyRetry && Date.now() - vocabularyRetryAt < VOCABULARY_RETRY_MS) return
    if (!force && !vocabularyRetry && regionVocabulary !== null && vocabularyPackKey === key) return
    if (vocabularyLoading !== null && vocabularyLoading === key) return
    vocabularyLoading = key
    let next = []
    let loadedKey = key
    try {
      if (id !== '') {
        const query = version === ''
          ? `?packId=${encodeURIComponent(id)}`
          : `?packId=${encodeURIComponent(id)}&version=${encodeURIComponent(version)}`
        const body = await api(`/api/packs/regions${query}`)
        const payload = body !== null && typeof body === 'object' ? body : {}
        const list = Array.isArray(payload.regions) ? payload.regions : []
        next = list
          .filter(entry => entry !== null && typeof entry === 'object'
            && typeof entry.id === 'string' && entry.id !== '')
          .map(entry => ({
            id: entry.id,
            label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.id,
          }))
        // 响应会带上服务端实际解析到的版本（不传 version 时补 active 版本），
        // 用它做缓存键，避免同一版本被重复请求。
        const resolvedId = typeof payload.packId === 'string' && payload.packId !== ''
          ? payload.packId
          : id
        const resolvedVersion = typeof payload.version === 'string' ? payload.version : version
        loadedKey = `${resolvedId}@${resolvedVersion}`
      }
    } catch (error) {
      // 期间又换了包：这次结果作废（新请求会负责更新）。
      if (vocabularyLoading !== key) return
      vocabularyLoading = null
      if (error.status === 404) {
        clearError('vocabulary')
        vocabularyRetry = false
        vocabularyRetryAt = 0
        regionVocabulary = []
        vocabularyPackKey = key
      } else {
        // 500/超时/断网：不缓存为“已加载”，留待下一次调用重试。
        vocabularyRetry = true
        vocabularyRetryAt = Date.now()
        noteError('vocabulary', `读取部位失败：${describe(error)}`)
        if (vocabularyPackKey !== key || !Array.isArray(regionVocabulary)) {
          regionVocabulary = null
        }
      }
      setupSignatures.clear()
      renderSetup()
      return
    }
    // 期间又换了包：这次结果作废，别把旧包的词表盖上去。
    if (vocabularyLoading !== key) return
    vocabularyLoading = null
    vocabularyRetry = false
    vocabularyRetryAt = 0
    regionVocabulary = next
    vocabularyPackKey = loadedKey
    clearError('vocabulary')
    setupSignatures.clear()
    renderSetup()
  }

  /** 游玩视图是否可见；设备/设置视图打开或标签页隐藏时本视图停止高频轮询。 */
  function playVisible() {
    if (document.hidden) return false
    const view = document.body.dataset.view
    return view === undefined || view === 'play'
  }

  /** 切回游玩视图时立即拉一次全部状态（不等下一个 500ms 窗口）。 */
  async function refreshAll() {
    // A deep link to /device or /settings must not fire the session endpoints
    // (there is no session yet, and the 404s only add console noise). The
    // viewchange handler refreshes the play view as soon as it is opened.
    await Promise.all([
      refreshPacks(),
      refreshVocabulary(),
      ...(playVisible() ? [refreshSession(), refreshTranscript(), refreshSnapshot()] : []),
    ])
  }

  async function poll() {
    if (polling || !playVisible()) return
    polling = true
    try {
      ticks += 1
      await refreshSession()
      if (!playVisible()) return
      await refreshTranscript()
      if (ticks % 4 === 0) await refreshSnapshot()
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
      showError('没有可用的内容包：请先在设备视图导入并激活一个包')
      return
    }
    const plannedMinutes = Number(el.plannedMinutes.value)
    if (!Number.isFinite(plannedMinutes) || plannedMinutes < 1 || plannedMinutes > 240) {
      showError('计划时长请填 1–240 分钟')
      return
    }
    busy = true
    el.start.textContent = '开局中…'
    renderControls()
    try {
      // v3：不再随开局写会话上限；输出边界由每通道的软上限持有。
      const next = await api('/api/session/start', {
        method: 'POST',
        body: JSON.stringify({ packId, plannedMinutes }),
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
    if (!window.confirm('结束本局？')) return
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
      showError('急停需要控制台 token：请从启动窗口打开本页')
      return
    }
    // 设备视图的直控滑杆由 app.js 管理；急停按钮只有这一处绑定，用一个
    // 进程内事件通知它立刻停掉 keepalive（不等下一次 500ms 轮询）。
    window.dispatchEvent(new CustomEvent('embodied:panic'))
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

  el.packSelect.addEventListener('change', () => { void refreshVocabulary() })

  /**
   * 合并卡的焦点处理。
   *
   * 编辑期间 renderSetup 不会重建该挂载点；焦点完全离开两个挂载点后补一次
   * 快照，并清掉签名让下一次渲染落地。
   */
  let setupFocusTimer
  function attachSetupFocusOut(mount) {
    if (mount === null) return
    mount.addEventListener('focusout', () => {
      if (setupFocusTimer !== undefined) clearTimeout(setupFocusTimer)
      setupFocusTimer = setTimeout(() => {
        setupFocusTimer = undefined
        if (setupMounts().some(entry => entry.contains(document.activeElement))) return
        setupSignatures.clear()
        void refreshSnapshot()
      }, 0)
    })
  }
  attachSetupFocusOut(el.softCapsLobby)
  attachSetupFocusOut(el.devices)

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

  // 设备/设置视图打开时本视图停止轮询；切回来立即刷新一次，避免看到旧台词/旧边界。
  window.addEventListener('viewchange', event => {
    const view = event.detail !== undefined && event.detail !== null ? event.detail.view : undefined
    if (view !== 'play') return
    setupSignatures.clear()
    void refreshAll()
  })

  // ── 启动 ────────────────────────────────────────────────────────────────
  async function boot() {
    if (token.length < 16) {
      el.conn.textContent = '缺少 token'
      el.conn.classList.remove('on')
      el.conn.classList.add('bad')
      showError('URL 缺少 token 参数：请从启动窗口打开游玩页地址（/play?token=…）')
      renderSession()
      return
    }
    await Promise.all([
      refreshPacks(),
      refreshSession(),
      refreshTranscript(),
      refreshSnapshot(),
    ])
    // 开局前先拿到当前内容包的部位词表；之后只在换包时重新拉。不阻塞轮询启动。
    void refreshVocabulary()
    window.setInterval(() => { void poll() }, POLL_MS)
  }

  void boot()
})()
