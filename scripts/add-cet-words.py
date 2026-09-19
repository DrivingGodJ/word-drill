#!/usr/bin/env python3
"""四六级自动补词：词库里的新词不够时，从四六级词书挑几个补进 data/words.json。

用法：
    python3 scripts/add-cet-words.py                 # 正式运行（自动判断、自动提交）
    python3 scripts/add-cet-words.py --dry-run       # 只看会补哪些词，不写任何东西
    python3 scripts/add-cet-words.py --force         # 跳过「词不够」判断（仍受每周配额限制）
    python3 scripts/add-cet-words.py --max-add 3     # 这次最多补 3 个

规则：
  * 词源：kajweb/dict 的 CET4/CET6 词书（含中文释义、词性、配对例句），下载后缓存在
    scripts/.cache-cet/（已 gitignore），只需下载一次。
  * 触发：词库里「还没开始学」的词 < MIN_FRESH 才补；补到 TARGET_FRESH 为止。
  * 配额：**滚动 7 天内最多加 7 个**，记在 scripts/cet-state.json（随仓库提交，可审计）。
  * 提交：先 `git pull --ff-only` 同步远端，改完本地两个文件后一次性 commit + push，
    GitHub Pages 会自动重新部署（词库走 network-first 缓存策略，无需 bump SW）。
  * 与 sync-from-flowus.py 互不干扰：那个脚本默认是合并语义，不会删掉这里加的词。

依赖：gh（GitHub CLI，用登录账号调 worddrill-data 私有仓库读进度，不需要额外 token）。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORDS_FILE = ROOT / "data" / "words.json"
STATE_FILE = ROOT / "scripts" / "cet-state.json"
CACHE_DIR = ROOT / "scripts" / ".cache-cet"
GIT_DIR = ROOT

DICT_REPO = "kajweb/dict"                 # 词书来源（公开仓库）
PROGRESS_REPO = "DrivingGodJ/worddrill-data"   # 学习进度（私有仓库）
PROGRESS_FILE = "progress.json"

WEEKLY_LIMIT = 7                          # 滚动 7 天最多加的生词数
WINDOW_DAYS = 7
MIN_FRESH = 15                            # 未开始的词少于这个数才触发
TARGET_FRESH = 30                         # 一次补到这个数为止（再叠加配额上限）
BOOKS = ("CET4", "CET6")                  # 候选词书：先四级后六级
# 「默认已掌握」词书：小学+初中+高中（人教等教材词表），四级候选先把这些排除掉
KNOWN_PATTERN = r"^\d+_((PEP)?(GaoZhong|ChuZhong)|PEPXiaoXue\d)_\d+\.zip$"

RE_CET = re.compile(r"^\d+_CET[46](?:luan)?_\d+\.zip$", re.IGNORECASE)
RE_KNOWN = re.compile(KNOWN_PATTERN, re.IGNORECASE)


# ---------------------------------------------------------------- gh / git ---

def gh(*args: str, allow_404: bool = False) -> str | None:
    """调 gh api，返回 stdout；allow_404 时 404 返回 None，其它错误直接退出。"""
    proc = subprocess.run(["gh", "api", *args], capture_output=True, text=True)
    if proc.returncode == 0:
        return proc.stdout
    if allow_404 and "404" in proc.stderr and "Not Found" in proc.stderr:
        return None
    sys.exit(f"gh api 调用失败（{' '.join(args[:4])}）：{proc.stderr.strip()[:300]}")


def gh_bytes(*args: str) -> bytes:
    """调 gh api 拿原始字节（下载 zip 用，不能用 text 模式）。"""
    proc = subprocess.run(["gh", "api", *args], capture_output=True)
    if proc.returncode != 0:
        sys.exit(f"gh api 调用失败（{' '.join(args[:4])}）：{proc.stderr.decode('utf-8', 'replace')[:300]}")
    return proc.stdout


def git(*args: str) -> str:
    proc = subprocess.run(["git", "-C", str(GIT_DIR), *args], capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"git {' '.join(args)} 失败：{proc.stderr.strip()[:300]}")
    return proc.stdout


def sync_repo() -> None:
    """先把本地工作副本拉到远端最新（失败只警告：大概率只是没网/没改动）。"""
    if subprocess.run(["git", "-C", str(GIT_DIR), "pull", "--ff-only", "-q"],
                      capture_output=True, text=True).returncode != 0:
        print("⚠️ git pull --ff-only 失败，继续用本地工作副本（提交时若冲突会再报错）")


# ------------------------------------------------------------------ 词书源 ---

def book_zip(book_hint: str) -> Path:
    """按书名前缀（CET4/CET6）找一个已缓存的 zip。"""
    for p in sorted(CACHE_DIR.glob("*.zip")):
        if re.match(rf"^\d+_{book_hint}(?:luan)?_\d+\.zip$", p.name, re.IGNORECASE):
            return p
    raise FileNotFoundError(f"缓存里没有 {book_hint} 的词书 zip")


def download_books(pattern: str) -> list[Path]:
    """按正则下载词书 zip（只下缺的），返回本地路径列表。"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    listing = json.loads(gh(f"repos/{DICT_REPO}/contents/book"))
    wanted = [it for it in listing if re.match(pattern, it["name"], re.IGNORECASE)]
    if not wanted:
        sys.exit(f"{DICT_REPO}/book 里没找到匹配 {pattern} 的词书 zip")
    paths: list[Path] = []
    for it in sorted(wanted, key=lambda x: x["name"]):
        dest = CACHE_DIR / it["name"]
        if dest.exists() and dest.stat().st_size == it["size"]:
            paths.append(dest)
            continue
        print(f"下载词书 {it['name']}（{it['size'] // 1024} KB，只需一次）...")
        raw = gh_bytes("-H", "Accept: application/vnd.github.raw",
                       f"repos/{DICT_REPO}/contents/book/{it['name']}")
        dest.write_bytes(raw)
        paths.append(dest)
    return paths


