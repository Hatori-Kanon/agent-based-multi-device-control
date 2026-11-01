"""Per-phase statistics for a capture whose phases are known from wall clock.

The HW9 does not expose contact bits (bit1/bit2 always 0) and has no device
timestamp, so T5/T6/T7 phases can only be attributed by arrival time. This
script makes that attribution explicit and reproducible: give it phase windows
and it reports HR/RR/flag behaviour *per phase*.

  python analysis\\hw9-capture\\_tools\\phase-stats.py ^
      --dir analysis\\hw9-capture\\<TS>-S2 ^
      --phases analysis\\hw9-capture\\<TS>-S2\\exports\\phases.json

phases.json:
  {"phases":[{"name":"t5-rest1","label":"静息基线","start":"2026-11-01T17:56:07","end":"2026-11-01T17:57:25"}, ...]}
Times are local (+08:00 implied).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import statistics

TZ = dt.timezone(dt.timedelta(hours=8))


def parse_local(text: str) -> dt.datetime:
    base = dt.datetime.fromisoformat(text)
    return base.replace(tzinfo=TZ) if base.tzinfo is None else base


def load_rows(path: str) -> list[dict]:
    rows = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        if not row.get("decoded"):
            continue
        rows.append(row)
    return rows


def stats(rows: list[dict]) -> dict:
    n = len(rows)
    hrs = [r["decoded"]["hr"] for r in rows if r["decoded"].get("hr", 0) > 0]
    zero = sum(1 for r in rows if r["decoded"].get("hr") == 0)
    rr_rows = [r for r in rows if r["decoded"].get("rrMs")]
    rrs = [x for r in rr_rows for x in r["decoded"]["rrMs"]]
    bit4 = sum(1 for r in rows if r["decoded"]["flags"] & 0x10)
    pairs = [(a, b) for a, b in zip(rrs, rrs[1:])]
    artifacts = sum(1 for a, b in pairs if abs(b - a) / a > 0.20)
    return {
        "n": n,
        "hr_valid": len(hrs),
        "hr_zero": zero,
        "hr_min": min(hrs) if hrs else None,
        "hr_median": round(statistics.median(hrs), 1) if hrs else None,
        "hr_max": max(hrs) if hrs else None,
        "bit4_packets": bit4,
        "bit4_ratio": round(bit4 / n, 4) if n else None,
        "rr_values": len(rrs),
        "rr_median": round(statistics.median(rrs), 1) if rrs else None,
        "rr_min": round(min(rrs), 1) if rrs else None,
        "rr_max": round(max(rrs), 1) if rrs else None,
        "rr_range_ratio": round(sum(1 for x in rrs if 400 <= x <= 1500) / len(rrs), 4) if rrs else None,
        "artifact_pairs": len(pairs),
        "artifact_hits": artifacts,
        "artifact_rate": round(artifacts / len(pairs), 4) if pairs else None,
        "bpm_from_rr_median": round(60000 / statistics.median(rrs), 1) if rrs else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--phases", required=True)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    rows = load_rows(f"{args.dir}/notifications.jsonl")
    spec = json.load(open(args.phases, encoding="utf-8"))
    out = {"capture_dir": args.dir, "notifications": len(rows), "phases": []}
    print(f"notifications with decoded payload: {len(rows)}")
    for phase in spec["phases"]:
        start, end = parse_local(phase["start"]), parse_local(phase["end"])
        subset = [r for r in rows if start <= dt.datetime.fromisoformat(r["t"]) <= end]
        st = stats(subset)
        st["name"] = phase["name"]
        st["label"] = phase.get("label", "")
        st["start"], st["end"] = phase["start"], phase["end"]
        out["phases"].append(st)
        print(f"{phase['name']:12s} n={st['n']:3d} hr={st['hr_min']}-{st['hr_median']}-{st['hr_max']} "
              f"bit4={st['bit4_ratio']} rr={st['rr_values']} art={st['artifact_rate']}")

    dest = args.out or f"{args.dir}/exports/phases-stats.json"
    json.dump(out, open(dest, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"wrote {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
