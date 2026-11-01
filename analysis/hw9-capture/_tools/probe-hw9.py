"""One connection, several notify characteristics at once.

Purpose: T4/Q5/Q6 of analysis/coospo-hw9-test-plan.md - watch the vendor
service 0xFD00 (chars fd09/fd19) *together with* the standard 0x2A37 so the
time relation between the streams is preserved in a single timeline.

  analysis\\hw9-capture\\_tools\\.venv\\Scripts\\python.exe ^
    analysis\\hw9-capture\\_tools\\probe-hw9.py --address <MAC> --seconds 180 ^
    --out analysis\\hw9-capture\\_tools\\.local\\vendor-probe.jsonl

Writes one JSONL row per notification:
  {"t", "monoMs", "char", "hex", "len"}
Plus one "info" row per successful read/attempt at connect time, so the file is
self-describing when read offline.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time

from bleak import BleakClient, BleakScanner

CHARS = {
    "fd09": "0000fd09-0000-1000-8000-00805f9b34fb",
    "fd19": "0000fd19-0000-1000-8000-00805f9b34fb",
    "2a37": "00002a37-0000-1000-8000-00805f9b34fb",
}


def now_stamp() -> str:
    from datetime import datetime

    return datetime.now().astimezone().isoformat(timespec="milliseconds")


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", required=True)
    ap.add_argument("--seconds", type=float, default=180)
    ap.add_argument("--out", required=True)
    ap.add_argument("--chars", default="fd09,fd19,2a37")
    ap.add_argument("--scan-seconds", type=float, default=12)
    args = ap.parse_args()

    t0 = time.monotonic()
    out = open(args.out, "a", encoding="utf-8")

    def write_row(**row) -> None:
        row.setdefault("t", now_stamp())
        row.setdefault("monoMs", int((time.monotonic() - t0) * 1000))
        out.write(json.dumps(row, ensure_ascii=False) + "\n")
        out.flush()

    targets = [c.strip() for c in args.chars.split(",") if c.strip()]
    short = {v.lower(): k for k, v in CHARS.items()}

    print(f"scanning {args.scan_seconds}s for {args.address} ...")
    found = await BleakScanner.discover(timeout=args.scan_seconds, return_adv=True)
    device = None
    for addr, (dev, adv) in found.items():
        if addr.upper() == args.address.upper():
            device = dev
            write_row(event="found", addr=addr, name=adv.local_name, rssi=adv.rssi)
            break
    if device is None:
        print("device not advertising; trying address directly")
        device = args.address

    counts: dict[str, int] = {}

    def make_cb(name: str):
        def cb(characteristic, data: bytearray) -> None:  # noqa: ANN001 - bleak signature
            counts[name] = counts.get(name, 0) + 1
            write_row(event="notify", char=name, hex=bytes(data).hex().upper(), len=len(data))

        return cb

    disconnected = asyncio.Event()

    async with BleakClient(device, timeout=30.0) as client:
        write_row(event="connected", addr=getattr(device, "address", device),
                  mtu=getattr(client, "mtu_size", None))
        try:
            body = await client.read_gatt_char("00002a38-0000-1000-8000-00805f9b34fb")
            write_row(event="info", key="2a38_body_sensor_location",
                      hex=bytes(body).hex().upper(), value=int.from_bytes(body, "little"))
        except Exception as exc:  # noqa: BLE001
            write_row(event="info", key="2a38_body_sensor_location", error=str(exc))

        for name in targets:
            uuid = CHARS.get(name, name)
            try:
                await client.start_notify(uuid, make_cb(name))
                write_row(event="subscribed", char=name)
                print(f"subscribed {name}")
            except Exception as exc:  # noqa: BLE001
                write_row(event="subscribe_failed", char=name, error=str(exc))
                print(f"subscribe {name} failed: {exc}")

        print(f"recording {args.seconds}s (Ctrl+C to stop) ...")
        try:
            await asyncio.sleep(args.seconds)
        except asyncio.CancelledError:
            pass
        for name in targets:
            try:
                await client.stop_notify(CHARS.get(name, name))
            except Exception:
                pass

    write_row(event="summary", counts=counts, seconds=args.seconds)
    print("counts:", counts)
    out.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
