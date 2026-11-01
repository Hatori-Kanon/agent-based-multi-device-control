# AI-for-Coyote（Coyote in Cradle）后端证据笔记

> 对象：本地克隆 `ai-for-coyote/`，HEAD `9cce657`（提交时间 2026-08-30，工作区 `_reference/ai-for-coyote/` 内容相同、无 .git）。
> 方法：只读源码逐文件通读（下表），**未安装依赖、未运行项目**、未使用真机；所有结论以代码为准，不采信 README（README 有已知过时处，见 §8.2）。
> 许可：仓库整体 GPL-3.0（`LICENSE`；`relay/` 另带 dglab-websocket-server 的 GPL-3.0 LICENSE）。本笔记只引用短关键行与常量，不整段复制源码。
> 路径约定：除特别说明外，所有 `文件:行号` 均相对 `ai-for-coyote/`。文中「旧分析」指工作区根目录 `项目分析-AI-for-Coyote.md`。

已通读文件（行数）：`backend/main.py` 836、`backend/game_loop.py` 729、`backend/safety.py` 348、`backend/llm.py` 444、`backend/config.py` 654、`backend/relay_client.py` 215、`backend/device_ops.py` 100、`backend/camera.py` 140、`backend/audio.py` 162、`backend/waveforms.py` 129、`backend/logging_utils.py` 27；`relay/v4-server.ts` 477、`relay/v3-server.ts` 1154、`relay/README.md` 527、`relay/package.json`、`relay/.env.example`；`config/config.example.yaml` 71、`config/character.example.yaml` 66、`config/waveforms.yaml` 963；`desktop/shell.py` 176、`run_app.py` 37、`start.bat` 45、`requirements.txt` 10；`frontend/src/api.ts`、`commands.ts`、`App.tsx`（相关片段）、`vite.config.ts`；`packaging/build_release.py`、`packaging/installer.iss`。

---

## 1. 进程、端口与启动链路

### 1.1 运行时有 3 个自建本地进程 + 内嵌 WebView + 1 个手机端 + 1 个外部云服务

| # | 组件 | 形态 | 关键事实与证据 |
|---|---|---|---|
| 1 | 桌面壳 `Coyote-in-Cradle.exe` | 独立进程（pywebview） | 负责拉起中继与后端、再开窗口；`desktop/shell.py:127-176` |
| 2 | 中继 `bun run v4-server.ts` | 独立进程（Bun） | 默认端口 **9998**；`relay/v4-server.ts:4`，`start.bat:32-33`，`desktop/shell.py:136-141` |
| 3 | 后端 `python -m backend.main` / `AI-for-Coyote.exe` | 独立进程（Python/uvicorn） | 默认 **127.0.0.1:8000**；`backend/config.py:31-32`，`run_app.py:22-35`，`desktop/shell.py:143-147` |
| 4 | 内嵌浏览器视图（WebView2） | 桌面壳窗口内的 WebView | 加载 `http://127.0.0.1:8000`；`desktop/shell.py:153-163` |
| 5 | DG-LAB 4.0 App（手机） | 外部设备 | 以被控方身份连 `ws://<PC-IP>:9998?tid=<controller_id>`；`relay/v4-server.ts:445-448`，`relay/README.md:160-166`；郊狼 BLE 由 App 持有，本项目不直连硬件 |
| 6 | OpenAI 兼容 LLM API（可含独立视觉端点） | 外部云服务 | `backend/llm.py:248-266`；默认 `https://api.openai.com/v1`（`backend/config.py:39`），示例为 `https://api.deepseek.com`（`config/config.example.yaml:17`） |
| 可选 | 本地 Ollama 视觉服务 | 独立进程 | `start.bat:18-30` 探测 11434 并可选拉起；`config/config.example.yaml:24-27` 注释给出 `http://127.0.0.1:11434/v1` |
| 开发态 | Vite dev server | 独立进程 | `frontend/vite.config.ts:7-12` 把 `/api`、`/ws` 代理到 8000（默认 5173 端口） |

### 1.2 双击 exe 的启动链路（打包发布态）

1. `desktop/shell.py:127-133`：单实例互斥（`MutexName` 在 `desktop/shell.py:24`）→ 失败弹「已在运行」。
2. `desktop/shell.py:135-141`：仅当 9998 未被占用才 `spawn([bun, "run", "v4-server.ts"], cwd=relay/)`；找不到 bun.exe 时弹窗（查找路径见 `desktop/shell.py:68-77`，优先 exe 同目录 `bun.exe`）。
3. `desktop/shell.py:142-147`：仅当 8000 空闲才拉起后端（有 `AI-for-Coyote.exe` 用 exe，否则 `python -m backend.main`）。
4. `desktop/shell.py:97-108`：轮询 `http://127.0.0.1:8000/api/state`，最多 30s 直到 HTTP 200（`BACKEND_URL` 在 `desktop/shell.py:25`）。
5. `desktop/shell.py:153-163`：`webview.create_window(..., "http://127.0.0.1:8000", 1440x900)`；无 WebView2 运行时给安装提示（`desktop/shell.py:164-170`）。
6. 关窗 = 退出：`finally: shutdown()` → `taskkill /PID <pid> /T /F` 清理中继与后端（`desktop/shell.py:111-124`、`173-175`）。

打包侧：后端用 PyInstaller `--onefile`，显式排除 `faster_whisper`/`torch`/`tensorflow`（`packaging/build_release.py:163-166`），并安装 `opencv-python`、`numpy`、`pywebview`（`packaging/build_release.py:131`）；壳另打一个 exe（`packaging/build_release.py:175+`）。安装器是 Inno Setup，直接整目录拷贝、无服务注册（`packaging/installer.iss:16-27`）。

### 1.3 源码/脚本启动（`start.bat`）

- `start.bat:18-30`：可选先起 Ollama（仅当 11434 未监听且 `..\ollama\ollama.exe` 存在）。
- `start.bat:32-33`：窗口 1 = 中继 `v4-server.ts`（注释写明端口 9998）。
- `start.bat:35-36`：窗口 2 = `python -m backend.main`。
- `start.bat:38-40`：`timeout 4` 后打开 `http://127.0.0.1:8000`。
- `start.bat:44`：提示手机连同一 Wi-Fi 扫页面二维码。
- 环境变量旁路：`DGLAB_DRY_RUN`（`backend/config.py:139-143`）、`DGLAB_LLM_API_KEY` 优先于配置（`backend/config.py:146-148`）。

### 1.4 FastAPI 侧

- `app = make_app()` 在**模块导入时**执行（`backend/main.py:824`），`make_app()` 内部 `load_config()` + `AppState(cfg)`（`backend/main.py:310-313`）；`python -m backend.main` 的 `__main__` 分支又 `load_config()` 一次取 host/port 再 `uvicorn.run`（`backend/main.py:827-836`）。`run_app.py:22-35` 是等价入口。
- 生命周期：`@app.on_event("startup")` → `state.start_background()`（`backend/main.py:315-321`）；`shutdown` → `state.shutdown()`（`backend/main.py:323-325`）。
- `start_background`（`backend/main.py:284-295`）：起 `relay.run()` 常驻任务、`_sensor_watchdog()`（15s 周期）；若配置 `autopilot.enabled` 则真正调 `loop.set_autopilot(True)`（注释说明曾因只置状态不启动任务导致「假开真停」，`backend/main.py:287-290`）；有浏览器接入才启动传感器；最后 `loop.start_observe_loop()`。
- `shutdown`（`backend/main.py:297-307`）：停观察循环、关自动运行、停摄像头/麦克风；`auto_clear_on_disconnect` 为真时再执行一次 `loop.estop()`；取消后台任务。
- 前端托管：`FRONTEND_DIST = <root>/frontend/dist`（`backend/main.py:47`）；`GET /` 返回 `dist/index.html`，未构建则返回纯文本构建提示（`backend/main.py:328-336`）；`/assets` 仅在存在时 `StaticFiles` 挂载（`backend/main.py:339-340`）。

HTTP/WS 接口清单（全部在 `main.py`，UI 侧封装见 `frontend/src/api.ts:26-70`）：

| 方法/路径 | 作用 | 行号 |
|---|---|---|
| GET `/api/state` | 全量状态快照 | `backend/main.py:342-344` |
| GET `/api/qrcode.png` | 生成配对二维码 PNG | `backend/main.py:346-358` |
| GET `/api/pair_url` | 返回配对链接文本 | `backend/main.py:360-368` |
| GET `/api/network` | 网络自检（IP 列表、pair_url、relay_port=9998 硬编码） | `backend/main.py:370-392`（9998 在 386） |
| POST `/api/chat` | 用户回合 | `backend/main.py:395-399` |
| POST `/api/estop` / `/api/resume` | 急停/解除 | `backend/main.py:401-411` |
| POST `/api/manual` | 手动动作，**与 AI 同一执行链路** | `backend/main.py:413-420` |
| POST `/api/device/channels`、`/enabled`、`/cap` | 配件/通道开关/运行时上限 | `backend/main.py:422-445`、`483-506` |
| POST `/api/sensors` | 摄像头/麦克风单独开关（不持久化） | `backend/main.py:447-461` |
| POST `/api/history/clear` | 清对话历史 | `backend/main.py:463-467` |
| POST `/api/layout` | 前端三栏尺寸上报（调试用） | `backend/main.py:469-481` |
| POST `/api/character/profile`、`/nick` | 角色/风格、昵称热切换 | `backend/main.py:508-548` |
| POST `/api/dlc/import` | 上传 zip/md 导入 DLC | `backend/main.py:550-696` |
| POST `/api/autopilot` | 自动运行开关（联动传感器） | `backend/main.py:698-705` |
| GET/POST `/api/settings/llm`、POST `/test` | 模型配置读/写/测连 | `backend/main.py:708-803` |
| WS `/ws` | 服务器推送 `{"type":"state"|"chat"}`；客户端只发心跳、服务端忽略 | `backend/main.py:806-819`（忽略接收内容在 814） |

无 CORS、无鉴权中间件（全文件无 `add_middleware`/`CORSMiddleware`）；服务默认只绑 127.0.0.1（`backend/config.py:31`）。

### 1.5 中继（9998）与配对/二维码

- 后端配置默认 `relay.url = ws://127.0.0.1:9998`（`backend/config.py:37`）；中继默认 `PORT=9998`（`relay/v4-server.ts:4`）、路径前缀 `PREFIX='/'`（`relay/v4-server.ts:14`）、监听 `hostname: '::'`（`relay/v4-server.ts:463`，即对局域网开放，手机才能连）。
- 后端以**控制方**身份连中继：`websockets.connect(url, ping_interval=20, ping_timeout=20, open_timeout=10)`，断线每 `reconnect_delay_s`（默认 3s）重连并清空 clients（`backend/relay_client.py:92-113`）。
- 配对链：中继在连接建立时下发 `hello{clientId}`（`relay/v4-server.ts:118-120`）→ 后端记 `controller_id`（`backend/relay_client.py:125-129`）→ 二维码链接 = `https://dungeon-lab.cn/s/?v=1&action=socket&url=<quote(ws://<lan_ip>:9998?tid=<controller_id>>)`（`backend/main.py:84-90`）→ 手机 App 扫码后以 `?tid=` 接入被控方（`relay/v4-server.ts:445-448`）→ 中继通知控制方 `client_attached`（`relay/v4-server.ts:329-333`）。
- `lan_ip: auto` 时用 UDP 连 8.8.8.8 探测出口源地址（`backend/main.py:60-67`）；`public_url` 非空时改用公网 `wss://` 中继（`backend/main.py:86-87`，`config/config.example.yaml:14`）。
- 前端二维码图由 `GET /api/qrcode.png` 现场生成（`qrcode` 库，`backend/main.py:355-358`），中继未连上时返回 503（`backend/main.py:349-350`）。
- 空闲坑：控制方 5 分钟没有**任何**被控方接入会被中继 `4002 idle_timeout` 关闭（`relay/v4-server.ts:12`、`340-353`）；后端会自动重连，但**会拿到新的 controllerId**（旧二维码随之失效）——重连不持久化配对身份（`backend/relay_client.py:92-113`）。

