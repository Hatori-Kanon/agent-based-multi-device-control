# AI-for-Coyote（Coyote in Cradle）产品面分析笔记

> 对象：`ai-for-coyote/`（HEAD `9cce657`，2026-08-30 23:01 +0800；GPL-3.0）
> 视角：**产品面**（UI / 前端状态与 API / 桌面壳 / 打包发布 / 内容 DLC / 启动编排 / 安全 UX / 产品取舍），不重复旧分析《项目分析-AI-for-Coyote.md》已覆盖的传输协议与安全层内部算法。
> 方法：**只读源码**（未安装依赖、未运行、未跑前端 build、未解压 DLC）；`content/pure/*.md` 仅统计文件结构与字段，不转述内容。行号以 HEAD 文件为准，均用 Read/grep 核对。
> 引用约定：`文件:行号` 均相对 `ai-for-coyote/` 仓库根（如 `frontend/src/App.tsx:15`）；旧分析引用相对工作区根（`项目分析-AI-for-Coyote.md:65`）。
> 标注约定：**【实现】**= 代码当前已实现；**【文档】**= README/注释/说明.txt 的声称；**【旧分析】**= 旧分析的说法。

---

## 0. 一句话结论

它是一个**只差发行签名/更新的 Windows 单机产品化样板**：pywebview 壳 + FastAPI 后端 + Bun 中继 + React 控制台，四段式启动、内置 DLC 导入、免装 zip + Inno 安装包、CI 只用 tag 触发构建；产品交互打磨集中在「急停/上限/通道/角色卡/传感器状态」五个点，而文档与实现已经出现多处漂移（强度修正、聊天输入、麦克风转写、DLC 档位），旧分析也有两条关键结论在 HEAD 已过时。

---

## 1. UI 信息架构

### 1.1 全局骨架（三栏 + 顶栏 + 悬浮底栏）

- 根布局：`flex h-full flex-col`；顶部 `TopBar`，中部 `grid` 三栏，底部 `BottomBar`，最后是急停长按浮层（`frontend/src/App.tsx:121-164`）。
- 三栏列宽由 store 按窗口宽度计算：左栏 `clamp(160, 15.8%, 360)`，右栏 `clamp(300, 32.2%, 900)`，中间聊天栏自适应；**不可拖拽**（`frontend/src/store.ts:48-78`，注释「固定比例三栏…不可拖拽」）。
- 全局缩放：窗口宽度 / 1600 → 0.8~1.3，用 CSS `zoom` 施在根节点（`frontend/src/App.tsx:22-33`、`frontend/src/App.tsx:122`）。
- 深色金色主题与字体栈在 Tailwind v4 `@theme` 中硬编码（`frontend/src/styles.css:3-20`）；`body` 禁止滚动（`frontend/src/styles.css:28-33`），页面高度 100%（`frontend/src/styles.css:23-27`）。
- 浏览器标签标题：静态为「郊狼 · AI 驯服师」（`frontend/index.html:6`），挂载后由后端 `config_info.title` 覆盖，默认值来自配置（`frontend/src/App.tsx:63-68`、`backend/main.py:209-217`）。

### 1.2 真实视图清单（与任务描述的「5 个页面」有差异）

| 区域 | 组件 | 形态 | 职责 | 证据 |
|---|---|---|---|---|
| 顶栏 | `TopBar.tsx` | 常驻 | 标题、导航（仅「控制台 / 设置」）、中继/App/急停三个状态胶囊 | `frontend/src/components/TopBar.tsx:18-45` |
| 左栏 | `Sidebar.tsx` | 常驻 | 设备卡（名称/在线/电量/A口/B口 chips）、角色卡、侧边导航、急停按钮、配件设置、称谓、免责脚注 | `frontend/src/components/Sidebar.tsx:29-66` |
| 中栏 | `ChatPanel.tsx` | 常驻（**不是独立 view**） | 当前主题徽章、清空历史、未配对二维码占位、消息流、自动运行开关 | `frontend/src/components/ChatPanel.tsx:64-174` |
| 右栏 view=control | `DeviceStatus` + `ChannelControl` + `PresetPanel` | 视图 | 设备状态/传感器、A/B 通道手动控制、自选波形组合 | `frontend/src/App.tsx:131-138` |
| 右栏 view=pair | `PairView` | 视图 | 配对二维码、配对地址、本机 IP、15s 轮询 | `frontend/src/components/views.tsx:6-45` |
| 右栏 view=settings | `SettingsView` | 视图 | 版本/模型/主题/配置文件路径 + AI 模型配置表单 | `frontend/src/components/views.tsx:47-195` |
| 底栏 | `BottomBar.tsx` | 常驻 | 全部清零、解除急停、中央暂停/恢复圆钮、空格提示 | `frontend/src/components/BottomBar.tsx:11-42` |

结论（避免沿用任务描述的假设）：**「聊天 / 手动控制 / 通道与配件 / 角色设置 / 设置」不是 5 个页面**——聊天是常驻中栏；「角色设置」是左栏角色卡点开的浮层（`frontend/src/components/RoleCard.tsx:151-265`）；「通道与配件」拆成右栏 `ChannelControl` 与左栏 `AccessoryConfig` 两处；只有 `control / pair / settings` 三个 view（`frontend/src/components/TopBar.tsx:3`）。

### 1.3 组件职责清单

| 组件 | 职责要点 | 证据 |
|---|---|---|
| `TopBar` | ViewName 只有 `control/pair/settings`，但导航只渲染 `control/settings`（pair 入口被移到左栏） | `frontend/src/components/TopBar.tsx:3`、`frontend/src/components/TopBar.tsx:18-21` |
| `Sidebar` | 设备卡取 `relay.clients[0]`，设备名缺省「郊狼 3.0」；chips 展示 slot 前 8 位/电量/A口/B口状态 | `frontend/src/components/Sidebar.tsx:14-46` |
| `RoleCard` | 两段式浮层：主题（角色列表，未装禁用）+ 风格（固定三档，按可用性点亮）；内置「导入 DLC」文件选择 | `frontend/src/components/RoleCard.tsx:210-259` |
| `AccessoryConfig` | A/B 配件预设（贴片/肛塞/待适配）自动带出位置与基准强度；位置输入 Enter/blur 提交 | `frontend/src/components/AccessoryConfig.tsx:7-11`、`frontend/src/components/AccessoryConfig.tsx:52-72` |
| `CharacterConfig` | 玩家昵称（AI 称呼），maxLength 20，blur/Enter 保存 | `frontend/src/components/CharacterConfig.tsx:27-37` |
| `DeviceStatus` | 连接徽章、摄像头/麦克风三态按钮（灰/绿/橙）、麦克风音量条与最近文本、A/B 行（强度/波形/配件名·位置） | `frontend/src/components/DeviceStatus.tsx:104-167` |
| `ChannelControl` | A/B 通道卡、开/关、强度滑杆、上限浮窗、±10、播放/暂停、停止、A/B 联动 | `frontend/src/components/ChannelControl.tsx:48-198` |
| `PresetPanel` | 分类页签 + 波形卡网格（6 列/窄屏 3 列），点击对焦点通道发 `pulse_hold` | `frontend/src/components/PresetPanel.tsx:27-62` |
| `BottomBar` | 全部清零、解除急停、中央圆钮、空格提示 | `frontend/src/components/BottomBar.tsx:16-40` |
| `ChatPanel` | 主题徽章、清空历史（`window.confirm`）、未配对二维码、消息气泡 + 动作标签、自动运行开关 | `frontend/src/components/ChatPanel.tsx:92-172` |
| `views.tsx` | 配对页与设置页（含 LLM 配置、测试连接、保存热加载） | `frontend/src/components/views.tsx:6-195` |

### 1.4 A/B 通道控件（打磨最重的一块）

- 通道卡顶部：`A/B 通道` + 设备名（未设置为「未设置」）+ 开/关按钮；关闭态整卡降透明、描边转红（`frontend/src/components/ChannelControl.tsx:107-133`）。
- 强度显示为「当前值 / 上限」，上限数字可点开浮窗滑杆（1~硬上限），文案「上限可调」；当最近请求值与当前值不一致时额外显示「设定 N」（`frontend/src/components/ChannelControl.tsx:134-165`）。
- 点浮窗外或鼠标抬起/按键抬起才提交上限（`frontend/src/components/ChannelControl.tsx:86-95`、`frontend/src/components/ChannelControl.tsx:152-161`）。
- 强度滑杆 `max={cap}`，本地值先动、`pointerup/keyup` 才发 `hold_strength`（乐观 + 提交式），避免拖动过程刷请求（`frontend/src/components/ChannelControl.tsx:69-70`、`frontend/src/components/ChannelControl.tsx:171-179`）。
- 四个动作按钮：−10 / +10（`add_strength`）、播放/暂停（`pulse_hold` ↔ `clear`）、停止（`clear`，危险色）（`frontend/src/components/ChannelControl.tsx:180-195`）。
- A/B 联动按钮只在右栏 ≥400px 时显示；开启后同一动作对 A/B 各发一次（`frontend/src/components/ChannelControl.tsx:14-16`、`frontend/src/components/ChannelControl.tsx:29-41`、`frontend/src/commands.ts:5-8`）。
- 窄屏（右栏 <400px）通道卡竖排，预设网格 3 列；`compact` 用右栏实际宽度判断而非窗口宽（`frontend/src/components/ChannelControl.tsx:14-16`、`frontend/src/components/PresetPanel.tsx:48-51`）。
- 焦点通道：点哪张卡哪张获得焦点（描边加亮），预设面板默认作用在焦点通道，并高亮该通道上次选的波形（`frontend/src/components/ChannelControl.tsx:108-112`、`frontend/src/components/PresetPanel.tsx:22-25`、`frontend/src/components/PresetPanel.tsx:54`）。

### 1.5 「强度修正滑块（50%~150%）」——**HEAD 已不存在**

- 前端全部源码中已无「强度修正 / multiplier / 150」类实现（grep 仅命中 `frontend/src/components/views.tsx:21` 的 15000 轮询）。
- 该功能是在 `661ffed`（2026-08-30 03:28）「前端改版：固定比例三栏/紧凑控制区/主题头像/移除强度修正」中前后端一起删掉的：本次提交删除了 `game_loop` 的倍率缩放、`safety` 的 scale 字段、`ChannelControl` 的滑杆。
- 但 README 仍两处声称存在（`README.md:34`、`README.md:162`）→ **【文档】过时**。

### 1.6 自动运行开关

- 位置在中栏**底部**，不在顶部：标题「自动运行」+ 动态说明文字（AI 每 N 秒观察/调整/发言，摄像头/麦克风开或关）+ 圆形开关（`frontend/src/components/ChatPanel.tsx:154-172`）。
- 说明文字随状态组合变化（未开=「自动运行已停止，AI 暂停行动」；开+传感器=运行中提示；开+传感器未开=「摄像头/麦克风已关闭」）（`frontend/src/components/ChatPanel.tsx:21-27`）。
- 切换调用 `POST /api/autopilot`，后端同时启停传感器（`frontend/src/components/ChatPanel.tsx:56-62`、`backend/main.py:698-705`）。
- 【文档】README 说「顶部开关」（`README.md:163`），与实际位置不符。

### 1.7 状态徽章（三层冗余，防止误判）