def load_book(zip_path: Path) -> list[dict]:
    """zip 里的 JSON 是「一行一条」的 JSONL，解析成词条列表。"""
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


def pick_sentence(entry: dict) -> tuple[str, str] | None:
    """挑一条包含词头的中英例句；同长度优先短的（更易读）。"""
    head = entry["headWord"].lower()
    sents = entry.get("content", {}).get("word", {}).get("content", {}) \
                 .get("sentence", {}).get("sentences", []) or []
    hits = [s for s in sents
            if s.get("sContent") and s.get("sCn")
            and re.search(rf"\b{re.escape(head)}\b", s["sContent"], re.IGNORECASE)]
    if not hits:
        return None
    best = min(hits, key=lambda s: len(s["sContent"]))
    return best["sContent"].strip(), best["sCn"].strip()


def format_pos(trans: list[dict]) -> str:
    """'n'+'v' -> 'n./v.'；'v & n' 也拆开。"""
    parts: list[str] = []
    for t in trans:
        for p in re.split(r"&|/", t.get("pos", "")):
            p = p.strip()
            if p and f"{p}." not in parts:
                parts.append(f"{p}.")
    return "/".join(parts)


def format_meaning(trans: list[dict]) -> str:
    seen: list[str] = []
    for t in trans:
        cn = (t.get("tranCn") or "").strip()
        if cn and cn not in seen:
            seen.append(cn)
    return "；".join(seen[:3])


def to_worddrill_entry(entry: dict, level: str) -> dict | None:
    """词书词条 -> WordDrill 词库格式。缺例句/释义的直接放弃，宁缺毋滥。"""
    word = (entry.get("headWord") or "").strip()
    if not word:
        return None
    sent = pick_sentence(entry)
    if not sent:
        return None
    trans = entry.get("content", {}).get("word", {}).get("content", {}).get("trans", []) or []
    meaning = format_meaning(trans)
    if not meaning:
        return None
    slug = re.sub(r"[^a-z0-9]+", "-", word.lower()).strip("-")
    example, example_zh = sent
    return {
        "id": slug,
        "word": word,
        "pos": format_pos(trans),
        "meaning": meaning,
        "example": example,
        "exampleZh": example_zh,
        "collocations": [],
        "tags": [level],
    }


def load_headwords(zip_paths: list[Path]) -> set[str]:
    """只取词头集合（排除表用，不需要例句释义）。"""
    out: set[str] = set()
    for zp in zip_paths:
        for raw in load_book(zp):
            head = (raw.get("headWord") or "").strip().lower()
            if head:
                out.add(head)
    return out


def build_candidates() -> list[dict]:
    """四级优先、六级在后，按词头去重，并排除中小学教材里已有的词。"""
    excluded = load_headwords(download_books(KNOWN_PATTERN))
    print(f"中小学词表共 {len(excluded)} 个词（默认已掌握，不重复进词库）")

    seen: set[str] = set()
    out: list[dict] = []
    for level in BOOKS:
        cet_pattern = rf"^\d+_{level}(?:luan)?_\d+\.zip$"
        for zp in download_books(cet_pattern):
            for raw in load_book(zp):
                head = (raw.get("headWord") or "").strip().lower()
                if not head or head in seen or head in excluded or len(head) < 3:
                    continue
                seen.add(head)
                item = to_worddrill_entry(raw, level)
                if item:
                    out.append(item)
    return out