---

## 2. Relay 协议事实（v4）

### 2.1 角色判定与帧类型

注：本小节未注路径的行号均指 `relay/v4-server.ts`。

- 连接时不带 `tid`（或 `targetId`）= 控制方；带 `tid` = 被控方（`relay/v4-server.ts:126-131`、`445-448`）。`targetId` 与 `tid` 等价（`relay/v4-server.ts:445-448`；v3 用 `targetId`，见 `relay/v3-server.ts:4/33`）。
- 服务端下行帧（控制方视角）：`hello{clientId}`（`118-120`）、`client_attached{clientId}`（`333`）、`client_disconnected{clientId}`（`250-253`）、`error{code,...}`（`162-167`、`180-184`）、`message{clientId,data}`（`192-196`）、`heartbeat`（`90-96`，间隔 30s，`6`）、`pong`（`271`）、`idle_timeout`（`347`）。
- 服务端给被控方的帧：`hello`、`controller_attached{clientId=控制方ID}`（`329-332`）、转发的 `message{data}`（`171-177`）、`error{code:controller_not_found}`（`305-306`）。
- 断开码：`4000` 控制方断开（`16`、`228-233`）、`4001` 目标控制方不存在（`18`、`305-306`）、`4002` 空闲超时（`20`、`347-348`）。错误码 `bad_request`/`client_not_found`/`controller_not_found`（`relay/v4-server.ts:162-167/180-184/305-306`；`relay/README.md:247-261`）。
- **中继完全透明**：只解析外层 `type`/`clientId`/`data`，不解析 DG-LAB 业务指令（`relay/v4-server.ts:158-204`；`relay/README.md:128` 原文即「服务端只关心外层的 type、clientId 和 data，不会解析 DG-LAB 设备指令」）。因此 `slots.patch`/`comfortLimit` 等字段**不是中继产生**的，见 §2.4。

### 2.2 后端 → 中继的报文格式（device_ops.py）

注：本小节未注路径的行号均指 `backend/device_ops.py`。

`backend/device_ops.py:4-12` 的注释即协议摘要，`31-53` 是唯一构造器：

- 外层：`{"type":"message","clientId":<被控方ID>,"data":{...}}`（`backend/device_ops.py:31-35`）。
- `data`：`{"t":"req","reqId":"<自增整数>","m":"device.op","data":{...}}`（`backend/device_ops.py:32`；`reqId` 用 `itertools.count(1)`，`29`）。
- `device.op.data` 公共字段：`s`=slotId、`c`=通道（0=A/1=B）、`t`=动作类型；可选 `d`=时长 ms、`v`=值、`im:true`=立即替换（`backend/device_ops.py:37-53`、`21-22`）。
- 动作类型常量：`t=0` AppendPulseData 波形帧、`t=3` AddIntensity 相对增减、`t=4` SetTempIntensity 临时强度、`t=7` SetIntensity 绝对（仅 `v=0` 归零）（`backend/device_ops.py:15-19`、`4-11`）。
- 清理：`m="device.op.clear"`，`data={"s":slotId[, "c":通道]}` 或省略清全部（`backend/device_ops.py:86-96`）。
- 另有 `request_devices`（`m="devices.get"`，`backend/device_ops.py:98-100`）**全仓库从未调用**（grep 仅定义处）——设备列表完全依赖 App 主动推 `devices.snapshot`。
- 实际发送点唯一：`game_loop._send_all` → `relay.send_frame`（`backend/game_loop.py:675-676`；`backend/relay_client.py:199-208` 只做 `json.dumps(..., ensure_ascii=False)` 后 `ws.send`）。

### 2.3 中继 → 后端的上行事件（relay_client.py）

注：本小节未注路径的行号均指 `backend/relay_client.py`。

`_handle_message`（`backend/relay_client.py:151-197`）：

- 只接受「已知被控方」的消息：`cid` 不在 `self.clients` 直接丢弃，防幽灵客户端（`backend/relay_client.py:156-159`）。
- `data.t=="ev"` 时按 `data.ev` 分发（`161-190`）：
  - `devices.snapshot`：整表替换设备列表（`163-166`）；
  - `devices.patch`：按 `removed` 删除 + `added` 追加（`167-173`）；
  - `slots.patch`：按 `slotId` 深合并 `props` 与 `slotState`（`174-184`；深合并实现 `19-25`），并 `props.setdefault("slotId", sid)`（`183`）；
  - `custom.action`：取 `data.action` 作为反馈按钮编号（`185-190`），若构造时传了 `on_action` 则 `create_task(on_action(action, cid))`。
- `data.t=="resp"`：只记日志（成功 debug/失败 warning），`reqId` 无上层回调（`191-197`）。
- 其余帧（`heartbeat`/`pong`/`idle_timeout` 等）一律忽略（`149`）。
- 事件回调经 `_emit` 调用 `AppState.on_relay_event`（`210-215`）。

### 2.4 `comfortLimit` / `overheat` / `slotState` 到底从哪来

**来源**：唯一来源是手机 DG-LAB 4.0 App 通过 SocketAPI v4 上行 `slots.patch` 里的 `slotState`；中继原样转发；Python 侧只在 `safety.update_device_state` 消费。全仓库 grep `comfortLimit|comfortMax|absoluteMax` 只命中 `backend/safety.py:303-312`（消费者），中继 TS 与 README 均无这些字段——即本仓库既不构造也不改写它们。

**消费路径**：`main.on_relay_event("slots_patch")` 取 `relay.clients[first_client_id()]` 的 `props`/`slotState`（`backend/main.py:147-154`）→ `safety.update_device_state(props, slot_state)`（`backend/safety.py:283-312`）：

| 读取字段 | 层级 | 用途 | 证据 |
|---|---|---|---|
| `props.intensityA` / `intensityB` | slot props | 同步本地 `current[A/B]`；波形播放期间（`now < pulse_until`）**忽略**上报值 | `backend/safety.py:294-299` |
| `slotState.channelA/channelB.comfortLimit.overheat` | slotState | 置 `overheat[ch]`，随后 `cap_for` 的上限降到 `overheat_reduce_to` | `backend/safety.py:300-306`、`66-70` |
| `...comfortLimit.comfortMax`（优先）→ `absoluteMax` | slotState | 写入 `app_caps[ch]`，**仅用于状态展示与提示词**，不参与 `cap_for` 钳制 | `backend/safety.py:307-312`、`318-348`；提示词在 `backend/llm.py:176-182` |

**何时上报**：由 App 决定，本仓库不轮询、不请求（无 `devices.get` 调用）；后端每收到一帧 `slots.patch` 就更新一次状态并发起 WebSocket 广播（`backend/main.py:162`）。

**关键结论**：`app_caps`（App 舒适上限）在安全层里**不是**钳制项——`cap_for = min(caps, user_caps[, overheat→20])`（`backend/safety.py:66-70`）；程序只是把数值写进提示词劝模型「不要超」。设备端是否自行截断取决于 App。

### 2.5 relay 的其它协议事实

- 业务心跳 30s（`relay/v4-server.ts:6`、`90-96`），后端不回应（忽略，`backend/relay_client.py:149`）。
- 原生 WebSocket ping 10s 一次、连续 3 次未 pong 即 terminate（`relay/v4-server.ts:8-10`、`98-116`）。
- clientId 为 4 字节随机数的 8 位十六进制串（`relay/v4-server.ts:24`、`275-286`）。
- 中继**无鉴权**：任何知道 `tid` 的客户端都能挂到该控制方下（`relay/v4-server.ts:298-338`），且监听 `::`（`463`）——安全边界只靠随机 clientId 与局域网。
- `v3-server.ts` 是旧协议另一实现，默认 `PORT=9999`（`relay/v3-server.ts:4`），`package.json` 提供 `v3`/`v4` 两个脚本；但 `start.bat:33`、`desktop/shell.py:141` 只启动 `v4-server.ts`，后端 Python 也只实现 v4 报文（`backend/relay_client.py:4-8`）。v3 在本项目运行链路中是死件。

---

## 3. 每轮 game loop 的精确顺序

### 3.1 五个入口，同一套执行通道

注：本小节未注路径的行号均指 `backend/game_loop.py`。

`GameLoop` 有四个会调模型的入口：用户消息 `handle_user_message`（`backend/game_loop.py:135-169`）、配对开场 `auto_open`（`179-218`，由 `client_attached` 触发，`backend/main.py:155-158/164-172`，缓 3s）、自动观察 `_auto_observe_turn`（`261-293`）、自动运行 `_autopilot_turn`（`327-370`）；四者最终都汇入同一执行通道 `execute_actions`（`442-519`）。四条模型入口的骨架几乎一致：

1. `reload_character(cfg)` 热加载角色（`139`、`181`、`263`、`328`）
2. `_note_rage()` 更新怒气（`146`、`182`、`264`、`329`）
3. `state = build_state()` 生成状态快照（`147`、`183`、`265`、`330`）——**在动作之前生成**，所以注入提示词的是本回合动手前的强度
4. 向 history 追加一条「系统提示 user 消息」（开场/观察/自动三种文案：`184-191`、`266-274`、`331-344`）
5. `llm.chat(character, history, state, image_b64=self._latest_image())`（`150-153`、`198-201`、`280-283`、`350-353`）
6. 解析结果 → `execute_actions(actions)`（`162-163` 等）
7. `_apply_channel_floor()` 双通道保底（`164`、`209`、`289`、`359`）——**该步骤在 HEAD 上会因 `_scale_cmd` 未定义而抛异常**，见 §4.8
8. 把 `line` 作为 assistant 消息追加回 history（`168`、`212`、`292`、`362`）
9. 返回 `{line, executed[], dropped[], error?}`；用户入口由 API 返回（`backend/main.py:395-399`），自动入口由 `on_ai_turn` 回调广播（`backend/main.py:113`、`backend/game_loop.py:365-369`）

`turn_busy` 在模型调用期间置真（`144-166`），用于让自动观察/自动运行跳过并发回合（`248`、`318`）。

### 3.2 观察（camera/audio）在每轮里具体怎么进来

