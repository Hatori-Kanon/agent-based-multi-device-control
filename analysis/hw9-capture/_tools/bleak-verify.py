"""Decisive check: does bleak reach the Windows BLE stack from this sandbox?

Read-only advertisement scan, 8 s. Prints every device it sees.
Run with the toolchain venv:
  analysis\\hw9-capture\\_tools\\.venv\\Scripts\\python.exe analysis\\hw9-capture\\_tools\\bleak-verify.py
"""

import asyncio
import sys

import bleak
from bleak import BleakScanner


async def main() -> int:
    version = getattr(bleak, "__version__", None)
    if version is None:  # bleak >= 3 dropped the module attribute
        from importlib.metadata import version as _pkg_version

        version = _pkg_version("bleak")
    print(f"bleak {version} on python {sys.version.split()[0]}")
    try:
        found = await BleakScanner.discover(timeout=8.0, return_adv=True)
    except TypeError:
        # older bleak: return_adv absent
        devices = await BleakScanner.discover(timeout=8.0)
        print(f"scanned: {len(devices)} device(s) (no advertisement data)")
        for d in devices:
            print(f"  {d.address}  {d.name!r}  rssi={getattr(d, 'rssi', '?')}")
        return 0
    except Exception as exc:  # noqa: BLE001 - we want the raw platform error text
        print(f"SCAN FAILED: {type(exc).__name__}: {exc}")
        return 1

    print(f"scanned: {len(found)} device(s) with advertisement data")
    for address, (device, adv) in sorted(found.items(), key=lambda kv: -(kv[1][1].rssi or -999)):
        name = adv.local_name or device.name
        uuids = [str(u) for u in (adv.service_uuids or [])]
        print(f"  {address}  name={name!r}  rssi={adv.rssi}  uuids={uuids}")
        if adv.manufacturer_data:
            for cid, payload in adv.manufacturer_data.items():
                print(f"      mfr 0x{cid:04X} {payload.hex().upper()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
