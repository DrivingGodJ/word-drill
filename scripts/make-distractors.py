#!/usr/bin/env python3
"""生成「词库外干扰释义」池 data/distractors.json。

用途：练习时四选一的干扰项不再只从自己词库里挑（词太少时一眼就能排除），
这里预先准备 ~480 条**不在词库里的**四六级词的释义，供 app.js 随机掺进选项。

规则：
  * 词源：scripts/.cache-cet/ 里已缓存的 CET4/CET6 词书（缺了会重新下载）。
  * 排除：词库里已有的词、中小学教材词（太简单，干扰性差）、释义为空或与词库释义重复的。
  * pos 归一化成首个词性（'n./v.' → 'n.'），方便和词库词按词性配对。
  * 按固定随机种子抽样，保证每次生成结果一致（可复现、不会每次提交都在抖）。

用法：
    python3 scripts/make-distractors.py            # 写 data/distractors.json
    python3 scripts/make-distractors.py --dry-run  # 只看会生成多少条
"""

from __future__ import annotations

import argparse
import json
import random
import re
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORDS_FILE = ROOT / "data" / "words.json"
OUT_FILE = ROOT / "data" / "distractors.json"
CACHE_DIR = ROOT / "scripts" / ".cache-cet"

DICT_REPO = "kajweb/dict"
BOOKS = ("CET4", "CET6")
POOL_SIZE = 480
SEED = 20260920

KNOWN_PATTERN = r"^\d+_((PEP)?(GaoZhong|ChuZhong)|PEPXiaoXue\d)_\d+\.zip$"


def gh_bytes(*args: str) -> bytes:
    proc = subprocess.run(["gh", "api", *args], capture_output=True)
    if proc.returncode != 0:
        sys.exit(f"gh api 调用失败：{proc.stderr.decode('utf-8', 'replace')[:300]}")
    return proc.stdout


def download_books(pattern: str) -> list[Path]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    listing = json.loads(subprocess.run(
        ["gh", "api", f"repos/{DICT_REPO}/contents/book"],
        capture_output=True, text=True).stdout)
    wanted = [it for it in listing if re.match(pattern, it["name"], re.IGNORECASE)]
    if not wanted:
        sys.exit(f"{DICT_REPO}/book 里没找到匹配 {pattern} 的词书 zip")
    paths: list[Path] = []
    for it in sorted(wanted, key=lambda x: x["name"]):
        dest = CACHE_DIR / it["name"]
        if dest.exists() and dest.stat().st_size == it["size"]:
            paths.append(dest)
            continue
        print(f"下载词书 {it['name']}（{it['size'] // 1024} KB）...")
        dest.write_bytes(gh_bytes("-H", "Accept: application/vnd.github.raw",
                                  f"repos/{DICT_REPO}/contents/book/{it['name']}"))
        paths.append(dest)
    return paths


def load_book(zip_path: Path) -> list[dict]:
    out: list[dict] = []
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            if not name.endswith(".json"):
                continue
            for line in z.read(name).decode("utf-8").splitlines():
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
    return out


def pos_key(trans: list[dict]) -> str:
    """取第一个词性，归一成 'n.' / 'v.' / 'adj.' / 'adv.' 这种短形式。"""
    for t in trans:
        for p in re.split(r"&|/", t.get("pos", "")):
            p = p.strip()
            if p:
                return f"{p}."
    return ""


def meaning_of(trans: list[dict]) -> str:
    seen: list[str] = []
    for t in trans:
        cn = (t.get("tranCn") or "").strip()
        if cn and cn not in seen:
            seen.append(cn)
    return "；".join(seen[:2])


def main() -> None:
    ap = argparse.ArgumentParser(description="生成词库外干扰释义池")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--size", type=int, default=POOL_SIZE)
    args = ap.parse_args()

    lib = json.loads(WORDS_FILE.read_text(encoding="utf-8"))["words"]
    lib_words = {w["word"].lower() for w in lib}
    lib_meanings = {w["meaning"].strip() for w in lib}

    excluded = set()
    for zp in download_books(KNOWN_PATTERN):
        for raw in load_book(zp):
            head = (raw.get("headWord") or "").strip().lower()
            if head:
                excluded.add(head)
    print(f"词库 {len(lib_words)} 个词；中小学词表 {len(excluded)} 个（都排除）")

    pool: list[dict] = []
    seen_meaning = set()
    for level in BOOKS:
        for zp in download_books(rf"^\d+_{level}(?:luan)?_\d+\.zip$"):
            for raw in load_book(zp):
                head = (raw.get("headWord") or "").strip()
                low = head.lower()
                if not low or low in lib_words or low in excluded or len(low) < 3:
                    continue
                content = raw.get("content", {}).get("word", {}).get("content", {})
                trans = content.get("trans") or []
                meaning = meaning_of(trans)
                pos = pos_key(trans)
                if not meaning or not pos or meaning in lib_meanings or meaning in seen_meaning:
                    continue
                seen_meaning.add(meaning)
                pool.append({"w": head, "pos": pos, "meaning": meaning})

    print(f"可作干扰的候选 {len(pool)} 条")
    rng = random.Random(SEED)
    rng.shuffle(pool)
    picked = sorted(pool[: args.size], key=lambda d: d["w"].lower())

    print(f"抽样 {len(picked)} 条，例如：")
    for d in picked[:8]:
        print(f"  {d['w']:<14} {d['pos']:<6} {d['meaning']}")

    if args.dry_run:
        print("\n--dry-run：未写入。")
        return

    OUT_FILE.write_text(json.dumps({"words": picked}, ensure_ascii=False, indent=1) + "\n",
                        encoding="utf-8")
    print(f"\n已写入 {OUT_FILE.relative_to(ROOT)}（{OUT_FILE.stat().st_size // 1024} KB）")


if __name__ == "__main__":
    main()