# -------------------------------------------------------------------- 状态 ---

def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {"added": []}


def quota_left(state: dict) -> tuple[int, int]:
    """返回（剩余配额，最近 7 天已用）。"""
    now = datetime.now(timezone.utc)
    used = 0
    for it in state.get("added", []):
        try:
            at = datetime.fromisoformat(it["at"])
        except (KeyError, ValueError):
            continue
        if now - at <= timedelta(days=WINDOW_DAYS):
            used += 1
    return max(0, WEEKLY_LIMIT - used), used


# --------------------------------------------------------------------- 主流程

def main() -> None:
    ap = argparse.ArgumentParser(description="四六级自动补词")
    ap.add_argument("--dry-run", action="store_true", help="只显示会补哪些词，不写不提交")
    ap.add_argument("--force", action="store_true", help="跳过「词不够」判断（配额仍然生效）")
    ap.add_argument("--min-fresh", type=int, default=MIN_FRESH)
    ap.add_argument("--target", type=int, default=TARGET_FRESH)
    ap.add_argument("--max-add", type=int, default=WEEKLY_LIMIT)
    args = ap.parse_args()

    sync_repo()

    data = json.loads(WORDS_FILE.read_text(encoding="utf-8"))
    words: list[dict] = data.get("words", [])

    # 已开始学的词：读私有仓库里的进度（404 视为全新开始）
    raw_progress = gh(f"repos/{PROGRESS_REPO}/contents/{PROGRESS_FILE}", allow_404=True)
    started: set[str] = set()
    if raw_progress:
        payload = json.loads(raw_progress)
        progress = json.loads(__import__("base64").b64decode(payload["content"]))
        started = set(progress.get("words", {}).keys())
    known = {w["word"].lower() for w in words}

    fresh = [w for w in words if w["id"] not in started]
    print(f"词库 {len(words)} 个词，其中还没开始学的 {len(fresh)} 个（阈值 {args.min_fresh}）")

    left, used = quota_left(load_state())
    print(f"本周滚动 7 天配额：已用 {used}/{WEEKLY_LIMIT}，剩 {left}")

    if len(fresh) >= args.min_fresh and not args.force:
        print("词库还够，不添加。")
        return

    need = min(args.max_add, left, max(0, args.target - len(fresh)) or args.max_add)
    if args.force and need == 0:
        need = min(args.max_add, left)
    if need <= 0:
        print("本周配额已用完，不添加。")
        return

    print(f"开始挑 {need} 个新词（四级优先）...")
    taken: list[dict] = []
    for item in build_candidates():
        if len(taken) >= need:
            break
        if item["word"].lower() in known:
            continue
        taken.append(item)
    if not taken:
        sys.exit("词书里挑不出可用的新词（都有例句/释义过滤），检查词书数据。")

    for item in taken:
        known.add(item["word"].lower())
        words.append(item)
    words.sort(key=lambda w: w["word"].lower())
    data["words"] = words
    data.setdefault("meta", {})
    data["meta"]["updated"] = datetime.now().astimezone().date().isoformat()

    state = load_state()
    now_iso = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    state.setdefault("added", []).extend({"word": t["word"], "at": now_iso, "level": t["tags"][0]} for t in taken)
    state["added"] = state["added"][-500:]

    print("将添加：")
    for t in taken:
        print(f"  + {t['word']}  {t['pos']}  {t['meaning']}  [{t['tags'][0]}]")

    if args.dry_run:
        print("\n--dry-run：未写入、未提交。")
        return

    WORDS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    names = "、".join(t["word"] for t in taken)
    git("add", "data/words.json", "scripts/cet-state.json")
    git("commit", "-q", "-m",
        f"chore(dict): 自动补充四六级生词 {len(taken)} 个：{names}")
    push = subprocess.run(["git", "-C", str(GIT_DIR), "push", "-q", "origin", "main"],
                          capture_output=True, text=True)
    if push.returncode != 0:
        git("pull", "--rebase", "-q", "origin", "main")
        git("push", "-q", "origin", "main")
    _, used_after = quota_left(state)
    print(f"\n已提交并推送：新增 {len(taken)} 个词（{names}）")
    print(f"词库 {len(words)} 个词；本周滚动 7 天已用 {used_after}/{WEEKLY_LIMIT}")


if __name__ == "__main__":
    main()
