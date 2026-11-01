#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""hw9cap.py — CooSpo HW9 BLE 抓包命令行（Windows / Python / bleak 路线）

对应分析计划：analysis/coospo-hw9-test-plan.md 路线 A（bleak）+ §4 记录纪律 + §5 数据格式。
运行环境（已实测）：Python 3.10.11 + bleak 3.0.2 + winrt-* 3.2.1，Windows 后端为 pywinrt；
本脚本按 bleak 3.x API 编写（BleakScanner.discover(return_adv=True) 返回 dict、
BleakClient(target, timeout=...)、client.services、BleakGATTCharacteristic.descriptors 等）。
设计原则：
  * 原始 hex 一律落盘，解析值只作附加字段（decoded）。
  * 每条通知带本机到达时间（ISO8601 带本地时区偏移 + 单调毫秒）。
  * 数据写 stdout（或 --out 文件），日志一律写 stderr —— 便于管道/重定向。
  * MAC 默认脱敏；保留真值时必须写到 _tools/.local/ 下（由脚本强制）。

用法（先看 _tools/README.md，bootstrap 需 Lead 批准后再执行）：
  python hw9cap.py --help
  python hw9cap.py scan --seconds 10 --out analysis/hw9-capture/_tools/.local/scan.jsonl
  python hw9cap.py info --address AA:BB:CC:DD:EE:FF
  python hw9cap.py gatt --address AA:BB:CC:DD:EE:FF --out gatt.json
  python hw9cap.py notify --address AA:BB:CC:DD:EE:FF --service heart_rate \
         --char heart_rate_measurement --seconds 600 --out notifications.jsonl
  python hw9cap.py reconnect --address AA:BB:CC:DD:EE:FF --times 3
  python hw9cap.py concurrency --address AA:BB:CC:DD:EE:FF --other AA:BB:CC:DD:EE:00 --seconds 60
  python hw9cap.py decode 164a0f030f03          # 离线自检 0x2A37 解码（不需要 bleak）