- 摄像头：`_latest_image()` 在 `camera.enabled && has_frame()` 时取最新 JPEG 的 base64（`backend/game_loop.py:172-176`）；`llm.chat` 把它以多模态 `image_url`（`data:image/jpeg;base64,...`）附在**最后一条 user 消息**上（`backend/llm.py:280-293`）。
- 摄像头不单独「喂文」：图像直接进多模态 content；`camera.vision_prompt`（`backend/camera.py:23-29`）定义了却**从未被读取**（死配置）。
- 麦克风：不转写，后台每 `interval_s`（默认 4s，`backend/config.py:86`）算一次 RMS（`backend/audio.py:117`），超阈值触发呻吟分级回调（`backend/audio.py:118-121`、`132-145`）→ `AppState.on_audio_moan` 往 loop.notes 里写一条中文提示（`backend/main.py:134-144`）→ 下一轮系统提示词以 `【玩家反馈】` 注入（`backend/llm.py:218-219`）。`on_text`（转写）回调是死代码，见 §6.3。
- `_note_rage` 在回合开头用**传感器当前状态**决定怒气 +1 或清零（`backend/game_loop.py:76-82`）。

### 3.3 JSON 解析与安全校验、设备命令

注：本小节未注路径的行号均指 `backend/game_loop.py`。

顺序（`game_loop.execute_actions`）：

1. 取 `client_id = relay.first_client_id()`、`slot_id = relay.get_slot_id()`、`ready = bool(both)`、`dry_run = safety.dry_run`（`448-451`）。
2. 逐条动作：`safety.validate(action)`；不通过进 `dropped` 并记 warning（`457-461`）。
3. 非 dry-run 且未就绪 → 进 `dropped`（`463-465`）。
4. 记录 `last_strength[ch]` / `last_wave[ch]` 轮次（`468-471`）。
5. 强度类动作若该通道没有波形承载，先自动挂默认持续波形（`473-477`）；`pulse_hold` 走循环任务（`479-493`）；`clear/stop` 先取消循环（`495-501`）。
6. `_build_frames(cmd, client_id, slot_id)` 生成 V4 帧（`506`）；`ready && !dry_run` 才 `_send_all` 发送（`508-509`）；`safety.record(cmd)` 更新本地跟踪（`510`）；写 `executed`（`511-512`）。

### 3.4 节奏

| 循环 | 周期 | 前置条件 | 证据 |
|---|---|---|---|
| 自动运行 autopilot | `autopilot.interval_s` 默认 **12s**（DEFAULTS，`backend/config.py:98`；读取 `backend/game_loop.py:48`）；每轮先等满一个周期再动 | 非急停、非 turn_busy（`318-319`）；`relay.status=="paired"` **或** dry_run（`320-321`）；异常只记日志不杀循环（`323-325`） | `backend/game_loop.py:310-325` |
| 自动观察 observe | `camera.observe_interval_s` 默认 **10s**（`backend/config.py:81`）；由 `start_observe_loop` 启动（需 camera.enabled 且 `auto_observe`，`backend/game_loop.py:221-233`） | 非急停、非 turn_busy、**必须 paired**（无 dry_run 豁免，`248-251`）、必须有帧（`252-253`） | `backend/game_loop.py:241-259` |
| 传感器看门狗 | 15s | `sensors_on` 且对应传感器有 error / 无帧 | `backend/main.py:259-281` |
| 浏览器空闲关传感器 | `sensor_idle_timeout_s` 默认 30s | WebSocket 客户端全断开 | `backend/main.py:248-257`、`backend/config.py:35` |

注意：observe 与 autopilot 是**两个独立循环**，可同时开启（camera 开启 + autopilot 开启时理论上每 ~10s 与 ~12s 各触发一次模型调用，只靠 `turn_busy` 互斥）。observe 循环不检查 `autopilot` 开关。

### 3.5 怒气（rage_rounds）与黑屏/无声升级规则

注：本小节未注路径的行号均指 `backend/game_loop.py`。

- 判定（`backend/game_loop.py:63-74`）：`dark = camera.enabled && camera.to_state().has_frame && dark`；`silent = audio.enabled && running && silent`；`rage_triggered = dark || silent`。
- 累计（`76-82`）：每回合被调用一次；触发 +1，否则清零。
- 注入（`build_state`）：`state["rage_rounds"] = rage_rounds + character.rage_baseline`（`backend/game_loop.py:115`）；`rage_baseline` 按风格档位固定：轻 0 / 中 1 / 重 2（`backend/config.py:486-487`）。
- 提示词三档阈值（`backend/llm.py:195-211`）：`>=5` 暴怒、`>=3` 愤怒、`>=1` 不耐烦；文案要求逐级加码/逼玩家回应。
- 黑屏判据只有平均亮度：`dark = has_frame && mean_brightness < dark_threshold`，默认 **20.0**（0~255）（`backend/camera.py:22`、`130-139`、`backend/config.py:82`）。**没有任何人脸/人体检测**（backend 全目录 grep `face|人脸|无人|person` 无命中）——旧分析「黑屏/无人」的「无人」部分不成立。
- 无声判据：`silent = (now - last_sound_ts) > silence_timeout_s`，默认 **90s**（`backend/audio.py:159`、`backend/config.py:94`）；`last_sound_ts` 只在 RMS ≥ threshold 时更新（`backend/audio.py:118-119`）。边界：`last_sound_ts` 初值 0（`backend/audio.py:36`），麦克风刚启动后的第一个回合会立刻满足「无声」——这是真实的初值 bug 面。
- 传感器未启用/未运行不计怒气：麦克风必须 `running`（`backend/game_loop.py:70-73`），摄像头必须 `has_frame`（`66-68`）。

### 3.6 呻吟分级阈值与行为

- 阈值：`threshold` 默认 **0.005**（`backend/config.py:87`）；`high` 判据 = `level >= threshold * moan_high_multiple`，倍数默认 **4.0** → 实际高音阈值 **0.02**（`backend/audio.py:134`、`backend/config.py:92`）。
- 冷却：同档信号 `moan_cooldown_s` 默认 **5s** 内不重复上报（`backend/audio.py:136-142`、`backend/config.py:93`）；换档不受冷却限制（条件同时要求同 kind）。
- 行为：`high` → notes「应降低强度、安抚并关心，不要继续加码」；`low` → notes「挑逗等级可逐渐增加，小幅加码」（`backend/main.py:134-144`）。notes 只保留最近 **5** 条（`backend/game_loop.py:726-729`），并在下一轮以 `【玩家反馈】` 注入（`backend/llm.py:218-219`）。
- 另注：`audio.interval_s` 默认 4s（`backend/config.py:86`），`min_segment_s`/`model_size`/`language` 字段虽在配置里出现，但 `audio.py` 只读 `interval_s/threshold/device/moan_*/silence_timeout_s`（`backend/audio.py:18-28`）——旧 Whisper 遗留字段（见 §8.2 E1）。

---

## 4. safety.py 逐层拆解

`backend/safety.py:2-11` 的模块 docstring 自述 6 条规则，与实际代码基本一致（下列逐层核对，并标出两处自述与实现的差异）。

### 4.1 状态与构造（`backend/safety.py:24-55`）

- `caps{A,B}` ← `safety.channels.<ch>.max_strength`（`28-31`）；DEFAULTS 为 **200**（`backend/config.py:54`），示例配置也是 200（`config/config.example.yaml:34-37`），`load_config` 把值钳到 0~200（`backend/config.py:160-162`）。
- `user_caps` 初值 = `min(100, caps)`（`backend/safety.py:33`）→ 即「默认 100、硬上限 200」的真实含义。
- `max_pulse_s` ← `playback.max_duration_s`（默认 10，`backend/config.py:63`/`251-257`）；`min_pulse_s` ← `playback.min_duration_s`（默认 3，`backend/config.py:62`）；`max_temp_s` ← `safety.max_temp_duration_s`（默认 10，`backend/config.py:55`）；`max_step` ← `max_strength_step`（默认 40，`backend/config.py:56`）；`overheat_reduce_to` ← 默认 20（`backend/config.py:58`）（`backend/safety.py:34-38`）。
- 本地跟踪：`current`（跟随设备上报）、`requested`、`app_caps`、`pulse_until`（monotonic 秒）、`overheat`、`enabled`（可被 `device_channels.<ch>.enabled` 覆盖）、`estop_active`、`dry_run`（`43-55`）。

### 4.2 层 1：每通道强度上限

- `cap_for(ch)` = `min(caps[ch], user_caps[ch])`，过热时再 `min(..., overheat_reduce_to)`（`backend/safety.py:66-70`）。
- `set_user_cap(ch, v)`：`v = max(1, min(caps[ch], int(v)))`，并就地钳制 `current/requested`（`72-81`）；API 先改上限，若当前强度高于新上限立刻下一条 `hold_strength` 降下来（`backend/main.py:493-498`）。
- 每条 temp/hold 校验都 `value = max(0, min(value, cap_for(ch)))`（`137`、`156`）。

### 4.3 层 2：单条指令步长（**注意：只对 add_strength 生效**）

- `_validate_add`：`delta = max(-max_step, min(delta, max_step))`，默认 ±40（`backend/safety.py:167-168`）。
- `_validate_hold` / `_validate_temp` **没有步长钳制**，只受 cap 限制（`149-161`、`131-147`）；执行时 hold 被换算成 `AddIntensity(目标-当前)`（`backend/game_loop.py:535-539`）、temp 同样（`529-534`）——所以**一条 `hold_strength` 可以把强度从 0 直接跳到上限**。旧分析「单条指令强度变化 ≤ 40」不准确（见 §8.2 E4）。

### 4.4 层 3：时长

- 临时强度：`duration_s = max(1.0, min(duration_s, max_temp_s=10))`（`backend/safety.py:138-142`）；执行后由 `asyncio` 任务到点发负 AddIntensity + `t=7 v=0` 归零（`backend/game_loop.py:587-608`），若 `estop_active` 则跳过归零（`backend/game_loop.py:594-596`）。
- 波形：`upper = min(max_pulse_s=10, preset.max_duration_s)`，`lower = min_pulse_s=3`（`backend/safety.py:196-198`）；执行时把波形帧平铺到请求时长（每帧 `frame_ms=100`，`backend/game_loop.py:542-552`；`backend/config.py:61`、`backend/waveforms.py:4`）。
- 配置不一致点：`config/waveforms.yaml` 里每个 preset 写 `max_duration_s: 30`（如 `config/waveforms.yaml:11-15`），但 `_load_waveforms` 会 `min(move_max, playback.max_duration_s=10)`（`backend/config.py:292-305`）→ 实际生效上限 **10s**，yaml 的 30 不生效。
- 提示词里的「3~10」只是建议：`temp_strength` 校验下限是 1.0s（`backend/safety.py:142`），与 `backend/llm.py:71` 文案不一致。

### 4.5 层 4：过热

- `overheat_reduce_to` 默认 20（`backend/config.py:58`）；`cap_for` 在该通道 `overheat=True` 时返回 `min(cap, 20)`（`backend/safety.py:68-69`）。
- `overheat` 只由 App 上报的 `slotState.channelX.comfortLimit.overheat` 置位（`backend/safety.py:303-306`）；本仓库没有「过热后 N 秒自动解除」逻辑，只有后续上报 False 才清除。若 App 不上报或字段缺失，这一层等于不存在。
- 过热只降低**新命令**的上限；不会主动把当前强度压下去，也没有「过热即 clear」的行为。

### 4.6 层 5：断开

