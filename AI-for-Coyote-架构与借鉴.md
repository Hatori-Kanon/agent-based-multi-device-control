# AI-for-Coyote 架构分析与借鉴

> 对象：<https://github.com/indhg/AI-for-Coyote>（产品名「Coyote in Cradle」），本地克隆 `ai-for-coyote/`，HEAD `9cce657b8cd694632eb40108ae165eef14954d96`（2026-08-30），GPL-3.0。
> 方法：只读逐文件取证（Python 后端 / React 前端 / Bun 中继 / 打包），配合 `archify` 生成架构图；行号均可在该 commit 下抽查。
> 本文结论基于代码，不基于它 README 的自述——两者不一致处已单列（§1）。
> 我方基线：`Embodied Roleplay`（工作区根，HEAD `fea2776`）与 `coyote-hub/`（工作区未跟踪目录）。

---

## 0. 结论先行

1. **它是一个「单角色 × 单设备 × 手机中继」的完整单机产品**，不是框架。真正值钱的不是它的代码，而是三样东西：**手机 App 持有 BLE 带来的设备状态自报**、**一套被真机打磨过的回合引擎 + 提示词工程**、**把 AI 内容做成可分发内容包的产品化路径**。
2. **它的安全层是「够用」而不是「完备」**：五层限幅真实存在，但步长限制只对 `add_strength` 生效、`comfortLimit` 只写进提示词不参与钳制、保底补强度绕过校验、断开只清本地状态；更糟的是**保底路径调用了一个全仓库都不存在的 `_scale_cmd`，触发即崩溃**。**我们抄结论、不抄实现**——否则会把它的四个洞和一个真 bug 一起搬进来。
3. 对我方两个工程，净收益排序是：**波形承载规则（立刻修负体验）> 每通道 step 限制（最便宜的安全增益）> 感知反馈闭环精简版（M2 体验核心）> 设备状态自报接口（为 relay 第二通路铺路）**。**换传输、换桌面壳、照抄 `{line, actions[]}` 输出格式是负收益**。

---

## 1. 先校正认知：README 和上一版分析里已经不成立的说法

它的 README（以及我们仓库里 8 月版的 `项目分析-AI-for-Coyote.md`）落后于代码。以下每条都已逐行核对：

| # | 常见说法 | HEAD 代码事实 | 证据 |
|---|---|---|---|
| 1 | 麦克风用 faster-whisper 转写玩家语音 | **没有任何 STT**。只由 sounddevice 采 RMS 电平，按 `threshold×4` 分 high/low 两档；`on_text`/`last_text` 是死代码，requirements 里没有 whisper | `backend/audio.py:2,27,118-121,132-145`；`requirements.txt:1-9` |
| 2 | 长按空格是「焦点无关」的带外急停 | 绑定在**页面 `document`** 的 keydown 上，窗口失焦即取消；控制台没焦点时长按无效 | `frontend/src/App.tsx:92-111` |
| 3 | 有「强度修正滑块 50%~150%」 | 已在 commit `661ffed` 删除，HEAD 前端无此控件 | `frontend/src/components/ChannelControl.tsx:180-195` vs `README.md:34` |
| 4 | 左侧聊天框打字与 AI 对话 | HEAD **没有聊天输入框**；`POST /api/chat` 后端仍在但前端无调用方，交互是「自动运行优先」 | `frontend/src/api.ts:31`；`frontend/src/components/ChatPanel.tsx:64-174` |
| 5 | 单条指令强度变化 ≤40 防跳变 | 只有 `add_strength` 被钳 ±40；`hold_strength`/`temp_strength` 不受限，一条 hold 可以 0→上限 | `backend/safety.py:163-176` vs `131-161` |
| 6 | `comfortLimit` 是程序使用的安全上限 | 只写入 `app_caps` 供状态展示与提示词劝告；`cap_for` **不读** `app_caps` | `backend/safety.py:66-70` vs `303-312,324` |
| 7 | 中继/App 断开 → 自动清零 | 只是取消循环波形 + 本地 `current` 归零（`record(stop)`），**一个设备帧都不发**（App 已断，无处可发） | `backend/game_loop.py:715-719`；`backend/main.py:159-161` |
| 8 | 内置 24 个官方波形、64 帧 | 24 个 preset + 24 个 custom，每个 2~84 帧，合计约 763 帧 | `config/waveforms.yaml:7-963`；`backend/waveforms.py:8-129` |

**这条经验本身对我们有用**：引用上游 README 做技术选型会把你带错；任何「它支持 X」的结论都要落到代码行。

---

## 2. 架构

### 2.1 一张图

- 交互版（可切主题/缩放/导出）：本地 `.archify/architecture-ai-for-coyote-20261101-160515/ai-for-coyote-architecture.html`（archify 生成物，已加入 `.gitignore`，不随仓库发布）
- 静态预览：本地 `.archify/architecture-ai-for-coyote-20261101-160515/ai-for-coyote-architecture.visual-check.1440x900.light.png`（同上，本地生成）

