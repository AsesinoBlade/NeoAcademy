#!/usr/bin/env python3

import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# NeoAcademy memory watcher
#
# Samples frequently but only logs suspicious conditions.
#
# Watches:
#   - overall macOS free-memory percentage
#   - swap usage
#   - NeoAcademy / Next.js
#   - Ollama
#   - vMLX / Python MLX image processes
#   - Docker
#
# Run in a separate terminal:
#   python3 scripts/memory-watch.py
# ---------------------------------------------------------------------------

SAMPLE_SECONDS = 5
REPEAT_ALERT_SECONDS = 60

# System-level thresholds
LOW_FREE_MEMORY_PERCENT = 15
CRITICAL_FREE_MEMORY_PERCENT = 8

SWAP_WARNING_MB = 2048
SWAP_CRITICAL_MB = 6144

# Individual RSS threshold. RSS does NOT include all Apple GPU/unified memory,
# so system pressure/swap is more important than this value.
PROCESS_RSS_WARNING_MB = 8192

LOG_PATH = Path(__file__).resolve().parent.parent / "logs" / "memory-watch.log"

# Processes relevant to NeoAcademy.
PROCESS_PATTERNS = [
    ("NeoAcademy", re.compile(r"NeoAcademy|next-server|next dev|pnpm dev", re.I)),
    ("Ollama", re.compile(r"\bollama\b", re.I)),
    ("vMLX", re.compile(r"\bvmlx\b|z-image|mflux", re.I)),
    ("Docker", re.compile(r"Docker|com\.docker", re.I)),
]


def run_command(args):
    try:
        result = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=10,
        )
        return result.stdout
    except Exception:
        return ""


def get_memory_free_percent():
    output = run_command(["memory_pressure"])

    match = re.search(
        r"System-wide memory free percentage:\s*(\d+)%",
        output,
    )

    if not match:
        return None

    return int(match.group(1))


def get_swap_used_mb():
    output = run_command(["sysctl", "vm.swapusage"])

    match = re.search(
        r"used\s*=\s*([\d.]+)([MG])",
        output,
        re.I,
    )

    if not match:
        return None

    value = float(match.group(1))
    unit = match.group(2).upper()

    if unit == "G":
        value *= 1024

    return value


def get_processes():
    output = run_command(
        [
            "ps",
            "-axo",
            "pid=,ppid=,rss=,%mem=,etime=,command=",
        ]
    )

    processes = []

    for line in output.splitlines():
        parts = line.strip().split(None, 5)

        if len(parts) < 6:
            continue

        try:
            pid = int(parts[0])
            ppid = int(parts[1])
            rss_kb = int(parts[2])
            mem_percent = float(parts[3])
        except ValueError:
            continue

        elapsed = parts[4]
        command = parts[5]

        category = None

        for name, pattern in PROCESS_PATTERNS:
            if pattern.search(command):
                category = name
                break

        if not category:
            continue

        # Do not include this watcher itself.
        if pid == os.getpid():
            continue

        processes.append(
            {
                "category": category,
                "pid": pid,
                "ppid": ppid,
                "rss_mb": rss_kb / 1024,
                "mem_percent": mem_percent,
                "elapsed": elapsed,
                "command": command,
            }
        )

    return processes


def short_command(command):
    command = command.replace(str(Path.home()), "~")

    if len(command) > 180:
        return command[:177] + "..."

    return command


def write_alert(reason, free_percent, swap_mb, processes):
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().astimezone().isoformat(timespec="seconds")

    total_rss = sum(p["rss_mb"] for p in processes)

    lines = [
        "",
        "=" * 80,
        f"{timestamp}",
        f"ALERT: {reason}",
        f"System free memory: {free_percent if free_percent is not None else '?'}%",
        f"Swap used: {swap_mb:.1f} MB" if swap_mb is not None else "Swap used: ?",
        f"Relevant process RSS total: {total_rss:.1f} MB",
        "",
        "Relevant processes:",
    ]

    if not processes:
        lines.append("  NONE FOUND")
    else:
        processes = sorted(
            processes,
            key=lambda p: p["rss_mb"],
            reverse=True,
        )

        for p in processes:
            lines.append(
                f"  {p['category']:10} "
                f"PID={p['pid']:6} "
                f"PPID={p['ppid']:6} "
                f"RSS={p['rss_mb']:9.1f} MB "
                f"%MEM={p['mem_percent']:5.1f} "
                f"TIME={p['elapsed']:>10}"
            )
            lines.append(f"      {short_command(p['command'])}")

    lines.append("=" * 80)

    text = "\n".join(lines) + "\n"

    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(text)

    print(
        f"[{timestamp}] {reason} "
        f"(free={free_percent}%, "
        f"swap={swap_mb:.0f}MB)"
        if swap_mb is not None
        else f"[{timestamp}] {reason}"
    )


def classify(free_percent, swap_mb, processes):
    reasons = []

    if free_percent is not None:
        if free_percent <= CRITICAL_FREE_MEMORY_PERCENT:
            reasons.append(f"CRITICAL memory pressure ({free_percent}% free)")
        elif free_percent <= LOW_FREE_MEMORY_PERCENT:
            reasons.append(f"low memory ({free_percent}% free)")

    if swap_mb is not None:
        if swap_mb >= SWAP_CRITICAL_MB:
            reasons.append(f"CRITICAL swap usage ({swap_mb:.0f} MB)")
        elif swap_mb >= SWAP_WARNING_MB:
            reasons.append(f"high swap usage ({swap_mb:.0f} MB)")

    large_processes = [
        p
        for p in processes
        if p["rss_mb"] >= PROCESS_RSS_WARNING_MB
    ]

    for p in large_processes:
        reasons.append(
            f"{p['category']} PID {p['pid']} RSS {p['rss_mb']:.0f} MB"
        )

    return "; ".join(reasons) if reasons else None


def main():
    print("NeoAcademy memory watcher")
    print(f"Sampling every {SAMPLE_SECONDS} seconds")
    print(f"Logging alerts to: {LOG_PATH}")
    print("Ctrl-C to stop.")
    print()

    previous_reason = None
    last_alert_time = 0

    try:
        while True:
            free_percent = get_memory_free_percent()
            swap_mb = get_swap_used_mb()
            processes = get_processes()

            reason = classify(
                free_percent,
                swap_mb,
                processes,
            )

            now = time.time()

            if reason:
                should_log = (
                    reason != previous_reason
                    or now - last_alert_time >= REPEAT_ALERT_SECONDS
                )

                if should_log:
                    write_alert(
                        reason,
                        free_percent,
                        swap_mb,
                        processes,
                    )
                    last_alert_time = now

            previous_reason = reason

            time.sleep(SAMPLE_SECONDS)

    except KeyboardInterrupt:
        print("\nMemory watcher stopped.")


if __name__ == "__main__":
    main()
