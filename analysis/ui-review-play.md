# 游玩页视觉审查（v2「墨金」）

> 审查范围：`apps/desktop/src/ui/play.html`、`play.js`、`phone.html`（只读，未改任何一行）；对照 `style.css`、`前端界面设计.md` 与 `ai-for-coyote/frontend` 的视觉语言。
> 环境：47833 的进行中会话（token 见 `.ui-shots/preview/urls.txt`）、47825 未开局且无内容包、临时 47841 有内容包大厅（审查后已停止，数据目录已删）。
> 证据：截图都在 `.ui-shots/rv-*.png`；交互/状态部分用 CDP `--eval` 注入 DOM 构造，正文里单独标注。

## 结论

**方向是对的，但还不能直接交付。** 桌面 1280–1600 已经有「墨金」的骨架，最影响观感的三件事是：

1. **无内容包首屏的下拉框是空白的**（不是空态文案，是一个只有箭头的空控件），第一次打开就像坏了。
2. **1600×1000 的「现在」没有成为大字焦点**：台词 18.5px，只比气泡 13.5px 大一点；1160px 宽的卡片里两行字只占 500px，上方/中部还留出约 150px 纯黑空洞；气泡 760px、选项 1163px，三条右边界互不对齐。
3. **390×844 窄屏不是可玩的布局**：选项 3 和输入框在首屏外，向下滚到输入框时顶栏和「紧急停止」已经完全滚出视口（`scrollY 718` 时 panic 在 `y=-662`），违反「急停常驻」的设计原则。

另外有 2 个明显的视觉 bug：现在卡的装饰引号被裁成两个土黄圆点；超长/不可断的选项会把整个选项列撑出舞台、盖住右轨。

## 阻塞级（必须修）

### B1 无内容包时「内容包」下拉显示为空白

- **复现**：无已安装内容包的大厅（47825），1600×1000。下拉框只看到箭头和空框，没有任何选项文字；下面的提示「没有可用的内容包：请先在控制台导入并激活一个包」又是 11.5px 的 faint，很难被注意到。
- **证据**：`packSelect.selectedIndex === -1`，选项文本实际存在（`（没有已安装的内容包）`）。见 `.ui-shots/rv-lobby-1600.png`、`.ui-shots/rv-play-notoken.png`。
- **位置**：`play.js:752-759`。`renderPacks()` 新建了唯一的 option 并 `disabled`，但从未选中它；`replaceChildren` 后 `selectedIndex` 变成 -1。
- **建议改法**：在 `options.length === 0` 分支里 `option.selected = true`，或在 `replaceChildren` 后 `el.packSelect.selectedIndex = 0`。如果希望不可选，再单独给 select 加 `disabled`/`aria-disabled`，但文字必须保留；同时把 `#startHint` 从 `.hint`（11.5px faint）提到 12px `--muted`，让空态原因可读。
- **为什么是阻塞级**：这是「没有内容包」这一最常见的首次打开状态，控件空白会被读成页面坏了。

### B2 1600 下「现在」不是大字焦点，舞台被拉成一条空带

- **现象**（`.ui-shots/rv-play-1600.png`、`rv-play-1440.png`）：
  - `#currentLine` 计算字号 18.5px、行高 1.95；对话气泡 13.5px，选项 13.5px。它只是「稍大」，不是设计文档说的「大字台词 / 现在窗口是焦点」。
  - `.now-card` 1600 下约 1160×116；两行字只占左侧约 500px，右半张卡是空的；没有任何「现在」标签，只有被裁坏的装饰引号（B4）。
  - 内容较少时 `.thread > :first-child { margin-top: auto }` 把气泡压到底部，now-card 和第一颗气泡之间约有 150px 纯黑空洞；整个舞台中部像没加载完。
  - 同一舞台内气泡 `max-width: 760px`、选项/卡片 1163–1160px，右边界不一致；选项是三条通栏长条，右半截全空，像设置列表而不是舞台。