- 配置 `auto_clear_on_disconnect` 默认 true（`backend/config.py:57`）。
- `client_disconnected` 事件 → 若该开关为真：`loop.on_client_disconnected()`（`backend/main.py:159-161`）→ 取消全部循环波形、清 patterns、`safety.record({"kind":"stop"})` 把本地 current/pulse_until 归零（`backend/game_loop.py:715-719`）。
- **不会向设备发送任何清零帧**（App 已断开，帧无处可发）；这是「本地状态清零 + 停止循环任务」，不是「设备端清零」。旧分析「中继/App 断开 → 自动清零」需要按此修正（见 §8.2 E9）。
- 中继连接断开时 `relay_client` 在 finally 里 `clients.clear()`（`backend/relay_client.py:108-112`），同理无设备命令。

### 4.7 急停（estop）

- `safety.estop()`：置 `estop_active=True`、`current/pulse_until` 归零、返回 `[{kind:clear,channel:None},{kind:stop}]`（`backend/safety.py:238-244`）。
- `game_loop.estop()`：先 `_cancel_loops(None)`、清 patterns（`backend/game_loop.py:697-699`），再 `safety.estop()` 拿命令、走 `_build_frames` 生成 clear + 双通道负 AddIntensity + `t=7 v=0`（`backend/game_loop.py:700-708`、`553-584`），非 dry-run 且有设备才发送（`704-708`）。
- 急停期间安全层拒绝一切动作（`backend/safety.py:95-96`）；提示词要求 actions 必须空数组（`backend/llm.py:183-184`）；`resume()` 只清 `estop_active`（`backend/safety.py:246-248`、`backend/game_loop.py:711-713`）。
- UI 触发：页面大红按钮；**空格长按 1000ms**，松手/失焦取消、已急停不重复（`frontend/src/App.tsx:15`、`92-107`；`frontend/src/commands.ts:39-46`）；README 同述（`README.md:164`）。
- 退出时若配置了断开清零，`AppState.shutdown` 也会 `loop.estop()`（`backend/main.py:298-305`）。

### 4.8 「任何来源命令的唯一出口」到底怎么保证

强成立的部分：

- 所有 V4 帧只由 `DeviceOps` 构造（`device_ops.py` 是唯一 `device.op` 报文构造器）。
- 所有帧只经 `game_loop._send_all` → `relay.send_frame` 发出（`backend/game_loop.py:675-676`；全仓库 grep `send_frame` 只有这一处调用）。
- AI（chat/autopilot/observe/open）、手动 API（`backend/main.py:413-420`）、通道上限下调（`backend/main.py:496-498`）都走 `execute_actions` → `safety.validate`。

两个旁路（图里/评审时要标出）：

1. `_apply_channel_floor` 自己构造 `hold`/`add` 命令后直接 `_build_frames` + `safety.record`，**不经过 `validate`**（`backend/game_loop.py:395-440`、`418-432`）→ 保底补强度时不受 `max_step`/`user_caps` 校验（`add` 的 ±5 用 `cap_for` 判断方向，但 `hold` 的 baseline 值没再钳制）；理论上 baseline（默认 15/5）若高于用户上限仍会被写入。
2. **HEAD 上这条路还会直接抛异常**：`backend/game_loop.py:419`、`429` 调用了 `self._scale_cmd(cmd)`，但该名字在全仓库**没有定义**（`grep _scale_cmd` 只有这两处调用；静态扫描 `game_loop.py` 的 `self.xxx(` 调用，未定义方法仅此一个；类方法清单见 `backend/game_loop.py:21-729`）。触发条件分别是「`turn_count>=2` 且该通道无波形或强度≤0」（`412-419`）和「某通道连续 2 轮没调强度/波形」（`426-429`）。后果按调用方不同：用户回合从 `/api/chat` 抛 500（`handle_user_message` 的 `try/finally` 不吞异常，`135-169`）；自动运行回合被 `_autopilot_loop` 兜底捕获后跳过（`310-325`）；自动观察循环**没有兜底**（`241-259`），异常会让 observe 任务直接死亡。
3. `estop` 自己构造 clear/stop 帧（`backend/game_loop.py:705-708`），不经 `validate`——属安全动作，合理但确实是第二条构造路径。

另：`dry_run` 时 `execute_actions` 仍走 `validate` 与 `record`，只是不发帧（`backend/game_loop.py:463`、`backend/game_loop.py:508-509`），手动控制同样如此（`backend/main.py:415` 注释「与 AI 指令走完全相同的安全链路」属实）。

### 4.9 通道开关与其它

- `enabled` 初值可由 `device_channels.<ch>.enabled` 覆盖（`backend/safety.py:49-53`）；`set_channel_enabled` 关闭时清 current/pulse_until/requested（`117-124`）；校验时 `_check_enabled` 拒绝（`126-129`）。API：`POST /api/device/channels/enabled`，落盘 `device_channels.yaml`（`backend/main.py:432-445`、`backend/config.py:212-241`）。
- `VALID_OPS` 共 7 种：`temp_strength/hold_strength/add_strength/pulse/pulse_hold/clear/stop`（`backend/safety.py:17`），与提示词里的 7 种 op 一致（`backend/llm.py:62`）。
- 未知波形名直接拒绝（`backend/safety.py:178-184`）——这是「波形名铁律」的硬兜底。

---

## 5. llm.py：模型接入与提示词工程

### 5.1 provider / OpenAI 兼容客户端

- 统一 OpenAI Chat Completions：`url = {base_url}/chat/completions`（`backend/llm.py:248-249`）；`Authorization: Bearer <api_key>`（`303-305`）。
- 参数：`temperature`（默认 1.0，`backend/config.py:42`）、`max_tokens`（默认 1500，`backend/config.py:43`）、`timeout_s`（默认 60 → `httpx.AsyncClient(timeout=...)`，`backend/llm.py:255`）、`json_mode`（默认 true，`backend/config.py:45`）。
- 模型名与地址完全可配（设置页 `POST /api/settings/llm` 文本级改写 `config/config.yaml` 后**重建 LLM 实例并热替换** `state.llm`/`loop.llm`，`backend/main.py:751-778`；首次保存会从示例复制出 config.yaml，`backend/main.py:759-766`；key 留空回退环境变量，`backend/main.py:767-771`）。
- 视觉端点可与主模型分离：`vision.base_url/api_key/model/timeout_s` 为空则回退主模型（`backend/llm.py:257-266`）；`describe_image`（`363-412`）与 `complete`（`414-444`）是通用工具方法，backend 内**无调用点**（grep 仅定义）。
- 空 content 兜底：推理型模型把正文放 `reasoning_content` 时取它（`backend/llm.py:316-321`，视觉 408-412，纯文本 438-441）；两者都空抛 `RuntimeError`（`321`）。

### 5.2 系统提示词分层（`backend/llm.py:25-220`）

注：下表未注路径的行号均指 `backend/llm.py`。

| 层 | 内容 | 行号 |
|---|---|---|
| L0 角色 | 「你在扮演角色『name』」+ `character.prompt`（来自 prompt_file 文件内容，或 character.yaml 的 `prompt` 兜底） | `25-32`、`backend/config.py:460-463` |
| L1 few-shot | `examples` 最多取 8 条；assistant 若为 dict 会渲染成 `{line, actions}` JSON 示例 | `34-49`、`backend/config.py:334-350` |
| L2 输出格式 | **仅当无 `prompt_file` 时注入**：7 种 op 的定义、默认波形列表、波形名铁律、台词一致性、强度调节原则 | `53-89`（有 prompt_file 时只写一句「你的角色设定文件已包含输出格式与规范」，`53-56`） |
| L3 通用安全 | 求饶可继续挑逗但不真伤害；连续痛苦要主动降强度并关心 | `90-93` |
| L4 实时状态 | 中继状态、A/B 当前强度/上限、对玩家称呼 | `94-104` |
| L5 风格档 | `profile_note` 优先；否则按 `纯爱`/`调教` 给两段固定风格约束 | `106-119` |
| L6 设备映射 | A/B = 配件名（位置）；刺激描写只能落在配件位置；触手/装置两套「禁止设备词汇」叙事 | `121-157` |
| L6b 通道工作状态 | 每通道「工作中/当前未工作」，要求台词不描写未工作通道 | `149-157` |
| L6c 禁用通道 | 被手动关闭的通道禁止输出动作 | `158-163` |
| L7 基准与协同 | 基准强度 A=15/B=5（可配）、低/中/高=70%/100%/130%、每轮小幅上调 3~5、双通道协同 | `164-175` |
| L8 条件注入 | App 舒适上限提醒、急停禁止动作、dry-run 说明、摄像头观察指引、怒气三档、防复读、玩家反馈 notes | `176-219` |

- 波形列表由 `_preset_text` 从状态里的 presets 渲染成「名字（推荐 Ns）」（`backend/llm.py:12-22`），即**模型可见的波形名就是 `config/waveforms.yaml` 的 presets 键（中文名）**。
- 波形名铁律：`backend/llm.py:76-78`（「pattern 必须一字不差照抄…动作描写词不是波形名」）；安全层未知波形拒绝（`backend/safety.py:178-184`）。
- 波形使用要求：大多数回复至少一个波形动作，不要只调强度不给波形（`backend/llm.py:79-81`）。
- `device_channels` 绑定：默认 `A=贴片/小穴/baseline 15`、`B=肛塞/后穴/baseline 5`（`backend/config.py:101-104`，运行时可存 `config/device_channels.yaml`，`backend/config.py:184-241`）；提示词映射与叙事由 `device_channels` + 角色 `device_narrative` 合成（`backend/llm.py:121-147`）。
- A/B 关系：**不是「轮流使用」，是「双通道协同」**——「默认 A/B 两个通道一起用…每轮尽量两个通道都给出动作…严禁连续多轮只操作一个通道」（`backend/llm.py:164-175`）；配合 §3.4 的 `_apply_channel_floor` 硬保底（`backend/game_loop.py:395-440`）。旧分析「A/B 通道轮流使用」措辞错误（见 §8.2 E5）。
- 状态快照来源：`game_loop.build_state`（`backend/game_loop.py:84-127`）合并 safety/relay/camera/device_channels；提示词在 `llm.chat` 内基于传入 state 现构建（`backend/llm.py:276`）。

### 5.3 JSON 模式、解析与重试/修复策略

注：本小节未注路径的行号均指 `backend/llm.py`。

