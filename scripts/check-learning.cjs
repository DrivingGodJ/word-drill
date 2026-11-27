// Run: node scripts/check-learning.cjs [private-progress-backup.json]
// Exercise the real app closure without exporting test APIs in the browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const storage = new Map();
const elements = new Map();
const documentEvents = {}, windowEvents = {}, intervals = [];
const element = (key) => {
  if (!elements.has(key)) elements.set(key, {
    value: '', hidden: false, disabled: false, style: {}, dataset: {},
    classList: { values: new Set(), add(x) { this.values.add(x); }, remove(x) { this.values.delete(x); }, toggle(x, on) { on ? this.values.add(x) : this.values.delete(x); }, contains(x) { return this.values.has(x); } },
    events: {}, addEventListener(type, fn) { this.events[type] = fn; }, setAttribute() {}, removeAttribute() {}, scrollIntoView() {}, focus() {}, select() { this.selected = true; },
    querySelector: (selector) => element(key + selector),
    querySelectorAll: () => [], insertAdjacentHTML() {}
  });
  return elements.get(key);
};
const context = vm.createContext({
  document: { body: element('body'), documentElement: element('html'), querySelector: element, querySelectorAll: () => [], visibilityState: 'visible',
    addEventListener: (type, fn) => { documentEvents[type] = fn; } },
  localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
  crypto: require('node:crypto').webcrypto, navigator: {}, location: { protocol: 'http:', hash: '' },
  window: { addEventListener: (type, fn) => { windowEvents[type] = fn; } },
  setInterval: (fn) => intervals.push(fn),
  setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {}, console,
  testNow: +new Date('2026-10-08T12:00:00+08:00'),
  TextDecoder, TextEncoder, atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  btoa: (value) => Buffer.from(value, 'binary').toString('base64')
});
vm.runInContext(fs.readFileSync(path.join(root, 'vendor/ts-fsrs-5.4.2.js'), 'utf8'), context);
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8')
  .replace('const now = () => Date.now();', 'const now = () => globalThis.testNow;')
  .replace("document.addEventListener('DOMContentLoaded', boot);", `globalThis.check = {
    defaultStore, readStore, migrateStore, loadStore, grade, mergeRemote, buildPayload,
    newAllowance, dailyCoverage, normalMemory, normalize, selectRepository, repositoryId, migrateRepositoryStorage, restoreVocabulary, saveStore, hasFillExample, dayKey, startSession, remoteRead,
    requiresWriting, progressOf, quizTypeFor, renderLibrary, switchView, bindSettings,
    nextQuestion, answer, revealOptions, onPickOption, speak, canSpeak, bindEvents,
    syncNow, autoSync, bindAutoSync, endSession, getSync: () => sync, isSyncing: () => syncing,
    setSync: (config) => { sync = config; }, setSession: (s) => { session = s; },
    getStore: () => store, setStore: (s) => { store = readStore(s); },
    getVocabulary: () => ({words: WORDS, meta: META}), getSession: () => session, setMeta: (meta) => { META = meta; },
    setWords: (words) => { WORDS = words; byId.clear(); words.forEach(w => byId.set(w.id, w)); },
    applyPacePreset, getCurrentPace, mergeWordlists, planCloudUpload, uploadLocalToCloud,
    remoteReadFile, loadWordbooks, saveWordbooks, selectWordbook, deleteWordbook, isCloudBook, saveVocabularyLocal,
    buildWordbookBundle, parseWordbookBundle, wordDifficulty, selectDailyNewWords, resetBookProgress,
    getIosPwaState, syncBookToNativeDisk, deleteBookFromNativeDisk, hydrateNativeWordbooksOnBoot
  }; sync = { deviceId: 'check' };`);
vm.runInContext(source, context);
const app = context.check;
const plain = (obj) => JSON.parse(JSON.stringify(obj));
const waitFor = async (predicate) => {
  for (let i = 0; !predicate(); i++) {
    assert.ok(i < 1000, 'async sync check did not finish');
    await Promise.resolve();
  }
};
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
assert.equal(migrated.version, 6);
assert.equal(migrated.settings.threshold, 3);
assert.equal(migrated.settings.newLimit, old.settings.newLimit);
assert.equal(storage.get('worddrill.backup.before-v6'), raw);
for (const [id, p] of Object.entries(old.words)) {
  for (const key of ['stage', 'credits', 'correct', 'wrong', 'due', 'lastSeen']) {
    assert.deepEqual(plain(migrated.words[id][key]), p[key], `${id}.${key}`);
  }
}
assert.deepEqual(plain(migrated.stats), { ...plain(app.defaultStore().stats), ...old.stats });
assert.deepEqual(plain(migrated.cet), old.cet);
const originalSetter = context.localStorage.setItem;
storage.delete('worddrill.backup.before-v6');
context.localStorage.setItem = () => { throw new Error('quota'); };
assert.throws(() => app.loadStore(), /quota/);
assert.equal(storage.get('worddrill.v1'), raw);
context.localStorage.setItem = originalSetter;

// v5 -> v6 keeps existing FSRS settings/history and also retains the older backup.
const v5 = { ...plain(migrated), version: 5, settings: { ...plain(migrated.settings), threshold: 5, retention: 85 }, settingsAt: 123 };
storage.set('worddrill.v1', JSON.stringify(v5));
storage.set('worddrill.backup.before-v5', 'older-backup');
const v6 = app.loadStore();
assert.equal(v6.version, 6);
assert.deepEqual(plain(v6.settings), v5.settings);
assert.equal(v6.settingsAt, 123);
assert.deepEqual(plain(v6.words), v5.words);
assert.equal(storage.get('worddrill.backup.before-v6'), JSON.stringify(v5));
assert.equal(storage.get('worddrill.backup.before-v5'), 'older-backup');

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