- 顶栏三个胶囊：`中继: 未连接/连接中/等待 App/已配对`、`App: N 台在线/未接入`、`急停: 已触发/否`（`frontend/src/components/TopBar.tsx:12-16`、`frontend/src/components/TopBar.tsx:43-45`）。
- 设备卡：在线圆点 + 状态词（已连接/等待配对/未连接）+ slot/电量/A口/B口 chips（`frontend/src/components/Sidebar.tsx:30-47`）。
- 设备状态卡：实时连接徽章（绿已连接/红未连接）（`frontend/src/components/DeviceStatus.tsx:110-124`）。
- 传感器按钮三态：灰=关（或自动运行未开）/ 绿=开且在跑 / 橙=开但未跑（警示三角），tooltip 给出具体原因（缺依赖、启动中、自动运行未开）（`frontend/src/components/DeviceStatus.tsx:61-102`）。
- 通道工作状态文字：已关闭 / ▶波形名 / 工作中 / 未工作（`frontend/src/components/ChannelControl.tsx:167-169`）。

### 1.8 底部栏

- 固定 `bottom-0 h-14`，左右边界分别贴左栏/右栏宽度，形成只覆盖中栏的悬浮条（`frontend/src/components/BottomBar.tsx:11-15`）。
- 左：全部清零（`stop` 同时发 A/B）、解除急停；中：跨在栏顶边线上的圆形按钮（急停中显示 ▶ 并恢复，否则显示 ⏸ 触发急停）；右：`空格 = 急停` 提示（`frontend/src/components/BottomBar.tsx:16-40`）。
- 注意：底部「全部清零」在急停中也只是普通 `manual stop`，会被安全层以「急停中，拒绝一切设备动作」拒绝（`backend/safety.py:95-96`）——UI 没有对此做禁用态。

### 1.9 「打磨过的产品细节」清单

1. 长按空格 1s 急停带进度条动画，动画时长与判定时长共用同一常量（`frontend/src/App.tsx:14-15`、`frontend/src/App.tsx:145-163`）；松手/窗口失焦取消，输入框内不劫持空格，已急停不重复触发（`frontend/src/App.tsx:91-111`）。
2. 角色/风格切换后自动往聊天流插一条「—— 已切换至 X · Y ——」分隔消息，避免上下文串戏（`frontend/src/components/ChatPanel.tsx:31-42`）。
3. 选完角色浮层不关、继续选风格；选完风格也不关（注释「用户要求」）（`frontend/src/components/RoleCard.tsx:78`、`frontend/src/components/RoleCard.tsx:84-93`）。
4. 角色列表对「未装 DLC」的角色禁用并显示「未装」，点击有明确指引文案（`frontend/src/components/RoleCard.tsx:177-204`）。
5. DLC 导入成功后显示「已导入 N 个文件到 content\pack\<dir>，已自动启用「风格」」并自动切到新角色/风格（`frontend/src/components/RoleCard.tsx:95-114`）。
6. 配件下拉选中即带出默认位置与基准强度（敏感配件基准低），并立即落盘（`frontend/src/components/AccessoryConfig.tsx:7-11`、`frontend/src/components/AccessoryConfig.tsx:67-72`）。
7. 未配对时中栏直接显示二维码 + 「配对后请在 App 里打开『输出』开关」警示 + 「连接成功后 3 秒，AI 会主动开场」（与后端 3s 延时一致）（`frontend/src/components/ChatPanel.tsx:92-113`、`backend/main.py:164-169`）。
8. 配对页 15s 轮询网络信息，二维码用时间戳防缓存（`frontend/src/components/views.tsx:20-22`、`frontend/src/components/views.tsx:31`）。
9. 双通道都关闭时聊天区顶部红条警告「AI 不会输出任何刺激」（`frontend/src/components/ChatPanel.tsx:116-120`）。
10. 所有带输入/选择的浮层都做了「点外部关闭」，角色列表还处理了「点当前行不要先收起」的边界（`frontend/src/components/RoleCard.tsx:43-65`、`frontend/src/components/ChannelControl.tsx:77-84`、`frontend/src/components/AccessoryConfig.tsx:43-50`）。
11. 清空对话有二次确认，并明说「设备强度不受影响」（`frontend/src/components/ChatPanel.tsx:76-90`）。
12. 设置页把「哪些配置热加载、哪些要重启」写清楚；LLM Key 只回显掩码、留空保存=清除（`frontend/src/components/views.tsx:67-71`、`frontend/src/components/views.tsx:142-161`、`backend/main.py:708-725`）。
13. 后端把当前三栏布局（sidebar_w/control_w/inner_width/zoom）以 300ms 节流上报，属调试/监测埋点，不是功能（`frontend/src/App.tsx:35-48`、`backend/main.py:469-481`）。
14. 后端接口普遍「先 accepted 再由 WS 推送刷新」，前端注释「状态由 ws 推送刷新」（`frontend/src/components/ChannelControl.tsx:90-94`、`frontend/src/components/DeviceStatus.tsx:54-59`）。
15. 底部中央按钮跨栏顶边、带光晕，是明显的视觉主操作点（`frontend/src/components/BottomBar.tsx:28-36`）。

### 1.10 IA / 可用性问题

- **没有聊天输入框**：`ChatPanel` 只有消息流与自动运行开关，无 textarea/发送按钮；`api.chat` 在 `frontend/src/api.ts:31` 定义但**全前端无调用方**（grep 仅定义处）；`POST /api/chat` 后端仍在（`backend/main.py:395-399`）。【文档】`README.md:160`「左侧与 AI 对话」不成立（HEAD 是自动运行优先的控制台）。
- 导航不对称：`ViewName` 有三种，顶栏只给两种（`frontend/src/components/TopBar.tsx:3` vs `:18-21`），配对页只能从左栏按钮进入（`frontend/src/components/Sidebar.tsx:53`）。
- 布局不可拖拽、无移动端自适应、无折叠；窄窗靠缩放兜底（`frontend/src/store.ts:48` 注释、`frontend/src/App.tsx:24-33`）。
- 很多失败被静默吞掉（`.catch(() => {})`），只有角色切换/LLM 设置会显示错误（见 §2.5）。
- 无 aria/键盘可达性设计；颜色是唯一状态载体（传感器三态、通道开关）——`frontend/src/components/DeviceStatus.tsx:85-90`。

---

## 2. 前端状态与 API 面

### 2.1 store 结构（zustand，三个独立 store）

| store | 字段 | 用途 | 证据 |
|---|---|---|---|
| `useApp` | `state: FullState|null`、`focusCh`、`linkOn`、`lastPreset` | 后端全量状态的镜像 + 纯前端交互态 | `frontend/src/store.ts:5-25` |
| `useChat` | `messages`、`busy`、`push/setBusy/clear` | 聊天流（AI/用户/系统三条角色）；`busy/setBusy` **无任何组件使用**（死代码） | `frontend/src/store.ts:33-46` |
| `useLayout` | `sidebarW`、`controlW`、`updateLayout` | 三栏宽度，窗口 resize 时重算 | `frontend/src/store.ts:69-78` |

- `FullState` 有 60+ 字段：安全（estop/caps/user_caps/effective_caps/app_caps/current/requested/overheat/pulse_active/enabled_channels）、角色（role/roles/profile/profile_available/profile_level）、传感器（camera/audio/sensors/sensors_on）、中继（relay.clients/props/slotState）、播放参数、UI 常量、`config_info`（`frontend/src/types.ts:47-124`）。
- 状态只有一个方向：后端 `build_state()` → WS 推送 → `setState` 覆盖（`backend/game_loop.py:84-129`、`backend/main.py:201-218`、`frontend/src/App.tsx:77-86`）；前端不自己拼派生状态（`requested` vs `current` 由后端给）。

### 2.2 REST 端点清单（前端调用 + 后端实现）

| 方法/路径 | 用途 | 前端调用点 | 后端实现 |
|---|---|---|---|
| GET `/` | 返回 `frontend/dist/index.html`；未构建时纯文本提示 | 浏览器/WebView 入口 | `backend/main.py:328-336`、`backend/main.py:333-336` |
| GET `/assets/*` | 托管 Vite 产物（存在才挂载） | 前端静态资源 | `backend/main.py:339-340` |
| GET `/api/state` | 全量状态（首屏 + 壳健康检查 `BACKEND_URL`） | `frontend/src/api.ts:30`、`desktop/shell.py:25` | `backend/main.py:342-344` |
| GET `/api/qrcode.png` | 服务端生成配对二维码 PNG（无 controller 时 503） | `<img src>`：`frontend/src/components/ChatPanel.tsx:95`、`frontend/src/components/views.tsx:31` | `backend/main.py:346-358` |
| GET `/api/pair_url` | 仅返回配对 URL | **前端未使用**（死端点） | `backend/main.py:360-368` |
| GET `/api/network` | 本机 IP 列表 + 配对 URL + 提示 | `frontend/src/api.ts:37`、`frontend/src/components/views.tsx:15` | `backend/main.py:370-392` |
| POST `/api/chat` | 文本对话，返回 `{line, actions, executed, dropped}` | **前端未使用**（`frontend/src/api.ts:31` 无调用方） | `backend/main.py:395-399` |
| POST `/api/manual` | 手动动作，与 AI 指令同一条安全链路 | `frontend/src/api.ts:32`、`frontend/src/commands.ts:31` | `backend/main.py:413-420` |
| POST `/api/estop` | 急停 | `frontend/src/api.ts:34`、`frontend/src/commands.ts:41` | `backend/main.py:401-405` |
| POST `/api/resume` | 解除急停 | `frontend/src/api.ts:35`、`frontend/src/commands.ts:49` | `backend/main.py:407-411` |
| POST `/api/history/clear` | 清模型上下文 + 前端清列表 | `frontend/src/api.ts:36`、`frontend/src/components/ChatPanel.tsx:79-85` | `backend/main.py:463-467` |
| POST `/api/device/channels` | 保存 A/B 配件（名字/位置/基准） | `frontend/src/api.ts:38-40`、`frontend/src/components/AccessoryConfig.tsx:61` | `backend/main.py:422-430` |
| POST `/api/device/channels/enabled` | 手动开/关通道（持久化） | `frontend/src/api.ts:41-42`、`frontend/src/components/ChannelControl.tsx:101` | `backend/main.py:432-445` |
| POST `/api/device/channels/cap` | 运行时强度上限（不持久化） | `frontend/src/api.ts:43-47`、`frontend/src/components/ChannelControl.tsx:91` | `backend/main.py:483-506` |
| POST `/api/sensors` | 运行时开/关摄像头/麦克风（不持久化） | `frontend/src/api.ts:50-54`、`frontend/src/components/DeviceStatus.tsx:56` | `backend/main.py:447-461` |
| POST `/api/layout` | 上报三栏布局（调试） | `frontend/src/api.ts:48-49`、`frontend/src/App.tsx:39` | `backend/main.py:469-481` |
| POST `/api/character/profile` | 切角色/风格；目标 DLC 未装时 400 `detail: dlc_missing` | `frontend/src/api.ts:55-59`、`frontend/src/components/RoleCard.tsx:77`、`frontend/src/components/RoleCard.tsx:88` | `backend/main.py:508-538` |
| POST `/api/character/nick` | 改昵称（1~20 字，热加载） | `frontend/src/api.ts:60-61`、`frontend/src/components/CharacterConfig.tsx:18` | `backend/main.py:540-548` |
| POST `/api/dlc/import` | multipart 上传 `.zip/.md`，落盘 + 自动接线 + 热加载 | `frontend/src/api.ts:62-72`、`frontend/src/components/RoleCard.tsx:100` | `backend/main.py:550-696` |
| POST `/api/autopilot` | 自动运行开关（连带启停传感器） | `frontend/src/api.ts:73-74`、`frontend/src/components/ChatPanel.tsx:58` | `backend/main.py:698-705` |
| GET `/api/settings/llm` | 读 LLM 配置（masked key） | `frontend/src/api.ts:75-82`、`frontend/src/components/views.tsx:95` | `backend/main.py:708-725` |
| POST `/api/settings/llm` | 保存 API Key/URL/模型并热加载（不重启） | `frontend/src/api.ts:83-84`、`frontend/src/components/views.tsx:111` | `backend/main.py:751-778` |
| POST `/api/settings/llm/test` | 用表单值发一条最小 OpenAI 兼容请求 | `frontend/src/api.ts:85-89`、`frontend/src/components/views.tsx:126` | `backend/main.py:780-803` |
| WS `/ws` | 实时状态推送 + AI 主动聊天推送 | `frontend/src/App.tsx:70-90` | `backend/main.py:806-819` |

