# 产品化界面 v4：去说明文字 / 原生单位 / 设置页

> 起因：产品负责人对当时可运行的前端提出五点问题——
> 1. 去除 UI 内所有多余的说明文字（只保留功能需要的文字）；
> 2. 游玩界面没有滚轮滑动，设备多了下面的看不到；
> 3. 设备页两个 mock 设备删除，日志/审计/调试不显示在前端 UI（面向用户的产品）；
> 4. DG-LAB 郊狼按官方蓝牙开源项目：强度上下限 0–200（不是百分比），频率把官方 10–240
>    频宽映射到实际频率；
> 5. 缺设置页面（模型 API 信息、摄像头/麦克风设备选择与开关）。
>
> 频率口径在开工前确认过：官方 10–240 是**脉冲周期 ms 的分段压缩码**，物理频率为
> `1000/周期`。负责人选择「按官方物理频率 Hz 显示（1–100 Hz）」，而不是线性 10–200 刻度。

## 1. 交付内容

### 1.1 界面（`apps/desktop/src/ui/`）

| 文件 | 变化 |
| --- | --- |
| `index.html` | 单窗口**三视图**（游玩/设备/设置）：删 hero、全局上限说明、准备工作、遥测右栏、设备 viewbar/底栏/感知/错误面板、所有卡片 `<small>` 与长 hint；设置视图 markup（14 个契约 id）；hold overlay 只留「紧急停止」。 |
| `style.css` | 滚动修复：`.main-play/.main-console/.main-settings` 作为独立滚动容器；设备视图两栏；删除已删 UI 的死 CSS；新增设置页样式（复用墨金 token）。 |
| `shell.js` | `VIEWS` 加 `settings`；`/settings` 深链；路径同步 / sessionStorage 记忆 / viewchange 不变。 |
| `app.js` | 删除日志/审计/调试/遥测/运行时错误/感知面板及其全部请求；郊狼强度原生 0–200（滑杆 step 2、读数无 %）、频率物理 Hz 1–100（不再出现「编码」）；强度上限滑杆右端是**绝对满量程**（可双向调整）；文案收敛。 |
| `play.js` | 删除 `/api/debug`、probe 渲染、感知卡；解释性文案全删；软上限卡改为原生单位 + Hz；保留长按空格急停、暂停/继续/结束、锁定、choices、composer 等全部行为。 |
| `settings.js`（新） | 设置视图逻辑：读 `GET /api/settings`、保存模型、摄像头/麦克风开关与设备选择；密钥永不回显、保存后清空；无 console/localStorage。 |
| `phone.html` | 手机急停页同样压缩文案（去 tagline/说明段落/页脚/按钮副标题），功能与存储行为不变。 |

### 1.2 宿主 / core

| 文件 | 变化 |
| --- | --- |
| `packages/core/src/backends/coyote/frequency.ts`（新） | 官方 10–240 ↔ 物理 Hz 换算：`codeToHz`/`hzToCode`/`frequencyBandToHz`/`hzBandToCode`；分段公式、窄带塌缩、边界钳制；独立单测覆盖官方对照表。 |
| `packages/core/src/index.ts` | 导出频率换算模块。 |
| `apps/desktop/src/main/dashboard.ts` | 所有返回 snapshot 的路由统一装饰：device `protocol`、channel `intensityUnit/intensityMax/minFreqHz/maxFreqHz`；波形摘要 `minFreqHz/maxFreqHz`；`/api/cap` 接受 Hz 字段（与 code 字段互斥、单端补齐、全有或全无）；`/settings` 别名；`ADDABLE_PROTOCOLS` 去 `mock`；settings 路由分发；`STATIC_FILES` 加 `settings.js`。 |
| `apps/desktop/src/main/host-settings.ts`（新） | `state/settings.json` 传感器偏好持久化（camera 默认开、**mic 默认关**）；key-free 设置快照；`SettingsError`。 |
| `apps/desktop/src/main/settings-routes.ts`（新） | `GET /api/settings`、`POST /api/settings/llm`、`POST /api/settings/sensors`；400 校验；密钥永不回显。 |
| `apps/desktop/src/main/sensors/audio-host.ts`（新） | 麦克风采集宿主（2Hz FeatureSample、audioLevelPct 0–100、异常断流推 unavailable、`audioSensorSource`）。 |
| `apps/desktop/src/main/bootstrap.ts` | `audioHost` 选项与 mic SensorSource；启动时应用传感器偏好；HostRuntime 增加 `settingsSnapshot/saveLlmSettings/saveSensorSettings`；model runner/llm 改为 getter；play host 传 runner provider。 |
| `apps/desktop/src/main/play.ts` | `PlaySessionEnvironment.runner` 支持 `ModelRunner | (() => ModelRunner)`，回合时解析——保存模型配置后下一回合即生效。 |
| `apps/desktop/src/main/index.ts` | 产品入口 `withMockDevices: false`（`EMBODIED_MOCK_DEVICES=1` 才演示）；把 audioHost 传入 runtime；BUILD_TOKEN 升级。 |
| `apps/desktop/src/dev-server.ts` | 默认不注册 mock；`EMBODIED_MOCK_DEVICES=1` 才注册；`settings.js` 进入静态包。 |
| `apps/desktop/src/main/sensors/camera-window.ts` / `preload-camera.ts` / `renderer/camera.js` | 同一个隐藏窗口新增 `window.__audio`（enumerate audioinput、getUserMedia audio、AudioContext RMS 0–100、track ended → `audio:ended`），相机路径不变。 |
| `start-dev.bat` | 默认产品状态（无 mock）；`start-dev.bat mock` 显式演示。 |

