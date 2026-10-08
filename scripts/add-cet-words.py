#!/usr/bin/env python3
"""四六级补词：候选确认后按学习余量入库；7 个是参考量，48 小时最多 14 个。

python3 scripts/add-cet-words.py --dry-run
python3 scripts/add-cet-words.py --no-commit --progress-file progress.json
python3 scripts/add-cet-words.py --repo /path/to/clean/main/checkout

只挑有词性、中文释义、完整中英例句和带日期的真题收录记录的难词。
词频是难度代理；优先真题相关性和实际展示的资料，不让缺词频的词排第一。
--force 只跳过候选储备判断，不跳过入库配额、确认或未学词储备上限。
依赖 Python 标准库和已登录的 gh；无需模型或额外 token。
"""
from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import math
import re
import subprocess
import sys
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORDS_FILE = ROOT / 'data/words.json'
PENDING_FILE = ROOT / 'data/cet-pending.json'
STATE_FILE = ROOT / 'scripts/cet-state.json'
CACHE_DIR = ROOT / 'scripts/.cache-cet'
DICT_REPO = 'kajweb/dict'
FREQ_REPO = 'hermitdave/FrequencyWords'
FREQ_PATH = 'content/2018/en/en_50k.txt'
PROGRESS_REPO = 'DrivingGodJ/worddrill-data'
PROGRESS_FILE = 'progress.json'
WINDOW_DAYS, LIMIT, MIN_FRESH, BATCH_SIZE = 2, 7, 15, 10
MAX_SUPPLY = 14
MIN_DIFFICULTY, MIN_SCORE = 3, 5
BOOKS = ('CET4', 'CET6')
# 过滤小学/初中基础词，不推断用户已掌握所有高中词。
KNOWN_PATTERN = r'^\d+_((PEP)?ChuZhong|PEPXiaoXue\d)_\d+\.zip$'
# 这两个旧候选已获批准，但词书只有短语；编辑补成句子，并明确标为项目例句。
EDITED_EXAMPLES = {
    'prevalent': ('The belief in astrology is prevalent in some communities.', '对占星术的信仰在一些群体中很普遍。'),
    'proficient': ('He is a proficient typist who rarely makes mistakes.', '他是一名熟练的打字员，很少出错。'),
}


def gh(endpoint: str, allow_404: bool = False) -> str:
    p = subprocess.run(['gh', 'api', endpoint], capture_output=True, text=True)
    if p.returncode:
        if allow_404 and '(HTTP 404)' in p.stderr:
            return ''
        sys.exit(f'GitHub 读取失败：{p.stderr.strip()[:300]}')
    return p.stdout


def git(*args: str) -> str:
    p = subprocess.run(['git', '-C', str(ROOT), *args], capture_output=True, text=True)
    if p.returncode:
        sys.exit(f"git {' '.join(args)} 失败：{p.stderr.strip()[:300]}")
    return p.stdout


def sync_repo() -> None:
    if git('branch', '--show-current').strip() != 'main':
        sys.exit('自动补词只能在 main 发布；开发预演请用 --dry-run 或 --no-commit。')
    if git('remote', 'get-url', 'origin').strip() not in (
            'https://github.com/DrivingGodJ/word-drill.git', 'git@github.com:DrivingGodJ/word-drill.git'):
        sys.exit('origin 不是 DrivingGodJ/word-drill，停止自动发布。')
    if git('status', '--porcelain').strip():
        sys.exit('工作副本有未提交改动，停止补词，避免顺带发布其它改动。')
    git('pull', '--ff-only', '-q', 'origin', 'main')
    if git('rev-list', '--count', 'origin/main..HEAD').strip() != '0':
        sys.exit('main 有未推送提交，停止补词，请先处理这些提交。')


@lru_cache(maxsize=1)
def book_index() -> list[dict]:
    return json.loads(gh(f'repos/{DICT_REPO}/contents/book'))


