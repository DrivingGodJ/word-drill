// Run: node scripts/check-learning.cjs [private-progress-backup.json]
// Exercise the real app closure without exporting test APIs in the browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const storage = new Map();
const elements = new Map();
const element = (key) => {
  if (!elements.has(key)) elements.set(key, {
    value: '', hidden: false, disabled: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    events: {}, addEventListener(type, fn) { this.events[type] = fn; }, setAttribute() {}, focus() {},
    querySelector: (selector) => element(key + selector),
    querySelectorAll: () => [], insertAdjacentHTML() {}
  });
  return elements.get(key);
};
const context = vm.createContext({
  document: { querySelector: element, querySelectorAll: () => [], addEventListener() {} },
  localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
  navigator: {}, location: { protocol: 'http:', hash: '' }, window: {},
  setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {}, console,
  testNow: +new Date('2026-10-08T12:00:00+08:00'),
  TextDecoder, atob: (value) => Buffer.from(value, 'base64').toString('binary')
});
vm.runInContext(fs.readFileSync(path.join(root, 'vendor/ts-fsrs-5.4.2.js'), 'utf8'), context);
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8')
  .replace('const now = () => Date.now();', 'const now = () => globalThis.testNow;')
  .replace("document.addEventListener('DOMContentLoaded', boot);", `globalThis.check = {
    defaultStore, readStore, migrateStore, loadStore, grade, mergeRemote, buildPayload,
    newAllowance, normalMemory, normalize, hasFillExample, dayKey, startSession, remoteRead,
    nextQuestion, answer, revealOptions, onPickOption, speak, canSpeak, bindEvents,
    getStore: () => store, setStore: (s) => { store = readStore(s); },
    getSession: () => session,
    setWords: (words) => { WORDS = words; byId.clear(); words.forEach(w => byId.set(w.id, w)); }
  }; sync = { deviceId: 'check' };`);
vm.runInContext(source, context);
const app = context.check;
const plain = (obj) => JSON.parse(JSON.stringify(obj));
const DAY = 86400000;
const initialTime = context.testNow;
const rec = (stage = 'recognize') => ({ stage, credits: [initialTime - 40 * DAY, initialTime - DAY],
  correct: 8, wrong: 1, due: initialTime - DAY, lastSeen: initialTime - DAY });
const reset = (words = {}) => {
  context.testNow = initialTime;
  app.setStore({ ...plain(app.defaultStore()), words });
};

// Migration preserves every existing record, including IDs absent from today's dictionary.
const old = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : {
  version: 4, words: { existing: rec(), orphan: rec('mastered') },
  settings: { newLimit: 10, threshold: 15 }, stats: { answers: 632, correct: 597, sessions: 27 },
  cet: { approved: ['keep'], rejected: ['skip'] }
};
const raw = JSON.stringify(old);
storage.set('worddrill.v1', raw);
const migrated = app.loadStore();
assert.equal(migrated.version, 5);
assert.equal(migrated.settings.threshold, 3);
assert.equal(migrated.settings.newLimit, old.settings.newLimit);
assert.equal(storage.get('worddrill.backup.before-v5'), raw);
for (const [id, p] of Object.entries(old.words)) {
  for (const key of ['stage', 'credits', 'correct', 'wrong', 'due', 'lastSeen']) {
    assert.deepEqual(plain(migrated.words[id][key]), p[key], `${id}.${key}`);
  }
}
assert.deepEqual(plain(migrated.stats), { ...plain(app.defaultStore().stats), ...old.stats });
assert.deepEqual(plain(migrated.cet), old.cet);
const originalSetter = context.localStorage.setItem;
storage.delete('worddrill.backup.before-v5');
context.localStorage.setItem = () => { throw new Error('quota'); };
assert.throws(() => app.loadStore(), /quota/);
assert.equal(storage.get('worddrill.v1'), raw);
context.localStorage.setItem = originalSetter;

// Lapses retain historical days; practice and hints cannot create mastery evidence.
reset({ word: rec() });
const lapse = app.grade('word', false);
assert.equal(lapse.after.credits.length, 2);
assert.equal(lapse.after.due, initialTime + 60000);
const retry = app.grade('word', true);
assert.equal(retry.credited, false);
assert.equal(retry.promoted, false);
const memory = plain(retry.after.memory);
const due = retry.after.due;
const practice = app.grade('word', true, false, true);
assert.equal(practice.after.due, due);
assert.deepEqual(plain(practice.after.memory), memory);
assert.deepEqual(plain(practice.after.credits), plain(retry.after.credits));
context.testNow = due;
const aided = app.grade('word', true, true);
assert.equal(aided.credited, false);
assert.equal(aided.promoted, false);
assert.deepEqual(plain(aided.after.credits), plain(practice.after.credits));