- **位置**：`style.css:1242-1279`（now-card / now-line）、`1297-1300`（thread 底对齐）、`1347-1367`（选项通栏）、`1192-1198`（1fr / 344px）；`play.html:135-137`。
- **建议改法**：
  - `.now-line` 改为 `font-size: clamp(20px, 1.5vw, 25px); line-height: 1.8; max-width: 760-880px`，并在卡片内加一个 11px 金色 eyebrow「现在 / NOW」；让「现在」在字号和标签上都成立。
  - 给舞台加一个 960–1040px 的内容列（now-card、thread、choices、composer 统一 `max-width`，不建议继续 1fr 拉满 1220px），让 now-card 1160 / bubble 760 / choices 1163 的右边界收敛成一条；1600 下两侧留白反而更像舞台。
  - 内容少时不要只用 `margin-top:auto` 造出大洞：可以在气泡区顶部加「上文」分隔线/渐隐遮罩，或者让 `.thread` 在内容不足时顶部对齐并保留一个 24–32px 的舞台顶衬。选项也建议限宽到 760–920px，和气泡同一阅读尺度。
  - 这是本次最主观、但最直接对着「愿意打开来玩 / 舞台感」目标的一条；不改的话，1600 下仍会像一块被拉宽的表单。

### B3 390×844 下主操作不在首屏，急停会随顶栏滚走

- **证据**（`.ui-shots/rv-play-390.png`、`.ui-shots/rv-play-390-scrolled.png`）：
  - 390×844 时 `scrollHeight = 1620`；输入框 `top = 899`，选项 3 在 850 左右，首屏只看到选项 1/2；底部「暂停/继续/结束」在文档末尾（总高 1620），首屏完全看不到。
  - 顶栏在窄屏换成两行、高 108.6px；它不 sticky。滚到输入框（`scrollY 718`）后顶栏 `y=-718`、`panic` 在 `y=-662`，右上角的「紧急停止」完全不可见。底栏也只是文档末尾，不是固定的。
  - 这是设计原则 §1.5「急停按钮常驻」与验收清单「急停始终可见」在窄屏上的直接破例。
- **位置**：`style.css:1783-1818`（`body { overflow: auto }`、`.app { height:auto }`、`.stage { min-height:70vh }`、`.thread { max-height:46vh }`）、`169-180`（topbar）、`308-322`（bottombar）。
- **建议改法**：
  - 最小修法：在 `@media (max-width: 620px)` 里把 `.topbar` 和 `.bottombar` 设为 `position: sticky`（top:0 / bottom:0，带背景和 z-index），让急停和暂停/结束始终可见；`.composer` 设置 `position: sticky; bottom: <bottombar 高度>` 并在其后面留出安全区。
  - 更完整的修法：窄屏把右轨折叠进 `<details>`/抽屉或直接隐藏，`.stage` 用 `height: calc(100dvh - topbar - bottombar)`，`.thread` 内部滚动，选项与 composer 固定在舞台底部；这样选项 3 和输入框不需要把整页拉成 1620px。
  - 顺带把窄屏 topbar 的 `.topbar-actions` 右对齐（现在第二行「调试/紧急停止」靠左，右边空一半），并缩小换行后的 gap，控制高度在 88–96px。

### B4 now-card 的装饰引号被裁成两个土黄圆点

- **现象**：1440/1600 的会话截图里，now-card 右上角一直有两颗土黄色圆点，像灰尘/渲染残影；它其实是 `content: "“"` 的引号。见 `.ui-shots/rv-play-1600.png`、`rv-play-1440.png`、`rv-play-390.png`。
- **位置**：`style.css:1257-1265`：`top: -22px; right: 18px; font: 700 96px/1 var(--serif); color: rgba(247,217,122,0.1)`，而 `.now-card` 又有 `overflow: hidden`，所以只露出 96px 引号的底部两笔。
- **建议改法**：下移并缩小（如 `top: 8px; right: 20px; font-size: 64px; color: rgba(...,0.08)`），或改成与文案一致的「」、或直接删掉；修完在 1600 与 390 各看一眼。这个虽然不是功能问题，但它在每局的主焦点卡上，属于「看起来像坏了」的级别。