def download_books(pattern: str) -> list[Path]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    wanted = [it for it in book_index() if re.match(pattern, it['name'], re.IGNORECASE)]
    if not wanted:
        sys.exit(f'词书源没有匹配 {pattern} 的词书，停止补词。')
    paths = []
    for it in sorted(wanted, key=lambda x: x['name']):
        dest = CACHE_DIR / it['name']
        def matches(raw: bytes) -> bool:
            return hashlib.sha1(f'blob {len(raw)}\0'.encode() + raw).hexdigest() == it['sha']
        if not dest.exists() or not matches(dest.read_bytes()):
            print(f"下载并校验词书 {it['name']}...")
            with urllib.request.urlopen(f"https://raw.githubusercontent.com/{DICT_REPO}/master/book/{it['name']}", timeout=45) as res:
                raw = res.read()
            if not matches(raw):
                sys.exit(f"词书 {it['name']} 校验失败，未修改词库，请稍后重试。")
            dest.write_bytes(raw)
        paths.append(dest)
    return paths


@lru_cache(maxsize=None)
def load_book(path: Path) -> list[dict]:
    rows = []
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if name.endswith('.json'):
                rows.extend(json.loads(line) for line in z.read(name).decode('utf-8').splitlines() if line.strip())
    if not rows:
        sys.exit(f'词书 {path.name} 无词条，停止补词。')
    return rows


def contains_head(text: str, head: str) -> bool:
    return bool(re.search(rf'(?<![a-z]){re.escape(head)}(?![a-z])', text, re.IGNORECASE))


def complete_sentence(text: str, head: str) -> bool:
    # ponytail: 标点/长度过滤不是语法或翻译验证；发现漏网片段时加人工审核。
    return (5 <= len(text.split()) <= 35 and len(text) <= 240
            and bool(re.match(r'^["“\(]?[A-Z]', text))
            and bool(re.search(r'[.!?]["”\)]?$', text))
            and not re.search(r'\.{2,}|…|_{2,}|<[^>]+>', text)
            and contains_head(text, head))


def chinese(text: str) -> bool:
    return bool(re.search(r'[\u4e00-\u9fff]', text))


def content(raw: dict) -> dict:
    return raw.get('content', {}).get('word', {}).get('content', {})


def quality_score(item: dict) -> int:
    return (3 + bool(item.get('pos')) + min(2, len(item.get('collocations', [])))
            + bool(item.get('phonetic')) + bool(item.get('selection', {}).get('examSources')))


def to_worddrill_entry(raw: dict, level: str) -> dict | None:
    head = (raw.get('headWord') or '').strip()
    c = content(raw)
    hits = [s for s in c.get('sentence', {}).get('sentences', []) or []
            if complete_sentence(s.get('sContent', '').strip(), head)
            and chinese(s.get('sCn', ''))]
    edited = not hits and head.lower() in EDITED_EXAMPLES
    if edited:
        en, zh = EDITED_EXAMPLES[head.lower()]
        hits = [{'sContent': en, 'sCn': zh}]
    trans = c.get('trans') or []
    meaning = '；'.join(dict.fromkeys(t.get('tranCn', '').strip() for t in trans if t.get('tranCn', '').strip()))
    pos = '/'.join(dict.fromkeys(p.strip().rstrip('.') + '.' for t in trans
                               for p in re.split(r'&|/', t.get('pos', '')) if p.strip()))
    if not head or not hits or not pos or not chinese(meaning):
        return None
    sent = min(hits, key=lambda s: len(s['sContent']))
    return {'id': re.sub(r'[^a-z0-9]+', '-', head.lower()).strip('-'), 'word': head, 'pos': pos,
            'meaning': meaning, 'example': sent['sContent'].strip(), 'exampleZh': sent['sCn'].strip(),
            'collocations': [f"{p['pContent'].strip()}（{p['pCn'].strip()}）"
                             for p in c.get('phrase', {}).get('phrases', []) or []
                             if p.get('pContent') and chinese(p.get('pCn', ''))
                             and contains_head(p['pContent'], head)][:3],
            'phonetic': (c.get('ukphone') or c.get('usphone') or '').strip(), 'tags': [level],
            'exampleSource': '本项目编辑补全（非真题）' if edited else '词书配对例句（非真题）'}


