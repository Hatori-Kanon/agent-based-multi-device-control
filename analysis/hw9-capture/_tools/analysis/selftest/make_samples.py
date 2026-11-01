#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成分析器自测用的 3 组合成数据（**不是真实健康数据**）。

样本：
  rr-good/   bit4 恒 1、每包 2 RR、RR 700–900ms、无空档（Gate B 应 pass）
  bpm-only/  bit4 恒 0（Gate B fail、Gate B- 成立）
  messy/     0x16/0x06/0x0A 混包 + 3 段 >3s 空档 + 多处 >20% 跳变 +
             摘下段（bit1=0, HR=0）+ 解码失败 + decoded 故意错 + 非 HRS 流

数据全部由确定性公式生成，仅用于验证分析器逻辑；
每行 note 标明 SELFTEST-SYNTHETIC。
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = datetime(2026, 11, 1, 17, 30, 0, tzinfo=timezone(timedelta(hours=8)))
TOOL = "selftest-synth"


def iso_at(sec_off):
    return (BASE + timedelta(seconds=sec_off)).isoformat(timespec="milliseconds")


def hrs_hex(flags, hr, rrs_ms=None, energy=None):
    b = bytearray([flags])
    if flags & 0x01:
        b += int(hr).to_bytes(2, "little")
    else:
        b.append(int(hr) & 0xFF)
    if flags & 0x08:
        b += int(energy if energy is not None else 0).to_bytes(2, "little")
    for rr in (rrs_ms or []):
        raw = int(round(float(rr) * 1024.0 / 1000.0))
        raw = max(0, min(0xFFFF, raw))
        b += raw.to_bytes(2, "little")
    return bytes(b).hex().upper()


def make_row(t_off, flags, hr, rrs=None, energy=None, note="",
             decoded=None, hex_override=None, service="180d", char="2a37"):
    return {
        "t": iso_at(t_off),
        "monoMs": int(t_off * 1000),
        "tool": TOOL,
        "service": service,
        "char": char,
        "hex": hex_override if hex_override is not None else hrs_hex(flags, hr, rrs, energy),
        "decoded": decoded,
        "note": note,
    }


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


GATT_STANDARD = {
    "services": [
        {
            "uuid": "0000180d-0000-1000-8000-00805f9b34fb",
            "name": "Heart Rate",
            "standard": True,
            "characteristics": [
                {
                    "uuid": "00002a37-0000-1000-8000-00805f9b34fb",
                    "name": "Heart Rate Measurement",
                    "properties": ["notify"],
                    "cccd": True,
                    "userDescription": None,
                }
            ],
        },
        {
            "uuid": "0000180a-0000-1000-8000-00805f9b34fb",
            "name": "Device Information",
            "standard": True,
            "characteristics": [
                {"uuid": "00002a29-0000-1000-8000-00805f9b34fb",
                 "name": "Manufacturer Name String", "properties": ["read"],
                 "cccd": False, "userDescription": None},
                {"uuid": "00002a26-0000-1000-8000-00805f9b34fb",
                 "name": "Firmware Revision String", "properties": ["read"],
                 "cccd": False, "userDescription": None},
            ],
        },
        {
            "uuid": "0000180f-0000-1000-8000-00805f9b34fb",
            "name": "Battery",
            "standard": True,
            "characteristics": [
                {"uuid": "00002a19-0000-1000-8000-00805f9b34fb",
                 "name": "Battery Level", "properties": ["read", "notify"],
                 "cccd": True, "userDescription": None},
            ],
        },
    ],
    "advertisement": {
        "name": "SYNTH-HW9",
        "services": ["0000180d-0000-1000-8000-00805f9b34fb"],
        "manufacturerData": "00",
    },
}

GATT_WITH_VENDOR = {
    "services": GATT_STANDARD["services"] + [
        {
            "uuid": "0000fff0-0000-1000-8000-00805f9b34fb",
            "name": "Vendor FFF0",
            "standard": False,
            "characteristics": [
                {"uuid": "0000fff1-0000-1000-8000-00805f9b34fb",
                 "name": "Vendor Notify", "properties": ["notify"],
                 "cccd": True, "userDescription": "vendor-data"},
            ],
        }
    ],
    "advertisement": GATT_STANDARD["advertisement"],
}


def meta(name):
    return {
        "device": {
            "name": name,
            "mac": "（脱敏）",
            "model": "SYNTHETIC-HW9",
            "firmware": "0.0.0-synth",
            "hardware": "synth-hw",
            "serial": "SYNTH-SERIAL-0001",
        },
        "env": {"os": "Windows 11 synthetic", "chrome": "0",
                "adapter": "none", "tools": ["selftest-synth"]},
        "tester": "selftest",
        "startedAt": iso_at(0),
        "notes": "SELFTEST-SYNTHETIC：合成自测数据，非真实健康数据",
    }