图中每个组件都挂了源码出处；`archify` 的 validate / deliver / check / browser-check 四道门禁全过，并已人工看过 1440×900 渲染。

### 2.2 分层

```
┌ 外壳层 ──────────────────────────────────────────────┐
│ 桌面壳 Coyote-in-Cradle.exe（Python + pywebview）      │
│   拉起 bun 中继 + Python 后端 → 等 /api/state 200 → 开窗 │
│   单实例 mutex；关窗 taskkill 整个进程树                │
├ UI 层 ───────────────────────────────────────────────┤
│ React 19 + zustand + Vite 构建产物，由 FastAPI 托管     │
│   状态单向：后端 build_state() → WS /ws 推送 → 覆盖     │
├ 主程序层 ─────────────────────────────────────────────┤
│ FastAPI :8000（只绑 127.0.0.1）                        │
│   AppState（事件枢纽/传感器开关/WS 广播/DLC 导入）      │
│   GameLoop（四个模型入口 → 一条执行通道）              │
│   SafetyManager（唯一命令出口）                         │
│   DeviceOps（V4 RPC 帧构造，唯一构造器）                │
│   RelayClient（v4 控制方，自动重连）                    │
│   Camera / AudioManager（可选依赖，可降级）             │
├ 中继层 ───────────────────────────────────────────────┤
│ Bun v4-server.ts :9998（监听 ::，对局域网开放，无鉴权） │
│   透明转发：hello / client_attached / message 原样透传   │
├ 硬件与外部 ───────────────────────────────────────────┤
│ DG-LAB 4.0 App（手机，**BLE 由它持有**）→ 郊狼 V3 A/B    │
│ OpenAI 兼容 LLM API（可分离视觉端点 → 本地 Ollama）      │
│ dungeon-lab.cn 短链（二维码内容）                       │
└ 横切：config/*.yaml + content/pure（内容）+ packaging/  ┘
```

### 2.3 四条必须记住的架构事实

1. **后端既不直连蓝牙，也不直连郊狼**。它只对 `ws://127.0.0.1:9998` 说 V4 报文，真正持 BLE 的是手机 App（`relay/README.md:107-113`；全仓库无蓝牙依赖）。
2. **中继是透明的**，它只解析外层 `type/clientId/data`，不解析 `device.op`；所以 `slots.patch` 里的 `comfortLimit/overheat` 是 **App 产生**、中继透传、Python 消费（`relay/v4-server.ts:158-204`；`backend/safety.py:283-312`）。
3. **配对是带外的**：后端只生成二维码 PNG（`dungeon-lab.cn/s/?v=1&action=socket&url=ws://<lan>:9998?tid=<controllerId>`），人用手机扫，App 主动连中继（`backend/main.py:84-90,346-358`）。
4. **桌面的两条命令入口共用一个出口**：AI 回合的 `actions[]` 与页面手动控制都走 `execute_actions → safety.validate`；`dry_run`（默认 true）只跳过发帧，不跳过校验与记录（`backend/game_loop.py:442-519`；`backend/main.py:413-420`）。

---

## 3. 机制剖析：哪些值得学、哪些只是能跑、哪些是坑

### 3.1 SocketAPI v4 中继：买的是「状态自报」，代价是「多一跳 + 无鉴权」

**事实**：控制方（Python）连 9998 拿 `clientId`；被控方（App）用 `?tid=<clientId>` 接入；双方报文由中继原样转发。这套协议来自第三方 GPL 项目 `dglab-websocket-server`，本仓库的 `relay/v4-server.ts` 是它的一份重实现（`relay/README.md:109-137`；`relay/v4-server.ts:118-135`）。

**换来了什么**：
- 唯一的 `comfortLimit.comfortMax/absoluteMax` 与 `comfortLimit.overheat` 来源——这是 BLE 直连拿不到、由官方 App 上报的设备状态；
- 设备态 `slotState`、当前 `intensityA/B`、`custom.action` 反馈按钮；
- 手机端不用装我们的 App，官方 App 即客户端。

**代价**（全部是运维/安全面）：
- 多一个运行时（Bun）和一次配对；二维码依赖局域网 IP 与防火墙；
- **中继无鉴权**，监听 `::`，任何知道 `tid` 的客户端都能挂进来；后端也只绑 loopback、无 token（`relay/v4-server.ts:441-473`；`backend/main.py:310-344` 无中间件）；
- 5 分钟无被控方即 `idle_timeout` 断开控制方，重连后 `controllerId` 变化 → **旧二维码失效**（`relay/v4-server.ts:12,340-353`）；
- `comfortLimit` 到了我们手里也**不是钳制项**，只是提示词里的劝告（见 §3.2）。

