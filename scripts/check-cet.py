#!/usr/bin/env python3
"""Run: python3 scripts/check-cet.py (offline, no private reads, no Git writes)."""
import contextlib
import copy
import importlib.util
import io
import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

s = importlib.util.spec_from_file_location('cet', Path(__file__).with_name('add-cet-words.py'))
cet = importlib.util.module_from_spec(s)
s.loader.exec_module(cet)
at = datetime(2026, 10, 8, 4, tzinfo=timezone.utc)
item = {'id': 'proficient', 'word': 'proficient', 'pos': 'adj.', 'meaning': '熟练的',
        'example': 'He is a proficient typist who rarely makes mistakes.', 'exampleZh': '他是一名熟练的打字员，很少出错。',
        'collocations': ['proficient in English'], 'tags': ['CET6'], 'selection': {'version': 2, 'examSources': ['CET6 · 2016.6']}}
# Avoid network even when the planner tries to refill the candidate reserve.
cet.build_scored_candidates = lambda: []
cet.upgrade_pending = lambda words: None

assert cet.complete_sentence(item['example'], item['word'])
assert not cet.complete_sentence('a proficient typist', 'proficient')
assert not cet.complete_sentence('...He is a proficient typist...', 'proficient')
assert not cet.complete_sentence('A carpet arrived at the house.', 'car')
assert cet.difficulty_score('unknown', 'CET6', {}) < cet.difficulty_score('rare', 'CET6', {'rare': 30000})
assert cet.difficulty_score('widely', 'CET6', {'widely': 13000, 'wide': 2000}) < cet.MIN_DIFFICULTY
raw = {'headWord': 'advisable', 'bookId': 'CET4_2', 'content': {'word': {'content': {
    'sentence': {'sentences': [{'sContent': 'It is advisable to leave early.', 'sCn': '早点离开是明智的。'}]},
    'trans': [{'pos': 'n', 'tranCn': '明智的'}],
    'realExamSentence': {'sentences': [{'sContent': 'It is advisable to leave early.', 'sourceInfo': {'level': 'CET4', 'year': '2016.6'}}]}
}}}}
better = copy.deepcopy(raw); better['bookId'] = 'CET4_3'
better['content']['word']['content']['trans'] = [{'pos': 'adj', 'tranCn': '明智的', 'tranOther': 'wise'}]
assert cet.source_item('advisable', [('CET4', raw), ('CET4', better)])['pos'] == 'adj.'
assert cet.exam_sources([{'content': {'word': {'content': {'realExamSentence': {'sentences': [
    {'sContent': 'He is proficient.', 'sourceInfo': {'level': 'CET6', 'year': '2016.6', 'paper': '第二套'}},
    {'sContent': 'A proficient worker.', 'sourceInfo': {'level': 'CET6', 'year': '2016.6', 'paper': '第二套'}}
]}}}}}], 'proficient') == ['CET6 · 2016.6 · 第二套']
assert cet.quota_left({'added': [{'at': (at - timedelta(hours=48)).isoformat()}]}, at) == (7, 0)
assert cet.quota_left({'added': [{'at': (at - timedelta(hours=47)).isoformat()}] * 7}, at) == (0, 7)
try:
    cet.quota_left({'added': [{'at': '2026-10-08T04:00:00'}]}, at)
    assert False, 'naive history timestamps must stop'
except ValueError:
    pass

# Flexible supply: default while legacy timestamps are missing, grow with observed pace,
# shrink with slow consumption, pause for stale reviews/inactivity, respect manual limits.
def pace(count, spread):
    words = [{'id': f'w{i}', 'word': f'w{i}'} for i in range(count)]
    records = {w['id']: {'stage': 'recognize', 'introducedAt': (at - timedelta(days=i % spread)).timestamp()*1000,
                         'lastSeen': at.timestamp()*1000, 'due': (at + timedelta(days=1)).timestamp()*1000}
               for i,w in enumerate(words)}
    return words, {'words': records, 'cet': {'approved': [], 'rejected': []}}