// CET6 needs recognition only; CET4, manual and overlapping labels still require writing.
const classified = [
  { id: 'six', word: 'six', meaning: '六级词', tags: ['CET6'] },
  { id: 'four', word: 'four', meaning: '四级词', tags: ['CET4'] },
  { id: 'extra', word: 'extra', meaning: '手动词', tags: [] },
  { id: 'both', word: 'both', meaning: '重合词', tags: ['CET4', 'CET6'] },
  { id: 'manualSix', word: 'manual-six', meaning: '额外六级词', tags: ['CET6', '手动添加'] },
  { id: 'unitSix', word: 'unit-six', meaning: '课本词', tags: ['CET6', 'Unit2'] }
];
app.setWords(classified);
assert.equal(app.requiresWriting('six'), false);
for (const id of ['four', 'extra', 'both', 'manualSix', 'unitSix']) assert.equal(app.requiresWriting(id), true);
for (const stage of ['new', 'recognize', 'write', 'mastered']) assert.equal(app.quizTypeFor('six', stage), 'recognize');
for (const id of ['four', 'extra', 'both', 'manualSix']) assert.equal(app.quizTypeFor(id, 'mastered'), 'spell');
reset();
app.grade('six', true);
let sixMastered = false;
for (let n = 0; n < 16; n++) {
  context.testNow = app.getStore().words.six.due;
  const result = app.grade('six', true);
  assert.notEqual(result.after.stage, 'write');
  if (result.after.stage === 'mastered') { sixMastered = true; break; }
}
assert.ok(sixMastered);
assert.equal(app.getStore().words.six.masteredBy, 'recognize');
const sixMemory = plain(app.getStore().words.six.memory);
const sixPayload = plain(app.buildPayload());
reset();
app.mergeRemote(sixPayload);
assert.equal(app.getStore().words.six.masteredBy, 'recognize', 'sync retains which skill was mastered');
assert.deepEqual(plain(app.getStore().words.six.memory), sixMemory);
context.testNow = app.getStore().words.six.due;
assert.equal(app.grade('six', false).after.stage, 'recognize', 'a CET6 lapse never demands spelling');
reset({ six: rec('write'), four: rec('write') });
const legacySix = plain(app.getStore().words.six);
assert.equal(app.progressOf('six').stage, 'mastered');
for (const key of ['credits', 'correct', 'wrong', 'due', 'lastSeen']) assert.deepEqual(plain(app.progressOf('six')[key]), legacySix[key]);
assert.deepEqual(plain(app.getStore().words.six), legacySix, 'interpreting legacy CET6 does not rewrite history');
assert.equal(app.progressOf('four').stage, 'write');
app.setWords(classified.slice(0, 1));
app.startSession('review');
assert.equal(app.getSession().current.kind, 'recognize', 'even a tiny CET6 dictionary does not fall back to spelling');
app.setSession(null);
app.setWords(classified);
reset({ manualSix: { ...rec('mastered'), due: initialTime + 30 * DAY, masteredBy: 'recognize', memory: sixMemory } });
assert.equal(app.progressOf('manualSix').stage, 'write', 'manually requesting an already-recognized CET6 word adds the spelling requirement');
assert.equal(app.progressOf('manualSix').memory, undefined, 'spelling starts a separate memory card');
assert.equal(app.progressOf('manualSix').credits.length, 0);
assert.equal(app.progressOf('manualSix').due, 0, 'the unlearned writing skill is available immediately');
app.grade('manualSix', true);
assert.equal(app.getStore().words.manualSix.stage, 'write');
assert.ok(app.getStore().words.manualSix.memory.stability < 21);
assert.throws(() => app.readStore({ version: 6, words: { six: { ...rec(), masteredBy: 'unknown' } } }), /格式/);
app.renderLibrary();
assert.match(elements.get('#wordlist').innerHTML, /只需认词/);
assert.match(elements.get('#wordlist').innerHTML, /认词＋拼写/);

if (process.argv[3]) {
  const current = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  app.setWords((process.argv[4] ? JSON.parse(fs.readFileSync(process.argv[4], 'utf8')).words : []));
  app.setStore(current);
  const original = plain(app.getStore());
  let legacySix = 0;
  for (const [id, p] of Object.entries(original.words)) {
    const view = app.progressOf(id);
    assert.equal(view.stage, !app.requiresWriting(id) && p.stage === 'write' ? 'mastered' : p.stage);
    if (!app.requiresWriting(id) && p.stage === 'write') legacySix++;
    for (const key of ['credits', 'correct', 'wrong', 'due', 'lastSeen', 'introducedAt', 'memory']) {
      assert.deepEqual(plain(view[key] ?? null), plain(p[key] ?? null), `${id} preserves ${key}`);
    }
  }
  assert.deepEqual(plain(app.getStore()), original, 'the live export remains unchanged while applying current requirements');
  console.log(`Current-progress check passed; ${legacySix} legacy CET6 spelling records now count as recognition-mastered.`);
}

// A two-round target lifts only the effective quota; stored settings/progress stay intact.
reset();
app.setMeta({ dailyWordTarget: 80 });
const supply = Array.from({length: 100}, (_, i) => ({id: `s${i}`, word: `s${i}`, tags: ['CET4']}));
app.setWords(supply);
assert.equal(app.newAllowance(), 80);
for (let i = 0; i < 30; i++) app.getStore().words[`s${i}`] = rec();
assert.equal(app.newAllowance(), 50, '30 due words leave a 50-word gap');
for (let i = 0; i < 20; i++) {
  app.getStore().words[`s${i}`].lastSeen = initialTime;
  app.getStore().words[`s${i}`].due = initialTime + DAY;
}
assert.deepEqual(plain(app.dailyCoverage()), {seen: 20, due: 10});
assert.equal(app.newAllowance(), 50, 'completed reviews still count toward today');
app.getStore().words.s0.due = initialTime - 1;
assert.equal(app.newAllowance(), 50, 'an already-seen due word is counted only once');
app.getStore().words.orphan = rec();
assert.equal(app.newAllowance(), 50, 'unknown IDs cannot fill the target');
assert.equal(app.getStore().settings.newLimit, 10, 'do not rewrite synced settings');
// Two successive perfect rounds can select 40 each even with no due reviews.
reset();
app.setWords(supply);
app.startSession();
assert.equal(app.getSession().queue.length, 40);
for (const id of app.getSession().queue) {
  app.getStore().words[id] = {...rec(), introducedAt: initialTime, lastSeen: initialTime, due: initialTime + DAY};
}
assert.equal(app.newAllowance(), 40);
app.startSession();
assert.equal(app.getSession().queue.length, 40);
for (const id of app.getSession().queue) {
  assert.equal(app.getStore().words[id], undefined, 'second round has different fresh words');
  app.getStore().words[id] = {...rec(), introducedAt: initialTime, lastSeen: initialTime, due: initialTime + DAY};
}
assert.equal(app.newAllowance(), 0);
context.testNow += DAY;
assert.equal(app.newAllowance(), 10, '80 now-due words already cover the target');
app.setMeta({});
app.setSession(null);
reset();

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