## 应该修

### S1 不可断的长选项会撑破选项列、盖住右轨

- **证据**（`.ui-shots/rv-play-1024-tall.png`、`.ui-shots/rv-stress-choices.png`）：
  - 1024×768 注入一条 140+ 个 A 的选项后，`.choices` 的自动列宽被撑大，选项 1 的中文也被带着溢出并被裁在舞台右边界，A 串直接压到右侧「设备与部位」卡片上；页面 `body` 是 `overflow:hidden`，所以没有横向滚动条，只是内容被裁掉/盖住。
  - 1600 下同样的 A 串在按钮右侧溢出到 x≈1490（按钮右边界 1238），只是还没到视口边缘。
- **位置**：`style.css:1347-1351`（`.choices` 单列 grid）、`1353-1367`（`.choice` 未设 `min-width:0`）、`play.html:42`（`.choice-label` 只有 `min-width:0`，没有 `overflow-wrap`）。
- **建议改法**：
  - `.choices { grid-template-columns: minmax(0, 1fr); }`
  - `.choice { min-width: 0; white-space: normal; }`
  - `.choice-label { overflow-wrap: anywhere; }`
  - 如担心一轮 3 个长选项把输入框挤出屏幕，再给 `.choices` 一个 `max-height: 36-40vh; overflow-y: auto;`，或对标签做 2 行 clamp 并用 `title` 提供全文。
- 中文长句本身会正常换行（实测 1024 下 55 字标签会变 2 行），真正致命的是 URL / 连续拉丁字符 / 无空格长串；LLM 生成的选项完全可能带这类内容。

### S2 右轨「设备与部位」还是控制台表单的样子

- **现象**：每台设备、每个通道都渲染一个 120px 的「部位（空=全身）」输入框；卡头却写「只显示连接状态」。三行一模一样的 placeholder 让右轨看起来像设置页，和参考项目用 chip 展示设备属性的语言不一致。见 `.ui-shots/rv-play-1600.png`、`rv-play-1024.png`。
- **位置**：`play.js:529-550`、`play.html:166`、`style.css:1450-1470`。
- **建议改法**：默认把部位渲染成只读 `.tag` chip（`全身` / `腰部`），点击 chip 或一个小铅笔图标再切到输入；或者至少把输入框做成无边框文本、去掉重复 placeholder，并把卡头改成「连接与部位」。这是「舞台感 vs 调试表单」最直接的一处残留。

### S3 次要文字对比度不足（faint 系列）

- **实测对比度**（WCAG，普通小字需要 4.5:1）：
  - `--faint #616b7c` 在 `--panel #151920` 上 **3.27:1**，在 `--panel-2 #1b2029` 上 **3.04:1**，在 `--ink-0` 上 **3.70:1**。
  - 用 faint 的文字包括：`.hint` 11.5px（会话上限解释、开局提示、底部急停说明）、`.bubble .who` 10px（旁白）、`.card-title small` 10.5px（「只显示连接状态」）、`.turn-chip` 11.5px、手机页 `.phone-note` 12px（带外急停说明）。
- **位置**：`style.css:47`（token）、`821-825`（`.hint`）、`1302-1320`（`.bubble .who`）、`1723-1728`（`.phone-note`）；`phone.html:113-116,165-169`。
- **建议改法**：把 `--faint` 提到 `#7f8a9b`/`#818b9c`（在 panel-2 上约 4.75:1），或只把 `.hint`、`.phone-note`、`.bubble .who` 提到 `--muted`；真正的装饰信息（如 `第 N 回合` 的点缀）再保留低对比。安全说明（会话上限、急停、带外通道）不应低于 4.5:1。
- 已通过的对比：`--text`/`--muted`/`--gold`/`--bad`/`--warn` 在 panel/ink 上都 ≥ 5.6:1。

### S4 会话上限滑杆没有可见焦点，点击高度只有 8px

