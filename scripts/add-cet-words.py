#!/usr/bin/env python3
"""四六级补词（两阶段，先确认再入库）：

  阶段一（入库）：读学习进度仓库 progress.json 里的 cet.approved / cet.rejected
      （来自网站上的「四六级候选词」确认卡），把批准的词真正写进 data/words.json，
      受「滚动 7 天最多 7 个」配额限制；被拒的词从此不再出现。
  阶段二（摆候选）：词库里还没开始学的词 < MIN_FRESH 且当前没有待确认的候选时，
      从四六级词书按质量分挑一批（默认 10 个）写进 data/cet-pending.json，
      等用户在网站上勾选确认 —— 脚本绝不自动入库。

用法：
    python3 scripts/add-cet-words.py                     # 两阶段都跑（正常入口）
    python3 scripts/add-cet-words.py --dry-run           # 只看会做什么，不写不提交
    python3 scripts/add-cet-words.py --force             # 跳过「词不够」判断（配额仍生效）
    python3 scripts/add-cet-words.py --decisions-file d.json   # 测试用：用本地 JSON 代替进度仓库

候选词要过两道门槛，都满足才摆出来：
  难度分（词频，用户要求挑难词）：
      词频 5 万表查无此词 +4   25000 名开外 +3   12000 开外 +2   7000 开外 +1
      六级专有词（CET4 词书没有的）再 +1；低于 MIN_DIFFICULTY 的直接不摆，摆出按难度降序。
  质量分（资料丰富度）：
      realExamSentence 真题例句 +3   syno 近义词 +2   relWord 同根词 +1   多词性多义项 +1

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
PENDING_FILE = ROOT / "data" / "cet-pending.json"
STATE_FILE = ROOT / "scripts" / "cet-state.json"
CACHE_DIR = ROOT / "scripts" / ".cache-cet"
GIT_DIR = ROOT

DICT_REPO = "kajweb/dict"                 # 词书来源（公开仓库）
FREQ_REPO = "hermitdave/FrequencyWords"   # 词频表来源（OpenSubtitles 2018）
FREQ_PATH = "content/2018/en/en_50k.txt"  # 英文 5 万高频词（降序），词频排名 = 难度代理
FREQ_CACHE = "en-freq-50k.txt"
PROGRESS_REPO = "DrivingGodJ/worddrill-data"   # 学习进度（私有仓库）
PROGRESS_FILE = "progress.json"

WEEKLY_LIMIT = 7                          # 滚动 7 天最多入库的生词数
WINDOW_DAYS = 7
MIN_FRESH = 15                            # 未开始的词少于这个数才摆新候选
BATCH_SIZE = 10                           # 一批候选词数量（比配额大，留出否决空间）
MIN_DIFFICULTY = 2                        # 候选词最低难度分（词频代理）
MIN_SCORE = 4                             # 候选词最低质量分
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


def quality_score(raw: dict) -> int:
    """词条质量分：真题例句 > 近义词 > 同根词 > 多义项。分低 = 资料单薄，不摆出来。"""
    c = raw.get("content", {}).get("word", {}).get("content", {})
    score = 0
    if c.get("realExamSentence", {}).get("sentences"):
        score += 3          # 有真题例句：来源可靠、难度真实
    if c.get("syno", {}).get("synos"):
        score += 2          # 有近义词辨析
    if c.get("relWord", {}).get("rels"):
        score += 1          # 有同根/派生词
    if len(c.get("trans") or []) >= 2:
        score += 1          # 多词性多义项：值得练
    return score


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


def load_freq_ranks() -> dict[str, int]:
    """英文 5 万高频词表（OpenSubtitles 语料，按出现次数降序），缓存到本地只下一次。
    返回 {词: 频率排名}；表里没有的词视为比第 5 万名还低频（= 难）。"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    dest = CACHE_DIR / FREQ_CACHE
    if not dest.exists():
        print(f"下载词频表 {FREQ_PATH}（只需一次）...")
        raw = gh_bytes("-H", "Accept: application/vnd.github.raw",
                       f"repos/{FREQ_REPO}/contents/{FREQ_PATH}")
        dest.write_bytes(raw)
    ranks: dict[str, int] = {}
    for i, line in enumerate(dest.read_text(encoding="utf-8").splitlines(), 1):
        w = line.split(" ", 1)[0].strip().lower()
        if w and w not in ranks:
            ranks[w] = i
    return ranks


def difficulty_score(word: str, level: str, freq: dict[str, int]) -> int:
    """难度分：词频越低越难（用户要求「词汇的难度要比较高」）。"""
    r = freq.get(word.lower())
    score = 0
    if r is None:
        score += 4          # 5 万高频词表都没有：非常低频
    elif r >= 25000:
        score += 3
    elif r >= 12000:
        score += 2
    elif r >= 7000:
        score += 1
    if level == "CET6":
        score += 1          # 六级专有词（CET4 词书里没有）整体更难
    return score