**判断**：这条通路的价值 > 成本，但**只值一条「第二通路」**，不该替换我们已验证的 BLE 直连；接之前先把设备状态事件接口留好（见 §4.2 A3）。

### 3.2 安全层：五层 + 两个旁路，是「够用」不是「完备」

| 层 | 真实实现 | 缺口 |
|---|---|---|
| 上限 | 硬上限默认 200，用户上限初值 `min(100, 200)`，页面可调到 200；`cap_for = min(caps, user_caps)` | 与硬件无关，纯软件 |
| 步长 | `max_strength_step=40`，**只钳 `add_strength`** | `hold/temp` 可 0→上限跳变 |
| 时长 | 临时强度 ≤10s 到点自动归零；波形 ≤ min(10s, 预设上限) | 配置 `waveforms.yaml` 写 30s 但被 10s 吃掉（`config.py:292-305`） |
| 过热 | App 上报 `comfortLimit.overheat` → 该通道上限临时降到 20 | 无自动解除；只降「新命令」上限，不压当前强度；App 不报就等于不存在 |
| 断开 | `auto_clear_on_disconnect` → 取消循环 + 本地清零 | **不发设备帧**（App 已断） |
| 急停 | 前端长按 1s / 页面按钮 → 置 `estop_active`，清通道、清波形、暂停循环；期间拒绝一切动作（含 stop） | 非全局热键；无硬件级兜底 |

两个**旁路**（图里没画，但评审必须知道）：
1. `_apply_channel_floor` 补强度/波形时自己构造 `hold/add` 命令并直接发帧，**不经过 `validate`**（`backend/game_loop.py:395-440`）；
2. `estop` 自己构造 clear/stop 帧（`backend/game_loop.py:697-708`）——属安全动作，合理但有第二条构造路径。

**而且这条保底路径本身是坏的**：`_apply_channel_floor` 在两条分支上调用 `self._scale_cmd(cmd)`（`backend/game_loop.py:419,429`），但全仓库没有 `_scale_cmd` 的定义（`grep -rn "_scale_cmd" backend/` 只有这两处调用）。触发条件很常见——第 2 轮后某通道强度为 0，或连续 2 轮没有调整强度——一旦命中就是 `AttributeError`：用户消息入口直接 500，自动运行回合被吞，自动观察任务（`game_loop.py:241-259` 没有异常兜底）会静默死掉。仓库没有任何测试（无 `tests/`），所以这个死代码一直没被发现。**这是「规则值得借、实现不能借」的最好例证**，也提醒我们：保底/自动路径如果也开第二条写路径，必须被类型检查和测试钉死。

**判断**：它的五层结构值得学（每层都能独立解释、数值可配），但**实现不能照抄**：step 要对我们所有写路径生效；`comfortLimit` 若采纳必须真参与钳制或至少降额 + 审计；overheat 要有 TTL 与恢复；断开若还有可用通路，要真发 `stop`；保底路径不得绕开 policy。

### 3.3 强度原语与波形承载：两条真机结论

- **`AddIntensity`（t=3，相对增减）是最可靠的原语**；`SetTempIntensity(d=0)` 不可靠，所以持续强度用「目标 − 当前」换算出 delta 下发；循环波形不指望 App 的循环参数，由**主机侧分批重发**（`backend/device_ops.py:4-12,15-19`；`backend/game_loop.py:529-539,611-662`）。
- **只给强度不给波形，郊狼通道不产输出**。它的系统修复是两层：动作执行时若通道无波形先自动挂默认波形（`_ensure_default_wave`，`game_loop.py:473-477`），回合结尾再做双通道保底（`_apply_channel_floor`），并由提示词强约束「大多数回复至少一个波形动作、A/B 两通道都给动作」（`backend/llm.py:79-81,164-175`）。

**对我们的直接结论**：
- 我们的郊狼 V3 后端用绝对模式 + `B1` ack，**不继承「AddIntensity 才可靠」这个约束**；但 MonsterParty / Buttplug / 谜姬 / 未来 relay 后端都是「宿主保活重发」模型，这条结论适用。
- 「强度必须伴随波形」是**通用契约**，不是郊狼特有。我们应在 registry/policy 层实现「无波形 → 自动挂默认波形或显式拒绝」，并且**不要在 policy 之外再开一条保底写路径**（避免重演它 bypass + `_scale_cmd` 的教训）。
- 规则可以借，**它的保底实现不能借**（见 §3.2：该路径触发即 `AttributeError`）。

### 3.4 回合引擎：四个模型入口 + 一条执行通道

| 入口 | 触发 | 证据 |
|---|---|---|
| `handle_user_message` | 手动聊天（HEAD 前端已无调用方） | `game_loop.py:135-169` |
| `auto_open` | 首次配对成功后缓 3s，AI 主动开场 | `main.py:155-172` |
| `_auto_observe_turn` | 摄像头观察循环，约 10s | `game_loop.py:221-259` |
| `_autopilot_turn` | 自动运行循环，约 12s | `game_loop.py:310-325` |
| `execute_actions` | 以上四者共用的执行通道 | `game_loop.py:442-519` |

