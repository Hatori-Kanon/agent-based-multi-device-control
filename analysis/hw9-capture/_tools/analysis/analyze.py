#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CooSpo HW9（0x2A37）通知流离线分析器 —— 纯标准库实现。

输入：
    <capture-dir>/notifications.jsonl   # 计划 §5 格式，一行一条通知
    <capture-dir>/gatt.json             # 可选
    <capture-dir>/meta.json             # 可选
输出：
    <capture-dir>/analysis.json         # 结构化全部指标
    <capture-dir>/analysis.md           # 人读报告（中文）
    控制台摘要

用法：
    python analyze.py <capture-dir>
    python analyze.py <capture-dir> --json
    python analyze.py <capture-dir> --rest-start 60 --rest-sec 300

设计原则（与计划 §4/附录 A 对齐）：
  * 所有数值只从 `hex` 按附录 A 重新解码；`decoded` 仅用于“解码对照差异”统计，
    不参与任何指标计算（原始 hex 优先）。
  * 不猜测：数据不足的 Gate 判据输出 `未验证`，并给出测量值供人工复核。
  * 健康数据只输出聚合统计：不输出逐拍原始 RR 序列、不输出 MAC/序列号。
  * 只用标准库，无第三方依赖。
"""

import argparse
import json
import math
import os
import sys
from collections import Counter, OrderedDict
from datetime import datetime, timezone

SCHEMA_VERSION = "hw9-analysis/1"

# 已知标准服务短 UUID（用于区分“非标准/厂商服务”）
STD_SERVICE_SHORTS = {
    "1800", "1801", "1805", "1809", "180a", "180d", "180f", "1810",
    "181a", "181b", "181c", "181d", "181e", "181f", "1820", "1821",
    "1822", "1823", "1824", "1825", "1826", "1827", "1828",
    "183e", "183f", "1840", "1841",
}

# 代码里统一使用的判定词（渲染时给人读解释）
V_PASS = "pass"
V_FAIL = "fail"
V_UNKNOWN = "未验证"

GATE_LABELS = OrderedDict([
    ("A", "Gate A 可连接"),
    ("B", "Gate B RR 可用"),
    ("B_minus", "Gate B- 仅 bpm"),
    ("C", "Gate C 私有通道"),
    ("D", "Gate D 不可用"),
])


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def _setup_io():
    """Windows 控制台默认可能是 GBK，强制 UTF-8 输出，避免中文报错。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def pct(x, nd=1):
    if x is None:
        return "—"
    return ("{:." + str(nd) + "f}%").format(x * 100.0)


def num(x, nd=1):
    if x is None:
        return "—"
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        return str(x)
    return ("{:." + str(nd) + "f}").format(x)


def rnd(x, nd=3):
    if x is None:
        return None
    try:
        return round(float(x), nd)
    except (TypeError, ValueError):
        return None


def safe_div(a, b):
    if not b:
        return None
    try:
        return float(a) / float(b)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def percentile(vals, p):
    """线性插值百分位（p ∈ [0,100]）。"""
    if not vals:
        return None
    vs = sorted(vals)
    if len(vs) == 1:
        return float(vs[0])
    k = (len(vs) - 1) * (p / 100.0)
    lo = int(math.floor(k))
    hi = int(math.ceil(k))
    if lo == hi:
        return float(vs[lo])
    return vs[lo] + (vs[hi] - vs[lo]) * (k - lo)


def mean(vals):
    if not vals:
        return None
    return sum(vals) / float(len(vals))