- `json_mode=true` 时请求体加 `response_format:{"type":"json_object"}`（`backend/llm.py:300-302`）；`false` 时不加，靠文本兜底解析。
- 解析 `parse_llm_json`（`backend/llm.py:223-242`）：先整体 `json.loads`；失败则去掉 ``` 围栏后用正则取首个 `{...}` 块再解析；全失败返回 `{}`。
- 请求循环 `for attempt in range(3)`（`backend/llm.py:311-349`）：
  1. 每次请求后取 `content`（空则取 `reasoning_content`，再空则抛错）；
  2. `parse_llm_json(content)` 成功即 break；
  3. 非 JSON 模式：直接把整段文本当 `line`，break（`326-328`）；
  4. 仍失败则尝试解析 `reasoning_content`（`330-334`）；
  5. 第 1 次失败：往 `messages[0]`（system）追加「必须且只能是 JSON」硬约束（`335-340`）；第 2 次失败：追加「最后警告」（`341-346`）；
  6. 第 3 次失败：logger 写「零温度兜底重试」并 `payload["temperature"] = 0.0`（`347-349`）——**但这是循环最后一次迭代，之后不再发请求**，随即 `parsed` 为空 → 抛「思维链泄漏」错误（`351-353`）。即所谓「零温度兜底」实际从未生效（旧分析把它当既有能力，见 §8.2 E8）。
- HTTP 错误不重试：`resp.raise_for_status()` 直接抛（`312-313`），由上层兜底。
- 上层兜底（`backend/game_loop.py:154-161`）：任何异常都变成一句中文台词（思维链泄漏 vs 普通调用失败两种文案），`actions=[]`，回合继续；用户不会看到崩栈。
- 返回：`line` 取 `parsed["line"]`（空则 warning 但继续），`actions` 非 list 则置空（`backend/llm.py:355-361`）。

---

## 6. 传感器降级（缺依赖时的真实行为）

### 6.1 摄像头（OpenCV）

注：本小节未注路径的行号均指 `backend/camera.py`。

- `camera.enabled=false`（DEFAULTS 与示例都是 false，`backend/config.py:77`、`config/config.example.yaml:51`）时 `start()` 立即 return，**不会 import cv2**（`backend/camera.py:39-41`）——这是「缺 opencv 也能跑」的实现方式。
- enabled=true 但缺 cv2：`start()` 捕获 `ImportError`，`self.error = "缺少 opencv-python: ..."`，不启动采集（`backend/camera.py:42-47`）；`has_frame()` 恒 False。
- 打开失败：`cv2.VideoCapture(index)` 重试 3 次、间隔 0.5s，失败写 error（`backend/camera.py:48-69`）；`atexit` 注册释放兜底（`36`、`85-92`）。
- 采集：`_capture_loop` 每 `interval_s`（默认 1.5s）读一帧，算全帧均值亮度，最长边压到 1280，JPEG 质量 80（`backend/camera.py:94-119`，`backend/config.py:78-79`、`112`）。
- 停用：取消任务并 `await` 它退出后再 `release()`，并清掉残留帧（`backend/camera.py:71-83`）。
- 自动恢复：看门狗每 15s 检查「开关开着但没帧且有 error」→ 重试 `set_sensors(True)`（`backend/main.py:259-281`）。
- **降级不彻底**：`camera.enabled` 仍为 True，`build_state().camera_enabled` 为 True（`backend/game_loop.py:91`），提示词会注入「每条玩家消息会附带一张最新实时画面」的观察指引（`backend/llm.py:187-194`），但 `_latest_image()` 因 `has_frame()==False` 返回 None（`backend/game_loop.py:172-176`）→ 模型被要求看图却看不到图。旧分析未提这一点。

### 6.2 麦克风（sounddevice，无转写）

注：本小节未注路径的行号均指 `backend/audio.py`。

- 代码只做**电平检测**：`backend/audio.py:2` 明确「只测音量大小，不识别内容」。启动只 import `sounddevice`（`backend/audio.py:60-70`），循环里再 import `numpy`（`backend/audio.py:88`）——numpy 是隐式依赖（`requirements.txt` 未列，但打包时显式安装，`packaging/build_release.py:131`）。
- 缺 `sounddevice`：`ImportError` → `error` 带两种提示（打包态提示「下载最新版本」/源码态提示 pip install，`backend/audio.py:62-69`），不启动监听。
- `InputStream(samplerate=16000, channels=1, dtype="float32")` 回调攒 buffer，每 `interval_s` 拼起来算 RMS（`backend/audio.py:91-117`）；打开失败重试 3 次（`101-126`）。
- **没有 faster-whisper**：`requirements.txt:1-9` 无 whisper；`packaging/build_release.py:163` 显式 `--exclude-module faster_whisper`；全仓库 Python/TS 代码 grep `whisper` 只命中 README 与打包排除项。README `README.md:112`、`config/config.example.yaml:57-64` 的 Whisper 文案是**过时文档**。
- `on_text` 回调与 `last_text` 是死代码：构造时保存（`backend/audio.py:17/27`），但监听循环只调用 `_report_moan`（`118-121`、`132-145`），从来不调用 `on_text`，`last_text` 永远为空串（`33`、`153`）；`backend/main.py:128-131` 的 `on_audio_text` 因此永不触发（旧分析「faster-whisper → 文本」不成立，见 §8.2 E1）。
- 状态输出：`running` 看任务是否存活（`backend/audio.py:152`）、`level`、`level_pct`（相对惨叫档的百分比，`149-157`）、`silent`（90s 无声，`159`）、`error`。

### 6.3 其它缺依赖/可选组件

- pywebview 缺失/WebView2 缺失：壳给出安装提示（`desktop/shell.py:153-170`）。
- Ollama：只是 start.bat 的可选便利（`start.bat:18-30`）；后端本身不感知 Ollama，视觉端点由 `llm.vision.base_url` 决定（`backend/llm.py:257-266`）。
- 传感器开关与生命周期：运行时不持久化（`backend/main.py:121-125`）；`set_sensors(on)` 按 `sensor_switches` 启动/停止（`221-235`）；自动运行开关会同时启动/停止传感器（`backend/main.py:698-705`）；浏览器全断开 30s 后自动关（`248-257`）；自动运行开着但有浏览器才启传感器（`293-294`）。

---

## 7. 配置 schema（三份 YAML + 运行时生成文件）

### 7.1 `config/config.yaml`（主配置；不存在时回退 `config.example.yaml`，`backend/config.py:128-136`）

DEFAULTS（`backend/config.py:29-105`）与实际 load 流程（`128-178`）：

| 小节 | 字段（默认值） | 证据 |
|---|---|---|
| `app` | `host=127.0.0.1`、`port=8000`、`dry_run=True`（示例改 false）、`title=Coyote in Cradle`、`sensor_idle_timeout_s=30` | `backend/config.py:30-36`；`config/config.example.yaml:4-8` |
| `relay` | `url=ws://127.0.0.1:9998`、`reconnect_delay_s=3`、`lan_ip=auto`、`public_url=""` | `backend/config.py:37`；`config/config.example.yaml:10-14` |
| `llm` | `base_url`、`api_key`、`model`、`temperature=1.0`、`max_tokens=1500`、`timeout_s=60`、`json_mode=true`、`vision.{base_url,api_key,model}` | `backend/config.py:38-51`；`config/config.example.yaml:16-27` |
| `character_file` | `config/character.yaml`（不存在回退 example，并写回实际路径） | `backend/config.py:52`、`150-157` |
| `safety` | `channels.A/B.max_strength=200`（钳 0~200）、`max_temp_duration_s=10`（≥1）、`max_strength_step=40`、`auto_clear_on_disconnect=true`、`overheat_reduce_to=20` | `backend/config.py:53-59`、`159-165`；`config/config.example.yaml:32-41` |
| `playback` | `frame_ms=100`、`min_duration_s=3`、`max_duration_s=10`、`loop_batch_s=30`、`loop_overlap_s=0.3` | `backend/config.py:60-66`（实际被 `waveforms.yaml` 覆盖，`244-259`） |
| `ui` | `quick_strengths=[20,40,60,80]`、`baseline_strength{A:15,B:5}`、`default_wave=呼吸`、`default_temp_s=3`、`default_pulse_s=5` | `backend/config.py:67-73` |
| `camera` | `enabled=false`、`index=0`、`interval_s=1.5`、`auto_observe=true`、`observe_interval_s=10`、`dark_threshold=20.0` | `backend/config.py:76-83`；`config/config.example.yaml:50-55` |
| `audio` | `enabled=false`、`interval_s=4.0`、`threshold=0.005`、`min_segment_s=0.8`、`model_size=small`、`language=zh`（后三者对现行代码无效）、`moan_high_multiple=4.0`、`moan_cooldown_s=5.0`、`silence_timeout_s=90.0` | `backend/config.py:84-95`；`backend/audio.py:18-28` 实际读取范围 |
| `log` | `dir=logs`、`level=INFO`、`history_keep=40` | `backend/config.py:96`；`backend/game_loop.py:32/142` |
| `autopilot` | `enabled=false`、`interval_s=12` | `backend/config.py:98`；`config.example.yaml` 未收录该节（只用 DEFAULTS） |
| `device_channels` | `A{name:贴片,location:小穴,baseline:15}`、`B{name:肛塞,location:后穴,baseline:5}` | `backend/config.py:101-104` |
| `presets` / `waveform_data` | 由 `waveforms.yaml` + 内置 `waveforms.py` 合成 | `backend/config.py:167-168`、`244-311` |

加载顺序：读 YAML → 深合并 DEFAULTS（`108-115`、`135-136`）→ 环境变量覆盖 `dry_run`/`api_key`（`139-148`）→ 加载角色（`150-157`）→ 数值钳制（`159-165`）→ 加载波形（`167-168`）→ 加载通道配件（`170-171`）→ 建日志目录（`173-176`）。
LLM 设置页保存时会**文本级**改写 `config.yaml` 的 `llm` 小节（只认 2 空格缩进键，保留注释），不是 YAML 回写（`backend/main.py:727-749`）。

### 7.2 `config/character.yaml`（角色设定；运行时覆盖在 `character_runtime.yaml`）

- 新格式 `roles.<角色>.{name,title,device_narrative,profiles.<风格>.{level,note,prompt_file,examples}}`；旧平铺格式会被包装成单角色「触手」（`backend/config.py:393-422`）。
- `prompt_file` 实际存在性 = 该风格档 `available`（`backend/config.py:438-445`、`353-359`）；页面切换时若不可用直接拒绝并返回 `dlc_missing`（`backend/main.py:526-533`）。
- `prompt` 字段只在 `prompt_file` 读不到时兜底（`backend/config.py:460-463`）；`examples` 来自 profile 或顶层（`465-467`、`334-350`）。
- 风格档 `level` 决定 `rage_baseline`：轻 0 / 中 1 / 重 2（`backend/config.py:473-487`）。
- 运行时覆盖：`role`/`profile`/`player_nick` 存 `config/character_runtime.yaml`（`backend/config.py:319-331`、`494-511`），下次启动仍生效。
- 示例文件即实况结构（`config/character.example.yaml:12-66`）：默认 `role: 触手`、`纯爱` 档配 `content/pure/触手-角色提示词-纯爱.md`、`调教` 档的 prompt_file 被注释（未装 DLC1）。

### 7.3 `config/waveforms.yaml`（播放参数 + 波形库 + 自定义波形）

- 结构：`playback`（`config/waveforms.yaml:1-6`）→ `presets`（`:7-127`）→ `custom`（`:128-963`）。
- `presets` 共 **24** 个中文名，字段 `waveform`（引用 `custom` 的键，如 `wave_挤压`）、`default_duration_s`、`max_duration_s`、`category`（如 `config/waveforms.yaml:8-12`）。
- `custom` 共 **24** 个波形，字段 `label` + `frames[]`（每个元素是 8 字节十六进制串 `a1a2a3a4b1b2b3b4`，`backend/waveforms.py:4`、`config/waveforms.yaml:131-135`）。帧数 2~84 不等，合计 763 帧（本笔记统计 `config/waveforms.yaml`；非源码常量）。
- 合并逻辑：内置 `WAVEFORMS`（`backend/waveforms.py:8-129`，24 个键，注释说明数据移植自 dglab-kit / dungeonlab-open，MIT）→ `custom` 覆盖/追加（`backend/config.py:262-275`）→ `presets` 渲染成安全层与提示词用的库（`backend/config.py:277-307`）；引用不存在的 waveform 跳过并 warning（`288-290`）；`default/max_duration_s` 都会再与 `playback` 上限取 min（`292-305`）。
- 生效帧间隔 100ms（`backend/config.py:61`、`backend/waveforms.py:4`），与循环波形分批参数 `loop_batch_s=30`、`loop_overlap_s=0.3`（`backend/config.py:64-65`）共同决定重发节奏。