def gen_rr_good(outdir):
    rows = []
    for t in range(360):
        hr = 72 + (t % 7) - 3          # 69..75 bpm
        base = 60000.0 / hr
        rrs = [round(base * 0.985, 1), round(base * 1.015, 1)]  # 700–900ms
        rows.append(make_row(t, 0x16, hr, rrs,
                             note="SELFTEST-SYNTHETIC rr-good"))
    write_jsonl(os.path.join(outdir, "notifications.jsonl"), rows)
    write_json(os.path.join(outdir, "gatt.json"), GATT_STANDARD)
    write_json(os.path.join(outdir, "meta.json"), meta("SYNTH-HW9-rr-good"))


def gen_bpm_only(outdir):
    rows = []
    for t in range(360):
        hr = 68 + (t % 5) - 2          # 66..70 bpm，无 RR
        rows.append(make_row(t, 0x06, hr, note="SELFTEST-SYNTHETIC bpm-only"))
    write_jsonl(os.path.join(outdir, "notifications.jsonl"), rows)
    write_json(os.path.join(outdir, "gatt.json"), GATT_STANDARD)
    write_json(os.path.join(outdir, "meta.json"), meta("SYNTH-HW9-bpm-only"))


def gen_messy(outdir):
    gap_skip = set()
    # 每段空档两端都刻意落在“带 RR 的包”上，便于验证 RR 累计丢拍估计
    for a, b in ((35, 41), (115, 121), (175, 181)):
        gap_skip.update(range(a, b))
    detach = set(range(60, 67))
    cluster = {130, 131, 132, 133, 150, 151, 152, 153, 200, 201, 202, 203}
    out_range = {250, 251, 260, 261}

    rows = []
    for t in range(341):
        if t in gap_skip:
            continue
        note = "SELFTEST-SYNTHETIC messy"
        if t in detach:
            rows.append(make_row(t, 0x04, 0, note=note + " detach(bit1=0,HR=0)"))
            continue
        if t in cluster:
            hr = 88 + (t % 3)
            rrs = [660.0, 1120.0] if t % 2 == 0 else [1120.0, 660.0]
            rows.append(make_row(t, 0x16, hr, rrs, note=note + " jump>20%"))
            continue
        if t in out_range:
            hr = 92
            rrs = [2200.0, 660.0] if t % 2 == 0 else [300.0, 660.0]
            rows.append(make_row(t, 0x16, hr, rrs, note=note + " rr-out-of-range"))
            continue
        if t == 90:
            rows.append(make_row(t, 0x16, 88, hex_override="16",
                                 note=note + " truncated-packet"))
            continue
        if t % 10 in (7, 8):
            rows.append(make_row(t, 0x06, 88 + (t % 5) - 2,
                                 note=note + " bpm-only-packet"))
            continue
        if t % 10 in (0, 9):
            rows.append(make_row(t, 0x0A, 88 + (t % 5) - 2, energy=100 + t,
                                 note=note + " energy-expended"))
            continue
        base = 60000.0 / (88 + (t % 5) - 2)
        if t % 37 == 0:
            rrs = [round(base, 1)]                                  # 1 RR
        elif t % 41 == 0:
            rrs = [round(base * 0.99, 1), round(base, 1), round(base * 1.01, 1)]  # 3 RR
        elif t % 53 == 0:
            rrs = [round(base * 0.98, 1), round(base * 0.99, 1),
                   round(base, 1), round(base * 1.01, 1)]            # 4 RR
        else:
            rrs = [round(base * 0.99, 1), round(base * 1.01, 1)]    # 2 RR
        decoded = None
        if t % 9 == 0:
            # 故意给错的 decoded：分析器必须忽略它、以 hex 为准
            decoded = {"flags": 0x16, "hr": 88 + (t % 5) - 2 + 5,
                       "contactStatus": True, "contactSupported": True,
                       "rrMs": rrs}
        rows.append(make_row(t, 0x16, 88 + (t % 5) - 2, rrs,
                             note=note + " normal", decoded=decoded))

    # 非 HRS 通知流（vendor fff0/fff1）：周期 1s、uint16 小端 ~783 → 候选
    for i, t in enumerate((300, 301, 302)):
        rows.append({
            "t": iso_at(t), "monoMs": int(t * 1000), "tool": TOOL,
            "service": "fff0", "char": "fff1", "hex": "0F03",
            "decoded": None, "note": "SELFTEST-SYNTHETIC vendor-stream",
        })
    # harness device info 行（无 hex，不算通知）
    rows.append({"t": iso_at(0), "tool": "harness", "info": "manufacturer",
                 "value": "SYNTHETIC"})

    path = os.path.join(outdir, "notifications.jsonl")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        f.write('{"t": "this-is-not-json"\n')   # 故意坏行，验证容错
    write_json(os.path.join(outdir, "gatt.json"), GATT_WITH_VENDOR)
    write_json(os.path.join(outdir, "meta.json"), meta("SYNTH-HW9-messy"))


def write_json(path, obj):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    for name, fn in (("rr-good", gen_rr_good), ("bpm-only", gen_bpm_only),
                     ("messy", gen_messy)):
        outdir = os.path.join(HERE, name)
        os.makedirs(outdir, exist_ok=True)
        fn(outdir)
    print("已生成合成自测样本：rr-good / bpm-only / messy（SELFTEST-SYNTHETIC）")


if __name__ == "__main__":
    main()