- 另有 FastAPI 自带的 `/docs`、`/redoc`、`/openapi.json` 未关闭（`backend/main.py:313` 构造 app 时未设 `docs_url=None`）；默认只绑 127.0.0.1，外网不可达，但**若把 host 改为 0.0.0.0，就等于把无鉴权 API 文档也一起暴露**。
- 前端开发模式用 Vite 代理 `/api`、`/ws` 到 8000（`frontend/vite.config.ts:7-11`），build 输出 `dist`（`frontend/vite.config.ts:13`）；后端托管 `frontend/dist`，仓库不提交 dist（`.gitignore:3`）。

### 2.3 WebSocket

【实现】有 WS，不只是轮询：`ws(s)://<location.host>/ws`，断线后固定 2s 重连（无指数退避、无 onerror 处理）（`frontend/src/App.tsx:70-90`）。
- 服务端在 accept 后立即推一帧 `{"type":"state","data":...}`，之后每次状态变化广播（`backend/main.py:806-819`、`backend/main.py:179-188`）。
- 两类消息：`type:"state"` → 覆盖 store；`type:"chat"` → AI 主动回合的台词 + 执行/被拒动作标签（`frontend/src/App.tsx:77-86`、`backend/main.py:190-199`、`backend/game_loop.py:113`）。
- 后端 WS 循环只 `receive_text()` 丢弃（客户端心跳/无应用层 ping）（`backend/main.py:812-815`）；浏览器断开 30s 后自动关摄像头/麦克风（`backend/main.py:237-257`）。

### 2.4 轮询 / 节流节奏

| 动作 | 节奏 | 证据 |
|---|---|---|
| 全量状态 | WS 推送，无轮询 | `backend/main.py:179-188` |
| 配对页网络信息 | 15s 轮询 | `frontend/src/components/views.tsx:20-22` |
| 布局上报 | 300ms 防抖 | `frontend/src/App.tsx:35-48` |
| WS 重连 | 固定 2s | `frontend/src/App.tsx:88` |
| 传感器看门狗（后端） | 15s 重试启动 | `backend/main.py:259-281` |
| 自动运行回合 | 默认 12s（`autopilot.interval_s`） | `backend/config.py:97-98` |

### 2.5 乐观更新与错误处理

- 明确做乐观更新的只有三处：通道强度滑杆（本地 state 先动，`pointerup/keyup` 提交）、配件下拉（注释「本地乐观状态：点选立即生效（避免等服务器回包时闪回旧值）」）、布局 store（纯本地）；角色/风格切换是「先请求成功再关浮层」的半乐观（`frontend/src/components/ChannelControl.tsx:69-70`、`frontend/src/components/AccessoryConfig.tsx:32-40`、`frontend/src/components/RoleCard.tsx:76-93`）。
- 错误处理策略是「发请求失败就交给 WS 刷新」，大量 `.catch(() => {})`：`frontend/src/App.tsx:45`、`frontend/src/App.tsx:69`、`frontend/src/components/ChannelControl.tsx:92-94`、`frontend/src/components/DeviceStatus.tsx:57-59`、`frontend/src/components/ChatPanel.tsx:60-61`、`frontend/src/components/AccessoryConfig.tsx:62-64`、`frontend/src/commands.ts:42-44`。
- 只有两处面向用户显式报错：角色切换/导入失败（红字）与 LLM 保存/测试（状态文字）（`frontend/src/components/RoleCard.tsx:261-262`、`frontend/src/components/views.tsx:186-190`）。
- 手动动作结果会以系统消息形式进聊天流（`▶ 已执行 / ✖ 原因`），这是唯一的手动操作反馈通道（`frontend/src/commands.ts:10-20`、`frontend/src/commands.ts:22-37`）。
- `doResume` 没有 try/catch（`frontend/src/commands.ts:48-50`），失败会产生未处理的 Promise，属于小瑕疵。

### 2.6 前后端类型漂移（产品面可见的 3 处）

1. `types.ts` 的 `config_info.safeword` 后端根本不返回（`frontend/src/types.ts:114-117` vs `backend/main.py:209-217`）；同时 README 明说「不设安全词口令」（`README.md:165`）→ 字段是历史遗留。
2. `POST /api/chat` 端点保留但前端不用（见 §1.10）。
3. 后端 state 带 `rage_rounds/rage_triggered`（`backend/game_loop.py:115-116`），前端类型与 UI 都不消费（`frontend/src/types.ts:47-124`）。

---

## 3. 桌面壳（`desktop/shell.py`）

### 3.1 生命周期

【实现】双击壳 exe → 静默拉起中继与后端 → 轮询后端就绪 → 打开内嵌 WebView 窗口 → 关窗后按进程树清理（文件头注释即此四步，`desktop/shell.py:2-8`）。

1. 资源根：frozen 模式=exe 所在目录；源码模式=仓库根（`desktop/shell.py:33-36`）。
2. 日志：`logs/shell.log`（`desktop/shell.py:39-45`）；中继/后端子进程 stdout/stderr 追加到 `logs/shell-relay.log`、`logs/shell-backend.log`（`desktop/shell.py:80-94`）。
3. 单实例：`CreateMutexW("CoyoteInCradleSingleInstance")`，已存在则弹 MessageBox「已在运行」并退出（`desktop/shell.py:55-59`、`desktop/shell.py:130-132`）。
4. 端口复用：9998 已被占用则不启动中继；8000 已被占用则不启动后端（方便开发环境复用现有实例）（`desktop/shell.py:135-147`）。
5. 找 bun：本地 `bun.exe` → `%APPDATA%\npm\...\bun.exe` → `~/.bun/bin/bun.exe` → `C:\Program Files\Bun\bin\bun.exe`（`desktop/shell.py:68-77`）；找不到弹「请重新安装完整包」（`desktop/shell.py:137-140`）。
6. 起中继：`bun run v4-server.ts`，cwd=`relay/`（`desktop/shell.py:141`）；起后端：优先 `AI-for-Coyote.exe`，否则 `python -m backend.main`（`desktop/shell.py:143-147`）。
7. 就绪探测：最多 30s，每 0.5s 请求 `http://127.0.0.1:8000/api/state` 直到 200；超时弹「后端启动超时，请查看 logs\app.log」（`desktop/shell.py:25`、`desktop/shell.py:97-108`、`desktop/shell.py:148-151`）。
8. 开窗：`webview.create_window(APP_TITLE, "http://127.0.0.1:8000", width=1440, height=900, min_size=(1100, 700))`，`webview.start()` 阻塞直到关窗（`desktop/shell.py:152-163`）。
9. WebView2 缺失：捕获 `WebViewException`，弹 MessageBox 并给出微软下载链接（`desktop/shell.py:164-169`）。
10. 退出：`finally: shutdown()`，对 `_procs` 逆序 `taskkill /PID <pid> /T /F`，然后清空列表（`desktop/shell.py:111-124`、`desktop/shell.py:170-172`）；同时注册了 `atexit` 兜底并在 finally 注销（`desktop/shell.py:133`、`desktop/shell.py:172`）。

### 3.2 窗口与主题资源

- 窗口标题常量 `"Coyote in Cradle"`（`desktop/shell.py:23`）；尺寸 1440×900、最小 1100×700（`desktop/shell.py:156-162`）。
- **没有** `background_color`/主题参数、没有窗口位置记忆、没有全屏/无边框、没有自定义菜单——深色主题完全靠前端 CSS，WebView2 首帧可能出现白闪（`desktop/shell.py:152-163` 参数表可证）。
- 图标资源：壳/安装器用 `desktop/app.ico`（95 KB）与 `desktop/setup.ico`（6.5 KB）；后端 exe 故意不配图标，避免用户点错（`packaging/build_release.py:183`、`packaging/build_release.py:200`、`packaging/build_release.py:159` 注释）。
- 关窗即退出这一点由「`webview.start()` 返回 → finally taskkill」保证；壳不监听系统托盘，不常驻（`desktop/shell.py:170-172`）。

### 3.3 与后端/dist 的耦合方式

- 壳本身**不托管任何文件**，只把 `http://127.0.0.1:8000` 交给 WebView2；页面、静态资源、API、WS 全部由 FastAPI 后端提供（`desktop/shell.py:158`、`backend/main.py:328-340`、`backend/main.py:806-819`）。
- 健康检查 URL 直接写死 `/api/state`（`desktop/shell.py:25`）——壳与 API 契约强耦合；后台若改了状态路由，壳会启动超时。
- 端口 8000/9998 写死在壳里（`desktop/shell.py:25`、`desktop/shell.py:136`、`desktop/shell.py:143`），不读 `config.yaml`；用户改端口后壳与一键脚本都会对不上（只有手动按配置启动后端才行）。
- 壳不负责版本/更新检查（全文无 update 逻辑），也不区分 dev/release 的 API 前缀。

### 3.4 壳层问题

- 端口被**别的程序**占用时会静默复用：只要 8000 上任意服务对 `/api/state` 返回 200，壳就认为后端就绪并开窗（`desktop/shell.py:97-108`）；更常见的是上一轮崩溃残留的孤儿后端。
- `taskkill /F` 硬杀，后端没有优雅退出机会（配置写盘可能被截断，且 `logs/app.log` 无关闭日志）。
- 第二次启动只弹「已在运行」，不会把已有窗口带到前台（`desktop/shell.py:130-132`）。

---

## 4. 打包发布

### 4.1 `packaging/build_release.py` 做什么

【实现】「绿色免装发布包」构建脚本，默认版本 `0.1.0-beta`，可传参覆盖（`packaging/build_release.py:8-12`、`packaging/build_release.py:25`）。

| 步骤 | 内容 | 证据 |
|---|---|---|
| 1/6（仅本地） | `npm.cmd run build` 构建前端 | `packaging/build_release.py:111-112` |
| 2/6（仅本地） | 建 venv + pip（清代理、清华镜像）安装 `requirements.txt + pyinstaller + opencv-python + numpy + pywebview` | `packaging/build_release.py:114-132` |
| 3/6 | PyInstaller `--onefile` 打包后端入口 `run_app.py` → `AI-for-Coyote.exe`；排除 faster_whisper/torch/tensorflow；补 uvicorn/multipart hidden-import；**不配图标** | `packaging/build_release.py:153-175` |
| 3.5/7 | PyInstaller `--onefile --windowed` 打包桌面壳 → `Coyote-in-Cradle.exe`；`--icon desktop/app.ico`；`--collect-all webview`、`--collect-all pywebview` | `packaging/build_release.py:177-191` |
| 4/7 | 组装 `build_release/Coyote-in-Cradle-v<ver>/` 目录（见 §4.2） | `packaging/build_release.py:193-230` |
| 5/7 | 压 zip：`Coyote-in-Cradle-v<ver>.zip` | `packaging/build_release.py:232-236` |
| 6/7 | 用模板生成 `build_release/installer.iss`（替换 version/pkgdir/outdir） | `packaging/build_release.py:238-245` |
| 7/7 | 打印 zip 大小 | `packaging/build_release.py:247` |