### 7.4 DLC 目录约定（`content/pack/DLC*`）

- 目录名：`content/pack/DLC<序号>-<角色>-<风格>`，例如 `DLC1-触手-调教版`、`DLC2-品评会-调教`（`README.md:17`、`config/character.example.yaml:7-8/33-34/52`；导入分组正则见 `backend/main.py:587-608`）。
- 文件命名：`<角色>-角色提示词-<风格>.md`、`<角色>-语料库-<风格>.md`、`<角色>-漫画设定-<风格>.md`（`README.md`「项目内容」表；`backend/main.py:606-608` 从文件名 `<主题>-角色提示词-<风格>.md` 解析主题）。
- 导入接口 `POST /api/dlc/import`（`backend/main.py:550-696`）：只收 `.zip`/`.md`、上限 50MB（`559-565`）；Windows zip 中文名 cp437→UTF-8 修复（`579-586`）；按 `DLC\d+-.+?-.+` 或顶层目录分组（`591-601`）；落盘 `content/pack/<组>/`（`611-617`）。
- 自动接通：找含「角色提示词」的 md → 已存在角色则把对应风格的 `prompt_file` 指过去并把 `level` 修正为「中」（`621-652`）；新角色自动在 `roles:` 追加角色块（`653-658`、`backend/config.py:607-654`）；之后 `reload_character` 热加载（`672`）。这一整套是**文本级 YAML 编辑**（`backend/config.py:514-604`），依赖缩进/注释位置，注释掉的 `prompt_file:` 也能被替换（`584-600`）。
- 仓库内 `content/` 只有内置纯爱内容：`content/pure/` 3 个文件（`触手-角色提示词-纯爱.md` 158 行、`触手-漫画设定-纯爱.md` 140 行、`触手-语料库-纯爱.md` 89 行，合计 387 行；标题层级统计 25/22/7 个 `#` 行）。按任务要求只统计结构：三者分别承担「运行时提示词（含输出格式/风格/规则/边界）」「世界观与角色设定」「按风格分类的描写语料」；`content/pack/` 在仓库中不存在，由导入接口创建（`backend/main.py:567-568`）。内容为成人向被分析数据，本笔记不转述、不引用其文字。

### 7.5 运行时生成/写入的文件

| 文件 | 谁写 | 证据 |
|---|---|---|
| `config/config.yaml` | 设置页保存 LLM 时从 example 复制并改写 | `backend/main.py:759-766` |
| `config/character.yaml` | DLC 导入自动 patch / add role | `backend/config.py:514-654` |
| `config/character_runtime.yaml` | 角色/风格/昵称切换 | `backend/config.py:319-331`、`494-511` |
| `config/device_channels.yaml` | 配件/通道开关/基准修改 | `backend/config.py:181`、`212-241` |
| `logs/app.log` | 后端日志（控制台 + 文件，无复盘审计） | `backend/logging_utils.py:21-26`（`backend/logging_utils.py:2` 明确「无复盘日志」） |
| `logs/shell.log`、`logs/shell-<tag>.log` | 桌面壳与子进程输出 | `desktop/shell.py:39-45`、`80-94` |
| `version.txt` | 版本号（打包时写入，源码态显示 dev） | `backend/main.py:50-57` |

---

## 8. 证据表

### 8.1 关键断言 → 证据（可直接抽查）

| # | 断言 | 证据（文件:行号） | 关键值/说明 |
|---|---|---|---|
| 1 | 中继默认端口 9998、路径前缀 `/`、监听所有接口 | `relay/v4-server.ts:4`、`14`、`463` | `PORT=9998`、`PREFIX='/'`、`hostname:'::'` |
| 2 | 后端默认连 `ws://127.0.0.1:9998`，3s 重连 | `backend/config.py:37`、`backend/relay_client.py:92-113` | `reconnect_delay_s=3` |
| 3 | FastAPI 默认 `127.0.0.1:8000` | `backend/config.py:31-32`、`run_app.py:26-31` | `host=127.0.0.1`、`port=8000` |
| 4 | 后端托管 `frontend/dist`，未构建返回提示文本 | `backend/main.py:47`、`328-340` | 有 `index.html` 才 FileResponse |
| 5 | 配对二维码 = dungeon-lab 短链 + `ws://lan:9998?tid=controllerId` | `backend/main.py:84-90`、`346-368`；`relay/README.md:130-139` | `action=socket`、`tid=` |
| 6 | 控制方连上先收 `hello{clientId}`，被控方带 `tid` 接入 | `relay/v4-server.ts:118-120`、`127-131`、`445-448` | clientId 8 位 hex（`24`、`275-286`） |
| 7 | 中继只转发 `type/clientId/data`，不解析设备指令 | `relay/v4-server.ts:158-204`；`relay/README.md:128` | 业务层不透传解析 |
| 8 | 设备指令帧为 `{type:message,clientId,data:{t:req,reqId,m:device.op,data:{s,c,t,d,v,im}}}` | `backend/device_ops.py:4-12`、`31-53` | `t=0/3/4/7` 四种动作 |
| 9 | 绝对强度不可靠 → 全部换算成 AddIntensity 差值 | `backend/game_loop.py:6-8`、`535-539`；`backend/device_ops.py:55-63` | 实测结论注释 |
| 10 | `hold_strength` 无步长限制，只有 add_strength 限 ±40 | `backend/safety.py:149-161` vs `163-176`（168）；`backend/game_loop.py:535-539` | `max_strength_step=40` |
| 11 | 通道硬上限默认 200、用户上限初值 100、过热降到 20 | `backend/config.py:54`、`backend/safety.py:28-38`、`66-70` | `200 / 100 / 20` |
| 12 | 过热/舒适上限来自 App 的 `slotState.channelA/B.comfortLimit` | `backend/safety.py:300-312`；`backend/main.py:147-154`；`backend/relay_client.py:174-184` | `overheat`、`comfortMax`→`absoluteMax` |
| 13 | `app_caps` 不参与安全钳制，只进状态与提示词 | `backend/safety.py:66-70` vs `303-312`、`324`；`backend/llm.py:176-182` | 提示词仅提醒 |
| 14 | 波形播放期间忽略设备上报强度 | `backend/safety.py:294-299`；`backend/game_loop.py:261-267` | `pulse_until` 锁 |
| 15 | 波形/临时强度时长上限 10s、下限 3s/1s | `backend/safety.py:196-198`、`142`；`backend/config.py:62-63` | pulse 3~10；temp 1~10 |
| 16 | `waveforms.yaml` 的 30s 被代码钳到 10s | `config/waveforms.yaml:11-13`；`backend/config.py:292-305` | 实际生效 10s |
| 17 | 急停 = 清循环波形 + clear + 负 AddIntensity + t=7 归零 | `backend/game_loop.py:697-709`、`553-584`；`backend/safety.py:238-244` | 不发帧条件 `dry_run` |
| 18 | 急停后安全层拒绝一切动作、提示词要求 actions 空 | `backend/safety.py:95-96`；`backend/llm.py:183-184` | `estop_active` |
| 19 | 手动控制走与 AI 相同的 `execute_actions`/`validate` | `backend/main.py:413-420`；`backend/game_loop.py:442-519` | 无第二条手动链路 |
| 20 | 但保底流程 `_apply_channel_floor` 不经过 `validate` | `backend/game_loop.py:395-440`（418-432） | 旁路，仅 `record` |
| 21 | 用户消息回合顺序：reload → rage → state → llm → execute → floor | `backend/game_loop.py:135-169` | 详见 §3.1 |
| 21b | 保底路径调用未定义方法 `_scale_cmd`（潜在 AttributeError） | 调用 `backend/game_loop.py:419`、`429`；全仓库无 `def _scale_cmd`；静态扫描仅此一个未定义 `self.` 方法 | 触发见 §4.8 |
| 22 | 自动运行周期 12s、需 paired 或 dry-run | `backend/config.py:98`、`backend/game_loop.py:48`、`310-325` | `interval_s=12` |
| 23 | 自动观察周期 10s、必须 paired 且有帧 | `backend/config.py:81`、`backend/game_loop.py:221-259` | `observe_interval_s=10` |
| 24 | 摄像头黑屏判据 = 平均亮度 < 20.0，无人体检测 | `backend/camera.py:22`、`130-139`；`backend/config.py:82` | `dark_threshold=20.0` |
| 25 | 无声判据 = 90s 未超音量阈值，且麦克风 running | `backend/audio.py:159`、`backend/config.py:94`、`backend/game_loop.py:70-73` | `silence_timeout_s=90` |
| 26 | 怒气三档阈值 1/3/5，并叠加风格档 baseline 0/1/2 | `backend/llm.py:195-211`；`backend/game_loop.py:115`；`backend/config.py:487` | 轻0/中1/重2 |
| 27 | 呻吟 high 阈值 = 0.005×4.0=0.02，同档冷却 5s | `backend/audio.py:132-145`；`backend/config.py:87/92/93` | `moan_high_multiple=4.0` |
| 28 | 呻吟提示注入：high 降/安抚，low 加码；notes 只留 5 条 | `backend/main.py:134-144`；`backend/game_loop.py:722-729`；`backend/llm.py:218-219` | `notes[-5:]` |
| 29 | 无语音转写；`on_text`/`last_text` 是死代码 | `backend/audio.py:2`、`27`、`33`、`118-121`、`132-145`；`backend/main.py:128-131` | 仅 RMS 分级 |
| 30 | 无 faster-whisper 依赖，打包时显式排除 | `requirements.txt:1-9`；`packaging/build_release.py:163` | README 过时 |
| 31 | 摄像头缺 opencv 时 error 但不崩、可看门狗重试 | `backend/camera.py:42-47`；`backend/main.py:259-281` | 15s 重试 |
| 32 | 摄像头 enabled 但无帧时提示词仍注入「附带画面」 | `backend/game_loop.py:91`、`172-176`；`backend/llm.py:187-194` | 降级不彻底 |
| 33 | LLM 端点 = `{base_url}/chat/completions`，Bearer 鉴权 | `backend/llm.py:248-249`、`303-305` | OpenAI 兼容 |
| 34 | json_mode 时请求 `response_format=json_object` | `backend/llm.py:300-302`；`backend/config.py:45` | 默认 true |
| 35 | 解析容错：整体 JSON → 去围栏 → 首个 `{...}` | `backend/llm.py:223-242` | 失败返回 `{}` |
| 36 | 3 次请求重试 + 两次硬约束注入；零温度兜底不生效 | `backend/llm.py:311-349`、`351-353` | 第 3 次后无第 4 次请求 |
| 37 | content 空时取 reasoning_content，两空抛错 | `backend/llm.py:316-321`、`330-334` | 推理模型兜底 |
| 38 | 系统提示词含 7 op 规范、波形名铁律、双通道协同 | `backend/llm.py:58-89`、`76-78`、`164-175` | 有 prompt_file 时省略格式段 |
| 39 | 波形列表来自 presets，中文名即 pattern 可选值 | `backend/llm.py:12-22`、`76`；`backend/config.py:277-307` | 24 个 |
| 40 | 设备映射 A/B 绑定配件名、位置与基准强度 | `backend/config.py:101-104`；`backend/llm.py:121-175` | 贴片15/肛塞5 |
| 41 | `character.prompt` 来自 prompt_file，缺失才用 YAML `prompt` | `backend/config.py:460-463`、`362-371` | 热加载 `314-316` |
| 42 | 风格档不可用（DLC 未装）时拒绝切换 | `backend/main.py:508-538`、`backend/config.py:438-445` | `dlc_missing` |
| 43 | DLC 目录约定 `DLC<序号>-<角色>-<风格>`，自动 patch prompt_file | `backend/main.py:587-673`；`backend/config.py:514-654`；`README.md:17` | 文本级 YAML 编辑 |
| 44 | 波形数据 24 个内置 + 24 个 custom，帧格式 8 字节 hex | `backend/waveforms.py:8-129`；`config/waveforms.yaml:128-963` | 合计 763 帧（统计） |
| 45 | 日志只有运行日志，无审计/复盘日志 | `backend/logging_utils.py:1-27`（第 2 行自述） | 控制台 + app.log |
| 46 | 壳拉起中继/后端、等 `/api/state`、开 pywebview 窗口、关窗 taskkill | `desktop/shell.py:25`、`97-108`、`135-163`、`111-124` | 单实例互斥 `24` |
| 47 | 空闲 5 分钟无被控方 → 中继 4002 关连接；后端重连换新 controllerId | `relay/v4-server.ts:12`、`340-353`；`backend/relay_client.py:92-113` | 二维码会失效 |
| 48 | 后端从不主动 `devices.get`，设备列表依赖 App 推送 | `backend/device_ops.py:98-100`（无调用点）；`backend/relay_client.py:163-173` | `request_devices` 死代码 |
| 49 | 后端/中继均无鉴权；中继对 LAN 开放 | `main.py` 全文件无中间件；`relay/v4-server.ts:463` | 仅随机 clientId 保护 |
| 50 | `sensors_on` 与浏览器连接联动、30s 空闲自动关传感器 | `backend/main.py:237-257`、`293-294`；`backend/config.py:35` | `sensor_idle_timeout_s=30` |