每回合的固定骨架（值得照搬的纪律）：
`reload_character()` → `_note_rage()` → **`build_state()`（先取状态，再动作）** → 追加系统提示 user 消息 → `llm.chat(..., image_b64)` → 解析 JSON → `execute_actions` → `_apply_channel_floor` → 台词回写历史。

两个观察渠道：
- 摄像头：每 1.5s 截帧，只算**全帧平均亮度**判「黑屏」（阈值 20/255）；无人体/人脸检测（`backend/camera.py:22,94-139`）；
- 麦克风：每 4s 算一次 RMS，`level ≥ threshold(0.005)` 即触发，`≥ threshold×4(0.02)` 记 high；同档 5s 冷却；high → 注入「该降低了、安抚」；low → 注入「可小幅加码」；90s 无声判「持续无声」（`backend/audio.py:87-145,159`）。notes 只留最近 5 条，下一轮以 `【玩家反馈】` 注入。
- 怒气：`dark || silent` 每回合 +1，否则清零；`>=1 不耐烦 / >=3 愤怒 / >=5 暴怒` 三档写进提示词（`game_loop.py:63-82,115`；`llm.py:195-211`）。

**缺陷**（别抄）：observe 与 autopilot 是**两个独立循环**（10s / 12s），仅靠 `turn_busy` 互斥，传感器开着时同一时段可能连发两次模型调用；麦克风 `last_sound_ts` 初值 0 会让刚启动的第一回合必然判「无声」（`backend/audio.py:36`）。

**判断**：我们 M2 的 agent loop 应该做成**单调度器 + 优先级 + 互斥**，而不是两个死循环相加；但「状态快照先于动作」「run_pattern 立即返回、下一轮观察」「配对后 AI 主动开场」这三条节奏直接可用。

### 3.5 提示词工程：一张分层表 + 三个硬约束

它的系统提示词是 9 层拼出来的（`backend/llm.py:25-220`）：

| 层 | 内容 |
|---|---|
| L0 角色 | 「你在扮演 X」+ `prompt_file` 正文 |
| L1 few-shot | 最多 8 条对话示例；带动作的示例渲染成 `{line, actions}` JSON |
| L2 输出格式 | **仅当没有 prompt_file 时**注入 7 种 op 定义、波形列表、铁律、台词一致性、强度调节原则 |
| L3 通用安全 | 求饶可继续但不真伤害；连续痛苦要主动降强度并关心 |
| L4 实时状态 | 中继状态、A/B 当前强度与上限、对玩家称呼 |
| L5 风格档 | 纯爱 / 调教两段固定约束 |
| L6 设备映射 | A/B = 配件名 + 位置；描写只能落在配件位置；触手/装置两套叙事 |
| L7 基准与协同 | 基准 A=15/B=5；低/中/高 = 70%/100%/130%；每轮小幅上调 3~5；双通道协同 |
| L8 条件注入 | App 舒适上限提醒、急停禁止动作、dry-run 说明、摄像头观察指引、怒气三档、防复读、玩家反馈 notes |

三个真正值得抄的硬约束：
1. **波形名铁律**：pattern 必须一字不差照抄列表，动作描写词不是波形名；安全层对未知波形直接拒绝（`llm.py:76-78`；`safety.py:178-184`）——**提示词约束 + 代码兜底双保险**。
2. **台词一致性**：台词里说做了什么刺激，actions 就必须有对应动作；不许报与 actions 不符的数值（`llm.py:82-83`）。
3. **JSON 修复策略**：整体解析 → 去代码围栏 → 正则取首个 `{...}`；3 次请求，每次失败往 system 追加更硬的「必须且只能是 JSON」；推理模型 content 为空时取 `reasoning_content`（`llm.py:223-242,311-353,316-321`）。

**但它有一个 bug 级的坑**：所谓「第 3 次零温度兜底」是把 `temperature=0` 设在循环最后一次迭代之后——**没有第 4 次请求，兜底从未生效**（`llm.py:347-353`）。我们若做重试，别复制这个假兜底。

### 3.6 内容与分发：产品化完整，工程纪律薄弱

**DLC 机制**（真正可借鉴的是流水线，不是文件约定）：
`POST /api/dlc/import`（zip 或单 .md）→ 校验扩展名/空文件/50MB → zip 文件名 cp437→UTF-8 还原（Windows 压缩工具的经典坑）→ 只收 `.md`、按 `DLC<序号>-<角色>-<风格>` 分组 → 落盘 `content/pack/`（跳过 `..` 防穿越）→ 找组内「角色提示词」→ 回写 `character.yaml` 的 `prompt_file` → `reload_character()` 热加载，无需重启（`backend/main.py:550-696`；`backend/config.py:514-604`）。