def median_of(vals):
    if not vals:
        return None
    vs = sorted(vals)
    n = len(vs)
    if n % 2 == 1:
        return float(vs[n // 2])
    return (vs[n // 2 - 1] + vs[n // 2]) / 2.0


def pstdev(vals):
    if len(vals) < 2:
        return None
    m = mean(vals)
    return math.sqrt(sum((v - m) ** 2 for v in vals) / float(len(vals)))


def rmssd(vals):
    """连续相邻差均方根（只作 sanity，不宣称临床值）。"""
    if len(vals) < 2:
        return None
    ds = [vals[i + 1] - vals[i] for i in range(len(vals) - 1)]
    return math.sqrt(sum(d * d for d in ds) / float(len(ds)))


def fmt_rel(t):
    if t is None:
        return "—"
    return "{:+.1f}s".format(t)


def fmt_epoch(epoch):
    if epoch is None:
        return "—"
    try:
        return datetime.fromtimestamp(epoch).astimezone().isoformat(timespec="milliseconds")
    except Exception:
        return "—"


def fmt_duration(sec):
    if sec is None:
        return "未验证"
    if sec < 60:
        return "{:.1f}s".format(sec)
    m, s = divmod(sec, 60.0)
    return "{:.0f}m{:04.1f}s".format(m, s)


def md_table(headers, rows):
    def cell(c):
        s = "" if c is None else str(c)
        return s.replace("|", "\\|")

    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        out.append("| " + " | ".join(cell(c) for c in row) + " |")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# UUID / 解码
# ---------------------------------------------------------------------------

def norm_uuid(u):
    if u is None:
        return ""
    s = str(u).strip().lower()
    if s.startswith("0x"):
        s = s[2:]
    for ch in ("-", "_", " ", "{"):
        s = s.replace(ch, "")
    s = s.replace("}", "")
    return s


def short_uuid(u):
    """尽量取 16-bit 短 UUID；取不到就返回规范化后的原串。"""
    n = norm_uuid(u)
    if not n:
        return ""
    if len(n) == 4:
        return n
    if len(n) == 8:
        if n.startswith("0000"):
            return n[4:8]
        return n
    if len(n) == 32:
        return n[4:8]
    if len(n) > 8:
        return n
    return n


CHAR_ALIASES = {
    "heartratemeasurement", "heart_rate_measurement", "heartrate",
    "heart_rate", "2a37", "00002a37", "00002a3700001000800000805f9b34fb",
}
SERVICE_ALIASES = {
    "heartrate", "heart_rate", "180d", "0000180d",
    "0000180d00001000800000805f9b34fb",
}


def char_is_hrs(char):
    if char is None or str(char).strip() == "":
        return None  # 未标注 → 由调用方按 §5 约定当作 HRS
    n = norm_uuid(char)
    if short_uuid(n) == "2a37":
        return True
    s = n.replace("-", "").replace("_", "")
    return s in CHAR_ALIASES


def service_is_hrs(service):
    if service is None or str(service).strip() == "":
        return None
    n = norm_uuid(service)
    if short_uuid(n) == "180d":
        return True
    s = n.replace("-", "").replace("_", "")
    return s in SERVICE_ALIASES


def decode_hrs_hex(hexstr):
    """按计划附录 A 从原始 hex 解码 0x2A37。

    返回 (dec, err)：
      dec 可能只包含已解析出的前缀字段（例如 flags 解析成功但 HR 被截断），
      这样即使解码失败也能统计 flags 分布。
    """
    dec = {
        "flags": None,
        "hr": None,
        "energy_kj": None,
        "rr_raw": [],
        "rr_ms": [],
        "contact": None,
        "contact_supported": None,
        "trailing_hex": "",
        "nbytes": 0,
    }
    if hexstr is None:
        return dec, "missing_hex"
    s = str(hexstr).strip().replace(" ", "").replace("\t", "")
    if s == "":
        return dec, "empty_hex"
    if s.lower().startswith("0x"):
        s = s[2:]
    if len(s) % 2 != 0:
        return dec, "odd_hex_len"
    try:
        b = bytes.fromhex(s)
    except ValueError:
        return dec, "bad_hex"
    dec["nbytes"] = len(b)
    if len(b) < 1:
        return dec, "too_short"
    flags = b[0]
    dec["flags"] = flags
    dec["contact_supported"] = bool(flags & 0x04)
    dec["contact"] = bool(flags & 0x02)
    off = 1
    u16 = flags & 0x01
    need = 2 if u16 else 1
    if len(b) < off + need:
        return dec, "truncated_hr"
    dec["hr"] = int.from_bytes(b[off:off + need], "little")
    off += need
    if flags & 0x08:
        if len(b) < off + 2:
            return dec, "truncated_energy"
        dec["energy_kj"] = int.from_bytes(b[off:off + 2], "little")
        off += 2
    if flags & 0x10:
        while off + 1 < len(b):
            raw = int.from_bytes(b[off:off + 2], "little")
            dec["rr_raw"].append(raw)
            dec["rr_ms"].append(raw * 1000.0 / 1024.0)
            off += 2
        if not dec["rr_raw"]:
            dec["trailing_hex"] = b[off:].hex().upper()
            return dec, "rr_flag_without_data"
        if off != len(b):
            dec["trailing_hex"] = b[off:].hex().upper()
    else:
        if off != len(b):
            dec["trailing_hex"] = b[off:].hex().upper()
    return dec, None


def check_decoded_mismatch(row, dec):
    """把 §5 的 decoded 与 hex 重解结果对照；只做质量统计，不当真值。"""
    d = row.get("decoded")
    if not isinstance(d, dict):
        return None
    fields = []

    def cmp_field(name, a, b):
        if a is None or b is None:
            return
        if isinstance(a, bool) or isinstance(b, bool):
            ok = bool(a) == bool(b)
        elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
            ok = abs(float(a) - float(b)) <= 1.0
        elif isinstance(a, list) and isinstance(b, list):
            ok = len(a) == len(b) and all(
                abs(float(x) - float(y)) <= 1.0 for x, y in zip(a, b))
        else:
            ok = a == b
        fields.append({"field": name, "decoded": a, "from_hex": b, "match": ok})

    if "flags" in d:
        cmp_field("flags", d.get("flags"), dec.get("flags"))
    if "hr" in d:
        cmp_field("hr", d.get("hr"), dec.get("hr"))
    if "contactStatus" in d:
        cmp_field("contactStatus", d.get("contactStatus"), dec.get("contact"))
    if "contactSupported" in d:
        cmp_field("contactSupported", d.get("contactSupported"),
                  dec.get("contact_supported"))
    if "rrMs" in d:
        cmp_field("rrMs", d.get("rrMs"), [round(v, 1) for v in dec.get("rr_ms", [])])
    bad = [f for f in fields if not f["match"]]
    return {"compared_fields": len(fields), "mismatch_fields": len(bad),
            "mismatches": bad[:10]}


# ---------------------------------------------------------------------------
# 加载输入
# ---------------------------------------------------------------------------

def load_json_file(path):
    if not os.path.isfile(path):
        return None, "文件不存在"
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f), None
    except Exception as e:  # noqa: BLE001 - 容忍脏文件
        return None, "JSON 解析失败: {}".format(e)


def load_jsonl(path):
    rows, bad = [], []
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception as e:  # noqa: BLE001
                bad.append({"line": lineno, "error": str(e)})
                continue
            if not isinstance(obj, dict):
                bad.append({"line": lineno, "error": "不是 JSON 对象"})
                continue
            rows.append(obj)
    return rows, bad


def parse_iso_epoch(s):
    if not isinstance(s, str) or not s.strip():
        return None
    s = s.strip()
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        # 无时区按 UTC 处理：只影响绝对时间显示，不影响相对时长
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def parse_number(x):
    if isinstance(x, bool) or x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, str):
        try:
            return float(x.strip())
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------------------
# 记录构建与时间轴
# ---------------------------------------------------------------------------

def build_records(rows, warnings):
    """把 jsonl 行分类成：HRS 通知 / 其他通知流 / 非通知行。"""
    non_notification = 0
    recs = []
    seq = 0
    for row in rows:
        if "hex" not in row:
            # 例如 harness 的 device info 行，不算通知
            non_notification += 1
            continue
        raw_hex = row.get("hex")
        raw_char = row.get("char")
        raw_service = row.get("service")
        is_hrs = char_is_hrs(raw_char)
        if is_hrs is None:
            svc_flag = service_is_hrs(raw_service)
            is_hrs = True if svc_flag is None else svc_flag
        kind = "hrs" if is_hrs else "other"
        rec = {
            "seq": seq,
            "row": row,
            "hex": "" if raw_hex is None else str(raw_hex).strip(),
            "tool": row.get("tool"),
            "service": raw_service,
            "char": raw_char,
            "kind": kind,
            "t_abs": parse_iso_epoch(row.get("t")),
            "mono": parse_number(row.get("monoMs")),
            "dec": None,
            "err": None,
            "flags": None,
            "t": None,
            "t_rel": None,
        }
        if kind == "hrs":
            dec, err = decode_hrs_hex(raw_hex)
            rec["dec"] = dec
            rec["err"] = err
            rec["flags"] = dec.get("flags")
        seq += 1
        recs.append(rec)
    return recs, non_notification


def assign_times(recs):
    """给一组记录分配时间；返回 (time_source, verified)。"""
    if not recs:
        return "empty", False
    has_t = all(r["t_abs"] is not None for r in recs)
    has_mono = all(r["mono"] is not None for r in recs)
    if has_t:
        times, source, verified = [r["t_abs"] for r in recs], "t", True
    elif has_mono:
        times, source, verified = [r["mono"] / 1000.0 for r in recs], "monoMs", True
    else:
        times, source, verified = [float(i) for i in range(len(recs))], "order", False
    t0 = times[0]
    for r, tv in zip(recs, times):
        r["t"] = tv
        r["t_rel"] = tv - t0 if verified else None
    return source, verified


def interval_metrics(recs, verified, gap_sec):
    """到达间隔、>gap_sec 空档、非单调时间戳。"""
    res = {
        "available": bool(verified),
        "count": 0,
        "median": None,
        "min": None,
        "max": None,
        "mean": None,
        "negative_count": 0,
        "zero_count": 0,
        "gaps": [],
        "gaps_count": 0,
    }
    if not verified or len(recs) < 2:
        return res
    diffs = []
    for a, b in zip(recs, recs[1:]):
        d = b["t"] - a["t"]
        if d < 0:
            res["negative_count"] += 1
            continue
        if d == 0:
            res["zero_count"] += 1
        diffs.append(d)
        if d > gap_sec:
            res["gaps"].append({
                "from_rel": rnd(a["t_rel"], 3),
                "to_rel": rnd(b["t_rel"], 3),
                "from_t": fmt_epoch(a["t_abs"]),
                "to_t": fmt_epoch(b["t_abs"]),
                "gap_sec": rnd(d, 3),
            })
    # 空档也记录文件顺序位置，便于对照
    res["gaps_count"] = len(res["gaps"])
    if diffs:
        res["count"] = len(diffs)
        res["median"] = rnd(median_of(diffs), 3)
        res["min"] = rnd(min(diffs), 3)
        res["max"] = rnd(max(diffs), 3)
        res["mean"] = rnd(mean(diffs), 3)
    return res


# ---------------------------------------------------------------------------
# 各维度指标
# ---------------------------------------------------------------------------

def flags_metrics(attempts):
    hist = OrderedDict()
    bit_counts = Counter()
    length_dist = Counter()
    by_flags = OrderedDict()
    rfu = Counter()
    n = 0
    for rec in attempts:
        dec = rec["dec"]
        if dec is None or dec.get("flags") is None:
            continue
        n += 1
        f = dec["flags"]
        length_dist[dec["nbytes"]] += 1
        hist[f] = hist.get(f, 0) + 1
        for bit in range(5):
            if f & (1 << bit):
                bit_counts[bit] += 1
        for bit in range(5, 8):
            if f & (1 << bit):
                rfu[bit] += 1
        item = by_flags.setdefault(f, {
            "lengths": Counter(), "count": 0,
            "sample_hex": rec["hex"], "rr_counts": Counter(),
        })
        item["count"] += 1
        item["lengths"][dec["nbytes"]] += 1
        if dec.get("rr_ms") is not None:
            item["rr_counts"][len(dec["rr_ms"])] += 1
    histogram = []
    for f, c in sorted(hist.items()):
        bits = [i for i in range(8) if f & (1 << i)]
        histogram.append({
            "flags": f,
            "flags_hex": "0x{:02X}".format(f),
            "bits_set": bits,
            "count": c,
            "ratio": rnd(c / float(n)) if n else None,
        })
    bit_rates = {}
    for bit in range(5):
        bit_rates["bit{}".format(bit)] = {
            "name": ["HR uint16", "contact_status", "contact_supported",
                     "energy_expended", "rr_interval"][bit],
            "set_count": bit_counts[bit],
            "ratio": rnd(bit_counts[bit] / float(n)) if n else None,
        }
    rfu_out = {"bits_set": sorted(rfu.keys()),
               "count": sum(rfu.values()),
               "warning": bool(rfu)}
    length_by_flags = OrderedDict()
    for f, item in by_flags.items():
        length_by_flags["0x{:02X}".format(f)] = {
            "count": item["count"],
            "length_dist": {str(k): v for k, v in sorted(item["lengths"].items())},
            "rr_count_dist": {str(k): v for k, v in sorted(item["rr_counts"].items())},
            "sample_hex": item["sample_hex"],
        }
    return {
        "n_packets_with_flags": n,
        "histogram": histogram,
        "bit_rates": bit_rates,
        "rfu": rfu_out,
        "length_dist": {str(k): v for k, v in sorted(length_dist.items())},
        "length_by_flags": length_by_flags,
    }


def hr_metrics(valid_recs, all_recs):
    hrs = []
    zero = 0
    gt250 = 0
    missing = 0
    for rec in valid_recs:
        dec = rec["dec"]
        if dec is None or dec.get("hr") is None:
            missing += 1
            continue
        h = dec["hr"]
        if h == 0:
            zero += 1
            continue
        if h > 250:
            gt250 += 1
            continue
        hrs.append(h)
    # 解码失败的包也属于“HR 缺失”
    missing += max(0, len(all_recs) - len(valid_recs))
    deltas = [b - a for a, b in zip(hrs, hrs[1:])]
    absd = [abs(d) for d in deltas]
    buckets = {"0": 0, "1-2": 0, "3-5": 0, "6-10": 0, "11-20": 0, ">20": 0}
    for a in absd:
        if a == 0:
            buckets["0"] += 1
        elif a <= 2:
            buckets["1-2"] += 1
        elif a <= 5:
            buckets["3-5"] += 1
        elif a <= 10:
            buckets["6-10"] += 1
        elif a <= 20:
            buckets["11-20"] += 1
        else:
            buckets[">20"] += 1
    return {
        "valid_count": len(hrs),
        "zero_count": zero,
        "missing_count": missing,
        "gt250_count": gt250,
        "min": min(hrs) if hrs else None,
        "max": max(hrs) if hrs else None,
        "median": rnd(median_of(hrs), 1) if hrs else None,
        "mean": rnd(mean(hrs), 1) if hrs else None,
        "p5": rnd(percentile(hrs, 5), 1) if hrs else None,
        "p95": rnd(percentile(hrs, 95), 1) if hrs else None,
        "delta": {
            "count": len(deltas),
            "min": rnd(min(deltas), 1) if deltas else None,
            "max": rnd(max(deltas), 1) if deltas else None,
            "median": rnd(median_of(deltas), 1) if deltas else None,
            "mean_abs": rnd(mean(absd), 2) if absd else None,
            "p95_abs": rnd(percentile(absd, 95), 1) if absd else None,
            "buckets_abs": buckets,
        },
        "valid_range": "1..250",
    }


def rr_stats(vals):
    in_range = [v for v in vals if 400.0 <= v <= 1500.0]
    below = [v for v in vals if v < 400.0]
    above = [v for v in vals if v > 1500.0]
    return {
        "count": len(vals),
        "min": rnd(min(vals), 1) if vals else None,
        "max": rnd(max(vals), 1) if vals else None,
        "median": rnd(median_of(vals), 1) if vals else None,
        "mean": rnd(mean(vals), 1) if vals else None,
        "p5": rnd(percentile(vals, 5), 1) if vals else None,
        "p95": rnd(percentile(vals, 95), 1) if vals else None,
        "stdev": rnd(pstdev(vals), 1) if vals else None,
        "in_range_count": len(in_range),
        "in_range_ratio": rnd(len(in_range) / float(len(vals))) if vals else None,
        "below_400_count": len(below),
        "above_1500_count": len(above),
    }


def artifact_metrics(entries, threshold):
    """粗伪影率：| rr[i+1] - rr[i] | / rr[i] > threshold。"""
    res = {
        "threshold": threshold,
        "pairs": 0,
        "hits": 0,
        "rate": None,
        "within_packet_pairs": 0,
        "within_packet_hits": 0,
        "cross_packet_pairs": 0,
        "cross_packet_hits": 0,
        "ratio_median": None,
        "ratio_p95": None,
        "ratio_max": None,
        "hits_detail": [],
    }
    if len(entries) < 2:
        return res
    ratios = []
    for a, b in zip(entries, entries[1:]):
        prev, cur = a["rr"], b["rr"]
        if prev is None or cur is None or prev <= 0:
            continue
        ratio = abs(cur - prev) / prev
        ratios.append(ratio)
        res["pairs"] += 1
        within = a["pkt"] == b["pkt"]
        if within:
            res["within_packet_pairs"] += 1
        else:
            res["cross_packet_pairs"] += 1
        if ratio > threshold:
            res["hits"] += 1
            if within:
                res["within_packet_hits"] += 1
            else:
                res["cross_packet_hits"] += 1
            if len(res["hits_detail"]) < 20:
                res["hits_detail"].append({
                    "t_rel": rnd(b.get("t_rel"), 3),
                    "prev": rnd(prev, 1),
                    "cur": rnd(cur, 1),
                    "change_pct": rnd(ratio, 4),
                })
    if res["pairs"]:
        res["rate"] = rnd(res["hits"] / float(res["pairs"]), 4)
        res["ratio_median"] = rnd(median_of(ratios), 4)
        res["ratio_p95"] = rnd(percentile(ratios, 95), 4)
        res["ratio_max"] = rnd(max(ratios), 4)
    return res


def per_packet_rr_metrics(attempts):
    counts = Counter()
    denom = 0
    rr_packets = 0
    for rec in attempts:
        dec = rec["dec"]
        if dec is None or dec.get("flags") is None:
            continue
        denom += 1
        rr = dec.get("rr_ms") or []
        counts[len(rr)] += 1
        if rr:
            rr_packets += 1
    multi = sum(v for k, v in counts.items() if k >= 2)
    dist = {str(k): v for k, v in sorted(counts.items())}
    return {
        "denominator": denom,
        "length_dist": dist,
        "rr_packet_count": rr_packets,
        "rr_packet_ratio": rnd(rr_packets / float(denom)) if denom else None,
        "multi_rr_count": multi,
        "multi_rr_ratio": rnd(multi / float(denom)) if denom else None,
        "max_rr_per_packet": max(counts.keys()) if counts else None,
        "median_rr_per_packet": rnd(median_of(
            [k for k, v in counts.items() for _ in range(v)]), 1) if counts else None,
    }


def window_metrics(entries, duration, window_sec):
    """按固定窗口（默认 60s，从首条通知起算）统计 RR 与 RMSSD。"""
    empty = {"available": False, "windows": [], "rmssd_median": None,
             "rmssd_min": None, "rmssd_max": None, "rmssd_count": 0,
             "reason": ""}
    if duration is None:
        empty["reason"] = "无可用时间戳"
        return empty
    if not entries:
        empty["reason"] = "无 RR 数据（bit4 从未置位，或 RR 全部解码失败）"
        return empty
    groups = {}
    for e in entries:
        if e.get("t_rel") is None:
            continue
        idx = int(math.floor(e["t_rel"] / window_sec))
        groups.setdefault(idx, []).append(e)
    windows = []
    for idx in sorted(groups):
        es = groups[idx]
        vals = [e["rr"] for e in es]
        start = idx * window_sec
        complete = duration is not None and (start + window_sec) <= duration + 1e-9
        item = {
            "start_rel": rnd(start, 3),
            "end_rel": rnd(start + window_sec, 3),
            "complete": complete,
            "n_rr": len(vals),
            "n_packets": len(set(e["pkt"] for e in es)),
            "rr_median": rnd(median_of(vals), 1),
            "rr_p5": rnd(percentile(vals, 5), 1),
            "rr_p95": rnd(percentile(vals, 95), 1),
            "rmssd": rnd(rmssd(vals), 1) if len(vals) >= 3 else None,
        }
        windows.append(item)
    rms = [w["rmssd"] for w in windows if w["rmssd"] is not None]
    return {
        "available": True,
        "window_sec": window_sec,
        "count": len(windows),
        "windows": windows,
        "rmssd_count": len(rms),
        "rmssd_median": rnd(median_of(rms), 1) if rms else None,
        "rmssd_min": rnd(min(rms), 1) if rms else None,
        "rmssd_max": rnd(max(rms), 1) if rms else None,
        "rmssd_note": "RMSSD 只作 sanity check，不宣称临床值",
    }


def contact_state_of(dec):
    """0x2A37 的接触位语义（供人工/扩展使用）。

    bit2=1 时 bit1 才有效；bit2=0 且 bit1=1 视为矛盾包（inconsistent）。
    """
    if dec is None or dec.get("flags") is None:
        return None
    supported = bool(dec["flags"] & 0x04)
    contact = bool(dec["flags"] & 0x02)
    if not supported:
        return "inconsistent" if contact else "unsupported"
    return "contact" if contact else "no-contact"


def contact_metrics(attempts, times_verified):
    """接触状态时间轴。

    只有 bit2=1（设备声明支持接触检测）的包才进入时间轴；
    bit2=0 的包（含 bit1=1 的矛盾包）跳过，单列为 inconsistent/unsupported。
    """
    n_flags = 0
    supported = 0
    detected = 0
    inconsistent = 0
    unsupported = 0
    timeline = []
    for rec in attempts:
        dec = rec["dec"]
        if dec is None or dec.get("flags") is None:
            continue
        n_flags += 1
        f = dec["flags"]
        if f & 0x04:
            supported += 1
            if f & 0x02:
                detected += 1
            timeline.append(("contact" if (f & 0x02) else "no-contact", rec))
        elif f & 0x02:
            inconsistent += 1
        else:
            unsupported += 1

    segs = []
    transitions = []
    for st, rec in timeline:
        if not segs or segs[-1]["state"] != st:
            if segs:
                transitions.append({
                    "from": segs[-1]["state"],
                    "to": st,
                    "at_rel": rec["t_rel"],
                    "at_t": fmt_epoch(rec["t_abs"]),
                })
            segs.append({"state": st, "recs": [], "start": rec["t"]})
        segs[-1]["recs"].append(rec)
        segs[-1]["end"] = rec["t"]
        segs[-1]["end_rel"] = rec["t_rel"]
    out_segments = []
    for seg in segs:
        rs = seg["recs"]
        hr_vals = [r["dec"]["hr"] for r in rs
                   if r["dec"] and r["dec"].get("hr") is not None
                   and 0 < r["dec"]["hr"] <= 250]
        hr_zero = sum(1 for r in rs
                      if r["dec"] and r["dec"].get("hr") == 0)
        dur = None
        if times_verified and len(rs) >= 1:
            dur = rs[-1]["t"] - rs[0]["t"]
        out_segments.append({
            "state": seg["state"],
            "start_rel": rnd(rs[0]["t_rel"], 3),
            "end_rel": rnd(seg.get("end_rel"), 3),
            "start_t": fmt_epoch(rs[0]["t_abs"]),
            "end_t": fmt_epoch(rs[-1]["t_abs"]),
            "count": len(rs),
            "duration_sec": rnd(dur, 3),
            "hr_median": rnd(median_of(hr_vals), 1) if hr_vals else None,
            "hr_zero_count": hr_zero,
            "notif_per_min": rnd(safe_div(len(rs) * 60.0, dur), 2) if dur else None,
        })
    # T5 启发式：摘下→戴上，HR 恢复时间
    detach_events = []
    if times_verified:
        for i, tr in enumerate(transitions):
            if tr["to"] != "no-contact":
                continue
            t_detach = tr["at_rel"]
            on = None
            for tr2 in transitions[i + 1:]:
                if tr2["to"] == "contact":
                    on = tr2["at_rel"]
                    break
            if on is None:
                detach_events.append({
                    "detach_rel": rnd(t_detach, 3),
                    "recontact_rel": None,
                    "detach_duration_sec": None,
                    "hr_zero_in_detach": None,
                    "recovery_sec": None,
                    "note": "未观察到重新接触",
                })
                continue
            det_recs = [r for r in attempts
                        if r["t_rel"] is not None and t_detach <= r["t_rel"] < on]
            zeros = sum(1 for r in det_recs
                        if r["dec"] and r["dec"].get("hr") == 0)
            pre = [r["dec"]["hr"] for r in attempts
                   if r["t_rel"] is not None
                   and t_detach - 30.0 <= r["t_rel"] < t_detach
                   and r["dec"] and r["dec"].get("hr") is not None
                   and 0 < r["dec"]["hr"] <= 250]
            baseline = median_of(pre) if pre else None
            recovery = None
            if baseline:
                lo, hi = baseline * 0.8, baseline * 1.2
                for r in attempts:
                    if r["t_rel"] is None or r["t_rel"] < on:
                        continue
                    if r["t_rel"] > on + 120.0:
                        break
                    if r["dec"] and r["dec"].get("hr") is not None \
                            and lo <= r["dec"]["hr"] <= hi:
                        recovery = r["t_rel"] - on
                        break
            detach_events.append({
                "detach_rel": rnd(t_detach, 3),
                "recontact_rel": rnd(on, 3),
                "detach_duration_sec": rnd(on - t_detach, 3),
                "hr_zero_in_detach": zeros,
                "pre_hr_median": rnd(baseline, 1),
                "recovery_sec": rnd(recovery, 3),
                "note": "启发式：恢复=重新接触后首个 HR 回到摘下前 30s 中位数 ±20%",
            })
    else:
        detach_events.append({"note": "无可用时间戳，T5 恢复时间未验证"})
    return {
        "packets_with_flags": n_flags,
        "packets_with_contact_bits": supported,
        "contact_supported_count": supported,
        "contact_supported_ratio": rnd(support_to_ratio(supported, n_flags)),
        "contact_detected_count": detected,
        "contact_detected_ratio": rnd(support_to_ratio(detected, supported)),
        "inconsistent_count": inconsistent,
        "unsupported_count": unsupported,
        "segments": out_segments,
        "transitions": transitions,
        "detach_events": detach_events,
        "note": "仅 bit2=1 的包进入状态时间轴；bit2=0 的包跳过并单列。",
    }


def support_to_ratio(a, b):
    if not b:
        return None
    return float(a) / float(b)


def motion_metrics(entries, attempts, times_verified, bin_sec, artifact_threshold,
                   motion_ratio, min_pairs):
    bins = {}
    if not times_verified:
        return {"available": False, "segments": [], "bins": [],
                "note": "无可用时间戳，运动段未验证"}
    for e in entries:
        if e["t_rel"] is None:
            continue
        idx = int(math.floor(e["t_rel"] / bin_sec))
        bins.setdefault(idx, {"pairs": 0, "hits": 0, "max_jump": 0.0,
                              "hr_deltas": [], "hrs": []})
    for a, b in zip(entries, entries[1:]):
        if a["t_rel"] is None or b["t_rel"] is None:
            continue
        ia = int(math.floor(a["t_rel"] / bin_sec))
        ib = int(math.floor(b["t_rel"] / bin_sec))
        if ia != ib or ia not in bins:
            continue
        prev, cur = a["rr"], b["rr"]
        if prev <= 0:
            continue
        ratio = abs(cur - prev) / prev
        bins[ia]["pairs"] += 1
        bins[ia]["max_jump"] = max(bins[ia]["max_jump"], ratio)
        if ratio > artifact_threshold:
            bins[ia]["hits"] += 1
    prev_hr = None
    for rec in attempts:
        if rec["t_rel"] is None or rec["dec"] is None:
            continue
        h = rec["dec"].get("hr")
        if h is None or not (0 < h <= 250):
            prev_hr = None
            continue
        idx = int(math.floor(rec["t_rel"] / bin_sec))
        if idx in bins:
            bins[idx]["hrs"].append(h)
            if prev_hr is not None:
                bins[idx]["hr_deltas"].append(abs(h - prev_hr))
        prev_hr = h
    bin_list = []
    motion_idxs = []
    for idx in sorted(bins):
        b = bins[idx]
        rate = safe_div(b["hits"], b["pairs"])
        motion = (b["pairs"] >= min_pairs and rate is not None
                  and rate >= motion_ratio)
        if motion:
            motion_idxs.append(idx)
        bin_list.append({
            "bin_start_rel": rnd(idx * bin_sec, 3),
            "bin_end_rel": rnd((idx + 1) * bin_sec, 3),
            "pairs": b["pairs"],
            "hits": b["hits"],
            "artifact_rate": rnd(rate, 4),
            "max_jump": rnd(b["max_jump"], 4),
            "hr_median": rnd(median_of(b["hrs"]), 1) if b["hrs"] else None,
            "max_abs_dhr": rnd(max(b["hr_deltas"]), 1) if b["hr_deltas"] else None,
            "mean_abs_dhr": rnd(mean(b["hr_deltas"]), 2) if b["hr_deltas"] else None,
            "motion": motion,
        })
    # 合并相邻运动 bin 为运动段
    segments = []
    for idx in motion_idxs:
        if segments and idx == segments[-1]["_last"] + 1:
            seg = segments[-1]
            seg["_last"] = idx
        else:
            segments.append({"_first": idx, "_last": idx})
    for seg in segments:
        idxs = [i for i in motion_idxs if seg["_first"] <= i <= seg["_last"]]
        sel = [b for b in bin_list
               if int(round(b["bin_start_rel"] / bin_sec)) in idxs]
        pairs = sum(b["pairs"] for b in sel)
        hits = sum(b["hits"] for b in sel)
        jump = max([b["max_jump"] for b in sel if b["max_jump"] is not None] or [0])
        dhr = [b["max_abs_dhr"] for b in sel if b["max_abs_dhr"] is not None]
        seg.update({
            "start_rel": rnd(seg["_first"] * bin_sec, 3),
            "end_rel": rnd((seg["_last"] + 1) * bin_sec, 3),
            "pairs": pairs,
            "hits": hits,
            "artifact_rate": rnd(safe_div(hits, pairs), 4),
            "max_jump_ratio": rnd(jump, 4),
            "max_abs_dhr": rnd(max(dhr), 1) if dhr else None,
        })
        seg.pop("_first")
        seg.pop("_last")
    return {
        "available": True,
        "bin_sec": bin_sec,
        "artifact_threshold": artifact_threshold,
        "motion_ratio_threshold": motion_ratio,
        "min_pairs_per_bin": min_pairs,
        "bins": bin_list,
        "segments": segments,
        "note": "运动段=相邻运动 bin 合并；仅统计 RR 对足够（≥min_pairs）且伪影率≥阈值的 bin",
    }


def dropout_metrics(hrs_all, intervals, duration, rr_median, times_verified):
    """丢拍估计：①到达间隔空档 ②RR 累计（相邻 RR 包之间的拍数缺口）。

    两种都是估计，不宣称精确。
    """
    out = {
        "arrival": {"available": bool(times_verified)},
        "rr_accumulation": {"available": False},
        "clusters": [],
    }
    if times_verified and intervals.get("count"):
        m = intervals["median"]
        est = 0
        for g in intervals["gaps"]:
            missed = max(0, int(round(g["gap_sec"] / m)) - 1) if m else 0
            g["est_missed_notifications"] = missed
            est += missed
        n = intervals["count"] + 1
        out["arrival"] = {
            "available": True,
            "median_interval_sec": m,
            "gap_count": intervals["gaps_count"],
            "est_missed_notifications": est,
            "est_missed_ratio": rnd(est / float(n + est), 4) if (n + est) else None,
            "note": "估丢=Σ(max(0, round(gap/中位间隔)-1))，按到达间隔估计",
        }
        out["clusters"] = [
            {
                "start_rel": g["from_rel"],
                "end_rel": g["to_rel"],
                "duration_sec": g["gap_sec"],
                "est_missed_notifications": g.get("est_missed_notifications"),
            }
            for g in intervals["gaps"]
        ]
    # ② RR 累计法：找“相邻两条都带 RR 的通知包”之间的到达空档，
    #    用 Δt/中位RR 估计应到拍数，再减去后一包实际携带的 RR 数。
    rr_acc = {
        "available": False,
        "pairs": 0,
        "est_missing_beats": 0.0,
        "est_missing_ratio": None,
        "detail": [],
        "note": "对相邻两条都带 RR 的通知包：expected=Δt/中位RR、delivered=后一包 RR 数；"
                "仅 Δt>1.5×中位间隔时计入（即通知流出现空档但两端都有 RR）",
    }
    if times_verified and rr_median:
        median_interval = intervals.get("median")
        total_expected = 0.0
        total_missing = 0.0
        pair_count = 0
        for a, b in zip(hrs_all, hrs_all[1:]):
            if a["t_rel"] is None or b["t_rel"] is None:
                continue
            a_rr = a["dec"].get("rr_ms") if a["dec"] else None
            b_rr = b["dec"].get("rr_ms") if b["dec"] else None
            if not a_rr or not b_rr:
                continue
            dt = b["t_rel"] - a["t_rel"]
            if median_interval and dt <= 1.5 * median_interval:
                continue
            expected = dt / (rr_median / 1000.0)
            delivered = len(b_rr)
            missing = max(0.0, round(expected - delivered))
            total_expected += expected
            total_missing += missing
            pair_count += 1
            if len(rr_acc["detail"]) < 20:
                rr_acc["detail"].append({
                    "start_rel": rnd(a["t_rel"], 3),
                    "end_rel": rnd(b["t_rel"], 3),
                    "delta_sec": rnd(dt, 3),
                    "expected_beats": rnd(expected, 1),
                    "delivered_rr": delivered,
                    "est_missing_beats": rnd(missing, 1),
                })
        rr_acc["available"] = True
        rr_acc["pairs"] = pair_count
        rr_acc["est_missing_beats"] = rnd(total_missing, 1)
        rr_acc["est_missing_ratio"] = (rnd(total_missing / total_expected, 4)
                                       if total_expected else 0.0)
        if total_expected == 0:
            rr_acc["note"] += "；本捕获未发现符合条件的空档"
    out["rr_accumulation"] = rr_acc
    return out


# ---------------------------------------------------------------------------
# GATT / 私有通道
# ---------------------------------------------------------------------------

def gatt_summary(gatt, gatt_err):
    out = {
        "present": gatt is not None,
        "error": gatt_err,
        "services": [],
        "has_180d": False,
        "has_2a37": False,
        "has_2a37_notify": False,
        "nonstandard_notify": [],
        "advertisement": None,
    }
    if not isinstance(gatt, dict):
        return out
    if isinstance(gatt.get("advertisement"), dict):
        adv = gatt["advertisement"]
        out["advertisement"] = {
            "name": adv.get("name"),
            "services": adv.get("services"),
            "manufacturerData": adv.get("manufacturerData"),
        }
    for svc in gatt.get("services") or []:
        if not isinstance(svc, dict):
            continue
        s_short = short_uuid(svc.get("uuid"))
        is_std = svc.get("standard")
        if is_std is None:
            is_std = s_short in STD_SERVICE_SHORTS
        is_180d = (s_short == "180d")
        chars = []
        for ch in svc.get("characteristics") or []:
            if not isinstance(ch, dict):
                continue
            c_short = short_uuid(ch.get("uuid"))
            props = ch.get("properties") or []
            if isinstance(props, str):
                props = [props]
            props = [str(p).lower() for p in props]
            notify = any(p in ("notify", "indicate") for p in props)
            if c_short == "2a37":
                out["has_2a37"] = True
                if notify:
                    out["has_2a37_notify"] = True
            chars.append({
                "uuid": ch.get("uuid"),
                "short": c_short,
                "name": ch.get("name"),
                "properties": props,
                "cccd": ch.get("cccd"),
                "userDescription": ch.get("userDescription"),
                "notify": notify,
            })
            if (not is_std) and notify:
                out["nonstandard_notify"].append({
                    "service_uuid": svc.get("uuid"),
                    "service_short": s_short,
                    "service_name": svc.get("name"),
                    "char_uuid": ch.get("uuid"),
                    "char_short": c_short,
                    "char_name": ch.get("name"),
                })
        if is_180d:
            out["has_180d"] = True
        out["services"].append({
            "uuid": svc.get("uuid"),
            "short": s_short,
            "name": svc.get("name"),
            "standard": bool(is_std),
            "characteristics": chars,
        })
    return out


def private_channel_metrics(recs, gatt_sum):
    """非 HRS 通知流的周期/数值候选分析（只列候选，不猜协议）。"""
    groups = {}
    for rec in recs:
        key = (str(rec["service"]), str(rec["char"]))
        groups.setdefault(key, []).append(rec)
    streams = []
    for key, rs in groups.items():
        assign_times(rs)
        verified = all(r["t_rel"] is not None for r in rs)
        intervals = []
        for a, b in zip(rs, rs[1:]):
            if a["t_rel"] is not None and b["t_rel"] is not None:
                intervals.append(b["t_rel"] - a["t_rel"])
        lengths = Counter()
        u16_vals = []
        for r in rs:
            raw = r["hex"]
            try:
                s = raw.strip().replace(" ", "")
                if s.lower().startswith("0x"):
                    s = s[2:]
                b = bytes.fromhex(s)
            except Exception:  # noqa: BLE001
                b = b""
            lengths[len(b)] += 1
            for i in range(0, max(0, len(b) - 1), 2):
                u16_vals.append(int.from_bytes(b[i:i + 2], "little"))
        period_med = median_of(intervals) if intervals else None
        u16_med = median_of(u16_vals) if u16_vals else None
        candidates = []
        if period_med is not None and 0.5 <= period_med <= 2.0:
            candidates.append("通知周期中位数 {:.2f}s ∈ [0.5,2.0]s".format(period_med))
        if u16_med is not None and 300 <= u16_med <= 1500:
            candidates.append("uint16 小端中位数 {:.0f} ∈ [300,1500]".format(u16_med))
        streams.append({
            "service": key[0],
            "char": key[1],
            "count": len(rs),
            "times_verified": verified,
            "period_median_sec": rnd(period_med, 3),
            "period_min_sec": rnd(min(intervals), 3) if intervals else None,
            "period_max_sec": rnd(max(intervals), 3) if intervals else None,
            "length_dist": {str(k): v for k, v in sorted(lengths.items())},
            "u16_median": rnd(u16_med, 1) if u16_med is not None else None,
            "u16_p5": rnd(percentile(u16_vals, 5), 1) if u16_vals else None,
            "u16_p95": rnd(percentile(u16_vals, 95), 1) if u16_vals else None,
            "candidate": bool(candidates),
            "candidate_reasons": candidates,
        })
    return {
        "gatt_nonstandard_notify": gatt_sum.get("nonstandard_notify") or [],
        "streams": streams,
        "candidate_streams": [s for s in streams if s["candidate"]],
    }


# ---------------------------------------------------------------------------
# Gate 判定
# ---------------------------------------------------------------------------

def mk_crit(name, value, value_display, threshold, verdict, note=""):
    return {
        "name": name,
        "value": rnd(value, 4) if isinstance(value, float) else value,
        "value_display": value_display,
        "threshold": threshold,
        "verdict": verdict,
        "note": note,
    }


def combine(criteria):
    if any(c["verdict"] == V_FAIL for c in criteria):
        return V_FAIL
    if any(c["verdict"] == V_UNKNOWN for c in criteria):
        return V_UNKNOWN
    return V_PASS


def evaluate_gates(ctx, opts):
    """严格按计划 §6 表格判定；每条判据都带测量值、阈值与判定。"""
    overall = ctx["overall"]
    flags = ctx["flags"]
    rr = ctx["rr"]
    quality = ctx["quality"]
    gatt_sum = ctx["gatt_sum"]
    private = ctx["private"]
    duration = overall.get("duration_sec")
    n_hrs = overall.get("n", 0)
    time_verified = overall.get("time_verified", False)

    # -- Gate A：能连接并收到 0x2A37 通知（≥10s） --------------------------
    a_c1 = mk_crit(
        "收到 0x2A37 / HRS 通知",
        n_hrs,
        "HRS 通知 {} 条（含解码失败 {} 条）".format(n_hrs, quality["hrs_errors"]),
        "≥1 条",
        V_PASS if n_hrs >= 1 else V_FAIL,
        "记录中 service/char 未标注时，按计划 §5 约定当作 0x2A37",
    )
    if duration is None:
        a_c2 = mk_crit("通知覆盖时长", None, "时长未验证（无可用时间戳）",
                       "≥10.0s", V_UNKNOWN, "notifications.jsonl 缺 t/monoMs")
    else:
        a_c2 = mk_crit("通知覆盖时长", duration,
                       "{}".format(fmt_duration(duration)), "≥10.0s",
                       V_PASS if duration >= 10.0 else V_FAIL, "")
    if gatt_sum.get("present"):
        if gatt_sum.get("has_180d") and gatt_sum.get("has_2a37_notify"):
            a_c3 = mk_crit("GATT 180D/2A37 notify", True,
                           "gatt.json: 180D=有, 2A37=有, notify=有", "存在",
                           V_PASS, "")
        else:
            a_c3 = mk_crit("GATT 180D/2A37 notify", False,
                           "gatt.json: 180D={}, 2A37notify={}".format(
                               "有" if gatt_sum.get("has_180d") else "无",
                               "有" if gatt_sum.get("has_2a37_notify") else "无"),
                           "存在", V_UNKNOWN,
                           "gatt.json 未确认 2A37 notify（可能不完整）；以实际收到通知为准")
    else:
        a_c3 = mk_crit("GATT 180D/2A37 notify", None,
                       "gatt.json 缺失", "存在", V_UNKNOWN,
                       "无 gatt.json，无法核对服务枚举")
    # 连接+通知已由收到的通知直接证明；gatt 缺失不否决 Gate A，只标注
    a_decisive = [a_c1, a_c2]
    a_verdict = combine(a_decisive)
    gates = OrderedDict()
    gates["A"] = {
        "label": GATE_LABELS["A"],
        "verdict": a_verdict,
        "criteria": [a_c1, a_c2, a_c3],
        "note": "Gate A 以“实际收到 0x2A37 通知 ≥10s”为决定性证据；gatt.json 仅作交叉核对。",
    }

    # -- Gate B：静息窗口 RR 可用 ------------------------------------------
    win = ctx["rest_window"]
    b_crits = []
    win_note = win.get("note", "")
    sufficient = win.get("sufficient", False)
    min_window_notifications = 10
    if sufficient and win.get("n_notif", 0) >= min_window_notifications:
        b_crits.append(mk_crit(
            "bit4=1 通知比例", win["bit4_rate"],
            "bit4=1 {} / {} = {}".format(win["bit4_count"], win["n_notif"],
                                         pct(win["bit4_rate"])),
            "≥80%", V_PASS if win["bit4_rate"] is not None
            and win["bit4_rate"] >= 0.80 else V_FAIL))
        b_crits.append(mk_crit(
            "每包 ≥2 个 RR 的比例", win["multi_rr_ratio"],
            "≥2 RR {} / {} = {}".format(win["multi_rr_count"], win["n_notif"],
                                         pct(win["multi_rr_ratio"])),
            "≥80%", V_PASS if win["multi_rr_ratio"] is not None
            and win["multi_rr_ratio"] >= 0.80 else V_FAIL))
        b_crits.append(mk_crit(
            "RR ∈ [400,1500]ms 比例", win["rr_in_range_ratio"],
            "{} / {} = {}".format(win["rr_in_range"], win["rr_count"],
                                  pct(win["rr_in_range_ratio"])),
            "≥95%", V_PASS if win["rr_in_range_ratio"] is not None
            and win["rr_in_range_ratio"] >= 0.95 else
            (V_FAIL if win["rr_count"] else V_UNKNOWN),
            "窗口内无 RR 值" if not win["rr_count"] else ""))
        b_crits.append(mk_crit(
            "粗伪影率（相邻 RR 变化 >20%）", win["artifact_rate"],
            "{} / {} 对 = {}".format(win["artifact_hits"], win["artifact_pairs"],
                                     pct(win["artifact_rate"])),
            "<5%", V_PASS if win["artifact_rate"] is not None
            and win["artifact_rate"] < 0.05 else
            (V_FAIL if win["artifact_pairs"] else V_UNKNOWN),
            "窗口内相邻 RR 对不足" if not win["artifact_pairs"] else ""))
        b_verdict = combine(b_crits)
    elif sufficient:
        b_crits.append(mk_crit(
            "窗口内通知样本", win.get("n_notif", 0),
            "窗口内可读 flags 的 HRS 通知 {} 条".format(win.get("n_notif", 0)),
            "≥{} 条".format(min_window_notifications), V_UNKNOWN,
            "样本不足，4 条判据全部未验证"))
        b_verdict = V_UNKNOWN
    else:
        reason = win.get("reason") or "静息窗口不足"
        b_crits.append(mk_crit(
            "静息 5min 窗口", None,
            "窗口 {}s（需 ≥{}s）：{}".format(
                num(win.get("available_sec"), 1), num(opts["rest_sec"], 0), reason),
            "≥{}s".format(num(opts["rest_sec"], 0)), V_UNKNOWN, reason))
        b_verdict = V_UNKNOWN
    gates["B"] = {
        "label": GATE_LABELS["B"],
        "verdict": b_verdict,
        "criteria": b_crits,
        "window": {
            "rest_start_sec": opts["rest_start"],
            "rest_sec": opts["rest_sec"],
            "available_sec": win.get("available_sec"),
            "sufficient": sufficient,
            "note": win_note,
        },
        "note": "4 条判据都对才 pass；任一 fail 则 fail；无 fail 但有未验证则未验证。",
    }

    # -- Gate B-：仅 bpm 降级 ----------------------------------------------
    if gates["A"]["verdict"] == V_FAIL:
        bm_c1 = mk_crit("Gate A 通过", False, "Gate A fail", "A=pass", V_FAIL)
    elif gates["A"]["verdict"] == V_UNKNOWN:
        bm_c1 = mk_crit("Gate A 通过", None, "Gate A 未验证", "A=pass", V_UNKNOWN)
    else:
        bm_c1 = mk_crit("Gate A 通过", True, "Gate A pass", "A=pass", V_PASS)
    if gates["B"]["verdict"] == V_FAIL:
        bm_c2 = mk_crit("Gate B 不通过（RR 不可用）", True,
                        "Gate B fail：bit4/多 RR/范围/伪影判据未全部满足",
                        "B=fail", V_PASS)
    elif gates["B"]["verdict"] == V_UNKNOWN:
        bm_c2 = mk_crit("Gate B 不通过（RR 不可用）", None,
                        "Gate B 未验证，无法判断是否应降级", "B=fail", V_UNKNOWN)
    else:
        bm_c2 = mk_crit("Gate B 不通过（RR 不可用）", False,
                        "Gate B pass，RR 可用，无需降级", "B=fail", V_FAIL)
    gates["B_minus"] = {
        "label": GATE_LABELS["B_minus"],
        "verdict": combine([bm_c1, bm_c2]),
        "criteria": [bm_c1, bm_c2],
        "note": "pass = 降级为“仅 bpm 趋势（quality=no-rr）”成立。",
    }

    # -- Gate C：私有通道候选 ----------------------------------------------
    # 计划 §6 的前提是「标准 HRS 无 RR」；RR 可用时 Gate C 条件不成立，
    # 但候选信息仍会列在 §8/Q5 供参考。
    gatt_ok = gatt_sum.get("present")
    n_gatt_cand = len(gatt_sum.get("nonstandard_notify") or [])
    n_streams = len(private.get("streams") or [])
    n_stream_cand = len(private.get("candidate_streams") or [])
    if gates["B"]["verdict"] == V_FAIL:
        c_c0 = mk_crit("前提：标准 HRS 无可用 RR（Gate B 不通过）", True,
                       "Gate B fail", "B=fail", V_PASS)
    elif gates["B"]["verdict"] == V_UNKNOWN:
        c_c0 = mk_crit("前提：标准 HRS 无可用 RR（Gate B 不通过）", None,
                       "Gate B 未验证", "B=fail", V_UNKNOWN)
    else:
        c_c0 = mk_crit("前提：标准 HRS 无可用 RR（Gate B 不通过）", False,
                       "Gate B pass（RR 可用，不需要私有通道）", "B=fail", V_FAIL)
    if not gatt_ok:
        c_c1 = mk_crit("非标准 notify 特征（gatt.json）", None,
                       "gatt.json 缺失", "≥1 个", V_UNKNOWN)
    else:
        c_c1 = mk_crit("非标准 notify 特征（gatt.json）", n_gatt_cand,
                       "非标准 notify 特征 {} 个".format(n_gatt_cand), "≥1 个",
                       V_PASS if n_gatt_cand >= 1 else V_FAIL)
    c_c2 = mk_crit("非 HRS 通知流（notifications.jsonl）", n_streams,
                   "非 HRS 通知流 {} 组，其中周期/数值可疑候选 {} 组".format(
                       n_streams, n_stream_cand), "≥1 组",
                   V_PASS if n_streams >= 1 else V_FAIL)
    has_cand = n_gatt_cand >= 1 or n_streams >= 1
    if has_cand:
        if c_c0["verdict"] == V_PASS:
            c_verdict = V_PASS
        elif c_c0["verdict"] == V_UNKNOWN:
            c_verdict = V_UNKNOWN
        else:
            c_verdict = V_FAIL
    elif not gatt_ok:
        c_verdict = V_UNKNOWN
    else:
        c_verdict = V_FAIL
    gates["C"] = {
        "label": GATE_LABELS["C"],
        "verdict": c_verdict,
        "criteria": [c_c0, c_c1, c_c2],
        "note": "pass = 满足「标准 HRS 无可用 RR」且有私有通道候选；"
                "仅进入 T4 逆向评估，不承诺可用。",
    }

    # -- Gate D：不可用 ----------------------------------------------------
    total_notif = n_hrs + quality.get("other_stream_rows", 0)
    d_c1 = mk_crit("无任何通知", total_notif == 0,
                   "通知总数 {}".format(total_notif), "=0",
                   V_PASS if total_notif == 0 else V_FAIL)
    d_c2 = mk_crit("连接失败", None, "无连接事件日志，未验证", "—", V_UNKNOWN)
    d_c3 = mk_crit("Windows 方案不稳定", None,
                   "需 T8/人工观察，未验证", "—", V_UNKNOWN)
    if total_notif == 0:
        d_verdict = V_PASS
        d_note = "无任何通知 → 不可用成立（连接失败/不稳定子项未单独验证）"
    else:
        d_verdict = V_FAIL
        d_note = "有通知 → Gate D 不成立；Windows 稳定性子项仍为未验证"
    gates["D"] = {
        "label": GATE_LABELS["D"],
        "verdict": d_verdict,
        "criteria": [d_c1, d_c2, d_c3],
        "note": d_note,
    }

    # -- 决策树（计划 §6） --------------------------------------------------
    A, B, C = gates["A"]["verdict"], gates["B"]["verdict"], gates["C"]["verdict"]
    if A == V_FAIL:
        decision = "Gate A 未过 → Gate D：放弃该型号（换 Polar H10 验证）"
    elif A == V_UNKNOWN:
        decision = "未验证：Gate A 证据不足，无法进入决策树"
    elif B == V_PASS:
        decision = "首选（RR 源）：支持动作后 Δbpm + 离线 60s RMSSD"
    elif B == V_FAIL:
        if C == V_PASS:
            decision = ("降级：仅 bpm 趋势（quality=no-rr）；"
                        "私有通道有候选，评估逆向成本（默认不投入）")
        else:
            decision = "降级：仅 bpm 趋势（quality=no-rr）"
    else:
        decision = "未验证：Gate B 数据不足（静息窗口/样本不足），不能判定 RR 可用性"
    gates["decision"] = decision
    gates["note"] = "pass=该 Gate 条件成立；fail=条件不成立；未验证=证据/数据不足（不猜测）。"
    return gates


# ---------------------------------------------------------------------------
# 静息窗口统计（Gate B 用）
# ---------------------------------------------------------------------------

def build_rest_window(attempts, entries, duration, time_verified, opts):
    rest_start = float(opts["rest_start"])
    rest_sec = float(opts["rest_sec"])
    result = {
        "available_sec": None,
        "sufficient": False,
        "reason": "",
        "n_notif": 0,
        "bit4_count": 0,
        "bit4_rate": None,
        "multi_rr_count": 0,
        "multi_rr_ratio": None,
        "rr_count": 0,
        "rr_in_range": 0,
        "rr_in_range_ratio": None,
        "artifact_pairs": 0,
        "artifact_hits": 0,
        "artifact_rate": None,
        "note": "",
    }
    if not time_verified or duration is None:
        result["reason"] = "无可用时间戳，无法切分静息窗口"
        return result
    available = min(rest_sec, max(0.0, duration - rest_start))
    result["available_sec"] = rnd(available, 3)
    if duration - rest_start < rest_sec:
        result["sufficient"] = False
        result["reason"] = "捕获时长不足（{} < {}s）".format(
            num(available, 1), num(rest_sec, 0))
    else:
        result["sufficient"] = True
    t0, t1 = rest_start, rest_start + rest_sec
    win_recs = [r for r in attempts if r["t_rel"] is not None
                and t0 <= r["t_rel"] < t1]
    win_entries = [e for e in entries if e["t_rel"] is not None
                   and t0 <= e["t_rel"] < t1]
    n = 0
    bit4 = 0
    multi = 0
    for r in win_recs:
        dec = r["dec"]
        if dec is None or dec.get("flags") is None:
            continue
        n += 1
        if dec["flags"] & 0x10:
            bit4 += 1
        if dec.get("rr_ms") and len(dec["rr_ms"]) >= 2:
            multi += 1
    vals = [e["rr"] for e in win_entries]
    in_range = sum(1 for v in vals if opts["rr_min"] <= v <= opts["rr_max"])
    art = artifact_metrics(win_entries, opts["artifact_threshold"])
    result.update({
        "n_notif": n,
        "bit4_count": bit4,
        "bit4_rate": rnd(bit4 / float(n)) if n else None,
        "multi_rr_count": multi,
        "multi_rr_ratio": rnd(multi / float(n)) if n else None,
        "rr_count": len(vals),
        "rr_in_range": in_range,
        "rr_in_range_ratio": rnd(in_range / float(len(vals))) if vals else None,
        "artifact_pairs": art["pairs"],
        "artifact_hits": art["hits"],
        "artifact_rate": art["rate"],
        "note": "窗口 [{:.1f}s, {:.1f}s)（从首条通知起算）".format(t0, t1),
    })
    if not result["sufficient"]:
        result["reason"] = (result["reason"] +
                            "；不足 5min 时 Gate B 按计划要求判为未验证，"
                            "窗口内数值仅供参考")
    return result


# ---------------------------------------------------------------------------
# Q1–Q10
# ---------------------------------------------------------------------------

def build_qa(ctx, gates):
    flags = ctx["flags"]
    rr = ctx["rr"]
    overall = ctx["overall"]
    quality = ctx["quality"]
    gatt_sum = ctx["gatt_sum"]
    meta = ctx["meta"]
    private = ctx["private"]
    contact = ctx["contact"]
    hr = ctx["hr"]
    bit4_ratio = flags["bit_rates"]["bit4"]["ratio"]
    bit2_ratio = flags["bit_rates"]["bit2"]["ratio"]
    bit1_ratio = flags["bit_rates"]["bit1"]["ratio"]
    qa = []

    q1_part = []
    if gatt_sum.get("present"):
        q1_part.append("gatt.json: 180D={}, 2A37={}, 2A37notify={}".format(
            "有" if gatt_sum.get("has_180d") else "无",
            "有" if gatt_sum.get("has_2a37") else "无",
            "有" if gatt_sum.get("has_2a37_notify") else "无"))
    else:
        q1_part.append("gatt.json 缺失，服务枚举未验证")
    q1_part.append("实收 HRS 通知 {} 条".format(overall.get("n", 0)))
    qa.append({
        "q": "Q1",
        "question": "是否提供标准 HRS 0x180D/0x2A37，能否不配对直连？",
        "answer": "；".join(q1_part) + "。“不配对直连”=未验证（离线分析器无法判断连接/配对流程，需连接日志或 meta 记录）。",
        "evidence": "§1/§2；inputs.gatt；notifications.jsonl",
    })
    qa.append({
        "q": "Q2",
        "question": "0x2A37 flags bit4（RR-Interval）是否为 1？多久出现一次？",
        "answer": "bit4=1 比例 {}（n={}）。".format(
            pct(bit4_ratio), flags["n_packets_with_flags"]),
        "evidence": "§3 flags.bit_rates.bit4；analysis.json#/flags/bit_rates",
    })
    pc = rr["per_packet"]
    dist_str = "，".join("{}个RR×{}包".format(k, v)
                         for k, v in pc["length_dist"].items())
    qa.append({
        "q": "Q3",
        "question": "每包几个 RR？RR 是否合理（400–1500ms）？伪影比例？",
        "answer": ("每包 RR 数分布：{}；≥2 RR 比例 {}；RR 中位 {} ms，P5/P95={}/{} ms，"
                   "∈[400,1500] 比例 {}；粗伪影率 {}（{} 对）。").format(
            dist_str, pct(pc["multi_rr_ratio"]),
            num(rr["pool"]["median"], 1), num(rr["pool"]["p5"], 1),
            num(rr["pool"]["p95"], 1), pct(rr["pool"]["in_range_ratio"]),
            pct(rr["artifact"]["rate"]), rr["artifact"]["pairs"]),
        "evidence": "§5；analysis.json#/rr",
    })
    qa.append({
        "q": "Q4",
        "question": "通知频率、接触状态 bit1/bit2 是否可用？摘下/戴上会不会变？",
        "answer": ("通知 {} 条/分钟；bit2（接触能力）=1 比例 {}；bit1（接触状态）=1 比例 {}；"
                   "接触状态切换 {} 次。").format(
            num(overall.get("rate_per_min"), 1), pct(bit2_ratio), pct(bit1_ratio),
            len(contact.get("transitions") or [])),
        "evidence": "§2/§3/§6；analysis.json#/contact",
    })
    if gatt_sum.get("present"):
        q5_answer = "gatt.json 中非标准 notify 特征 {} 个；非 HRS 通知流 {} 组（可疑候选 {} 组）。".format(
            len(gatt_sum["nonstandard_notify"]),
            len(private.get("streams") or []),
            len(private.get("candidate_streams") or []))
        q5_ev = "§8；analysis.json#/private_channels；gatt.json"
    else:
        q5_answer = "未验证（缺 gatt.json，无法枚举非标准服务/特征）。"
        q5_ev = "gatt.json（缺失）"
    qa.append({
        "q": "Q5",
        "question": "若标准 HRS 不带 RR：有无厂商私有服务/特征在发通知？",
        "answer": q5_answer,
        "evidence": q5_ev,
    })
    qa.append({
        "q": "Q6",
        "question": "官方 App 说的 HRV 是设备端算的还是 App 端算的？",
        "answer": "未验证（需要观察官方 App 行为；离线通知流分析无法回答）。",
        "evidence": "—",
    })
    if meta.get("present"):
        dev = meta.get("device") or {}
        parts = []
        for k, label in (("name", "名称"), ("model", "型号"),
                         ("firmware", "固件"), ("hardware", "硬件")):
            if dev.get(k):
                parts.append("{}={}".format(label, dev[k]))
        if dev.get("serial") is not None or dev.get("mac") is not None:
            parts.append("序列号/MAC 已脱敏不输出")
        adv = gatt_sum.get("advertisement") or {}
        if adv.get("services") is not None:
            svcs = adv.get("services") or []
            parts.append("广播服务={}".format(
                ", ".join(str(s) for s in svcs) if svcs else "（空）"))
        elif gatt_sum.get("present"):
            parts.append("广播信息未记录")
        q7_answer = "；".join(parts) if parts else "未验证（meta.json 无设备信息字段）"
        q7_ev = "§1；inputs.meta；gatt.json#advertisement"
    else:
        q7_answer = "未验证（缺 meta.json，无设备/环境信息）。"
        q7_ev = "meta.json（缺失）"
    qa.append({
        "q": "Q7",
        "question": "固件/型号/硬件版本、电量、广播名与广播里是否带 0x180D？",
        "answer": q7_answer,
        "evidence": q7_ev,
    })
    qa.append({
        "q": "Q8",
        "question": "与郊狼 B0 流并发时 BLE 是否会被卡？",
        "answer": "未验证（需要同时抓 B0 + HW9 的日志或人工观察；本分析只含单设备通知流）。",
        "evidence": "—",
    })
    qa.append({
        "q": "Q9",
        "question": "断线重连行为（3 次退避、是否清缓冲、是否需重新选设备）？",
        "answer": "未验证（需要连接/断开事件日志；本文件无连接事件记录）。",
        "evidence": "—",
    })
    qa.append({
        "q": "Q10",
        "question": "Windows 配对/缓存是否导致第二次连接看不到设备？",
        "answer": "未验证（需要 Windows 配对/缓存的人工观察；分析器只解析通知流）。",
        "evidence": "—",
    })
    return qa


# ---------------------------------------------------------------------------
# 主分析
# ---------------------------------------------------------------------------

def analyze_capture(capture_dir, opts):
    warnings = []
    notif_path = os.path.join(capture_dir, "notifications.jsonl")
    if not os.path.isfile(notif_path):
        raise FileNotFoundError("找不到 {}".format(notif_path))
    rows, bad_lines = load_jsonl(notif_path)
    meta, meta_err = load_json_file(os.path.join(capture_dir, "meta.json"))
    gatt, gatt_err = load_json_file(os.path.join(capture_dir, "gatt.json"))
    if bad_lines:
        warnings.append("notifications.jsonl 有 {} 行 JSON 解析失败（已跳过）".format(
            len(bad_lines)))

    recs, non_notif = build_records(rows, warnings)
    hrs_all = [r for r in recs if r["kind"] == "hrs"]
    other = [r for r in recs if r["kind"] == "other"]

    # 时间轴：总体用 HRS 通道
    time_source, time_verified = assign_times(hrs_all)
    if not time_verified and hrs_all:
        warnings.append("notifications.jsonl 缺可用时间戳（t/monoMs），"
                        "时长/间隔/窗口类指标按未验证处理")
    if time_verified and any(r["t_rel"] is None for r in hrs_all):
        warnings.append("部分记录缺时间戳（未参与窗口统计）")

    # 基本计数
    hrs_valid = [r for r in hrs_all if r["err"] is None]
    hrs_bad = [r for r in hrs_all if r["err"] is not None]
    decoded_mismatch = {"compared_rows": 0, "mismatch_rows": 0, "mismatches": []}
    for rec in hrs_valid:
        mm = check_decoded_mismatch(rec["row"], rec["dec"])
        if mm is None:
            continue
        decoded_mismatch["compared_rows"] += 1
        if mm["mismatch_fields"] > 0:
            decoded_mismatch["mismatch_rows"] += 1
            if len(decoded_mismatch["mismatches"]) < 10:
                decoded_mismatch["mismatches"].append({
                    "seq": rec["seq"], "fields": mm["mismatches"],
                })
    if decoded_mismatch["mismatch_rows"]:
        warnings.append("decoded 与 hex 重解不一致 {} 行（以 hex 为准）".format(
            decoded_mismatch["mismatch_rows"]))

    # 总体
    interval = interval_metrics(hrs_all, time_verified, opts["gap_sec"])
    duration = None
    if time_verified and len(hrs_all) >= 2:
        duration = rnd(hrs_all[-1]["t"] - hrs_all[0]["t"], 3)
    elif time_verified and len(hrs_all) == 1:
        duration = 0.0
    overall = {
        "n": len(hrs_all),
        "n_valid": len(hrs_valid),
        "n_decode_errors": len(hrs_bad),
        "duration_sec": duration,
        "time_source": time_source,
        "time_verified": bool(time_verified),
        "first_t": fmt_epoch(hrs_all[0]["t_abs"]) if hrs_all else None,
        "last_t": fmt_epoch(hrs_all[-1]["t_abs"]) if hrs_all else None,
        "rate_per_min": rnd(len(hrs_all) * 60.0 / duration, 2) if duration else None,
        "intervals": interval,
        "other_stream_rows": len(other),
        "non_notification_rows": non_notif,
        "malformed_lines": len(bad_lines),
    }
    if bad_lines:
        overall["malformed_line_detail"] = bad_lines[:10]

    flags = flags_metrics(hrs_all)
    hr = hr_metrics(hrs_valid, hrs_all)

    entries = []
    for rec in hrs_valid:
        rr_ms = rec["dec"].get("rr_ms") or []
        for pos, v in enumerate(rr_ms):
            entries.append({
                "rr": v,
                "t_rel": rec["t_rel"],
                "pkt": rec["seq"],
                "pos": pos,
            })
    rr_vals = [e["rr"] for e in entries]
    per_packet = per_packet_rr_metrics(hrs_all)
    pool = rr_stats(rr_vals)
    artifact = artifact_metrics(entries, opts["artifact_threshold"])
    windows = window_metrics(entries, duration, opts["window_sec"])
    dropout = dropout_metrics(hrs_all, interval, duration, pool["median"],
                              time_verified)
    # RR 与 bpm 的一致性 sanity：RR 中位数 vs 60000/HR 中位数
    expected_rr = safe_div(60000.0, hr["median"]) if hr["median"] else None
    rr_consistency = {
        "hr_median": hr["median"],
        "rr_median": pool["median"],
        "expected_rr_ms_from_hr": rnd(expected_rr, 1) if expected_rr else None,
        "ratio": rnd(safe_div(pool["median"], expected_rr), 4)
        if (expected_rr and pool["median"]) else None,
        "note": "仅作 sanity：若 RR 中位数与 60000/HR 中位数偏差大（如 >±20%），"
                "提示 RR 可能是缓冲/重复/单位问题，或 bpm 与 RR 不同源",
    }
    rr = {
        "per_packet": per_packet,
        "pool": pool,
        "artifact": artifact,
        "windows": windows,
        "dropout": dropout,
        "consistency": rr_consistency,
    }

    contact = contact_metrics(hrs_all, time_verified)
    motion = motion_metrics(entries, hrs_all, time_verified, opts["bin_sec"],
                            opts["artifact_threshold"],
                            opts["motion_artifact_ratio"],
                            opts["min_pairs_per_bin"])
    gatt_sum = gatt_summary(gatt, gatt_err)
    private = private_channel_metrics(other, gatt_sum)
    rest_window = build_rest_window(hrs_all, entries, duration, time_verified, opts)

    # meta 摘要（脱敏）
    meta_summary = {"present": meta is not None, "error": meta_err}
    if isinstance(meta, dict):
        dev = meta.get("device") or {}
        env = meta.get("env") or {}
        meta_summary["device"] = {
            "name": dev.get("name"),
            "model": dev.get("model"),
            "firmware": dev.get("firmware"),
            "hardware": dev.get("hardware"),
            "mac": "（脱敏，不输出）" if dev.get("mac") else None,
            "serial": "（脱敏，不输出）" if dev.get("serial") else None,
        }
        meta_summary["env"] = {
            "os": env.get("os"),
            "chrome": env.get("chrome"),
            "adapter": env.get("adapter"),
            "tools": env.get("tools"),
        }
        meta_summary["startedAt"] = meta.get("startedAt")
        notes = meta.get("notes")
        meta_summary["notes_present"] = bool(notes)
        meta_summary["notes_len"] = len(notes) if isinstance(notes, str) else None
        meta_summary["notes_note"] = "notes 内容不写入报告（避免泄露敏感信息）"

    quality = {
        "rows_total": len(rows),
        "hrs_attempts": len(hrs_all),
        "hrs_valid": len(hrs_valid),
        "hrs_errors": len(hrs_bad),
        "hrs_error_detail": [
            {"seq": r["seq"], "hex": r["hex"], "error": r["err"]}
            for r in hrs_bad[:20]
        ],
        "non_notification_rows": non_notif,
        "other_stream_rows": len(other),
        "malformed_lines": len(bad_lines),
        "decoded_mismatch": decoded_mismatch,
        "timestamp_warnings": [],
    }
    if interval.get("negative_count"):
        quality["timestamp_warnings"].append(
            "{} 个到达间隔为负（时间戳非单调，已从统计中剔除）".format(
                interval["negative_count"]))
        warnings.append("时间戳非单调：{} 个负间隔".format(
            interval["negative_count"]))
    if interval.get("zero_count"):
        quality["timestamp_warnings"].append(
            "{} 个重复时间戳（间隔=0）".format(interval["zero_count"]))
    if flags["rfu"]["warning"]:
        warnings.append("flags bit5-7 有置位：{}".format(flags["rfu"]["bits_set"]))
    if hr["zero_count"]:
        warnings.append("HR=0 的包 {} 条".format(hr["zero_count"]))
    if hr["gt250_count"]:
        warnings.append("HR>250 的包 {} 条".format(hr["gt250_count"]))
    if contact.get("inconsistent_count"):
        warnings.append("bit2=0 但 bit1=1 的矛盾接触包 {} 条"
                        "（未进入接触状态时间轴）".format(
                            contact["inconsistent_count"]))
    if hr.get("valid_count") == 0 and overall["n"]:
        warnings.append("没有任何有效 HR 值（全部为 0/超范围/解码失败）")
    if not gatt_sum["present"]:
        warnings.append("gatt.json 缺失：Gate A 交叉核对 / Gate C / Q1/Q5/Q7 部分指标未验证")
    if not meta_summary["present"]:
        warnings.append("meta.json 缺失：Q7 设备/环境信息未验证")

    ctx = {
        "overall": overall,
        "flags": flags,
        "hr": hr,
        "rr": rr,
        "contact": contact,
        "motion": motion,
        "quality": quality,
        "gatt_sum": gatt_sum,
        "private": private,
        "meta": meta_summary,
        "rest_window": rest_window,
        "opts": opts,
    }
    gates = evaluate_gates(ctx, opts)
    qa = build_qa(ctx, gates)

    assumptions = build_assumptions(opts, overall, rest_window)
    evidence = {
        "overall": "analysis.json#/overall；报告 §2",
        "flags": "analysis.json#/flags；报告 §3",
        "hr": "analysis.json#/hr；报告 §4",
        "rr": "analysis.json#/rr；报告 §5",
        "contact": "analysis.json#/contact；报告 §6",
        "motion": "analysis.json#/motion；报告 §7",
        "private": "analysis.json#/private_channels；报告 §8",
        "gates": "analysis.json#/gates；报告 §9",
        "qa": "analysis.json#/qa；报告 §10",
        "raw": "notifications.jsonl（原始 hex，唯一真值来源）",
    }
    doc = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "capture_dir": os.path.abspath(capture_dir),
        "options": {
            "rest_start_sec": opts["rest_start"],
            "rest_sec": opts["rest_sec"],
            "gap_sec": opts["gap_sec"],
            "window_sec": opts["window_sec"],
            "bin_sec": opts["bin_sec"],
            "rr_range_ms": [opts["rr_min"], opts["rr_max"]],
            "artifact_threshold": opts["artifact_threshold"],
            "motion_artifact_ratio": opts["motion_artifact_ratio"],
            "min_pairs_per_bin": opts["min_pairs_per_bin"],
        },
        "inputs": {
            "files": {
                "notifications.jsonl": os.path.isfile(notif_path),
                "meta.json": os.path.isfile(os.path.join(capture_dir, "meta.json")),
                "gatt.json": os.path.isfile(os.path.join(capture_dir, "gatt.json")),
            },
            "meta": meta_summary,
            "gatt": gatt_sum,
        },
        "quality": quality,
        "overall": overall,
        "flags": flags,
        "hr": hr,
        "rr": rr,
        "contact": contact,
        "motion": motion,
        "private_channels": private,
        "rest_window": rest_window,
        "gates": gates,
        "qa": qa,
        "assumptions": assumptions,
        "warnings": warnings,
        "evidence": evidence,
    }
    return doc


def build_assumptions(opts, overall, rest_window):
    return [
        {"id": "A1", "text": "时间轴以文件到达顺序为准；优先用 `t`（绝对时间），"
                             "其次 `monoMs`（相对时间），都没有时按行序（时长/间隔类指标记为未验证）。"},
        {"id": "A2", "text": "通知总体只统计 HRS 通道（service 180D/char 2A37 或未标注）；"
                             "非 HRS 通知流单列到私有通道分析。"},
        {"id": "A3", "text": "条/分钟 = HRS 通知条数 / 捕获时长(分钟)；到达间隔统计使用相邻"
                             "有效时间戳差，负间隔单独计数并剔除。"},
        {"id": "A4", "text": "Gate B 的“静息 5min”默认取首条通知起 {}s 窗口"
                             "（--rest-start/--rest-sec 可改）；捕获不足 {}s 时 Gate B 判未验证，"
                             "窗口内数值仅参考。".format(
                                 num(opts["rest_sec"], 0), num(opts["rest_sec"], 0))},
        {"id": "A5", "text": "Gate B 判据 1/2 的分母 = 窗口内能读出 flags 的 HRS 通知条数"
                             "（含 HR/RR 被截断的包；hex 为空/非法、读不出 flags 的包不计入）；"
                             "判据 3 分母 = 窗口内全部 RR 值；判据 4 分母 = 窗口内全部相邻 RR 对。"},
        {"id": "A6", "text": "每包 RR 数量分布的分母同上（窗口外则用全捕获的 HRS 通知条数）。"},
        {"id": "A7", "text": "HR 统计有效范围取 1–250：0 单列（HR zero），>250 单列，"
                             "解码失败单列。ΔHR 只在相邻两个有效 HR 包之间计算。"},
        {"id": "A8", "text": "粗伪影定义：|rr[i+1]-rr[i]|/rr[i] > {}（--artifact-threshold）；"
                             "主伪影率用全部相邻 RR 对，另报包内/跨包拆分。".format(
                                 pct(opts["artifact_threshold"], 0))},
        {"id": "A9", "text": "RR 的时间归属：一包内多个 RR 都归到该包到达时刻（窗口/分箱统计用），"
                             "因此窗口边界处的 RR 归属有 ±1 包误差。"},
        {"id": "A10", "text": "60s 窗口 RMSSD 只作 sanity check（窗口内 ≥3 个 RR 才计算），"
                              "不宣称临床值；窗口从首条通知对齐、固定宽度不重叠。"},
        {"id": "A11", "text": "丢拍估计两种（均为估计）：①到达间隔法：gap>1.5×中位间隔时"
                              "估丢 round(gap/中位间隔)-1；②RR 累计法：仅统计“相邻两条都带 RR 的通知包”"
                              "之间的空档，expected=Δt/中位RR、delivered=后一包实际 RR 数，"
                              "缺口=max(0, round(expected-delivered))；不把“设备本来不发 RR 的包”算成丢拍。"},
        {"id": "A12", "text": "接触状态：只有 bit2=1（设备声明支持接触检测）的包进入状态时间轴"
                              "（bit2=1&bit1=1→contact，bit2=1&bit1=0→no-contact）；"
                              "bit2=0 的包跳过并单列（bit1=1 记 inconsistent 矛盾包，bit1=0 记 unsupported）。"},
        {"id": "A13", "text": "T5 恢复时间启发式：以摘下前 30s HR 中位数为基线，"
                              "取重新接触后首个落入基线 ±20% 的 HR 的时间差；找不到记 null（未验证）。"},
        {"id": "A14", "text": "运动段：{}s 分箱，箱内相邻 RR 对 ≥{} 且伪影率 ≥{} 判为运动 bin，"
                              "相邻 bin 合并成段（--bin-sec/--min-pairs-per-bin/--motion-artifact-ratio）。".format(
                                  num(opts["bin_sec"], 0), opts["min_pairs_per_bin"],
                                  pct(opts["motion_artifact_ratio"], 0))},
        {"id": "A15", "text": "丢拍集中时间段直接取 >{}s 的到达空档（含估丢条数），"
                              "不做“按 RR 数量分箱”的二次推断。".format(
                                  num(opts["gap_sec"], 0))},
        {"id": "A16", "text": "gatt.json / meta.json 缺失时相关项标未验证，不用通知流反推服务枚举。"},
        {"id": "A17", "text": "私有通道候选判定（仅列候选，不猜协议）：非 HRS 流的中位周期 ∈[0.5,2.0]s "
                              "或 uint16 小端中位数 ∈[300,1500] 之一满足即列为候选。"},
        {"id": "A18", "text": "隐私：不输出逐拍 RR 序列、MAC、序列号；meta.notes 内容不写入报告。"},
        {"id": "A19", "text": "所有解析从原始 hex 重新解码（附录 A）；`decoded` 仅用于不一致统计。"},
        {"id": "A20", "text": "本次分析不判断“真实健康值/临床精度”；只能回答协议与数据质量。"},
        {"id": "A21", "text": "Gate C 以「标准 HRS 无可用 RR（Gate B 不通过）」为前提；"
                              "RR 可用时即使发现私有通道，Gate C 条件也不成立"
                              "（候选信息仍列在 §8/Q5）。"},
    ]


# ---------------------------------------------------------------------------
# 渲染：Markdown / 控制台
# ---------------------------------------------------------------------------

def _gate_verdict_text(v):
    return {"pass": "pass（条件成立）", "fail": "fail（条件不成立）",
            "未验证": "未验证（数据不足）"}.get(v, str(v))


def render_markdown(doc, opts):
    o = doc["overall"]
    q = doc["quality"]
    fl = doc["flags"]
    hr = doc["hr"]
    rr = doc["rr"]
    ct = doc["contact"]
    mo = doc["motion"]
    pv = doc["private_channels"]
    gs = doc["inputs"]["gatt"]
    gates = doc["gates"]
    meta = doc["inputs"]["meta"]
    L = []
    add = L.append

    add("# CooSpo HW9 通知流离线分析报告")
    add("")
    add("> 生成时间：{}　|　输入目录：`{}`".format(
        doc["generated_at"], doc["capture_dir"]))
    add("> 生成工具：`analysis/hw9-capture/_tools/analysis/analyze.py`（纯标准库）")
    add("> 口径：所有数值从 `notifications.jsonl` 的原始 `hex` 按计划附录 A 重新解码，"
        "`decoded` 只用于不一致统计。")
    add("> 隐私：本报告只含聚合统计，不含逐拍 RR 原始序列、MAC、序列号。")
    add("")

    # 0 结论摘要
    add("## 0. 结论摘要")
    add("")
    rows = []
    for key in ("A", "B", "B_minus", "C", "D"):
        g = gates[key]
        rows.append([g["label"], _gate_verdict_text(g["verdict"]), g["note"]])
    add(md_table(["Gate", "结论", "说明"], rows))
    add("")
    add("**决策树结论**：{}".format(gates["decision"]))
    add("")
    add("> 判定词说明：`pass`=该 Gate 条件成立；`fail`=条件不成立；"
        "`未验证`=证据或数据不足，不做猜测。")
    add("")

    # 1 数据与解析质量
    add("## 1. 数据与解析质量")
    add("")
    files = doc["inputs"]["files"]
    add(md_table(["输入文件", "存在", "说明"], [
        ["notifications.jsonl", "是" if files["notifications.jsonl"] else "否",
         "{} 行 JSONL，{} 行解析失败".format(q["rows_total"], q["malformed_lines"])],
        ["meta.json", "是" if files["meta.json"] else "否",
         "notes 内容不输出" if files["meta.json"] else "缺失"],
        ["gatt.json", "是" if files["gatt.json"] else "否",
         "服务/特征枚举" if files["gatt.json"] else "缺失"],
    ]))
    add("")
    add(md_table(["统计项", "数值"], [
        ["HRS 通知（尝试）", q["hrs_attempts"]],
        ["HRS 解码成功", q["hrs_valid"]],
        ["HRS 解码失败", q["hrs_errors"]],
        ["非 HRS 通知流（条）", q["other_stream_rows"]],
        ["非通知行（如 device info）", q["non_notification_rows"]],
        ["decoded 对照行数 / 不一致行数",
         "{} / {}".format(q["decoded_mismatch"]["compared_rows"],
                          q["decoded_mismatch"]["mismatch_rows"])],
        ["时间戳来源", "{}（{}）".format(
            o["time_source"],
            "已验证" if o["time_verified"] else "未验证")],
    ]))
    add("")
    if q["hrs_error_detail"]:
        add("解码失败样例：")
        add("")
        add(md_table(["seq", "hex", "错误"],
                      [[d["seq"], "`{}`".format(d["hex"]), d["error"]]
                       for d in q["hrs_error_detail"]]))
        add("")
    if q["timestamp_warnings"]:
        add("时间戳告警：")
        add("")
        for w in q["timestamp_warnings"]:
            add("- {}".format(w))
        add("")
    if meta.get("present"):
        dev = meta.get("device") or {}
        add("设备/环境（脱敏）：")
        add("")
        add(md_table(["字段", "值"], [
            ["device.name", dev.get("name") or "—"],
            ["device.model", dev.get("model") or "—"],
            ["device.firmware", dev.get("firmware") or "—"],
            ["device.hardware", dev.get("hardware") or "—"],
            ["device.mac", dev.get("mac") or "—"],
            ["device.serial", dev.get("serial") or "—"],
            ["env.os", (meta.get("env") or {}).get("os") or "—"],
            ["env.chrome", (meta.get("env") or {}).get("chrome") or "—"],
            ["env.adapter", (meta.get("env") or {}).get("adapter") or "—"],
            ["startedAt", meta.get("startedAt") or "—"],
        ]))
        add("")
    if doc["warnings"]:
        add("**告警/未验证提示：**")
        add("")
        for w in doc["warnings"]:
            add("- {}".format(w))
        add("")

    # 2 通知总体
    add("## 2. 通知总体")
    add("")
    iv = o["intervals"]
    add(md_table(["指标", "数值"], [
        ["通知条数", o["n"]],
        ["捕获时长", "{}（{}）".format(
            fmt_duration(o["duration_sec"]),
            "已验证" if o["time_verified"] else "未验证")],
        ["条/分钟", num(o["rate_per_min"], 1)],
        ["到达间隔中位数", "{} s".format(num(iv["median"], 3))],
        ["到达间隔最小值", "{} s".format(num(iv["min"], 3))],
        ["到达间隔最大值", "{} s".format(num(iv["max"], 3))],
        ["到达间隔均值", "{} s".format(num(iv["mean"], 3))],
        [">{:.0f}s 空档数".format(opts["gap_sec"]), iv["gaps_count"]],
        ["时间戳非单调（负间隔）", iv["negative_count"]],
        ["首条时间", o["first_t"] or "—"],
        ["末条时间", o["last_t"] or "—"],
    ]))
    add("")
    if iv["gaps"]:
        add(">{:.0f}s 空档列表（T2/T6 的“断流”证据）：".format(opts["gap_sec"]))
        add("")
        add(md_table(["#", "起（相对）", "止（相对）", "空档长度"],
                      [[i + 1, fmt_rel(g["from_rel"]), fmt_rel(g["to_rel"]),
                        "{} s".format(num(g["gap_sec"], 2))]
                       for i, g in enumerate(iv["gaps"])]))
        add("")

    # 3 flags
    add("## 3. flags 分布与包长")
    add("")
    add(md_table(["bit", "含义", "命中率", "命中数 / 总数"],
                  [["bit{}".format(i), h["name"], pct(h["ratio"]),
                    "{}/{}".format(h["set_count"], fl["n_packets_with_flags"])]
                   for i, h in enumerate(fl["bit_rates"].values())]))
    add("")
    add("flags 取值直方图：")
    add("")
    add(md_table(["flags", "二进制", "置位 bit", "包数", "占比"],
                  [["`{}`".format(h["flags_hex"]),
                    "0b{:08b}".format(h["flags"]),
                    ",".join("bit{}".format(b) for b in h["bits_set"]) or "—",
                    h["count"], pct(h["ratio"])] for h in fl["histogram"]]))
    add("")
    add("不同 flags 值的包长分布：")
    add("")
    lrows = []
    for fhex, item in fl["length_by_flags"].items():
        lrows.append([fhex, item["count"],
                      ", ".join("{}B×{}".format(k, v)
                                for k, v in item["length_dist"].items()),
                      ", ".join("{}RR×{}".format(k, v)
                                for k, v in item["rr_count_dist"].items()) or "—",
                      "`{}`".format(item["sample_hex"])])
    add(md_table(["flags", "包数", "包长分布", "RR 个数分布", "样例 hex"], lrows))
    add("")
    add("全捕获包长分布：{}".format(
        ", ".join("{}B×{}".format(k, v) for k, v in fl["length_dist"].items())))
    add("")
    if fl["rfu"]["warning"]:
        add("⚠ flags bit5–7 有置位（RFU）：bits={}，共 {} 包".format(
            fl["rfu"]["bits_set"], fl["rfu"]["count"]))
        add("")

    # 4 HR
    add("## 4. HR")
    add("")
    d = hr["delta"]
    add(md_table(["指标", "数值"], [
        ["有效 HR 包数（1–250）", hr["valid_count"]],
        ["min / max", "{} / {}".format(num(hr["min"]), num(hr["max"]))],
        ["中位数", num(hr["median"])],
        ["均值", num(hr["mean"])],
        ["P5 / P95", "{} / {}".format(num(hr["p5"]), num(hr["p95"]))],
        ["HR=0 包数", hr["zero_count"]],
        ["HR>250 包数", hr["gt250_count"]],
        ["HR 缺失（解码失败/无值）包数", hr["missing_count"]],
    ]))
    add("")
    add("逐包 ΔHR（相邻有效 HR 包）：")
    add("")
    add(md_table(["指标", "数值"], [
        ["ΔHR 对数", d["count"]],
        ["ΔHR min / max", "{} / {}".format(num(d["min"]), num(d["max"]))],
        ["ΔHR 中位数", num(d["median"])],
        ["|ΔHR| 均值", num(d["mean_abs"], 2)],
        ["|ΔHR| P95", num(d["p95_abs"])],
        ["|ΔHR| 分布", ", ".join("{}: {}".format(k, v)
                                  for k, v in d["buckets_abs"].items())],
    ]))
    add("")

    # 5 RR
    add("## 5. RR 质量")
    add("")
    pc = rr["per_packet"]
    add("### 5.1 每包 RR 个数")
    add("")
    add(md_table(["每包 RR 数", "包数", "占比"], [
        [k, v, pct(safe_div(v, pc["denominator"]))]
        for k, v in pc["length_dist"].items()
    ] + [["合计", pc["denominator"], "100%"] if pc["denominator"] else ["合计", 0, "—"]]))
    add("")
    add("- 含 ≥1 RR 的包：{} / {}（{}）".format(
        pc["rr_packet_count"], pc["denominator"], pct(pc["rr_packet_ratio"])))
    add("- 含 ≥2 RR 的包：{} / {}（{}）".format(
        pc["multi_rr_count"], pc["denominator"], pct(pc["multi_rr_ratio"])))
    add("- 单包最大 RR 数：{}".format(pc["max_rr_per_packet"]))
    add("")
    pool = rr["pool"]
    add("### 5.2 RR 池（全捕获）")
    add("")
    add(md_table(["指标", "数值"], [
        ["RR 总数", pool["count"]],
        ["min / max", "{} / {} ms".format(num(pool["min"]), num(pool["max"]))],
        ["中位数", "{} ms".format(num(pool["median"]))],
        ["均值 / 标准差", "{} / {} ms".format(num(pool["mean"]), num(pool["stdev"]))],
        ["P5 / P95", "{} / {} ms".format(num(pool["p5"]), num(pool["p95"]))],
        ["∈[400,1500]ms", "{} / {}（{}）".format(
            pool["in_range_count"], pool["count"], pct(pool["in_range_ratio"]))],
        ["<400ms / >1500ms", "{} / {}".format(pool["below_400_count"],
                                              pool["above_1500_count"])],
    ]))
    add("")
    art = rr["artifact"]
    add("### 5.3 粗伪影率")
    add("")
    add(md_table(["指标", "数值"], [
        ["判定阈值", "|ΔRR|/RR > {}".format(pct(art["threshold"], 0))],
        ["相邻 RR 对", art["pairs"]],
        ["伪影对", art["hits"]],
        ["粗伪影率", pct(art["rate"], 2)],
        ["包内对 / 命中", "{} / {}".format(art["within_packet_pairs"],
                                          art["within_packet_hits"])],
        ["跨包对 / 命中", "{} / {}".format(art["cross_packet_pairs"],
                                          art["cross_packet_hits"])],
        ["|ΔRR|/RR 中位 / P95 / max", "{} / {} / {}".format(
            num(art["ratio_median"], 3), num(art["ratio_p95"], 3),
            num(art["ratio_max"], 3))],
    ]))
    add("")
    if art["hits_detail"]:
        add("伪影样例（最多 20 条）：")
        add("")
        add(md_table(["相对时间", "前 RR", "后 RR", "变化"],
                      [[fmt_rel(h["t_rel"]), num(h["prev"], 1), num(h["cur"], 1),
                        pct(h["change_pct"], 2)] for h in art["hits_detail"]]))
        add("")
    win = rr["windows"]
    add("### 5.4 60s 窗口 RR / RMSSD（只算不宣称）")
    add("")
    if win.get("available"):
        add(md_table(["窗口", "完整", "RR 数", "中位 RR", "P5/P95", "RMSSD"],
                      [["{}–{}s".format(num(w["start_rel"], 0), num(w["end_rel"], 0)),
                        "是" if w["complete"] else "否", w["n_rr"],
                        num(w["rr_median"], 1),
                        "{}/{}".format(num(w["rr_p5"], 1), num(w["rr_p95"], 1)),
                        num(w["rmssd"], 1)] for w in win["windows"]]))
        add("")
        add("- RMSSD 窗口数：{}；中位/P5/P95：{} / {} / {} ms".format(
            win["rmssd_count"], num(win["rmssd_median"], 1),
            num(win["rmssd_min"], 1), num(win["rmssd_max"], 1)))
        add("- ⚠ RMSSD 只作 sanity check，不宣称临床值。")
    else:
        add("未验证：{}。".format(win.get("reason") or "无可用时间戳"))
    add("")
    drop = rr["dropout"]
    add("### 5.5 丢拍估计")
    add("")
    da = drop["arrival"]
    if da.get("available"):
        add(md_table(["方法", "指标", "数值"], [
            ["到达间隔", "中位间隔", "{} s".format(num(da["median_interval_sec"], 3))],
            ["到达间隔", ">3s 空档数", da["gap_count"]],
            ["到达间隔", "估计丢失通知数", da["est_missed_notifications"]],
            ["到达间隔", "丢失比例（估计）", pct(da["est_missed_ratio"])],
        ]))
    else:
        add("- 到达间隔法：未验证（无可用时间戳）")
    add("")
    dra = drop["rr_accumulation"]
    if dra.get("available"):
        add(md_table(["方法", "指标", "数值"], [
            ["RR 累计", "符合条件的空档对数", dra["pairs"]],
            ["RR 累计", "估计丢拍数", num(dra["est_missing_beats"], 1)],
            ["RR 累计", "缺口比例（估计）", pct(dra["est_missing_ratio"])],
        ]))
        if dra["detail"]:
            add("")
            add(md_table(["起", "止", "Δt", "应到拍数", "后一包实际 RR", "估计丢拍"],
                          [[fmt_rel(d["start_rel"]), fmt_rel(d["end_rel"]),
                            "{} s".format(num(d["delta_sec"], 2)),
                            num(d["expected_beats"], 1), d["delivered_rr"],
                            num(d["est_missing_beats"], 1)]
                           for d in dra["detail"]]))
        add("")
        add("- 说明：{}".format(dra["note"]))
    else:
        add("- RR 累计法：未验证（无 RR 或无时间戳）")
    add("")
    cons = rr.get("consistency") or {}
    add("RR / bpm 一致性 sanity：RR 中位数 {} ms vs 60000/HR 中位数 {} ms，"
        "比值 {}（{}）。".format(
            num(cons.get("rr_median"), 1), num(cons.get("expected_rr_ms_from_hr"), 1),
            num(cons.get("ratio"), 3), cons.get("note") or "—"))
    add("")

    # 6 接触
    add("## 6. 接触状态（T5）")
    add("")
    add(md_table(["指标", "数值"], [
        ["含 flags 的包", ct["packets_with_flags"]],
        ["bit2=1（声明支持接触检测）", "{}（{}）".format(
            ct["contact_supported_count"], pct(ct["contact_supported_ratio"]))],
        ["bit1=1（检测到接触，仅统计 bit2=1 的包）", "{}（{}）".format(
            ct["contact_detected_count"], pct(ct["contact_detected_ratio"]))],
        ["bit2=0 且 bit1=1（矛盾/inconsistent）", ct["inconsistent_count"]],
        ["bit2=0 且 bit1=0（unsupported）", ct["unsupported_count"]],
        ["进入状态时间轴的包", ct["packets_with_contact_bits"]],
        ["状态切换次数", len(ct["transitions"])],
    ]))
    add("")
    if ct["segments"]:
        add("状态分段（按文件顺序，仅 bit2=1；最多显示 40 段）：")
        add("")
        add(md_table(["状态", "起", "止", "包数", "时长", "HR 中位", "HR=0 包", "条/分"],
                      [[s["state"], fmt_rel(s["start_rel"]), fmt_rel(s["end_rel"]),
                        s["count"], fmt_duration(s["duration_sec"]),
                        num(s["hr_median"], 1), s["hr_zero_count"],
                        num(s["notif_per_min"], 1)]
                       for s in ct["segments"][:40]]))
        if len(ct["segments"]) > 40:
            add("")
            add("（共 {} 段，其余省略；完整数据见 analysis.json#/contact/segments）".format(
                len(ct["segments"])))
        add("")
    if ct["transitions"]:
        add("状态切换点（最多显示 40 个）：")
        add("")
        add(md_table(["#", "切换", "相对时间（绝对时间）"],
                      [[i + 1, "{} → {}".format(t["from"], t["to"]),
                        "{}（{}）".format(fmt_rel(t["at_rel"]), t["at_t"])]
                       for i, t in enumerate(ct["transitions"][:40])]))
        if len(ct["transitions"]) > 40:
            add("")
            add("（共 {} 个切换点，其余省略；完整数据见 analysis.json#/contact/transitions）".format(
                len(ct["transitions"])))
        add("")
    for ev in ct["detach_events"]:
        add("- 摘下事件：{}；重新接触：{}；摘下时长：{} s；摘下期间 HR=0 包：{}；"
            "恢复时间（启发式）：{}".format(
                fmt_rel(ev.get("detach_rel")),
                fmt_rel(ev.get("recontact_rel")) if ev.get("recontact_rel") is not None
                else "未观察到",
                num(ev.get("detach_duration_sec")),
                ev.get("hr_zero_in_detach"),
                ("{} s".format(num(ev.get("recovery_sec"))))
                if ev.get("recovery_sec") is not None else "未找到/未验证"))
    add("")

    # 7 运动
    add("## 7. 运动伪影（T6）")
    add("")
    if mo.get("available"):
        add("运动段（{}s 分箱、伪影率≥{}、相邻 RR 对≥{}，相邻 bin 合并）：".format(
            num(mo["bin_sec"], 0), pct(mo["motion_ratio_threshold"], 0),
            mo["min_pairs_per_bin"]))
        add("")
        if mo["segments"]:
            add(md_table(["#", "起", "止", "RR 对", "伪影对", "伪影率",
                          "最大跳变", "|ΔHR| max"],
                          [[i + 1, fmt_rel(s["start_rel"]), fmt_rel(s["end_rel"]),
                            s["pairs"], s["hits"], pct(s["artifact_rate"], 1),
                            pct(s["max_jump_ratio"], 1),
                            num(s["max_abs_dhr"], 1)]
                           for i, s in enumerate(mo["segments"])]))
        else:
            add("未检测到 ≥{} 的伪影聚集段（不代表运动中一定无伪影，样本可能不足）。".format(
                pct(mo["motion_ratio_threshold"], 0)))
        add("")
    else:
        add("未验证（{}）。".format(mo.get("note", "无可用时间戳")))
    dc = drop["clusters"]
    add("丢拍集中时间段（>{:.0f}s 空档）：{}".format(
        opts["gap_sec"],
        "无" if not dc else ""))
    if dc:
        add("")
        add(md_table(["#", "起", "止", "时长", "估计丢失通知"],
                      [[i + 1, fmt_rel(c["start_rel"]), fmt_rel(c["end_rel"]),
                        "{} s".format(num(c["duration_sec"], 2)),
                        c["est_missed_notifications"]]
                       for i, c in enumerate(dc)]))
    add("")
    add("T6 结论（机器可判定部分）：{}".format(
        "运动段伪影率见上表；" +
        ("检测到 {} 个伪影聚集段 → 运动中 RR 不可直接使用，只用 bpm 更稳。".format(
            len(mo.get("segments") or []))
         if mo.get("segments") else
         "未检测到明确伪影聚集段（静息样本），运动中可用性仍需 T6 人工记录佐证。")))
    add("")

    # 8 私有通道
    add("## 8. 私有通道候选（Gate C）")
    add("")
    if gs.get("present"):
        add("gatt.json 非标准 notify 特征：{} 个".format(
            len(gs["nonstandard_notify"])))
        add("")
        if gs["nonstandard_notify"]:
            add(md_table(["service", "char", "名称", "CCCD"],
                          [[c["service_short"], c["char_short"],
                            c["char_name"] or "—",
                            "是" if c.get("cccd") else "—"]
                           for c in gs["nonstandard_notify"]]))
            add("")
    else:
        add("gatt.json 缺失 → 服务枚举未验证。")
        add("")
    if pv["streams"]:
        add("非 HRS 通知流：")
        add("")
        add(md_table(["service", "char", "条数", "周期中位", "包长", "u16 中位", "候选"],
                      [[s["service"], s["char"], s["count"],
                        "{} s".format(num(s["period_median_sec"], 2))
                        if s["period_median_sec"] is not None else "—",
                        ", ".join("{}B".format(k) for k in s["length_dist"]),
                        num(s["u16_median"]),
                        "是（{}）".format("；".join(s["candidate_reasons"]))
                        if s["candidate"] else "否"]
                       for s in pv["streams"]]))
    else:
        add("未捕获到非 HRS 通知流。")
    add("")
    add("> 仅为候选列表，不猜测协议；Gate C 通过也不承诺可用（计划 §6：默认不投入逆向）。")
    add("")

    # 9 Gate 明细
    add("## 9. Gate 判定明细（逐条：数值 + 阈值 + 判定）")
    add("")
    for key in ("A", "B", "B_minus", "C", "D"):
        g = gates[key]
        add("### {}".format(g["label"]))
        add("")
        add("**判定：{}**".format(_gate_verdict_text(g["verdict"])))
        add("")
        rows = []
        for i, c in enumerate(g["criteria"]):
            rows.append([i + 1, c["name"], c["value_display"],
                         c["threshold"], c["verdict"], c["note"] or "—"])
        add(md_table(["#", "判据", "测量值", "阈值", "判定", "备注"], rows))
        add("")
        add("- 说明：{}".format(g["note"]))
        if key == "B":
            w = g.get("window") or {}
            add("- 窗口：rest_start={}s, rest_sec={}s, 可用={}s, 充分={}".format(
                num(w.get("rest_start_sec"), 0), num(w.get("rest_sec"), 0),
                num(w.get("available_sec"), 1), "是" if w.get("sufficient") else "否"))
        add("")
    add("**决策树结论**：{}".format(gates["decision"]))
    add("")

    # 10 Q
    add("## 10. Q1–Q10 回答表")
    add("")
    add(md_table(["#", "问题", "回答（数值 + 证据）", "证据指针"],
                  [[qrow["q"], qrow["question"], qrow["answer"], qrow["evidence"]]
                   for qrow in doc["qa"]]))
    add("")

    # 11 假设
    add("## 11. 口径与假设（分析器做的假设，必须人工复核）")
    add("")
    add(md_table(["#", "假设"], [[a["id"], a["text"]] for a in doc["assumptions"]]))
    add("")

    # 12 未验证清单
    add("## 12. 未验证清单（数据不足，未做猜测）")
    add("")
    unverified = []
    for key in ("A", "B", "B_minus", "C", "D"):
        for c in gates[key]["criteria"]:
            if c["verdict"] == V_UNKNOWN:
                unverified.append([gates[key]["label"], c["name"],
                                   c["value_display"], c["note"] or "—"])
    for qrow in doc["qa"]:
        if qrow["answer"].strip().startswith("未验证"):
            unverified.append(["Q 表", qrow["q"], "—", qrow["answer"]])
    if unverified:
        add(md_table(["Gate/来源", "项目", "现状", "原因"], unverified))
    else:
        add("无。")
    add("")

    # 13 summary 骨架
    add("## 13. summary.md 骨架（可直接改写成 §7 交付的 summary）")
    add("")
    add("```markdown")
    add("# CooSpo HW9 测试 summary（骨架，由 analyze.py 填充，未验证项需人工补）")
    add("")
    add("- 测试时间：{} ~ {}".format(o["first_t"] or "—", o["last_t"] or "—"))
    add("- 设备/固件：{} / {}".format(
        (meta.get("device") or {}).get("name") or "待补",
        (meta.get("device") or {}).get("firmware") or "待补"))
    add("- Gate A 可连接：{}｜Gate B RR 可用：{}｜Gate B- 仅 bpm：{}".format(
        gates["A"]["verdict"], gates["B"]["verdict"], gates["B_minus"]["verdict"]))
    add("- Gate C 私有通道：{}｜Gate D 不可用：{}".format(
        gates["C"]["verdict"], gates["D"]["verdict"]))
    add("- 决策：{}".format(gates["decision"]))
    add("- RR：bit4={}、每包≥2RR={}、∈[400,1500]={}、粗伪影率={}".format(
        pct(fl["bit_rates"]["bit4"]["ratio"]),
        pct(rr["per_packet"]["multi_rr_ratio"]),
        pct(rr["pool"]["in_range_ratio"]),
        pct(rr["artifact"]["rate"], 2)))
    add("- 通知：{} 条 / {} / {} 条每分钟".format(
        o["n"], fmt_duration(o["duration_sec"]),
        num(o["rate_per_min"], 1)))
    add("- 未验证项：见 §12")
    add("- 私有通道候选：{} 组（仅候选，未逆向）".format(
        len(pv["candidate_streams"])))
    add("- 并发/重连/配对缓存（Q8–Q10）：未验证（需人工记录）")
    add("- 建议：按决策树结论填写；健康数据仅本地留存、不提交 git。")
    add("```")
    add("")

    return "\n".join(L) + "\n"


def render_console(doc):
    o = doc["overall"]
    fl = doc["flags"]
    rr = doc["rr"]
    gates = doc["gates"]
    L = []
    add = L.append
    add("=== HW9 离线分析摘要 ===")
    add("输入: {}".format(doc["capture_dir"]))
    add("HRS 通知: {} 条 | 时长: {} | {} 条/分钟 | 解码失败: {} 条".format(
        o["n"], fmt_duration(o["duration_sec"]), num(o["rate_per_min"], 1),
        o["n_decode_errors"]))
    add("flags: bit4={} | bit2={} | bit1={}".format(
        pct(fl["bit_rates"]["bit4"]["ratio"]),
        pct(fl["bit_rates"]["bit2"]["ratio"]),
        pct(fl["bit_rates"]["bit1"]["ratio"])))
    add("RR: 总数 {} | 中位 {}ms | P5/P95 {}/{}ms | ∈[400,1500] {} | 伪影率 {}".format(
        rr["pool"]["count"], num(rr["pool"]["median"], 1),
        num(rr["pool"]["p5"], 1), num(rr["pool"]["p95"], 1),
        pct(rr["pool"]["in_range_ratio"]), pct(rr["artifact"]["rate"], 2)))
    for key in ("A", "B", "B_minus", "C", "D"):
        g = gates[key]
        add("{:<18s}: {:<6s} {}".format(g["label"], g["verdict"],
                                        " | ".join(
                                            "{}={}→{}".format(
                                                c["name"], c["value_display"],
                                                c["verdict"])
                                            for c in g["criteria"])))
    add("决策: {}".format(gates["decision"]))
    add("")
    add("已写入: analysis.json, analysis.md")
    return "\n".join(L)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv):
    p = argparse.ArgumentParser(
        prog="analyze.py",
        description="CooSpo HW9 (0x2A37) 通知流离线分析器：指标 + Gate 判定 + summary 骨架（纯标准库）")
    p.add_argument("capture_dir", help="抓包目录（含 notifications.jsonl）")
    p.add_argument("--json", action="store_true",
                   help="把结构化结果按 JSON 打到 stdout（不再打印人类摘要）")
    p.add_argument("--out-dir", default=None,
                   help="输出目录（默认写回 capture-dir）")
    p.add_argument("--rest-start", type=float, default=0.0,
                   help="Gate B 静息窗口起点（相对首条通知，秒），默认 0")
    p.add_argument("--rest-sec", type=float, default=300.0,
                   help="Gate B 静息窗口长度（秒），默认 300")
    p.add_argument("--gap-sec", type=float, default=3.0,
                   help="到达空档阈值（秒），默认 3.0")
    p.add_argument("--window-sec", type=float, default=60.0,
                   help="RR/RMSSD 窗口长度（秒），默认 60")
    p.add_argument("--bin-sec", type=float, default=10.0,
                   help="运动/丢拍分箱长度（秒），默认 10")
    p.add_argument("--rr-min", type=float, default=400.0,
                   help="RR 合理范围下限（ms），默认 400")
    p.add_argument("--rr-max", type=float, default=1500.0,
                   help="RR 合理范围上限（ms），默认 1500")
    p.add_argument("--artifact-threshold", type=float, default=0.20,
                   help="粗伪影判定阈值（相邻 RR 相对变化），默认 0.20")
    p.add_argument("--motion-artifact-ratio", type=float, default=0.20,
                   help="运动 bin 伪影率阈值，默认 0.20")
    p.add_argument("--min-pairs-per-bin", type=int, default=3,
                   help="运动 bin 最少相邻 RR 对数，默认 3")
    return p.parse_args(argv)


