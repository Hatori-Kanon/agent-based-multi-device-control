// 单窗口视图切换（v3）。只做三件事：切 nav、显隐三个 <section>、记住当前
// 视图（sessionStorage + 地址栏），供刷新后回到上次的位置。
//
// 约束（`设备范围与单窗口界面-设计说明.md` §4）：这里只允许使用
// sessionStorage，而且读/写都必须包 try/catch —— 隐私模式或 file:// 下
// 访问存储可能直接抛异常，不能因此让整个应用页起不来。
//
// 地址栏同步：`/play`、`/device`、`/settings` 都是同一页的别名，`show()` 用
// history.replaceState 把路径改成当前视图（保留 ?token=）。这样「深链」与
// 「刷新后回到刚才的视图」同时成立，不会出现路径与存储互相打回对方的循环。
//
// 切视图时派发 `viewchange`（detail.view = 'play' | 'device' | 'settings'）：
// play.js 与 app.js 监听它，离开时停掉自己的高频轮询（各自在 refresh 前检查
// document.body.dataset.view），切回时立即刷新一次。
(() => {
  const STORAGE_KEY = 'embodied.view'
  const VIEWS = ['play', 'device', 'settings']
  const DEFAULT_VIEW = 'play'

  const sections = Array.from(document.querySelectorAll('section[data-view]'))
  const tabs = Array.from(document.querySelectorAll('[data-view-target]'))

  /** 读取 sessionStorage 里记住的视图；任何异常都当作没有记录。 */
  function rememberedView() {
    try {
      const value = sessionStorage.getItem(STORAGE_KEY)
      return VIEWS.includes(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  /** 路径 → 视图（`/device`、`/settings`、`/play` 都是深链入口）。 */
  function pathView() {
    try {
      const path = window.location.pathname.replace(/\/+$/u, '')
      if (path === '/device') return 'device'
      if (path === '/settings') return 'settings'
      if (path === '/play') return 'play'
    } catch {
      // 取不到 pathname 就退回默认
    }
    return undefined
  }

  /**
   * 深链优先于上次视图。
   *
   * `/device`、`/settings` 是用户明确打开的地址，不能被 sessionStorage 里
   * 上一次停留的视图悄悄改写（否则分享/收藏的深链会落到别处）；`/` 这种
   * 没有视图信息的入口才回退到记忆。切换视图时 syncPath 已把地址栏同步成
   * 当前视图，所以「刷新后回到刚才的视图」仍然成立。
   */
  function initialView() {
    return pathView() ?? rememberedView() ?? DEFAULT_VIEW
  }

  /** 记住当前视图；存不进去不影响切换。 */
  function remember(view) {
    try {
      sessionStorage.setItem(STORAGE_KEY, view)
    } catch {
      // 隐私模式 / file://：保持本次会话内的切换即可
    }
  }

  /** 视图 → 地址栏路径（`/play` 是默认视图的规范路径）。 */
  const VIEW_PATHS = { play: '/play', device: '/device', settings: '/settings' }

  /** 地址栏跟随当前视图（保留 search，也就是 token）。 */
  function syncPath(view) {
    try {
      const url = new URL(window.location.href)
      const target = VIEW_PATHS[view] ?? VIEW_PATHS[DEFAULT_VIEW]
      if (url.pathname !== target) {
        url.pathname = target
        window.history.replaceState({}, '', url)
      }
    } catch {
      // file:// 或受限环境：地址栏不同步，但视图仍然正确
    }
  }

  function normalize(view) {
    return VIEWS.includes(view) ? view : DEFAULT_VIEW
  }

  let current = null

  /** 立即把界面切到 view，不改存储、不发事件（由调用方决定）。 */
  function paint(view) {
    document.body.dataset.view = view
    for (const section of sections) {
      if (section.dataset.view === view) section.removeAttribute('hidden')
      else section.setAttribute('hidden', '')
    }
    for (const tab of tabs) {
      const active = tab.dataset.viewTarget === view
      tab.classList.toggle('active', active)
      tab.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
    current = view
  }

  function show(view) {
    const next = normalize(view)
    if (next === current) return
    remember(next)
    paint(next)
    syncPath(next)
    window.dispatchEvent(new CustomEvent('viewchange', { detail: { view: next } }))
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => show(tab.dataset.viewTarget))
  }

  // 初始视图（不派发 viewchange：play.js/app.js 还没接线，它们会读
  // document.body.dataset.view 决定首次启动要不要立刻拉数据）。地址栏只在
  // 它已经是 /play、/device 或 /settings 深链时才跟随，避免把 `/` 改写成 `/play`；
  // 深链本身已经在 pathView() 里赢得初始视图。
  const initial = initialView()
  paint(initial)
  if (pathView() !== undefined) syncPath(initial)

  /**
   * 应用内确认框（替代原生 confirm 弹窗）。
   *
   * 返回 `Promise<boolean>`：点「确定」→ true；点「取消」、按 Esc、
   * 浏览器不支持 `showModal`、或页面里没有对话框元素 → false（安静降级，
   * 不向调用方抛错）。破坏性操作（结束本局 / 移除设备）走这里，脚本里
   * 不再出现原生 confirm。
   */
  window.embodiedConfirm = function embodiedConfirm(message) {
    const dialog = document.getElementById('confirmDialog')
    const text = document.getElementById('confirmText')
    const ok = document.getElementById('confirmOk')
    const cancel = document.getElementById('confirmCancel')
    if (dialog === null || text === null || ok === null || cancel === null) return Promise.resolve(false)
    if (typeof dialog.showModal !== 'function') return Promise.resolve(false)
    if (dialog.open) return Promise.resolve(false)
    text.textContent = String(message)
    dialog.returnValue = ''
    return new Promise(resolve => {
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        ok.onclick = null
        cancel.onclick = null
        dialog.removeEventListener('close', onClose)
        if (dialog.open) dialog.close()
        resolve(value)
      }
      // Esc 走 dialog 的 close 事件，returnValue 不是 'ok' → 按取消处理。
      const onClose = () => finish(dialog.returnValue === 'ok')
      ok.onclick = () => {
        dialog.returnValue = 'ok'
        finish(true)
      }
      cancel.onclick = () => finish(false)
      dialog.addEventListener('close', onClose)
      try {
        dialog.showModal()
        ok.focus()
      } catch {
        // 已在打开状态 / 浏览器拒绝打开：按取消处理，不把异常抛给调用方。
        finish(false)
      }
    })
  }
})()
