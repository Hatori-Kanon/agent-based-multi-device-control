#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分析器自测：生成 3 组合成样本 → 跑 analyze.py → 断言关键指标/Gate 结论。

用法：
    python selftest/check.py          # 或 python analyze.py 同目录下 python selftest/check.py
    bash selftest/run.sh              # 等价包装
退出码：0=全部通过，1=有失败。
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL_DIR = os.path.dirname(HERE)
ANALYZE = os.path.join(TOOL_DIR, "analyze.py")
SAMPLES = ("rr-good", "bpm-only", "messy")
RUN_DIR = os.path.join(HERE, "_run")

RESULTS = []


def _setup_io():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def check(name, cond, detail=""):
    RESULTS.append((bool(cond), name, detail))
    print("[{}] {}  {}".format("PASS" if cond else "FAIL", name, detail))


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def run_analyzer(sample):
    """以 CLI 方式运行 analyze.py。

    注：本机 DSH 沙箱下 subprocess 的 pipe 会被拒绝（WinError 5），
    因此这里用文件重定向而不是 capture_output。
    """
    sample_dir = os.path.join(HERE, sample)
    os.makedirs(RUN_DIR, exist_ok=True)
    out_path = os.path.join(RUN_DIR, sample + ".out.txt")
    err_path = os.path.join(RUN_DIR, sample + ".err.txt")
    cmd = [sys.executable, ANALYZE, sample_dir]
    with open(out_path, "w", encoding="utf-8") as fo, \
            open(err_path, "w", encoding="utf-8") as fe:
        proc = subprocess.run(cmd, stdout=fo, stderr=fe)
    with open(out_path, "r", encoding="utf-8", errors="replace") as f:
        stdout = f.read()
    with open(err_path, "r", encoding="utf-8", errors="replace") as f:
        stderr = f.read()
    print("\n$ " + " ".join(cmd))
    tail = stdout.strip().splitlines()
    for line in tail[-6:]:
        print("  | " + line)
    if proc.returncode != 0:
        print("  stderr: " + stderr.strip())
    check("{}: analyze.py 退出码 0".format(sample), proc.returncode == 0,
          "exit={}".format(proc.returncode))
    out_dir = os.path.join(sample_dir)
    json_path = os.path.join(out_dir, "analysis.json")
    md_path = os.path.join(out_dir, "analysis.md")
    return (load(json_path) if os.path.isfile(json_path) else None,
            md_path, proc)


def gate(doc, key):
    return ((doc or {}).get("gates") or {}).get(key) or {}


def verdict(doc, key):
    return gate(doc, key).get("verdict")


