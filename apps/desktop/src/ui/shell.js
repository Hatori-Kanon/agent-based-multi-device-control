// 单窗口视图切换（v3）。只做三件事：切 nav、显隐两个 <section>、记住当前
// 视图（sessionStorage + 地址栏），供刷新后回到上次的位置。
//
// 约束（`设备范围与单窗口界面-设计说明.md` §4）：这里只允许使用
// sessionStorage，而且读/写都必须包 try/catch —— 隐私模式或 file:// 下
// 访问存储可能直接抛异常，不能因此让整个应用页起不来。
//
// 地址栏同步：`/play`、`/device` 都是同一页的别名，`show()` 用
// history.replaceState 把路径改成当前视图（保留 ?token=）。这样「深链」与
// 「刷新后回到刚才的视图」同时成立，不会出现路径与存储互相打回对方的循环。
//
// 切视图时派发 `viewchange`（detail.view = 'play' | 'device'）：play.js 与
// app.js 监听它，离开时停掉自己的高频轮询（各自在 refresh 前检查
// document.body.dataset.view），切回时立即刷新一次。
(() => {
  const STORAGE_KEY = 'embodied.view'
  const VIEWS = ['play', 'device']
  const DEFAULT_VIEW = 'play'

  const sections = Array.from(document.querySelectorAll('section[data-view]'))
  const tabs = Array.from(document.querySelectorAll('[data-view-target]'))
  const label = document.getElementById('viewLabel')

  /** 读取 sessionStorage 里记住的视图；任何异常都当作没有记录。 */
  function rememberedView() {
    try {
      const value = sessionStorage.getItem(STORAGE_KEY)
      return VIEWS.includes(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  /** 路径 → 视图（`/device`、`/play` 是深链入口）。 */
  function pathView() {
    try {
      const path = window.location.pathname.replace(/\/+$/u, '')
      if (path === '/device') return 'device'
      if (path === '/play') return 'play'
    } catch {
      // 取不到 pathname 就退回默认
    }
    return undefined
  }

  /**
   * 上次视图优先于深链：两者冲突时以「用户刚刚在用的视图」为准；地址栏随后
   * 会被 syncPath 改写，所以刷新仍然落在同一个视图上。
   */
  function initialView() {
    return rememberedView() ?? pathView() ?? DEFAULT_VIEW
  }

  /** 记住当前视图；存不进去不影响切换。 */
  function remember(view) {
    try {
      sessionStorage.setItem(STORAGE_KEY, view)
    } catch {
      // 隐私模式 / file://：保持本次会话内的切换即可
    }
  }

  /** 地址栏跟随当前视图（保留 search，也就是 token）。 */
  function syncPath(view) {
    try {
      const url = new URL(window.location.href)
      const target = view === 'device' ? '/device' : '/play'
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
    if (label !== null) label.textContent = view === 'device' ? '设备' : '游玩'
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
  // 它已经是 /play 或 /device 深链时才跟随，避免把 `/` 改写成 `/play`。
  const initial = initialView()
  paint(initial)
  if (pathView() !== undefined) syncPath(initial)
})()