**三个坑**：
1. 三件套里**只有「角色提示词」被运行时读取**，语料库/漫画设定没有任何读取点——它们是给人看的约定资产（`backend/config.py:460-463`）。
2. 导入时**强制把新档位写成 `level=中`**，与 README 声称的「DLC2=重」矛盾（`backend/main.py:650,656`）。
3. 全新安装没有 `character.yaml` 时会回退到 `character.example.yaml`，而导入逻辑直接改这个文件——**首次导入 DLC 会改写示例模板**（`backend/config.py:150-157`；`backend/main.py:628-631`）。

**发布**：前端 build + 两个 PyInstaller `--onefile`（后端 + pywebview 壳）+ 随包 `bun.exe` + `relay/` 源码 + `frontend/dist` + 配置模板 + `content/pure` → zip；`.iss` 只生成、真正编译在 CI；per-user 安装、无需管理员（`packaging/build_release.py:193-247`；`packaging/installer.iss:1-27`）。

**工程纪律上的问题**（别学）：CI 只构建不测试；依赖全部 `>=` 不锁版本，构建不可复现；无自动更新、无代码签名，CI 注释自认 Defender 误报；无卸载/用户数据迁移钩子；安装器 `LicenseFile` 指向「说明.txt」。

### 3.7 UI/UX 打磨清单（精选，直接可映射）

1. **配对引导完整**：未配对时中栏直接给二维码 + 「配对后在 App 里打开『输出』开关」+「连接成功后 3 秒 AI 会主动开场」（与后端 3s 一致）。
2. **上限调低立即生效**：后端马上用 `hold_strength` 把当前强度压到新上限（`main.py:489-498`）。
3. **通道开关**：关即清零并拒绝后续动作，状态持久化；双通道都关时聊天区顶部红条警告「AI 不会输出任何刺激」。
4. **三态传感器徽章**（灰/绿/橙）防止「开了但其实没跑」的误判——这是被真实 bug 教育的产物。
5. **长按空格急停带 1s 进度条**，与判定时长共用一个常量；输入框内不劫持、失焦/松手取消、已急停不重复。
6. 切换角色/风格往聊天流插一条分隔消息，避免上下文串戏。
7. 清空对话二次确认，并明说「设备强度不受影响」。
8. 设置页写清「哪些配置热加载、哪些要重启」；API Key 只回显掩码、留空保存=清除。

---

## 4. 对我方项目：差距矩阵与取舍

### 4.1 总表

| 维度 | AI-for-Coyote | Embodied Roleplay（我们） | coyote-hub（我们） |
|---|---|---|---|
| 传输 | 手机 App 持 BLE，PC 走 v4 中继 | **BLE 直连**（Web Bluetooth 桥）+ MonsterParty 云 + Buttplug 集线器 + 安可尼直连 | BLE 直连（Web Bluetooth） |
| 设备状态源 | App 上报 `slots.patch`（含 comfortLimit/overheat） | 自己维护 + pid 猜测 | 自己维护（绝对上下限） |
| 硬件级安全 | **无**（只有软件上限 + App 侧） | **`BF` 软上限**，连接即写、写不进就拒绝进入可控状态 | **不发 BF**（README 明说） |
| 软件安全层 | 五层 + 两端急停 | 三层上限 + `LOCKED` latch + 三条急停 + append-only 审计 | **无 policy / 无审计 / 无 LOCKED** |
| 波形 | 24 preset + 24 custom（hex） | 帧模型 + 段落 DSL + 两级库 + 夹紧 | 无波形库（只有强度/频率） |
| AI | 单角色 `{line, actions[]}`，7 种 op | **M2 未实现**（agent/scenario/sensors/state 目录不存在） | 无 AI |
| 感知 | 亮度黑屏 + 音频 RMS 分级（无 STT） | 无 | 无 |
| 内容分发 | DLC zip（角色/风格三件套） | 三层剧本设计完整，未实现，无 DLC | 无 |
| 多设备 | 单设备双通道 | 5 个真实后端 + mock，多设备并行 | **多台郊狼**（核心卖点） |
| 对外 API | 无鉴权 REST + WS（内部用） | dashboard API + panic server（token） | **稳定的 HTTP REST + WS 对外契约**（docs/API.md） |
| 测试 | 无测试 | **263 core + 84 desktop** | 137 + 11 项 UI smoke |
| 许可 | GPL-3.0 | 自定义/待定 | 未声明 |

### 4.2 Embodied Roleplay：我们更强的地方，以及该补的

**先明确别被带偏**：`BF` 硬件软上限、`LOCKED` latch、append-only 审计、per-device 串行队列、generation token、波形 DSL、5 个真实后端 + mock、263+84 条测试——这些是我们**已经强于它**的部分（`packages/core/src/backends/coyote/backend.ts:6-11,244-246`；`devices/registry.ts:129-136`；`devices/audit.ts:35-65`；`devices/policy.ts:27-53`）。借鉴它不能以拆掉这些为代价。