def main():
    _setup_io()
    sys.path.insert(0, HERE)
    import make_samples  # noqa: E402  (同目录脚本)

    make_samples.main()
    print("\n=== HW9 分析器自测（合成数据，非真实健康数据）===\n")

    # ---------------- rr-good ----------------
    doc, md_path, _ = run_analyzer("rr-good")
    check("rr-good: analysis.json 生成", doc is not None)
    check("rr-good: Gate A pass", verdict(doc, "A") == "pass", verdict(doc, "A"))
    check("rr-good: Gate B pass", verdict(doc, "B") == "pass", verdict(doc, "B"))
    check("rr-good: Gate B- fail", verdict(doc, "B_minus") == "fail")
    check("rr-good: Gate C fail", verdict(doc, "C") == "fail")
    check("rr-good: Gate D fail", verdict(doc, "D") == "fail")
    check("rr-good: 决策=首选",
          "首选" in ((doc or {}).get("gates") or {}).get("decision", ""),
          ((doc or {}).get("gates") or {}).get("decision", ""))
    if doc:
        br = doc["flags"]["bit_rates"]
        check("rr-good: bit4=1 比例 == 1.0", br["bit4"]["ratio"] == 1.0,
              str(br["bit4"]["ratio"]))
        check("rr-good: 每包≥2RR 比例 == 1.0",
              doc["rr"]["per_packet"]["multi_rr_ratio"] == 1.0,
              str(doc["rr"]["per_packet"]["multi_rr_ratio"]))
        check("rr-good: 无 >3s 空档",
              doc["overall"]["intervals"]["gaps_count"] == 0,
              "gaps={}".format(doc["overall"]["intervals"]["gaps_count"]))
        check("rr-good: 粗伪影率 <5%",
              doc["rr"]["artifact"]["rate"] is not None
              and doc["rr"]["artifact"]["rate"] < 0.05,
              str(doc["rr"]["artifact"]["rate"]))
        check("rr-good: RR 100% ∈[400,1500]",
              doc["rr"]["pool"]["in_range_ratio"] == 1.0,
              str(doc["rr"]["pool"]["in_range_ratio"]))
        check("rr-good: 60s 窗口 RMSSD 有值",
              doc["rr"]["windows"]["rmssd_count"] >= 4,
              "windows={}".format(doc["rr"]["windows"]["rmssd_count"]))
        check("rr-good: 静息窗口充分",
              doc["rest_window"]["sufficient"] is True)
        check("rr-good: 无解码失败", doc["quality"]["hrs_errors"] == 0)
        check("rr-good: RR 累计法无空档（pairs=0）",
              doc["rr"]["dropout"]["rr_accumulation"]["pairs"] == 0,
              str(doc["rr"]["dropout"]["rr_accumulation"]["pairs"]))
        cons = doc["rr"]["consistency"]["ratio"]
        check("rr-good: RR 中位数与 60000/HR 一致（0.95–1.05）",
              cons is not None and 0.95 <= cons <= 1.05, str(cons))
    check("rr-good: analysis.md 生成且含 Gate B",
          os.path.isfile(md_path)
          and "Gate B RR 可用" in open(md_path, encoding="utf-8").read())

    # ---------------- bpm-only ----------------
    doc, md_path, _ = run_analyzer("bpm-only")
    check("bpm-only: analysis.json 生成", doc is not None)
    check("bpm-only: Gate A pass", verdict(doc, "A") == "pass", verdict(doc, "A"))
    check("bpm-only: Gate B fail", verdict(doc, "B") == "fail", verdict(doc, "B"))
    check("bpm-only: Gate B- pass", verdict(doc, "B_minus") == "pass")
    check("bpm-only: Gate C fail", verdict(doc, "C") == "fail")
    check("bpm-only: Gate D fail", verdict(doc, "D") == "fail")
    check("bpm-only: 决策含“仅 bpm”",
          "仅 bpm" in ((doc or {}).get("gates") or {}).get("decision", ""))
    if doc:
        check("bpm-only: bit4 恒 0",
              doc["flags"]["bit_rates"]["bit4"]["ratio"] == 0.0,
              str(doc["flags"]["bit_rates"]["bit4"]["ratio"]))
        check("bpm-only: RR 池为空", doc["rr"]["pool"]["count"] == 0)
        check("bpm-only: HR 中位数在 66..70",
              doc["hr"]["median"] is not None
              and 66 <= doc["hr"]["median"] <= 70,
              str(doc["hr"]["median"]))
        check("bpm-only: 无解码失败", doc["quality"]["hrs_errors"] == 0)

    # ---------------- messy ----------------
    doc, md_path, _ = run_analyzer("messy")
    check("messy: analysis.json 生成", doc is not None)
    check("messy: Gate A pass", verdict(doc, "A") == "pass", verdict(doc, "A"))
    check("messy: Gate B fail", verdict(doc, "B") == "fail", verdict(doc, "B"))
    check("messy: Gate B- pass", verdict(doc, "B_minus") == "pass")
    check("messy: Gate C pass（存在厂商 notify 候选）",
          verdict(doc, "C") == "pass", verdict(doc, "C"))
    check("messy: Gate D fail", verdict(doc, "D") == "fail")
    if doc:
        hist_flags = {h["flags"] for h in doc["flags"]["histogram"]}
        check("messy: flags 含 0x16/0x06/0x0A",
              {0x16, 0x06, 0x0A}.issubset(hist_flags), str(sorted(hist_flags)))
        gaps = doc["overall"]["intervals"]["gaps_count"]
        check("messy: 空档数 ≥3", gaps >= 3, "gaps={}".format(gaps))
        art = doc["rr"]["artifact"]["rate"]
        check("messy: 粗伪影率 ∈ (2%,60%)",
              art is not None and 0.02 < art < 0.60, str(art))
        irr = doc["rr"]["pool"]["in_range_ratio"]
        check("messy: RR 范围外值存在（90%<比例<100%）",
              irr is not None and 0.90 < irr < 1.0, str(irr))
        check("messy: 解码失败恰 1 条",
              doc["quality"]["hrs_errors"] == 1,
              str(doc["quality"]["hrs_errors"]))
        check("messy: 坏 JSON 行恰 1 条",
              doc["quality"]["malformed_lines"] == 1,
              str(doc["quality"]["malformed_lines"]))
        check("messy: 非通知行 ≥1",
              doc["quality"]["non_notification_rows"] >= 1)
        check("messy: decoded 与 hex 不一致 ≥1 行",
              doc["quality"]["decoded_mismatch"]["mismatch_rows"] >= 1,
              str(doc["quality"]["decoded_mismatch"]["mismatch_rows"]))
        check("messy: HR=0 包恰 7（摘下段）",
              doc["hr"]["zero_count"] == 7, str(doc["hr"]["zero_count"]))
        segs = doc["motion"]["segments"]
        check("messy: 运动段 ≥3", len(segs) >= 3, "segments={}".format(len(segs)))
        clus = doc["rr"]["dropout"]["clusters"]
        check("messy: 丢拍集中段 ≥3", len(clus) >= 3, "clusters={}".format(len(clus)))
        det = doc["contact"]["detach_events"]
        det_ok = [e for e in det if e.get("hr_zero_in_detach") == 7]
        check("messy: 摘段事件记录 HR=0 包=7", len(det_ok) == 1,
              "detach_events={}".format(len(det)))
        check("messy: 戴回后恢复时间可计算",
              bool(det_ok) and det_ok[0].get("recovery_sec") is not None,
              str(det_ok[0].get("recovery_sec")) if det_ok else "—")
        dist = doc["rr"]["per_packet"]["length_dist"]
        check("messy: 每包 RR 数含 2 且总类型 ≥3",
              "2" in dist and len(dist) >= 3, str(dist))
        check("messy: 静息窗口充分（Gate B 可判 fail 而非未验证）",
              doc["rest_window"]["sufficient"] is True)
        check("messy: 私有通道候选流 ≥1",
              len(doc["private_channels"]["candidate_streams"]) >= 1)
        check("messy: 接触时间轴被矛盾包污染前已过滤（切换=2）",
              len(doc["contact"]["transitions"]) == 2,
              "transitions={}".format(len(doc["contact"]["transitions"])))
        check("messy: inconsistent 接触包 >0（0x0A 的 bit2=0&bit1=1）",
              doc["contact"]["inconsistent_count"] > 0,
              str(doc["contact"]["inconsistent_count"]))
        acc = doc["rr"]["dropout"]["rr_accumulation"]
        check("messy: RR 累计法识别 3 段空档且估丢拍>0",
              acc["pairs"] == 3 and acc["est_missing_beats"] > 0,
              "pairs={} missing={}".format(acc["pairs"],
                                           acc["est_missing_beats"]))
        check("messy: HR 缺失 = 1（解码失败计入）",
              doc["hr"]["missing_count"] == 1,
              str(doc["hr"]["missing_count"]))
        cons = doc["rr"]["consistency"]["ratio"]
        check("messy: RR 中位数与 60000/HR 一致（0.95–1.05）",
              cons is not None and 0.95 <= cons <= 1.05, str(cons))
    check("messy: analysis.md 生成", os.path.isfile(md_path))

    # ---------------- 汇总 ----------------
    passed = sum(1 for ok, _, _ in RESULTS if ok)
    failed = len(RESULTS) - passed
    print("\n=== 汇总：{} pass / {} fail（共 {} 条断言）===".format(
        passed, failed, len(RESULTS)))
    if failed:
        print("失败项：")
        for ok, name, detail in RESULTS:
            if not ok:
                print("  - {}  {}".format(name, detail))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
