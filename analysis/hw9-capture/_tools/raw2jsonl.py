"""Convert a raw probe-hw9.py timeline into plan §5 notifications.jsonl rows.

Usage:
  python analysis/hw9-capture/_tools/raw2jsonl.py ^
      --in  analysis/hw9-capture/_tools/.local/s2-raw.jsonl ^
      --out analysis/hw9-capture/<TS>/notifications.jsonl ^
      --note s2-t5t6t7

Only rows from 0x2A37 become notification rows; every other char (vendor fd09 /
fd19) is written to a sibling `<out>.other.jsonl` with the same timestamp so the
vendor stream can still be studied without polluting the HRS file.
Decoding follows plan appendix A, from the raw hex only.
"""

from __future__ import annotations

import argparse
import json
import sys


def decode_hrs(hex_str: str) -> dict:
    data = bytes.fromhex(hex_str)
    if not data:
        raise ValueError("empty payload")
    flags = data[0]
    offset = 1
    u16 = flags & 0x01
    if u16:
        hr = int.from_bytes(data[offset:offset + 2], "little")
        offset += 2
    else:
        hr = data[offset]
        offset += 1
    if flags & 0x08:
        offset += 2
    rr: list[float] = []
    note = ""
    if flags & 0x10:
        while offset + 1 < len(data):
            rr.append(round(int.from_bytes(data[offset:offset + 2], "little") * 1000 / 1024, 1))
            offset += 2
        if offset != len(data):
            note = "trailing byte(s) after RR"
    elif offset != len(data):
        note = "trailing byte(s) without RR flag"
    return {
        "flags": flags,
        "hr": hr,
        "contactStatus": bool(flags & 0x02),
        "contactSupported": bool(flags & 0x04),
        "rrMs": rr,
        "_note": note,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="dst", required=True)
    ap.add_argument("--note", default="")
    args = ap.parse_args()

    out = open(args.dst, "w", encoding="utf-8", newline="\n")
    side = open(args.dst + ".other.jsonl", "w", encoding="utf-8", newline="\n")
    n_hrs = n_other = n_bad = 0
    for line in open(args.src, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        if row.get("event") != "notify":
            continue
        char = (row.get("char") or "").lower()
        hex_str = row.get("hex") or ""
        if char in ("2a37", "00002a37-0000-1000-8000-00805f9b34fb"):
            try:
                decoded = decode_hrs(hex_str)
            except Exception as exc:  # noqa: BLE001
                out.write(json.dumps({
                    "t": row.get("t"), "monoMs": row.get("monoMs"), "tool": "bleak-probe",
                    "service": "180d", "char": "2a37", "hex": hex_str.lower(),
                    "decoded": None, "note": f"decode failed: {exc}",
                }, ensure_ascii=False) + "\n")
                n_bad += 1
                continue
            note = " ".join(x for x in (args.note, decoded.pop("_note", "")) if x)
            out.write(json.dumps({
                "t": row.get("t"), "monoMs": row.get("monoMs"), "tool": "bleak-probe",
                "service": "180d", "char": "2a37", "hex": hex_str.lower(),
                "decoded": decoded, "note": note,
            }, ensure_ascii=False) + "\n")
            n_hrs += 1
        else:
            side.write(json.dumps({
                "t": row.get("t"), "monoMs": row.get("monoMs"), "tool": "bleak-probe",
                "char": char, "hex": hex_str.lower(), "len": row.get("len"),
            }, ensure_ascii=False) + "\n")
            n_other += 1
    out.close()
    side.close()
    print(f"wrote {n_hrs} HRS rows ({n_bad} decode errors) -> {args.dst}")
    print(f"wrote {n_other} other-char rows -> {args.dst}.other.jsonl")
    return 0


if __name__ == "__main__":
    sys.exit(main())