- 本地/CI 双模式：`--ci` 时用当前解释器、不建 venv、不跑 npm（`packaging/build_release.py:26`、`packaging/build_release.py:107-109`）；CI 里前端与依赖由 workflow 单独装（`.github/workflows/release.yml:31-36`）。
- PyInstaller 查找有三级兜底（同目录 / Scripts / PATH）（`packaging/build_release.py:134-151`）。
- 中继**不打包代码**：直接把 `relay/` 源码目录复制进产物，靠随包的 `bun.exe` 现场执行 TS（`packaging/build_release.py:219-222`）；bun 来源按 npm global / ~/.bun / Program Files 顺序找（`packaging/build_release.py:201-218`）。

### 4.2 免装 zip 的产物结构（构建脚本写死）

```
Coyote-in-Cradle-v<ver>/
├─ Coyote-in-Cradle.exe     # 壳（pywebview，带图标）
├─ AI-for-Coyote.exe        # 后端（PyInstaller onefile，无图标）
├─ bun.exe                  # 中继运行时（从开发机复制）
├─ setup.ico                # 安装器图标
├─ start.bat                # 由脚本内嵌模板生成（与仓库根 start.bat 不同）
├─ 说明.txt                 # 由脚本内嵌模板生成（安装器把它当 LicenseFile）
├─ version.txt              # 版本号，运行时读入 /api/state
├─ LICENSE
├─ relay/                   # v4-server.ts 等源码（排除 node_modules/.env/*.log）
├─ config/                  # config.example.yaml / character.example.yaml / waveforms.yaml
├─ content/pure/            # 本体内容三件套（不含 pack/）
└─ frontend/dist/           # Vite 构建产物
```

证据：`packaging/build_release.py:193-230`；运行时根目录判定 `backend/main.py:43-47`；版本读取 `backend/main.py:50-57`。

### 4.3 安装器（Inno Setup）与 CI

- `installer.iss`：固定 `AppId`、`AppVersion={version}`、装到 `%LOCALAPPDATA%\Programs\Coyote in Cradle`（**per-user，无需管理员**）、`PrivilegesRequired=lowest`、`Compression=lzma2`、桌面+开始菜单快捷方式、安装完可勾选启动（`packaging/installer.iss:1-27`）。
- 两个细节：`LicenseFile` 指向 `说明.txt` 而不是 `LICENSE`（`packaging/installer.iss:16`）；`AppId={{CoyoteInCradleDesktop}}` 是自定义串而非 GUID（`packaging/installer.iss:2`）。
- `build_release.py` **只生成 .iss，不编译安装器**；真正编译在 CI：`choco install innosetup` + `ISCC.exe build_release/installer.iss`（`.github/workflows/release.yml:52-57`）。
- 发布触发：push tag `v*` 或手动 dispatch（`.github/workflows/release.yml:3-7`）；CI 用 tag 去掉 `v` 作为版本（`.github/workflows/release.yml:47-48`）；上传 zip + setup.exe，自动生成 release notes、允许覆盖（`.github/workflows/release.yml:59-66`）。
- CI 没有 test/lint 步骤，也没有签名/公证步骤；并且专门给工作目录加了 Defender 排除，注释直言「PyInstaller 产物偶发被 Defender 误报」（`.github/workflows/release.yml:43-46`）。

### 4.4 版本与更新策略

- 版本只有「构建时写 `version.txt`」这一条链路：zip 根目录 `version.txt`，运行时 `_app_version()` 读取，设置页展示；源码运行显示 `dev`（`packaging/build_release.py:230`、`backend/main.py:50-57`、`frontend/src/components/views.tsx:50-56`）。
- **没有任何自动更新/检查更新/增量升级机制**：壳、安装器、后端都不查询版本（`desktop/shell.py`、`packaging/installer.iss`、`packaging/build_release.py` 全文无相关逻辑）；安装器也不做「检测已安装版本/正在运行」的 `[Code]`。
- DLC 也不带版本，导入即覆盖（`backend/main.py:610-617`）。

### 4.5 发布流程缺点（基于代码）

1. 双模式构建路径分叉：本地跑 `npm run build` + 建 venv/装依赖，CI 跳过（前端与依赖由 workflow 单独装）；两处依赖集相同但**全未锁版本**（`requirements.txt` 只有 `>=` 下限，pyinstaller/opencv-python/pywebview 未固定），构建不可复现（`packaging/build_release.py:106-132`、`.github/workflows/release.yml:31-36`、`requirements.txt:1-9`）。
2. 脚本步骤编号自相矛盾（1/6…3.5/7、4/7…），维护痕迹明显（步骤标题见 `packaging/build_release.py:111`、`packaging/build_release.py:114`、`packaging/build_release.py:153`、`packaging/build_release.py:177`、`packaging/build_release.py:193`、`packaging/build_release.py:232`、`packaging/build_release.py:238`、`packaging/build_release.py:247`）。
3. 壳的 PyInstaller 参数同时给 `--collect-all webview` 与 `--collect-all pywebview`：pip 发行名是 pywebview、import 名是 webview，两行职责重复；当前离线 CI 能产出说明当前 PyInstaller 能过，但属于依赖“名字容忍度”的易碎配置（`packaging/build_release.py:187-188`）。
4. bun.exe 从开发机现有安装复制、路径硬编码，构建机没有 bun 时直接退出（`packaging/build_release.py:201-218`）。
5. 无体积预算/无签名/无 SBOM；zip 只是拼目录，`shutil.copytree` 不带任何校验（`packaging/build_release.py:193-236`）。
6. 产物包含 `relay/` 源码：Bun 直接执行 TS，所以源码必须随包（同时也满足 relay 的 GPL-3.0 源码可得性）；副作用是中继逻辑完全公开、可直接被改而无需重打包。
7. 安装器没有 `[UninstallDelete]`/`[Code]` 卸载钩子：用户安装后导入的 `content/pack/` DLC 与生成的 `config/character.yaml`、`device_channels.yaml`、`character_runtime.yaml` 不在 Inno 安装清单里，卸载/升级重装都没有「用户数据」处理与迁移逻辑（`packaging/installer.iss:1-27`、`backend/main.py:567-568`、`backend/config.py:237`、`backend/config.py:319-320`）。

---

## 5. 内容 / DLC 机制

### 5.1 目录与命名规范

- 内容包目录：`content/pack/DLC<序号>-<角色>-<风格>/`（README 的长期规划里明确写死该规范：`README.md:45`；DLC 导入的目录解析正则同样按此匹配：`backend/main.py:592-599`）。
- 每个风格三类文件：`<角色>-角色提示词-<风格>.md`、`<角色>-语料库-<风格>.md`、`<角色>-漫画设定-<风格>.md`（`README.md:65-93`）。
- 本体内容固定放在 `content/pure/`（默认「触手·纯爱」，`README.md:65-73`）；`content/pack/` 被 gitignore，不随仓库分发（`.gitignore:28-30`）。
- `config/character.yaml` 的角色映射：`roles.<角色>.profiles.<风格>.{level, prompt_file, examples, note}`，`level` ∈ 轻/中/重（`config/character.example.yaml:17-59`）。

### 5.2 三类文件里只有「角色提示词」真正被运行时读取

【实现】`_load_character` 只把 `prompt_file` 内容读进 `character.prompt`，然后注入系统提示词（`backend/config.py:460-463`、`backend/llm.py:25-55`）。
`语料库`/`漫画设定` 在 backend/frontend/config 中**没有任何读取点**（grep 只命中 `README.md` 的分发说明；代码与配置里没有对应解析）——它们是 DLC 分发与人工维护的约定资产，运行时靠「提示词文件自带语料」工作。这意味着 DLC 的「三件套」里只有一件是机器可用的，另外两件是给人看的/供作者写提示词时参考的。

### 5.3 DLC 导入流水线（前端 → 后端 → 落盘 → config → 热启停）

1. 前端：角色卡浮层「导入 DLC（.zip 或 .md）」→ 隐藏 `<input type=file accept=".zip,.md">`（`frontend/src/components/RoleCard.tsx:243-259`）。
2. 前端：`FormData` 上传 `POST /api/dlc/import`，`busy` 期禁用按钮，成功显示「已导入 N 个文件到 content\pack\<dir>」并自动 `setProfile` 切到新内容（`frontend/src/api.ts:62-72`、`frontend/src/components/RoleCard.tsx:95-114`）。
3. 后端限流/校验：只收 `.zip/.md`、空文件拒绝、>50MB 拒绝（`backend/main.py:557-565`）。
4. 解包：zip 先做 cp437→UTF-8 文件名还原（兼容 Windows 压缩工具不写 UTF-8 标志）（`backend/main.py:577-586`）；只保留 `.md`，按「`DLC\d+-角色-风格` 路径组件」分组，否则按顶层目录/单层包装规则分组（`backend/main.py:587-603`）。
5. 单文件 `.md`：从文件名 `^(.+?)-角色提示词-(.+?)\.md$` 解析主题/风格，归入 `DLC导入-<主题>-<风格>` 组（`backend/main.py:604-608`）。
6. 落盘：写到 `content/pack/<组>/<文件名>`，跳过 `.`/`..` 与含 `..` 的组名（防路径穿越）（`backend/main.py:610-617`）。
7. 自动接线：找组内文件名含「角色提示词」的 md → `reload_character` → 把 `content/pack/<dir>/<prompt>` 作为相对路径写回 `character.yaml`（`backend/main.py:621-673`、`backend/config.py:514-604`）：
   - 角色已存在：在 prompt 文件名里找与现有 profile 名匹配的档位（找不到取第一个），**并强制把该档 level 设为「中」**（`backend/main.py:645-652`）。
   - 角色不存在：按目录名/文件名解析角色与风格，**以 level「中」注册新角色块**（`backend/main.py:653-658`、`backend/config.py:607-654`）。
   - 解析不出主题：退回当前角色内匹配（`backend/main.py:659-671`）。
8. 热加载：`reload_character(cfg)` 重读配置 + 提示词文件（`backend/config.py:314-316`）；不需要重启（注释与 README 一致：`backend/main.py:552-555`、`README.md:77`）。下一次 AI 回合开始时会再 reload 一次（`backend/game_loop.py:139`、`backend/game_loop.py:181`、`backend/game_loop.py:263`、`backend/game_loop.py:328`）。

### 5.4 未装 DLC 的降级与拦截（三层拦截 + 一层兜底）

1. 可用性计算：`available = 对应 prompt_file 是否存在`（`backend/config.py:353-359`、`backend/config.py:438-445`），随 state 下发 `roles[].profiles[].available` 与 `profile_available`。
2. 前端：角色列表里「没有任何可用风格」的角色禁用并显示「未装」，tooltip「需要安装对应 DLC（content\pack\）」；三档按钮未点亮为禁用（`frontend/src/components/RoleCard.tsx:177-204`、`frontend/src/components/RoleCard.tsx:210-241`）。
3. 后端：切角色/风格前先 `reload_character` 再校验，未装返回 400 + `detail:"dlc_missing"` 与中文指引（`backend/main.py:508-533`）。
4. 另有一层「兜底角色」：`character.yaml` 不存在时 `load_config` 回退到 `character.example.yaml`，所以全新解包也能用触手纯爱开箱即跑（`backend/config.py:150-157`）。

### 5.5 角色主题资源（`roleTheme.ts`）

