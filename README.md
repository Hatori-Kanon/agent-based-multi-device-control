# Embodied Roleplay

**Agent 主持的具身角色扮演系统**：摄像头/麦克风感知 + 多设备并行物理反馈，安全边界由硬件与人类共同持有。

[![check](https://github.com/Hatori-Kanon/agent-based-multi-device-control/actions/workflows/check.yml/badge.svg)](https://github.com/Hatori-Kanon/agent-based-multi-device-control/actions/workflows/check.yml)
[![license](https://img.shields.io/github/license/Hatori-Kanon/agent-based-multi-device-control)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)](package.json)

> 模型只能请求 0–100% 的相对强度；实际输出始终被人类设定的每通道软上限、硬件限幅与三条急停路径夹住。

## 特性

- **多设备并行**：郊狼 V3、谜姬 XHTKJ、安可尼 JH1、MonsterParty、Buttplug/Intiface
- **感知闭环**：摄像头、麦克风、心率带进入导演与写作上下文
- **回合引擎**：导演 → 写作 → 执行，支持阶段推进、选项与自动运行
- **内容包**：剧本 / 角色 / 阶段 / 波形，可校验、导入、覆盖安装
- **单窗口界面**：游玩 / 设备 / 设置 + 手机急停
- **离线可跑**：无硬件时用模拟设备与 demo 脚本

## 快速开始

需要 Node ≥ 22.19 与 pnpm 10。

```bash
pnpm install
pnpm run check        # typecheck + 单元测试
```

```powershell
.\start.bat           # 桌面端（Electron）
.\start-dev.bat       # 纯 Node 开发服务器，浏览器打开
.\start-dev.bat mock  # 演示模式：注册两台模拟设备
```

游玩页地址在启动日志里（带 token）：`http://<host>:<port>/play?token=…`。离线四步演示：`node scripts/demo-m2.mjs`。

## 后端与失效语义

| 后端 | 传输 | 形态 | 宿主进程死亡后 |
| --- | --- | --- | --- |
| 郊狼 V3 / 安可尼 JH1 | BLE | 单设备 | ✅ 自动归零（流式） |
| 谜姬 XHTKJ | BLE | 单设备 | ❌ 继续输出 |
| MonsterParty | WebSocket 云中继 | 单设备 | ❌ 继续输出 |
| Buttplug / Intiface | WebSocket 本机引擎 | 集线器（多设备） | ❌ 继续输出 |

## 结构

```
packages/core     纯 TS 引擎：设备后端、感知、回合、导演-写作-执行、内容包
apps/desktop      Electron 宿主 + 产品 UI（静态页面，无框架）
deliverables/     内容包制作包（模板 / 校验 / 安装）
analysis/         开发日志与审计记录（不参与构建）
```

## 文档

- [设计文档](设计文档.md)
- [内容包规范](内容包规范.md) / [内容包制作包](deliverables/content-pack-kit/README.md)
- [迭代记录](CHANGELOG.md)
- [开发日志与审计](analysis/)

## 安全

- 只有人类能修改每通道的强度 / 频率上下限；模型与内容包只写相对百分比
- 三条独立急停路径：`Ctrl+Alt+X`、`POST /panic`、手机 `/phone`
- 郊狼与安可尼是流式硬件，宿主停止刷新即归零；其余后端依赖宿主定时器兜底

## License

[MIT](LICENSE)