// Training locks navigation; every exit restores a usable route to the intro.
reset({ alpha: rec() });
app.setSession(null);
app.setWords(trainingWords);
app.startSession('review');
assert.equal(elements.get('body').classList.contains('is-training'), true);
const routeBefore = context.location.hash;
app.switchView('settings');
assert.equal(context.location.hash, routeBefore, 'navigation is blocked during training');
app.endSession();
assert.equal(elements.get('body').classList.contains('is-training'), false);
assert.equal(elements.get('#session-intro').hidden, false, 'ending without answers returns home');
app.startSession('review');
app.answer(true, 'correct');
app.endSession();
assert.equal(elements.get('#session-summary').hidden, false);
assert.equal(elements.get('body').classList.contains('is-training'), false);
app.switchView('learn');
assert.equal(elements.get('#session-summary').hidden, true, 'training tab leaves the summary');
assert.equal(elements.get('#session-intro').hidden, false);
elements.get('#btn-summary-home').events.click();
assert.equal(elements.get('#session-intro').hidden, false, 'explicit home button works');

// The summary can drill an assisted-only word even when there is no historical mistake.
reset({ alpha: { ...rec(), wrong: 0 } });
app.setWords(trainingWords);
app.startSession('mistakes', ['alpha']);
assert.deepEqual(plain(app.getSession().queue), ['alpha']);
assert.equal(app.getSession().practice, true);
// Corrupt remote progress must stop the read/write cycle before merging any data.
(async () => {
  // Copy the actual public onboarding prompt; clipboard failures leave it selectable.
  app.bindSettings();
  const onboarding = fs.readFileSync(path.join(root, 'index.html'), 'utf8').match(/<textarea id="agent-prompt"[^>]*>([\s\S]*?)<\/textarea>/)[1];
  element('#agent-prompt').value = onboarding;
  let copied;
  context.navigator.clipboard = { writeText: async value => { copied = value; } };
  await elements.get('#btn-copy-agent-prompt').events.click();
  assert.equal(copied, onboarding);
  assert.match(copied, /https:\/\/github.com\/DrivingGodJ\/word-drill\/tree\/main\/skills\/worddrill-assistant/);
  context.navigator.clipboard.writeText = async () => { throw new Error('permission denied'); };
  await elements.get('#btn-copy-agent-prompt').events.click();
  assert.equal(elements.get('#agent-prompt').selected, true);
  assert.match(elements.get('#agent-copy-status').textContent, /已选中/);
  delete context.navigator.clipboard;
  await elements.get('#btn-copy-agent-prompt').events.click();
  assert.equal(elements.get('#agent-prompt').selected, true);

  // Rejected native fullscreen keeps training usable; completing the queue unlocks home.
  reset({ alpha: rec() });
  app.setSession(null);
  app.setWords(trainingWords);
  context.document.fullscreenEnabled = true;
  context.document.documentElement.requestFullscreen = async () => { throw new Error('unsupported'); };
  app.startSession('review');
  await Promise.resolve();
  assert.equal(elements.get('body').classList.contains('is-training'), true);
  app.answer(true, 'correct');
  app.nextQuestion();
  assert.equal(app.getSession(), null);
  assert.equal(elements.get('#session-summary').hidden, false);
  assert.equal(elements.get('body').classList.contains('is-training'), false);
  elements.get('#btn-summary-home').events.click();
  assert.equal(elements.get('#session-intro').hidden, false);
  context.document.fullscreenEnabled = false;
  context.fetch = async () => ({ ok: true, json: async () => ({
    sha: 'check', content: Buffer.from('broken json').toString('base64')
  }) });
  await assert.rejects(() => app.remoteRead(), /无法解析/);
  context.fetch = async () => ({ ok: true, json: async () => ({
    sha: 'check', content: Buffer.from(JSON.stringify({ version: 5, words: { invalid: null } })).toString('base64')
  }) });
  await assert.rejects(() => app.remoteRead(), /格式/);
  // A desktop left open must pull the phone's newer records on return and while idle.
  app.setSession(null);
  app.setSync({ enabled: true, token: 'test-only', owner: 'test', repo: 'private',
    branch: 'main', path: 'progress.json', deviceId: 'desktop' });
  const phone = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : {
    ...plain(app.defaultStore()), words: { phone: { ...rec('write'), lastSeen: initialTime } },
    stats: { answers: 636, correct: 600, sessions: 28, streakDays: 7, lastDate: '2026-10-08' }
  };
  let cloud = plain(phone), sha = 1, reads = 0, writes = 0;
  let holdWrite, releaseWrite, conflictOnce = false;
  context.fetch = async (url, options = {}) => {
    if (!url.startsWith('https://api.github.com/')) return { ok: true, json: async () => ({ words: [] }) };
    if (!url.includes('/contents/')) return { ok: true, json: async () => ({ private: true }) };
    if (url.includes('/contents/data/')) return { ok: true, json: async () => ({content: Buffer.from(JSON.stringify({words: url.includes('data/words.json') ? trainingWords : []})).toString('base64')}) };
    if (options.method !== 'PUT') {
      reads++;
      return { ok: true, json: async () => ({ sha: String(sha), content: Buffer.from(JSON.stringify(cloud)).toString('base64') }) };
    }
    const body = JSON.parse(options.body);
    if (holdWrite) { holdWrite = false; await new Promise(resolve => { releaseWrite = resolve; }); }
    if (conflictOnce) { conflictOnce = false; sha++; cloud.words.concurrent = rec(); return { ok: false, status: 409 }; }
    assert.equal(body.sha, String(sha));
    cloud = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
    sha++; writes++;
    return { ok: true, json: async () => ({}) };
  };
  // A schema-only migration must upload v6 even if all progress/settings are identical.
  reset();
  cloud = plain(app.buildPayload()); cloud.version = 5;
  await app.syncNow({ silent: true });
  assert.equal(cloud.version, 6);
  assert.equal(writes, 1);
  cloud = plain(phone); sha++; reads = 0; writes = 0;
  reset({ desktopOnly: rec() });
  await app.autoSync();
  for (const [id, p] of Object.entries(app.readStore(phone).words)) {
    assert.deepEqual(plain(app.getStore().words[id]), plain(p), `phone progress ${id}`);
  }
  assert.ok(cloud.words.desktopOnly, 'phone pull also preserves desktop-only progress');
  assert.equal(app.getStore().stats.answers, phone.stats.answers);
  const unchangedWrites = writes;
  await app.syncNow({ silent: true });
  assert.equal(writes, unchangedWrites, 'identical progress produces no empty commit');
  app.bindAutoSync();
  for (const [trigger, id] of [[windowEvents.focus, 'focus'], [windowEvents.pageshow, 'pageshow'],
    [intervals[0], 'poll'], [documentEvents.visibilitychange, 'visible'], [windowEvents.online, 'online']]) {
    cloud.words[id] = rec(); sha++; context.testNow += 16000;
    await trigger();
    await waitFor(() => !app.isSyncing());
    assert.ok(app.getStore().words[id], `${id} triggers a remote pull`);
  }
  const previousReads = reads;
  await app.autoSync();
  assert.equal(reads, previousReads, 'focus and visibility events are throttled');
  context.document.visibilityState = 'hidden';
  await app.autoSync(true);
  assert.equal(reads, previousReads, 'hidden pages do not poll');
  context.document.visibilityState = 'visible';

  // Each answer uploads even before ending the round. A late answer queues another upload.
  reset({ alpha: rec(), beta: rec() });
  app.setWords(trainingWords);
  app.startSession('review');
  const activeBefore = plain(app.getStore());
  const currentId = app.getSession().current.word.id;
  cloud.words[currentId] = { ...rec('write'), lastSeen: initialTime + DAY };
  sha++;
  await app.syncNow({ silent: true });
  assert.deepEqual(plain(app.getStore()), activeBefore, 'pulling during a quiz never changes the grading stage');
  assert.match(app.getSync().lastResult, /本轮结束后合并/);
  assert.ok(cloud.words.focus && cloud.words.desktopOnly, 'active-quiz upload preserves remote-only records');
  assert.equal(await app.autoSync(true), undefined, 'idle pull waits until the quiz ends');
  holdWrite = true;
  app.answer(true, 'correct');
  await waitFor(() => !!releaseWrite);
  assert.equal(app.getSession().done, 1);
  app.nextQuestion();
  app.answer(true, 'correct');
  assert.throws(()=>app.selectRepository({owner:'test',repo:'other'}), /等待/, 'in-flight requests cannot switch repositories');
  assert.equal(elements.get('#data-repository').disabled, true);
  releaseWrite();
  await waitFor(() => !app.isSyncing());
  assert.equal(cloud.words[app.getSession().current.word.id].lastSeen, context.testNow, 'last answer was not dropped while a write was in flight');
  assert.ok(cloud.words.focus, 'queued writes keep records learned on the other device');
  app.endSession();
  await waitFor(() => !app.isSyncing());
  assert.ok(app.getStore().words.focus, 'remote records become local when the quiz ends');
  conflictOnce = true;
  app.getStore().words.conflictLocal = rec();
  await app.syncNow({ silent: true });
  assert.ok(cloud.words.concurrent && cloud.words.conflictLocal, 'a 409 retries and preserves both devices');

  // A private-repository permission failure must never be treated as an empty remote file.
  const beforeFailure = plain(app.getStore());
  let deniedWrites = 0;
  context.fetch = async (url, options = {}) => {
    if (options.method === 'PUT') deniedWrites++;
    return { ok: false, status: 404 };
  };
  await app.syncNow({ silent: true });
  assert.match(app.getSync().lastResult, /404/);
  assert.equal(deniedWrites, 0);
  assert.deepEqual(plain(app.getStore()), beforeFailure);
  context.fetch = async (url) => url.includes('/contents/')
    ? { ok: false, status: 404 }
    : { ok: true, json: async () => ({ permissions: { push: true }, full_name: 'test/private', private: true }) };
  assert.equal(await app.remoteRead(), null, 'an accessible branch with no file still allows first sync');
  context.fetch = async (url) => url.includes('/branches/') || url.includes('/contents/')
    ? { ok: false, status: 404 }
    : { ok: true, json: async () => ({ permissions: { push: true }, private: true }) };
  await assert.rejects(() => app.remoteRead(), /分支 main 不存在/, 'a wrong branch cannot create an empty progress file');
  // Each data repository has independent local progress, vocabulary, and credentials.
  app.setSession(null);
  const configA = {enabled: true, owner: 'test', repo: 'data-a', branch: 'main', path: 'progress.json', token: 'token-a'};
  const configB = {...configA, repo: 'data-b', token: 'token-b'};
  app.setSync(configA);
  storage.set('worddrill.v1', JSON.stringify({...plain(app.defaultStore()), words: {legacy: rec()}}));
  storage.delete('worddrill.legacy-repository.v1');
  app.migrateRepositoryStorage();
  app.setStore(app.loadStore());
  assert.ok(app.getStore().words.legacy, 'existing config receives legacy records');
  app.saveStore();
  app.selectRepository(configB);
  assert.deepEqual(plain(app.getStore().words), {}, 'new repository cannot inherit old progress');
  assert.equal(app.newAllowance(), 10);
  app.getStore().words.midterm = rec();
  app.saveStore();
  app.selectRepository(configA);
  assert.ok(app.getStore().words.legacy);
  assert.equal(app.getStore().words.midterm, undefined);
  assert.equal(app.getSync().token, 'token-a');
  app.selectRepository(configB);
  assert.ok(app.getStore().words.midterm);
  assert.equal(app.getStore().words.legacy, undefined);
  assert.equal(app.getSync().token, 'token-b');
  // A corrupt selected profile cannot leave the previous in-memory progress bound to a new repo.
  const bad = {...configA, repo:'broken'};
  storage.set('worddrill.v1:'+encodeURIComponent(app.repositoryId(bad)), '{broken');
  assert.throws(()=>app.selectRepository(bad));
  assert.equal(app.getSync().repo, 'data-b');
  assert.ok(app.getStore().words.midterm);
  // Cache is repo-scoped and can restore the selected book without a network request.
  const cacheKey = 'worddrill.vocabulary.v1:'+encodeURIComponent(app.repositoryId(configB));
  storage.set(cacheKey, JSON.stringify({words: [{id:'book-b',word:'word',meaning:'词'}],meta:{name:'B'}}));
  app.restoreVocabulary();
  assert.equal(app.getVocabulary().words[0].id, 'book-b');
  app.selectRepository(configA);
  assert.equal(app.getVocabulary().words.length, 0);
  assert.equal(app.getSession(), null);
  app.selectRepository(configB);
  assert.equal(app.getVocabulary().words[0].id, 'book-b');
  assert.ok(app.getStore().words.midterm);

  // Intuitive preset settings map cleanly to internal threshold + retention values.
  app.applyPacePreset('light');
  assert.equal(app.getStore().settings.threshold, 2);
  assert.equal(app.getStore().settings.retention, 85);
  assert.equal(app.getCurrentPace().key, 'light');
  app.applyPacePreset('strict');
  assert.equal(app.getStore().settings.threshold, 5);
  assert.equal(app.getStore().settings.retention, 93);
  assert.equal(app.getCurrentPace().key, 'strict');
  app.applyPacePreset('standard');
  assert.equal(app.getCurrentPace().key, 'standard');

  // mergeWordlists deduplicates by ID, unions tags, prefers richer entries, and deduplicates distractors.
  const mergedLists = app.mergeWordlists([
    {
      meta: { shortName: '四级词汇' },
      words: [
        { id: 'abandon', word: 'abandon', pos: 'v.', meaning: '放弃', tags: ['拼写'] },
        { id: 'cet4only', word: 'cet4only', pos: 'n.', meaning: '四级专有', example: 'A cet4only sample sentence here.', exampleZh: '例句', tags: ['拼写'] }
      ]
    },
    {
      meta: { shortName: '六级词汇' },
      words: [
        { id: 'abandon', word: 'abandon', pos: 'v.', meaning: '放弃；抛弃', example: 'Do not abandon hope in hard times.', exampleZh: '困难时不要放弃希望。', tags: ['只认'] },
        { id: 'ieltsword', word: 'ieltsword', pos: 'adj.', meaning: '雅思词汇', tags: ['只认'] }
      ]
    }
  ], [
    { w: 'd1', pos: 'n.', meaning: '干扰1' },
    { w: 'd1', pos: 'n.', meaning: '干扰1' },
    { w: 'd2', pos: 'v.', meaning: '干扰2' }
  ]);
  assert.equal(mergedLists.words.length, 3);
  const abandonMerged = mergedLists.words.find(w => w.id === 'abandon');
  assert.deepEqual(plain(abandonMerged.tags), ['拼写']);
  assert.deepEqual(plain(mergedLists.words.find(w => w.id === 'ieltsword').tags), ['只认']);
  assert.equal(abandonMerged.meaning, '放弃；抛弃');
  assert.equal(mergedLists.distractors.length, 2);
  assert.deepEqual(plain(mergedLists.meta.sources), ['四级词汇', '六级词汇']);

  // Local wordbook isolation & autoSync skipping.
  const localId = 'local:testbook1';
  const reg = app.loadWordbooks();
  reg.books[localId] = { id: localId, type: 'local', name: '四级 + 六级词汇', sources: ['四级词汇', '六级词汇'], wordCount: 3 };
  app.saveWordbooks(reg);
  storage.set('worddrill.v1:' + encodeURIComponent(localId), JSON.stringify({
    ...plain(app.defaultStore()),
    words: { abandon: { ...rec('recognize'), lastSeen: initialTime + 5000, correct: 4 } }
  }));
  app.saveVocabularyLocal(mergedLists, localId);
  await app.selectWordbook(localId);
  assert.equal(app.isCloudBook(), false);
  assert.equal(app.getVocabulary().words.length, 3);
  assert.equal(app.getStore().words.abandon.correct, 4);
  assert.equal(app.getStore().words.midterm, undefined);
  let unexpectedNetworkCalls = 0;
  context.fetch = async () => { unexpectedNetworkCalls++; return { ok: true, json: async () => ({}) }; };
  await app.autoSync(true);
  assert.equal(unexpectedNetworkCalls, 0, 'local wordbook never triggers cloud autoSync');

  // 3-mode spelling requirement: auto (per spelling tag), all (force spelling), off (recognize only).
  app.setWords([
    { id: 'cet6only', word: 'cet6only', meaning: '只认词1', tags: ['只认'] },
    { id: 'recOnly', word: 'recOnly', meaning: '只认词2', tags: ['只认'] },
    { id: 'spellWord', word: 'spellWord', meaning: '拼写词', tags: ['拼写'] }
  ]);
  reset({
    cet6only: { ...rec('mastered'), masteredBy: 'recognize' },
    recOnly: { ...rec('mastered'), masteredBy: 'recognize' }
  });
  assert.equal(app.requiresWriting('cet6only'), false);
  assert.equal(app.requiresWriting('recOnly'), false);
  assert.equal(app.requiresWriting('spellWord'), true);
  app.getStore().settings.spelling = 'all';
  assert.equal(app.requiresWriting('cet6only'), true);
  assert.equal(app.requiresWriting('recOnly'), true);
  assert.equal(app.progressOf('cet6only').stage, 'write');
  const allSpellPayload = plain(app.buildPayload());
  assert.equal(allSpellPayload.settings.spelling, 'all');
  reset();
  app.mergeRemote({ ...allSpellPayload, settingsAt: initialTime + 1000 });
  assert.equal(app.getStore().settings.spelling, 'all');

  // Wordbook bundle export/import includes both vocabulary and progress; progress-only JSON is rejected.
  const bundle = app.buildWordbookBundle({
    book: { name: '测试导出词库', type: 'local', sources: ['四级词汇'] },
    vocab: mergedLists,
    progress: app.getStore()
  });
  const parsedBundle = app.parseWordbookBundle(plain(bundle));
  assert.equal(parsedBundle.name, '测试导出词库');
  assert.equal(parsedBundle.vocabulary.words.length, 3);
  assert.equal(parsedBundle.progress.settings.spelling, 'all');
  assert.throws(() => app.parseWordbookBundle(plain(app.defaultStore())), /单词表与学习进度/);

  // planCloudUpload supports append (add new words + merge progress), replace (replace words, keep/merge progress), and overwrite (replace both words & progress).
  const localVocabPlan = {
    meta: { name: '本地合并词库' },
    words: [
      { id: 'shared', word: 'shared', pos: 'n.', meaning: '本地新释义', tags: ['CET4'] },
      { id: 'localonly', word: 'localonly', pos: 'v.', meaning: '仅本地词', tags: ['IELTS'] }
    ],
    distractors: [{ w: 'dx', pos: 'n.', meaning: '新干扰' }]
  };
  const localProgPlan = {
    ...plain(app.defaultStore()),
    words: {
      shared: { ...rec('write'), lastSeen: initialTime - 1000, correct: 9, wrong: 2 },
      localonly: { ...rec('recognize'), lastSeen: initialTime, correct: 2 }
    }
  };
  const remoteVocabPlan = {
    meta: { name: '云端原有' },
    words: [
      { id: 'shared', word: 'shared', pos: 'n.', meaning: '云端旧释义', tags: ['CET4'] },
      { id: 'remoteonly', word: 'remoteonly', pos: 'adj.', meaning: '仅云端词', tags: ['CET6'] }
    ],
    distractors: [{ w: 'dy', pos: 'v.', meaning: '旧干扰' }]
  };
  const remoteProgPlan = {
    ...plain(app.defaultStore()),
    words: {
      shared: { ...rec('mastered'), lastSeen: initialTime + 1000, correct: 12, wrong: 1 },
      remoteonly: { ...rec('recognize'), lastSeen: initialTime, correct: 3 }
    }
  };

  // 1) append
  const planAppend = app.planCloudUpload({
    localVocab: localVocabPlan, localProgress: localProgPlan,
    remoteVocab: remoteVocabPlan, remoteProgress: remoteProgPlan, mode: 'append'
  });
  assert.deepEqual(plain(planAppend.summary), {
    remoteCount: 2, localCount: 2, added: 1, kept: 2, removed: 0, finalCount: 3,
    progressAction: '保留云端已有进度并与本地合并'
  });
  assert.equal(planAppend.wordsData.words.find(w => w.id === 'shared').meaning, '云端旧释义');
  assert.equal(planAppend.progress.words.shared.stage, 'mastered', 'append keeps newer remote stage');
  assert.ok(planAppend.progress.words.localonly && planAppend.progress.words.remoteonly);

  // 2) replace (replace words, keep/merge progress for retained words)
  const planReplace = app.planCloudUpload({
    localVocab: localVocabPlan, localProgress: localProgPlan,
    remoteVocab: remoteVocabPlan, remoteProgress: remoteProgPlan, mode: 'replace'
  });
  assert.deepEqual(plain(planReplace.summary), {
    remoteCount: 2, localCount: 2, added: 1, kept: 1, removed: 1, finalCount: 2,
    progressAction: '保留同词云端历史进度并与本地合并'
  });
  assert.equal(planReplace.wordsData.words.some(w => w.id === 'remoteonly'), false);
  assert.equal(planReplace.wordsData.words.find(w => w.id === 'shared').meaning, '本地新释义');
  assert.equal(planReplace.progress.words.shared.stage, 'mastered');
  assert.equal(planReplace.progress.words.remoteonly, undefined);

  // 3) overwrite (replace both words and progress with local)
  const planOverwrite = app.planCloudUpload({
    localVocab: localVocabPlan, localProgress: localProgPlan,
    remoteVocab: remoteVocabPlan, remoteProgress: remoteProgPlan, mode: 'overwrite'
  });
  assert.deepEqual(plain(planOverwrite.summary), {
    remoteCount: 2, localCount: 2, added: 1, kept: 1, removed: 1, finalCount: 2,
    progressAction: '全部进度覆写为本地状态'
  });
  assert.equal(planOverwrite.wordsData.words.some(w => w.id === 'remoteonly'), false);
  assert.equal(planOverwrite.progress.words.shared.stage, 'write');
  assert.equal(planOverwrite.progress.words.remoteonly, undefined);

  // End-to-end uploadLocalToCloud including >1MB git/blobs fallback read and private-repo enforcement.
  const uploadRepoFiles = {
    'data/words.json': { sha: 'w-sha-1', content: '', blobSha: 'blob-w-1', data: remoteVocabPlan },
    'progress.json': { sha: 'p-sha-1', data: remoteProgPlan }
  };
  const writtenFiles = {};
  context.fetch = async (url, options = {}) => {
    if (url.endsWith('/repos/test/cloud-target')) {
      return { ok: true, json: async () => ({ full_name: 'test/cloud-target', private: true, permissions: { push: true } }) };
    }
    if (url.includes('/branches/main')) return { ok: true, json: async () => ({ name: 'main' }) };
    if (url.includes('/git/blobs/blob-w-1')) {
      return { ok: true, json: async () => ({ content: Buffer.from(JSON.stringify(uploadRepoFiles['data/words.json'].data)).toString('base64') }) };
    }
    if (options.method === 'PUT') {
      const m = url.match(/\/contents\/(.+)$/);
      const body = JSON.parse(options.body);
      writtenFiles[m[1]] = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      return { ok: true, json: async () => ({ content: { sha: 'new-sha' } }) };
    }
    const m = url.match(/\/contents\/([^?]+)/);
    const f = m && uploadRepoFiles[m[1]];
    if (!f) return { ok: false, status: 404 };
    if (f.blobSha) return { ok: true, json: async () => ({ sha: f.blobSha, content: '' }) };
    return { ok: true, json: async () => ({ sha: f.sha, content: Buffer.from(JSON.stringify(f.data)).toString('base64') }) };
  };

  const uploadRes = await app.uploadLocalToCloud({
    localBookId: localId,
    targetConfig: { owner: 'test', repo: 'cloud-target', branch: 'main', path: 'progress.json', token: 'tok' },
    mode: 'append'
  });
  assert.equal(uploadRes.plan.summary.finalCount, 5);
  assert.equal(writtenFiles['data/words.json'].words.length, 5);
  assert.equal(writtenFiles['data/distractors.json'].words.length, 2);
  assert.ok(writtenFiles['progress.json'].words.abandon && writtenFiles['progress.json'].words.shared);
  assert.ok(storage.get('worddrill.backup.before-v6:' + encodeURIComponent(uploadRes.targetRepoId)), 'backs up remote progress before upload');
  assert.ok(app.loadWordbooks().books[localId], 'local wordbook stays intact after cloud upload');

  // Difficulty-aware daily new-word scheduling (balanced / easy_first / hard_first) & anti-interference spacing.
  const eEasy = { id: 'book', word: 'book', meaning: '书', difficulty: 1, freq: 300, tags: ['拼写'] };
  const eHard = { id: 'obfuscate', word: 'obfuscate', meaning: '使模糊；使困惑；弄糊涂', difficulty: 5, freq: 45000, tags: ['拼写'] };
  const hEasy = { id: 'cat', word: 'cat', meaning: '猫', tags: ['只认'] };
  const hHard = { id: 'counterproductive', word: 'counterproductive', meaning: '适得其反的；产生相反效果的；无效的', tags: ['拼写'] };
  assert.ok(app.wordDifficulty(eEasy) < app.wordDifficulty(eHard), 'explicit difficulty & freq rank easy below hard');
  assert.ok(app.wordDifficulty(hEasy) < app.wordDifficulty(hHard), 'heuristic fallback ranks short recognize word below long spelling word');

  const pool20 = [
    { id: 'easy-a', word: 'apple', meaning: '苹果', difficulty: 1, freq: 400 },
    { id: 'easy-b', word: 'bread', meaning: '面包', difficulty: 1, freq: 900 },
    { id: 'easy-c', word: 'chair', meaning: '椅子', difficulty: 1, freq: 1500 },
    { id: 'easy-d', word: 'drink', meaning: '喝', difficulty: 1, freq: 2000 },
    { id: 'easy-e', word: 'earth', meaning: '地球', difficulty: 2, freq: 3600 },
    { id: 'easy-f', word: 'frame', meaning: '框架', difficulty: 2, freq: 5000 },
    { id: 'easy-g', word: 'green', meaning: '绿色', difficulty: 2, freq: 6500 },
    { id: 'med-a', word: 'harvest', meaning: '收获', difficulty: 3, freq: 11000 },
    { id: 'med-b', word: 'inspire', meaning: '鼓舞', difficulty: 3, freq: 13000 },
    { id: 'med-c', word: 'journal', meaning: '期刊', difficulty: 3, freq: 15000 },
    { id: 'med-d', word: 'kinetic', meaning: '运动的', difficulty: 3, freq: 17000 },
    { id: 'med-e', word: 'lantern', meaning: '灯笼', difficulty: 3, freq: 19000 },
    { id: 'med-f', word: 'migrate', meaning: '迁移', difficulty: 3, freq: 20500 },
    { id: 'med-g', word: 'nurture', meaning: '培育', difficulty: 3, freq: 21500 },
    { id: 'med-h', word: 'obscure', meaning: '模糊的', difficulty: 4, freq: 24000 },
    { id: 'hard-a', word: 'palpable', meaning: '明显的', difficulty: 4, freq: 30000 },
    { id: 'hard-b', word: 'quixotic', meaning: '不切实际的', difficulty: 5, freq: 38000 },
    { id: 'hard-c', word: 'recalcitrant', meaning: '顽抗的', difficulty: 5, freq: 42000 },
    { id: 'hard-d', word: 'sycophant', meaning: '马屁精', difficulty: 5, freq: 46000 },
    { id: 'hard-e', word: 'ubiquitous', meaning: '无处不在的', difficulty: 5, freq: 49000 }
  ];

  const pickedBalanced = app.selectDailyNewWords(pool20, 10, 'balanced', initialTime);
  assert.equal(pickedBalanced.length, 10);
  const balancedDiffs = pickedBalanced.map(w => w.difficulty);
  assert.ok(balancedDiffs.some(d => d <= 2) && balancedDiffs.some(d => d === 3) && balancedDiffs.some(d => d >= 4),
    'balanced mode mixes easy, medium, and hard words');

  const pickedEasy = app.selectDailyNewWords(pool20, 6, 'easy_first', initialTime);
  assert.equal(pickedEasy.length, 6);
  assert.ok(pickedEasy.every(w => w.difficulty <= 2), 'easy_first prioritizes easiest words');

  const pickedHard = app.selectDailyNewWords(pool20, 5, 'hard_first', initialTime);
  assert.equal(pickedHard.length, 5);
  assert.ok(pickedHard.every(w => w.difficulty >= 4), 'hard_first prioritizes hardest words');

  // Prefix anti-interference avoids clustering adapt/adopt/adept when diverse prefixes exist.
  const clusterPool = [
    { id: 'ada1', word: 'adapt', meaning: '适应', difficulty: 1, freq: 100 },
    { id: 'ada2', word: 'adaptive', meaning: '适应的', difficulty: 1, freq: 110 },
    { id: 'ada3', word: 'adaptor', meaning: '适配器', difficulty: 1, freq: 120 },
    { id: 'brv1', word: 'brave', meaning: '勇敢', difficulty: 1, freq: 200 },
    { id: 'cln1', word: 'clean', meaning: '干净', difficulty: 1, freq: 210 },
    { id: 'drk1', word: 'drink', meaning: '喝', difficulty: 1, freq: 220 }
  ];
  const spaced = app.selectDailyNewWords(clusterPool, 4, 'easy_first', initialTime);
  const adaCount = spaced.filter(w => w.word.startsWith('ada')).length;
  assert.equal(adaCount, 1, 'only one word from the same 3-letter prefix cluster when alternatives exist');

  // newOrder persists and syncs across devices.
  reset();
  app.getStore().settings.newOrder = 'hard_first';
  app.getStore().settingsAt = initialTime + 2000;
  const orderPayload = plain(app.buildPayload());
  assert.equal(orderPayload.settings.newOrder, 'hard_first');
  reset();
  app.mergeRemote(orderPayload);
  assert.equal(app.getStore().settings.newOrder, 'hard_first');

  // switchView resets scroll to top instead of scrolling down via #main.scrollIntoView.
  let scrolledTo = null;
  let mainScrollIntoViewCount = 0;
  context.window.scrollTo = (opts) => { scrolledTo = opts; };
  element('#main').scrollIntoView = () => { mainScrollIntoViewCount++; };
  app.switchView('books');
  assert.deepEqual(plain(scrolledTo), { top: 0, behavior: 'auto' });
  assert.equal(mainScrollIntoViewCount, 0);

  // resetBookProgress clears a target book independently without disturbing another book.
  const otherId = 'local:reset-target';
  const activeId = 'local:reset-active';
  storage.set('worddrill.wordbooks.v1', JSON.stringify({
    activeId,
    books: {
      [activeId]: { id: activeId, type: 'local', name: 'A' },
      [otherId]: { id: otherId, type: 'local', name: 'B' }
    }
  }));
  storage.set('worddrill.v1:' + encodeURIComponent(otherId), JSON.stringify({
    ...plain(app.defaultStore()),
    words: { temp: rec() }
  }));
  reset({ keepme: rec() });
  context.confirm = () => true;
  await app.selectWordbook(activeId);
  app.getStore().words.keepme = rec();
  app.saveStore();
  app.resetBookProgress(otherId);
  const afterOther = JSON.parse(storage.get('worddrill.v1:' + encodeURIComponent(otherId)));
  assert.deepEqual(afterOther.words, {}, 'inactive book progress is cleared');
  assert.ok(app.getStore().words.keepme, 'active book progress remains untouched');

  // Manual sync runs even when auto-sync (enabled) is turned off.
  cloud = { words: { manualCheck: rec() } };
  app.selectRepository({ enabled: false, owner: 'test', repo: 'manual-repo', branch: 'main', path: 'progress.json', token: 'tok', deviceId: 'check' });
  const toB64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  context.fetch = async (url) => {
    if (!url.includes('/contents/')) return { ok: true, json: async () => ({ private: true }) };
    if (url.includes('words.json')) return { ok: true, json: async () => ({ content: toB64(JSON.stringify({ words: trainingWords })), sha: 'w' }) };
    if (url.includes('distractors.json')) return { ok: true, json: async () => ({ content: toB64(JSON.stringify({ words: [] })), sha: 'd' }) };
    if (url.includes('cet-pending.json')) return { ok: false, status: 404 };
    if (url.includes('progress.json')) return { ok: true, json: async () => ({ content: toB64(JSON.stringify({ ...plain(app.defaultStore()), words: cloud.words })), sha: 'p' }) };
    return { ok: true, json: async () => ({ sha: 'p2' }) };
  };
  await app.syncNow({ silent: true, manual: true });
  assert.ok(app.getStore().words.manualCheck, 'manual sync pulls even when auto-sync is off');

  // iOS PWA guide visibility checks across Safari, Chrome/in-app, standalone PWA, desktop, and native wrappers.
  const iosSafari = app.getIosPwaState({
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' },
    window: {},
    localStorage: { getItem: () => null }
  });
  assert.equal(iosSafari.showBanner, true);
  assert.equal(iosSafari.isSafari, true);

  const iosChrome = app.getIosPwaState({
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0 Mobile/15E148 Safari/604.1' },
    window: {},
    localStorage: { getItem: () => null }
  });
  assert.equal(iosChrome.showBanner, true);
  assert.equal(iosChrome.isSafari, false);

  const iosStandalone = app.getIosPwaState({
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)', standalone: true },
    window: {},
    localStorage: { getItem: () => null }
  });
  assert.equal(iosStandalone.showBanner, false);
  assert.equal(iosStandalone.showSettingsEntry, false);

  const iosNative = app.getIosPwaState({
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)' },
    window: { WordDrillNative: { platform: 'windows' } },
    localStorage: { getItem: () => null }
  });
  assert.equal(iosNative.showBanner, false);

  // Native local disk bridge: syncs local wordbooks to disk, hydrates from disk on boot, and falls back to native TTS.
  const diskFiles = new Map();
  let spokenNative = '';
  const sampleDiskBundle = app.buildWordbookBundle({
    book: { id: 'local:disk1', type: 'local', name: 'Disk Book', sources: ['CET4'], createdAt: initialTime },
    vocab: { meta: { name: 'Disk Book', count: 1 }, words: [{ id: 'diskword', word: 'diskword', meaning: '磁盘词' }], distractors: [] },
    progress: { ...plain(app.defaultStore()), words: { diskword: rec() } }
  });
  diskFiles.set('Disk-Book__disk1.json', JSON.stringify(sampleDiskBundle));

  context.window.WordDrillNative = {
    platform: 'windows',
    getWordbooksDir: async () => 'C:\\Users\\test\\Documents\\WordDrill\\wordbooks',
    openWordbooksDir: async () => ({ ok: true }),
    listWordbookFiles: async () => Array.from(diskFiles.entries()).map(([name, content]) => ({ name, content })),
    writeWordbookBundle: async (bookId, fileName, content) => {
      const shortId = String(bookId).replace(/^local:/, '');
      for (const k of diskFiles.keys()) { if (k.endsWith(`__${shortId}.json`)) diskFiles.delete(k); }
      diskFiles.set(fileName, content);
      return { ok: true, path: fileName };
    },
    deleteWordbookBundle: async (bookId) => {
      const shortId = String(bookId).replace(/^local:/, '');
      for (const k of diskFiles.keys()) { if (k.endsWith(`__${shortId}.json`)) diskFiles.delete(k); }
      return { ok: true };
    },
    speak: async (text) => { spokenNative = text; return true; }
  };

  await app.hydrateNativeWordbooksOnBoot();
  assert.ok(app.loadWordbooks().books['local:disk1'], 'hydrates local wordbook bundle found on native disk');
  assert.equal(elements.get('#native-storage-bar').hidden, false);
  await app.syncBookToNativeDisk('local:disk1');
  assert.ok(Array.from(diskFiles.keys()).some((k) => k.endsWith('__disk1.json')));
  await app.deleteBookFromNativeDisk('local:disk1');
  assert.equal(Array.from(diskFiles.keys()).some((k) => k.endsWith('__disk1.json')), false);

  const prevSpeech = context.window.speechSynthesis;
  delete context.window.speechSynthesis;
  assert.equal(app.canSpeak(), true);
  app.speak('nativehello');
  assert.equal(spokenNative, 'nativehello', 'native TTS bridge speaks when speechSynthesis is absent');
  if (prevSpeech) context.window.speechSynthesis = prevSpeech;
  delete context.window.WordDrillNative;

  console.log(`Learning checks passed; ${Object.keys(old.words).length} legacy records preserved.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