- 头像：`触手`/`品评会` 两张像素风 PNG 随前端包分发（532 KB / 729 KB，`frontend/src/assets/theme-cushou.png`、`frontend/src/assets/theme-pingpinghui.png`），映射硬编码（`frontend/src/roleTheme.ts:3-14`）。新 DLC 角色没有头像 → 回退「首字块」（`frontend/src/components/RoleCard.tsx:128-132`）。
- 档位语义映射：`轻→纯爱（绿）`、`中→调教（金）`、`重→凌辱（红）`，用于徽章/圆点/描边（`frontend/src/roleTheme.ts:15-32`）。
- 角色描边色只给「触手/品评会」两套（`frontend/src/roleTheme.ts:34-42`）——**品评会的头像/描边随本体前端预置**，即使内容 DLC 未安装，UI 主题资源已经先到位。
- 死代码：`STYLE_LABELS`、`STYLE_DESCS`、`styleDesc()` 无任何组件引用（`frontend/src/roleTheme.ts:44-57`；grep 仅定义处）。

### 5.6 `content/pure/` 结构统计（只统计，不转述）

| 文件 | 行数 | 字节 | `#` | `##` | `###` | 列表项 | 表格行 | 代码块 | YAML front matter |
|---|---|---|---|---|---|---|---|---|---|
| `content/pure/触手-漫画设定-纯爱.md` | 140 | 11885 | 2 | 20 | 0 | 56 | 0 | 0 | 无 |
| `content/pure/触手-角色提示词-纯爱.md` | 158 | 14313 | 6 | 13 | 6 | 88 | 0 | 0 | 无 |
| `content/pure/触手-语料库-纯爱.md` | 89 | 6353 | 0 | 7 | 0 | 0 | 0 | 0 | 无 |

约定推断：`角色提示词` 是结构化程度最高的文件（最多标题层级/列表），`漫画设定` 是设定条目，`语料库` 是分主题段落（无列表）。三者均无 frontmatter/表格/代码块，说明运行时不做字段解析；实际只有「角色提示词」被整段拼进系统提示词（§5.2）。本笔记不摘录其中任何内容，`content/pure/*.md` 只当数据。

### 5.7 DLC 机制的坑

1. **档位永远写成「中」**：`backend/main.py:650` 与 `backend/main.py:656` 都传 `level="中"`；但 README 声称 DLC2「品评会·调教」是**重**档（`README.md:61`、`README.md:87`），且本体 `config/character.example.yaml:43-53` 里注释掉的品评会块写的也是 `level: 中`。导入 DLC2 后实际显示「调教（中）」，与「重」的设定不一致。
2. **全新安装导入 DLC 会改写示例模板**：`character.yaml` 不存在时 `load_config` 把 `cfg["character_file"]` 改成 `config/character.example.yaml`（`backend/config.py:150-157`），而导入逻辑直接用这个路径落盘（`backend/main.py:628-631`）→ 首次导入会把「示例模板」当用户配置改掉（之后用户按 README 再 copy 示例时，拿到的已经是被 DLC 改过的文件）。
3. 无删除/卸载 DLC 的 UI；覆盖写已有同名文件（`backend/main.py:610-617`）；无内容校验/签名/大小清单；导入的 md 不检查编码（写 bytes）。
4. 18+ 门槛只有文字免责声明（`README.md:48-55`）与单独 DLC 仓库（`README.md:11-18`），没有年龄校验/内容分级开关。

---

## 6. 启动编排

### 6.1 源码模式：仓库根 `start.bat`（3 步 + 1 个可选）

| 顺序 | 动作 | 端口 | 证据 |
|---|---|---|---|
| 0（可选） | 检测 11434 是否已监听；否则若 `..\ollama\ollama.exe` 存在则启动本地视觉模型 | 11434 | `start.bat:18-30` |
| 1 | 找 Bun（`%APPDATA%\npm\...\bun.exe`，否则 PATH 里的 `bun`），找不到就报错 pause 退出 | — | `start.bat:6-16` |
| 2 | 新窗口启动中继：`cd relay && bun run v4-server.ts` | 9998 | `start.bat:32-33` |
| 3 | 新窗口启动主程序：`python -m backend.main`（要求已 `pip install -r requirements.txt`） | 8000 | `start.bat:35-36` |
| 4 | `timeout /t 4` 后 `start http://127.0.0.1:8000` 开默认浏览器 | 8000 | `start.bat:38-40` |

- 失败处理很薄：只有「找不到 Bun」有明确错误分支；Python 缺依赖/端口占用时后端窗口里就是 traceback，脚本不检测、不重试（`start.bat:35-36`、`start.bat:42-45`）。
- 「关闭对应的命令行窗口即可停止程序」——没有进程树管理，关错窗口会留下孤儿（`start.bat:43`）。

### 6.2 发布模式：壳 exe 静默启动（推荐路径）

见 §3.1：壳依次起中继→后端→等就绪→开窗口；全链路 `CREATE_NO_WINDOW`，无命令行窗口（`desktop/shell.py:22`、`desktop/shell.py:80-94`）。产物里的 `start.bat` 是另一套模板（由构建脚本生成）：优先用包内 `bun.exe`，中继窗口最小化，后端窗口标题 `AI-for-Coyote`，3s 后开浏览器（`packaging/build_release.py:41-69`）。

### 6.3 端口与防火墙

| 端口 | 谁监听 | 绑定 | 证据 |
|---|---|---|---|
| 8000 | FastAPI 后端 | 默认 `127.0.0.1`（配置可改） | `config/config.example.yaml:4-6`、`backend/config.py:31-36`、`run_app.py:26-31` |
| 9998 | Bun 中继（v4） | **`hostname:'::'`（所有网卡）** | `relay/v4-server.ts:462-473`、`relay/README.md:9-12` |
| 9999 | Bun 中继（v3，本产品未用） | 同上（默认） | `relay/README.md:11-12` |
| 11434 | 可选 Ollama | 由 Ollama 自己决定 | `start.bat:18-30` |
| 5173 | Vite 开发服务器（仅开发） | localhost | `frontend/vite.config.ts:6-12` |

- 手机必须能访问 9998：中继监听 `::` 是必要的；但**没有任何自动防火墙规则**——`start.bat`/壳/安装器都不执行 netsh，README 只教用户在扫不上时手动加规则（`README.md:154-156`）。首次运行大概率弹 Windows 防火墙对话框（Bun.exe）。
- 后端默认只绑 127.0.0.1，手机不访问 Web 控制台；如果用户把 `app.host` 改成 `0.0.0.0`，控制台会在局域网无鉴权暴露（见 §8.3）。
- 中继没有身份鉴权：控制方（后端）连接即拿 `clientId`，被控方（手机）凭 `tid` 接入，而 `tid` 就明文展示在页面配对 URL 与二维码里（`relay/v4-server.ts:441-457`、`backend/main.py:84-90`）；局域网内任何人都能连中继，拿到页面/二维码即可冒充被控方接入。

### 6.4 失败处理对照

| 场景 | 源码 start.bat | 发布壳 exe |
|---|---|---|
| 缺 Bun | 报错 + pause + exit 1 | MessageBox「找不到 bun.exe…请重新安装完整包」后退出（`desktop/shell.py:137-140`） |
| 缺 Python 依赖 | 后端窗口 traceback，无提示 | 通常不触发（依赖已打进 onefile） |
| 端口被占 | 后端窗口启动失败 | 静默复用已有服务（`desktop/shell.py:135-147`） |
| 后端 30s 未就绪 | 浏览器打开后 502/无响应 | MessageBox + 日志路径提示（`desktop/shell.py:148-151`） |
| 缺 WebView2 | 用浏览器，无影响 | MessageBox + 下载链接（`desktop/shell.py:164-169`） |
| 关窗/关错窗口 | 孤儿进程 | 进程树 taskkill（`desktop/shell.py:111-124`） |

---

## 7. 安全 UX

### 7.1 长按空格急停：实现位置与时长

- 判定时长：`ESTOP_HOLD_MS = 1000`，注释「与进度条动画同步」（`frontend/src/App.tsx:14-15`）。
- 监听在**前端页面**：`document.addEventListener("keydown"/"keyup")` + `window blur`；输入框/文本域内不劫持空格；`e.repeat` 忽略；已急停时不再触发；松手/失焦调用 `cancelHold()`（`frontend/src/App.tsx:91-111`）。
- 长按 1s 到点执行 `doEstop()`：`POST /api/estop` → 成功后往聊天流写系统消息「⚠ 急停：全部清零、波形停止、AI 循环暂停」；请求失败也写（状态由 WS 刷新）（`frontend/src/commands.ts:39-46`）。
- 进行中 UI：底部居中浮层「急停中… 松开取消」+ 1s 线性填充条（`frontend/src/App.tsx:145-163`），动画 keyframes 在 `frontend/src/styles.css:73-81`。
- 另有两条**立即触发**路径（无需长按）：左栏「急停（长按空格）」红色按钮（`frontend/src/components/Sidebar.tsx:55`）与底栏中央 ⏸ 圆钮（`frontend/src/components/BottomBar.tsx:28-36`）。

### 7.2 急停后行为（后端）

- `SafetyManager.estop()`：置 `estop_active=True`、清 A/B current、清波形计时（`backend/safety.py:238-244`）。
- `GameLoop.estop()`：停掉所有循环波形任务、清 `patterns`、下发 clear+stop 帧（dry-run/未连接时不发）（`backend/game_loop.py:697-709`）。
- 急停期间**一切设备动作被拒**：`validate()` 在 op 分发前直接返回「急停中，拒绝一切设备动作」，连 `stop` 也被拒（`backend/safety.py:93-96`）。
- AI 循环不销毁但跳过：观察循环与自动运行循环都检查 `estop_active`（`backend/game_loop.py:246-250`、`backend/game_loop.py:316-320`）。
- 解除：`POST /api/resume` → `safety.resume()` 清标志（`backend/main.py:407-411`、`backend/game_loop.py:711-713`、`backend/safety.py:246-248`）。
- UI 侧：顶栏徽章变红「急停: 已触发」；预设面板顶部红条「急停中：所有设备动作被拒绝。点『解除急停』恢复（焦点不在输入框时长按空格 1 秒触发急停）」；底栏圆钮变 ▶（`frontend/src/components/TopBar.tsx:45`、`frontend/src/components/PresetPanel.tsx:30-34`、`frontend/src/components/BottomBar.tsx:29-36`）。

### 7.3 「带外急停」的关键限制

**空格急停不是带外热键**：它绑定在页面 `document` 上（`frontend/src/App.tsx:109-111`），只有控制台窗口/页面拥有键盘焦点时才有效；用户切到游戏/其他窗口后长按空格不会触发。底栏文字「空格 = 急停」也没有提示这一前提（`frontend/src/components/BottomBar.tsx:37-40`）。这一点与旧分析的判断相反（见 §8.7）。

### 7.4 强度上限的 UI 展示与手动开关