words, fast = pace(21, 3)
assert cet.supply_limits(words, fast, at)[:2] == (14, 15)
assert cet.quota_left({'added': [{'at': at.isoformat()}]*8}, at, 14) == (6, 8)
words, slow = pace(6, 6)
assert cet.supply_limits(words, slow, at)[:2] == (3, 5)
slow['settings'] = {'newLimit': 1}
assert cet.supply_limits(words, slow, at)[0] == 2
words, late = pace(30, 3)
for p in list(late['words'].values())[:10]: p['due'] = (at - timedelta(days=2)).timestamp()*1000
assert cet.supply_limits(words, late, at)[0] == 0
words, legacy = pace(6, 3)
for p in legacy['words'].values(): p.pop('introducedAt')
assert cet.supply_limits(words, legacy, at)[0] == 7
for p in legacy['words'].values(): p['lastSeen'] = (at-timedelta(days=8)).timestamp()*1000
assert cet.supply_limits(words, legacy, at)[0] == 0
assert cet.quota_left({'added': [{'at': at.isoformat()}]*8}, at, 3) == (0, 8)

with contextlib.redirect_stdout(io.StringIO()):
    # Approval deduplication; rejection wins across devices; progress remains byte-equivalent.
    progress = {'words': {}, 'cet': {'approved': ['proficient', 'proficient'], 'rejected': []}}
    old = copy.deepcopy(progress)
    data, state = {'words': []}, {'added': [], 'rejected': []}
    pending, added = cet.plan_update(data, [copy.deepcopy(item)], state, progress, at=at)
    assert added == ['proficient'] and not pending and len(state['added']) == 1 and progress == old
    assert cet.plan_update(data, [], state, progress, at=at)[1] == []
    data, state = {'words': []}, {'added': [], 'rejected': []}
    rejected_progress = {'words': {}, 'cet': {'approved': ['proficient'], 'rejected': ['proficient']}}
    assert cet.plan_update(data, [copy.deepcopy(item)], state, rejected_progress, at=at) == ([], [])
    assert state['rejected'] == ['proficient'] and data['words'] == []
    # Quota-blocked approved words remain available; history is never trimmed.
    state = {'added': [{'at': at.isoformat(), 'word': f'old{i}'} for i in range(7)], 'rejected': []}
    before = copy.deepcopy(state)
    pending, added = cet.plan_update({'words': []}, [copy.deepcopy(item)], state, progress, at=at)
    assert not added and pending == [item] and state == before
    # stage=new records are still unstarted; force cannot bypass the reserve cap.
    data = {'words': [{'id': f'fresh{i}', 'word': f'fresh{i}'} for i in range(15)]}
    p = {'words': {w['id']: {'stage': 'new'} for w in data['words']}, 'cet': progress['cet']}
    assert cet.plan_update(data, [copy.deepcopy(item)], {'added': [], 'rejected': []}, p, force=True, at=at)[1] == []
    # Broken legacy candidates and decisions are preserved, not silently discarded or admitted.
    broken = copy.deepcopy(item); broken['example'] = 'a proficient typist'
    assert cet.plan_update({'words': []}, [broken], {'added': [], 'rejected': []}, progress, at=at) == ([broken], [])
    # Dry-run and no-op leave all files untouched, including timestamps; no Git/gh calls.
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        (root/'data').mkdir(); (root/'scripts').mkdir()
        values = {'data/words.json': {'words': []}, 'data/cet-pending.json': {'updated': 'old', 'words': [item]},
                  'scripts/cet-state.json': {'added': [], 'rejected': []}, 'progress.json': progress}
        for name, value in values.items(): (root/name).write_text(json.dumps(value))
        before = {name: (root/name).read_bytes() for name in values}
        cet.gh = cet.git = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('no remote/Git operations'))
        sys.argv = ['check', '--repo', str(root), '--dry-run', '--progress-file', str(root/'progress.json')]
        cet.main()
        assert {name: (root/name).read_bytes() for name in values} == before
        values['progress.json']['cet']['approved'] = []
        (root/'progress.json').write_text(json.dumps(values['progress.json']))
        before = {name: ((root/name).read_bytes(), (root/name).stat().st_mtime_ns) for name in values}
        sys.argv = ['check', '--repo', str(root), '--no-commit', '--progress-file', str(root/'progress.json')]
        cet.main()
        assert {name: ((root/name).read_bytes(), (root/name).stat().st_mtime_ns) for name in values} == before
        (root/'progress.json').write_text('{broken')
        try:
            cet.main()
            assert False, 'broken progress must stop'
        except json.JSONDecodeError:
            pass
        for name in values:
            if name != 'progress.json': assert (root/name).read_bytes() == before[name][0]
print('CET checks passed: adaptive supply, 48h quota, approval/rejection, reserve, replay, dry-run, no-op, bad progress.')