### 1.3 测试

| 文件 | 覆盖 |
| --- | --- |
| `packages/core/tests/coyote-frequency.spec.ts`（新，9） | 官方对照表 10→100Hz、20→50、50→20、100→10、102→9、110→6.67、204→1.56、240→1；往返、钳制、窄带塌缩。 |
| `apps/desktop/tests/dashboard-units.spec.ts`（新，9） | snapshot 装饰、`/api/cap` Hz 双端/单端换算、混用与越界 400、legacy code patch、波形 Hz、`/settings` 深链。 |
| `apps/desktop/tests/settings.spec.ts`（新，11） | 设置 API 形状/无密钥泄漏、env 优先、文件 key 保留与清除、非法 400、内存配置 409、camera/mic 启停+持久化+重启恢复、未知设备 400、采集失败 200+error、无宿主 supported:false、模型保存后新会话首回合生效。 |
| `apps/desktop/tests/audio-host.spec.ts`（新，6） | 假桥接下列采样节奏、FeatureSample 形状、stop 清定时器、意外断流只推一条 unavailable。 |
| `apps/desktop/tests/dashboard.spec.ts` | 更新静态契约（三视图/settings.js/settings ids/无遥测）；mock 不再是可添加协议（400）；debug 面不再出现在页面与脚本。 |

## 2. 安全不变量（未变）

- 强度/频率的**人类边界**仍只由 `PolicyStore.setByHuman` 写；模型与内容包仍只写 0–100% 相对百分比，
  映射进人类区间（0 = 停止）。原生单位只是显示层 ×2 / Hz 换算。
- `/api/level` 仍收整数 percent；`/api/cap` 的强度仍落 `minPercent/maxPercent`；频率内部仍存协议码。
- 急停、LOCKED 闩锁、长按空格、手机带外急停、审计、BF 重下发、关闭归零全部保持。
- API key：只在 `<dataDir>/state/llm.json`（0600）与内存中；设置 payload 只有 `hasApiKey`/`apiKeySource`；
  任何响应、审计、日志、DOM 都不含密钥。
- CSP 未放宽；无外链资源；`play.js`/`app.js`/`settings.js` 无 `localStorage`/`console.`；
  `shell.js` 只写 sessionStorage 且 try/catch。

## 3. 验证

| 检查 | 结果 |
| --- | --- |
| `packages/core` tsc | 0 error |
| `apps/desktop` tsc | 0 error |
| core vitest | 51 files / **660** tests 全过 |
| desktop vitest | 17 files / **205** tests 全过 |
| esbuild：dev-server + Electron（main/preload/camera-renderer） | 构建通过 |
| 无 mock 的 dev-server（默认） | `/api/snapshot` → `devices: []`，`/api/settings` 形状正确，`/settings`、`/settings.js` 200 |
| 浏览器（无头 Chrome + CDP，真 dashboard + 真 coyote-over-mock-BLE 后端） | 大厅/舞台/设备/设置截图；郊狼通道 `0–40`（原生）、`1–100 Hz`、直控读数无 %；把强度上限拖到原生 100 → 服务端 `maxPercent=50`；频率拖到 60 Hz → 协议 `minFreq=17/maxFreq=240`，回读 59 Hz（协议粒度）；设置页保存模型 → `已保存`、密钥框清空、`GET /api/settings` 反映新值 |
| 滚动 | 大厅 `clientH 881 / scrollH 1556 / scrollTop 675`；设置页 1200×480 `422/603/181`；设备页中栏内部滚动 `910/2069`；顶栏 top 恒 0；1600/1280/1000/760/620 均无横向溢出 |
| 产品入口无 mock | Electron `index.ts` 与默认 dev-server 均 `withMockDevices: false`；添加设备弹窗无 Mock 项；`POST /api/devices {protocol:'mock'}` → 400 |
| 文案清理 | grep 三个 UI 文件：遥测/审计/日志/调试/编码/安全边界/准备工作/EMBODIED ROLEPLAY/今晚，由你来决定分寸/全局会话上限/append-only 等 0 命中 |

## 4. 独立审查与修复

交付前做了两轮独立只读审查（核心/宿主流 + UI 流；后者自行在真实 dashboard 上跑 CDP
截图/交互）。第一轮发现并修复了以下问题（对话轮次内的修复已包含在最终提交里）：