def exam_sources(entries: list[dict], head: str) -> list[str]:
    sources = set()
    for raw in entries:
        for exam in content(raw).get('realExamSentence', {}).get('sentences', []) or []:
            info = exam.get('sourceInfo') or {}
            if (info.get('level') in BOOKS and re.fullmatch(r'(?:19|20)\d{2}\.(?:6|12)', info.get('year', ''))
                    and contains_head(exam.get('sContent', ''), head)):
                sources.add(' · '.join(str(info[k]) for k in ('level', 'year', 'paper', 'type') if info.get(k)))
    return sorted(sources, reverse=True)


def load_freq_ranks() -> dict[str, int]:
    path = CACHE_DIR / 'en-freq-50k.txt'
    if not path.exists():
        with urllib.request.urlopen(f'https://raw.githubusercontent.com/{FREQ_REPO}/master/{FREQ_PATH}', timeout=45) as res:
            path.write_bytes(res.read())
    return {line.split()[0].lower(): i for i, line in enumerate(path.read_text().splitlines(), 1) if line.strip()}


def difficulty_score(word: str, level: str, freq: dict[str, int]) -> int:
    rank = freq.get(word.lower())
    # 常见形容词的 -ly 副词不能只因词形低频就被当作难词（例如 wide → widely）。
    if word.endswith('ly'):
        ranks = [r for r in (rank, freq.get(word[:-2]), freq.get(word[:-3] + 'y')) if r is not None]
        rank = min(ranks) if ranks else None
    score = 2 if rank is None else 3 if rank >= 25000 else 2 if rank >= 12000 else 1 if rank >= 7000 else 0
    return score + (level == 'CET6')


@lru_cache(maxsize=1)
def cet_entries() -> dict[str, list[tuple[str, dict]]]:
    heads: dict[str, list[tuple[str, dict]]] = {}
    for level in BOOKS:
        for path in download_books(rf'^\d+_{level}(?:luan)?_\d+\.zip$'):
            for raw in load_book(path):
                head = (raw.get('headWord') or '').strip().lower()
                if len(head) >= 3:
                    heads.setdefault(head, []).append((level, raw))
    return heads


def source_item(head: str, entries: list[tuple[str, dict]]) -> dict | None:
    level = 'CET4' if any(l == 'CET4' for l, _ in entries) else 'CET6'
    sources = exam_sources([r for _, r in entries], head)
    usable = [(r, to_worddrill_entry(r, level)) for _, r in entries]
    usable = [(r, item) for r, item in usable if item]
    if not sources or not usable:
        return None
    # 同质量优先有英释的版本，再选 _3 词书；避免先读到缺英释的错标词性版本。
    _, item = max(usable, key=lambda pair: (quality_score(pair[1]),
                   any(t.get('tranOther') for t in content(pair[0]).get('trans', [])),
                   pair[0].get('bookId', '').endswith('_3')))
    item['selection'] = {'version': 2, 'source': DICT_REPO,
                         'books': sorted({r.get('bookId', '') for _, r in entries} - {''}),
                         'examSources': sources}
    item['score'] = quality_score(item)
    return item


def build_scored_candidates() -> list[tuple[int, int, dict]]:
    excluded = {r.get('headWord', '').lower() for p in download_books(KNOWN_PATTERN) for r in load_book(p)}
    freq = load_freq_ranks()
    out = []
    for head, entries in cet_entries().items():
        if head in excluded:
            continue
        level = 'CET4' if any(l == 'CET4' for l, _ in entries) else 'CET6'
        diff = difficulty_score(head, level, freq)
        if diff < MIN_DIFFICULTY:
            continue
        item = source_item(head, entries)
        if not item:
            continue
        item['selection']['frequencyRank'] = freq.get(head)
        score = quality_score(item)
        if score >= MIN_SCORE:
            item.update(score=score, difficulty=diff)
            out.append((diff, score, item))
    # 真题记录不是完整考试词频；同一篇的多个片段合并，不让重复片段抬高分数。
    out.sort(key=lambda t: (-min(8, len(t[2]['selection']['examSources'])), -t[1], abs(t[0] - 3),
                           hashlib.sha256(t[2]['id'].encode()).hexdigest()))
    print(f'基础词排除 {len(excluded)} 个，通过门槛 {len(out)} 个（资料质量优先，词频仅作难度代理）')
    return out