def build_scored_candidates() -> list[tuple[int, int, dict]]:
    """四级优先、六级在后，按词头去重、排除中小学教材词，返回（难度分, 质量分, 词条）。
    排序：难度降序 > 质量降序 > 字母序，保证结果可复现。"""
    excluded = load_headwords(download_books(KNOWN_PATTERN))
    print(f"中小学词表共 {len(excluded)} 个词（默认已掌握，不重复进词库）")
    freq = load_freq_ranks()
    print(f"词频表 {len(freq)} 个词（越低频越难）")

    # 词书序位是乱序的（书头书尾难度混杂），词性归属只用于打标签：
    # CET4 里有的是四级词，只在 CET6 出现的是六级专有词（更难）
    heads: dict[str, str] = {}
    for level in BOOKS:
        cet_pattern = rf"^\d+_{level}(?:luan)?_\d+\.zip$"
        for zp in download_books(cet_pattern):
            for raw in load_book(zp):
                head = (raw.get("headWord") or "").strip().lower()
                if head and head not in heads:
                    heads[head] = level

    out: list[tuple[int, int, dict]] = []
    seen: set[str] = set()
    for level in BOOKS:
        cet_pattern = rf"^\d+_{level}(?:luan)?_\d+\.zip$"
        for zp in download_books(cet_pattern):
            for raw in load_book(zp):
                head = (raw.get("headWord") or "").strip().lower()
                if not head or head in seen or head in excluded or len(head) < 3:
                    continue
                seen.add(head)
                item = to_worddrill_entry(raw, heads.get(head, level))
                if not item:
                    continue
                diff = difficulty_score(head, heads.get(head, level), freq)
                if diff < MIN_DIFFICULTY:
                    continue
                score = quality_score(raw)
                if score < MIN_SCORE:
                    continue
                out.append((diff, score, item))
    out.sort(key=lambda t: (-t[0], -t[1], t[2]["word"]))
    return out


# -------------------------------------------------------------------- 状态 ---

def load_state() -> dict:
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {"added": [], "rejected": []}


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


def load_decisions(args) -> tuple[list[str], list[str]]:
    """读确认决定：默认从进度仓库 progress.json 的 cet 字段（网站上点的结果，
    随同步跨设备共享）；--decisions-file 时用本地 JSON 代替（测试用）。"""
    if args.decisions_file:
        d = json.loads(Path(args.decisions_file).read_text(encoding="utf-8"))
        return list(d.get("approved") or []), list(d.get("rejected") or [])
    raw = gh(f"repos/{PROGRESS_REPO}/contents/{PROGRESS_FILE}", allow_404=True)
    if not raw:
        return [], []
    payload = json.loads(raw)
    progress = json.loads(__import__("base64").b64decode(payload["content"]))
    cet = progress.get("cet") or {}
    return list(cet.get("approved") or []), list(cet.get("rejected") or [])