它对我们真正的增量，按优先级：

| # | 采纳项 | 为什么 | 落点（我方文件） | 优先级 |
|---|---|---|---|---|
| A1 | **每通道 step 限制** | 我们 policy 只有上限没有速率；模型/脚本一次跳满是最常见的体感事故。**修掉它「只对 add 生效」的洞**：对我们的所有强度写入（含保底/急停后的恢复）都生效，或在 policy 里显式豁免并审计 | `devices/policy.ts` 加 `maxStepPerCommand` + `ABSOLUTE_MAX_STEP`；`devices/registry.ts` 写路径（约 `:663-673`）执行「斜坡或拒绝」；测试 `policy.spec.ts` / `registry.spec.ts` | **P0**（成本半天） |
| A2 | **波形承载契约** | 「只给强度不给波形 = 没感觉」是负体验，且我们已经踩过（XHTKJ 与郊狼的差异）。把它写成**系统契约**而不是提示词礼貌：强度命令若通道无波形则自动挂默认波形，或明确拒绝并告知模型。**唯一实现点放 policy/registry，禁止第二写路径**（吸取它 floor 绕过 validate 的教训） | `devices/policy.ts`（规则）+ `devices/registry.ts`/`effect.ts`（自动挂默认波形）；`waveform/library.ts` 提供 per-channel 默认波形；`agent/tools.ts`（未来）在工具描述里说明 | **P0**（半天） |
| A3 | **设备状态事件 + 过热降额** | 我们没有任何「设备自报状态」通道：`DeviceBackend` 只有 `onLinkLost/onChannelsChanged`，快照无硬件状态字段。先留接口与 UI/审计字段，本地 mock 可先模拟 | `devices/types.ts` 加 `onDeviceState?` 与 `DeviceSnapshot.deviceState`；`devices/registry.ts:575-604` 聚合；`devices/policy.ts` 加「临时降额 override（带 TTL 与恢复）」；`devices/audit.ts` 新增 `device_state`/`derate` action；`apps/desktop/src/main/dashboard.ts:283-427` 透出；`ui/` 显示降额原因 | **P0/P1**（接口 1 天；降额依赖状态源） |
| A4 | **DG-LAB SocketAPI v4 中继后端（第二通路）** | 唯一能拿到 `comfortLimit/overheat` 的路径；也是「手机不在 PC 边也能玩」的形态。**但它是第二通路，不是替换**：我们 BLE 直连 + BF 更强 | 新建 `packages/core/src/backends/dglab-relay/{backend,protocol}.ts`（**只按协议规格自实现，不复制 GPL 代码**）；`apps/desktop/src/main/bootstrap.ts` 协议工厂注册；`dashboard.ts` 加配对二维码；`devices/types.ts` 通过 A3 接状态 | **P1**（M3，2~3 天；先做 A3 铺路） |
| A5 | **感知反馈闭环（精简版）** | M2 的体验核心。它的做法被证明「不需要 STT 也能成立」：亮度黑屏 + 音频 RMS 分级 → 注入提示词。**不要做 STT**（它自己砍了） | 新建 `packages/core/src/sensors/{registry,frame-store}.ts`（帧快照原子写复用 `ports/storage.ts`）；`apps/desktop/src/main/bootstrap.ts` 接线；`dashboard.ts` 加 `POST /frame`（独立 token、绑回环）；M2 先用音频（`sounddevice` 不在 Node 生态，桌面用 `naudiodon`/`node-record-lpcm16` 或先做「手机浏览器采音」） | **P1**（M2） |
| A6 | **回合节奏纪律** | 「先取状态快照，再动作」「`run_pattern` 立即返回、下一轮观察」「配对成功 3s 后 AI 主动开场」「同一时刻只允许一个模型调用」 | `agent/loop.ts`（新建）、`scenario/phases.ts`、`devices/effect.ts` 的立即返回语义；`agent/prompt.ts` | **P1**（M2，与 A7/A8 同批） |
| A7 | **提示词硬约束** | 波形名铁律、台词一致性、双通道/多设备协同、notes/反馈注入、JSON 修复（**真兜底**，不要抄它的零温度假兜底） | `agent/prompt.ts`（新建，按 `剧本系统设计.md` §8 分层）；`scenario/intents.ts` 映射 `feedbackIntents` 到默认波形 | **P1**（M2） |
| A8 | **内容包/DLC 机制（manifest 化）** | 我们需要内容分发，但**不能抄它的三个坑**：三件套只读一件、level 强制=中、无版本/校验/卸载。做 manifest（id/版本/模型/文件清单/哈希/兼容范围）+ 校验失败拒绝加载 + 可卸载 | `packages/core/src/scenario/loader.ts` + `apps/desktop/src/main/node-storage.ts`（安装/校验）；`dashboard.ts` 导入端点；`docs/` 规范 | **P1**（M2 后期） |
| A9 | **UI 打磨清单（§3.7 选 5 条）** | 状态三态徽章、上限调低立即压下、配对二维码 + 3s 开场、长按急停进度条、双通道关闭警告 | `apps/desktop/src/ui/`；`apps/desktop/src/main/dashboard.ts` / `panic-server.ts`（已有 panic 端点可复用） | **P2** |
| A10 | **发布工程（选择性）** | per-user 安装器 + `version.txt` + tag 触发 CI 构建可以学；**不学**「无测试 CI / 不锁版本 / 无签名」 | 构建脚本（新增） | **P2** |