def upgrade_pending(pending: list[dict]) -> None:
    """补齐旧候选资料；保留 ID、词头、释义、词性、取舍决定。"""
    for item in pending:
        if item.get('selection', {}).get('version') == 2:
            continue
        head = item['word'].lower()
        replacement = source_item(head, cet_entries().get(head, []))
        if replacement:
            for k in ('example', 'exampleZh', 'collocations', 'phonetic', 'exampleSource', 'selection', 'score'):
                item[k] = replacement[k]
            print(f'补齐旧候选资料：{item["word"]}（原决定保留）')


def load_json(path: Path, fallback=None):
    if not path.exists() and fallback is not None:
        return fallback
    return json.loads(path.read_text(encoding='utf-8'))


def ids(value, label: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(v, str) or not v for v in value):
        raise ValueError(f'{label} 必须是非空字符串数组；停止补词，未修改词库。')
    return list(dict.fromkeys(value))


def load_progress(args) -> dict:
    if args.progress_file:
        progress = load_json(Path(args.progress_file))
    elif args.decisions_file:
        progress = {'words': {}, 'cet': load_json(Path(args.decisions_file))}
    else:
        raw = gh(f'repos/{PROGRESS_REPO}/contents/{PROGRESS_FILE}', allow_404=True)
        # 缺进度不能推断所有词未开始，更不能据此继续自动扩库。
        if not raw:
            raise ValueError('没有读到私有学习进度，停止补词；未修改任何数据。')
        progress = json.loads(base64.b64decode(json.loads(raw)['content']))
    if not isinstance(progress, dict) or not isinstance(progress.get('words'), dict):
        raise ValueError('学习进度格式错误，停止补词。')
    if any(not isinstance(p, dict) for p in progress['words'].values()):
        raise ValueError('学习记录格式错误，停止补词。')
    cet = progress.get('cet', {})
    if not isinstance(cet, dict):
        raise ValueError('候选确认格式错误，停止补词。')
    progress['cet'] = {k: ids(cet.get(k, []), k) for k in ('approved', 'rejected')}
    return progress


def quota_left(state: dict, at: datetime | None = None, limit=LIMIT) -> tuple[int, int]:
    cutoff = (at or datetime.now(timezone.utc)) - timedelta(days=WINDOW_DAYS)
    # 恰好满 48 小时的记录已过期；异常时间停止，不能悄悄丢掉占用的配额。
    times = [datetime.fromisoformat(it['at']) for it in state.get('added', [])]
    if any(t.tzinfo is None for t in times):
        raise ValueError('补词历史时间缺少时区，停止补词。')
    used = sum(t > cutoff for t in times)
    return max(0, limit - used), used


def supply_limits(words: list[dict], progress: dict, at: datetime, reserve_cap=MIN_FRESH) -> tuple[int, int, str]:
    """用已记录的数据控制补词余量；旧存档不伪造学习速度，先用参考量。"""
    timestamp = at.timestamp() * 1000
    day = 86400000
    records = [progress['words'][w['id']] for w in words if w['id'] in progress['words']]
    started = [p for p in records if p.get('stage', 'new') != 'new' or p.get('introducedAt', 0) or p.get('correct', 0) or p.get('wrong', 0)]
    last = max((p.get('lastSeen', 0) for p in started), default=0)
    late = sum(0 < p.get('due', 0) < timestamp - day for p in started)
    # ponytail: 30%/至少10词的积压线是保护阈值，不是经个人实验校准的最优参数。
    if started and late >= max(10, math.ceil(len(started) * .3)):
        return 0, min(3, reserve_cap), f'{late} 个词逾期超过一天，先消化复习'
    if last and last < timestamp - 7 * day:
        return 0, min(3, reserve_cap), '超过一周未学习，先消化现有词'
    introduced = [p['introducedAt'] for p in records if timestamp - 7 * day <= p.get('introducedAt', 0) <= timestamp and p.get('introducedAt', 0)]
    days = {datetime.fromtimestamp(t / 1000).astimezone().date() for t in introduced}
    limit, reason = LIMIT, '新词时间记录不足，先用 7 个参考量'
    if len(introduced) >= 6 and len(days) >= 3:
        span = min(7, max(3, math.floor((timestamp - min(introduced)) / day) + 1))
        rate = len(introduced) / span
        limit = min(MAX_SUPPLY, max(3, math.ceil(rate * WINDOW_DAYS)))
        reason = f'近 {span} 天开始 {len(introduced)} 个新词，按实际节奏调整'
    daily_limit = max(0, int(progress.get('settings', {}).get('newLimit', 10)))
    limit = min(limit, daily_limit * WINDOW_DAYS)
    # 准备约三天的新词储备，最多15个；不再逢日期就把固定数量塞进词库。
    reserve = min(reserve_cap, max(3, math.ceil(limit * 1.5)))
    return limit, reserve, reason