| 来源 | 问题 | 修复 |
| --- | --- | --- |
| core 审查 · 阻塞 | 设置页保存模型时先把文件落盘再构建 runner；未知 provider 且无 baseUrl 会让 `state/llm.json` 变成**下次启动必崩**的配置（文件已写、内存已换、路由 500） | 保存前用候选配置构建 runner 做校验（失败 → 400 `INVALID_LLM` 且不写文件）；启动时若文件配置不可用，回退内置默认并写审计，不阻塞启动 |
| core 审查 · 阻塞 | 环境变量覆盖文件密钥时，一次未提及 apiKey 的保存会删掉文件里的密钥 | 新增 `storedApiKeyOf(raw)`：保存时直接读原始文件的 key，环境变量解析值不再参与写回判断 |
| core 审查 · major | `/api/cap` 单端 Hz 补丁会把未改动端点按四舍五入的显示 Hz 重新量化（91–100 Hz 带、改快端会把慢端带到 83 Hz） | 单端补丁保留未改动端的**原始协议码**，只转换改动端；并拒绝跨过未改动端的请求（400），新增回归测试 |
| core 审查 · major | `director` 内联配置无效时：启动静默回退默认，之后所有保存都 400（UI 无法修复文件） | 启动/保存时对 `director`/`writer` 做可构建性检查，无效角色在内存中忽略、保存时从文件清除（可恢复）；设置 payload 增加 `split`/`warning` 字段，UI 显示降级提示 |
| core 审查 · minor | 真实采集宿主 `stop()` 吞掉 bridge 停止失败，设置页仍报 `stopped` | `BridgedCameraHost/AudioHost.stop` 报告后重新抛出；采集控制把失败显示为 `error`（有测试） |
| core 审查 · minor | 设备枚举失败被当成「没有设备」 | 区分枚举错误：设置页显示 `采集失败：<原因>`，不覆盖为「没有可用的设备」 |
| core 审查 · minor | `captureState.deviceId` 返回偏好而非实际在用的设备 | 改为 `runningDeviceId ?? preference.deviceId` |
| core 审查 · minor | 远程 `http://` baseUrl 会明文发送 Bearer key；userinfo/query 会回显与进审计 | baseUrl 要求 https（回环地址可用 http）、拒绝 userinfo；审计里的 baseUrl 去掉 query/hash |
| core 审查 · minor | 升级数据目录里旧的 `protocol:'mock'` 清单条目仍会注册假设备 | 载入 manifest 时删除 mock 条目并重写文件（写审计），一次性迁移 |
| core 审查 · minor | 并发设置 POST 可能互相覆盖 | 设置读写串行化（`runSettingsOp`） |
| core 审查 · minor | 设置页无法清除已存密钥；刷新会清掉未保存的模型输入；pagehide 不 flush | 增加「清除密钥」按钮（`POST {apiKey:''}`）；刷新按钮只重绘设备区、模型表单有 dirty 保护；pagehide flush |
| core 审查 · nit | 生产不再使用 `hzBandToCode`，与 dashboard 的映射实现可能漂移 | 双端补丁有与 `hzBandToCode` 的 parity 测试；代码注释说明为何单端路径必须自己保留原始码 |

**已知保留项**（有意识不修）：

- 原生强度步进 2（0–200 只到偶数）：内部安全语义是整数百分比，奇数原生值需要非整数百分比；
  这是可解释的取舍，不是漏掉的需求。
- 极窄/退化的历史协议码频带（显示四舍五入后 min==max）在界面上显示「—」并禁用，
  用户可用整体范围重设；协议码在高速端每步约 9 Hz，这是硬件协议的分辨率。
- `withMockDevices` 在 `createHostRuntime` 里默认 true（测试/fixture 默认），产品入口
  （Electron 主进程、dev-server）全部显式传 false；已有 manifest 的 mock 条目会被迁移清除。

## 5. 已知取舍与遗留

- **频率控件可见性**：只有 `supportsWaveform` 的通道（当前只有郊狼）在设备页与软上限里显示频率滑杆；
  其他后端的策略里仍有 `minFreq/maxFreq` 字段（引擎与 API 不变），但界面上不提供不生效的旋钮。
- **频率码粒度**：官方码在高速端 1 ms 一步（code 10=100Hz、11=90.9Hz…）。界面按整 Hz 显示，
  因此 60 Hz 请求会落到最近码（58.82Hz）并在下一次快照回读为 59 Hz；界面滑块会随之跳 1 Hz。
  这是协议分辨率，不是映射 bug；不显示协议码是产品决定。
- **强度步进 2**：原生 0–200 与整数百分比一一对应，因此郊狼直控/范围滑杆只允许偶数原生值
  （奇数强度需要非整数百分比，会破坏安全策略的整数约束）。
- **真机未验**：真实 Electron 下的摄像头/麦克风权限弹窗、设备热插拔、隐藏窗口 `AudioContext`
  自动播放策略需要真机人工过一遍；无头环境只验证了代码路径与单测。
- 摄像头默认开（沿用 v3 行为）、麦克风默认关（隐私默认）；`withCamera:false` 只覆盖启动时刻。
- 会话上限 `sessionCeiling` 仍在引擎里作为第二道闸门，UI 不暴露。
