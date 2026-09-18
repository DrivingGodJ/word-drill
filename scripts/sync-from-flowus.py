#!/usr/bin/env python3
"""把 FlowUs 生词页同步进 data/words.json。

用法：
    python3 scripts/sync-from-flowus.py                    # 同步默认生词页
    python3 scripts/sync-from-flowus.py --dry-run          # 只看差异，不写文件
    python3 scripts/sync-from-flowus.py --page-id <ID>     # 换一个页面
    python3 scripts/sync-from-flowus.py --replace          # 全量替换（慎用）

设计原则：
  * FlowUs 页面是生词内容的 source of truth（你手动改的以页面为准）。
  * 词库里已有的 collocations / tags 等字段不会被清掉。
  * 只更新单词、词性、释义、例句这几项。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_PAGE_ID = "2220ec94-e0c2-4523-87be-f8277b09d786"   # FlowUs · 学习/生词
ROOT = Path(__file__).resolve().parent.parent
WORDS_FILE = ROOT / "data" / "words.json"

# 标准条目：- **word** pos meaning
RE_BULLET = re.compile(r"^[-*]\s+\*\*(?P<word>[^*]+)\*\*\s*(?P<rest>.*)$")
# 例句子块：例：English — 中文（长前缀必须排在短前缀前，否则"例："会残留冒号）
RE_EXAMPLE = re.compile(
    r"^\s*(?:例句|例|e\.g\.)\s*[:：]?\s*(?P<en>.+?)\s*[—–]\s*(?P<zh>.+)$"
)
# 纯文本旧格式：word meaning（整行无 markdown 标记）
RE_PLAIN = re.compile(r"^(?P<word>[A-Za-z][A-Za-z'’\-\s]{1,40}?)\s{1,}(?P<rest>\S.*)$")
# 词性前缀：n. / v. / adj. / adv. / phr. / prep. 等
RE_POS = re.compile(r"^\s*(?P<pos>(?:[a-z]{1,4}\.\s*(?:/\s*)?)+)\s*(?P<meaning>.+)$")


def slugify(word: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", word.strip().lower()).strip("-")


def split_pos(rest: str) -> tuple[str, str]:
    """把 'n. 大量，丰富' 拆成 ('n.', '大量，丰富')。"""
    m = RE_POS.match(rest)
    if m:
        pos = re.sub(r"\s+", " ", m.group("pos")).strip()
        return pos, m.group("meaning").strip()
    return "", rest.strip()


def parse_markdown(md: str) -> list[dict]:
    """解析生词页 markdown，返回词条列表。"""
    entries: list[dict] = []
    current: dict | None = None

    for raw in md.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue

        # 例句子块（先判，避免被当成新词条）
        m_ex = RE_EXAMPLE.match(line)
        if m_ex and current is not None:
            current["example"] = m_ex.group("en").strip()
            current["exampleZh"] = m_ex.group("zh").strip()
            continue

        # 标准 bullet 条目
        m = RE_BULLET.match(line.strip())
        if m:
            word = m.group("word").strip()
            pos, meaning = split_pos(m.group("rest"))
            current = {"id": slugify(word), "word": word, "pos": pos,
                       "meaning": meaning, "example": "", "exampleZh": ""}
            entries.append(current)
            continue

        # 纯文本条目（旧格式）：行首是英文单词 + 释义
        if current is None or not line.startswith((" ", "\t")):
            m_plain = RE_PLAIN.match(line.strip())
            if m_plain and not line.strip().startswith(("#", ">", "|")):
                word = m_plain.group("word").strip()
                # 排除整句英文（>4 个词的多半是例句/说明）
                if len(word.split()) <= 3:
                    pos, meaning = split_pos(m_plain.group("rest"))
                    current = {"id": slugify(word), "word": word, "pos": pos,
                               "meaning": meaning, "example": "", "exampleZh": ""}
                    entries.append(current)

    # 去重：同 id 保留最后一次出现
    seen: dict[str, dict] = {}
    for e in entries:
        if e["id"]:
            seen[e["id"]] = e
    return list(seen.values())


def fetch_page_markdown(page_id: str) -> str:
    """用 flowus CLI 拉页面 markdown。"""
    try:
        proc = subprocess.run(
            ["flowus", "--json", "markdown", "get", page_id],
            capture_output=True, text=True, timeout=60,
        )
    except FileNotFoundError:
        sys.exit("找不到 flowus 命令。先按 flowus-cli 技能安装，或直接手动编辑 data/words.json。")

    if proc.returncode != 0:
        sys.exit(f"拉取失败：{proc.stderr.strip()[:300]}")

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        sys.exit(f"返回不是 JSON：{proc.stdout[:200]}")

    if not payload.get("ok"):
        sys.exit(f"FlowUs 返回错误：{json.dumps(payload, ensure_ascii=False)[:300]}")
    return payload["data"]["markdown"]


def load_words() -> dict:
    if not WORDS_FILE.exists():
        return {"meta": {}, "words": []}
    with WORDS_FILE.open(encoding="utf-8") as f:
        return json.load(f)


def merge(existing: list[dict], incoming: list[dict]) -> tuple[list[dict], list[str], list[str], list[str]]:
    """合并词条：以 FlowUs 为准更新内容字段，保留本地扩展字段。"""
    by_id = {w["id"]: w for w in existing}
    added, updated, blank = [], [], []

    for item in incoming:
        if not item.get("meaning"):
            blank.append(item["word"])
        old = by_id.get(item["id"])
        if old is None:
            item.setdefault("collocations", [])
            item.setdefault("tags", [])
            existing.append(item)
            added.append(item["word"])
            continue

        changed = False
        for key in ("word", "pos", "meaning", "example", "exampleZh"):
            new_val = item.get(key)
            if new_val and old.get(key) != new_val:
                old[key] = new_val
                changed = True
        if changed:
            updated.append(item["word"])

    existing.sort(key=lambda w: w["word"].lower())
    return existing, added, updated, blank


def main() -> None:
    ap = argparse.ArgumentParser(description="同步 FlowUs 生词页到 data/words.json")
    ap.add_argument("--page-id", default=DEFAULT_PAGE_ID, help="FlowUs 生词页 ID")
    ap.add_argument("--dry-run", action="store_true", help="只显示差异，不写入")
    ap.add_argument("--replace", action="store_true", help="全量替换而不是合并")
    ap.add_argument("--markdown-file", help="跳过联网，直接读本地 markdown 文件（调试用）")
    args = ap.parse_args()

    md = (Path(args.markdown_file).read_text(encoding="utf-8")
          if args.markdown_file else fetch_page_markdown(args.page_id))

    incoming = parse_markdown(md)
    if not incoming:
        sys.exit("没有解析出任何词条。检查页面格式，或确认页面 ID 是否正确。")

    data = load_words()
    existing = [] if args.replace else data.get("words", [])

    words, added, updated, blank = merge(existing, incoming)
    data["words"] = words
    data.setdefault("meta", {})
    data["meta"]["updated"] = __import__("datetime").date.today().isoformat()
    data["meta"]["source"] = f"FlowUs · page {args.page_id}"

    print(f"页面解析出 {len(incoming)} 个词条")
    print(f"  新增 {len(added)}：{'、'.join(added) if added else '—'}")
    print(f"  更新 {len(updated)}：{'、'.join(updated) if updated else '—'}")
    print(f"  词库合计 {len(words)} 个词")
    if blank:
        print(f"  ⚠️ 缺中文释义（请到 FlowUs 补齐后再同步）：{'、'.join(blank)}")

    if args.dry_run:
        print("\n--dry-run：未写入文件")
        return

    WORDS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with WORDS_FILE.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"\n已写入 {WORDS_FILE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