def eligible(item: dict) -> bool:
    return (all(isinstance(item.get(k), str) and item[k].strip() for k in ('id', 'word', 'pos', 'meaning', 'example', 'exampleZh'))
            and complete_sentence(item['example'], item['word']) and chinese(item['meaning']) and chinese(item['exampleZh'])
            and isinstance(item.get('collocations', []), list)
            and bool(item.get('selection', {}).get('examSources')))


def plan_update(data: dict, pending: list[dict], state: dict, progress: dict,
                min_fresh=MIN_FRESH, batch_size=BATCH_SIZE, force=False, at=None) -> tuple[list[dict], list[str]]:
    at = at or datetime.now(timezone.utc)
    words = data['words']
    known_ids = {w['id'] for w in words}
    known_words = {w['word'].lower() for w in words}
    # 页面可能为未学词预建 stage=new 的记录；只有真实开始过才算已学。
    started = {i for i, p in progress['words'].items()
               if p.get('stage', 'new') != 'new' or p.get('introducedAt', 0) or p.get('correct', 0) or p.get('wrong', 0)}
    rejected = set(ids(state.get('rejected', []), '历史拒绝')) | set(progress['cet']['rejected'])
    state['rejected'] = sorted(rejected)
    approved = progress['cet']['approved']
    upgrade_pending(pending)
    fresh = sum(w['id'] not in started for w in words)
    limit, reserve, reason = supply_limits(words, progress, at, min_fresh)
    left, used = quota_left(state, at, limit)
    room = max(0, reserve - fresh)
    print(f'词库 {len(words)}，未开始 {fresh}/{reserve}；48 小时已入库 {used}，当前额度 {limit}，剩 {left}；{reason}')
    by_id = {w['id']: w for w in pending}
    candidates = [by_id[i] for i in dict.fromkeys(approved)
                  if i in by_id and i not in rejected and i not in known_ids and by_id[i]['word'].lower() not in known_words]
    # 未通过新门槛的旧候选保留，不能把用户已批准的词悄悄换成别的词。
    valid = [w for w in candidates if eligible(w)]
    invalid = len(candidates) - len(valid)
    if invalid:
        print(f'有 {invalid} 个旧候选资料不完整，保留原候选和决定，待补齐例句/来源后入库。')
    take = valid[:min(left, room)]
    added = []
    for item in take:
        if item['id'] in known_ids or item['word'].lower() in known_words:
            continue
        words.append(item)
        known_ids.add(item['id']); known_words.add(item['word'].lower())
        state.setdefault('added', []).append({'word': item['word'], 'at': at.astimezone().isoformat(timespec='seconds'), 'level': item['tags'][0]})
        added.append(item['word'])
        print(f"入库：{item['word']} {item['pos']} {item['meaning']}")
    if added:
        words.sort(key=lambda w: w['word'].lower())
        data.setdefault('meta', {})['updated'] = at.astimezone().date().isoformat()
    pending = [w for w in pending if w['id'] not in rejected and w['id'] not in known_ids and w['word'].lower() not in known_words]
    fresh += len(added)
    if len(valid) > len(added):
        print(f'还有 {len(valid)-len(added)} 个已批准词等待配额/储备空间。')
    # 同批部分批准/拒绝后，补到 10 个供选择；已批准但未入库的候选原样保留。
    if (fresh < reserve or force) and len(pending) < batch_size:
        excluded_ids = known_ids | rejected | {w['id'] for w in pending}
        pending_words = {w['word'].lower() for w in pending}
        for _, _, item in build_scored_candidates():
            if len(pending) >= batch_size:
                break
            if item['id'] not in excluded_ids and item['word'].lower() not in known_words | pending_words:
                pending.append(item); excluded_ids.add(item['id']); pending_words.add(item['word'].lower())
                print(f"新候选：{item['word']} {item['pos']} {item['meaning']}")
    return pending, added


