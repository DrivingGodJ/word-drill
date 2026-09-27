#!/usr/bin/env python3
"""加词器：把一批新词写进 data/words.json（去重、排序、更新 meta），可选直接提交推送。

用法：
    # 直接给 JSON（推荐，一次加任意多个词）
    python3 scripts/add-words.py --json '[{"word":"barren","pos":"adj.","meaning":"贫瘠的，荒芜的",
        "example":"Years of over-farming had left the soil barren.","exampleZh":"多年的过度耕作让这片土地变得贫瘠。",
        "collocations":["barren land"]}]'

    # JSON 太长时写文件
    python3 scripts/add-words.py --json-file /tmp/words.json

    # 批量：每行一个「词 | 词性 | 释义」，例句等用 YAML 风格的续行（见 --help 里的格式说明）
    python3 scripts/add-words.py --list /tmp/words.txt

    # 只预览 / 只写文件不提交
    python3 scripts/add-words.py --json '...' --dry-run
    python3 scripts/add-words.py --json '...' --no-commit

字段（JSON 对象）：
    word        必填。英文单词（短语也行，id 会做 slug 化）
    meaning     必填。中文释义；多个义项用「；」分隔
    pos         词性，如 'n.' / 'v.' / 'adj.' / 'vt.'；多词性用 'n./v.'
    example     英文例句（建议用真实语料，别硬造）
    exampleZh   例句中文翻译
    collocations 常用搭配数组，如 ['have a stroke']
    tags        标签数组，如 ['Unit1'] / ['CET6']；不给就是 []

脚本自动做的事：
  * id = 单词小写 slug（'sun-drenched' → 'sun-drenched'），已存在就跳过并报告
  * 按字母序重排整个词库，更新 meta.updated
  * 检查 data/distractors.json 里是否混进了这些词/释义（会造成「正确释义同时当干扰项」），
    有的话**自动从干扰池剔除**
  * 默认 commit + push（GitHub Pages 自动重新部署）；--no-commit 只改文件，--dry-run 什么都不写
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORDS_FILE = ROOT / "data" / "words.json"
POOL_FILE = ROOT / "data" / "distractors.json"
GIT_DIR = ROOT

REQUIRED = ("word", "meaning")
ALLOWED = ("word", "pos", "meaning", "example", "exampleZh", "collocations", "tags")


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def git(*args: str) -> str:
    proc = subprocess.run(["git", "-C", str(GIT_DIR), *args], capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"git {' '.join(args)} 失败：{proc.stderr.strip()[:300]}")
    return proc.stdout


def normalize(entry: dict, where: str) -> dict:
    if not isinstance(entry, dict):
        sys.exit(f"{where}：每个词必须是 JSON 对象，收到 {type(entry).__name__}")
    for key in REQUIRED:
        if not str(entry.get(key, "")).strip():
            sys.exit(f"{where}：缺少必填字段 {key}（词条 {json.dumps(entry, ensure_ascii=False)[:80]}）")
    out = {"id": slug(entry["word"])}
    if not out["id"]:
        sys.exit(f"{where}：单词 {entry['word']!r} slug 化后为空，换个写法")
    for key in ALLOWED:
        if key in entry and entry[key] not in (None, ""):
            out[key] = entry[key]
        elif key in ("word", "meaning"):
            out[key] = str(entry[key]).strip()
    out.setdefault("pos", "")
    out.setdefault("example", "")
    out.setdefault("exampleZh", "")
    out.setdefault("collocations", [])
    out.setdefault("tags", [])
    for key in ("collocations", "tags"):
        if not isinstance(out[key], list):
            sys.exit(f"{where}：{key} 必须是数组")
    for key in ("word", "meaning", "pos", "example", "exampleZh"):
        if key in out:
            out[key] = str(out[key]).strip()
    return out


def load_list(path: str) -> list[dict]:
    """简易文本格式：
        barren | adj. | 贫瘠的，荒芜的；不育的
          example: Years of over-farming had left the soil barren.
          exampleZh: 多年的过度耕作让这片土地变得贫瘠。
          col: barren land ; barren soil
          tags: CET6
    以「词 | 词性 | 释义」开头，缩进行写附加字段。
    """
    out: list[dict] = []
    cur: dict | None = None
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        stripped = line.strip()
        if "|" in stripped and not stripped.split(":", 1)[0] in ("example", "exampleZh", "col", "collocations", "tags"):
            parts = [p.strip() for p in stripped.split("|")]
            if len(parts) < 3:
                sys.exit(f"列表格式错误（需要「词 | 词性 | 释义」）：{stripped}")
            cur = {"word": parts[0], "pos": parts[1], "meaning": " | ".join(parts[2:])}
            out.append(cur)
            continue
        if cur is None:
            sys.exit(f"列表格式错误（第一行必须是「词 | 词性 | 释义」）：{stripped}")
        key, _, value = stripped.partition(":")
        value = value.strip()
        if key in ("example", "e.g."):
            cur["example"] = value
        elif key in ("exampleZh", "zh", "翻译"):
            cur["exampleZh"] = value
        elif key in ("col", "collocations", "搭配"):
            cur["collocations"] = [v.strip() for v in re.split(r";|；|,", value) if v.strip()]
        elif key in ("tags", "标签"):
            cur["tags"] = [v.strip() for v in re.split(r";|；|,", value) if v.strip()]
        else:
            sys.exit(f"未知字段 {key!r}（可用 example / exampleZh / col / tags）")
    return out


def prune_pool(dropped_ids: set[str], lib_words: set[str], lib_meanings: set[str], dry: bool) -> list[str]:
    """把干扰池里与词库重复的词/释义剔掉（否则会拿正确释义当干扰项）。"""
    if not POOL_FILE.exists():
        return []
    pool = json.loads(POOL_FILE.read_text(encoding="utf-8"))
    items = pool.get("words") or []
    kept, removed = [], []
    for d in items:
        if (d.get("w", "").lower() in lib_words or d.get("w", "").lower() in dropped_ids
                or d.get("meaning") in lib_meanings):
            removed.append(d.get("w", ""))
        else:
            kept.append(d)
    if removed and not dry:
        pool["words"] = kept
        POOL_FILE.write_text(json.dumps(pool, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return removed


def main() -> None:
    ap = argparse.ArgumentParser(description="向词库加新词", formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--json", help="JSON 数组（词条对象）")
    src.add_argument("--json-file", help="从文件读 JSON 数组")
    src.add_argument("--list", help="从文本列表读（每行「词 | 词性 | 释义」+ 缩进续行）")
    ap.add_argument("--dry-run", action="store_true", help="只预览，不写文件不提交")
    ap.add_argument("--no-commit", action="store_true", help="写文件但不 commit/push")
    ap.add_argument("--tag", action="append", default=[], help="给这批词统一打标签，可重复")
    args = ap.parse_args()

    if args.json_file:
        entries = json.loads(Path(args.json_file).read_text(encoding="utf-8"))
    elif args.list:
        entries = load_list(args.list)
    else:
        entries = json.loads(args.json)
    if isinstance(entries, dict):
        entries = entries.get("words") or [entries]
    if not entries:
        sys.exit("没有要加的词")

    data = json.loads(WORDS_FILE.read_text(encoding="utf-8"))
    words = data["words"]
    have = {w["id"] for w in words}

    cleaned = [normalize(e, f"第 {i + 1} 条") for i, e in enumerate(entries)]
    added, skipped = [], []
    for item in cleaned:
        if item["id"] in have:
            skipped.append(item["word"])
            continue
        if args.tag:
            item["tags"] = sorted(set(list(item.get("tags") or []) + args.tag))
        words.append(item)
        have.add(item["id"])
        added.append(item)

    if not added:
        print(f"没有新词可加（{len(skipped)} 个已存在：{'、'.join(skipped)}）")
        return

    words.sort(key=lambda w: w["word"].lower())
    data["words"] = words
    data.setdefault("meta", {})["updated"] = datetime.now().astimezone().date().isoformat()

    print(f"新增 {len(added)} 个：")
    for w in added:
        print(f"  + {w['word']:<16} {w['pos']:<8} {w['meaning']}")
    if skipped:
        print(f"已存在跳过 {len(skipped)} 个：{'、'.join(skipped)}")

    lib_words = {w["word"].lower() for w in words}
    lib_meanings = {w["meaning"].strip() for w in words}
    removed = prune_pool({w["id"] for w in added}, lib_words, lib_meanings, args.dry_run)
    if removed:
        print(f"干扰池里剔除 {len(removed)} 条重复项：{'、'.join(removed)}")

    print(f"词库 {len(words) - len(added)} → {len(words)} 个词")

    if args.dry_run:
        print("\n--dry-run：未写入、未提交。")
        return

    WORDS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入 {WORDS_FILE.relative_to(ROOT)}")

    if args.no_commit:
        print("--no-commit：未提交。")
        return

    names = "、".join(w["word"] for w in added)
    git("add", "data/words.json", "data/distractors.json")
    git("commit", "-q", "-m", f"feat(dict): 加词 {len(added)} 个：{names}")
    push = subprocess.run(["git", "-C", str(GIT_DIR), "push", "-q", "origin", "main"],
                          capture_output=True, text=True)
    if push.returncode != 0:
        git("pull", "--rebase", "-q", "origin", "main")
        git("push", "-q", "origin", "main")
    print(f"已提交并推送：{names}（GitHub Pages 会自动重新部署）")


if __name__ == "__main__":
    main()
