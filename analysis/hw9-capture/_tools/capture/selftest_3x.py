#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bleak 3.x API 适配自检（不需要真实设备，不发起任何 BLE 连接/扫描）。

用途：在不接 HW9 的情况下，验证 hw9cap.py 对已安装 bleak 3.0.2 的用法假设：
  * BleakScanner.discover(return_adv=True) -> dict[address] -> (BLEDevice, AdvertisementData)
  * AdvertisementData 字段名（local_name/service_uuids/manufacturer_data/service_data/tx_power/rssi）
  * BleakClient(target, timeout=...) 构造参数、client.mtu_size
  * client.services 迭代、service.characteristics、characteristic.properties（字符串列表）
  * characteristic.descriptors（含 0x2902 CCCD / 0x2901 用户描述）、read_gatt_descriptor(handle)
  * 错误类型映射（BleakDeviceNotFoundError -> 退出码 3）

运行（用已装 bleak 3.0.2 的 venv）：
  analysis\\hw9-capture\\_tools\\.venv\\Scripts\\python.exe analysis\\hw9-capture\\_tools\\capture\\selftest_3x.py

注意：fake 的 GATT 对象只提供 hw9cap.py 实际访问的属性；真实设备上的行为仍需 Lead 首轮实测。
"""

from __future__ import annotations

import asyncio
import sys
import types
from argparse import Namespace
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import hw9cap  # noqa: E402

FAILS: list[str] = []
PASSES = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASSES
    if ok:
        PASSES += 1
        print(f"PASS  {name}")
    else:
        FAILS.append(name)
        print(f"FAIL  {name}  {detail}")


def check_eq(name: str, got, want) -> None:
    check(name, got == want, f"got={got!r} want={want!r}")


class FakeBleak:
    """伪 bleak 模块：只用于验证 _scan 对 3.x 返回结构的处理。"""

    def __init__(self, mapping):
        self.mapping = mapping

    class BleakScanner:  # 占位，实际在 discover 里替换
        @classmethod
        async def discover(cls, timeout=5.0, *, return_adv=False):  # pragma: no cover
            raise AssertionError("should be replaced")


def make_adv(**overrides):
    from bleak import AdvertisementData

    kwargs = dict(
        local_name="HW9-TEST",
        manufacturer_data={0x0059: b"\x42\x43"},
        service_data={"0000180d-0000-1000-8000-00805f9b34fb": b"\xaa\xbb"},
        service_uuids=["0000180d-0000-1000-8000-00805f9b34fb"],
        tx_power=None,
        rssi=-61,
        platform_data=(),
    )
    kwargs.update(overrides)
    return AdvertisementData(**kwargs)


def make_dev(address="AA:BB:CC:DD:EE:FF", name="HW9-TEST"):
    return types.SimpleNamespace(address=address, name=name, details=None)


# ── 1. 0x2A37 解码（计划附录 A / §5 示例） ────────────────────────────────────
def test_decode() -> None:
    decoded, note = hw9cap.decode_hrs(bytes.fromhex("164a0f030f03"))
    check_eq("decode 附录 A 示例 flags/hr", (decoded ["flags"], decoded["hr"]), (22, 74))
    check_eq("decode 附录 A 示例 RR", decoded["rrMs"], [764.6, 764.6])
    check_eq("decode 附录 A 示例 contact", (decoded["contactStatus"], decoded["contactSupported"]), (True, True))
    check_eq("decode 正常包 note 为空", note, "")

    # uint16 HR + 尾随字节（flags=0x07，HR 小端 f4 01 = 500，尾部 ff）
    decoded, note = hw9cap.decode_hrs(bytes.fromhex("07f401ff"))
    check_eq("decode uint16 HR", decoded["hr"], 500)
    check("decode 尾随字节写进 note", "trailing 1 byte" in note, note)

    # 截断：flags 声称有 RR 但只有 flags
    decoded, note = hw9cap.decode_hrs(b"\x16")
    check("decode 截断不崩、返回 error", "error" in decoded, repr(decoded))


# ── 2. AdvertisementData 字段读取（真实 bleak NamedTuple） ───────────────────
def test_adv_row() -> None:
    dev = make_dev()
    adv = make_adv()
    row = hw9cap._adv_row(hw9cap.Mono(), dev, adv, redact=True)
    check_eq("adv 行 tool/event", (row["tool"], row["event"]), ("bleak", "advertisement"))
    check_eq("adv 行 address 脱敏", row["address"], "AA:BB:CC:**:**:**")
    check_eq("adv 行 name 取 local_name", row["name"], "HW9-TEST")
    check_eq("adv 行 rssi", row["rssi"], -61)
    check_eq("adv 行 serviceUuids 规范化", row["serviceUuids"], ["0000180d-0000-1000-8000-00805f9b34fb"])
    check_eq("adv 行 manufacturerData", row["manufacturerData"], {"0x0059": "4243"})
    check_eq("adv 行 serviceData", row["serviceData"],
             {"0000180d-0000-1000-8000-00805f9b34fb": "aabb"})
    check_eq("adv 行 txPower", row["txPower"], None)
    check("adv 行 monoMs 是 int", isinstance(row["monoMs"], int))

    # 不脱敏
    row2 = hw9cap._adv_row(hw9cap.Mono(), dev, adv, redact=False)
    check_eq("adv 行 --no-redact-mac 保留原值", row2["address"], "AA:BB:CC:DD:EE:FF")


# ── 3. _scan 对 3.x discover dict 的处理 ─────────────────────────────────────
def test_scan_shape() -> None:
    dev, adv = make_dev(), make_adv()

    class _Scanner:
        @classmethod
        async def discover(cls, timeout=5.0, *, return_adv=False):
            check("scan 调用带 return_adv=True", return_adv is True, repr(return_adv))
            # bleak 3.x 契约：dict[address] -> (BLEDevice, AdvertisementData)
            return {dev.address: (dev, adv)}

    fake = FakeBleak({dev.address: (dev, adv)})
    fake.BleakScanner = _Scanner
    original = hw9cap.import_bleak
    hw9cap.import_bleak = lambda: fake
    try:
        rows = asyncio.run(hw9cap._scan(0.01))
    finally:
        hw9cap.import_bleak = original
    check("scan 返回 list[(dev, adv)]", len(rows) == 1 and rows[0][0] is dev and rows[0][1] is adv, repr(rows))


# ── 4. build_gatt 的 3.x 属性访问（fake GATT 对象） ──────────────────────────
class FakeDescriptor:
    def __init__(self, uuid: str, handle: int):
        self.uuid = uuid
        self.handle = handle


class FakeChar:
    def __init__(self, uuid, props, descriptors):
        self.uuid = uuid
        self.properties = props
        self.descriptors = descriptors


class FakeService:
    def __init__(self, uuid, characteristics):
        self.uuid = uuid
        self.characteristics = characteristics


class FakeClient:
    def __init__(self, services=None, mtu=247, raise_on_services=False):
        self._services = services if services is not None else []
        self.mtu_size = mtu
        self._raise = raise_on_services

    @property
    def services(self):
        if self._raise:
            raise RuntimeError("Service Discovery has not been performed yet")
        return self._services

    async def read_gatt_descriptor(self, desc_specifier):
        return b"HW9 user description"


def fake_services():
    hrm = FakeChar(
        "00002a37-0000-1000-8000-00805f9b34fb",
        ["notify"],
        [FakeDescriptor("00002902-0000-1000-8000-00805f9b34fb", 16),
         FakeDescriptor("00002901-0000-1000-8000-00805f9b34fb", 15)],
    )
    hrs = FakeService("0000180d-0000-1000-8000-00805f9b34fb", [hrm])
    vendor = FakeChar(
        "0000fff4-0000-1000-8000-00805f9b34fb",
        ["read", "write-without-response", "notify"],
        [],
    )
    vendor_svc = FakeService("0000fff0-0000-1000-8000-00805f9b34fb", [vendor])
    return [hrs, vendor_svc]


def test_build_gatt() -> None:
    client = FakeClient(fake_services())
    adv = make_adv()
    doc = asyncio.run(hw9cap.build_gatt(client, adv, read_descriptions=True))

    check_eq("gatt 服务数", len(doc["services"]), 2)
    hrs = doc["services"][0]
    check_eq("gatt 标准服务名", hrs["name"], "Heart Rate")
    check_eq("gatt 服务 uuid 完整", hrs["uuid"], "0000180d-0000-1000-8000-00805f9b34fb")
    check_eq("gatt 标准标记", hrs["standard"], True)
    hrm = hrs["characteristics"][0]
    check_eq("gatt 特征 uuid", hrm["uuid"], "00002a37-0000-1000-8000-00805f9b34fb")
    check_eq("gatt 特征名", hrm["name"], "Heart Rate Measurement")
    check_eq("gatt properties", hrm["properties"], ["notify"])
    check_eq("gatt descriptors", hrm["descriptors"], ["2902", "2901"])
    check_eq("gatt cccd", hrm["cccd"], True)
    check_eq("gatt userDescription 走 read_gatt_descriptor(handle)", hrm["userDescription"], "HW9 user description")
    vendor = doc["services"][1]
    check_eq("gatt 非标准服务 standard=False", vendor["standard"], False)
    check_eq("gatt 非标准服务 name=None", vendor["name"], None)
    check_eq("gatt MTU 附加字段", doc["mtu"], 247)
    check_eq("gatt advertisement.name", doc["advertisement"]["name"], "HW9-TEST")
    check_eq("gatt advertisement.manufacturerData", doc["advertisement"]["manufacturerData"], "4243")

    # 服务发现未完成时给出可操作错误
    try:
        asyncio.run(hw9cap.build_gatt(FakeClient(raise_on_services=True), adv, False))
    except hw9cap.UsageError as exc:
        check("gatt 服务发现失败 -> UsageError 含提示", "nRF Connect" in str(exc), str(exc))
    else:
        check("gatt 服务发现失败 -> UsageError 含提示", False, "no exception")


# ── 5. 设备选择 / 脱敏 / 退出码映射 ─────────────────────────────────────────
def test_selection_and_redact() -> None:
    adv = make_adv()
    dev_hw9 = make_dev("AA:BB:CC:DD:EE:FF", "HW9-TEST")
    dev_other = make_dev("11:22:33:44:55:66", "Printer")
    rows = [(dev_other, adv), (dev_hw9, make_adv(local_name="HW9-TEST", rssi=-50))]

    got = hw9cap._select_target(rows, Namespace(address="aa:bb:cc:dd:ee:ff", name=None, redact_mac=True))
    check("select 按地址匹配（忽略大小写/分隔符）", got[0] is dev_hw9, repr(got[0]))

    got = hw9cap._select_target(rows, Namespace(address=None, name="hw9", redact_mac=True))
    check("select 按名字子串匹配", got[0] is dev_hw9, repr(got[0]))

    got = hw9cap._select_target(rows, Namespace(address=None, name="nope", redact_mac=True))
    check("select 无匹配返回 (None, None)", got == (None, None), repr(got))

    check_eq("redact 掩后 3 字节", hw9cap.redact_addr("AA:BB:CC:DD:EE:FF"), "AA:BB:CC:**:**:**")
    check_eq("redact 关闭保留原值", hw9cap.redact_addr("AA:BB:CC:DD:EE:FF", False), "AA:BB:CC:DD:EE:FF")
    check_eq("short_uuid 短名", hw9cap.short_uuid("heart_rate_measurement"), "2a37")
    check_eq("normalize_uuid 0x 前缀", hw9cap.normalize_uuid("0x2A37"),
             "00002a37-0000-1000-8000-00805f9b34fb")


def test_resolve_out_redaction() -> None:
    """--no-redact-mac 的落盘策略（不实际写文件）。"""
    local = hw9cap.LOCAL_DIR.resolve()

    got = hw9cap.resolve_out(
        Namespace(out="somewhere/outside/raw.jsonl", redact_mac=False), "test"
    )
    check("--no-redact-mac 目录外输出重定向到 .local",
          got is not None and local in got.parents and got.name == "raw.jsonl", repr(got))

    got = hw9cap.resolve_out(Namespace(out=None, redact_mac=False), "scan")
    check("--no-redact-mac 未给 --out 自动落 .local",
          got is not None and local in got.parents and got.name.startswith("scan-"), repr(got))

    check("默认脱敏且无 --out -> 写 stdout",
          hw9cap.resolve_out(Namespace(out=None, redact_mac=True), "scan") is None)


def test_bleak_not_found_exit_code() -> None:
    class BleakDeviceNotFoundError(Exception):
        pass

    def boom(_args):
        raise BleakDeviceNotFoundError("Device with address AA was not found.")

    original = hw9cap.cmd_scan
    original_log = hw9cap.log
    hw9cap.cmd_scan = boom
    hw9cap.log = lambda msg="": None  # 该用例只验证退出码，不打印预期中的错误日志
    try:
        rc = hw9cap.main(["scan"])
    finally:
        hw9cap.cmd_scan = original
        hw9cap.log = original_log
    check_eq("BleakDeviceNotFoundError -> 退出码 3", rc, hw9cap.EXIT_NO_DEVICE)


# ── main ────────────────────────────────────────────────────────────────────
def main() -> int:
    hw9cap._setup_io()  # Windows 控制台默认 gbk，统一 UTF-8 输出
    try:
        import bleak  # noqa: F401
    except ImportError:
        print("SKIP: 未安装 bleak；请用 _tools/.venv 的 python 运行（bleak 3.x）")
        return 2
    version = hw9cap._bleak_version()
    print(f"bleak 版本：{version}（本自检按 3.x API；0.2x 不保证）")
    if not version.startswith("3."):
        print(f"警告：当前 bleak {version} 不在 3.x 范围，API 可能不符。")

    test_decode()
    test_adv_row()
    test_scan_shape()
    test_build_gatt()
    test_selection_and_redact()
    test_resolve_out_redaction()
    test_bleak_not_found_exit_code()

    print(f"\n结果：{PASSES} 项通过，{len(FAILS)} 项失败")
    if FAILS:
        print("失败项：" + "；".join(FAILS))
        return 1
    print("全部通过（离线 API 形状自检；真机行为仍需 Lead 首轮实测）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