def main() -> None:
    global ROOT, WORDS_FILE, PENDING_FILE, STATE_FILE, CACHE_DIR
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--repo', type=Path, default=ROOT, help='词库工作副本（定时任务使用干净的 main）')
    ap.add_argument('--dry-run', action='store_true', help='只预演，不拉取、不改词库、不提交；可更新下载缓存')
    ap.add_argument('--no-commit', action='store_true', help='只写本地文件，不拉取、提交或推送')
    ap.add_argument('--force', action='store_true', help='强制准备候选，仍保留所有入库限制')
    ap.add_argument('--min-fresh', type=int, default=MIN_FRESH)
    ap.add_argument('--batch-size', type=int, default=BATCH_SIZE)
    src = ap.add_mutually_exclusive_group()
    src.add_argument('--progress-file', help='使用本地完整进度，不访问私有仓库')
    src.add_argument('--decisions-file', help='兼容本地 {approved:[], rejected:[]}，未学词数按全新存档计算')
    args = ap.parse_args()
    if args.min_fresh < 1 or not 1 <= args.batch_size <= 50:
        ap.error('min-fresh 必须为正数，batch-size 必须在 1～50 内。')
    if (args.progress_file or args.decisions_file) and not (args.dry_run or args.no_commit):
        ap.error('本地进度只用于预演/本地写入，必须配 --dry-run 或 --no-commit。')
    ROOT = args.repo.expanduser().resolve()
    WORDS_FILE, PENDING_FILE, STATE_FILE, CACHE_DIR = (ROOT / p for p in ('data/words.json', 'data/cet-pending.json', 'scripts/cet-state.json', 'scripts/.cache-cet'))
    if not args.dry_run and not args.no_commit:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        run_lock = (CACHE_DIR / 'run.lock').open('a')
        try:
            fcntl.flock(run_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('已有补词脚本在运行，本次跳过。')
            return
        sync_repo()
    data = load_json(WORDS_FILE)
    state = load_json(STATE_FILE, {'added': [], 'rejected': []})
    pending_data = load_json(PENDING_FILE, {'words': []})
    if not isinstance(data.get('words'), list) or not isinstance(pending_data.get('words'), list):
        raise ValueError('词库或候选格式错误，停止补词。')
    originals = [json.dumps(v, sort_keys=True, ensure_ascii=False) for v in (data, pending_data.get('words', []), state)]
    pending, added = plan_update(data, pending_data['words'], state, load_progress(args),
                                args.min_fresh, args.batch_size, args.force)
    values = [data, pending, state]
    changed = [json.dumps(v, sort_keys=True, ensure_ascii=False) != old for v, old in zip(values, originals)]
    if args.dry_run:
        print('--dry-run：预演完成，未改词库/候选/配额历史，未提交。')
        return
    if not any(changed):
        print('没有需要提交的改动。')
        return
    # 所有读取/筛选完成后才写文件；无变更不改 updated，也不制造空提交。
    for path, value, differs in zip((WORDS_FILE, PENDING_FILE, STATE_FILE), values, changed):
        if differs:
            if path == PENDING_FILE:
                value = {'updated': datetime.now().astimezone().date().isoformat(), 'words': value}
            tmp = path.with_suffix(path.suffix + '.tmp')
            try:
                tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                tmp.replace(path)
            finally:
                tmp.unlink(missing_ok=True)
    if args.no_commit:
        print('--no-commit：已写本地文件，未提交或推送。')
        return
    git('add', 'data/words.json', 'data/cet-pending.json', 'scripts/cet-state.json')
    git('commit', '-q', '-m', f"chore(dict): 四六级补词入库 {len(added)} 个、候选 {len(pending)} 个")
    # 推送失败保留本地提交并退出；不自动 rebase，也不带上其它提交。
    git('push', '-q', 'origin', 'HEAD:main')
    print('已提交并推送词库数据。')


if __name__ == '__main__':
    main()