- 卡片显示「当前 / 上限」，上限数字可点开滑杆（1~**硬上限**），范围来自后端 `caps`（配置，默认 200，且 `load_config` 会再 clamp 到 ≤200）（`frontend/src/components/ChannelControl.tsx:72-76`、`backend/config.py:160-162`、`backend/safety.py:28-33`）。
- 「用户上限」初始为 `min(100, 硬上限)`（即开箱显示 100/200），滑杆最大仍是 200，文案「上限可调」（`backend/safety.py:32-33`、`frontend/src/components/ChannelControl.tsx:143-145`、`frontend/src/components/ChannelControl.tsx:152-157`）。
- 上限调低后，后端会立即把高于新上限的当前强度用 `hold_strength` 压下来（`backend/main.py:489-498`）；但**急停期间这条补偿动作会被安全层拒绝**（`backend/safety.py:95-96`）。
- 通道手动开/关按钮在通道卡右上角，关闭即清零该通道并拒绝后续动作，同时持久化到 `config/device_channels.yaml`；关闭态卡片降透明 + 红边（`frontend/src/components/ChannelControl.tsx:119-132`、`frontend/src/components/ChannelControl.tsx:99-105`、`backend/main.py:432-445`、`backend/safety.py:117-129`、`backend/config.py:212-241`）。
- 过热没有独立徽章：设备上报 `comfortLimit.overheat` 后只体现为「该通道上限降到 20」（可视效果=上限数字变小）（`backend/safety.py:300-312`、`backend/safety.py:66-70`）。

### 7.5 持久化矩阵（重启后哪些保留）

| 项 | 是否持久化 | 证据 |
|---|---|---|
| 角色/风格选择 | 是（`character_runtime.yaml`） | `backend/config.py:319-320`、`backend/config.py:494-511` |
| 玩家昵称 | 是（同上） | `backend/config.py:494-511` |
| 配件名/位置/基准、通道开关 | 是（`device_channels.yaml`，首次保存才创建） | `backend/config.py:212-241`、`backend/main.py:440-443` |
| 用户强度上限（1~200） | **否**，重启回 100 | `backend/safety.py:32-33`、`backend/main.py:483-486` 注释 |
| 摄像头/麦克风开关 | **否**，重启跟配置 `camera/audio.enabled` | `backend/main.py:121-125`、`backend/main.py:449` 注释 |
| 自动运行开关 | 跟配置 `autopilot.enabled`（默认 false），运行中改了不写盘 | `backend/config.py:97-98`、`backend/game_loop.py:296-307` |
| 清空的历史/聊天记录 | 内存，重启即空 | `backend/game_loop.py:130-133` |
| LLM Key/URL/模型 | 是（写 `config.yaml`，或环境变量优先） | `backend/main.py:751-778`、`backend/config.py:145-148` |
| DLC 内容 | 是（`content/pack/` + 改 `character.yaml`） | `backend/main.py:610-673` |

### 7.6 其他安全 UX 事实

- 默认配置模板 `dry_run: false`（`config/config.example.yaml:8`），而代码内置默认是 `true`（`backend/config.py:33`）——用户一旦按 README `copy config.example.yaml config.yaml`，就处于「真机可动作」状态，README 虽建议先 dry_run 联调（`README.md:133`），但模板本身给的是 false，属于易踩的脚枪。
- 无安全词口令：README 明说不设（`README.md:165`），`types.ts` 里的 `safeword` 字段是历史残留。
- 断连自动清零：配置 `safety.auto_clear_on_disconnect: true`；App 断开时取消循环波形并 `record(stop)`（不置急停标志），程序退出时若该配置为真则调用 loop.estop（`config/config.example.yaml:40`、`backend/main.py:159-161`、`backend/game_loop.py:715-719`、`backend/main.py:303-305`）。
- 急停/状态只在本机可见（后端 127.0.0.1），中继在局域网裸奔（见 §6.3）。

---

## 8. 产品级取舍与弱点（全部基于代码证据）

### 8.1 三语言运行时 + 第四方 WebView2

- Python（FastAPI/uvicorn）是主程序（`requirements.txt:1-9`、`run_app.py:17-31`）；Bun 跑中继（`relay/package.json` 的 `packageManager: bun@1.3.14`、`relay/README.md:9-12`）；Node 只用于前端构建（`frontend/package.json:6-10`、`.github/workflows/release.yml:31-33`）；运行时还要系统 WebView2（`desktop/shell.py:164-169`）。
- 结果：发布包必须自带 `bun.exe`（`packaging/build_release.py:218`），体积与攻击面都增加；构建机需要 Python+Node+Bun 三套工具链（`.github/workflows/release.yml:18-36`）。

### 8.2 体积 / 启动 / 发布形态

- 两个 PyInstaller `--onefile`（后端+壳）：首次启动都要解压到临时目录（`packaging/build_release.py:157`、`packaging/build_release.py:181`）；壳再带 `--collect-all webview/pywebview`（`packaging/build_release.py:187-188`）。
- 构建时显式安装 `opencv-python`（`packaging/build_release.py:131`、`.github/workflows/release.yml:36`），而摄像头默认关闭（`config/config.example.yaml:50-55`）；PyInstaller 的静态分析能发现 `backend/camera.py:42-43` 的函数内 `import cv2`，因此即使默认不用摄像头，cv2（含 numpy 依赖）也很可能被收进 onefile，带来体积与首启解压成本。
- 前端 2 张头像 PNG 共约 1.26 MB 直接进 dist（`frontend/src/assets/`；`frontend/src/roleTheme.ts:3-10`）。
- 无更新机制（§4.4）、无代码签名、CI 注释自认 Defender 误报（`.github/workflows/release.yml:43-46`）。

### 8.3 认证 / 网络暴露 / 隐私

- 后端 API 与 WS **没有任何 token/鉴权**（`backend/main.py:310-325` 的 `make_app` 无 middleware；全仓库无 token 校验），默认只绑 127.0.0.1（`config/config.example.yaml:4-6`、`backend/config.py:31-32`）。
- 中继监听所有网卡且无鉴权（`relay/v4-server.ts:462-473`）；`/ws` 也不校验 Origin（`backend/main.py:806-819`）——若把后端绑定改到局域网，任何同网段设备都能读状态、发手动动作、触发急停。
- FastAPI 默认 `/docs`、`/openapi.json` 未关（`backend/main.py:313`），加剧上述风险。
- API Key 明文写 `config.yaml`（`backend/main.py:739-740`），仅在读接口回显掩码（`backend/main.py:711-722`）；无系统凭据库。
- 无审计：只有 `logs/app.log` 等文本日志（`backend/config.py:173-176`），没有操作级 append-only 记录；旧分析也指出过「审计=无」（`项目分析-AI-for-Coyote.md:104`）。

### 8.4 配置摩擦

- 摄像头/麦克风/安全上限/波形改 YAML 后需重启（设置页自己也写明：`frontend/src/components/views.tsx:67-71`）；LLM 配置与角色设定是热加载（`backend/main.py:751-778`、`backend/game_loop.py:139`）。
- 很多可调项只存在于代码默认值、没有进示例配置：`autopilot.interval_s`、`ui.*`、`camera.dark_threshold`、`audio.silence_timeout_s`、`app.sensor_idle_timeout_s` 都不在 `config/config.example.yaml`（`backend/config.py:29-104` vs `config/config.example.yaml:1-71`）。
- 死配置：`ui.quick_strengths`、`ui.default_temp_s`、`ui.default_pulse_s` 下发给前端但 UI 不用（`backend/config.py:67-73`、`frontend/src/types.ts:84` 只有类型；grep 无组件消费）；强度的「快捷按钮」实际是 ±10（`frontend/src/components/ChannelControl.tsx:180-182`）。
- 文档说 `device_channels.yaml`「首次运行自动生成」（`README.md:136`），实际只有 UI 保存时才写盘（`backend/config.py:184-209` vs `backend/config.py:212-241`）。

### 8.5 内容治理

- 内容即纯文本 md，无签名/校验/版本（§5.7）；DLC 导入会覆盖同名文件；无卸载入口；导入即改 `character.yaml`（`backend/main.py:610-673`）。
- 档位被强制为「中」，导致 README 的「DLC2=重」在实现上不成立（§5.7 第 1 条）。
- 内容随「本体 UI 主题」解耦不彻底：品评会的头像/配色在本体前端里（`frontend/src/roleTheme.ts:7-10`、`frontend/src/roleTheme.ts:34-42`），新角色只能吃「首字块」。
- 成人内容只靠 README 免责声明与独立仓库区分（`README.md:48-61`），程序内无年龄门槛。

### 8.6 README / 注释 vs 代码：漂移清单（可直接给 Lead 引用）

| # | 文档声称 | 代码事实 | 证据 |
|---|---|---|---|
| 1 | 控制台含「强度修正（50%~150%）」 | 已在 661ffed 删除，HEAD 无此控件 | `README.md:34`、`README.md:162` vs `frontend/src/components/ChannelControl.tsx:180-195` |
| 2 | 「聊天：左侧与 AI 对话」 | HEAD 无输入框，`/api/chat` 无前端调用方 | `README.md:160` vs `frontend/src/components/ChatPanel.tsx:64-174`、`frontend/src/api.ts:31` |
| 3 | 「麦克风：faster-whisper…首次运行下载 whisper 模型」 | HEAD 麦克风只测音量、明确不识别内容；代码无 faster_whisper | `README.md:112`、`config/config.example.yaml:57-59` vs `backend/audio.py:1-7` |
| 4 | 「自动运行：顶部开关」 | 开关在中栏底部 | `README.md:163` vs `frontend/src/components/ChatPanel.tsx:154-172` |
| 5 | 当前角色「触手（纯爱/调教两种风格）」 | HEAD 已是「角色 × 三档风格」模型，且有品评会主题资源 | `README.md:3` vs `backend/config.py:393-455`、`frontend/src/roleTheme.ts:7-42` |
| 6 | 「波形（可选时长与通道，持续波形可循环）」 | UI 无时长选择、通道用焦点隐式决定 | `README.md:161` vs `frontend/src/components/PresetPanel.tsx:22-25` |
| 7 | AI 指令协议只列 5 种 op | 实际 7 种（含 `hold_strength`/`pulse_hold`） | `README.md:182-190` vs `backend/safety.py:17`、`backend/llm.py:64-66` |
| 8 | `device_channels.yaml` 首次运行自动生成 | 首次 UI 保存才生成 | `README.md:136` vs `backend/config.py:184-241` |
| 9 | DLC2 品评会=重（凌辱） | 导入代码强制 level=中 | `README.md:61`、`README.md:87` vs `backend/main.py:650`、`backend/main.py:656`、`config/character.example.yaml:50` |
| 10 | 脚本头注释称输出 `build_release/AI-for-Coyote-v<版本>.zip` | 实际输出 `Coyote-in-Cradle-v<版本>.zip`；且本地脚本只生成 .iss，setup.exe 由 CI 的 Inno 步骤编译 | `packaging/build_release.py:11-12`、`packaging/build_release.py:233`、`packaging/build_release.py:238-245`、`.github/workflows/release.yml:52-57` |

### 8.7 旧分析（`项目分析-AI-for-Coyote.md`）需修正 / 过时处