- **证据**：键盘 Tab 到 `#ceiling` 时 `:focus-visible === true`，但计算样式是 `outline: none; box-shadow: none`；截图上完全看不出焦点（`.ui-shots/rv-focus-range.png`，对比 `.ui-shots/rv-focus-tab.png` 里按钮/输入框都有金色焦点）。
- **位置**：`style.css:575-587` 的 `input[type=range] { outline: none; height: 8px }`，而 `525-533` 的 focus 规则没有包含 range。
- **建议改法**：补 `input[type="range"]:focus-visible { box-shadow: 0 0 0 4px rgba(247,217,122,0.22); }`（或金色 outline）；同时把命中高度做成 24px（视觉轨道仍 8px，用背景层画），18px 的滑块在触摸屏上仍然偏小。会话上限是安全相关设置，值得这点成本。

### S5 锁定横幅不是 live region；`#currentLine` 的更新可能被读屏反复播报

- **现象**：
  - `#lockBanner` 是普通 div，没有 `role="alert"`/`aria-live`；视觉上很醒目（`.ui-shots/rv-play-locked.png`），但屏幕阅读器不会因为 `display:none → flex` 而可靠地播报「输出已被锁定」。手机页的同款横幅有 `role="alert"`，两页不一致。
  - `#currentLine` 带 `aria-live="polite"`，但 `renderSession()` 每 500ms 无条件 `textContent = line`；同一句台词被重新赋值时，部分读屏会重复播报。
- **位置**：`play.html:74`（lockBanner）、`136`（currentLine aria-live）；`play.js:255-277`（每次轮询都 renderSession，264 无条件赋值）。
- **建议改法**：给 `#lockBanner` 加 `role="alert"`（或 `aria-live="assertive"`），并保留 `#unlock` 在可聚焦顺序里；`currentLine` 只在 `el.currentLine.textContent !== line` 时更新，同时给 `#sessionState` 加上 `aria-live="polite"`（暂停/锁定是玩家需要知道的状态变化）。`#holdOverlay` 目前只改 `aria-hidden`，也可加 `role="status"` 让「松开空格即取消」被读出。

### S6 阶段/时间在舞台头和右轨状态卡里各出现一次

- **现象**：舞台头有「自由发挥 / 第 6 回合 / 已过 8 分 · 剩余 17 分」，右轨「状态」卡又重复「阶段 / 时间」；顶栏的「进行中」和状态卡的「状态」也重复。1600 下信息量不大，但视线要跑两处。
- **位置**：`play.js:268-270`（stage head）、`326-343`（statusNodes 的 状态/阶段/时间/边界/内容包）；`style.css:1430-1448`。
- **建议改法**：二选一——右轨状态卡只保留「内容包 / 边界」（安全信息），阶段、回合、时间只留在舞台头；或反过来把舞台头的计时去掉。这样右轨会更像「本局状态」而不是第二份舞台信息。

### S7 「已结束」状态在舞台里像一个空白的大卡片

- **说明**：这一状态是 DOM 构造的（`renderSession` 的 `ended` 分支很长，真结束会破坏预览会话）；截图 `.ui-shots/rv-play-ended-empty.png`。
- **现象**：会话结束后 now-card 仍然 1160×116，只显示 14px faint 的「（本局已结束）」；舞台头还保留「自由发挥 / 已过 X 分 · 剩余 Y 分」，输入框禁用但外形不变。玩家看到的是一个大的空金框 + 还在倒计时，结束感很弱。
- **位置**：`play.js:261-270`（无论 ended 都显示同一 now-card 和 phase/timer），`style.css:1242-1279`。
- **建议改法**：当 `state === 'ended'`：now-card 切成结束卡（「本局已结束 / 已过 N 分」+ 一句「重开需要重启宿主」），隐藏 or 把 phase chip / timer 置为「—」，输入区改为明确的结束提示；历史保留。暂停态同理可考虑在舞台上加一层很淡的「已暂停」状态字/遮罩（目前只有顶栏和输入框 placeholder 提示）。

### S8 字号层级过密，右轨和顶栏显得碎