**明确不采纳**（负收益或与我们的安全模型冲突）：
- ❌ 换掉 BLE 直连、改用「手机 App 持 BLE」作为主通路（我们 BLE 已有真机验证，且 `BF` 是硬件级保护）；
- ❌ 照抄 `{line, actions[]}` 单角色单体输出（我们的 `feedbackIntents` 是更通用的意图层，`剧本系统设计.md` §4）；
- ❌ 照抄「A=贴片 / B=肛塞」的物理绑定写死（我们已有 `Channel` 抽象与 `outputFloorPercent`）；
- ❌ 照抄「comfortLimit 只进提示词」的做法（要么真钳制，要么降额 + 审计，不能只靠劝）；
- ❌ 照抄两个独立 auto 循环（改为单调度器）；
- ❌ 引入它「无鉴权 + 局域网裸奔 + API Key 明文」的部署形态（我们已有 token 化 dashboard 与独立 panic server）。

### 4.3 coyote-hub：它缺的是安全层，不是 AI

`coyote-hub` 是「从大工程里把郊狼控制摘出来」的工具型软件：多台郊狼、每设备每通道绝对上下限（强度 0–200 / 频率 1–100Hz）、本地 HTTP REST + WS 对外契约、Web Bluetooth、mock、fourNights 集成，137 单测 + 11 项 UI smoke。它**没有** policy/审计/LOCKED/BF/波形库/持久化/AI（grep 无 `audit`；`manager.ts:4`；`types.ts:193`）。

AI-for-Coyote 对 hub 的可取之处其实很少——两者定位不同（产品 vs 工具）：
1. **设备状态自报**：hub 用绝对窗口，若接 v4 中继可显示 App 的 `comfortLimit/overheat`，并在过热时临时收紧该通道上限（同样是 A3 的「带 TTL 降额」）；
2. **步长限制**：hub 通过 HTTP API 暴露给外部软件，无 step 限制意味着任何脚本都能一帧拉满——这是**比主工程更该补**的洞；
3. **UI 状态三态**与**长按急停**：hub 是浏览器/Electron 形态，页面级长按急停适用（它的桌面全局热键不需要）；
4. 不建议把 AI 内容包/回合引擎引入 hub——那是主工程的职责。

### 4.4 许可边界（必须写死）

AI-for-Coyote 整体 GPL-3.0，`relay/` 源自 GPL-3.0 的 `dglab-websocket-server`。**只吸收思路、流程、实测数值、协议事实与 UX；不复制任何源码**。relay 协议按 `relay/README.md` 的规格自实现，波形预设不打包它的数据。这与我们 `波形系统设计.md` §4 的既定策略一致。

---

## 5. 落地清单与验收（建议排期）

**阶段 0（P0，1–2 天，不依赖任何外部方案）**
- [ ] policy 增加 `maxStepPerCommand`，registry 所有强度写路径执行「斜坡或拒绝」；保底/恢复路径也不豁免（或显式豁免 + 审计）。
- [ ] 波形承载契约：无波形通道上的强度命令 → 自动挂默认波形或拒绝；写入 `devices/policy.ts` 注释与 `agent/tools.ts` 描述。
- [ ] `audit.ts` 增加 `derate` / `device_state` / `step_clamp` 三种 action 的 schema。
- 验收断言：任意强度写路径单次变化 ≤ N（测试注入 0→100 断言被斜坡或拒绝）；无波形时强度命令行为可预测且有测试。

**阶段 1（P0/P1，3–5 天，M2 铺垫）**
- [ ] `DeviceBackend.onDeviceState` + `registry` 快照聚合 + dashboard 透出 + UI 徽章；mock 后端先产出 overheat/comfortLimit 假状态。
- [ ] policy 临时降额 override（带 TTL、自动恢复、审计）。
- 验收断言：mock 上报 overheat → 该通道 cap 降到 20、UI 显示原因、恢复后 cap 回升、两端都有审计记录。