1. **【旧分析 §2.4，第 65、68 行】「麦克风 faster-whisper → 文本；玩家说的话通过麦克风转写」已过时**：HEAD 的 `backend/audio.py:1-7` 明确「只测音量大小，不识别内容（用户决定，玩家语音内容不被 AI 引用）」，全仓库无 faster-whisper 代码（仅 README/config 注释与打包 exclude 残留）。旧分析据此推出的「STT 可能比视觉更刚需」判断需撤回或改写为「作者主动砍掉了 STT」。
2. **【旧分析 §2.3，第 57-61 行】「空格长按是焦点无关的带外急停 / 前台焦点在游戏窗口时也有效」不成立**：实现是前端 `document` keydown（`frontend/src/App.tsx:92-111`），窗口失焦即取消（`frontend/src/App.tsx:108-111`），控制台无焦点时不响应。
3. **【旧分析 §2.5，第 82 行】「或页面的按钮」不存在**：HEAD 前端没有反馈按钮组件（`frontend/src/**` 无 feedback 相关实现）；反馈只来自 App 上报 `custom.action`（`backend/relay_client.py:185-190`、`backend/game_loop.py:722-724`）。
4. **【旧分析 §2.4，第 67 行】「画面变黑或没人 → 怒气」措辞不准**：怒气只由「画面平均亮度低于阈值（dark）」或「麦克风持续无声」触发（`backend/game_loop.py:63-74`、`backend/camera.py:22`）；「没人/表情」是视觉模型描述，不进 `rage_rounds`。
5. **【旧分析 §2.6，第 88-89 行】可选依赖描述过时**：麦克风只需要 `sounddevice`（缺它才禁用），faster-whisper 已不再是依赖（`backend/audio.py:57-74`、`requirements.txt:1-9`）。
6. 旧分析未覆盖产品面（壳、打包、DLC 导入实现、UI、WS、文档漂移），本笔记补足；旧分析对传输/安全层的判断（SocketAPI v4 中继价值、comfortLimit/overheat、AddIntensity 实测结论、步长/时长/过热/断连四层安全、7 种 op）在 HEAD 仍成立，不重复展开。
7. 旧分析把「聊天/UI 使用方式」默认成 README 描述（如「聊天」左栏），实际 HEAD 是自动运行优先的控制台——任何引用 README 使用说明的结论都要先对代码复核。

### 8.8 工程化缺口

- CI 只构建、不测试：`.github/workflows/release.yml` 无 test/lint 步骤；仓库无 `tests/`；`frontend/package.json:6-10` 无 test 脚本。
- 无类型/接口契约测试：`safeword` 漂移、`/api/pair_url`/`/api/chat` 死端点都是例证（§2.2、§2.6）。
- 打包脚本无校验步骤（zip 组装后不 check 文件存在/大小），`build_release.py` 里只有 `copytree/copy2` 直接抛异常兜底（`packaging/build_release.py:193-236`）。
- 壳与后端契约靠硬编码 URL/端口（§3.3），没有共享配置或健康检查版本号。
- GPL-3.0：包内附带 `LICENSE` 与 `relay/LICENSE`（`packaging/build_release.py:219-227`），中继来自第三方 GPL 项目（`README.md:60`）；本笔记只做引用与描述，不搬运源码。

---

## 9. 证据表（关键结论 → 文件:行号）

| # | 结论 | 证据 |
|---|---|---|
| 1 | 长按空格急停时长 1000ms，进度条动画同源 | `frontend/src/App.tsx:14-15`、`frontend/src/App.tsx:145-163`、`frontend/src/styles.css:73-81` |
| 2 | 空格急停绑定在页面 document，输入框/失焦会取消 → 非全局热键 | `frontend/src/App.tsx:92-111` |
| 3 | 急停期间安全层拒绝一切动作（含 stop） | `backend/safety.py:93-96` |
| 4 | 急停=清 A/B、清波形、停循环任务；resume 清标志 | `backend/safety.py:238-248`、`backend/game_loop.py:697-713` |
| 5 | 急停 UI 三处冗余：顶栏徽章/预设红条/底栏圆钮 | `frontend/src/components/TopBar.tsx:45`、`frontend/src/components/PresetPanel.tsx:30-34`、`frontend/src/components/BottomBar.tsx:28-36` |
| 6 | 用户上限默认 min(100,硬上限)，硬上限配置 200，不持久化 | `backend/safety.py:28-33`、`backend/config.py:160-162`、`backend/main.py:483-486` |
| 7 | 上限调低会立刻用 hold_strength 压当前强度 | `backend/main.py:489-498` |
| 8 | 通道手动开关持久化到 device_channels.yaml，关闭即清零 | `backend/main.py:432-445`、`backend/safety.py:117-129`、`backend/config.py:212-241` |
| 9 | 传感器开关/通道上限不持久化，重启回默认 | `backend/main.py:121-125`、`backend/main.py:449` |
| 10 | 三栏宽度公式与不可拖拽 | `frontend/src/store.ts:48-78` |
| 11 | 全局缩放 0.8~1.3（CSS zoom） | `frontend/src/App.tsx:22-33`、`frontend/src/App.tsx:122` |
| 12 | WS 路径 /ws、2s 固定重连、消息 type=state/chat | `frontend/src/App.tsx:70-90`、`backend/main.py:806-819`、`backend/main.py:190-199` |
| 13 | 无聊天输入框；/api/chat 无前端调用方 | `frontend/src/components/ChatPanel.tsx:64-174`、`frontend/src/api.ts:29-31` |
| 14 | 强度修正 50%~150% 已在 661ffed 移除，README 仍写 | `README.md:34`、`README.md:162`；commit `661ffed` |
| 15 | 自动运行开关在聊天栏底部，连带启停传感器 | `frontend/src/components/ChatPanel.tsx:154-172`、`backend/main.py:698-705` |
| 16 | A/B 联动=同一动作对两通道各发一次 | `frontend/src/components/ChannelControl.tsx:29-41`、`frontend/src/commands.ts:5-8` |
| 17 | 通道卡显示「当前/上限」+ 上限浮窗（1~硬上限） | `frontend/src/components/ChannelControl.tsx:134-165` |
| 18 | 设备状态卡传感器按钮三态（灰/绿/橙） | `frontend/src/components/DeviceStatus.tsx:61-102` |
| 19 | 配对二维码由后端生成 PNG；前端 <img> 引用 | `backend/main.py:346-358`、`frontend/src/components/ChatPanel.tsx:95` |
| 20 | 配对 URL 格式（dungeon-lab.cn/s/?v=1&action=socket&url=ws://IP:9998?tid=） | `backend/main.py:84-90` |
| 21 | 配对成功后 3s AI 主动开场 | `backend/main.py:164-169`、`frontend/src/components/ChatPanel.tsx:112` |
| 22 | 中继监听所有网卡、端口 9998、路径前缀可配 | `relay/v4-server.ts:462-473`、`relay/v4-server.ts:378-405`、`relay/README.md:9-12` |
| 23 | 中继无鉴权：控制方连接即得 clientId，被控方凭 tid 接入 | `relay/v4-server.ts:441-457`、`backend/relay_client.py:1-9` |
| 24 | 后端默认 127.0.0.1:8000，API/WS 无鉴权、无 CORS 中间件 | `config/config.example.yaml:4-6`、`backend/main.py:310-325`、`backend/main.py:806-819` |
| 25 | FastAPI 默认 /docs 未关闭 | `backend/main.py:313` |
| 26 | 静态资源托管：GET / 返回 dist/index.html；/assets 存在才挂载 | `backend/main.py:328-340` |
| 27 | 壳：1440×900/最小 1100×700、单实例 mutex、30s 探测、关窗 taskkill | `desktop/shell.py:23-25`、`desktop/shell.py:55-59`、`desktop/shell.py:97-108`、`desktop/shell.py:111-124`、`desktop/shell.py:152-172` |
| 28 | 壳不托管页面，仅打开 127.0.0.1:8000；端口若被占用则复用不启动 | `desktop/shell.py:135-147`、`desktop/shell.py:158` |
| 29 | 打包：前端 build + venv + 两个 onefile PyInstaller + 组装 + zip + 生成 iss | `packaging/build_release.py:106-251` |
| 30 | 产物包含 bun.exe/relay 源码/config 模板/content/pure/frontend dist/version.txt | `packaging/build_release.py:193-230` |
| 31 | 安装器 per-user、lzma2、快捷方式、LicenseFile=说明.txt | `packaging/installer.iss:1-27` |
| 32 | CI：tag v* 触发，Node/Bun/Python，build_release --ci，choco 安装 Inno 编译 setup，上传 release；无测试步骤 | `.github/workflows/release.yml:3-7`、`.github/workflows/release.yml:31-50`、`.github/workflows/release.yml:52-66` |
| 33 | 无自动更新/版本检查；version.txt 只用于展示 | `packaging/build_release.py:230`、`backend/main.py:50-57`、`frontend/src/components/views.tsx:50-56` |
| 34 | DLC 导入：扩展名/空/50MB 校验 | `backend/main.py:557-565` |
| 35 | DLC zip 中文名 cp437→UTF-8 修复；只收 .md；按 DLC 目录分组 | `backend/main.py:577-603` |
| 36 | DLC 单 md 从文件名解析主题；落盘跳过 ..（防穿越） | `backend/main.py:604-617` |
| 37 | DLC 自动接线：reload → 改 character.yaml 的 prompt_file；已存在角色强制 level=中 | `backend/main.py:621-673`、`backend/main.py:650` |
| 38 | 新角色自动注册 role 块（level 固定中） | `backend/main.py:653-658`、`backend/config.py:607-654` |
| 39 | 未装 DLC 三道拦截：available 计算、前端禁用、后端 400 dlc_missing | `backend/config.py:353-359`、`backend/config.py:438-445`、`frontend/src/components/RoleCard.tsx:177-204`、`backend/main.py:526-533` |
| 40 | 只有「角色提示词」被运行时读取；语料库/漫画设定无读取点 | `backend/config.py:460-463`、`backend/llm.py:25-55` |
| 41 | 全新安装无 character.yaml 时回退 character.example.yaml，导致导入 DLC 会改写示例模板 | `backend/config.py:150-157`、`backend/main.py:628-631` |
| 42 | 品评会头像/描边随本体前端预置；新角色回退首字块 | `frontend/src/roleTheme.ts:7-10`、`frontend/src/roleTheme.ts:34-42`、`frontend/src/components/RoleCard.tsx:128-132` |
| 43 | roleTheme 的 STYLE_LABELS/STYLE_DESCS/styleDesc 是死代码 | `frontend/src/roleTheme.ts:44-57` |
| 44 | 源码启动 3 步：bun 检查→中继 9998→后端 8000→4s 后开浏览器；可选 Ollama 11434 | `start.bat:6-40` |
| 45 | 发布壳启动顺序：中继→后端→探测→开窗；无自动防火墙规则 | `desktop/shell.py:134-169`、`README.md:154-156` |
| 46 | 源码 start.bat 无防火墙规则，只有 README 教用户 netsh 放行 9998 | `start.bat:32-40`、`README.md:155-156` |
| 47 | 前端主题色/字体/滚动条/急停动画集中在 styles.css | `frontend/src/styles.css:3-20`、`frontend/src/styles.css:38-81` |
| 48 | 设置页可热改 LLM Key/地址/模型并测试；Key 回显掩码 | `frontend/src/components/views.tsx:139-194`、`backend/main.py:751-803` |
| 49 | 麦克风只做电平分级（high/low），不识别内容 | `backend/audio.py:1-7`、`backend/audio.py:132-146` |
| 50 | 摄像头可选依赖 opencv；画面黑暗阈值判定 | `backend/camera.py:1-5`、`backend/camera.py:42-47`、`backend/camera.py:22` |
| 51 | 怒气只由黑屏或持续无声触发 | `backend/game_loop.py:63-74` |
| 52 | AI 指令 7 种 op；README 只列 5 种 | `backend/safety.py:17`、`backend/llm.py:64-66`、`README.md:182-190` |
| 53 | 无审核/审计：只有日志目录 | `backend/config.py:173-176`、`backend/main.py:98` |
| 54 | GPL-3.0，包内附 LICENSE 与 relay/LICENSE | `LICENSE`、`relay/LICENSE`、`packaging/build_release.py:219-227`、`README.md:59-61` |
| 55 | 旧分析「麦克风转写」在 HEAD 已过时 | `backend/audio.py:1-7` vs `项目分析-AI-for-Coyote.md:65-68` |
| 56 | 旧分析「带外空格急停」不成立 | `frontend/src/App.tsx:92-111` vs `项目分析-AI-for-Coyote.md:57-61` |

