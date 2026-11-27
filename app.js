/* ============================================================
   WordDrill — app
   四级 / 手动词：认 → 写；六级词：只认
   调度：FSRS-6；支持本地词库（IndexedDB）与私有 GitHub 云端词库
   ============================================================ */
(() => {
  'use strict';

  /* ---------- 常量 ---------- */
  const STORE_KEY = 'worddrill.v1';
  const BOOKS_KEY = 'worddrill.wordbooks.v1';
  const DEFAULT_WORDLIST_REPO = 'DrivingGodJ/worddrill-wordlists';
  const DEFAULT_WORDLIST_BRANCH = 'main';
  const LIB_PAGE_SIZE = 100;

  const STAGES = ['new', 'recognize', 'write', 'mastered'];
  const STAGE_LABEL = {
    new: '未开始',
    recognize: '认词中',
    write: '拼写中',
    mastered: '已掌握'
  };
  const STAGE_BADGE = { recognize: '认词', write: '拼写', mastered: '巩固' };
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // 答对天数保留，不再过期或因一次答错清零。升阶还要求 FSRS 的稳定性达标。
  const PROMOTION_STABILITY = { recognize: 7, write: 21 };
  const CREDIT_NEED_MIN = 2, CREDIT_NEED_MAX = 10, CREDIT_NEED_DEFAULT = 3;
  const REQUESTS_PER_ROUND = 40;   // 单轮最大题量，避免无限循环

  // 直观复习节奏预设（映射到内部 threshold + retention）
  const PACE_PRESETS = {
    light: { label: '轻松', threshold: 2, retention: 85 },
    standard: { label: '标准', threshold: 3, retention: 90 },
    strict: { label: '严格', threshold: 5, retention: 93 }
  };

  /* ---------- 多设备同步（GitHub 私有仓库当存储） ---------- */
  const SYNC_KEY = 'worddrill.sync.v1';
  const SYNC_API = 'https://api.github.com';
  /** 学习参数才同步；主题/发音是设备偏好，各设备自己存 */
  const SYNCED_SETTINGS = ['newLimit', 'threshold', 'retention', 'spelling'];
  /** 拼写要求：auto = 按词表标签判定（六级词只认，四级/手动词要拼）；off = 本词表全部只认不拼。 */
  const SPELLING_MODES = ['auto', 'off'];
  const normSpelling = (v) => (SPELLING_MODES.includes(v) ? v : 'auto');
  /** 学习参数的合法区间 */
  const SETTING_RANGE = { newLimit: [0, 40], threshold: [CREDIT_NEED_MIN, CREDIT_NEED_MAX], retention: [80, 95] };

  function clampSetting(k, v) {
    const r = SETTING_RANGE[k];
    const n = Number(v);
    if (!r || !isFinite(n)) return undefined;
    return Math.min(r[1], Math.max(r[0], Math.round(n)));
  }

  function normalizeSettings(s) {
    for (const k of Object.keys(SETTING_RANGE)) {
      const c = clampSetting(k, s[k]);
      s[k] = c === undefined ? defaultStore().settings[k] : c;
    }
    s.spelling = normSpelling(s.spelling);
    return s;
  }

  /* ---------- 状态 ---------- */
  let WORDS = [];          // 当前词库单词
  let META = {};
  let PENDING = [];
  let activeRepository = '';
  const repositoryId = (config = sync) => config?.owner && config?.repo
    ? `${config.owner.toLowerCase()}/${config.repo.toLowerCase()}@${config.branch || 'main'}:${config.path || 'progress.json'}` : '';
  const isCloudBook = (id = activeRepository) => {
    if (id && String(id).startsWith('local:')) return false;
    return !!(id || (sync?.owner && sync?.repo));
  };
  const scopedKey = (key, scope = activeRepository) => scope ? `${key}:${encodeURIComponent(scope)}` : key;
  let DISTRACTORS = [];    // 词库外的干扰释义池
  const byId = new Map();
  let store = null;        // 持久化状态
  let storeMigrated = false;
  let sync = null;         // 当前云端仓库配置（token 只在本机）
  let syncing = false;
  let syncQueued = false;
  let lastAutoSyncAt = 0;
  let session = null;      // 当前会话
  let libFilter = 'all';
  let libQuery = '';
  let libVisibleCount = LIB_PAGE_SIZE;
  let summaryMistakes = [];

  // 词库管理弹窗状态
  let catalogState = { repo: DEFAULT_WORDLIST_REPO, branch: DEFAULT_WORDLIST_BRANCH, data: null, nameEdited: false };
  let uploadState = {
    localBookId: '', localVocab: null, localProgress: null,
    targetConfig: null, remoteVocab: null, remoteProgress: null,
    remoteWordsSha: null, remoteDistractorsSha: null, remoteProgressSha: null,
    ready: false
  };

  /* ---------- 工具 ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const now = () => Date.now();

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function toast(msg, ms = 2200) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('is-show'));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.classList.remove('is-show');
      setTimeout(() => { el.hidden = true; }, 240);
    }, ms);
  }

  /* ---------- IndexedDB 大词库缓存（兼容 Node 测试与无 IDB 环境） ---------- */
  const vocabDB = (() => {
    let dbPromise = null;
    const open = () => {
      if (typeof indexedDB === 'undefined') return Promise.resolve(null);
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open('worddrill-db', 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('vocabularies')) db.createObjectStore('vocabularies');
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
      return dbPromise;
    };
    const run = async (mode, fn) => {
      const db = await open();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction('vocabularies', mode);
          const st = tx.objectStore('vocabularies');
          const req = fn(st);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    };
    return {
      get: (key) => run('readonly', (s) => s.get(key)),
      set: (key, value) => run('readwrite', (s) => s.put(value, key)),
      del: (key) => run('readwrite', (s) => s.delete(key))
    };
  })();

  /* ---------- 持久化 ---------- */
  const STORE_VERSION = 6;
  const BACKUP_KEY = 'worddrill.backup.before-v6';

  function defaultStore() {
    return {
      version: STORE_VERSION,
      settings: { newLimit: 10, threshold: CREDIT_NEED_DEFAULT, retention: 90, speak: true, spelling: 'auto' },
      settingsAt: 0,
      cet: { approved: [], rejected: [] },
      words: {},
      stats: { answers: 0, correct: 0, sessions: 0, lastDate: null, streakDays: 0 }
    };
  }

  function migrateStore(s, fromVersion) {
    if ((fromVersion || 1) >= STORE_VERSION) return false;
    s.version = STORE_VERSION;
    if ((fromVersion || 1) < 5) {
      s.settings.threshold = CREDIT_NEED_DEFAULT;
      s.settings.retention = 90;
      s.settingsAt = now();
    }
    return true;
  }

  function readStore(parsed) {
    if (!parsed || typeof parsed !== 'object' || !parsed.words
        || typeof parsed.words !== 'object' || Array.isArray(parsed.words)) {
      throw new Error('进度文件格式不对');
    }
    if (Number(parsed.version) > STORE_VERSION) throw new Error('进度来自更新版本，请先更新本站');
    const merged = Object.assign(defaultStore(), parsed, {
      settings: Object.assign(defaultStore().settings, parsed.settings || {}),
      stats: Object.assign(defaultStore().stats, parsed.stats || {}),
      words: Object.fromEntries(Object.entries(parsed.words).map(([id, p]) => {
        if (!p || typeof p !== 'object' || !STAGES.includes(p.stage || 'new')
            || (p.masteredBy !== undefined && !['recognize', 'write'].includes(p.masteredBy))) {
          throw new Error('词条进度格式不对');
        }
        return [id, normalRec(p)];
      }))
    });
    if (!merged.cet || !Array.isArray(merged.cet.approved) || !Array.isArray(merged.cet.rejected)) {
      merged.cet = { approved: [], rejected: [] };
    }
    normalizeSettings(merged.settings);
    return merged;
  }

  function keepBackup(raw, scope = activeRepository) {
    if (raw && !localStorage.getItem(scopedKey(BACKUP_KEY, scope))) {
      localStorage.setItem(scopedKey(BACKUP_KEY, scope), raw);
    }
  }

  function loadStore(scope = activeRepository) {
    const raw = localStorage.getItem(scopedKey(STORE_KEY, scope));
    if (!raw) return defaultStore();
    const parsed = JSON.parse(raw);
    const merged = readStore(parsed);
    if ((parsed.version || 1) < STORE_VERSION) {
      keepBackup(raw, scope);
      storeMigrated = migrateStore(merged, parsed.version);
    }
    return merged;
  }

  function saveStore() {
    try {
      localStorage.setItem(scopedKey(STORE_KEY), JSON.stringify(store));
    } catch {
      toast('进度保存失败：浏览器存储空间不足');
    }
  }

  function requiresWriting(id) {
    if (store?.settings?.spelling === 'off') return false;
    const tags = byId.get(id)?.tags || [];
    if (tags.includes('只认')) return false;
    return !tags.includes('CET6') || tags.includes('CET4')
      || tags.includes('手动添加') || tags.some((tag) => /^Unit\d+$/i.test(tag));
  }

  function progressOf(id, targetStore = store) {
    const p = targetStore.words[id] || {
      stage: 'new', credits: [],
      correct: 0, wrong: 0, due: 0, lastSeen: 0, introducedAt: 0
    };
    if (!requiresWriting(id) && p.stage === 'write') {
      return { ...p, stage: 'mastered', masteredBy: 'recognize' };
    }
    if (requiresWriting(id) && p.stage === 'mastered' && p.masteredBy === 'recognize') {
      return { ...p, stage: 'write', credits: [], memory: undefined, due: 0 };
    }
    return p;
  }

  /* ---------- SRS 引擎 ---------- */
  const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const creditNeed = () =>
    Math.min(CREDIT_NEED_MAX, Math.max(CREDIT_NEED_MIN, Number(store.settings.threshold) || CREDIT_NEED_DEFAULT));

  const needsCredits = (stage) => stage === 'recognize' || stage === 'write';

  function scheduler() {
    return FSRS.fsrs({ request_retention: store.settings.retention / 100,
      enable_fuzz: false, enable_short_term: true, learning_steps: ['1m', '10m'], relearning_steps: ['10m'] });
  }

  function schedule(p, rating, at) {
    const card = p.memory || FSRS.createEmptyCard(new Date(at));
    const result = scheduler().next(card, new Date(at), rating).card;
    return { ...result, due: +result.due, last_review: +result.last_review };
  }

  const dailyWordTarget = () => Math.max(0, Math.min(80, Number(META.dailyWordTarget) || 0));
  const studyDayKey = (ts) => new Date(ts + 8 * 60 * MIN).toISOString().slice(0, 10);

  function dailyCoverage(t = now()) {
    const today = studyDayKey(t);
    let seen = 0, due = 0;
    for (const w of WORDS) {
      const p = progressOf(w.id);
      if (p.lastSeen && studyDayKey(p.lastSeen) === today) seen++;
      else if ((p.stage !== 'new' || p.introducedAt) && p.due <= t) due++;
    }
    return { seen, due };
  }

  function newAllowance(t = now()) {
    const started = Object.values(store.words).filter((p) => p.introducedAt && dayKey(p.introducedAt) === dayKey(t)).length;
    const { seen, due } = dailyCoverage(t);
    return Math.max(0, store.settings.newLimit - started, dailyWordTarget() - seen - due);
  }

  function grade(id, isCorrect, aided = false, practice = false) {
    const before = progressOf(id);
    const after = { ...before, credits: [...before.credits] };
    const at = now();
    const need = creditNeed();
    let promoted = false, demoted = false, credited = false;

    after.lastSeen = at;
    if (!practice && before.stage === 'new' && !after.introducedAt) after.introducedAt = at;
    store.stats.answers++;
    if (isCorrect) store.stats.correct++;
    if (isCorrect) after.correct++;
    else after.wrong++;

    if (!practice) {
      after.memory = schedule(before, isCorrect && !aided ? FSRS.Rating.Good : FSRS.Rating.Again, at);
      after.due = after.memory.due;
    }
    if (isCorrect && !practice && !aided) {
      if (after.stage === 'new') {
        after.stage = 'recognize';
        after.credits = [];
        promoted = true;
      } else if (needsCredits(after.stage) && before.due <= at) {
        if (!after.credits.some((ts) => dayKey(ts) === dayKey(at))) {
          after.credits.push(at);
          credited = true;
        }
        if (credited && after.credits.length >= need
            && after.memory.stability >= PROMOTION_STABILITY[after.stage]
            && after.memory.state === FSRS.State.Review) {
          after.stage = after.stage === 'recognize' && requiresWriting(id) ? 'write' : 'mastered';
          after.masteredBy = after.stage === 'mastered' ? (requiresWriting(id) ? 'write' : 'recognize') : undefined;
          after.credits = [];
          promoted = true;
          if (after.stage === 'write') {
            after.memory = undefined;
            after.due = at + 10 * MIN;
          }
        }
      }
    } else if (!isCorrect && !practice) {
      after.credits = after.credits.filter((ts) => dayKey(ts) !== dayKey(at));
      if (after.stage === 'mastered') {
        after.stage = requiresWriting(id) ? 'write' : 'recognize';
        after.masteredBy = undefined;
        demoted = true;
      }
    }

    store.words[id] = after;
    saveStore();
    return { before, after, promoted, demoted, credited, aided, practice, need };
  }

  function quizTypeFor(id, stage) {
    if (requiresWriting(id) && (stage === 'write' || stage === 'mastered')) return 'spell';
    return 'recognize';
  }

  function posKey(pos) {
    return String(pos || '').split('/')[0].trim();
  }

  /* ---------- 出题 ---------- */
  function buildRecognizeQuestion(word) {
    const key = posKey(word.pos);
    const others = WORDS.filter((w) => w.id !== word.id);
    const inSame = shuffle(others.filter((w) => posKey(w.pos) === key)).map((w) => w.meaning);
    const inRest = shuffle(others.filter((w) => posKey(w.pos) !== key)).map((w) => w.meaning);
    const outSame = shuffle(DISTRACTORS.filter((d) => posKey(d.pos) === key)).map((d) => d.meaning);
    const outRest = shuffle(DISTRACTORS.filter((d) => posKey(d.pos) !== key)).map((d) => d.meaning);

    const outAll = outSame.concat(outRest);
    const inAll = inSame.concat(inRest);
    const wantOutside = outAll.length ? 1 + Math.floor(Math.random() * 2) : 0;

    const used = new Set([word.meaning]);
    const distractors = [];
    const add = (list, limit) => {
      for (const text of list) {
        if (distractors.length >= 3 || distractors.length >= limit) break;
        if (!text || used.has(text)) continue;
        used.add(text);
        distractors.push(text);
      }
    };
    add(outAll, wantOutside);
    add(inAll, 3);
    add(outAll, 3);

    const options = shuffle([
      { text: word.meaning, correct: true },
      ...distractors.map((text) => ({ text, correct: false }))
    ]);
    return { kind: 'recognize', word, options, optionsReady: false };
  }

  function buildSpellQuestion(word) {
    return { kind: 'spell', word, hint: letterHint(word.word) };
  }

  function buildFillQuestion(word) {
    return { kind: 'fill', word, hint: letterHint(word.word) };
  }

  const fillPattern = (word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  const hasFillExample = (word) => !!word.example && fillPattern(word.word).test(word.example)
    && word.example.trim().split(/\s+/).length >= 5
    && /[.!?]["”’']?$/.test(word.example.trim()) && !/…|\.{3}|_/.test(word.example);

  function letterHint(target) {
    const parts = String(target).split(/(\s+)/);
    return parts.map((p) => {
      if (/^\s+$/.test(p)) return p;
      if (p.length <= 1) return p;
      return p[0] + '·'.repeat(p.length - 1);
    }).join('');
  }

  function highlight(example, target) {
    const safe = esc(example);
    if (!target) return safe;
    const pattern = new RegExp(`(${esc(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*)`, 'gi');
    return safe.replace(pattern, '<b>$1</b>');
  }

  function blankExample(example, target) {
    const safe = esc(example);
    const re = fillPattern(esc(target));
    return safe.replace(re, '<b>______</b>');
  }

  /* ---------- 多设备同步与仓库读写 ---------- */
  function randomId() {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function defaultSync() {
    return {
      enabled: false,
      owner: '', repo: '', path: 'progress.json', branch: 'main',
      token: '', deviceId: randomId(),
      lastSyncAt: 0, lastResult: ''
    };
  }

  function loadSync() {
    try {
      const raw = localStorage.getItem(SYNC_KEY);
      if (!raw) return defaultSync();
      return Object.assign(defaultSync(), JSON.parse(raw), { path: 'progress.json' });
    } catch { return defaultSync(); }
  }

  function saveSync() {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); }
    catch { /* 存储被禁用，忽略 */ }
  }

  const b64Encode = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  };

  const b64Decode = (b64) => {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  const syncApiUrl = (path = sync.path || 'progress.json', config = sync) => {
    const p = String(path).replace(/^\/+/, '');
    return `${SYNC_API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${p}`;
  };

  const syncHeaders = (config = sync) => {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
    if (config?.token) headers.Authorization = `Bearer ${config.token}`;
    return headers;
  };

  function syncHttpError(status, hint) {
    if (status === 401) return new Error('token 无效或已过期（401），重新生成一个细粒度 token');
    if (status === 403) return new Error('token 权限不足或请求被限流（403），确认 Contents 设成了 Read and write');
    if (status === 404) {
      return new Error(hint || (
        '看不到这个仓库（404）。注意私有仓库只要 token 没授权就返回 404 而不是 403，'
        + '所以多半不是路径写错。常见原因：① token 的 Repository access 没勾上这个仓库；'
        + '② 用了经典 token 但没给 repo 权限；③ Owner/Repo 拼错。点「测试连接」可精确定位'
      ));
    }
    return new Error(`请求失败（${status}）`);
  }

  function setVocabulary(data) {
    if (!data || !Array.isArray(data.words)) throw new Error('词库格式错误：需要 words 数组');
    const ids = new Set();
    for (const w of data.words) {
      if (!w || typeof w.id !== 'string' || !w.id || ids.has(w.id)
          || typeof w.word !== 'string' || !w.word || typeof w.meaning !== 'string' || !w.meaning) {
        throw new Error('词库存在缺失字段或重复 ID，已保留原词库');
      }
      ids.add(w.id);
    }
    WORDS = data.words; META = data.meta || {};
    DISTRACTORS = data.distractors || [];
    PENDING = data.pending || [];
    byId.clear(); WORDS.forEach(w => byId.set(w.id, w));
  }

  function saveVocabularyLocal(data, scope = activeRepository) {
    const key = scopedKey('worddrill.vocabulary.v1', scope);
    vocabDB.set(scope || 'default', data);
    const json = JSON.stringify(data);
    if (json.length < 450000 || typeof indexedDB === 'undefined') {
      try { localStorage.setItem(key, json); } catch { /* 超额时依赖 IndexedDB */ }
    } else {
      localStorage.removeItem?.(key);
    }
  }

  function restoreVocabulary() {
    const raw = localStorage.getItem(scopedKey('worddrill.vocabulary.v1'));
    setVocabulary(raw ? JSON.parse(raw) : { words: [] });
  }

  async function restoreVocabularyAsync(scope = activeRepository) {
    const idbData = await vocabDB.get(scope || 'default');
    if (idbData && Array.isArray(idbData.words)) {
      setVocabulary(idbData);
      return idbData;
    }
    const raw = localStorage.getItem(scopedKey('worddrill.vocabulary.v1', scope));
    const parsed = raw ? JSON.parse(raw) : { words: [] };
    setVocabulary(parsed);
    if (raw && typeof indexedDB !== 'undefined') vocabDB.set(scope || 'default', parsed);
    return parsed;
  }

  /** 支持读取 >1MB 的 GitHub 文件（content 为空或返回 too_large 时自动走 git/blobs）。 */
  async function remoteReadFile(path, config = sync, optional = false) {
    const branch = config.branch || 'main';
    const headers = syncHeaders(config);
    const res = await fetch(`${syncApiUrl(path, config)}?ref=${encodeURIComponent(branch)}&t=${now()}`,
      { headers, cache: 'no-store' });
    if (optional && res.status === 404) return null;
    if (res.status === 404) return null;
    if (res.status === 403) {
      let errJson = null;
      try { errJson = await res.clone().json(); } catch { errJson = null; }
      const isTooLarge = Array.isArray(errJson?.errors) && errJson.errors.some((e) => e.code === 'too_large');
      if (isTooLarge) {
        const treeRes = await fetch(
          `${SYNC_API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
          { headers, cache: 'no-store' }
        );
        if (!treeRes.ok) throw syncHttpError(treeRes.status, `无法读取大文件 ${path}`);
        const tree = await treeRes.json();
        const node = (tree.tree || []).find((it) => it.path === path);
        if (!node) return optional ? null : (() => { throw syncHttpError(404, `找不到 ${path}`); })();
        const blobRes = await fetch(
          `${SYNC_API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/blobs/${node.sha}`,
          { headers, cache: 'no-store' }
        );
        if (!blobRes.ok) throw syncHttpError(blobRes.status, `无法读取大文件 ${path}`);
        const blob = await blobRes.json();
        return { sha: node.sha, data: JSON.parse(b64Decode(blob.content)) };
      }
    }
    if (!res.ok) throw syncHttpError(res.status, `无法读取 ${path}；确认账号、仓库和 token 的仓库授权`);
    const file = await res.json();
    let contentText;
    if (file.content) {
      contentText = b64Decode(file.content);
    } else if (file.sha) {
      const blobRes = await fetch(
        `${SYNC_API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/git/blobs/${file.sha}`,
        { headers, cache: 'no-store' }
      );
      if (!blobRes.ok) throw syncHttpError(blobRes.status, `无法读取大文件 ${path}`);
      const blob = await blobRes.json();
      contentText = b64Decode(blob.content);
    } else {
      throw new Error(`${path} 内容为空`);
    }
    try { return { sha: file.sha, data: JSON.parse(contentText) }; }
    catch { throw new Error(`${path} 无法解析，已停止同步`); }
  }

  async function remoteWriteFile(path, payload, sha, message, config = sync, pretty = false) {
    const body = {
      message: message || `sync ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      content: b64Encode(pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload)),
      branch: config.branch || 'main'
    };
    if (sha) body.sha = sha;
    const res = await fetch(syncApiUrl(path, config), {
      method: 'PUT', headers: syncHeaders(config), body: JSON.stringify(body)
    });
    if (res.ok) return res.json();
    if (res.status === 409) { const e = new Error('conflict'); e.conflict = true; throw e; }
    throw syncHttpError(res.status);
  }

  async function repositoryJson(path, optional = false) {
    const res = await fetch(`${syncApiUrl(path)}?ref=${encodeURIComponent(sync.branch)}&t=${now()}`,
      { headers: syncHeaders(), cache: 'no-store' });
    if (optional && res.status === 404) return { words: [] };
    if (!res.ok) throw syncHttpError(res.status, `无法读取 ${path}；确认账号、仓库和 token 的仓库授权`);
    const file = await res.json();
    if (!file.content && file.sha) {
      const blobRes = await fetch(
        `${SYNC_API}/repos/${encodeURIComponent(sync.owner)}/${encodeURIComponent(sync.repo)}/git/blobs/${file.sha}`,
        { headers: syncHeaders(), cache: 'no-store' }
      );
      if (!blobRes.ok) throw syncHttpError(blobRes.status, `无法读取 ${path}`);
      const blob = await blobRes.json();
      try { return JSON.parse(b64Decode(blob.content)); }
      catch { throw new Error(`${path} 无法解析，已停止同步`); }
    }
    try { return JSON.parse(b64Decode(file.content)); }
    catch { throw new Error(`${path} 无法解析，已停止同步`); }
  }

  async function loadRepositoryVocabulary() {
    const infoRes = await fetch(`${SYNC_API}/repos/${encodeURIComponent(sync.owner)}/${encodeURIComponent(sync.repo)}`, { headers: syncHeaders(), cache: 'no-store' });
    if (!infoRes.ok) throw syncHttpError(infoRes.status);
    if (!(await infoRes.json()).private) throw new Error('数据仓库必须是私有仓库，已停止同步');
    const [vocab, distractors, pending] = await Promise.all([
      repositoryJson('data/words.json'), repositoryJson('data/distractors.json', true),
      repositoryJson('data/cet-pending.json', true)
    ]);
    const data = { ...vocab, distractors: distractors.words || [], pending: pending.words || [] };
    setVocabulary(data);
    saveVocabularyLocal(data, activeRepository);
    syncWordbooksRegistry();
  }

  function saveProfile() {
    if (!isCloudBook()) return;
    const profiles = JSON.parse(localStorage.getItem('worddrill.repositories.v1') || '{}');
    if (repositoryId()) profiles[repositoryId()] = { ...sync };
    localStorage.setItem('worddrill.repositories.v1', JSON.stringify(profiles));
  }

  /* ---------- 词库注册表（本地词库 + 云端词库） ---------- */
  function loadWordbooks() {
    try {
      const raw = localStorage.getItem(BOOKS_KEY);
      if (!raw) return { activeId: '', books: {} };
      const parsed = JSON.parse(raw);
      return {
        activeId: typeof parsed.activeId === 'string' ? parsed.activeId : '',
        books: parsed.books && typeof parsed.books === 'object' ? parsed.books : {}
      };
    } catch { return { activeId: '', books: {} }; }
  }

  function saveWordbooks(reg) {
    try { localStorage.setItem(BOOKS_KEY, JSON.stringify(reg)); } catch { /* 忽略 */ }
  }

  function syncWordbooksRegistry() {
    const reg = loadWordbooks();
    const profiles = JSON.parse(localStorage.getItem('worddrill.repositories.v1') || '{}');
    for (const [id, p] of Object.entries(profiles)) {
      if (!id || !p?.owner || !p?.repo) continue;
      if (!reg.books[id]) {
        reg.books[id] = {
          id, type: 'cloud', name: `${p.owner}/${p.repo}`,
          createdAt: now(), updatedAt: p.lastSyncAt || 0, wordCount: 0
        };
      } else {
        reg.books[id].type = 'cloud';
        reg.books[id].name = `${p.owner}/${p.repo}`;
        if (p.lastSyncAt) reg.books[id].updatedAt = p.lastSyncAt;
      }
    }
    if (activeRepository) {
      reg.activeId = activeRepository;
      if (reg.books[activeRepository]) {
        reg.books[activeRepository].wordCount = WORDS.length;
      }
    }
    saveWordbooks(reg);
    return reg;
  }

  function getActiveBookInfo() {
    const reg = loadWordbooks();
    if (activeRepository && reg.books[activeRepository]) return reg.books[activeRepository];
    if (isCloudBook() && sync?.owner && sync?.repo) {
      return { id: activeRepository, type: 'cloud', name: `${sync.owner}/${sync.repo}`, wordCount: WORDS.length };
    }
    return null;
  }

  function selectRepository(next) {
    if (syncing || session) throw new Error('请等待当前同步或训练结束后再切换仓库');
    const id = repositoryId(next);
    if (!id) throw new Error('请填写仓库所有者与数据仓库名');
    if ((next.path || 'progress.json') !== 'progress.json') throw new Error('进度文件路径请使用 progress.json');
    if (store) saveStore();
    saveProfile();
    const previous = { id: activeRepository, sync, store, words: WORDS, meta: META, distractors: DISTRACTORS, pending: PENDING };
    try {
      activeRepository = id;
      sync = { ...defaultSync(), ...next };
      store = loadStore();
      restoreVocabulary();
    } catch (error) {
      activeRepository = previous.id; sync = previous.sync; store = previous.store;
      setVocabulary({ words: previous.words, meta: previous.meta, distractors: previous.distractors, pending: previous.pending });
      throw error;
    }
    libVisibleCount = LIB_PAGE_SIZE;
    lastAutoSyncAt = 0;
    saveSync(); saveProfile();
    syncWordbooksRegistry();
    applySyncToUI(); applySettingsToUI(); refreshIntro(); renderLibrary(); refreshCetReview(); renderWordbooks();
  }

  async function selectWordbook(bookId) {
    if (syncing || session) throw new Error('请等待当前同步或训练结束后再切换词库');
    const reg = loadWordbooks();
    const book = reg.books[bookId];
    if (!book) throw new Error('找不到该词库');

    if (book.type === 'cloud') {
      const profiles = JSON.parse(localStorage.getItem('worddrill.repositories.v1') || '{}');
      const profile = profiles[bookId];
      if (!profile) throw new Error('找不到该云端仓库的配置');
      selectRepository(profile);
      await restoreVocabularyAsync(bookId).catch(() => {});
      syncWordbooksRegistry();
      refreshIntro(); renderLibrary(); renderWordbooks();
      return;
    }

    // 本地词库切换
    if (store) saveStore();
    saveProfile();
    const previous = { id: activeRepository, sync, store, words: WORDS, meta: META, distractors: DISTRACTORS, pending: PENDING };
    try {
      activeRepository = bookId;
      sync = { ...defaultSync(), deviceId: sync?.deviceId || randomId() };
      store = loadStore(bookId);
      await restoreVocabularyAsync(bookId);
    } catch (error) {
      activeRepository = previous.id; sync = previous.sync; store = previous.store;
      setVocabulary({ words: previous.words, meta: previous.meta, distractors: previous.distractors, pending: previous.pending });
      throw error;
    }
    libVisibleCount = LIB_PAGE_SIZE;
    lastAutoSyncAt = 0;
    saveSync();
    reg.activeId = bookId;
    if (reg.books[bookId]) reg.books[bookId].wordCount = WORDS.length;
    saveWordbooks(reg);
    applySyncToUI(); applySettingsToUI(); refreshIntro(); renderLibrary(); refreshCetReview(); renderWordbooks();
  }

  function migrateRepositoryStorage() {
    const reg = loadWordbooks();
    if (reg.activeId && reg.books[reg.activeId]?.type === 'local') {
      activeRepository = reg.activeId;
    } else {
      activeRepository = repositoryId();
    }
    const raw = localStorage.getItem(STORE_KEY);
    if (activeRepository && isCloudBook() && raw && !localStorage.getItem('worddrill.legacy-repository.v1')) {
      for (const key of [STORE_KEY, BACKUP_KEY, 'worddrill.backup.before-v5']) {
        const value = localStorage.getItem(key);
        if (value && !localStorage.getItem(scopedKey(key))) localStorage.setItem(scopedKey(key), value);
      }
      localStorage.setItem('worddrill.legacy-repository.v1', activeRepository);
    }
    syncWordbooksRegistry();
  }

  /** 读远端进度；文件还不存在返回 null。 */
  async function remoteRead() {
    const url = `${syncApiUrl()}?ref=${encodeURIComponent(sync.branch)}&t=${now()}`;
    const res = await fetch(url, { headers: syncHeaders(), cache: 'no-store' });
    if (res.status === 404) {
      const diagnosis = await diagnoseSync();
      if (diagnosis.mode === 'error') throw new Error(diagnosis.text);
      return null;
    }
    if (!res.ok) throw syncHttpError(res.status);
    const j = await res.json();
    let data;
    try { data = JSON.parse(b64Decode(j.content)); }
    catch { throw new Error('远端进度无法解析，已暂停同步并保留原文件'); }
    readStore(data);
    return { sha: j.sha, data };
  }

  /** 写远端进度；sha 必填（新建时传 null）。别人抢先写了会抛 conflict。 */
  async function remoteWrite(payload, sha) {
    const body = {
      message: `sync ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      content: b64Encode(JSON.stringify(payload, null, 2)),
      branch: sync.branch
    };
    if (sha) body.sha = sha;
    const res = await fetch(syncApiUrl(), {
      method: 'PUT', headers: syncHeaders(), body: JSON.stringify(body)
    });
    if (res.ok) return res.json();
    if (res.status === 409) { const e = new Error('conflict'); e.conflict = true; throw e; }
    throw syncHttpError(res.status);
  }

  async function diagnoseSync(config = sync) {
    if (!config.owner || !config.repo) return { mode: 'error', text: '先把仓库所有者和仓库名填上' };
    if (!config.token) return { mode: 'error', text: '先把访问令牌 token 填上' };

    const full = `${config.owner}/${config.repo}`;
    const repoUrl = `${SYNC_API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
    const headers = syncHeaders(config);

    let res;
    try {
      res = await fetch(repoUrl, { headers, cache: 'no-store' });
    } catch {
      return { mode: 'error', text: '连不上 api.github.com —— 检查网络或代理设置' };
    }

    if (res.status === 401) return { mode: 'error', text: 'token 无效或已过期（401），请重新生成一个' };
    if (res.status === 403) return { mode: 'error', text: '被限流或权限不足（403），过一会再试' };
    if (res.status === 404) {
      return {
        mode: 'error',
        text: [
          `看不到 ${full}（404）。`,
          '私有仓库在 token 未授权时也返回 404：',
          '① token 的 Repository access 没勾上这个仓库；',
          '② 用了经典 token 但没给 repo 权限；',
          '③ 所有者或仓库名拼写有误。'
        ].join('\n')
      };
    }
    if (!res.ok) return { mode: 'error', text: `查询仓库失败（${res.status}）` };

    const info = await res.json();
    if (!info.private) return { mode: 'error', text: '请选择私有数据仓库，不能把学习进度上传到公开仓库' };
    if (!(info.permissions && info.permissions.push)) {
      return {
        mode: 'error',
        text: `能看到 ${info.full_name}，但 token 只有读权限。\n去 token 设置把 Contents 改成 Read and write`
      };
    }

    const branch = config.branch || 'main';
    const brRes = await fetch(`${repoUrl}/branches/${encodeURIComponent(branch)}`, { headers, cache: 'no-store' });
    if (brRes.status === 404) {
      return {
        mode: 'error',
        text: `仓库可写，但分支 ${branch} 不存在（404）。`
      };
    }
    if (!brRes.ok) return { mode: 'error', text: `查询分支失败（${brRes.status}）` };

    const fileRes = await fetch(syncApiUrl(config.path || 'progress.json', config), { headers, cache: 'no-store' });
    const fileOk = fileRes.ok || fileRes.status === 404;
    let fileNote;
    if (fileRes.status === 404) fileNote = '进度文件还没建，首次同步或上传会自动创建';
    else if (fileRes.ok) fileNote = '进度文件已存在，可正常读写';
    else fileNote = `读进度文件失败（${fileRes.status}）`;

    return {
      mode: fileOk ? 'ok' : 'error',
      text: `连接正常 ✓\n${info.full_name}（私有）· 分支 ${branch}\n${fileNote}`
    };
  }

  function parseRepoSpec(rawInput) {
    const raw = String(rawInput || '').trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^(www\.)?github\.com\//i, '')
      .replace(/\.git$/i, '');
    const parts = raw.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
    return null;
  }

  function normalizeRepoFields() {
    const el = $('#sync-owner');
    const parsed = parseRepoSpec(el.value);
    if (parsed) {
      el.value = parsed.owner;
      $('#sync-repo').value = parsed.repo;
    }
  }

  function normalMemory(m) {
    if (!m || typeof m !== 'object') return undefined;
    const card = {};
    for (const key of ['due', 'last_review', 'stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'reps', 'lapses', 'state', 'learning_steps']) {
      const n = key === 'due' || key === 'last_review' ? +new Date(m[key]) : Number(m[key]);
      if (!Number.isFinite(n) || n < 0) return undefined;
      card[key] = n;
    }
    if (card.state < 1 || card.state > 3 || card.stability <= 0 || card.difficulty < 1 || card.difficulty > 10) return undefined;
    return card;
  }

  const normalRec = (r) => ({
    stage: r.stage || 'new',
    credits: Array.isArray(r.credits) ? r.credits.filter((t) => typeof t === 'number' && isFinite(t)) : [],
    due: r.due || 0, lastSeen: r.lastSeen || 0,
    correct: r.correct || 0, wrong: r.wrong || 0,
    introducedAt: r.introducedAt || 0,
    memory: normalMemory(r.memory),
    masteredBy: r.masteredBy
  });

  function buildPayload(target = store) {
    const settings = {};
    for (const k of SYNCED_SETTINGS) settings[k] = target.settings[k];
    return {
      version: STORE_VERSION,
      app: 'worddrill',
      deviceId: sync.deviceId,
      syncedAt: now(),
      settingsAt: target.settingsAt || 0,
      settings,
      cet: target.cet || { approved: [], rejected: [] },
      stats: target.stats,
      words: target.words
    };
  }

  const payloadSig = (p) => JSON.stringify({
    version: Number(p.version) || 1,
    settings: p.settings || {}, settingsAt: p.settingsAt || 0,
    cet: p.cet || { approved: [], rejected: [] },
    stats: p.stats || {}, words: p.words || {}
  });

  function mergeRemote(remote, target = store) {
    if (!remote || typeof remote !== 'object') return false;
    if (Number(remote.version) > STORE_VERSION) throw new Error('远端进度来自更新版本，请刷新本站后同步');
    readStore(remote);
    let changed = false;

    const rw = (remote.words && typeof remote.words === 'object') ? remote.words : {};
    for (const id of new Set([...Object.keys(rw), ...Object.keys(target.words)])) {
      const mine = target.words[id];
      const theirs = rw[id];
      if (!theirs) continue;
      if (!mine) { target.words[id] = Object.assign(normalRec(theirs), { lastSeen: theirs.lastSeen || 0 }); changed = true; continue; }

      const newer = (theirs.lastSeen || 0) > (mine.lastSeen || 0) ? theirs : mine;
      const merged = normalRec(newer);
      merged.introducedAt = Math.min(mine.introducedAt || Infinity, theirs.introducedAt || Infinity);
      if (!Number.isFinite(merged.introducedAt)) merged.introducedAt = 0;
      merged.correct = Math.max(mine.correct || 0, theirs.correct || 0);
      merged.wrong = Math.max(mine.wrong || 0, theirs.wrong || 0);
      if (JSON.stringify(merged) !== JSON.stringify(normalRec(mine))) {
        target.words[id] = merged;
        changed = true;
      }
    }

    const remoteModel = Number(remote.version) || 1;
    const settingsOk = remoteModel >= 5;
    if (settingsOk && (remote.settingsAt || 0) > (target.settingsAt || 0) && remote.settings) {
      for (const k of SYNCED_SETTINGS) {
        if (k === 'spelling') {
          const s = SPELLING_MODES.includes(remote.settings.spelling) ? remote.settings.spelling : undefined;
          if (s !== undefined && target.settings.spelling !== s) { target.settings.spelling = s; changed = true; }
          continue;
        }
        const v = clampSetting(k, remote.settings[k]);
        if (v !== undefined && target.settings[k] !== v) { target.settings[k] = v; changed = true; }
      }
      target.settingsAt = remote.settingsAt || 0;
      changed = true;
    }

    const rs = remote.stats || {};
    for (const k of ['answers', 'correct', 'sessions', 'streakDays']) {
      const v = Math.max(target.stats[k] || 0, rs[k] || 0);
      if (v !== (target.stats[k] || 0)) { target.stats[k] = v; changed = true; }
    }
    if (rs.lastDate && (!target.stats.lastDate || rs.lastDate > target.stats.lastDate)) {
      target.stats.lastDate = rs.lastDate;
      changed = true;
    }

    const rc = remote.cet;
    if (rc && typeof rc === 'object') {
      target.cet = target.cet || { approved: [], rejected: [] };
      for (const k of ['approved', 'rejected']) {
        for (const id of (Array.isArray(rc[k]) ? rc[k] : [])) {
          if (!target.cet[k].includes(id)) { target.cet[k].push(id); changed = true; }
        }
      }
    }

    return changed;
  }

  function setSyncStatus(text, mode) {
    const el = $('#sync-status');
    if (!el) return;
    el.textContent = text || '';
    const ok = mode === 'ok';
    el.classList.toggle('is-error', !ok && !!mode);
    el.classList.toggle('is-ok', ok);
  }

  function describeSync() {
    if (!sync.lastSyncAt) {
      if (sync.lastResult) return sync.lastResult;
      return sync.enabled ? '还没同步过' : '未开启';
    }
    const mins = Math.floor((now() - sync.lastSyncAt) / MIN);
    const when = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : mins < 1440 ? `${Math.floor(mins / 60)} 小时前` : `${Math.floor(mins / 1440)} 天前`;
    return `${when} · ${sync.lastResult || '已同步'}`;
  }

  async function syncNow(opts) {
    const silent = !!(opts && opts.silent);
    if (!isCloudBook()) {
      if (!silent) toast('当前是本地词库，无需 GitHub 同步');
      return null;
    }
    if (!sync.enabled || !sync.token || !sync.owner || !sync.repo) {
      if (!silent) toast('先把云端仓库和 token 填好');
      return null;
    }
    if (syncing) { syncQueued = true; return null; }
    syncing = true;
    $('#btn-use-repository').disabled = true;
    $('#data-repository').disabled = true;
    setSyncStatus('同步中…');
    try {
      await loadRepositoryVocabulary();
      let changed = false, pushed = false, deferred = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await remoteRead();
        if (remote?.data && Number(remote.data.version || 1) < STORE_VERSION) {
          keepBackup(JSON.stringify(remote.data));
        }
        const remoteSig = (remote && remote.data) ? payloadSig(remote.data) : '';
        const target = session ? readStore(JSON.parse(JSON.stringify(store))) : store;
        if (mergeRemote(remote && remote.data, target)) {
          if (target === store) { changed = true; saveStore(); }
          else deferred = true;
        }

        const payload = buildPayload(target);
        if (remoteSig && remoteSig === payloadSig(payload)) break;
        try {
          await remoteWrite(payload, remote ? remote.sha : null);
          pushed = true;
          break;
        } catch (e) {
          if (e.conflict && attempt < 2) continue;
          throw e;
        }
      }
      sync.lastSyncAt = now();
      sync.lastResult = deferred ? (pushed ? '已上传，远端变化将在本轮结束后合并' : '远端有更新，本轮结束后合并')
        : changed ? (pushed ? '双向合并' : '已拉取') : (pushed ? '已上传' : '已是最新');
      saveSync();
      saveProfile();
      syncWordbooksRegistry();
      setSyncStatus(describeSync(), 'ok');
      applySettingsToUI(); refreshIntro(); renderLibrary(); refreshCetReview(); renderWordbooks();
      return { changed, pushed };
    } catch (e) {
      const msg = '同步失败：' + ((e && e.message) || '未知错误');
      sync.lastResult = msg;
      saveSync();
      saveProfile();
      setSyncStatus(describeSync(), 'error');
      if (!silent) toast(msg);
      return null;
    } finally {
      syncing = false;
      $('#btn-use-repository').disabled = false;
      $('#data-repository').disabled = false;
      if (syncQueued) { syncQueued = false; await syncNow({ silent: true }); }
    }
  }

  function autoSync(force = false) {
    if (!isCloudBook()) return;
    if (document.visibilityState === 'hidden' || session || syncing) return;
    if (!sync.enabled || !sync.token || !sync.owner || !sync.repo) return;
    if (!force && now() - lastAutoSyncAt < 15 * 1000) return;
    lastAutoSyncAt = now();
    return syncNow({ silent: true });
  }

  function bindAutoSync() {
    setInterval(() => { if (!session) { refreshIntro(); autoSync(); } }, MIN);
    window.addEventListener('focus', () => { refreshIntro(); autoSync(); });
    window.addEventListener('pageshow', () => autoSync());
    window.addEventListener('online', () => autoSync(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') syncNow({ silent: true });
      else autoSync();
    });
  }

  /* ---------- 公开词表拉取 & 本地词库合并 ---------- */
  async function fetchPublicRepoJson(repoSpec, filePath) {
    const parsed = parseRepoSpec(repoSpec);
    if (!parsed) throw new Error('公开词表仓库格式不对，应为 owner/repo');
    const path = String(filePath).replace(/^\/+/, '');
    const branch = DEFAULT_WORDLIST_BRANCH;
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const apiUrl = `${SYNC_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/contents/${path}?ref=${encodeURIComponent(branch)}`;
    try {
      const res = await fetch(apiUrl, { headers, cache: 'no-store' });
      if (res.ok) {
        const file = await res.json();
        if (file.content) return JSON.parse(b64Decode(file.content));
        if (file.sha) {
          const blobRes = await fetch(
            `${SYNC_API}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/git/blobs/${file.sha}`,
            { headers, cache: 'no-store' }
          );
          if (blobRes.ok) {
            const blob = await blobRes.json();
            return JSON.parse(b64Decode(blob.content));
          }
        }
      }
      if (res.status === 404) throw new Error(`在 ${parsed.owner}/${parsed.repo} 找不到 ${path}`);
    } catch (err) {
      if (/找不到/.test(err?.message || '')) throw err;
    }
    const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/${encodeURIComponent(branch)}/${path}`;
    const rawRes = await fetch(rawUrl, { cache: 'no-store' });
    if (!rawRes.ok) throw new Error(`拉取 ${path} 失败（${rawRes.status}）`);
    return rawRes.json();
  }

  function entryRichness(w) {
    return (w.example ? 4 : 0) + (w.exampleZh ? 2 : 0) + (w.phonetic ? 1 : 0)
      + (Array.isArray(w.collocations) && w.collocations.length ? 1 : 0) + (w.pos ? 1 : 0);
  }

  function mergeWordlists(lists, distractors = []) {
    const map = new Map();
    const sources = [];
    for (const item of lists) {
      const label = item?.meta?.shortName || item?.meta?.name;
      if (label && !sources.includes(label)) sources.push(label);
      for (const raw of (item?.words || [])) {
        if (!raw || typeof raw.id !== 'string' || !raw.id || !raw.word || !raw.meaning) continue;
        const prev = map.get(raw.id);
        const tags = Array.isArray(raw.tags) ? raw.tags.slice() : [];
        if (!prev) {
          map.set(raw.id, { ...raw, tags: [...new Set(tags)] });
        } else {
          const mergedTags = [...new Set([...(prev.tags || []), ...tags])];
          const winner = entryRichness(raw) > entryRichness(prev) ? raw : prev;
          map.set(raw.id, { ...winner, tags: mergedTags });
        }
      }
    }
    const words = Array.from(map.values());
    const distPool = [];
    const seenDist = new Set();
    for (const d of distractors) {
      if (!d || !d.meaning) continue;
      const key = `${d.w || ''}::${d.meaning}`;
      if (seenDist.has(key)) continue;
      seenDist.add(key);
      distPool.push(d);
    }
    return {
      meta: {
        name: sources.join(' + ') || '本地词库',
        sources,
        updated: dayKey(now()),
        count: words.length
      },
      words,
      distractors: distPool
    };
  }

  /* ---------- 本地词库上传到云端（新增 / 覆盖 / 替换） ---------- */
  function hasStudyActivity(rec) {
    return !!rec && (rec.stage !== 'new' || (rec.lastSeen || 0) > 0 || (rec.correct || 0) > 0 || (rec.wrong || 0) > 0);
  }

  function mergeDistractors(a = [], b = []) {
    const out = [];
    const seen = new Set();
    for (const d of [...a, ...b]) {
      if (!d || !d.meaning) continue;
      const key = `${d.w || ''}::${d.meaning}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
    return out;
  }

  function planCloudUpload({ localVocab, localProgress, remoteVocab, remoteProgress, mode, replaceProgress = false }) {
    const localWords = Array.isArray(localVocab?.words) ? localVocab.words : [];
    const remoteWords = Array.isArray(remoteVocab?.words) ? remoteVocab.words : [];
    const lProg = readStore(JSON.parse(JSON.stringify(localProgress || defaultStore())));
    const rProg = remoteProgress ? readStore(JSON.parse(JSON.stringify(remoteProgress))) : defaultStore();

    const remoteMap = new Map(remoteWords.map((w) => [w.id, w]));
    const localMap = new Map(localWords.map((w) => [w.id, w]));

    let finalWords = [];
    let added = 0, overwritten = 0, removed = 0;

    if (mode === 'append') {
      finalWords = remoteWords.slice();
      for (const w of localWords) {
        if (!remoteMap.has(w.id)) {
          finalWords.push(w);
          added++;
        }
      }
    } else if (mode === 'overwrite') {
      const resultMap = new Map(remoteWords.map((w) => [w.id, w]));
      for (const w of localWords) {
        if (resultMap.has(w.id)) overwritten++;
        else added++;
        resultMap.set(w.id, w);
      }
      finalWords = Array.from(resultMap.values());
    } else if (mode === 'replace') {
      finalWords = localWords.slice();
      for (const w of localWords) {
        if (remoteMap.has(w.id)) overwritten++;
        else added++;
      }
      for (const w of remoteWords) {
        if (!localMap.has(w.id)) removed++;
      }
    } else {
      throw new Error(`未知上传模式：${mode}`);
    }

    let finalProgress;
    if (mode === 'replace' && replaceProgress) {
      finalProgress = lProg;
    } else if (mode === 'replace') {
      finalProgress = lProg;
      const filteredRemote = {
        ...rProg,
        words: Object.fromEntries(
          Object.entries(rProg.words || {}).filter(([id]) => localMap.has(id))
        )
      };
      mergeRemote(filteredRemote, finalProgress);
    } else if (mode === 'overwrite') {
      finalProgress = rProg;
      for (const [id, rec] of Object.entries(lProg.words || {})) {
        if (hasStudyActivity(rec) || !finalProgress.words[id]) {
          finalProgress.words[id] = normalRec(rec);
        }
      }
      for (const k of ['answers', 'correct', 'sessions', 'streakDays']) {
        finalProgress.stats[k] = Math.max(finalProgress.stats[k] || 0, lProg.stats[k] || 0);
      }
      if (lProg.stats.lastDate && (!finalProgress.stats.lastDate || lProg.stats.lastDate > finalProgress.stats.lastDate)) {
        finalProgress.stats.lastDate = lProg.stats.lastDate;
      }
      if ((lProg.settingsAt || 0) > (finalProgress.settingsAt || 0)) {
        finalProgress.settings = { ...finalProgress.settings, ...lProg.settings };
        finalProgress.settingsAt = lProg.settingsAt;
      }
    } else {
      finalProgress = rProg;
      mergeRemote(lProg, finalProgress);
    }

    const finalDistractors = mode === 'replace' && (localVocab?.distractors || []).length
      ? localVocab.distractors
      : mergeDistractors(remoteVocab?.distractors || [], localVocab?.distractors || []);

    const finalMeta = {
      ...(remoteVocab?.meta || {}),
      ...(localVocab?.meta || {}),
      updated: dayKey(now()),
      count: finalWords.length
    };

    return {
      wordsData: { meta: finalMeta, words: finalWords },
      distractorsData: { words: finalDistractors },
      progress: finalProgress,
      summary: {
        remoteCount: remoteWords.length,
        localCount: localWords.length,
        added,
        overwritten,
        removed,
        finalCount: finalWords.length
      }
    };
  }

  async function uploadLocalToCloud({ localBookId, targetConfig, mode, replaceProgress = false }) {
    const diag = await diagnoseSync(targetConfig);
    if (diag.mode !== 'ok') throw new Error(diag.text);

    const reg = loadWordbooks();
    const localBook = reg.books[localBookId];
    if (!localBook || localBook.type !== 'local') throw new Error('只能从本地词库发起上传');

    const localVocab = await vocabDB.get(localBookId) || JSON.parse(localStorage.getItem(scopedKey('worddrill.vocabulary.v1', localBookId)) || 'null');
    if (!localVocab || !Array.isArray(localVocab.words) || !localVocab.words.length) {
      throw new Error('本地词库为空，无法上传');
    }
    const localProgress = loadStore(localBookId);

    const [remoteWordsFile, remoteDistFile, remoteProgFile] = await Promise.all([
      remoteReadFile('data/words.json', targetConfig, true),
      remoteReadFile('data/distractors.json', targetConfig, true),
      remoteReadFile(targetConfig.path || 'progress.json', targetConfig, true)
    ]);

    const targetRepoId = repositoryId(targetConfig);
    if (remoteProgFile?.data) {
      keepBackup(JSON.stringify(remoteProgFile.data), targetRepoId);
    }

    const plan = planCloudUpload({
      localVocab,
      localProgress,
      remoteVocab: {
        ...(remoteWordsFile?.data || { words: [] }),
        distractors: remoteDistFile?.data?.words || []
      },
      remoteProgress: remoteProgFile?.data || null,
      mode,
      replaceProgress
    });

    const modeTag = { append: 'append', overwrite: 'overwrite', replace: 'replace' }[mode] || mode;
    await remoteWriteFile(
      'data/words.json',
      plan.wordsData,
      remoteWordsFile?.sha || null,
      `upload words (${modeTag}): ${localBook.name}`,
      targetConfig
    );

    if (plan.distractorsData.words.length) {
      await remoteWriteFile(
        'data/distractors.json',
        plan.distractorsData,
        remoteDistFile?.sha || null,
        `upload distractors (${modeTag})`,
        targetConfig
      );
    }

    const progPayload = {
      ...buildPayload(plan.progress),
      deviceId: sync?.deviceId || targetConfig.deviceId || randomId()
    };
    await remoteWriteFile(
      targetConfig.path || 'progress.json',
      progPayload,
      remoteProgFile?.sha || null,
      `upload progress (${modeTag})`,
      targetConfig,
      true
    );

    // 同步保存云端仓库档案和本地缓存，保留本地词库不变
    const profiles = JSON.parse(localStorage.getItem('worddrill.repositories.v1') || '{}');
    const savedConfig = {
      ...defaultSync(),
      ...targetConfig,
      enabled: true,
      deviceId: sync?.deviceId || targetConfig.deviceId || randomId(),
      lastSyncAt: now(),
      lastResult: '已从本地上传'
    };
    profiles[targetRepoId] = savedConfig;
    localStorage.setItem('worddrill.repositories.v1', JSON.stringify(profiles));
    localStorage.setItem(scopedKey(STORE_KEY, targetRepoId), JSON.stringify(plan.progress));
    saveVocabularyLocal({ ...plan.wordsData, distractors: plan.distractorsData.words, pending: [] }, targetRepoId);
    syncWordbooksRegistry();

    return { plan, targetRepoId, savedConfig };
  }

  /* ---------- 会话 ---------- */
  function startSession(mode = 'learn', ids = null) {
    const t = now();
    const practice = ['practice', 'mistakes', 'context', 'listen'].includes(mode);
    if (mode === 'listen' && !canSpeak()) { toast('当前浏览器不支持发音，请使用语境填空或自由加练'); return; }
    let selected;
    if (practice) {
      selected = shuffle(WORDS.filter((w) => {
        const p = progressOf(w.id);
        if (mode === 'mistakes') return ids ? ids.includes(w.id) : p.wrong > 0;
        if (p.stage === 'new' && !p.introducedAt) return false;
        return mode !== 'context' || hasFillExample(w);
      }));
    } else {
      const due = shuffle(WORDS.filter((w) => {
        const p = progressOf(w.id);
        return (p.stage !== 'new' || p.introducedAt) && p.due <= t;
      })).sort((a, b) => progressOf(a.id).due - progressOf(b.id).due);
      const fresh = mode === 'review' ? [] : shuffle(WORDS.filter((w) => {
        const p = progressOf(w.id);
        return p.stage === 'new' && !p.introducedAt;
      })).slice(0, newAllowance(t));
      selected = due.concat(fresh);
    }
    const queue = selected.slice(0, REQUESTS_PER_ROUND).map((w) => w.id);

    if (!queue.length) {
      toast(mode === 'context' ? '已学词里还没有可填空的完整例句，可以先练认词或拼写'
        : mode === 'mistakes' ? '还没有待巩固词' : '本轮没有可练的词，可以稍后复习或自由加练');
      return;
    }

    session = {
      queue,
      total: queue.length,
      index: 0,
      done: 0,
      correct: 0,
      current: null,
      answered: false,
      practice,
      mode,
      missed: new Set(),
      aided: new Set(),
      startedAt: t,
      results: new Map(),
      requeued: 0
    };

    switchView('learn');
    showPanel('quiz');
    nextQuestion();
  }

  function nextQuestion() {
    if (!session) return;
    if (session.index >= session.queue.length || session.done >= REQUESTS_PER_ROUND) {
      return endSession();
    }
    const id = session.queue[session.index];
    session.index++;
    const word = byId.get(id);
    if (!word) return nextQuestion();

    const stage = progressOf(id).stage;
    const type = quizTypeFor(id, stage);
    let q;
    if (session.mode === 'context') {
      q = buildFillQuestion(word);
    } else if (session.mode === 'listen') {
      q = { kind: 'listen', word, hint: letterHint(word.word) };
    } else if (type === 'spell') {
      q = buildSpellQuestion(word);
    } else {
      q = WORDS.length >= 4 || !requiresWriting(id) ? buildRecognizeQuestion(word) : buildSpellQuestion(word);
    }

    q.retry = session.results.has(id);
    session.current = q;
    session.answered = false;
    renderQuiz(q);
  }

  function answer(isCorrect, userAnswer) {
    if (!session || session.answered) return;
    const word = session.current.word;
    const q = session.current;
    const r = grade(word.id, isCorrect, !!q.aided, session.practice || q.retry);
    session.answered = true;
    session.done++;
    if (isCorrect && !q.aided) session.correct++;

    const previous = session.results.get(word.id);
    if (previous) {
      r.before = previous.before;
      r.promoted = previous.promoted || r.promoted;
      r.demoted = previous.demoted || r.demoted;
    }
    session.results.set(word.id, r);

    if (!isCorrect || q.aided) {
      if (!isCorrect) session.missed.add(word.id);
      if (q.aided) session.aided.add(word.id);
      const insertAt = session.index + 3;
      if (insertAt <= session.queue.length && insertAt < REQUESTS_PER_ROUND) {
        session.queue.splice(insertAt, 0, word.id);
        session.requeued++;
        session.total = Math.min(session.queue.length, REQUESTS_PER_ROUND);
        q.requeued = true;
      }
    }

    renderFeedback(session.current, isCorrect, userAnswer, r);
    const nextBtn = $('#btn-next');
    if (nextBtn && !nextBtn.hidden && !nextBtn.disabled) nextBtn.focus({ preventScroll: true });
    updateProgress();
    syncNow({ silent: true });
  }

  function endSession() {
    const stats = session ? {
      done: session.done,
      correct: session.correct,
      results: session.results,
      missed: session.missed,
      aided: session.aided,
      elapsed: now() - session.startedAt,
      practice: session.practice
    } : null;
    session = null;

    if (!stats || stats.done === 0) {
      showPanel('intro');
      refreshIntro();
      return;
    }

    const today = dayKey(now());
    if (store.stats.lastDate !== today) {
      const yesterday = new Date(now());
      yesterday.setDate(yesterday.getDate() - 1);
      const y = dayKey(+yesterday);
      store.stats.streakDays = store.stats.lastDate === y ? (store.stats.streakDays || 0) + 1 : 1;
      store.stats.lastDate = today;
    }
    store.stats.sessions++;
    saveStore();

    renderSummary(stats);
    showPanel('summary');

    if (isCloudBook() && sync && sync.enabled && sync.token) syncNow({ silent: true });
  }

  /* ---------- 渲染：训练视图 ---------- */
  async function setTrainingMode(active) {
    document.body.classList.toggle('is-training', active);
    try {
      if (active && document.fullscreenEnabled && !document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        if (!session) await document.exitFullscreen();
      } else if (!active && document.fullscreenElement === document.documentElement) {
        await document.exitFullscreen();
      }
    } catch { /* 不支持或拒绝全屏时仍保持应用内专注布局。 */ }
  }

  function showPanel(which) {
    $('#session-intro').hidden = which !== 'intro';
    $('#session-quiz').hidden = which !== 'quiz';
    $('#session-summary').hidden = which !== 'summary';
    setTrainingMode(which === 'quiz');
  }

  function refreshActiveBookBar() {
    const book = getActiveBookInfo();
    const badge = $('#active-book-badge');
    const nameEl = $('#active-book-name');
    const metaEl = $('#active-book-meta');
    if (!badge || !nameEl || !metaEl) return;

    if (!book && !WORDS.length) {
      badge.textContent = '未选词库';
      badge.className = 'book-badge';
      nameEl.textContent = '请选择或创建词库';
      metaEl.textContent = '点击右侧「切换词库」从四级 / 六级 / 雅思新建';
      return;
    }
    const isCloud = book ? book.type === 'cloud' : isCloudBook();
    badge.textContent = isCloud ? '云端词库' : '本地词库';
    badge.className = `book-badge ${isCloud ? 'book-badge--cloud' : 'book-badge--local'}`;
    const displayName = book?.name || (isCloud && sync?.owner ? `${sync.owner}/${sync.repo}` : '本地词库');
    nameEl.textContent = displayName;
    const mastered = WORDS.filter((w) => progressOf(w.id).stage === 'mastered').length;
    const pct = WORDS.length ? Math.round((mastered / WORDS.length) * 100) : 0;
    metaEl.textContent = WORDS.length ? `${WORDS.length} 词 · 已掌握 ${pct}%` : '暂无单词';
    const settingsBookName = $('#settings-book-name');
    if (settingsBookName) settingsBookName.textContent = displayName;
    const libBookName = $('#lib-book-name');
    if (libBookName) libBookName.textContent = displayName;
  }

  function refreshIntro() {
    const t = now();
    let due = 0, fresh = 0, mastered = 0;
    for (const w of WORDS) {
      const p = progressOf(w.id);
      if (p.stage === 'new' && !p.introducedAt) fresh++;
      else {
        if (p.due <= t) due++;
        if (p.stage === 'mastered') mastered++;
      }
    }
    $('#meta-count').textContent = WORDS.length;
    $('#meta-updated').textContent = META.updated || '—';
    $('#active-repository').textContent = isCloudBook() ? `${sync.owner}/${sync.repo}` : '当前未连接云端仓库';
    $('#stat-due').textContent = due;
    const remaining = Math.min(fresh, newAllowance(t));
    $('#stat-new').textContent = remaining;
    $('#stat-mastered').textContent = mastered;

    const totalToday = due + remaining;
    $('#intro-hint').textContent = totalToday
      ? `本轮最多 ${Math.min(totalToday, REQUESTS_PER_ROUND)} 个词 · 待复习 ${due} · 今日可加新词 ${remaining}`
      : (!WORDS.length ? '当前词库还是空的，去「词库」新建本地词库或连接云端仓库即可开始。'
        : '暂时没有到期的词；自由加练不会提前推迟下次复习。');
    if (dailyWordTarget()) {
      $('#intro-hint').textContent += ` · 每日备词目标 ${dailyWordTarget()} 词，今日已练 ${dailyCoverage(t).seen} 词`;
    }
    const paceName = getCurrentPace()?.label || '自定义';
    $('#intro-rule').textContent = store.settings.spelling === 'off'
      ? `当前模式：只认不拼 · 复习节奏「${paceName}」`
      : `当前模式：认词 + 拼写（六级默认只认）· 复习节奏「${paceName}」`;

    $('#btn-start').disabled = totalToday === 0;
    $('#btn-review').disabled = due === 0;
    $('#btn-mistakes').disabled = !WORDS.some((w) => progressOf(w.id).wrong > 0);
    const learned = WORDS.filter((w) => {
      const p = progressOf(w.id);
      return p.stage !== 'new' || p.introducedAt;
    });
    $('#btn-practice').disabled = !learned.length;
    $('#btn-context').disabled = !learned.some(hasFillExample);
    $('#btn-listen').disabled = !learned.length || !canSpeak();
    $('#application-hint').textContent = !canSpeak()
      ? '当前浏览器不支持发音，仍可练语境填空。练习不改变升阶与复习时间。'
      : '练习已学词的语境和声音；不改变升阶与复习时间。听写使用设备合成语音。';
    refreshActiveBookBar();
  }

  /* ---------- 四六级候选词确认卡 ---------- */
  async function refreshCetReview() {
    const box = $('#cet-review');
    if (!box) return;
    let pending = PENDING;

    const decided = new Set([...(store.cet?.approved || []), ...(store.cet?.rejected || [])]);
    const known = new Set(WORDS.map((w) => w.id));
    pending = pending.filter((w) => w && w.id && w.word && !decided.has(w.id) && !known.has(w.id));
    if (!pending.length) { box.hidden = true; box.innerHTML = ''; return; }

    box.hidden = false;
    box.innerHTML = `
      <h2 class="cet-review__title">四六级候选词 · 要加入词库吗？</h2>
      <p class="cet-review__sub">勾选想学的词；取消勾选的词以后不再推荐。</p>
      ${!(isCloudBook() && sync.enabled && sync.token && sync.owner && sync.repo) ? '<p class="cet-review__sub">开启云端仓库同步后，补词任务才能收到你的选择。</p>' : ''}
      <ul class="cet-review__list">
        ${pending.map((w) => `
          <li class="cet-review__item">
            <label class="cet-review__choice" for="cet-${esc(w.id)}">
              <input type="checkbox" checked data-cet-id="${esc(w.id)}" id="cet-${esc(w.id)}">
              <span class="cet-review__word">${esc(w.word)}</span>
              <span class="cet-review__pos">${esc(w.pos || '')}</span>
              <span class="cet-review__tag">${esc((w.tags && w.tags[0]) || 'CET')}</span>
            </label>
            <span class="cet-review__meaning">${esc(w.meaning)}</span>
            <details class="cet-review__details">
              <summary>查看例句、搭配与来源</summary>
              ${w.phonetic ? `<p>/${esc(w.phonetic)}/</p>` : ''}
              <p>${esc(w.example || '')}<br><span class="cet-review__translation">${esc(w.exampleZh || '')}</span></p>
              ${(w.collocations || []).length ? `<p>搭配：${w.collocations.map(esc).join('；')}</p>` : ''}
              <p>${esc(w.exampleSource || '词书例句')}</p>
            </details>
          </li>`).join('')}
      </ul>
      <div class="cet-review__actions">
        <button class="btn btn--primary" id="btn-cet-approve" type="button">加入所选</button>
        <button class="btn btn--ghost" id="btn-cet-skip" type="button">这批都不要</button>
      </div>`;

    const collect = () => [...box.querySelectorAll('input[data-cet-id]')];
    const decide = (approvedIds, rejectedIds) => {
      store.cet = store.cet || { approved: [], rejected: [] };
      for (const id of approvedIds) if (!store.cet.approved.includes(id)) store.cet.approved.push(id);
      for (const id of rejectedIds) if (!store.cet.rejected.includes(id)) store.cet.rejected.push(id);
      saveStore();
      box.hidden = true;
      box.innerHTML = '';
      toast(approvedIds.length
        ? `已选 ${approvedIds.length} 个，等待同步和下一次补词任务`
        : '这批候选词已跳过，之后会换新的来');
      if (isCloudBook() && sync.enabled && sync.token && sync.owner && sync.repo) syncNow({ silent: true });
    };
    $('#btn-cet-approve').addEventListener('click', () => {
      const all = collect();
      decide(all.filter((i) => i.checked).map((i) => i.dataset.cetId),
             all.filter((i) => !i.checked).map((i) => i.dataset.cetId));
    });
    $('#btn-cet-skip').addEventListener('click', () => {
      decide([], collect().map((i) => i.dataset.cetId));
    });
  }

  function updateProgress() {
    const bar = $('#quiz-bar');
    const fill = $('#quiz-bar-fill');
    const shown = session ? Math.min(session.index, session.total) : 0;
    const pct = session && session.total ? Math.min(100, Math.round((shown / session.total) * 100)) : 0;
    fill.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
    $('#quiz-counter').textContent = session
      ? `${shown} / ${session.total}`
      : '0 / 0';
  }

  function renderQuiz(q) {
    const stage = progressOf(q.word.id).stage;
    const badge = $('#stage-badge');
    badge.textContent = q.retry ? '本轮回练' : session.mode === 'context' ? '语境加练'
      : session.mode === 'listen' ? '听写加练'
      : stage === 'mastered' && !requiresWriting(q.word.id) ? '认词巩固' : STAGE_BADGE[stage] || '认词';
    badge.dataset.stage = stage;

    $('#feedback').innerHTML = '';
    $('#btn-next').hidden = true;
    $('#btn-next').disabled = false;
    const shortcut = $('#quiz-shortcut');
    if (shortcut) shortcut.textContent = q.kind === 'recognize' ? '先想一想再核对' : '输入后按 Enter 提交';

    const body = $('#quiz-body');
    if (q.kind === 'recognize') {
      body.innerHTML = `
        <div class="prompt">
          <p class="prompt__label" id="recognize-label">先在心里回想词义，再核对选项</p>
          <p class="prompt__word">${esc(q.word.word)}</p>
        </div>
        <div class="btn-row" id="recall-actions">
          <button class="btn btn--primary" id="btn-recalled" type="button">想起了，核对选项</button>
          <button class="btn btn--ghost" id="btn-recall-help" type="button">没想起，借助选项</button>
        </div>
        <p class="hint" id="recall-hint">借助选项后答对会安排再复习，不记升阶天数。</p>
        <div class="options" id="recognize-options" role="group" aria-label="释义选项" hidden>
          ${q.options.map((o, i) => `
            <button class="option" type="button" data-index="${i}">
              <span class="option__key" aria-hidden="true">${i + 1}</span>
              <span>${esc(o.text)}</span>
              <span class="option__mark" aria-hidden="true"></span>
            </button>`).join('')}
        </div>`;
      $('#btn-recalled').addEventListener('click', () => revealOptions(q, false));
      $('#btn-recall-help').addEventListener('click', () => revealOptions(q, true));
      $$('.option', body).forEach((btn) => {
        btn.addEventListener('click', () => onPickOption(q, Number(btn.dataset.index)));
      });
      $('#btn-recalled').focus({ preventScroll: true });
    } else {
      const isFill = q.kind === 'fill';
      const isListen = q.kind === 'listen';
      body.innerHTML = `
        <div class="prompt">
          <p class="prompt__label">${isFill ? '读例句，填入已学过的词' : isListen ? '听发音，写出英文单词' : '根据中文写出英文单词'}</p>
          ${isFill
            ? `<p class="prompt__blank">${blankExample(q.word.example, q.word.word)}</p>
               <p class="prompt__blank" id="context-translation" hidden>${esc(q.word.exampleZh || '')}</p>`
            : isListen ? `<button class="btn btn--ghost" id="btn-listen-play" type="button">播放单词</button>
                <p class="hint" id="listen-status" role="status">可以重复播放；本题练习听音辨词。</p>`
            : `<p class="prompt__zh">${esc(q.word.meaning)}</p>`}
        </div>
        <form class="spell" id="spell-form" novalidate>
          <div class="spell__row">
            <label class="sr-only" for="spell-input">${isFill ? '填入英文单词' : isListen ? '输入听到的英文单词' : '输入英文单词'}</label>
            <input class="spell__input" id="spell-input" type="text"
                   autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
                   placeholder="输入英文…">
            <button class="btn btn--primary" type="submit">提交</button>
          </div>
          <button class="btn btn--ghost" id="btn-hint" type="button">${isFill ? '看中文和首字母提示' : '看首字母提示'}</button>
          <p class="spell__letters" id="spell-hint" hidden>${esc(q.hint)} · 提示后答对不记升阶天数</p>
        </form>`;
      const form = $('#spell-form');
      const input = $('#spell-input');
      if (isListen) $('#btn-listen-play').addEventListener('click', () => {
        $('#listen-status').textContent = '可以重复播放；本题练习听音辨词。';
        speak(q.word.word, () => {
          if (session?.current === q && !session.answered) $('#listen-status').textContent = '播放失败，可以重试或结束本次，改练语境填空。';
        });
        input.focus();
      });
      $('#btn-hint').addEventListener('click', () => {
        q.aided = true;
        $('#spell-hint').hidden = false;
        if (isFill) $('#context-translation').hidden = false;
        $('#btn-hint').hidden = true;
        input.focus();
      });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (session.answered) return;
        const val = input.value.trim();
        if (!val) { input.focus(); return; }
        const ok = normalize(val) === normalize(q.word.word);
        input.classList.add(ok ? 'is-correct' : 'is-wrong');
        input.disabled = true;
        form.querySelector('button').disabled = true;
        answer(ok, val);
      });
      setTimeout(() => input.focus(), 40);
    }

    if (store.settings.speak && q.kind === 'recognize') speak(q.word.word);
    if (typeof window.scrollTo === 'function') {
      window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    }
    updateProgress();
  }

  const normalize = (s) => String(s).normalize('NFKC').trim().toLowerCase()
    .replace(/[‘’]/g, "'").replace(/\s+/g, ' ');

  function revealOptions(q, aided) {
    if (!session || session.current !== q || session.answered || q.optionsReady) return;
    q.optionsReady = true;
    q.aided = aided;
    $('#recall-actions').hidden = true;
    $('#recall-hint').hidden = true;
    $('#recognize-label').textContent = aided ? '借助选项学习词义，再选出释义' : '选出释义，核对刚才的回忆';
    $('#recognize-options').hidden = false;
    const shortcut = $('#quiz-shortcut');
    if (shortcut) shortcut.textContent = '数字键 1-4 选择';
    $('.option')?.focus({ preventScroll: true });
  }

  function onPickOption(q, index) {
    if (!session || session.current !== q || session.answered || !q.optionsReady) return;
    const chosen = q.options[index];
    if (!chosen) return;
    const buttons = $$('.option');
    buttons.forEach((btn, i) => {
      btn.disabled = true;
      const mark = $('.option__mark', btn);
      if (q.options[i].correct) {
        btn.classList.add('is-correct');
        mark.innerHTML = iconCheck();
      } else if (i === index) {
        btn.classList.add('is-wrong');
        mark.innerHTML = iconCross();
      } else {
        btn.classList.add('is-dim');
      }
    });
    answer(chosen.correct, chosen.text);
  }

  function iconCheck() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
  }
  function iconCross() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
  }

  function renderFeedback(q, isCorrect, userAnswer, r) {
    const w = q.word;
    const stageChanged = r.promoted ? 'promoted' : (r.demoted ? 'demoted' : null);
    let stageNote = '';
    if (stageChanged === 'promoted') {
      const label = r.after.stage === 'write' ? '进入拼写关' :
                    r.after.stage === 'mastered' ? '已掌握' : '开始认词';
      stageNote = `<p class="fb__stage" style="color:var(--color-success)">↑ ${label}</p>`;
    } else if (stageChanged === 'demoted') {
      stageNote = `<p class="fb__stage" style="color:var(--color-danger)">↓ 退回${STAGE_BADGE[r.after.stage] || '认词'}关，再巩固一下</p>`;
    }

    const need = r.need || creditNeed();
    const have = (r.after.credits || []).length;
    const nextDue = formatDue(r.after.due);
    let creditNote;
    const retryNote = q.requeued ? '本轮隔开 3 题再练' : '本轮不立即重复';
    if (r.practice) {
      creditNote = `<p class="fb__credit">${q.retry ? '本轮回练' : '自由加练'} · 不改变升阶天数与下次复习时间</p>`;
    } else if (!isCorrect) {
      creditNote = `<p class="fb__credit fb__credit--bad">保留之前的 ${have} 天积累 · ${retryNote} · 下次复习 ${nextDue}</p>`;
    } else if (r.aided) {
      creditNote = `<p class="fb__credit">提示后答对，本次不记升阶天数 · ${retryNote} · 下次复习 ${nextDue}</p>`;
    } else if (r.before.stage === 'new') {
      creditNote = `<p class="fb__credit">进入「认词中」· 下次复习 ${nextDue}</p>`;
    } else if (r.promoted) {
      creditNote = r.after.stage === 'mastered'
        ? `<p class="fb__credit">跨天答对与${requiresWriting(w.id) ? '拼写' : '认词'}稳定性达标 → 已掌握 · 下次复习 ${nextDue}</p>`
        : `<p class="fb__credit">认词达标 → 进入拼写关，独立建立拼写记忆 · 下次复习 ${nextDue}</p>`;
    } else if (r.after.stage === 'mastered') {
      creditNote = `<p class="fb__credit">已掌握 · 下次复习 ${nextDue}</p>`;
    } else {
      const evidence = r.credited ? '记上新的一天' : '同日重复或提前回练，不加天数';
      creditNote = `<p class="fb__credit">${evidence} · 已攒 <b>${have}</b> / 至少 ${need} 天 · 稳定性 ${(r.after.memory?.stability || 0).toFixed(1)} / ${PROMOTION_STABILITY[r.after.stage]} 天 · 下次复习 ${nextDue}</p>`;
    }

    const userLine = (!isCorrect && q.kind !== 'recognize' && userAnswer)
      ? `<p class="fb__meaning" style="color:var(--color-danger)">你写的是：<s>${esc(userAnswer)}</s></p>` : '';

    $('#feedback').innerHTML = `
      <div class="fb ${isCorrect ? 'fb--ok' : 'fb--no'}">
        <p class="fb__head">
          ${isCorrect ? iconCheck() : iconCross()}
          ${isCorrect ? (q.aided ? '提示后答对' : q.kind === 'recognize' ? '认对了' : '拼对了') : (q.kind === 'recognize' ? '认错了' : '拼错了')}
        </p>
        <p class="fb__word">${esc(w.word)} <span class="prompt__pos">${esc(w.pos || '')}</span></p>
        <p class="fb__meaning">${esc(w.meaning)}</p>
        ${userLine}
        <div class="fb__ex">
          <p class="fb__ex-en">${highlight(w.example, w.word)}</p>
          <p class="fb__ex-zh">${esc(w.exampleZh || '')}</p>
          ${w.exampleSource ? `<p class="hint">${esc(w.exampleSource)}</p>` : ''}
          ${(w.collocations || []).length ? `<p class="fb__ex-zh">搭配：${w.collocations.map(esc).join('；')}</p>` : ''}
        </div>
        ${stageNote}
        ${creditNote}
      </div>`;

    const next = $('#btn-next');
    next.hidden = false;
    next.textContent = session.done >= session.total ? '看小结' : '继续';
    const shortcut = $('#quiz-shortcut');
    if (shortcut) shortcut.textContent = '按 Enter 继续';

    if (!isCorrect && q.kind !== 'recognize') {
      next.disabled = true;
      $('#feedback').insertAdjacentHTML('beforeend', `
        <form class="spell" id="correction-form">
          <label for="correction-input">再正确拼写一次：${esc(w.word)}</label>
          <div class="spell__row">
            <input class="spell__input" id="correction-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" required>
            <button class="btn btn--ghost" type="submit">确认拼写</button>
          </div>
          <p class="hint" id="correction-hint" role="status">这次订正不计入答题次数或升阶天数。</p>
        </form>`);
      const input = $('#correction-input');
      $('#correction-form').addEventListener('submit', (e) => {
        e.preventDefault();
        if (normalize(input.value) !== normalize(w.word)) {
          $('#correction-hint').textContent = '还没拼对，请对照上面的单词再试一次。';
          input.focus();
          return;
        }
        input.disabled = true;
        $('#correction-form button').disabled = true;
        $('#correction-hint').textContent = q.requeued ? '已订正，本轮隔开几题后再练。' : '已订正，之后按复习计划再练。';
        next.disabled = false;
        next.focus({ preventScroll: true });
      });
      $('#correction-form')?.scrollIntoView?.({ block: 'nearest' });
      input.focus({ preventScroll: true });
    } else next.focus({ preventScroll: true });
    if (store.settings.speak && q.kind !== 'recognize') speak(w.word);
  }

  function renderSummary(stats) {
    const rate = stats.done ? Math.round((stats.correct / stats.done) * 100) : 0;
    $('#summary-title').textContent = rate >= 90 ? '干净利落' : rate >= 70 ? '稳步推进' : '有难点，正常';

    const started = [], advanced = [], gained = [];
    stats.results.forEach((r, id) => {
      const before = (r.before.credits || []).length;
      const after = (r.after.credits || []).length;
      if (r.promoted && r.before.stage === 'new') started.push(id);
      else if (r.promoted) advanced.push(id);
      else if (after > before) gained.push(id);
    });

    $('#summary-stats').innerHTML = `
      <div class="stat"><span class="stat__num">${stats.done}</span><span class="stat__label">答题</span></div>
      <div class="stat"><span class="stat__num">${rate}%</span><span class="stat__label">独立答对率</span></div>
      <div class="stat"><span class="stat__num">${gained.length}</span><span class="stat__label">攒到天数</span></div>`;

    const rows = [];
    if (started.length) rows.push(`<div class="summary__row"><b>${started.length} 个</b> 词进入「认词中」，开始攒天数</div>`);
    if (gained.length) rows.push(`<div class="summary__row"><b>${gained.length} 个</b> 词攒到了新的一天 <span class="tag tag--up">↑</span></div>`);
    summaryMistakes = [...stats.missed];
    if (summaryMistakes.length) rows.push(`<div class="summary__row">本轮错词：<b>${summaryMistakes.map((id) => esc(byId.get(id)?.word || id)).join('、')}</b></div>`);
    const aidedWords = [...stats.aided];
    if (aidedWords.length) rows.push(`<div class="summary__row">提示后仍需巩固：<b>${aidedWords.map((id) => esc(byId.get(id)?.word || id)).join('、')}</b></div>`);
    summaryMistakes = [...new Set(summaryMistakes.concat(aidedWords))];
    $('#btn-summary-mistakes').hidden = !summaryMistakes.length;
    rows.push(`<div class="summary__row">用时 ${Math.max(1, Math.round(stats.elapsed / MIN))} 分钟${stats.practice ? ' · 自由加练，不影响复习计划' : ''}</div>`);
    if (advanced.length) {
      rows.push(`<div class="summary__row">升阶：<b>${advanced.map((id) => esc(byId.get(id)?.word || id)).join('、')}</b> <span class="tag tag--up">晋级</span></div>`);
    }
    $('#summary-list').innerHTML = rows.join('') || '<div class="summary__row">这轮没有需要特别标记的词。</div>';
  }

  /* ---------- 单词列表视图 ---------- */
  function renderLibrary() {
    const counts = { new: 0, recognize: 0, write: 0, mastered: 0 };
    for (const w of WORDS) counts[progressOf(w.id).stage]++;

    $('#lib-total').textContent = `共 ${WORDS.length} 个词`;
    $('#lib-dist').innerHTML = STAGES.map((s) => {
      const pct = WORDS.length ? (counts[s] / WORDS.length) * 100 : 0;
      if (!pct) return '';
      return `<span class="dist__seg" data-stage="${s}" style="width:${pct}%" title="${STAGE_LABEL[s]} ${counts[s]}"></span>`;
    }).join('');

    const legend = $('#lib-dist').nextElementSibling;
    if (legend && legend.classList.contains('dist-legend')) {
      legend.innerHTML = STAGES.map((s) =>
        `<span><i class="dot" data-stage="${s}" aria-hidden="true"></i>${STAGE_LABEL[s]} ${counts[s]}</span>`).join('');
    }

    const q = libQuery.trim().toLowerCase();
    const list = WORDS.filter((w) => {
      const p = progressOf(w.id);
      if (libFilter === 'mistakes' ? !p.wrong : libFilter !== 'all' && p.stage !== libFilter) return false;
      if (!q) return true;
      return w.word.toLowerCase().includes(q) || w.meaning.toLowerCase().includes(q);
    });

    const shown = list.slice(0, libVisibleCount);
    const ul = $('#wordlist');
    ul.innerHTML = shown.map((w) => {
      const p = progressOf(w.id);
      const need = creditNeed();
      const have = (p.credits || []).length;
      const pips = Array.from({ length: need }, (_, i) =>
        `<i class="strength__pip ${(p.stage === 'mastered' || i < have) ? 'is-on' : ''}" data-stage="${p.stage}"></i>`).join('');
      const creditText = p.stage === 'new' ? '未开始'
        : p.stage === 'mastered' ? '已掌握'
        : `已攒 ${have} / 至少 ${need} 天`;
      const dueText = p.stage === 'new' ? '尚未开始'
        : p.due <= now() ? '待复习'
        : `复习：${formatDue(p.due)}`;
      return `
        <li class="wcard">
          <div class="wcard__top">
            <span class="wcard__word">${esc(w.word)}</span>
            <span class="wcard__pos">${esc(w.pos || '')}</span>
            <span class="wcard__stage" data-stage="${p.stage}">${STAGE_LABEL[p.stage]}</span>
          </div>
          <p class="wcard__meaning">${esc(w.meaning)}</p>
          ${w.example ? `<p class="wcard__ex">${esc(w.example)}</p>` : ''}
          <div class="wcard__foot">
            <span class="strength" role="img" aria-label="${creditText}">${pips}</span>
            <span class="wcard__meta">${requiresWriting(w.id) ? '认词＋拼写' : '只需认词'} · ${creditText} · 对 ${p.correct} · 错 ${p.wrong} · ${dueText}${p.memory ? ` · 稳定性 ${p.memory.stability.toFixed(1)} 天` : ''}</span>
          </div>
        </li>`;
    }).join('');

    const moreWrap = $('#wordlist-more-wrap');
    const moreBtn = $('#btn-lib-more');
    if (moreWrap && moreBtn) {
      const remain = list.length - shown.length;
      moreWrap.hidden = remain <= 0;
      if (remain > 0) moreBtn.textContent = `显示更多（还有 ${remain} 个词）`;
    }

    $('#wordlist-empty').hidden = list.length > 0;
  }

  function formatDue(ts) {
    const diff = ts - now();
    if (diff < 60 * MIN) return `${Math.max(1, Math.round(diff / MIN))} 分钟后`;
    if (diff < DAY) return `${Math.round(diff / (60 * MIN))} 小时后`;
    return `${Math.round(diff / DAY)} 天后`;
  }

  /* ---------- 直观设置（预设化） ---------- */
  function getCurrentPace(settings = store?.settings) {
    if (!settings) return null;
    for (const [key, p] of Object.entries(PACE_PRESETS)) {
      if (Number(settings.threshold) === p.threshold && Number(settings.retention) === p.retention) {
        return { key, ...p };
      }
    }
    return null;
  }

  function applyPacePreset(presetKey) {
    const p = PACE_PRESETS[presetKey];
    if (!p) return;
    store.settings.threshold = p.threshold;
    store.settings.retention = p.retention;
    store.settingsAt = now();
    saveStore();
    applySettingsToUI();
    refreshIntro();
    renderLibrary();
  }

  function applySettingsToUI() {
    const nlVal = Number(store.settings.newLimit);
    const nlMatched = [0, 10, 20, 40].includes(nlVal);
    $$('[data-newlimit]').forEach((btn) => {
      const on = Number(btn.dataset.newlimit) === nlVal;
      btn.classList.toggle('is-selected', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const nlCustom = $('#set-newlimit-custom');
    if (nlCustom) {
      nlCustom.hidden = nlMatched;
      if (!nlMatched) nlCustom.textContent = `当前：${nlVal} 词/天`;
    }
    const nlHint = $('#set-newlimit-hint');
    if (nlHint) {
      nlHint.textContent = dailyWordTarget()
        ? `到期复习永远优先；当前词库已启用每日 ${dailyWordTarget()} 词备词目标。`
        : '到期复习永远优先，每天按这个量补充新词。';
    }

    const spMode = store.settings.spelling === 'off' ? 'off' : 'auto';
    $$('[data-spelling]').forEach((btn) => {
      const on = btn.dataset.spelling === spMode;
      btn.classList.toggle('is-selected', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const noSpell = $('#set-no-spelling');
    if (noSpell) noSpell.checked = spMode === 'off';

    const pace = getCurrentPace();
    $$('[data-pace]').forEach((btn) => {
      const on = pace && btn.dataset.pace === pace.key;
      btn.classList.toggle('is-selected', !!on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const paceCustom = $('#set-pace-custom');
    if (paceCustom) {
      paceCustom.hidden = !!pace;
      if (!pace) paceCustom.textContent = `自定义（${store.settings.threshold} 天 · ${store.settings.retention}%）`;
    }

    const sp = $('#set-speak');
    if (sp) sp.checked = !!store.settings.speak;
    const backupBtn = $('#btn-backup');
    if (backupBtn) backupBtn.disabled = !localStorage.getItem(scopedKey(BACKUP_KEY));
  }

  function bindSettings() {
    $('#btn-copy-agent-prompt').addEventListener('click', async () => {
      const prompt = $('#agent-prompt');
      const status = $('#agent-copy-status');
      try {
        await navigator.clipboard.writeText(prompt.value);
        status.textContent = '已复制，粘贴给你的 Agent 即可。';
      } catch {
        prompt.focus();
        prompt.select();
        status.textContent = '自动复制不可用，已选中提示词，请长按或使用复制快捷键。';
      }
    });

    $$('[data-newlimit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        store.settings.newLimit = Number(btn.dataset.newlimit);
        store.settingsAt = now();
        saveStore();
        applySettingsToUI();
        refreshIntro();
      });
    });

    $$('[data-spelling]').forEach((btn) => {
      btn.addEventListener('click', () => {
        store.settings.spelling = normSpelling(btn.dataset.spelling);
        store.settingsAt = now();
        saveStore();
        applySettingsToUI();
        refreshIntro();
        renderLibrary();
        toast(store.settings.spelling === 'off' ? '已切换为只认不拼' : '已切换为认词 + 拼写');
      });
    });

    $$('[data-pace]').forEach((btn) => {
      btn.addEventListener('click', () => applyPacePreset(btn.dataset.pace));
    });

    const noSpell = $('#set-no-spelling');
    if (noSpell) {
      noSpell.addEventListener('change', () => {
        store.settings.spelling = noSpell.checked ? 'off' : 'auto';
        store.settingsAt = now();
        saveStore();
        applySettingsToUI();
        refreshIntro();
        renderLibrary();
      });
    }

    const sp = $('#set-speak');
    sp.addEventListener('change', () => {
      store.settings.speak = sp.checked;
      saveStore();
    });

    $('#btn-export').addEventListener('click', () => exportProgress(JSON.stringify(store, null, 2)));
    $('#btn-backup').addEventListener('click', () => exportProgress(localStorage.getItem(scopedKey(BACKUP_KEY)), 'before-upgrade'));

    $('#import-file').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const imported = readStore(data);
        migrateStore(imported, data.version);
        keepBackup(localStorage.getItem(scopedKey(STORE_KEY)) || JSON.stringify(data));
        store = imported;
        saveStore();
        applySettingsToUI();
        refreshIntro();
        renderLibrary();
        toast('进度已导入');
      } catch (err) {
        toast('导入失败：' + err.message);
      } finally {
        e.target.value = '';
      }
    });

    $('#btn-reset').addEventListener('click', () => {
      if (!confirm('确认清空当前词库的全部学习进度？词库单词不受影响，此操作不可撤销。')) return;
      store = defaultStore();
      saveStore();
      applySettingsToUI();
      refreshIntro();
      renderLibrary();
      renderWordbooks();
      toast('进度已清空');
    });

    applySettingsToUI();
    $('#meta-count').textContent = WORDS.length;
    $('#meta-updated').textContent = META.updated || '—';
  }

  function exportProgress(raw, suffix = dayKey(now())) {
    if (!raw) return;
    const blob = new Blob([raw], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `worddrill-progress-${suffix}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('已导出进度文件');
  }

  /* ---------- 词库管理视图 ---------- */
  function readBookProgressSummary(bookId, totalWords) {
    let parsed;
    try {
      const raw = bookId === activeRepository
        ? null
        : localStorage.getItem(scopedKey(STORE_KEY, bookId));
      parsed = bookId === activeRepository ? store : (raw ? readStore(JSON.parse(raw)) : defaultStore());
    } catch {
      parsed = defaultStore();
    }
    const entries = Object.values(parsed.words || {});
    const mastered = entries.filter((p) => p.stage === 'mastered').length;
    const started = entries.filter((p) => p.stage !== 'new' || p.introducedAt).length;
    const t = now();
    const due = entries.filter((p) => (p.stage !== 'new' || p.introducedAt) && p.due <= t).length;
    const total = bookId === activeRepository ? WORDS.length : (totalWords || 0);
    const pct = total ? Math.min(100, Math.round((mastered / total) * 100)) : 0;
    return { total, mastered, started, due, pct };
  }

  function renderWordbooks() {
    const localBox = $('#local-books-list');
    const cloudBox = $('#cloud-books-list');
    if (!localBox || !cloudBox) return;

    const reg = syncWordbooksRegistry();
    const books = Object.values(reg.books);
    const locals = books.filter((b) => b.type === 'local').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const clouds = books.filter((b) => b.type === 'cloud').sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const profiles = JSON.parse(localStorage.getItem('worddrill.repositories.v1') || '{}');

    $('#local-books-empty').hidden = locals.length > 0;
    localBox.innerHTML = locals.map((b) => {
      const active = b.id === activeRepository;
      const s = readBookProgressSummary(b.id, b.wordCount);
      return `
        <div class="book-item ${active ? 'is-active' : ''}">
          <div class="book-item__top">
            <span class="book-badge book-badge--local">本地词库</span>
            <strong class="book-item__title">${esc(b.name)}</strong>
            ${active ? '<span class="book-item__active-pill">当前使用</span>' : ''}
          </div>
          ${Array.isArray(b.sources) && b.sources.length ? `
            <div class="book-item__sources">
              ${b.sources.map((src) => `<span class="source-tag">${esc(src)}</span>`).join('')}
            </div>` : ''}
          <div class="book-item__stats">
            <span>共 <b>${s.total}</b> 词 · 已掌握 ${s.mastered}（${s.pct}%）· 已学 ${s.started} · 待复习 ${s.due}</span>
            <div class="book-item__bar" aria-hidden="true"><span class="book-item__bar-fill" style="width:${s.pct}%"></span></div>
          </div>
          <div class="book-item__actions">
            ${active
              ? '<button class="btn btn--primary btn--sm" data-book-train="1" type="button">去训练</button>'
              : `<button class="btn btn--primary btn--sm" data-book-use="${esc(b.id)}" type="button">切换使用</button>`}
            <button class="btn btn--ghost btn--sm" data-book-upload="${esc(b.id)}" type="button">上传到云端</button>
            <button class="btn btn--ghost btn--sm" data-book-rename="${esc(b.id)}" type="button">重命名</button>
            <button class="btn btn--danger btn--sm" data-book-delete="${esc(b.id)}" type="button">删除</button>
          </div>
        </div>`;
    }).join('');

    $('#cloud-books-empty').hidden = clouds.length > 0;
    cloudBox.innerHTML = clouds.map((b) => {
      const active = b.id === activeRepository;
      const p = profiles[b.id] || {};
      const s = readBookProgressSummary(b.id, b.wordCount);
      const syncText = active ? describeSync() : (p.lastResult || '已保存');
      return `
        <div class="book-item ${active ? 'is-active' : ''}">
          <div class="book-item__top">
            <span class="book-badge book-badge--cloud">云端词库</span>
            <strong class="book-item__title">${esc(b.name)}</strong>
            ${active ? '<span class="book-item__active-pill">当前使用</span>' : ''}
          </div>
          <div class="book-item__stats">
            <span>共 <b>${s.total}</b> 词 · 已掌握 ${s.mastered}（${s.pct}%）· 同步：${esc(syncText)}</span>
            <div class="book-item__bar" aria-hidden="true"><span class="book-item__bar-fill" style="width:${s.pct}%"></span></div>
          </div>
          <div class="book-item__actions">
            ${active
              ? `<button class="btn btn--primary btn--sm" data-book-train="1" type="button">去训练</button>
                 <button class="btn btn--ghost btn--sm" data-book-sync="${esc(b.id)}" type="button">立即同步</button>`
              : `<button class="btn btn--primary btn--sm" data-book-use="${esc(b.id)}" type="button">切换并同步</button>`}
            <button class="btn btn--ghost btn--sm" data-book-config="${esc(b.id)}" type="button">配置 / Token</button>
            <button class="btn btn--danger btn--sm" data-book-remove-cloud="${esc(b.id)}" type="button">移出列表</button>
          </div>
        </div>`;
    }).join('');

    $$('[data-book-train]').forEach((btn) => btn.addEventListener('click', () => switchView('learn')));
    $$('[data-book-use]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.bookUse;
      try {
        await selectWordbook(id);
        toast('已切换词库');
        if (isCloudBook(id) && sync.enabled && sync.token) syncNow({ silent: false });
      } catch (err) { toast(err.message); }
    }));
    $$('[data-book-sync]').forEach((btn) => btn.addEventListener('click', () => syncNow({ silent: false })));
    $$('[data-book-config]').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        if (btn.dataset.bookConfig !== activeRepository) await selectWordbook(btn.dataset.bookConfig);
        $('#cloud-config-panel').hidden = false;
        $('#cloud-config-panel').scrollIntoView?.({ block: 'nearest' });
      } catch (err) { toast(err.message); }
    }));
    $$('[data-book-rename]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.bookRename;
      const cur = loadWordbooks();
      const target = cur.books[id];
      if (!target) return;
      const nextName = prompt('输入新的词库名称：', target.name);
      if (!nextName || !nextName.trim()) return;
      target.name = nextName.trim();
      saveWordbooks(cur);
      renderWordbooks();
      refreshActiveBookBar();
      toast('词库名称已更新');
    }));
    $$('[data-book-delete]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.bookDelete;
      const cur = loadWordbooks();
      const target = cur.books[id];
      if (!target) return;
      if (!confirm(`确认删除本地词库「${target.name}」？\n该词库的单词表和本地学习进度都会被删除，不可撤销。`)) return;
      await deleteWordbook(id);
    }));
    $$('[data-book-remove-cloud]').forEach((btn) => btn.addEventListener('click', async () => {
      const id = btn.dataset.bookRemoveCloud;
      const cur = loadWordbooks();
      const target = cur.books[id];
      if (!target) return;
      if (!confirm(`将云端词库「${target.name}」从本机列表移出？\n（不会删除 GitHub 仓库里的文件）`)) return;
      await deleteWordbook(id);
    }));
    $$('[data-book-upload]').forEach((btn) => btn.addEventListener('click', () => openUploadModal(btn.dataset.bookUpload)));
  }

  async function deleteWordbook(id) {
    if (syncing || session) { toast('请等待当前同步或训练结束后再操作'); return; }
    const reg = loadWordbooks();
    const book = reg.books[id];
    if (!book) return;
    delete reg.books[id];
    if (book.type === 'cloud') {
      const profiles = JSON.parse(localStorage.getItem('worddrill.repositories.v1') || '{}');
      delete profiles[id];
      localStorage.setItem('worddrill.repositories.v1', JSON.stringify(profiles));
      if (id === activeRepository) {
        sync = defaultSync();
        saveSync();
      }
    }
    for (const k of [STORE_KEY, BACKUP_KEY, 'worddrill.backup.before-v5', 'worddrill.vocabulary.v1']) {
      localStorage.removeItem?.(scopedKey(k, id));
    }
    await vocabDB.del(id);

    const remainingIds = Object.keys(reg.books);
    if (reg.activeId === id || activeRepository === id) {
      reg.activeId = remainingIds[0] || '';
      saveWordbooks(reg);
      if (reg.activeId) {
        await selectWordbook(reg.activeId);
      } else {
        activeRepository = '';
        sync = defaultSync();
        store = defaultStore();
        setVocabulary({ words: [] });
        saveSync();
        applySyncToUI(); applySettingsToUI(); refreshIntro(); renderLibrary(); refreshCetReview(); renderWordbooks();
      }
    } else {
      saveWordbooks(reg);
      renderWordbooks();
    }
    toast(book.type === 'cloud' ? '已从本机列表移出' : '本地词库已删除');
  }

  /* ---------- 创建本地词库弹窗 ---------- */
  function openModal(id) {
    const el = $(`#${id}`);
    if (el) el.hidden = false;
  }

  function closeModal(id) {
    const el = $(`#${id}`);
    if (el) el.hidden = true;
  }

  async function loadPublicCatalog(repoSpec = catalogState.repo) {
    const listEl = $('#catalog-list');
    const statusEl = $('#catalog-status');
    const confirmBtn = $('#btn-create-local-confirm');
    catalogState.repo = repoSpec.trim() || DEFAULT_WORDLIST_REPO;
    $('#wordlist-repo-label').textContent = catalogState.repo;
    statusEl.textContent = '正在拉取公开词表目录…';
    statusEl.className = 'hint';
    listEl.innerHTML = '';
    confirmBtn.disabled = true;

    try {
      const data = await fetchPublicRepoJson(catalogState.repo, 'index.json');
      if (!data || !Array.isArray(data.wordlists) || !data.wordlists.length) {
        throw new Error('仓库 index.json 里没有可用词表');
      }
      catalogState.data = data;
      listEl.innerHTML = data.wordlists.map((item) => `
        <label class="catalog-item">
          <input type="checkbox" data-wl-id="${esc(item.id)}" value="${esc(item.id)}">
          <div class="catalog-item__main">
            <div class="catalog-item__head">
              <strong>${esc(item.name || item.shortName || item.id)}</strong>
              ${item.tag ? `<span class="source-tag">${esc(item.tag)}</span>` : ''}
              <span class="catalog-item__count">${Number(item.count || 0)} 词</span>
            </div>
            ${item.description ? `<p class="catalog-item__desc">${esc(item.description)}</p>` : ''}
          </div>
        </label>`).join('');
      statusEl.textContent = `已加载 ${data.wordlists.length} 套词表（支持单选或多选合并）`;
      $$('input[data-wl-id]', listEl).forEach((cb) => cb.addEventListener('change', updateCreateLocalSelection));
      updateCreateLocalSelection();
    } catch (err) {
      statusEl.textContent = '拉取词表目录失败：' + (err.message || '请检查网络后重试');
      statusEl.className = 'hint sync-status is-error';
    }
  }

  function updateCreateLocalSelection() {
    const checked = $$('input[data-wl-id]:checked', $('#catalog-list')).map((i) => i.value);
    const items = (catalogState.data?.wordlists || []).filter((w) => checked.includes(w.id));
    const sumEl = $('#create-book-summary');
    const nameInput = $('#create-book-name');
    const confirmBtn = $('#btn-create-local-confirm');

    if (!items.length) {
      sumEl.textContent = '请选择至少一个词表';
      confirmBtn.disabled = true;
      if (!catalogState.nameEdited) nameInput.value = '';
      return;
    }
    const approx = items.reduce((acc, it) => acc + Number(it.count || 0), 0);
    const autoName = items.map((it) => it.shortName || it.name || it.id).join(' + ');
    if (!catalogState.nameEdited) nameInput.value = autoName;
    sumEl.textContent = `已选 ${items.length} 个词表（约 ${approx} 词，重叠单词将自动合并去重）`;
    confirmBtn.disabled = false;
  }

  async function confirmCreateLocalBook() {
    const checked = $$('input[data-wl-id]:checked', $('#catalog-list')).map((i) => i.value);
    const items = (catalogState.data?.wordlists || []).filter((w) => checked.includes(w.id));
    if (!items.length) return;

    const btn = $('#btn-create-local-confirm');
    const statusEl = $('#catalog-status');
    const bookName = ($('#create-book-name').value || '').trim()
      || items.map((it) => it.shortName || it.name || it.id).join(' + ');

    btn.disabled = true;
    btn.textContent = '正在下载词表…';
    statusEl.className = 'hint';
    statusEl.textContent = `正在从 ${catalogState.repo} 拉取 ${items.length} 份词表…`;

    try {
      const distPath = catalogState.data?.distractors;
      const [wordlistPayloads, distPayload] = await Promise.all([
        Promise.all(items.map((it) => fetchPublicRepoJson(catalogState.repo, it.file))),
        distPath ? fetchPublicRepoJson(catalogState.repo, distPath).catch(() => ({ words: [] })) : Promise.resolve({ words: [] })
      ]);

      const merged = mergeWordlists(wordlistPayloads, distPayload?.words || []);
      if (!merged.words.length) throw new Error('拉取的词表没有有效单词');

      const id = 'local:' + randomId();
      const reg = loadWordbooks();
      reg.books[id] = {
        id,
        type: 'local',
        name: bookName,
        sources: merged.meta.sources,
        wordCount: merged.words.length,
        createdAt: now(),
        updatedAt: now()
      };
      saveWordbooks(reg);
      localStorage.setItem(scopedKey(STORE_KEY, id), JSON.stringify(defaultStore()));
      saveVocabularyLocal(merged, id);
      await vocabDB.set(id, merged);

      await selectWordbook(id);
      closeModal('modal-create-local');
      toast(`已创建本地词库「${bookName}」（${merged.words.length} 词）`);
    } catch (err) {
      statusEl.textContent = '创建失败：' + (err.message || '未知错误');
      statusEl.className = 'hint sync-status is-error';
    } finally {
      btn.disabled = false;
      btn.textContent = '拉取并创建';
    }
  }

  /* ---------- 上传本地词库到云端弹窗 ---------- */
  function selectedUploadMode() {
    return $('input[name="upload-mode"]:checked')?.value || 'append';
  }

  function updateUploadPreview() {
    const preview = $('#upload-preview');
    const confirmBtn = $('#btn-upload-confirm');
    const mode = selectedUploadMode();
    const replaceWrap = $('#upload-replace-progress-wrap');
    if (replaceWrap) replaceWrap.hidden = mode !== 'replace';

    if (!uploadState.ready || !uploadState.localVocab) {
      preview.textContent = '请先点击「读取云端当前词库」以验证权限并预览变更。';
      confirmBtn.disabled = true;
      return;
    }

    const plan = planCloudUpload({
      localVocab: uploadState.localVocab,
      localProgress: uploadState.localProgress,
      remoteVocab: uploadState.remoteVocab,
      remoteProgress: uploadState.remoteProgress,
      mode,
      replaceProgress: !!$('#upload-replace-progress')?.checked
    });
    const s = plan.summary;
    const modeName = mode === 'append' ? '新增合并' : mode === 'overwrite' ? '覆盖更新' : '整库替换';
    preview.innerHTML = `
      <strong>变更预览（${modeName}）</strong><br>
      云端原有 <b>${s.remoteCount}</b> 词 · 本次本地 <b>${s.localCount}</b> 词<br>
      新增 <b>+${s.added}</b> 词 · 覆盖 <b>${s.overwritten}</b> 词 · 移除 <b>-${s.removed}</b> 词 → 上传后共 <b>${s.finalCount}</b> 词`;
    confirmBtn.disabled = false;
  }

  async function openUploadModal(bookId) {
    const reg = loadWordbooks();
    const book = reg.books[bookId];
    if (!book || book.type !== 'local') return;

    const localVocab = await vocabDB.get(bookId) || JSON.parse(localStorage.getItem(scopedKey('worddrill.vocabulary.v1', bookId)) || 'null');
    if (!localVocab || !Array.isArray(localVocab.words) || !localVocab.words.length) {
      toast('本地词库为空，无法上传');
      return;
    }

    uploadState = {
      localBookId: bookId,
      localVocab,
      localProgress: loadStore(bookId),
      targetConfig: null,
      remoteVocab: null,
      remoteProgress: null,
      ready: false
    };

    $('#upload-source-desc').textContent = `来源：本地词库「${book.name}」（${localVocab.words.length} 词）`;
    const profiles = JSON.parse(localStorage.getItem('worddrill.repositories.v1') || '{}');
    const savedOptions = Object.entries(profiles).map(([id, p]) =>
      `<option value="${esc(id)}">${esc(p.owner)}/${esc(p.repo)}</option>`).join('');
    const sel = $('#upload-target-select');
    sel.innerHTML = savedOptions + '<option value="__new__">+ 填写新的私有 GitHub 仓库</option>';
    const firstCloud = Object.keys(profiles)[0] || '__new__';
    sel.value = firstCloud;
    $('#upload-new-repo-fields').hidden = firstCloud !== '__new__';
    $('#upload-inspect-status').textContent = '';
    $('#upload-status').textContent = '';
    $('#upload-replace-progress').checked = false;
    $('input[name="upload-mode"][value="append"]').checked = true;
    updateUploadPreview();
    openModal('modal-upload-cloud');
  }

  function resolveUploadTargetConfig() {
    const selVal = $('#upload-target-select').value;
    if (selVal !== '__new__') {
      const profiles = JSON.parse(localStorage.getItem('worddrill.repositories.v1') || '{}');
      return profiles[selVal] ? { ...profiles[selVal] } : null;
    }
    const rawOwner = $('#upload-owner').value.trim();
    const parsed = parseRepoSpec(rawOwner);
    const owner = parsed ? parsed.owner : rawOwner;
    const repo = parsed ? parsed.repo : $('#upload-repo').value.trim();
    if (parsed) {
      $('#upload-owner').value = owner;
      $('#upload-repo').value = repo;
    }
    return {
      ...defaultSync(),
      owner,
      repo,
      token: $('#upload-token').value.trim()
    };
  }

  async function inspectUploadTarget() {
    const statusEl = $('#upload-inspect-status');
    const errEl = $('#upload-status');
    errEl.textContent = '';
    errEl.className = 'hint sync-status';
    const cfg = resolveUploadTargetConfig();
    if (!cfg || !cfg.owner || !cfg.repo || !cfg.token) {
      statusEl.textContent = '请先把目标仓库和 token 填完整';
      return;
    }
    statusEl.textContent = '正在读取云端状态…';
    uploadState.ready = false;
    updateUploadPreview();

    try {
      const diag = await diagnoseSync(cfg);
      if (diag.mode !== 'ok') throw new Error(diag.text);

      const [remoteWordsFile, remoteDistFile, remoteProgFile] = await Promise.all([
        remoteReadFile('data/words.json', cfg, true),
        remoteReadFile('data/distractors.json', cfg, true),
        remoteReadFile(cfg.path || 'progress.json', cfg, true)
      ]);
      uploadState.targetConfig = cfg;
      uploadState.remoteVocab = {
        ...(remoteWordsFile?.data || { words: [] }),
        distractors: remoteDistFile?.data?.words || []
      };
      uploadState.remoteProgress = remoteProgFile?.data || null;
      uploadState.ready = true;
      statusEl.textContent = `已读取 ${cfg.owner}/${cfg.repo}（云端原有 ${uploadState.remoteVocab.words.length} 词）`;
      updateUploadPreview();
    } catch (err) {
      statusEl.textContent = '检查失败';
      errEl.textContent = err.message || '读取云端失败';
      errEl.className = 'hint sync-status is-error';
      updateUploadPreview();
    }
  }

  async function confirmUploadToCloud() {
    if (!uploadState.ready || !uploadState.targetConfig) return;
    const btn = $('#btn-upload-confirm');
    const errEl = $('#upload-status');
    btn.disabled = true;
    btn.textContent = '正在上传…';
    errEl.textContent = '';
    errEl.className = 'hint sync-status';

    try {
      const res = await uploadLocalToCloud({
        localBookId: uploadState.localBookId,
        targetConfig: uploadState.targetConfig,
        mode: selectedUploadMode(),
        replaceProgress: !!$('#upload-replace-progress').checked
      });
      renderWordbooks();
      closeModal('modal-upload-cloud');
      toast(`已上传到 ${res.savedConfig.owner}/${res.savedConfig.repo}（共 ${res.plan.summary.finalCount} 词）`);
    } catch (err) {
      errEl.textContent = '上传失败：' + (err.message || '未知错误');
      errEl.className = 'hint sync-status is-error';
    } finally {
      btn.disabled = false;
      btn.textContent = '确认上传到云端';
    }
  }

  /* ---------- 同步面板（兼容原有选择器） ---------- */
  function applySyncToUI() {
    const profiles = JSON.parse(localStorage.getItem('worddrill.repositories.v1') || '{}');
    $('#data-repository').innerHTML = '<option value="">选择已保存的数据仓库</option>' + Object.entries(profiles).map(([id, p]) =>
      `<option value="${esc(id)}"${id === activeRepository ? ' selected' : ''}>${esc(p.owner)}/${esc(p.repo)}</option>`).join('');
    $('#sync-owner').value = sync.owner || '';
    $('#sync-repo').value = sync.repo || '';
    $('#sync-path').value = sync.path || 'progress.json';
    $('#sync-token').value = sync.token || '';
    $('#sync-enabled').checked = !!sync.enabled;
    $('#sync-device').textContent = sync.deviceId;
    setSyncStatus(describeSync(), /失败/.test(sync.lastResult || '') ? 'error' : sync.lastSyncAt ? 'ok' : '');
    $('#btn-sync-now').disabled = !sync.enabled || !isCloudBook();
    $('#btn-use-repository').disabled = syncing;
    $('#data-repository').disabled = syncing;
  }

  function bindSync() {
    const readForm = () => {
      normalizeRepoFields();
      const next = { ...sync, owner: $('#sync-owner').value.trim(), repo: $('#sync-repo').value.trim(),
        path: $('#sync-path').value.trim() || 'progress.json', token: $('#sync-token').value.trim(),
        enabled: $('#sync-enabled').checked };
      if (syncing) { toast('同步中，请稍后再修改仓库设置'); return false; }
      try {
        if (repositoryId(next) !== activeRepository) {
          next.lastSyncAt = 0; next.lastResult = '';
          selectRepository(next);
        } else { sync = next; saveSync(); saveProfile(); }
        return true;
      } catch (e) { toast(e.message); return false; }
    };
    $('#btn-use-repository').addEventListener('click', () => {
      if (readForm()) {
        sync.enabled = true; saveSync(); saveProfile(); syncWordbooksRegistry();
        applySyncToUI(); renderWordbooks(); syncNow({ silent: false });
      }
    });
    $('#data-repository').addEventListener('change', (e) => {
      if (!e.target.value) return;
      try {
        const profiles = JSON.parse(localStorage.getItem('worddrill.repositories.v1') || '{}');
        selectRepository(profiles[e.target.value]);
        syncNow({ silent: false });
      } catch (err) { toast(err.message); applySyncToUI(); }
    });
    $('#sync-enabled').addEventListener('change', () => {
      if (!readForm()) { applySyncToUI(); return; }
      applySyncToUI();
      if (sync.enabled) syncNow({ silent: false });
    });

    $('#btn-toggle-token').addEventListener('click', () => {
      const el = $('#sync-token');
      el.type = el.type === 'password' ? 'text' : 'password';
      $('#btn-toggle-token').textContent = el.type === 'password' ? '显示' : '隐藏';
    });

    $('#btn-sync-now').addEventListener('click', () => { if (readForm()) syncNow({ silent: false }); });

    $('#btn-sync-test').addEventListener('click', async () => {
      if (!readForm()) return;
      const btn = $('#btn-sync-test');
      btn.disabled = true;
      setSyncStatus('测试中…');
      try {
        const r = await diagnoseSync();
        setSyncStatus(r.text, r.mode);
        toast(r.mode === 'ok' ? '连接正常' : '连接测试没过，看下方提示');
      } catch (e) {
        setSyncStatus('测试出错：' + ((e && e.message) || '未知错误'), 'error');
      } finally {
        btn.disabled = false;
      }
    });

    $('#btn-sync-forget').addEventListener('click', () => {
      if (!confirm('清除当前云端仓库在本机保存的 token？\n（只影响这台设备；远端进度文件不删，学习进度也不动）')) return;
      if (syncing) { toast('请等待同步结束'); return; }
      sync = { ...sync, token: '', enabled: false, lastResult: '' };
      saveProfile();
      saveSync();
      applySyncToUI();
      renderWordbooks();
      toast('已清除当前仓库的 token');
    });
  }

  /* ---------- 发音 ---------- */
  const canSpeak = () => 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
  function speak(text, onError = null) {
    if (!canSpeak()) { onError?.(); return; }
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 0.9;
      if (onError) u.onerror = (event) => {
        if (!['canceled', 'interrupted'].includes(event?.error)) onError();
      };
      window.speechSynthesis.speak(u);
    } catch { onError?.(); }
  }

  /* ---------- 视图切换 ---------- */
  function switchView(name) {
    if (session && name !== 'learn') return;
    $$('.view').forEach((v) => {
      const on = v.id === `view-${name}`;
      v.classList.toggle('is-active', on);
      v.hidden = !on;
    });
    $$('.nav__item').forEach((b) => {
      const on = b.dataset.view === name;
      b.classList.toggle('is-active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (name === 'library') renderLibrary();
    if (name === 'books') renderWordbooks();
    if (name === 'settings') applySettingsToUI();
    if (name === 'learn') {
      if (!session) showPanel('intro');
      refreshIntro();
    }
    location.hash = name === 'learn' ? '' : `#${name}`;
    $('#main').scrollIntoView({ block: 'start', behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    $$('.nav__item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
    $$('[data-view]').forEach((b) => {
      if (!b.classList.contains('nav__item')) b.addEventListener('click', () => switchView(b.dataset.view));
    });

    $('#btn-start').addEventListener('click', () => startSession());
    $('#btn-review').addEventListener('click', () => startSession('review'));
    $('#btn-practice').addEventListener('click', () => startSession('practice'));
    $('#btn-context').addEventListener('click', () => startSession('context'));
    $('#btn-listen').addEventListener('click', () => startSession('listen'));
    $('#btn-mistakes').addEventListener('click', () => startSession('mistakes'));
    $('#btn-summary-mistakes').addEventListener('click', () => startSession('mistakes', summaryMistakes));
    $('#btn-summary-home').addEventListener('click', () => switchView('learn'));
    $('#btn-again').addEventListener('click', () => { showPanel('intro'); refreshIntro(); startSession(); });
    $('#btn-end').addEventListener('click', endSession);
    $('#btn-next').addEventListener('click', () => {
      if (!session || !session.answered) return;
      if (session && session.done >= session.total) endSession();
      else nextQuestion();
    });

    $$('.segmented__item').forEach((b) => {
      b.addEventListener('click', () => {
        libFilter = b.dataset.filter;
        libVisibleCount = LIB_PAGE_SIZE;
        $$('.segmented__item').forEach((x) => x.classList.toggle('is-active', x === b));
        renderLibrary();
      });
    });

    $('#lib-search').addEventListener('input', (e) => {
      libQuery = e.target.value;
      libVisibleCount = LIB_PAGE_SIZE;
      renderLibrary();
    });

    $('#btn-lib-more')?.addEventListener('click', () => {
      libVisibleCount += LIB_PAGE_SIZE;
      renderLibrary();
    });

    // 词库管理 & 弹窗事件
    $('#btn-toggle-cloud-form')?.addEventListener('click', () => {
      const panel = $('#cloud-config-panel');
      if (panel) panel.hidden = !panel.hidden;
    });

    $('#btn-open-create-local')?.addEventListener('click', () => {
      catalogState.nameEdited = false;
      $('#create-book-name').value = '';
      openModal('modal-create-local');
      loadPublicCatalog($('#wordlist-repo-input').value || DEFAULT_WORDLIST_REPO);
    });

    $('#btn-reload-catalog')?.addEventListener('click', () => {
      catalogState.nameEdited = false;
      loadPublicCatalog($('#wordlist-repo-input').value || DEFAULT_WORDLIST_REPO);
    });

    $('#create-book-name')?.addEventListener('input', () => {
      catalogState.nameEdited = true;
    });

    $('#btn-create-local-confirm')?.addEventListener('click', confirmCreateLocalBook);

    $('#upload-target-select')?.addEventListener('change', (e) => {
      $('#upload-new-repo-fields').hidden = e.target.value !== '__new__';
      uploadState.ready = false;
      $('#upload-inspect-status').textContent = '';
      updateUploadPreview();
    });

    $('#btn-upload-inspect')?.addEventListener('click', inspectUploadTarget);
    $$('input[name="upload-mode"]').forEach((r) => r.addEventListener('change', updateUploadPreview));
    $('#upload-replace-progress')?.addEventListener('change', updateUploadPreview);
    $('#btn-upload-confirm')?.addEventListener('click', confirmUploadToCloud);

    $$('[data-close-modal]').forEach((el) => {
      el.addEventListener('click', () => closeModal(el.dataset.closeModal));
    });

    // 键盘：选择题 1-4 直接作答；Enter 进入下一题
    document.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if ($('#view-learn').hidden) return;
      const quizVisible = !$('#session-quiz').hidden;
      if (!quizVisible || !session) return;
      const tag = document.activeElement?.tagName;
      const typing = tag === 'INPUT';

      if (!session.answered && session.current.optionsReady && /^[1-4]$/.test(e.key) && !typing) {
        const btn = $$('.option')[Number(e.key) - 1];
        if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
      }
      if (e.key === 'Enter' && session.answered) {
        if (typing) return;
        const el = document.activeElement;
        if (el && el.tagName === 'BUTTON' && !el.disabled && el.id !== 'btn-next') return;
        e.preventDefault();
        $('#btn-next').click();
      }
    });
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    sync = loadSync();
    try {
      migrateRepositoryStorage();
      if (typeof FSRS === 'undefined') throw new Error('复习算法未载入，请联网刷新一次');
      store = loadStore();
    } catch (err) {
      $('#session-intro').innerHTML = `<h2 class="intro__title">进度未被改动</h2>
        <p class="intro__sub">${esc(err.message || '无法读取进度')}。为保护原记录，本次暂停训练。</p>
        <button class="btn btn--ghost" id="btn-rescue" type="button">导出原始进度</button>`;
      $('#btn-rescue').addEventListener('click', () => exportProgress(localStorage.getItem(scopedKey(STORE_KEY)), 'original'));
      return;
    }
    if (isCloudBook()) saveProfile();
    if (storeMigrated) saveStore();
    try { await restoreVocabularyAsync(); }
    catch { setVocabulary({ words: [] }); }

    syncWordbooksRegistry();
    bindEvents();
    bindSettings();
    bindSync();
    applySyncToUI();
    renderWordbooks();
    refreshIntro();
    showPanel('intro');
    bindAutoSync();

    const hash = location.hash.replace('#', '');
    if (['books', 'library', 'settings'].includes(hash)) switchView(hash);
    else if (!WORDS.length) switchView('books');

    if (isCloudBook()) autoSync();
    refreshCetReview();
  }

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 忽略 */ });
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