// A new word needs spaced evidence in each skill; the spelling card starts independently.
reset();
app.grade('fresh', true);
assert.equal(app.getStore().words.fresh.stage, 'recognize');
assert.equal(app.getStore().words.fresh.due, initialTime + 10 * 60000);
let reachedWrite = false;
let reachedMastered = false;
for (let n = 0; n < 16; n++) {
  const before = app.getStore().words.fresh;
  context.testNow = before.due;
  const result = app.grade('fresh', true);
  if (result.after.stage === 'write' && result.promoted) {
    reachedWrite = true;
    assert.equal(result.after.memory, undefined);
    assert.equal(result.after.credits.length, 0);
    assert.equal(result.after.due, context.testNow + 10 * 60000);
  }
  if (result.after.stage === 'mastered') { reachedMastered = true; break; }
}
assert.ok(reachedWrite && reachedMastered, 'both skills can reach mastery');
const masteredDue = app.getStore().words.fresh.due;
context.testNow = masteredDue;
const forgotten = app.grade('fresh', false);
assert.equal(forgotten.after.stage, 'write');
assert.equal(forgotten.demoted, true);
assert.ok(forgotten.after.memory.stability < 21);

// A real daily quota includes failed first attempts and is shared across sessions.
reset();
app.getStore().settings.newLimit = 2;
app.grade('a', true);
app.grade('b', false);
assert.equal(app.newAllowance(), 0);
app.setWords(['a', 'b', 'c'].map(id => ({ id, word: id, meaning: id, example: '' })));
app.startSession();
assert.equal(app.getSession(), null, 'a fresh session cannot exceed the daily quota');
context.testNow += DAY;
assert.equal(app.newAllowance(), 2);
app.startSession('review');
assert.deepEqual(plain(app.getSession().queue), ['b', 'a']);
app.startSession();
assert.ok(app.getSession().queue.includes('c'));

// Sync round trips preserve FSRS and quota state and reject future formats.
const local = plain(app.getStore());
const payload = plain(app.buildPayload());
reset();
assert.equal(app.mergeRemote(payload), true);
assert.deepEqual(plain(app.getStore().words), local.words);
assert.equal(app.mergeRemote(payload), false);
assert.throws(() => app.mergeRemote({ version: 99 }), /更新版本/);
assert.throws(() => app.readStore({ words: [] }), /格式/);
assert.throws(() => app.readStore({ words: { broken: null } }), /格式/);
assert.equal(app.normalMemory({ stability: NaN }), undefined);

// Spelling preserves meaningful punctuation; sentence cloze requires an exact occurrence.
assert.equal(app.normalize('  HELLO   WORLD '), 'hello world');
assert.notEqual(app.normalize('car123'), app.normalize('car'));
assert.notEqual(app.normalize('icecream'), app.normalize('ice cream'));
assert.ok(app.hasFillExample({ word: 'car', example: 'A car arrived at the station.' }));
assert.equal(app.hasFillExample({ word: 'car', example: 'A carpet arrived at the station.' }), false);
assert.equal(app.hasFillExample({ word: 'car', example: 'A car arrived.' }), false);
assert.equal(app.hasFillExample({ word: 'car', example: 'A car at the station' }), false);

// Recall precedes visible choices; assisted correctness never becomes independent evidence.
const trainingWords = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map(id => ({
  id, word: id, meaning: `meaning-${id}`, pos: 'n.', example: `The ${id} is used in this example.`, exampleZh: `translation-${id}`
}));
app.setWords(trainingWords);
reset(Object.fromEntries(trainingWords.map(w => [w.id, rec()])));
app.startSession('review');
app.bindEvents();
const first = app.getSession().current;
const correctIndex = first.options.findIndex(o => o.correct);
assert.equal(first.optionsReady, false);
const firstIndex = app.getSession().index;
elements.get('#btn-next').events.click();
assert.equal(app.getSession().index, firstIndex, 'cannot skip an unanswered question');
assert.match(elements.get('#quiz-body').innerHTML, /id="recognize-options"[^>]*hidden/);
app.onPickOption(first, correctIndex);
assert.equal(app.getStore().stats.answers, 0, 'cannot grade choices before a recall attempt');
app.revealOptions(first, true);
assert.equal(elements.get('#recognize-options').hidden, false);
app.onPickOption(first, correctIndex);
assert.equal(app.getStore().stats.correct, 1, 'assisted correctness remains in historical totals');
assert.equal(app.getSession().correct, 0, 'session rate measures independent correctness');
assert.equal(app.getSession().aided.has(first.word.id), true);
assert.equal(first.requeued, true);
assert.equal(app.getSession().queue[app.getSession().index + 3], first.word.id);
const scheduled = plain(app.getStore().words[first.word.id]);
for (let i = 0; i < 3; i++) {
  app.nextQuestion();
  const q = app.getSession().current;
  app.revealOptions(q, false);
  app.onPickOption(q, q.options.findIndex(o => o.correct));
}
app.nextQuestion();
assert.equal(app.getSession().current.word.id, first.word.id);
assert.equal(app.getSession().current.retry, true);
app.revealOptions(app.getSession().current, false);
app.answer(true, first.word.meaning);
const afterRetry = app.getStore().words[first.word.id];
for (const key of ['stage', 'credits', 'due', 'memory', 'introducedAt']) {
  assert.deepEqual(plain(afterRetry[key] ?? null), plain(scheduled[key] ?? null), `retry preserves ${key}`);
}
assert.equal(afterRetry.correct, scheduled.correct + 1);