---

## 10. 架构图素材（产品面）

> 给 Lead 画图用：只写「谁加载谁 / 谁向谁发请求 / 端口与路径 / 打包产物」，不含业务算法。

### 10.1 进程与组件（矩形节点）

| 节点 | 进程/载体 | 启动者 | 关键职责 | 证据 |
|---|---|---|---|---|
| **WebView2 页面** | `msedgewebview2.exe`（pywebview 内嵌）/ 或外部浏览器 | 壳 exe / 用户 | 渲染 React 控制台；同源 fetch `/api/*`；WS `/ws` | `desktop/shell.py:152-163`、`frontend/src/App.tsx:70-90` |
| **Shell（桌面壳）** | `Coyote-in-Cradle.exe`（PyInstaller onefile + pywebview） | 用户双击 / 安装器快捷方式 | 单实例、启动中继与后端、等 `/api/state` 就绪、开窗、关窗杀进程树 | `desktop/shell.py:127-172` |
| **Backend（主程序）** | `AI-for-Coyote.exe`（PyInstaller onefile，uvicorn+FastAPI） | 壳 或 start.bat/`python -m backend.main` | 托管 dist（GET `/`、`/assets/*`）；REST API + WS `/ws`；生成二维码；连中继 WS；调 LLM；采集摄像头/麦克风 | `backend/main.py:43-47`、`backend/main.py:328-340`、`backend/main.py:806-819` |
| **Relay（中继）** | `bun.exe run relay/v4-server.ts` | 壳 或 start.bat | 控制方（后端）↔ 被控方（手机）WS Relay；心跳/空闲超时 | `desktop/shell.py:136-141`、`relay/v4-server.ts:462-477` |
| **Phone App** | DG-LAB 4.0 App（第三方） | 用户扫码 | 作为被控方接入中继；经 BLE 控郊狼 A/B | `backend/main.py:84-90`、`README.md:149-154` |
| **Device** | 郊狼主机（A/B 通道） | App BLE | 输出强度/波形 | `README.md:23-26` |
| **LLM API** | OpenAI 兼容 HTTP 服务 | 后端调用 | 台词+结构化动作+视觉描述 | `backend/llm.py:246-360`、`backend/main.py:780-803` |
| **构建链（非运行态）** | Node（Vite）+ Bun + Python（PyInstaller/pip）+ Inno Setup（CI） | CI / 开发者 | 产出 zip/setup.exe | `.github/workflows/release.yml:18-57`、`packaging/build_release.py:106-251` |

### 10.2 连接矩阵（有向边）

| 从 → 到 | 协议/地址 | 时机 | 证据 |
|---|---|---|---|
| WebView/浏览器 → Backend | HTTP `http://127.0.0.1:8000/`、`/api/*`（同源） | 页面加载与交互 | `desktop/shell.py:158`、`frontend/src/api.ts:8-21`、`frontend/src/api.ts:29-90` |
| WebView/浏览器 → Backend | WS `ws://127.0.0.1:8000/ws`（https 则 wss） | 页面挂载即连，断线 2s 重连 | `frontend/src/App.tsx:75-76` |
| Backend → WebView | WS 服务端推送 `{"type":"state"}` / `{"type":"chat"}` | 状态变化、AI 主动回合 | `backend/main.py:179-199` |
| Shell → Backend | HTTP GET `/api/state` 轮询 0.5s×30s | 启动时等就绪 | `desktop/shell.py:25`、`desktop/shell.py:97-108` |
| Shell → Relay | 子进程 `bun.exe run v4-server.ts`（cwd relay） | 启动时 9998 空闲才启动 | `desktop/shell.py:136-141` |
| Shell → Backend | 子进程 `AI-for-Coyote.exe`（或 `python -m backend.main`） | 启动时 8000 空闲才启动 | `desktop/shell.py:142-147` |
| Backend → Relay | WS `ws://127.0.0.1:9998`（作为控制方） | 常驻任务，断线 3s 重连 | `backend/main.py:101-106`、`backend/relay_client.py:92-113`、`backend/config.py:37` |
| Relay → Phone App | WS（App 扫码连 `ws://<局域网IP>:9998?tid=<controllerId>`） | 用户扫码配对 | `backend/main.py:84-90`、`relay/v4-server.ts:445-457` |
| Relay → Backend | WS 上行 `hello/client_attached/devices.snapshot/slots.patch/custom.action/message` | 配对与设备状态 | `backend/relay_client.py:1-9`、`backend/relay_client.py:123-197` |
| Backend → Relay | WS 下行 `{"type":"message","clientId":..,"data":{t:"req",m:"device.op..."}}` | 设备动作 | `backend/device_ops.py:5-12`、`backend/device_ops.py:26-35` |
| Backend → LLM | HTTPS `{base_url}/chat/completions`（Bearer api_key） | 每回合/测试连接 | `backend/main.py:780-803`、`backend/llm.py:268-300` |
| Backend → Camera/Mic | 本机 opencv / sounddevice | 自动运行开启且传感器开 | `backend/camera.py:39-70`、`backend/audio.py:57-74` |
| App → Device | BLE（第三方 App 内部） | 配对后 | `README.md:149-154` |

### 10.3 页面/静态资源路线（HTTP 视角）

1. 壳/浏览器请求 `GET http://127.0.0.1:8000/` → 后端若 `frontend/dist/index.html` 存在则返回它，否则返回「前端尚未构建」纯文本（`backend/main.py:328-336`）。
2. `GET /assets/*` → 由 FastAPI `StaticFiles` 托管 Vite 产物（仅在目录存在时挂载）（`backend/main.py:339-340`）。
3. 前端 JS/CSS 由 `frontend/src/main.tsx:1-10` 引入；构建 outDir=`dist`（`frontend/vite.config.ts:13`）。
4. 所有 API 请求都是**同源相对路径**（`frontend/src/api.ts:8-21`），无跨域配置；开发模式由 Vite 代理 `/api`、`/ws`（`frontend/vite.config.ts:7-11`）。
5. 二维码图片：`<img src="/api/qrcode.png">`，后端用 qrcode 库现场生成 PNG（`frontend/src/components/ChatPanel.tsx:95`、`backend/main.py:346-358`）。

### 10.4 打包产物（画「发布物」盒子时用）

- 免装包：`Coyote-in-Cradle-v<ver>/` → `Coyote-in-Cradle.exe`（壳）+ `AI-for-Coyote.exe`（后端）+ `bun.exe`（中继运行时）+ `relay/`（TS 源码）+ `frontend/dist/` + `config/`（3 个模板）+ `content/pure/`（3 个 md）+ `start.bat`/`说明.txt`/`version.txt`/`LICENSE`/`setup.ico`（`packaging/build_release.py:193-230`）。
- 安装包：Inno Setup 把上述目录装到 `%LOCALAPPDATA%\Programs\Coyote in Cradle`，per-user 无需管理员，开始菜单+桌面快捷方式（`packaging/installer.iss:1-27`、`.github/workflows/release.yml:52-57`）。
- 运行期自动产生：`logs/`（壳/后端）、`config/config.yaml`（首次保存 LLM 时从 example 复制）、`config/character.yaml`（DLC 导入或用户复制）、`config/device_channels.yaml`（首次配件保存）、`config/character_runtime.yaml`（切角色/昵称）、`content/pack/DLC*/`（导入 DLC）（`.gitignore:9-30`、`backend/main.py:751-778`、`backend/main.py:567-568`、`backend/config.py:237`）。
- 运行期**不产生**的东西（不要画进「产物」）：前端源码/Node 依赖、`relay/node_modules`、`tools/`、`ollama/`、`素材/`（`.gitignore:28-36`、`packaging/build_release.py:219-226`）。

### 10.5 建议的图边/分层

```
[Windows 用户桌面]
  ├─ (双击) Shell exe ──spawn──> Relay(Bun, :9998, bind ::)
  │        │                    └──spawn──> Backend(FastAPI, 127.0.0.1:8000)
  │        └─(WebView2) http://127.0.0.1:8000 ──> Backend（GET /, /assets, /api/*, WS /ws）
  └─ (备用) start.bat: 浏览器 ──> 同一 Backend
[局域网] Phone DG-LAB 4.0 App ──ws://<PC LAN IP>:9998?tid=──> Relay ──BLE──> 郊狼 A/B
[外网] Backend ──HTTPS──> OpenAI 兼容 LLM
[构建] Node(Vite build) + Python(PyInstaller) + Bun(运行时复制) + Inno(CI) ──> zip/setup.exe
```

### 10.6 时序要点（画 sequence 图时）

1. **启动**：Shell 起 Relay(:9998) → 起 Backend(:8000) → 轮询 `GET /api/state` 200 → 开 WebView2 → 页面 `GET /`、`/assets/*`、`GET /api/state`、WS `/ws` → 后端连 Relay WS（拿 `clientId`，状态 waiting）→ 页面「等待 App」。
2. **配对**：Backend 用 `clientId` 生成 QR（`/api/qrcode.png`）→ 手机扫码 → App 连 Relay `?tid=` → Relay 给 Backend 推 `client_attached` → Backend 3s 后 `auto_open` → WS 向页面推 `chat`。
3. **AI 回合**：自动运行循环（12s）→ LLM → actions → `safety.validate` → `relay_client.send_frame` → Relay → App → 设备；`slots.patch` 回传 current/caps → WS 推页面。
4. **急停**：页面长按空格 1s / 点按钮 → `POST /api/estop` → `GameLoop.estop`（停循环、clear/stop 帧）→ `safety.estop_active` → WS 推 state（badge 变红）→ 用户点「解除急停」→ `POST /api/resume`。
5. **DLC 导入**：页面选文件 → `POST /api/dlc/import`（multipart）→ 后端写 `content/pack/<DLC*>/`、改 `character.yaml`、`reload_character` → 返回 `{dir,files,role,profile}` → 前端 `POST /api/character/profile` → WS 推新 roles/profile → 角色卡更新。
6. **发布**：tag → CI 构建前端 → 装 Py 依赖 → `build_release.py --ci`（两个 PyInstaller onefile + 组目录 + zip + 生成 iss）→ `ISCC` 编 setup.exe → GitHub Release 上传两个产物。

### 10.7 端口 / 运行时依赖总表（图例）

| 端口 | 用途 | 默认绑定 | 谁访问 |
|---|---|---|---|
| 8000 | Web 控制台 + REST + WS + 二维码 | 127.0.0.1 | WebView2/浏览器（本机） |
| 9998 | DG-LAB v4 中继 | `::`（全接口） | 后端（控制方）、手机 App（被控方） |
| 9999 | DG-LAB v3 中继（未启用） | 默认 | 无 |
| 11434 | 可选 Ollama 本地视觉模型 | 由 Ollama | 后端 LLM vision 端点 |
| 5173 | Vite 开发服务器（仅开发） | localhost | 开发者浏览器 |

运行时依赖：Windows + WebView2 Runtime（壳必需；缺则弹窗给下载链接，`desktop/shell.py:164-169`）、Python 3.10+（源码模式，`README.md:107`）、Bun ≥1.3（中继/壳内置 bun.exe，`relay/package.json` engines）、Node 18+（仅构建，`README.md:109`）、可选 opencv-python（摄像头，`backend/camera.py:42-47`）、可选 sounddevice（麦克风，`backend/audio.py:57-74`）、手机 DG-LAB 4.0 App（v4，`README.md:224`）。