def main(argv=None):
    _setup_io()
    args = parse_args(argv)
    capture_dir = args.capture_dir
    if not os.path.isdir(capture_dir):
        print("错误：目录不存在：{}".format(capture_dir), file=sys.stderr)
        return 2
    opts = {
        "capture_dir": capture_dir,
        "rest_start": args.rest_start,
        "rest_sec": args.rest_sec,
        "gap_sec": args.gap_sec,
        "window_sec": args.window_sec,
        "bin_sec": args.bin_sec,
        "rr_min": args.rr_min,
        "rr_max": args.rr_max,
        "artifact_threshold": args.artifact_threshold,
        "motion_artifact_ratio": args.motion_artifact_ratio,
        "min_pairs_per_bin": args.min_pairs_per_bin,
    }
    try:
        doc = analyze_capture(capture_dir, opts)
    except FileNotFoundError as e:
        print("错误：{}".format(e), file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001
        print("错误：分析失败：{}: {}".format(type(e).__name__, e), file=sys.stderr)
        raise

    out_dir = args.out_dir or capture_dir
    os.makedirs(out_dir, exist_ok=True)
    json_path = os.path.join(out_dir, "analysis.json")
    md_path = os.path.join(out_dir, "analysis.md")
    with open(json_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    with open(md_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(render_markdown(doc, opts))

    if args.json:
        print(json.dumps(doc, ensure_ascii=False, indent=2))
    else:
        text = render_console(doc)
        print(text)
        print("")
        print("JSON: {}".format(os.path.abspath(json_path)))
        print("Markdown: {}".format(os.path.abspath(md_path)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