- **现象**：现状至少用了 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 14.5 / 18.5 / 38 十档字号；同一屏里「状态」12.5、「只显示连接状态」10.5、「A 通道」12、「已连接」10.5、「第 6 回合」11.5、hint 11.5，视觉上很多半档差异，缺少参考项目那种「13px 为主、少量 11px/15px」的稳定节奏。
- **位置**：全 `style.css`；重点 `340-350`、`653-674`、`821-825`、`1430-1448`。
- **建议改法**：收敛成 5 档（如 11 说明 / 12 meta / 13 正文 / 15 强调 / 24 now，外加 38 大厅标题），去掉 10.5/11.5/12.5 这类半档；`.card-title` 可以用 11px 金色 + 0.12em，但副标签统一 11px。

### S9 与参考项目对比：明显掉档的元素

参考 `ai-for-coyote/frontend` 的视觉语言是「近黑 + 金 + 细描边 + 小圆角卡片 + 药丸 + 三栏高密度」；我们借对了色板，但以下元素明显弱一档：

- **舞台的“空”**：参考的中栏是持续增长的对话/操作密度，1600 下也不会空；我们的 1160px now-card + 760px 气泡 + 1163px 选项在 1600 下互相不对齐，信息密度低，观感最受损。
- **右轨的「部位」输入框**：参考用 chip/tag 展示设备属性；我们是带 placeholder 的 120px 输入框，像控制台。
- **底栏主控**：参考底栏有一个居中悬浮的 52px 圆形主控 + 两侧工具；我们是三枚 40px 的普通按钮靠左，主操作（暂停）反而比右上角的「紧急停止」弱很多。
- **卡片描边**：参考 `--color-line: rgba(255,255,255,0.14)`；我们的 `--line` 只有 8%，1600 下右轨卡片边界偏软，卡片像是浮在同一个黑面上，缺一点“实体面板”的清晰度。
- **图标与节点头**：参考有 Lucide 图标和更明确的 section 层级；我们纯文字 + 大字距。不是必须，但在高完成度对比里会显得“只有排版，没有细节”。
- **字号节奏**：参考以 13px 为主；我们半档字号太多（见 S8），右轨会显得碎。

## 可以再打磨（可不修）

- **390 顶栏**：换行后第二行「调试 / 紧急停止」靠左、右边空一半；建议 `margin-left:auto` 右对齐，顺便把 108.6px 压到 88–96px（B3 的一部分）。
- **390 的孤儿行**：now 台词「……是想让我看不下去？」在 390 被切成三行，最后一行只剩「去？」；`text-wrap: pretty`（或 `balance`）和 17–18px 的窄屏字号可以改善；大厅副标题同理，最后一行「需要回应。」偏短。
- **大厅步骤 2 的断行**：1600 下「……用的是哪个版 / 本。」把「版本」拆开，1024 下反而正常；`text-wrap: pretty` 或把文案缩成「导入并激活内容包——存档会记住这一局的版本。」。
- **手机页的锁横幅**：「……才能重新输 / 出。」把「输出」拆开；缩短文案即可。`保存` 按钮只有 34px 高，手机页可以加到 40–44px。
- **暂停态**：目前只有顶栏药丸 + 输入框 placeholder + 选项变淡，舞台上没有「已暂停」三个字；可以考虑在舞台头加一个 warn 色 chip 或很淡的遮罩。
- **底栏主控**：如果不动结构，至少把「暂停/继续」做成一对等宽分段按钮并放大到 44px，让它们更像主操作；「结束」与它们分开。
- **长按急停浮层**：目前 260×61 的卡片贴在底部，视觉上比较轻；设计原则要求「显眼」，可以加红色描边、放大到 320×80，并把「松开空格即取消」从 10.5px faint 提到 11.5px muted。
- **卡片描边**：play 页的 rail card 可以从 `--line` 8% 提到 10–12%，或加一条很淡的金色顶边；和参考的 14% 更接近。
- **从游玩页回控制台**：大厅说「请先在控制台导入」，但顶栏没有「控制台」入口；第一次打开的用户只能改地址。可以加一个次要导航（保留现有 id/布局约束）。
- **会话页没有 h1**：大厅有 `h1`，进行中的舞台只有 span/p。可加一个视觉隐藏的 `h1`（或把 now 卡标题升级）改善读屏大纲。
- **对话流顶部裁切**：1024×768 下滚到底部时第一颗气泡被切在 now-card 下方，虽然有 16px mask，仍像被裁掉；可以加 24–32px 顶部渐隐/「上方还有内容」小提示。