### 8.2 旧分析（`项目分析-AI-for-Coyote.md`）勘误表

| # | 旧断言 | 代码事实 | 证据 |
|---|---|---|---|
| E1 | 「麦克风呻吟分级（faster-whisper → 文本；无文字片段按电平分级）」 | **无任何 STT**：只由 sounddevice 采 RMS 分级；`on_text`/`last_text` 死代码；requirements 无 whisper，打包显式排除 | `backend/audio.py:2`、`27`、`118-121`、`132-145`；`requirements.txt:1-9`；`packaging/build_release.py:163` |
| E2 | 「玩家说的话是通过麦克风转写的」（§2.4 末段，且与同段「无 STT 转写」自相矛盾） | 不转写、不引用玩家语音内容 | `backend/audio.py:2`、`120` |
| E3 | 「摄像头周期检测黑屏/无人」 | 只测全帧平均亮度 < 20.0；无人体/人脸检测代码 | `backend/camera.py:22`、`130-139`；全库 grep 无 face/person |
| E4 | 「单条指令强度变化 ≤ 40（`max_strength_step`）——防跳变」 | 仅 `add_strength` 钳 ±40；`hold_strength`/`temp_strength` 无步长限制，一条 hold 可 0→上限 | `backend/safety.py:163-176` vs `149-161`；`backend/game_loop.py:535-539` |
| E5 | 「A/B 通道轮流使用（避免只动一个通道）」 | 代码要求**每轮两个通道都给动作**（双通道协同），不是轮流 | `backend/llm.py:164-175`；`backend/game_loop.py:395-440` |
| E6 | 「内置 24 个官方波形（`waveforms.yaml`，64 帧）」 | 24 个 preset + 24 个 custom 波形；每个波形 2~84 帧，合计 763 帧；「64 帧」无来源 | `config/waveforms.yaml:7-127`、`128-963`；`backend/waveforms.py:8-129` |
| E7 | 「反馈按钮（App 上的 custom.action 0-9，或页面的按钮）注入…」 | 只有 App 的 `custom.action` 会调用 `handle_feedback`；前端没有任何反馈按钮 | `backend/relay_client.py:185-190`；`backend/main.py:174-176`；`backend/game_loop.py:722-724` |
| E8 | 「3 次重试 + 硬约束注入 + 零温度兜底」 | 零温度设置发生在第 3 次失败之后、循环随即结束，**没有第 4 次请求**，该兜底不生效 | `backend/llm.py:311-349`、`351-353` |
| E9 | 「中继/App 断开 → 自动清零」 | 只是取消循环波形 + 本地 `current` 清零（`record(stop)`），**不发送任何设备命令**；且受 `auto_clear_on_disconnect` 开关控制 | `backend/main.py:159-161`；`backend/game_loop.py:715-719`；`backend/config.py:57` |
| E10 | 「过热 → 该通道上限临时降到 20」 | 成立，但前提是 App 上报 `comfortLimit.overheat`；本程序不主动探测，也无自动解除 | `backend/safety.py:303-306`、`66-70`；`backend/config.py:58` |
| E11 | 「每通道独立上限（配置，默认 100；UI 可调到硬上限 200）」 | 硬上限默认 200，用户上限初值 100（`min(100,caps)`）；表述反了默认值归属 | `backend/config.py:54`；`backend/safety.py:33`；`backend/main.py:483-506` |
| E12 | 「它证明 `comfortLimit` 是自报安全代」（暗示程序按它钳制） | `comfortLimit` 只写 `app_caps` 供展示/提示词；`cap_for` 不读 `app_caps` | `backend/safety.py:66-70` vs `303-312`、`324`；`backend/llm.py:176-182` |
| E13 | 旧分析未提：观察循环与自动运行是**两个独立节奏**（10s / 12s），可叠加 | camera 开启时 observe 循环独立于 autopilot 运行，仅有 `turn_busy` 互斥 | `backend/game_loop.py:221-259`、`310-325` |
| E14 | 旧分析未提：`_apply_channel_floor` 绕过 `safety.validate` | 保底补强度/波形是第二条命令构造路径，不经步长/用户上限校验 | `backend/game_loop.py:395-440` |
| E15 | 旧分析未提：中继空闲 5 分钟会断开控制方、重连后 controllerId 变化（二维码失效） | `4002 idle_timeout` + 每 3s 重连；controllerId 无持久化 | `relay/v4-server.ts:12`、`340-353`；`backend/relay_client.py:92-113` |
| E16 | 旧分析未提：仓库还带 `v3-server.ts`（9999），但运行链路只用 v4 | `package.json` 有 v3/v4 两脚本；start.bat/壳只启 v4 | `relay/v3-server.ts:4`；`relay/package.json:7-12`；`start.bat:32-33`；`desktop/shell.py:141` |
| E17 | 旧分析未提：`camera.vision_prompt` 是死配置，`llm.describe_image`/`complete` 在 backend 无调用 | 定义但无引用 | `backend/camera.py:23-29`；`backend/llm.py:363-444` |
| E18 | 旧分析把双通道保底当「可靠产品特性」 | 保底路径调用未定义的 `_scale_cmd`，触发即抛 `AttributeError`（见 §4.8） | `backend/game_loop.py:419`、`429`（无定义） |

---

## 9. 架构图素材（组件清单 + 关系边）

### 9.1 组件清单（图里的所有节点）

| ID | 组件 | 类型 | 技术/形态 | 监听/端点 | 证据 |
|---|---|---|---|---|---|
| `shell` | 桌面壳 `Coyote-in-Cradle.exe` | 独立进程 | Python + pywebview | 无监听；子进程管理 | `desktop/shell.py:127-176` |
| `relay` | 中继 `dglab-websocket-server v4` | 独立进程 | Bun + `Bun.serve` | **9998**，监听 `::`，路径 `/` | `relay/v4-server.ts:4`、`14`、`462-477` |
| `backend` | 主程序 `AI-for-Coyote.exe` / `python -m backend.main` | 独立进程 | Python 3.10+、FastAPI + uvicorn | **8000**，默认 127.0.0.1 | `run_app.py:22-35`；`backend/config.py:31-32`；`backend/main.py:827-836` |
| `api` | FastAPI 应用（进程内模块） | 进程内 | 路由 + WebSocket `/ws` | `/api/*`、`/ws` | `backend/main.py:310-819` |
| `ui` | React 前端（浏览器/WebView2 内） | 进程内（浏览器侧） | React 19 + zustand + Vite 构建 | 同源 `/api`、`/ws` | `frontend/src/api.ts:26-70`；`frontend/src/App.tsx:70-77` |
| `config` | 配置加载与角色/DLC 写盘（进程内模块） | 进程内 | PyYAML，`config/*.yaml` | 文件 | `backend/config.py:128-654` |
| `safety` | 安全层（进程内模块） | 进程内 | `SafetyManager` | 内存 | `backend/safety.py:24-348` |
| `loop` | 回合引擎 `GameLoop`（进程内模块） | 进程内 | asyncio 任务（autopilot/observe/pulse worker） | 内存 | `backend/game_loop.py:20-729` |
| `llm` | 模型客户端（进程内模块） | 进程内 | httpx.AsyncClient | 出网 HTTPS | `backend/llm.py:245-444` |
| `ops` | 设备帧构造 `DeviceOps`（进程内模块） | 进程内 | 纯函数 | 内存 | `backend/device_ops.py:25-100` |
| `relayc` | 中继客户端 `RelayClient`（进程内模块） | 进程内 | `websockets` 客户端 | 出站 WS → 9998 | `backend/relay_client.py:28-215` |
| `camera` | 摄像头（进程内模块 + 本机硬件） | 进程内 + 设备 | OpenCV `VideoCapture`（可选依赖） | 本机 USB/虚拟摄像头 index=0 | `backend/camera.py:16-140` |
| `mic` | 麦克风（进程内模块 + 本机硬件） | 进程内 + 设备 | sounddevice + numpy RMS（可选） | 本机音频输入 16kHz 单声道 | `backend/audio.py:16-162` |
| `wf` | 波形库（进程内数据 + YAML） | 进程内 | `waveforms.py` + `config/waveforms.yaml` | 文件 | `backend/waveforms.py:8-129`；`config/waveforms.yaml` |
| `phone` | DG-LAB 4.0 App（手机） | 外部设备 | 官方 App，SocketAPI v4 被控方 | 出站 WS → PC:9998?tid=… | `relay/README.md:107-166`；`backend/main.py:84-90` |
| `coyote` | 郊狼主机 A/B（实体硬件） | 外部硬件 | BLE，由手机 App 持有 | — | README 架构图；本仓库无 BLE 代码（全库无蓝牙依赖） |
| `cloud` | LLM API（OpenAI 兼容，可分离视觉端点） | 外部服务 | HTTPS `{base_url}/chat/completions` | 443/自定义 | `backend/llm.py:248-266`；`backend/config.py:38-51` |
| `ollama` | 本地视觉模型服务（可选） | 独立进程（可选） | Ollama `11434` | 127.0.0.1:11434 | `start.bat:18-30`；`config/config.example.yaml:24-27` |
| `vite` | Vite dev server（仅开发） | 独立进程（可选） | 5173，代理 `/api`、`/ws` | 127.0.0.1:5173 | `frontend/vite.config.ts:7-12` |
| `dl-lab` | dungeon-lab.cn 短链服务（外部） | 外部服务 | 二维码内容里的 `https://dungeon-lab.cn/s/?v=1&action=socket&url=…` | 公网 443 | `backend/main.py:88`；`relay/README.md:134-137` |