"""

from __future__ import annotations

import argparse
import asyncio
import json
import platform
import re
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

VERSION = "0.1.0"
TOOL_NAME = "bleak"  # notifications.jsonl 的 tool 字段（计划 §5：nrf|edge|harness，bleak 为本机新增）

# ── 路径/常量 ────────────────────────────────────────────────────────────────
# hw9cap.py 位于 analysis/hw9-capture/_tools/capture/ → 上两级是 _tools/
TOOLS_DIR = Path(__file__).resolve().parent.parent
LOCAL_DIR = TOOLS_DIR / ".local"  # 允许放未脱敏原始数据；Lead 负责把它加进 .gitignore

HRS_SERVICE = "180d"
HRS_CHAR = "2a37"
HRS_FLAG_U16 = 0x01
HRS_FLAG_CONTACT = 0x02
HRS_FLAG_CONTACT_SUPPORTED = 0x04
HRS_FLAG_ENERGY = 0x08
HRS_FLAG_RR = 0x10

# 标准 16-bit UUID → 名字（仅列常用；未列出的按“未知/厂商”处理）
SERVICE_NAMES = {
    "1800": "Generic Access",
    "1801": "Generic Attribute",
    "1805": "Current Time",
    "180a": "Device Information",
    "180d": "Heart Rate",
    "180f": "Battery",
    "1810": "Blood Pressure",
    "1812": "Human Interface Device",
    "1813": "Scan Parameters",
    "1814": "Running Speed and Cadence",
    "1816": "Cycling Speed and Cadence",
    "1818": "Cycling Power",
    "181a": "Environmental Sensing",
    "181b": "Body Composition",
    "181c": "User Data",
    "181d": "Weight Scale",
    "181e": "Bond Management",
    "181f": "Continuous Glucose Monitoring",
    "1822": "Pulse Oximeter",
    "1826": "Fitness Machine",
    "1827": "Mesh Provisioning",
    "1828": "Mesh Proxy",
    "183a": "Insulin Delivery",
    "1848": "Media Control",
    "184b": "Audio Input Control",
}

CHAR_NAMES = {
    "2a00": "Device Name",
    "2a01": "Appearance",
    "2a04": "Peripheral Preferred Connection Parameters",
    "2a05": "Service Changed",
    "2a19": "Battery Level",
    "2a24": "Model Number String",
    "2a25": "Serial Number String",
    "2a26": "Firmware Revision String",
    "2a27": "Hardware Revision String",
    "2a28": "Software Revision String",
    "2a29": "Manufacturer Name String",
    "2a37": "Heart Rate Measurement",
    "2a38": "Body Sensor Location",
    "2a39": "Heart Rate Control Point",
    "2a49": "Blood Pressure Feature",
    "2a4a": "HID Information",
    "2a4b": "Report Map",
    "2a4d": "Report",
    "2a6e": "Temperature",
    "2a6f": "Humidity",
    "2a5b": "CSC Measurement",
    "2a63": "Cycling Power Measurement",
    "2a98": "Weight Measurement",
    "2a9d": "Weight Scale Feature",
}

SERVICE_ALIASES = {
    "heart_rate": "180d",
    "battery_service": "180f",
    "device_information": "180a",
    "generic_access": "1800",
    "generic_attribute": "1801",
    "blood_pressure": "1810",
    "running_speed_and_cadence": "1814",
    "cycling_speed_and_cadence": "1816",
    "cycling_power": "1818",
    "environmental_sensing": "181a",
    "user_data": "181c",
    "pulse_oximeter": "1822",
    "fitness_machine": "1826",
}

CHAR_ALIASES = {
    "heart_rate_measurement": "2a37",
    "battery_level": "2a19",
    "manufacturer_name_string": "2a29",
    "model_number_string": "2a24",
    "serial_number_string": "2a25",
    "firmware_revision_string": "2a26",
    "hardware_revision_string": "2a27",
    "software_revision_string": "2a28",
    "body_sensor_location": "2a38",
    "heart_rate_control_point": "2a39",
    "device_name": "2a00",
    "user_description": "2901",
    "client_characteristic_configuration": "2902",
}

INFO_CHARS = [
    ("180a", "2a29", "manufacturer", "Manufacturer Name"),
    ("180a", "2a24", "model", "Model Number"),
    ("180a", "2a26", "firmware", "Firmware Revision"),
    ("180a", "2a27", "hardware", "Hardware Revision"),
    ("180a", "2a25", "serial", "Serial Number"),
    ("180a", "2a28", "software", "Software Revision"),
]

# 退出码（写进 README，便于自动化判断）
EXIT_OK = 0
EXIT_ERR = 1
EXIT_NO_BLEAK = 2
EXIT_NO_DEVICE = 3
EXIT_DISCONNECTED = 4
EXIT_BLEAK_ERROR = 5


# ── 通用工具 ─────────────────────────────────────────────────────────────────
class MissingDependency(RuntimeError):
    """缺少 bleak 时抛出，main() 转成清晰报错 + 退出码 2。"""


class UsageError(RuntimeError):
    """参数/前置条件不满足（如没给 --address/--name）。"""


class DeviceNotFound(RuntimeError):
    """扫描窗口内没找到目标设备。"""


def log(msg: str = "") -> None:
    """所有人类可读日志走 stderr，stdout 只留给 JSONL/JSON 数据。"""
    print(msg, file=sys.stderr)


def now_iso() -> str:
    """本地时区 + 毫秒偏移，符合计划 §5 示例：2026-11-01T17:31:02.412+08:00"""
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def _dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _ts_for_filename() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


class Mono:
    """单调时钟：monoMs = 自本命令开始（或指定基准）以来的毫秒数。"""

    def __init__(self) -> None:
        self._t0 = time.monotonic()

    def ms(self) -> int:
        return int(round((time.monotonic() - self._t0) * 1000))


class JsonlWriter:
    """JSONL 输出器：path=None 时写 stdout。每条立即 flush，断连/崩溃不丢已收数据。"""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._fh = None
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._fh = open(path, "w", encoding="utf-8", newline="\n")

    def write(self, row: dict) -> None:
        line = _dumps(row)
        if self._fh is not None:
            self._fh.write(line + "\n")
            self._fh.flush()
        else:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            except Exception:
                pass
            self._fh = None


def write_json_file(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class JsonlWriterProxy:
    """写 --out 文件，同时把摘要写 stderr；-out 省略时写 stdout。"""

    def __init__(self, args, default_stem: str, allow_stdout: bool = True) -> None:
        self.path = resolve_out(args, default_stem, allow_stdout=allow_stdout)
        self._w = JsonlWriter(self.path)

    def write(self, row: dict) -> None:
        self._w.write(row)

    def close(self) -> None:
        self._w.close()


def resolve_out(args, default_stem: str, allow_stdout: bool = True,
                default_suffix: str = ".jsonl") -> Path | None:
    """解析 --out。

    * 未给 --out 且允许 stdout → 返回 None（写 stdout）。
    * 未给 --out 且 --no-redact-mac → 自动写 _tools/.local/<stem>-<ts><suffix>。
    * --no-redact-mac 时若路径不在 _tools/.local/ 下 → 强制重定向，避免真实 MAC 落进交付物。
    """
    out = getattr(args, "out", None)
    redact = getattr(args, "redact_mac", True)
    if out is None:
        if redact or not allow_stdout:
            if allow_stdout:
                return None
            out = str(LOCAL_DIR / f"{default_stem}-{_ts_for_filename()}{default_suffix}")
        else:
            out = str(LOCAL_DIR / f"{default_stem}-{_ts_for_filename()}{default_suffix}")
            log(f"[redact 关闭] 未指定 --out，自动写入 {out}")
    p = Path(out).expanduser()
    if not p.is_absolute():
        p = Path.cwd() / p
    p = p.resolve()
    if not redact:
        local = LOCAL_DIR.resolve()
        try:
            p.relative_to(local)
        except ValueError:
            target = local / p.name
            log(f"[redact 关闭] 真实 MAC 只允许落在 {local}，已重定向：{target}")
            p = target
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def redact_addr(addr, redact: bool = True) -> str:
    """MAC 脱敏：保留前 3 字节（OUI，便于区分设备族），掩掉后 3 字节。"""
    if not addr:
        return ""
    s = str(addr)
    if not redact:
        return s
    parts = re.split(r"[:-]", s)
    if len(parts) == 6 and all(re.fullmatch(r"[0-9A-Fa-f]{2}", x) for x in parts):
        return ":".join([x.upper() for x in parts[:3]] + ["**", "**", "**"])
    # 非 MAC 形式（例如某些平台的 UUID 形式地址）整体掩掉，别猜
    return "**"


def _addr_digits(s) -> str:
    return re.sub(r"[^0-9a-f]", "", str(s or "").lower())


def _same_addr(a, b) -> bool:
    da, db = _addr_digits(a), _addr_digits(b)
    return bool(da) and da == db


def _rssi(dev, adv) -> int | None:
    """bleak 3.x：RSSI 在 AdvertisementData.rssi（BLEDevice 没有 rssi 属性）。"""
    return getattr(adv, "rssi", None) if adv is not None else None


def _dev_name(dev, adv) -> str:
    name = getattr(dev, "name", None)
    if not name and adv is not None:
        name = getattr(adv, "local_name", None)
    return name or ""


# ── UUID ─────────────────────────────────────────────────────────────────────
def normalize_uuid(value) -> str:
    """短名/0x 前缀/大小写统一成小写 UUID 字符串。"""
    s = str(value or "").strip().lower()
    s = s.replace("0x", "", 1) if s.startswith("0x") else s
    s = SERVICE_ALIASES.get(s, s)
    s = CHAR_ALIASES.get(s, s)
    if re.fullmatch(r"[0-9a-f]{4}", s):
        return "0000" + s + "-0000-1000-8000-00805f9b34fb"
    if re.fullmatch(r"[0-9a-f]{8}", s):
        return s + "-0000-1000-8000-00805f9b34fb"
    return s


def short_uuid(value) -> str:
    """规范化为短 UUID（16-bit 用 4 位），与计划 §5 的 notifications.jsonl 示例一致。"""
    full = normalize_uuid(value)
    if re.fullmatch(r"0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb", full):
        return full[4:8]
    return full


def service_name(value) -> str | None:
    return SERVICE_NAMES.get(short_uuid(value))


def char_name(value) -> str | None:
    return CHAR_NAMES.get(short_uuid(value))


# ── 0x2A37 解码（计划附录 A） ────────────────────────────────────────────────
def decode_hrs(data: bytes) -> tuple[dict, str]:
    """解码标准 Heart Rate Measurement。

    返回 (decoded, note)。note 记录异常（截断/尾随字节），正常时为 ""。
    """
    if not data:
        return {"error": "empty payload"}, "empty payload"
    flags = data[0]
    off = 1
    decoded: dict = {"flags": flags}
    if flags & HRS_FLAG_U16:
        if off + 2 > len(data):
            return {"flags": flags, "error": "truncated hr(uint16)"}, "truncated HR value"
        hr = int.from_bytes(data[off:off + 2], "little")
        off += 2
    else:
        if off + 1 > len(data):
            return {"flags": flags, "error": "truncated hr(uint8)"}, "truncated HR value"
        hr = data[off]
        off += 1
    decoded["hr"] = hr
    decoded["contactStatus"] = bool(flags & HRS_FLAG_CONTACT)
    decoded["contactSupported"] = bool(flags & HRS_FLAG_CONTACT_SUPPORTED)
    note_parts = []
    if flags & HRS_FLAG_ENERGY:
        if off + 2 > len(data):
            note_parts.append("truncated energyExpended")
        else:
            decoded["energyExpended"] = int.from_bytes(data[off:off + 2], "little")
            off += 2
    rr: list[float] = []
    if flags & HRS_FLAG_RR:
        while off + 2 <= len(data):
            raw = int.from_bytes(data[off:off + 2], "little")
            rr.append(round(raw * 1000.0 / 1024.0, 1))
            off += 2
    decoded["rrMs"] = rr
    if off != len(data):
        note_parts.append(f"trailing {len(data) - off} byte(s)")
    return decoded, "; ".join(note_parts)


# ── bleak 加载 ───────────────────────────────────────────────────────────────
def import_bleak():
    """延迟导入 bleak：`--help` / `decode` 不需要依赖，缺依赖时给清晰报错。"""
    try:
        import bleak  # noqa: F401
        from bleak import BleakClient, BleakScanner  # noqa: F401
    except ImportError as exc:
        raise MissingDependency(
            "未安装 bleak（Python BLE 依赖）。\n"
            "  本仓库不自动安装依赖。请先让 Lead 批准，然后二选一：\n"
            "    powershell -NoProfile -ExecutionPolicy Bypass -File "
            "analysis\\hw9-capture\\_tools\\capture\\bootstrap.ps1\n"
            "    <venv 的 python> -m pip install -r "
            "analysis\\hw9-capture\\_tools\\capture\\requirements.txt\n"
            "  然后使用 .venv 里的 python 运行本脚本；不要装进产品依赖。"
        ) from exc
    return bleak


def _bleak_version() -> str:
    """bleak 3.x 不再暴露 bleak.__version__，从包元数据取版本。"""
    try:
        from importlib.metadata import version
        return version("bleak")
    except Exception:
        return "unknown"


def _client_factory(bleak, target, args, disconnected_callback=None):
    """按 bleak 3.0.2 API 构造 BleakClient。

    * target 优先传扫描得到的 BLEDevice；只有找不到广播、按地址直连时才传字符串。
    * timeout 是 BleakClient 构造参数（bleak 3.x 签名支持）。
    * 配对/缓存等 Windows 参数（pair=、winrt={"use_cached_services": ...}）本工具不使用，
      见 README「bleak 3.x API 适配」一节。
    """
    return bleak.BleakClient(
        target, disconnected_callback=disconnected_callback, timeout=args.timeout
    )


async def _scan(seconds: float):
    """扫描并返回 [(BLEDevice, AdvertisementData), ...]。

    bleak 3.x 的 BleakScanner.discover(return_adv=True) 返回
    dict[address] -> (BLEDevice, AdvertisementData)。
    """
    bleak = import_bleak()
    found = await bleak.BleakScanner.discover(timeout=seconds, return_adv=True)
    return [item for item in found.values() if isinstance(item, tuple) and len(item) == 2]


def _select_target(rows, args):
    """按 --address / --name 选设备；多台同名时选 RSSI 最强并提示。"""
    if getattr(args, "address", None):
        for dev, adv in rows:
            if _same_addr(dev.address, args.address) or _same_addr(
                getattr(dev, "id", ""), args.address
            ):
                return dev, adv
        return None, None
    if getattr(args, "name", None):
        needle = args.name.lower()
        hits = [(dev, adv) for dev, adv in rows if needle in _dev_name(dev, adv).lower()]
        if not hits:
            return None, None
        hits.sort(key=lambda pair: _rssi(*pair) if _rssi(*pair) is not None else -999, reverse=True)
        if len(hits) > 1:
            log(f"警告：{len(hits)} 台设备匹配 --name '{args.name}'，按 RSSI 选最强的一台：")
            for dev, adv in hits:
                log(f"  {redact_addr(dev.address, args.redact_mac)}  "
                    f"rssi={_rssi(dev, adv)}  name={_dev_name(dev, adv) or '<no-name>'}")
        return hits[0]
    raise UsageError("请用 --address 或 --name 指定目标设备（先跑 scan 找到它）")


async def resolve_target(args):
    """扫描并返回 (device_or_address, adv)。找不到时报清晰错误。

    --address 时即使扫描窗口内没广播，也允许直接连接（Windows 对已缓存/已配对设备可用）。
    """
    rows = await _scan(getattr(args, "scan_seconds", 8.0))
    dev, adv = _select_target(rows, args)
    if dev is not None:
        log(f"已找到目标：{_dev_name(dev, adv) or '<no-name>'}  "
            f"{redact_addr(dev.address, args.redact_mac)}  rssi={_rssi(dev, adv)}")
        return dev, adv
    if getattr(args, "address", None) and not getattr(args, "name", None):
        log(f"警告：扫描窗口内没发现 {redact_addr(args.address, args.redact_mac)}，"
            f"尝试按地址直接连接（Windows 缓存/已配对设备可能可连）…")
        return args.address, None
    seen = "、".join(
        f"{_dev_name(d, a) or '<no-name>'}@{redact_addr(d.address, args.redact_mac)}"
        for d, a in rows
    ) or "（无任何广播）"
    raise DeviceNotFound(
        f"扫描 {getattr(args, 'scan_seconds', 8.0)}s 没找到匹配设备。\n"
        f"  扫描到：{seen}\n"
        f"  建议：先跑 `scan --seconds 15`；确认设备在广播、没被手机/官方 App 占用；"
        f"Windows 已配对缓存可能让 Web Bluetooth 看不到设备，必要时在设置里移除配对。"
    )


def _get_service(client, service_uuid):
    target = normalize_uuid(service_uuid)
    for svc in client.services:
        if normalize_uuid(svc.uuid) == target:
            return svc
    return None


def _find_char(service, char_uuid):
    target = normalize_uuid(char_uuid)
    for ch in service.characteristics:
        if normalize_uuid(ch.uuid) == target:
            return ch
    return None


def locate_char(client, service_uuid, char_uuid):
    """返回 (service, characteristic)；服务找不到时退化为全表搜索并提示。"""
    svc = _get_service(client, service_uuid)
    if svc is not None:
        ch = _find_char(svc, char_uuid)
        if ch is not None:
            return svc, ch
    for svc in client.services:
        ch = _find_char(svc, char_uuid)
        if ch is not None:
            log(f"注意：{short_uuid(char_uuid)} 不在 {short_uuid(service_uuid)} 下，"
                f"实际属于 {short_uuid(svc.uuid)}；已按实际位置订阅。")
            return svc, ch
    raise UsageError(
        f"设备没有特征 {short_uuid(char_uuid)}（服务 {short_uuid(service_uuid)}）。"
        f"先用 `gatt` 子命令看全量枚举结果。"
    )


# ── 输出格式辅助 ─────────────────────────────────────────────────────────────
def _adv_manufacturer_hex(adv) -> str | None:
    if adv is None:
        return None
    md = getattr(adv, "manufacturer_data", None) or {}
    if not md:
        return None
    # 多厂商时按 company id 升序拼接，便于一眼核对
    parts = [bytes(md[k]).hex() for k in sorted(md)]
    return "".join(parts)


def _adv_manufacturer_map(adv) -> dict:
    if adv is None:
        return {}
    md = getattr(adv, "manufacturer_data", None) or {}
    return {f"0x{k:04x}": bytes(v).hex() for k, v in md.items()}


def _adv_service_data_map(adv) -> dict:
    if adv is None:
        return {}
    sd = getattr(adv, "service_data", None) or {}
    return {normalize_uuid(k): bytes(v).hex() for k, v in sd.items()}


def _adv_row(mono: Mono, dev, adv, redact: bool) -> dict:
    return {
        "t": now_iso(),
        "monoMs": mono.ms(),
        "tool": TOOL_NAME,
        "event": "advertisement",
        "address": redact_addr(getattr(dev, "address", ""), redact),
        "name": _dev_name(dev, adv) or None,
        "rssi": _rssi(dev, adv),
        "serviceUuids": [normalize_uuid(u) for u in (getattr(adv, "service_uuids", None) or [])],
        "manufacturerData": _adv_manufacturer_map(adv),
        "serviceData": _adv_service_data_map(adv),
        "txPower": getattr(adv, "tx_power", None) if adv is not None else None,
    }


# ── 子命令：scan ─────────────────────────────────────────────────────────────
def cmd_scan(args) -> int:
    import_bleak()
    mono = Mono()
    writer = JsonlWriterProxy(args, "scan")

    async def run():
        rows = await _scan(args.seconds)
        rows.sort(key=lambda pair: _rssi(*pair) if _rssi(*pair) is not None else -999, reverse=True)
        for dev, adv in rows:
            writer.write(_adv_row(mono, dev, adv, args.redact_mac))
        log(f"扫描完成：{len(rows)} 台设备；扫描时长 {args.seconds:.0f}s")
        for dev, adv in rows:
            log(f"  {redact_addr(dev.address, args.redact_mac)}  rssi={_rssi(dev, adv)}  "
                f"name={_dev_name(dev, adv) or '<no-name>'}  "
                f"services={[short_uuid(u) for u in (getattr(adv, 'service_uuids', None) or [])]}")
        if writer.path:
            log(f"JSONL 已写入：{writer.path}")

    try:
        asyncio.run(run())
    finally:
        writer.close()
    return EXIT_OK


# ── 子命令：info ─────────────────────────────────────────────────────────────
def cmd_info(args) -> int:
    bleak = import_bleak()
    mono = Mono()
    out = resolve_out(args, "info", default_suffix=".json") if (args.out or not args.redact_mac) else None

    async def run() -> dict:
        target, adv = await resolve_target(args)
        client = _client_factory(bleak, target, args)
        reads = []
        if isinstance(target, str):
            dev_name = getattr(adv, "local_name", None) or ""
        else:
            dev_name = _dev_name(target, adv)
        device = {
            "name": dev_name,
            "mac": redact_addr(getattr(target, "address", target), args.redact_mac),
            "model": "",
            "firmware": "",
            "hardware": "",
            "serial": "",
        }
        battery = None
        try:
            await client.connect()
            log("已连接，开始读取 Device Information / Battery …")
            for svc_uuid, ch_uuid, field, label in INFO_CHARS:
                item = {"service": short_uuid(svc_uuid), "char": short_uuid(ch_uuid),
                        "name": label, "hex": None, "value": None, "error": None}
                try:
                    data = await client.read_gatt_char(normalize_uuid(ch_uuid))
                    item["hex"] = bytes(data).hex()
                    text = bytes(data).decode("utf-8", errors="replace").strip("\x00").strip()
                    item["value"] = text
                    if field == "serial":
                        # 序列号无条件脱敏（计划 §4/§5）；--no-redact-mac 也不放开
                        device["serial"] = "（脱敏）" if text else ""
                        item["value"] = "（脱敏）" if text else ""
                    else:
                        device[field] = text
                except Exception as exc:  # 读不到不是致命错误，记进 reads
                    item["error"] = f"{type(exc).__name__}: {exc}"
                reads.append(item)
            try:
                data = await client.read_gatt_char(normalize_uuid("2a19"))
                battery = int.from_bytes(bytes(data), "little")
            except Exception as exc:
                reads.append({"service": "180f", "char": "2a19", "name": "Battery Level",
                              "hex": None, "value": None,
                              "error": f"{type(exc).__name__}: {exc}"})
        finally:
            try:
                await client.disconnect()
            except Exception:
                pass
        doc = {
            "device": device,
            "env": {
                "os": f"{platform.system()} {platform.release()} ({platform.version()})",
                "chrome": "",
                "adapter": "",
                "tools": [f"hw9cap {VERSION}", f"bleak {_bleak_version()}"],
                "python": platform.python_version(),
            },
            "tester": "",
            "startedAt": now_iso(),
            "notes": "",
            "reads": reads,
            "batteryPercent": battery,
        }
        if out:
            write_json_file(out, doc)
            log(f"meta 片段已写入：{out}")
        else:
            sys.stdout.write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
        log("提示：把 device/env 合并进测试目录的 meta.json；再跑 gatt 生成 gatt.json。")
        return doc

    asyncio.run(run())
    return EXIT_OK


# ── 子命令：gatt ─────────────────────────────────────────────────────────────
async def build_gatt(client, adv, read_descriptions: bool) -> dict:
    try:
        services_collection = client.services
    except Exception as exc:
        # bleak 3.x 在服务发现未完成时抛 BleakError；Windows 后端应在 connect() 内完成发现。
        raise UsageError(
            f"拿不到服务列表（{type(exc).__name__}: {exc}）。"
            "Windows 后端应在 connect() 内完成服务发现，可重试；"
            "若持续失败，用 nRF Connect 做全量枚举交叉校验（计划 T1）。"
        ) from exc
    services = []
    for svc in services_collection:
        svc_uuid = normalize_uuid(svc.uuid)
        name = service_name(svc_uuid)
        chars = []
        for ch in svc.characteristics:
            # bleak 3.x：Windows 后端在服务发现时逐特征枚举描述符；CCCD(0x2902) 有无据此判断。
            desc_uuids = [short_uuid(d.uuid) for d in ch.descriptors]
            cccd = "2902" in desc_uuids
            user_desc = None
            if read_descriptions:
                for desc in ch.descriptors:
                    if short_uuid(desc.uuid) == "2901":
                        try:
                            raw = await client.read_gatt_descriptor(desc.handle)
                            user_desc = bytes(raw).decode("utf-8", errors="replace").strip("\x00")
                        except Exception:
                            user_desc = None
                        break
            chars.append({
                "uuid": normalize_uuid(ch.uuid),
                "name": char_name(ch.uuid),
                "properties": sorted(ch.properties),
                "descriptors": desc_uuids,
                "cccd": cccd,
                "userDescription": user_desc,
            })
        services.append({
            "uuid": svc_uuid,
            "name": name,
            "standard": bool(name),
            "characteristics": chars,
        })
    advertisement = {
        "name": _dev_name(None, adv) or None,
        "services": [normalize_uuid(u) for u in (getattr(adv, "service_uuids", None) or [])],
        "manufacturerData": _adv_manufacturer_hex(adv),
    }
    try:
        mtu = int(client.mtu_size)
    except Exception:
        mtu = None
    # mtu 是附加字段：0x2A37 单包能带几个 RR 受 ATT_MTU 限制（计划附录 A 注）。
    return {"services": services, "advertisement": advertisement, "mtu": mtu}


def cmd_gatt(args) -> int:
    bleak = import_bleak()
    out = resolve_out(args, "gatt", default_suffix=".json") if (args.out or not args.redact_mac) else None

    async def run():
        target, adv = await resolve_target(args)
        client = _client_factory(bleak, target, args)
        try:
            await client.connect()
            doc = await build_gatt(client, adv, not args.no_read_descriptions)
        finally:
            try:
                await client.disconnect()
            except Exception:
                pass
        if out:
            write_json_file(out, doc)
            log(f"gatt.json 已写入：{out}")
        else:
            sys.stdout.write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
        n_svc = len(doc["services"])
        n_ch = sum(len(s["characteristics"]) for s in doc["services"])
        n_notify = sum(
            1 for s in doc["services"] for c in s["characteristics"]
            if "notify" in c["properties"] or "indicate" in c["properties"]
        )
        vendor = [s for s in doc["services"] if not s["standard"]]
        log(f"枚举完成：{n_svc} 个服务 / {n_ch} 个特征 / {n_notify} 个可 notify|indicate；"
            f"非标准服务 {len(vendor)} 个：{[short_uuid(s['uuid']) for s in vendor]}")
        log(f"ATT MTU（max_pdu_size）={doc.get('mtu')}；0x2A37 单包 RR 个数受它限制（附录 A 注）。")
        if adv is None:
            log("提示：未拿到广播数据（advertisement 字段为 null/空）；不影响 GATT 枚举。")
        return doc

    asyncio.run(run())
    return EXIT_OK


# ── 子命令：notify ───────────────────────────────────────────────────────────
def cmd_notify(args) -> int:
    bleak = import_bleak()
    mono = Mono()
    writer = JsonlWriterProxy(args, "notifications")
    events_path = None
    if args.events_out:
        events_path = Path(args.events_out).expanduser()
        if not events_path.is_absolute():
            events_path = Path.cwd() / events_path
        events_path = events_path.resolve()
        if not args.redact_mac:
            local = LOCAL_DIR.resolve()
            try:
                events_path.relative_to(local)
            except ValueError:
                events_path = local / events_path.name
        events_path.parent.mkdir(parents=True, exist_ok=True)
    elif writer.path is not None:
        events_path = writer.path.with_name(writer.path.stem + ".events.jsonl")
        if not args.redact_mac:
            events_path = LOCAL_DIR / events_path.name
    events = JsonlWriter(events_path) if events_path is not None else None

    svc_short = short_uuid(args.service)
    chr_short = short_uuid(args.char)
    count = 0
    disconnected = {"hit": False}

    def rec_event(event: str, detail: str = "") -> None:
        row = {"t": now_iso(), "monoMs": mono.ms(), "tool": TOOL_NAME,
               "event": event, "detail": detail}
        if events is not None:
            events.write(row)
        log(f"[{event}] {detail}".rstrip())

    def on_data(_characteristic, data: bytearray) -> None:
        nonlocal count
        raw = bytes(data)
        decoded = None
        note = args.note or ""
        if chr_short == HRS_CHAR:
            decoded, decode_note = decode_hrs(raw)
            if decode_note:
                note = (note + "; " if note else "") + decode_note
        row = {
            "t": now_iso(),
            "monoMs": mono.ms(),
            "tool": TOOL_NAME,
            "service": svc_short,
            "char": chr_short,
            "hex": raw.hex(),
            "decoded": decoded,
            "note": note,
        }
        writer.write(row)
        count += 1

    def on_disconnect(_client) -> None:
        disconnected["hit"] = True

    async def run() -> int:
        target, adv = await resolve_target(args)
        client = _client_factory(bleak, target, args, disconnected_callback=on_disconnect)
        try:
            await client.connect()
            try:
                mtu = int(client.mtu_size)
            except Exception:
                mtu = None
            rec_event("connect",
                      f"{redact_addr(getattr(target, 'address', target), args.redact_mac)} MTU={mtu}")
            _svc, char = locate_char(client, args.service, args.char)
            await client.start_notify(char, on_data)
            rec_event("notify-start", f"{svc_short}/{chr_short} 已订阅，"
                                   f"duration={'until-CtrlC' if args.seconds <= 0 else f'{args.seconds:g}s'}")
            started = time.monotonic()
            last_log = started
            while True:
                if disconnected["hit"]:
                    rec_event("disconnect", "连接被设备/系统断开，提前停止")
                    return EXIT_DISCONNECTED
                elapsed = time.monotonic() - started
                if args.seconds > 0 and elapsed >= args.seconds:
                    break
                if time.monotonic() - last_log >= 10:
                    log(f"…已收到 {count} 条通知（{elapsed:.0f}s）")
                    last_log = time.monotonic()
                await asyncio.sleep(0.2)
            try:
                await client.stop_notify(char)
            except Exception:
                pass
            rec_event("notify-stop", f"共 {count} 条")
            return EXIT_OK
        finally:
            try:
                if client.is_connected:
                    await client.disconnect()
            except Exception:
                pass

    try:
        rc = asyncio.run(run())
    finally:
        writer.close()
        if events is not None:
            events.close()
    log(f"完成：{count} 条通知；输出={writer.path or 'stdout'}；"
        f"事件={events_path or 'stderr'}")
    if rc == EXIT_OK and count == 0:
        log("警告：订阅成功但 0 条通知——检查佩戴/接触、设备是否在发通知、"
            "或用 gatt 看 0x2A37 的属性。")
    return rc


# ── 子命令：reconnect ────────────────────────────────────────────────────────
def cmd_reconnect(args) -> int:
    bleak = import_bleak()
    mono = Mono()
    writer = JsonlWriterProxy(args, "reconnect")

    async def run() -> int:
        target, adv = await resolve_target(args)
        addr = getattr(target, "address", None) or (target if isinstance(target, str) else None)
        base_client = _client_factory(bleak, target, args)
        t0 = time.monotonic()
        await base_client.connect()
        base_ms = int(round((time.monotonic() - t0) * 1000))
        writer.write({"t": now_iso(), "monoMs": mono.ms(), "tool": TOOL_NAME,
                      "event": "baseline", "connectMs": base_ms, "ok": True,
                      "address": redact_addr(addr, args.redact_mac)})
        log(f"基线连接 {base_ms}ms；开始 {args.times} 次断连/重连测试（间隔 {args.delay:g}s）")
        failures = 0
        for attempt in range(1, args.times + 1):
            try:
                await base_client.disconnect()
            except Exception:
                pass
            await asyncio.sleep(args.delay)
            scan_t0 = time.monotonic()
            found = False
            found_dev = None
            try:
                rows = await _scan(args.scan_seconds)
                for dev, adv2 in rows:
                    if addr and _same_addr(dev.address, addr):
                        # 3.x 推荐直接复用扫描得到的 BLEDevice，避免再次按地址查找
                        found, found_dev = True, dev
                        break
            except Exception as exc:
                log(f"第 {attempt} 次重连前扫描失败（继续用地址直连）：{exc}")
            scan_ms = int(round((time.monotonic() - scan_t0) * 1000))
            row = {"t": now_iso(), "monoMs": mono.ms(), "tool": TOOL_NAME,
                   "event": "reconnect", "attempt": attempt,
                   "scanMs": scan_ms, "foundByScan": found,
                   "needsReselect": not found}
            client = None
            try:
                connect_target = found_dev or addr or target
                client = _client_factory(bleak, connect_target, args)
                ct0 = time.monotonic()
                await client.connect()
                row["connectMs"] = int(round((time.monotonic() - ct0) * 1000))
                row["ok"] = True
                row["error"] = ""
                if args.verify_seconds > 0:
                    try:
                        _svc, char = locate_char(client, args.service, args.char)
                        got = {"n": 0}

                        def _cb(_ch, _data):
                            got["n"] += 1

                        await client.start_notify(char, _cb)
                        await asyncio.sleep(args.verify_seconds)
                        try:
                            await client.stop_notify(char)
                        except Exception:
                            pass
                        row["notifyCount"] = got["n"]
                        row["notifyOk"] = got["n"] > 0
                    except Exception as exc:
                        row["notifyCount"] = 0
                        row["notifyOk"] = False
                        row["notifyError"] = f"{type(exc).__name__}: {exc}"
            except Exception as exc:
                failures += 1
                row.update({"connectMs": None, "ok": False,
                            "error": f"{type(exc).__name__}: {exc}"})
            finally:
                if client is not None:
                    try:
                        if client.is_connected:
                            await client.disconnect()
                    except Exception:
                        pass
            writer.write(row)
            log(f"  第 {attempt}/{args.times} 次：found={found} scan={scan_ms}ms "
                f"connect={row.get('connectMs')}ms ok={row.get('ok')} "
                f"notify={row.get('notifyCount')}")
        try:
            if base_client.is_connected:
                await base_client.disconnect()
        except Exception:
            pass
        log(f"重连测试完成：{args.times} 次，失败 {failures} 次。"
            f"needsReselect=True 表示该次重连前扫描没看到广播（交互式工具里需要用户重新选择设备）。")
        return EXIT_OK if failures == 0 else EXIT_DISCONNECTED

    try:
        rc = asyncio.run(run())
    finally:
        writer.close()
    if writer.path:
        log(f"JSONL 已写入：{writer.path}")
    return rc


# ── 子命令：concurrency ──────────────────────────────────────────────────────
def cmd_concurrency(args) -> int:
    """并发观察骨架：主设备（HW9）+ 另一 BLE 设备的通知时间线。

    能测的是 OS/适配器层面的并发与丢包；无法复现 Web Bluetooth“单 pending
    requestDevice”这类浏览器层限制（那要在 harness/Electron 里测）。
    """
    bleak = import_bleak()
    mono = Mono()
    writer = JsonlWriterProxy(args, "concurrency")
    svc_short = short_uuid(args.service)
    chr_short = short_uuid(args.char)
    last_mono: dict[str, int] = {}
    stats = {"primary": {"count": 0, "maxGapMs": 0, "gapsOver1500": 0},
             "other": {"count": 0, "maxGapMs": 0, "gapsOver1500": 0}}

    def make_cb(stream: str):
        def cb(_ch, data: bytearray) -> None:
            raw = bytes(data)
            now = mono.ms()
            prev = last_mono.get(stream)
            gap = now - prev if prev is not None else None
            if gap is not None:
                stats[stream]["maxGapMs"] = max(stats[stream]["maxGapMs"], gap)
                if gap > 1500:
                    stats[stream]["gapsOver1500"] += 1
            last_mono[stream] = now
            stats[stream]["count"] += 1
            decoded = None
            if stream == "primary" and chr_short == HRS_CHAR:
                decoded, _note = decode_hrs(raw)
            writer.write({
                "t": now_iso(), "monoMs": now, "tool": TOOL_NAME, "stream": stream,
                "service": svc_short, "char": chr_short, "hex": raw.hex(),
                "decoded": decoded, "gapMs": gap,
            })
        return cb

    async def run() -> int:
        target, adv = await resolve_target(args)
        other = None
        if args.other or args.other_name:
            other_args = argparse.Namespace(
                address=args.other, name=args.other_name, timeout=args.timeout,
                scan_seconds=args.scan_seconds, redact_mac=args.redact_mac,
            )
            rows = await _scan(args.scan_seconds)
            other, other_adv = _select_target(rows, other_args)
            if other is None:
                raise DeviceNotFound(f"没找到第二台设备（--other {args.other or args.other_name}）。")
            log(f"第二台设备：{_dev_name(other, other_adv) or '<no-name>'} "
                f"{redact_addr(other.address, args.redact_mac)}")
        else:
            log("未指定 --other：只占用主设备（骨架仍可运行）。"
                "并发对比请加 --other <MAC> [--other-char <UUID>]。")

        primary = _client_factory(bleak, target, args)
        other_client = _client_factory(bleak, other, args) if other is not None else None
        try:
            await primary.connect()
            _svc, char = locate_char(primary, args.service, args.char)
            await primary.start_notify(char, make_cb("primary"))
            log(f"主设备已订阅 {svc_short}/{chr_short}")
            if other_client is not None:
                await other_client.connect()
                if args.other_char:
                    _osvc, ochar = locate_char(other_client, args.other_service, args.other_char)
                    await other_client.start_notify(ochar, make_cb("other"))
                    log(f"第二台设备已订阅 {short_uuid(args.other_service)}/{short_uuid(args.other_char)}")
                else:
                    log("第二台设备已连接（未给 --other-char，只占用连接不发通知）。")
            log(f"观察 {args.seconds:g}s …")
            await asyncio.sleep(max(args.seconds, 0.1))
            for stream in ("primary", "other"):
                s = stats[stream]
                log(f"  {stream}: {s['count']} 条，最大间隔 {s['maxGapMs']}ms，"
                    f">1500ms 间隔 {s['gapsOver1500']} 次")
        finally:
            for client in (primary, other_client):
                if client is None:
                    continue
                try:
                    if client.is_connected:
                        await client.disconnect()
                except Exception:
                    pass
        log("提醒：本命令只测 OS/BLE 层并发；浏览器/Electron 的 requestDevice 串行限制另测。")
        return EXIT_OK

    try:
        rc = asyncio.run(run())
    finally:
        writer.close()
    if writer.path:
        log(f"JSONL 已写入：{writer.path}")
    return rc


# ── 子命令：decode（离线自检，不需要 bleak） ────────────────────────────────
def cmd_decode(args) -> int:
    raw_text = "".join(args.hex)
    cleaned = re.sub(r"[^0-9A-Fa-f]", "", raw_text)
    if len(cleaned) < 2 or len(cleaned) % 2 != 0:
        raise UsageError(f"hex 需要偶数个十六进制字符，收到：{args.hex!r}")
    decoded, note = decode_hrs(bytes.fromhex(cleaned))
    out = {"input": cleaned, "decoded": decoded}
    if note:
        out["note"] = note
    sys.stdout.write(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
    return EXIT_OK


# ── CLI ──────────────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    common_io = argparse.ArgumentParser(add_help=False)
    common_io.add_argument("--out", metavar="PATH",
                           help="输出文件；省略时数据写 stdout（日志始终写 stderr）")
    common_io.add_argument("--redact-mac", dest="redact_mac", action="store_true", default=True,
                           help="脱敏 MAC（默认开启，保留 OUI，掩掉后 3 字节）")
    common_io.add_argument("--no-redact-mac", dest="redact_mac", action="store_false",
                           help="保留真实 MAC；输出会被强制重定向到 _tools/.local/")
    common_io.add_argument("-v", "--verbose", action="store_true", help="异常时打印完整 traceback")

    common_target = argparse.ArgumentParser(add_help=False, parents=[common_io])
    common_target.add_argument("--address", metavar="MAC",
                               help="目标设备地址（如 AA:BB:CC:DD:EE:FF）；与 --name 二选一")
    common_target.add_argument("--name", metavar="NAME",
                               help="目标设备广播名（不区分大小写的子串匹配）")
    common_target.add_argument("--timeout", type=float, default=20.0, metavar="SEC",
                               help="BleakClient 连接/查找超时秒数（默认 20）")

    p = argparse.ArgumentParser(
        prog="hw9cap.py",
        description="CooSpo HW9 BLE 抓包 CLI（bleak 3.x / Windows pywinrt 后端；输出符合计划 §5 数据格式）",
        epilog="子命令示例见 analysis/hw9-capture/_tools/README.md",
    )
    p.add_argument("--version", action="version", version=f"hw9cap {VERSION}")
    sub = p.add_subparsers(dest="cmd", metavar="<command>")
    sub.required = True

    def add(name, parents, help_text):
        return sub.add_parser(name, parents=parents, help=help_text)

    sp = add("scan", [common_io], "广播扫描：name/services/manufacturerData → JSONL")
    sp.add_argument("--seconds", type=float, default=10.0, metavar="SEC", help="扫描时长（默认 10）")
    sp.set_defaults(func=cmd_scan)

    sp = add("info", [common_target], "读 0x180A 字符串 + 0x180F/0x2A19，输出 meta.json 片段")
    sp.add_argument("--scan-seconds", type=float, default=8.0, metavar="SEC",
                    help="找设备时的扫描时长（默认 8）")
    sp.set_defaults(func=cmd_info)

    sp = add("gatt", [common_target], "全量枚举 primary service/characteristic → 计划 §5 gatt.json")
    sp.add_argument("--scan-seconds", type=float, default=8.0, metavar="SEC",
                    help="找设备时的扫描时长（默认 8）")
    sp.add_argument("--no-read-descriptions", action="store_true",
                    help="不读 0x2901 用户描述（更快，但 gatt.json 的 userDescription 恒为 null）")
    sp.set_defaults(func=cmd_gatt)

    sp = add("notify", [common_target], "订阅特征落 notifications.jsonl（2A37 自动按附录 A 解码）")
    sp.add_argument("--service", default="heart_rate",
                    help="服务 UUID 或短名（默认 heart_rate=180d）")
    sp.add_argument("--char", default="heart_rate_measurement",
                    help="特征 UUID 或短名（默认 heart_rate_measurement=2a37）")
    sp.add_argument("--seconds", type=float, default=60.0, metavar="SEC",
                    help="抓包时长；<=0 表示直到 Ctrl+C 或断连（默认 60）")
    sp.add_argument("--events-out", metavar="PATH",
                    help="连接/断连等事件 JSONL；默认 <out>.events.jsonl，无 --out 时只打 stderr")
    sp.add_argument("--scan-seconds", type=float, default=8.0, metavar="SEC",
                    help="找设备时的扫描时长（默认 8）")
    sp.add_argument("--note", default="", help="给每条记录的 note 字段加固定标记（如 t2-rest）")
    sp.set_defaults(func=cmd_notify)

    sp = add("reconnect", [common_target], "断连重连测试：记录耗时与是否需要重新选设备")
    sp.add_argument("--times", type=int, default=3, metavar="N", help="重连次数（默认 3）")
    sp.add_argument("--delay", type=float, default=2.0, metavar="SEC", help="每次断连后等待（默认 2）")
    sp.add_argument("--scan-seconds", type=float, default=5.0, metavar="SEC",
                    help="每次重连前扫描时长（默认 5）")
    sp.add_argument("--service", default="heart_rate", help="验证用服务（默认 180d）")
    sp.add_argument("--char", default="heart_rate_measurement", help="验证用特征（默认 2a37）")
    sp.add_argument("--verify-seconds", type=float, default=2.0, metavar="SEC",
                    help="重连后验证通知的观察秒数（0=不验证，默认 2）")
    sp.set_defaults(func=cmd_reconnect)

    sp = add("concurrency", [common_target], "与另一 BLE 设备同连的观察骨架（时间线/间隔/丢包）")
    sp.add_argument("--seconds", type=float, default=30.0, metavar="SEC", help="观察时长（默认 30）")
    sp.add_argument("--scan-seconds", type=float, default=8.0, metavar="SEC", help="扫描时长（默认 8）")
    sp.add_argument("--other", metavar="MAC", help="第二台设备地址")
    sp.add_argument("--other-name", metavar="NAME", help="第二台设备广播名")
    sp.add_argument("--service", default="heart_rate", help="主设备服务（默认 180d）")
    sp.add_argument("--char", default="heart_rate_measurement", help="主设备特征（默认 2a37）")
    sp.add_argument("--other-service", default="heart_rate", help="第二台设备服务")
    sp.add_argument("--other-char", default=None,
                    help="第二台设备特征（给了才订阅；否则只保持连接）")
    sp.set_defaults(func=cmd_concurrency)

    sp = add("decode", [], "离线按附录 A 解码一段 0x2A37 hex（不需要设备/bleak）")
    sp.add_argument("hex", nargs="+", help="十六进制字节，如 164a0f030f03 或 \"16 4a 0f 03\"")
    sp.set_defaults(func=cmd_decode)
    return p


def _setup_io() -> None:
    """统一 UTF-8 输出：Windows 控制台默认 gbk/936，中文日志/重定向都可能乱码。

    交互式控制台若仍显示乱码，先执行 `chcp 65001`（README 有说明）。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def main(argv=None) -> int:
    _setup_io()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except KeyboardInterrupt:
        log("\n已中断（Ctrl+C）。已写入的数据文件保留。")
        return 130
    except MissingDependency as exc:
        log(f"错误：{exc}")
        return EXIT_NO_BLEAK
    except UsageError as exc:
        log(f"用法错误：{exc}")
        return EXIT_ERR
    except DeviceNotFound as exc:
        log(f"错误：{exc}")
        return EXIT_NO_DEVICE
    except Exception as exc:  # BLE/系统错误
        exc_name = type(exc).__name__
        if exc_name in ("BleakDeviceNotFoundError", "BleakCharacteristicNotFoundError"):
            log(f"错误：{exc_name}: {exc}")
            log("提示：设备/特征没找到。先跑 scan 确认地址与广播；"
                "HW9 可能被手机/官方 App 占用，或不在范围内。")
            return EXIT_NO_DEVICE
        if exc_name == "BleakBluetoothNotAvailableError":
            log(f"错误：蓝牙不可用（{exc_name}: {exc}）。请确认蓝牙已打开、适配器驱动正常。")
            return EXIT_BLEAK_ERROR
        log(f"错误：{exc_name}: {exc}")
        if getattr(args, "verbose", False):
            traceback.print_exc()
        else:
            log("（加 -v/--verbose 可看完整 traceback）")
        return EXIT_BLEAK_ERROR


if __name__ == "__main__":
    sys.exit(main())