## 已验证没问题的部分

- **桌面适配**：1600×1000、1440×900、1280×800、1024×768 下 `document.documentElement.scrollWidth === innerWidth`，无横向滚动；右轨 344/344/344/300px，没有挤扁；1024×768 下输入框底 696.9、底栏顶 706.9，没有互相压住。
- **大厅（有内容包）**：1600/1024/390 下标题、内容包、时长、上限、开局 CTA 层级清楚；有包时 select 选中正确、开局按钮可用；390 下「开局」在首屏内。见 `rv-lobby-pack-1600.png`、`rv-lobby-1024.png`、`rv-lobby-390.png`。
- **状态**：进行中（1600/1440/1280/1024）、暂停（`rv-play-paused.png`，pill warn、选项 disabled、placeholder 正确）、锁定（`rv-play-locked.png`，横幅 + 解锁 + 已锁定 pill）、调试面板打开（`rv-play-debug2.png`，面板在右轨内、空 probe 文案正确）、错误 toast（`rv-play-notoken.png`，role=status、不遮住主操作）、长按急停（`rv-hold.png`，400ms 时进度 ~40%）、选项 0（panic 后）、1（构造）、3（真实）。
- **长台词换行**：now 卡里约 120 字的中文台词与长 URL 都按预期换行，不溢出；见 `rv-stress-long.png`。选项的 CJK 长句也能换行（`rv-choice-wrap-1024.png` 实测 55 字变 2 行），问题只在不可断串（S1）。
- **手机页**：390×844 正常/锁定两态都无横向滚动，内容正好 844 高；1600×900 为 440px 居中列，红钮和状态清晰。见 `rv-phone-390.png`、`rv-phone-1600.png`、`rv-phone-locked-390.png`。
- **键盘**：Tab 顺序为 debug → panic → message → send → 右轨输入；按钮/select/number input 都有 2px 金色 focus-visible（`rv-focus-tab.png`）；唯一例外是 range（S4）。
- **ARIA**：表单控件都有 label、`#message` 有 `aria-label`、`#err` 有 `role=status`、手机状态有 `aria-live`、`lang="zh"`、`prefers-reduced-motion` 有降级；缺的是 lock banner 的 role（S5）。
- **未误报的硬约束**：游玩页不显示设备数值/探针数值、`#debugPanel` 默认隐藏——这两点没有当作问题。

### 实际看过的截图

- 大厅：`rv-lobby-1600.png`（无包，空白 select）、`rv-lobby-pack-1600.png`（有包）、`rv-lobby-1024.png`、`rv-lobby-390.png`
- 进行中：`rv-play-1600.png`、`rv-play-1440.png`、`rv-play-1280.png`、`rv-play-1024.png`、`rv-play-390.png`、`rv-play-390-scrolled.png`
- 状态：`rv-play-paused.png`、`rv-play-locked.png`、`rv-play-debug2.png`、`rv-play-notoken.png`、`rv-hold.png`、`rv-play-ended-empty.png`（构造）
- 选项/压力：`rv-play-one-choice.png`（构造）、`rv-stress-long.png`（构造）、`rv-stress-choices.png`（构造）、`rv-play-1024-tall.png`（构造）、`rv-choice-wrap-1024.png`（测量）
- 焦点：`rv-focus-tab.png`、`rv-focus-range.png`
- 手机：`rv-phone-390.png`、`rv-phone-1600.png`、`rv-phone-locked-390.png`

> 审查后已把 47833 预览恢复到「进行中、turn 7、有 3 个选项、调试关闭」；临时 47841 已停，临时的 `.ui-shots/rv-data` 已删除。被审 HTML/JS/CSS 未修改。