// A short queue does not loop a single just-seen answer; correction still teaches the spelling.
app.setWords(trainingWords.slice(0, 1));
reset({ alpha: rec('write') });
app.startSession('review');
app.answer(false, 'alfa');
assert.equal(app.getSession().queue.length, 1);
assert.equal(app.getSession().current.requeued, undefined);
assert.match(elements.get('#feedback').innerHTML, /本轮不立即重复/);
const beforeCorrection = plain(app.getStore());
elements.get('#correction-input').value = 'alpha';
elements.get('#correction-form').events.submit({ preventDefault() {} });
assert.equal(elements.get('#btn-next').disabled, false);
assert.deepEqual(plain(app.getStore()), beforeCorrection, 'correction is not another grade');

// Context and listening transfer exercises preserve the formal memory card and daily quota.
app.setWords(trainingWords.concat([{ id: 'fragment', word: 'fragment', meaning: '片段', example: 'a fragment' }]));
reset({ alpha: rec(), fragment: rec(), beta: { ...rec('new'), introducedAt: initialTime } });
app.startSession('context');
assert.equal(app.getSession().practice, true);
assert.equal(app.getSession().current.kind, 'fill');
assert.equal(app.getSession().queue.length, 2, 'exclude unstarted words and sentence fragments');
assert.match(elements.get('#quiz-body').innerHTML, /id="context-translation" hidden/);
const contextId = app.getSession().current.word.id;
const beforeContext = plain(app.getStore().words[contextId]);
app.answer(true, contextId);
for (const key of ['stage', 'credits', 'due', 'memory', 'introducedAt']) {
  assert.deepEqual(plain(app.getStore().words[contextId][key] ?? null), plain(beforeContext[key] ?? null));
}
assert.equal(app.canSpeak(), false);
const previousSession = app.getSession();
app.startSession('listen');
assert.equal(app.getSession(), previousSession, 'unsupported speech must not start an unusable quiz');
let utterance;
context.SpeechSynthesisUtterance = function(text) { this.text = text; };
context.window.speechSynthesis = { cancel() {}, speak(u) { utterance = u; } };
app.startSession('listen');
assert.equal(app.getSession().current.kind, 'listen');
const listenQ = app.getSession().current;
assert.equal(elements.get('#quiz-body').innerHTML.includes(listenQ.word.meaning), false);
const beforeListen = plain(app.getStore().words[listenQ.word.id]);
elements.get('#btn-listen-play').events.click();
assert.equal(utterance.text, listenQ.word.word);
assert.equal(utterance.lang, 'en-US');
utterance.onerror({ error: 'canceled' });
assert.doesNotMatch(elements.get('#listen-status').textContent, /播放失败/);
utterance.onerror();
assert.match(elements.get('#listen-status').textContent, /播放失败/);
app.answer(true, listenQ.word.word);
assert.equal(app.getStore().words[listenQ.word.id].due, beforeListen.due);
assert.deepEqual(plain(app.getStore().words[listenQ.word.id].credits), beforeListen.credits);

// The summary can drill an assisted-only word even when there is no historical mistake.
reset({ alpha: { ...rec(), wrong: 0 } });
app.setWords(trainingWords);
app.startSession('mistakes', ['alpha']);
assert.deepEqual(plain(app.getSession().queue), ['alpha']);
assert.equal(app.getSession().practice, true);
// Corrupt remote progress must stop the read/write cycle before merging any data.
(async () => {
  context.fetch = async () => ({ ok: true, json: async () => ({
    sha: 'check', content: Buffer.from('broken json').toString('base64')
  }) });
  await assert.rejects(() => app.remoteRead(), /无法解析/);
  context.fetch = async () => ({ ok: true, json: async () => ({
    sha: 'check', content: Buffer.from(JSON.stringify({ version: 5, words: { invalid: null } })).toString('base64')
  }) });
  await assert.rejects(() => app.remoteRead(), /格式/);
  console.log(`Learning checks passed; ${Object.keys(old.words).length} legacy records preserved.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