**阶段 2（M2 主体）**
- [ ] `agent/loop.ts`（单调度器 + 状态先于动作 + run_pattern 立即返回 + 同一时刻一个模型调用）。
- [ ] `sensors/registry.ts` 精简闭环：音频 RMS 分级 + 摄像头亮度黑屏 → 注入提示词（先做音频）。
- [ ] `scenario/` 三层加载 + `feedbackIntents` ↔ 默认波形映射；提示词按分层组装（A7）。
- [ ] 内容包 manifest + 校验 + 卸载（A8）。
- 验收断言：端到端一局跑完无技术细节泄漏；传感器缺失时 `unavailable` 不阻塞启动；内容包校验失败拒绝加载而非静默降级。

**阶段 3（M3，可选）**
- [ ] `backends/dglab-relay` 第二通路 + 配对二维码 + 5 分钟 idle/二维码失效的运维提示；relay 的局域网无鉴权风险写进文档与 UI 警告。

---

## 附录 A：关键证据索引（均可抽查）

| 事实 | 证据 |
|---|---|
| 4 个进程与端口 | `desktop/shell.py:127-172`；`backend/main.py:827-836`；`relay/v4-server.ts:4` |
| 后端托管前端 dist | `backend/main.py:328-340` |
| 中继角色判定（tid） | `relay/v4-server.ts:118-135,445-448` |
| 中继透明转发 | `relay/v4-server.ts:158-204` |
| V4 帧构造常量 | `backend/device_ops.py:15-19,31-53,86-96` |
| `comfortLimit/overheat` 消费 | `backend/safety.py:283-312`；`backend/main.py:147-154` |
| 五层安全数值 | `backend/config.py:53-59`；`backend/safety.py:24-55,131-176` |
| 唯一发送点 | `backend/game_loop.py:675-676`；`backend/relay_client.py:199-208` |
| 保底绕过 validate | `backend/game_loop.py:395-440` |
| 回合骨架 | `backend/game_loop.py:135-169,442-519` |
| 传感器与怒气 | `backend/camera.py:22,94-139`；`backend/audio.py:87-145,159`；`backend/game_loop.py:63-82` |
| 提示词分层 | `backend/llm.py:25-220` |
| JSON 重试与假兜底 | `backend/llm.py:223-242,311-353` |
| DLC 导入 | `backend/main.py:550-696`；`backend/config.py:514-604` |
| 打包与安装器 | `packaging/build_release.py:193-247`；`packaging/installer.iss:1-27` |
| 无鉴权部署面 | `backend/main.py:310-344`；`relay/v4-server.ts:441-473` |
| 我方 `BF` / `B0` / `B1` | `packages/core/src/backends/coyote/backend.ts:6-11,244-246,309` |
| 我方 LOCKED / 审计 / policy | `packages/core/src/devices/registry.ts:129-136`；`devices/audit.ts:35-65`；`devices/policy.ts:27-53` |
| 我方测试 | `packages/core` 263 条、`apps/desktop` 84 条（`grep -oE "\bit\("` 统计） |

## 附录 B：与旧分析（`项目分析-AI-for-Coyote.md`）的差异

旧分析对「传输选择、comfortLimit/overheat 存在、AddIntensity 实测结论、五层限幅结构、7 种 op」的判断在 HEAD 仍成立，本文沿用并补证。需要修正的是：

1. **麦克风 STT**：旧分析称 faster-whisper 转写、玩家语音进上下文 → HEAD 只测音量，作者主动砍掉了 STT。
2. **空格急停是带外**：旧分析称焦点无关 → 实际绑定页面 document，失焦即取消。
3. **「页面的反馈按钮」**：不存在，只有 App 的 `custom.action`。
4. **「黑屏/无人」**：只有平均亮度黑屏，无人脸/人体检测。
5. **「单条指令 ≤40」**：只对 `add_strength` 生效。
6. **「comfortLimit 是安全上限」**：只进提示词，不参与钳制。
7. **「A/B 轮流使用」**：代码要求每轮双通道协同。
8. **产品面整体缺失**：旧分析没覆盖桌面壳/打包/DLC/UI/WS/文档漂移，本文 §2、§3.6、§3.7 补足。
9. **漏掉 `_scale_cmd` 未定义这个真 bug**：旧分析把「保底补强度/波形」当成成熟设计建议采纳，实际上这条路径一旦触发就 `AttributeError`（`backend/game_loop.py:419,429`），自动观察/自动运行会静默死。**保底规则可以借，那条实现路径不能借。**

## 附录 C：证据笔记与产物

- [后端证据笔记（622 行，51 条证据表 + 18 条旧分析勘误）](analysis/coyote-backend-notes.md)
- [产品面证据笔记（685 行，681 处行号引用）](analysis/coyote-product-notes.md)
- [我方基线盘点（441 行，含 14 条文档-代码矛盾）](analysis/our-baseline.md)
- 架构图（archify，可交互）：本地 `.archify/architecture-ai-for-coyote-20261101-160515/ai-for-coyote-architecture.html`（生成物，未跟踪）
- 架构图规格 JSON（含每个组件的源码出处）：本地 `.archify/architecture-ai-for-coyote-20261101-160515/candidate.json`（生成物，未跟踪）