def load_pending() -> list[dict]:
    if not PENDING_FILE.exists():
        return []
    try:
        data = json.loads(PENDING_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    return [w for w in (data.get("words") or []) if w and w.get("id")]


def write_pending(words: list[dict], dry: bool = False) -> None:
    if dry:
        return
    if words:
        PENDING_FILE.write_text(
            json.dumps({"updated": datetime.now().astimezone().date().isoformat(),
                        "words": words}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8")
    elif PENDING_FILE.exists():
        PENDING_FILE.unlink()   # 全都决定了就删掉，网站上也不再出卡片


def commit_and_push(message: str) -> None:
    git("add", "data/words.json", "data/cet-pending.json", "scripts/cet-state.json")
    git("commit", "-q", "-m", message)
    push = subprocess.run(["git", "-C", str(GIT_DIR), "push", "-q", "origin", "main"],
                          capture_output=True, text=True)
    if push.returncode != 0:
        git("pull", "--rebase", "-q", "origin", "main")
        git("push", "-q", "origin", "main")


# --------------------------------------------------------------------- 主流程

def main() -> None:
    ap = argparse.ArgumentParser(description="四六级补词（先确认再入库）")
    ap.add_argument("--dry-run", action="store_true", help="只显示会做什么，不写不提交")
    ap.add_argument("--force", action="store_true", help="跳过「词不够」判断（配额仍生效）")
    ap.add_argument("--min-fresh", type=int, default=MIN_FRESH)
    ap.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    ap.add_argument("--decisions-file", help="测试用：用本地 JSON {approved:[], rejected:[]} 代替进度仓库")
    args = ap.parse_args()

    sync_repo()

    data = json.loads(WORDS_FILE.read_text(encoding="utf-8"))
    words: list[dict] = data.get("words", [])
    known_words = {w["word"].lower() for w in words}
    known_ids = {w["id"] for w in words}

    # 已开始学的词：读私有仓库里的进度（404 视为全新开始）
    raw_progress = gh(f"repos/{PROGRESS_REPO}/contents/{PROGRESS_FILE}", allow_404=True)
    started: set[str] = set()
    if raw_progress and not args.decisions_file:
        payload = json.loads(raw_progress)
        progress = json.loads(__import__("base64").b64decode(payload["content"]))
        started = set(progress.get("words", {}).keys())

    approved, rejected = load_decisions(args)
    state = load_state()
    # 历史被拒的词永久排除，之后不再摆出来
    state.setdefault("rejected", [])
    for rid in rejected:
        if rid not in state["rejected"]:
            state["rejected"].append(rid)

    fresh = [w for w in words if w["id"] not in started]
    left, used = quota_left(state)
    print(f"词库 {len(words)} 个词，还没开始学的 {len(fresh)} 个（阈值 {args.min_fresh}）；"
          f"滚动 7 天配额已用 {used}/{WEEKLY_LIMIT}，剩 {left}")

    changed = False
    added_names: list[str] = []
    staged = False

    # ---------- 阶段一：把用户批准的候选词真正入库（受配额限制） ----------
    pending = load_pending()
    if pending:
        by_id = {w["id"]: w for w in pending}
        to_add = [by_id[i] for i in approved if i in by_id
                  and i not in known_ids and by_id[i]["word"].lower() not in known_words]
        take = to_add[:left]
        if take:
            for item in take:
                known_words.add(item["word"].lower())
                known_ids.add(item["id"])
                words.append(item)
            words.sort(key=lambda w: w["word"].lower())
            data["words"] = words
            data.setdefault("meta", {})
            data["meta"]["updated"] = datetime.now().astimezone().date().isoformat()
            now_iso = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
            state.setdefault("added", []).extend(
                {"word": t["word"], "at": now_iso, "level": t["tags"][0]} for t in take)
            state["added"] = state["added"][-500:]
            changed = True
            added_names = [t["word"] for t in take]
            print(f"\n阶段一 · 入库 {len(take)} 个（你在网站上批准的）：")
            for t in take:
                print(f"  + {t['word']}  {t['pos']}  {t['meaning']}  [{t['tags'][0]}]")
            if len(to_add) > len(take):
                print(f"  （还有 {len(to_add) - len(take)} 个批准的词因配额用完，下周再入库）")
        else:
            print("\n阶段一 · 没有待入库的批准词")

        # 决定完的词移出候选列表；因配额没入库的留着下周再入
        decided = set(approved) | set(rejected)
        quota_blocked = {i["id"] for i in to_add[len(take):]}
        remaining = [w for w in pending
                     if w["id"] not in decided or w["id"] in quota_blocked]
        write_pending(remaining, dry=args.dry_run)
        changed = True
        print(f"候选词剩 {len(remaining)} 个待确认")
    else:
        print("\n阶段一 · 当前没有待确认的候选词")

    # ---------- 阶段二：词不够且没有待确认候选时，摆出新一批候选词 ----------
    fresh = [w for w in words if w["id"] not in started]
    still_pending = load_pending()
    if still_pending:
        print("阶段二 · 还有候选词等你确认，不摆新的一批")
    elif len(fresh) < args.min_fresh or args.force:
        print(f"\n阶段二 · 摆出新候选词（难度 ≥ {MIN_DIFFICULTY}、质量 ≥ {MIN_SCORE}，按难度降序）...")
        excluded_ids = known_ids | set(state.get("rejected", [])) | set(rejected)
        taken: list[tuple[int, int, dict]] = []
        for diff, score, item in build_scored_candidates():
            if len(taken) >= args.batch_size:
                break
            if item["id"] in excluded_ids or item["word"].lower() in known_words:
                continue
            taken.append((diff, score, item))
        if not taken:
            sys.exit("词书里挑不出够难度/质量的新词（词频/例句/释义过滤），检查词书数据。")
        print("候选词：")
        staged_words = []
        for diff, score, t in taken:
            t["score"] = score
            t["difficulty"] = diff
            staged_words.append(t)
            print(f"  ? {t['word']}  {t['pos']}  {t['meaning']}  [{t['tags'][0]}] 难度={diff} 质量={score}")
        write_pending(staged_words, dry=args.dry_run)
        staged = True
        changed = True
    else:
        print("阶段二 · 词库还够，不摆新候选")

    if not changed:
        print("\n没有需要提交的改动。")
        return
    if args.dry_run:
        print("\n--dry-run：未写入、未提交。")
        return

    # ⚠️ 入库的词必须写回 words.json —— 曾漏掉这一步，导致「打印了入库、文件没变」
    if added_names:
        WORDS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                              encoding="utf-8")
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if added_names:
        msg = f"chore(dict): 确认入库四六级生词 {len(added_names)} 个：{'、'.join(added_names)}"
    elif staged:
        msg = "chore(dict): 摆出四六级候选词待确认（网站上勾选后才会入库）"
    else:
        msg = "chore(dict): 更新候选词列表"
    commit_and_push(msg)
    _, used_after = quota_left(state)
    print(f"\n已提交并推送；本周滚动 7 天配额已用 {used_after}/{WEEKLY_LIMIT}")


if __name__ == "__main__":
    main()