注：`relay/v3-server.ts`（9999）与 `packaging/`、`desktop/app.ico` 不属于运行架构；`v3` 只是仓库自带的旧协议实现，默认不启（`start.bat:33`、`desktop/shell.py:141`）。

### 9.2 关系边（from → to，协议/数据，方向）

| # | From → To | 协议/数据 | 方向 | 证据 |
|---|---|---|---|---|
| B1 | `shell` → `relay` | 子进程 `bun run v4-server.ts`（工作目录 `relay/`，无窗口，日志落 `logs/shell-relay.log`） | 单向启动/生命周期 | `desktop/shell.py:80-94`、`135-141` |
| B2 | `shell` → `backend` | 子进程 `AI-for-Coyote.exe` 或 `python -m backend.main` | 单向启动/生命周期 | `desktop/shell.py:142-147` |
| B3 | `shell` → `backend` | HTTP GET `/api/state` 轮询（最多 30s）确认就绪 | 请求/响应 | `desktop/shell.py:25`、`97-108` |
| B4 | `shell` → `ui` | `webview.create_window(url=http://127.0.0.1:8000)`；关窗 taskkill 全进程树 | 承载/控制 | `desktop/shell.py:153-163`、`111-124` |
| B5 | `ui` ↔ `backend` | HTTP `/api/*`（JSON；`/api/qrcode.png` 返回 PNG） | 双向请求/响应 | `backend/main.py:342-803`；`frontend/src/api.ts:26-70` |
| B6 | `backend` → `ui` | WebSocket `/ws` 推送 `{"type":"state","data":{…}}`、`{"type":"chat",line,executed,dropped}` | 单向推送（客户端只发心跳，服务端忽略） | `backend/main.py:179-199`、`806-819`；`frontend/src/App.tsx:70-77` |
| B7 | `backend` → `ui` | 托管 `frontend/dist/index.html` 与 `/assets/*` | 静态文件下发 | `backend/main.py:328-340` |
| B8 | `relayc` → `relay` | WS 出站 `ws://127.0.0.1:9998`，`ping_interval=20/ping_timeout=20/open_timeout=10`，断线 3s 重连 | 双向长连接 | `backend/relay_client.py:92-113`；`backend/config.py:37` |
| B9 | `relay` → `relayc` | 帧：`hello{clientId}`、`client_attached`、`client_disconnected`、`error`、`message{clientId,data}`、`heartbeat`、`idle_timeout` | 下行 | `relay/v4-server.ts:118-120/333/250-253/162-167/192-196/90-96/347` |
| B10 | `relayc` → `relay` | 帧：`{type:"message",clientId:<phone clientId>,data:{t:"req",reqId,m:"device.op",data:{s,c,t,d,v,im}}}`；也支持 `device.op.clear`、`devices.get`（未用） | 上行（控制指令） | `backend/device_ops.py:31-100`；`backend/relay_client.py:199-208` |
| B11 | `relay` → `phone` | 转发 `{"type":"message","data":<原 data>}`（目标 `tid`） | 下行 | `relay/v4-server.ts:170-186` |
| B12 | `phone` → `relay` | `message{data:{t:"ev",ev:"devices.snapshot"|"devices.patch"|"slots.patch"|"custom.action",...}}`；`{t:"resp"}` | 上行 | `backend/relay_client.py:161-197`（协议注释 `:4-8`） |
| B13 | `phone` → `coyote` | BLE（DG-LAB App 内部实现；本仓库无 BLE 代码） | 双向 | 仓库依赖说明 `README.md:20-26`；`relay/README.md:109-113` |
| B14 | `ui` → `phone`（经二维码） | 用户用手机 App 扫 `/api/qrcode.png`，内容为 dungeon-lab 短链，解码得 `ws://<lan>:9998?tid=<controllerId>` | 带外（扫码） | `backend/main.py:84-90`、`346-358`；`relay/README.md:130-139` |
| B15 | `ui` → `dl-lab`（间接） | 二维码 URL 指向 `dungeon-lab.cn/s/`（App 解析） | 带外 | `backend/main.py:88` |
| B16 | `phone` → `relay` | 被控方接入 `?tid=<controllerId>`（`targetId` 等价） | 双向长连接 | `relay/v4-server.ts:445-448`、`298-338` |
| B17 | `llm` → `cloud` | HTTPS POST `{base_url}/chat/completions`，Bearer key；可选 `response_format=json_object`；图片以 `data:image/jpeg;base64` 内联在最后一条 user 消息 | 请求/响应 | `backend/llm.py:248-305`；`backend/llm.py:280-293` |
| B18 | `llm` → `ollama`（可选） | 视觉端点 `{vision.base_url}/chat/completions`（示例 `http://127.0.0.1:11434/v1`） | 请求/响应 | `backend/llm.py:257-266`、`363-412`；`config/config.example.yaml:24-27` |
| B19 | `camera` → `loop` | 本机帧 JPEG（base64）注入模型请求 | 数据上送 | `backend/camera.py:94-125`；`backend/game_loop.py:172-176` |
| B20 | `mic` → `loop` | 本机 RMS 电平 → `on_moan(kind,level)` → `loop.add_note` | 数据上送（事件） | `backend/audio.py:117-121`、`132-145`；`backend/main.py:134-144` |
| B21 | `loop` → `safety` | `validate(action)` 逐条校验 | 进程内调用 | `backend/game_loop.py:457`；`backend/safety.py:84-235` |
| B22 | `loop` → `ops` | `_build_frames` 生成 V4 报文 | 进程内调用 | `backend/game_loop.py:521-585`；`backend/device_ops.py:25-100` |
| B23 | `loop` → `relayc` | `_send_all` → `send_frame`（唯一发送点） | 进程内调用 | `backend/game_loop.py:675-676`；`backend/relay_client.py:199-208` |
| B24 | `relayc` → `loop` | 事件回调：`on_relay_event`/`on_relay_action`（`AppState` 转发） | 进程内回调 | `backend/main.py:101-106`、`147-176`；`backend/relay_client.py:210-215` |
| B25 | `main` → `safety` | `slots.patch` → `update_device_state(props,slotState)` | 进程内调用 | `backend/main.py:147-154`；`backend/safety.py:283-312` |
| B26 | `loop` → `config` | `reload_character` 每回合热加载；读 `cfg` 参数 | 进程内调用 + 文件读 | `backend/game_loop.py:139`、`backend/config.py:314-316` |
| B27 | `main` → 文件系统 | DLC 导入写 `content/pack/`、patch `character.yaml`；设置页写 `config.yaml`；`device_channels.yaml`；`character_runtime.yaml`；`logs/app.log` | 写文件 | `backend/main.py:550-778`；`backend/config.py:212-241`、`494-654`；`backend/logging_utils.py:21-26` |

### 9.3 一条设备命令的端到端链路（画时序图可直接用）

1. 触发源：`ui` 的 `/api/manual`（`backend/main.py:413-420`）或 AI 回合产生的 `actions`（`backend/game_loop.py:163`）。
2. `ui` → `backend` HTTP POST JSON `{op, channel, value/pattern/duration_s/delta}`（`frontend/src/commands.ts:26-37`）。
3. `backend` 进 `loop.execute_actions`：`safety.validate` 钳制/白名单/步长/时长/过热/通道开关（`backend/game_loop.py:453-461`，`backend/safety.py:84-235`）。
4. 若该通道无波形承载，自动挂默认持续波形（`backend/game_loop.py:473-477`、`373-393`）。
5. `ops._build_frames`：hold/temp → `t=3 AddIntensity(差值)`；pulse → `t=0` 平铺帧；clear/stop → `device.op.clear` + 负 AddIntensity + `t=7 v=0`（`backend/game_loop.py:521-585`）。
6. `relayc.send_frame` → WS 9998，外层带 `clientId=<phone 被控方 ID>`（`backend/relay_client.py:199-208`）。
7. `relay` 只按 `clientId` 转发该 `data`（`relay/v4-server.ts:170-186`）。
8. `phone` 执行并（周期性）上行 `slots.patch` → `relay` → `relayc` → `main.on_relay_event` → `safety.update_device_state` 同步 current/overheat/app_caps（`backend/relay_client.py:174-184`、`backend/main.py:147-154`、`backend/safety.py:283-312`）。
9. `backend` 广播新状态给所有页面 WebSocket（`backend/main.py:162`、`179-189`）。

### 9.4 一个 AI 回合的数据流（含图片）

`ui` POST `/api/chat` → `loop.handle_user_message`（`backend/main.py:395-399`、`backend/game_loop.py:135`）→ `_note_rage`（读 `camera.to_state()/audio.to_state()`）→ `build_state()`（`backend/game_loop.py:84-127`）→ `llm.chat`（系统提示词 = 角色 + 状态 + 安全 + 设备映射，`backend/llm.py:25-220`；最后一条 user 消息附 `data:image/jpeg;base64`，`backend/llm.py:280-293`）→ `cloud` → 解析 JSON（`backend/llm.py:223-242`；3 次尝试，`311-353`）→ `execute_actions`（见 §9.3）→ `_apply_channel_floor` 保底（`backend/game_loop.py:395-440`）→ 返回 `{line, executed, dropped}` → `ui` 渲染聊天/动作结果；自动回合则经 `on_ai_turn` → WS 推送（`backend/main.py:113`、`backend/game_loop.py:365-369`）。

### 9.5 画图要点（容易画错的边）

- `backend` **不直连** `coyote`，也不直连蓝牙；它只与 `relay` 说 WebSocket，`coyote` 由 `phone` 经 BLE 驱动（`relay/README.md:109-113`；仓库无蓝牙依赖）。
- `relay` 是**透明转发**，不是业务处理层；不要把 `slots.patch`/`comfortLimit` 画成 `relay` 产生（`relay/v4-server.ts:158-204`；只有 Python 端 `backend/safety.py:300-312` 消费）。
- `consent/comfort` 状态来源是 `phone`（App 计算），`backend` 只展示/提示，不做硬件级保护（`backend/safety.py:66-70` vs `303-312`）。
- `shell` 不参与数据面：它只 spawn 两个进程 + 开窗口 + 关窗清理（`desktop/shell.py:127-176`）。
- 端口：`relay` = 9998（对 LAN 开放，`::`）；`backend` = 8000（loopback）；`vite` = 5173（开发）；`ollama` = 11434（可选）；`v3-server` 的 9999 默认不启。
- 配对方向：`ui` 展示二维码 → 人用 `phone` 扫 → `phone` 主动连 `relay`；`backend` 只是生成 URL，不参与扫码（`backend/main.py:346-358`、`84-90`）。
- 安全边界：`backend` 8000 只绑 loopback；`relay` 9998 对 LAN 开放且**无鉴权**（`relay/v4-server.ts:463`、`298-338`）——图里若要标「信任边界」，应画在 PC 的 9998 与 Wi-Fi 之间。
