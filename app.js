/* ============================================================
   WordDrill — app
   两阶段记忆模型：认（Recognition）→ 写（Production）
   调度：简化 SM-2（强度 0-5 → 间隔 10min / 1 / 3 / 7 / 16 / 35 天）
   ============================================================ */
(() => {
  'use strict';

  /* ---------- 常量 ---------- */
  const STORE_KEY = 'worddrill.v1';
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

  /**
   * 「长期记住」判定模型 —— 核心不是「当场答对几次」，而是「跨了多少个不同的日子」。
   *
   * 一个词在当前阶段，于一个自然月（PASS_WINDOW = 30 天）内累计有 threshold 天答对过，
   * 才允许升到下一阶段。
   *
   * 三条规则：
   * 1. **一天内可以反复刷**：答对后只是进入一个 20 分钟冷却（CREDIT_DUE），
   *    冷却过去它又会回到队列，当天想练几遍都行。
   * 2. **一天只记一次**：不论当天刷多少遍，`credits` 里最多只留当天的第一条记录。
   * 3. **答错全部清零**：任何一次答错都会清空已攒的全部天数（含当天），重新计数一个月。
   *    也就是「当天答对过才记这一天，之后又答错就整个作废」。
   */
  const PASS_WINDOW = 30 * DAY;
  /** 攒天数期间答对后的冷却：过去就能再刷一遍（一天内可反复练，但只记 1 天） */
  const CREDIT_DUE = 20 * MIN;
  /** 已掌握后的维护间隔：不再需要攒，只需偶尔回访 */
  const MASTERED_DUE = 3 * DAY;
  /** 攒天数期间答错后的最短重来间隔（当轮还会回流一次） */
  const LAPSE_DUE = 3 * MIN;
  /** 新词首次答对即进入「认词中」，这一关不需要攒 */
  const CREDIT_NEED_MIN = 1, CREDIT_NEED_MAX = 30, CREDIT_NEED_DEFAULT = 15;
  const REQUESTS_PER_ROUND = 40;   // 单轮最大题量，避免无限循环

  /* ---------- 多设备同步（GitHub 私有仓库当存储） ---------- */
  const SYNC_KEY = 'worddrill.sync.v1';
  const SYNC_API = 'https://api.github.com';
  /** 学习参数才同步；主题/发音是设备偏好，各设备自己存 */
  const SYNCED_SETTINGS = ['newLimit', 'threshold'];
  /** 学习参数的合法区间，必须和设置页滑块的 min/max 一致，否则同步进来的值会让界面与实际不一致 */
  const SETTING_RANGE = { newLimit: [0, 40], threshold: [CREDIT_NEED_MIN, CREDIT_NEED_MAX] };

  function clampSetting(k, v) {
    const r = SETTING_RANGE[k];
    const n = Number(v);
    if (!r || !isFinite(n)) return undefined;
    return Math.min(r[1], Math.max(r[0], Math.round(n)));
  }

  function normalizeSettings(s) {
    for (const k of Object.keys(SETTING_RANGE)) {
      const c = clampSetting(k, s[k]);
      if (c !== undefined) s[k] = c;
    }
    return s;
  }

  /* ---------- 状态 ---------- */
  let WORDS = [];          // 词库
  let META = {};
  const byId = new Map();
  let store = null;        // 持久化状态
  let storeMigrated = false;  // 本次启动是否把旧存档升级过（升级结果要立刻写回，免得旧标签页又读到老值）
  let sync = null;         // 多设备同步配置（token 只在本机）
  let syncing = false;
  let session = null;      // 当前会话
  let libFilter = 'all';
  let libQuery = '';

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

  /* ---------- 持久化 ---------- */
  const STORE_VERSION = 4;   // v2 两周内天数 → v3 一个月内 15 天 + 当天可刷 → v4 修「旧同步值覆盖新判定」

  function defaultStore() {
    return {
      version: STORE_VERSION,
      settings: { newLimit: 10, threshold: CREDIT_NEED_DEFAULT, speak: true },
      settingsAt: 0,                   // 学习参数最后修改时间，用于多设备合并
      cet: { approved: [], rejected: [] },   // 四六级候选词的取舍决定，随进度一起同步
      words: {},                       // id → 进度
      stats: { answers: 0, correct: 0, sessions: 0, lastDate: null, streakDays: 0 }
    };
  }

  /**
   * 把旧版存档升级到当前语义。
   *
   * threshold 的含义改过三次（「连续答对几次」→「两周内有几天」→「一个月内有几天」→
   * 「一个月内有几天 + 当天可反复刷」），旧值在新语义下都不等价，一律置成新默认。
   *
   * 同时把 settingsAt 顶到现在 —— 否则本机刚拿到的正确默认值会被仓库里那条
   * 「旧语义、但时间戳不比我旧」的 threshold 挡回去（同步合并是按 settingsAt 比新旧的）。
   */
  function migrateStore(s, fromVersion) {
    if ((fromVersion || 1) >= STORE_VERSION) return false;
    s.version = STORE_VERSION;
    s.settings.threshold = CREDIT_NEED_DEFAULT;
    s.settingsAt = now();
    return true;
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultStore();
      const parsed = JSON.parse(raw);
      const merged = Object.assign(defaultStore(), parsed, {
        settings: Object.assign(defaultStore().settings, parsed.settings || {}),
        stats: Object.assign(defaultStore().stats, parsed.stats || {}),
        words: parsed.words || {}
      });
      if (migrateStore(merged, parsed.version)) storeMigrated = true;
      // 候选词取舍记录的结构保护（旧存档没有这个字段）
      if (!merged.cet || typeof merged.cet !== 'object'
          || !Array.isArray(merged.cet.approved) || !Array.isArray(merged.cet.rejected)) {
        merged.cet = { approved: [], rejected: [] };
      }
      // 老记录里的 strength / streak 已经没有意义，统一补上 credits
      for (const id of Object.keys(merged.words)) merged.words[id] = normalRec(merged.words[id]);
      normalizeSettings(merged.settings);
      return merged;
    } catch {
      return defaultStore();
    }
  }

  function saveStore() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch {
      toast('进度保存失败：浏览器存储被禁用');
    }
  }

  /** 取某个词的进度（不存在则视为未开始）。 */
  function progressOf(id) {
    return store.words[id] || {
      stage: 'new', credits: [],
      correct: 0, wrong: 0, due: 0, lastSeen: 0
    };
  }

  /* ---------- SRS 引擎 ---------- */
  /** 本地日期键（YYYY-MM-DD），用来判断两次答对是不是同一天。 */
  const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  /** 当前设置要求的「一个月内答对的天数」。 */
  const creditNeed = () =>
    Math.min(CREDIT_NEED_MAX, Math.max(CREDIT_NEED_MIN, Number(store.settings.threshold) || CREDIT_NEED_DEFAULT));

  /** 丢掉滚出一个月窗口的旧记录 —— 这就是「一个月内」的实现。 */
  const pruneCredits = (list, at) => (list || []).filter((ts) => at - ts <= PASS_WINDOW);

  /** 是否还需要攒天数（已掌握的词不再需要）。 */
  const needsCredits = (stage) => stage === 'recognize' || stage === 'write';

  /**
   * 这个词是不是「今天练过、还在冷却里」—— 用来支持一天之内反复刷同一个词。
   *
   * 注意必须看 `lastSeen`（最后一次作答时间）而不是 `credits`：
   * 新词首次答对只是升到「认词中」、并不记天，credits 仍是空的，
   * 只看 credits 会导致刚练完的词当天回不来。
   * 已掌握的词不算在内 —— 它们按维护间隔走，不需要一天刷好几遍。
   */
  function inCooling(p, t) {
    if (!needsCredits(p.stage)) return false;
    if (!(p.due > t)) return false;
    return !!p.lastSeen && dayKey(p.lastSeen) === dayKey(t);
  }

  /**
   * 判定一次作答并推进状态。
   * @returns {{before:object, after:object, promoted:boolean, demoted:boolean, credited:boolean, cleared:number}}
   */
  function grade(id, isCorrect) {
    const before = progressOf(id);
    const after = Object.assign({}, before, { credits: pruneCredits(before.credits, now()) });
    const need = creditNeed();
    let promoted = false, demoted = false, credited = false, cleared = 0;

    after.lastSeen = now();
    store.stats.answers++;
    if (isCorrect) store.stats.correct++;

    if (isCorrect) {
      after.correct++;

      if (after.stage === 'new') {
        // 新词只要认对一次就进入「认词中」；攒次数从这一关才开始
        after.stage = 'recognize';
        after.credits = [];
        promoted = true;
      } else {
        // 一天只记一次：当天已经记过就不再追加（一天内可以反复刷，但只算 1 天）
        if (!after.credits.some((ts) => dayKey(ts) === dayKey(after.lastSeen))) {
          after.credits.push(after.lastSeen);
          credited = true;
        }
        if (after.credits.length >= need && needsCredits(after.stage)) {
          if (after.stage === 'recognize') { after.stage = 'write'; promoted = true; after.credits = []; }
          else if (after.stage === 'write') { after.stage = 'mastered'; promoted = true; after.credits = []; }
        }
      }
    } else {
      after.wrong++;
      cleared = after.credits.length;
      after.credits = [];                       // 答错说明没记住，已攒次数清零重来
      if (after.stage === 'mastered') { after.stage = 'write'; demoted = true; }
    }

    // 间隔调度
    let base;
    if (!isCorrect) base = LAPSE_DUE;                       // 当轮稍后回流，趁热打铁
    else if (after.stage === 'mastered') base = MASTERED_DUE; // 已掌握：只做维护
    else base = CREDIT_DUE;                                  // 攒天数：20 分钟后可再刷
    after.due = now() + base;

    store.words[id] = after;
    saveStore();
    return { before, after, promoted, demoted, credited, cleared, need };
  }

  /** 根据当前阶段决定出题方式。 */
  function quizTypeFor(stage) {
    if (stage === 'write' || stage === 'mastered') return 'spell';
    return 'recognize';
  }

  /* ---------- 出题 ---------- */
  function buildRecognizeQuestion(word) {
    const others = WORDS.filter((w) => w.id !== word.id);
    // 干扰项优先取同词性的词，不够再用其它词补
    const samePos = shuffle(others.filter((w) => w.pos === word.pos));
    const rest = shuffle(others.filter((w) => w.pos !== word.pos));
    const distractors = samePos.concat(rest).slice(0, 3);

    const options = shuffle([
      { text: word.meaning, correct: true },
      ...distractors.map((w) => ({ text: w.meaning, correct: false }))
    ]);
    return { kind: 'recognize', word, options };
  }

  function buildSpellQuestion(word) {
    return { kind: 'spell', word, hint: letterHint(word.word) };
  }

  function buildFillQuestion(word) {
    return { kind: 'fill', word, hint: letterHint(word.word) };
  }

  /** 生成拼写提示：保留首字母与词内空格，其余用 · 占位。 */
  function letterHint(target) {
    const parts = String(target).split(/(\s+)/);
    return parts.map((p) => {
      if (/^\s+$/.test(p)) return p;
      if (p.length <= 1) return p;
      return p[0] + '·'.repeat(p.length - 1);
    }).join('');
  }

  /** 把例句里的目标词标出来（返回已转义的 HTML）。 */
  function highlight(example, target) {
    const safe = esc(example);
    if (!target) return safe;
    const pattern = new RegExp(`(${esc(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*)`, 'gi');
    return safe.replace(pattern, '<b>$1</b>');
  }

  /** 例句挖空。 */
  function blankExample(example, target) {
    const safe = esc(example);
    const re = new RegExp(esc(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return safe.replace(re, '<b>______</b>');
  }

  /* ---------- 多设备同步：GitHub 私有仓库当存储 ----------
     进度文件放在一个**私有**仓库里，token 用细粒度 PAT，
     只授权那一个仓库的 Contents 读写。token 只存在本机浏览器，只发给 api.github.com。 */

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
      return Object.assign(defaultSync(), JSON.parse(raw));
    } catch { return defaultSync(); }
  }

  function saveSync() {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); }
    catch { /* 存储被禁用，忽略 */ }
  }

  const b64Encode = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };

  const b64Decode = (b64) => {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  const syncApiUrl = () => {
    const p = String(sync.path || 'progress.json').replace(/^\/+/, '');
    return `${SYNC_API}/repos/${encodeURIComponent(sync.owner)}/${encodeURIComponent(sync.repo)}/contents/${p}`;
  };

  const syncHeaders = () => ({
    Authorization: `Bearer ${sync.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  });

  function syncHttpError(status, hint) {
    if (status === 401) return new Error('token 无效或已过期（401），重新生成一个细粒度 token');
    if (status === 403) return new Error('token 权限不足（403），确认 Contents 设成了 Read and write');
    if (status === 404) {
      // 关键：私有仓库在「token 没授权这个仓库」时也返回 404，而不是 403。
      // 只看状态码无法区分「没权限」和「路径写错」，所以这里要把这个坑说出来。
      return new Error(hint || (
        '看不到这个仓库（404）。注意私有仓库只要 token 没授权就返回 404 而不是 403，'
        + '所以多半不是路径写错。常见原因：① token 的 Repository access 没勾上这个仓库；'
        + '② 用了经典 token 但没给 repo 权限；③ Owner/Repo 拼错。点「测试连接」可精确定位'
      ));
    }
    return new Error(`请求失败（${status}）`);
  }

  /** 读远端进度；文件还不存在返回 null。 */
  async function remoteRead() {
    const url = `${syncApiUrl()}?ref=${encodeURIComponent(sync.branch)}&t=${now()}`;
    const res = await fetch(url, { headers: syncHeaders(), cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw syncHttpError(res.status);
    const j = await res.json();
    let data = null;
    try { data = JSON.parse(b64Decode(j.content)); } catch { data = null; }
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

  /**
   * 逐层探测并给出精确结论：仓库看不看得见 → 有没有写权限 → 分支在不在 → 文件能不能读。
   * 必须分层，因为 GitHub 把「无权访问私有仓库」也报成 404，单看一个错误码分不清原因。
   */
  async function diagnoseSync() {
    if (!sync.owner || !sync.repo) return { mode: 'error', text: '先把 Owner 和 Repo 填上' };
    if (!sync.token) return { mode: 'error', text: '先把 token 填上' };

    const full = `${sync.owner}/${sync.repo}`;
    const repoUrl = `${SYNC_API}/repos/${encodeURIComponent(sync.owner)}/${encodeURIComponent(sync.repo)}`;

    let res;
    try {
      res = await fetch(repoUrl, { headers: syncHeaders(), cache: 'no-store' });
    } catch {
      return { mode: 'error', text: '连不上 api.github.com —— 检查网络，或代理是否拦了它' };
    }

    if (res.status === 401) return { mode: 'error', text: 'token 无效或已过期（401），重新生成一个' };
    if (res.status === 403) return { mode: 'error', text: '被限流或权限不足（403），过一会再试' };
    if (res.status === 404) {
      return {
        mode: 'error',
        text: [
          `看不到 ${full}（404）。`,
          '私有仓库在 token 未授权时也返回 404，所以先别怀疑路径：',
          '① token 的 Repository access 没勾上这个仓库（细粒度 token 必须显式选中）；',
          '② 用了经典 token 但没给 repo 权限；',
          '③ Owner 或 Repo 拼错 —— 注意是 worddrill-data，中间有连字符。',
          `自己核对一下：github.com/${full}`
        ].join('\n')
      };
    }
    if (!res.ok) return { mode: 'error', text: `查询仓库失败（${res.status}）` };

    const info = await res.json();
    if (!(info.permissions && info.permissions.push)) {
      return {
        mode: 'error',
        text: `能看到 ${info.full_name}，但 token 只有读权限。\n`
            + '去 token 设置把 Contents 改成 Read and write（改完不必重新粘贴 token）'
      };
    }

    const brRes = await fetch(`${repoUrl}/branches/${encodeURIComponent(sync.branch)}`,
      { headers: syncHeaders(), cache: 'no-store' });
    if (brRes.status === 404) {
      return {
        mode: 'error',
        text: `仓库可写，但分支 ${sync.branch} 不存在（404）。\n`
            + '去仓库首页确认默认分支叫什么，改对再试'
      };
    }
    if (!brRes.ok) return { mode: 'error', text: `查询分支失败（${brRes.status}）` };

    const fileRes = await fetch(syncApiUrl(), { headers: syncHeaders(), cache: 'no-store' });
    const fileOk = fileRes.ok || fileRes.status === 404;
    let fileNote;
    if (fileRes.status === 404) fileNote = '进度文件还没建，首次同步会自动创建';
    else if (fileRes.ok) fileNote = '进度文件已存在，可正常读写';
    else fileNote = `读进度文件失败（${fileRes.status}）`;

    return {
      mode: fileOk ? 'ok' : 'error',
      text: `连接正常 ✓\n${info.full_name}（${info.private ? '私有' : '⚠️ 公开'}）· 分支 ${sync.branch}\n${fileNote}`
    };
  }

  /** 允许把 "owner/repo" 或整个仓库网址粘进 Owner 输入框，自动拆成两个字段。 */
  function normalizeRepoFields() {
    const el = $('#sync-owner');
    const raw = el.value.trim()
      .replace(/^https?:\/\//i, '')
      .replace(/^(www\.)?github\.com\//i, '')
      .replace(/\.git$/i, '');
    if (!raw.includes('/')) return;
    const parts = raw.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (parts.length >= 2) {
      el.value = parts[0];
      $('#sync-repo').value = parts[1];
    }
  }

  const normalRec = (r) => ({
    stage: r.stage || 'new',
    credits: Array.isArray(r.credits) ? r.credits.filter((t) => typeof t === 'number' && isFinite(t)) : [],
    due: r.due || 0, lastSeen: r.lastSeen || 0,
    correct: r.correct || 0, wrong: r.wrong || 0
  });

  function buildPayload() {
    const settings = {};
    for (const k of SYNCED_SETTINGS) settings[k] = store.settings[k];
    return {
      version: STORE_VERSION,      // 声明本条记录的判定语义版本，对面据此决定要不要采纳 settings
      app: 'worddrill',
      deviceId: sync.deviceId,
      syncedAt: now(),
      settingsAt: store.settingsAt || 0,
      settings,
      cet: store.cet || { approved: [], rejected: [] },
      stats: store.stats,
      words: store.words
    };
  }

  /** 只用来判断「内容有没有变」，排除 deviceId / syncedAt 这类每次都变的时间戳。 */
  const payloadSig = (p) => JSON.stringify({
    settings: p.settings || {}, settingsAt: p.settingsAt || 0,
    cet: p.cet || { approved: [], rejected: [] },
    stats: p.stats || {}, words: p.words || {}
  });

  /**
   * 逐词合并远端进度。核心取舍：
   * - 阶段 / 已攒天数 / 到期时间取「最后练习时间（lastSeen）」较新的一条 —— 位置以最近练过的那台设备为准
   * - 对错次数取两端较大值，而不是相加 —— 两台设备可能从同一份基线各自练习，相加会重复计数
   */
  function mergeRemote(remote) {
    if (!remote || typeof remote !== 'object') return false;
    let changed = false;

    const rw = (remote.words && typeof remote.words === 'object') ? remote.words : {};
    for (const id of new Set([...Object.keys(rw), ...Object.keys(store.words)])) {
      const mine = store.words[id];
      const theirs = rw[id];
      if (!theirs) continue;
      if (!mine) { store.words[id] = Object.assign(normalRec(theirs), { lastSeen: theirs.lastSeen || 0 }); changed = true; continue; }

      const newer = (theirs.lastSeen || 0) > (mine.lastSeen || 0) ? theirs : mine;
      const merged = normalRec(newer);
      merged.correct = Math.max(mine.correct || 0, theirs.correct || 0);
      merged.wrong = Math.max(mine.wrong || 0, theirs.wrong || 0);
      if (JSON.stringify(merged) !== JSON.stringify(normalRec(mine))) {
        store.words[id] = merged;
        changed = true;
      }
    }

    // 学习参数只在「两边语义版本一致」时互相同步。
    // 旧版本客户端（payload 里 version 落后）存的 threshold 是另一套含义的数字，
    // 采纳它会把本机刚迁移好的新默认值顶掉 —— 这正是「设置里明明该是 15 天，却显示 5 天」的原因。
    const remoteModel = Number(remote.version) || 1;
    const settingsOk = remoteModel >= STORE_VERSION;
    if (settingsOk && (remote.settingsAt || 0) > (store.settingsAt || 0) && remote.settings) {
      for (const k of SYNCED_SETTINGS) {
        const v = clampSetting(k, remote.settings[k]);
        if (v !== undefined && store.settings[k] !== v) { store.settings[k] = v; changed = true; }
      }
      store.settingsAt = remote.settingsAt || 0;
    }

    const rs = remote.stats || {};
    for (const k of ['answers', 'correct', 'sessions', 'streakDays']) {
      const v = Math.max(store.stats[k] || 0, rs[k] || 0);
      if (v !== (store.stats[k] || 0)) { store.stats[k] = v; changed = true; }
    }
    if (rs.lastDate && (!store.stats.lastDate || rs.lastDate > store.stats.lastDate)) {
      store.stats.lastDate = rs.lastDate;
      changed = true;
    }

    // 候选词的取舍决定：两端取并集（决定是不可撤销的标记，合并只会增多）
    const rc = remote.cet;
    if (rc && typeof rc === 'object') {
      store.cet = store.cet || { approved: [], rejected: [] };
      for (const k of ['approved', 'rejected']) {
        for (const id of (Array.isArray(rc[k]) ? rc[k] : [])) {
          if (!store.cet[k].includes(id)) { store.cet[k].push(id); changed = true; }
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
      // 从没成功同步过时，上次的失败原因比「还没同步过」有用得多
      if (sync.lastResult) return sync.lastResult;
      return sync.enabled ? '还没同步过' : '未开启';
    }
    const mins = Math.floor((now() - sync.lastSyncAt) / MIN);
    const when = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : mins < 1440 ? `${Math.floor(mins / 60)} 小时前` : `${Math.floor(mins / 1440)} 天前`;
    return `${when} · ${sync.lastResult || '已同步'}`;
  }

  /**
   * 拉取 → 逐词合并 → 若无变化则不再写远端。
   * 远端在读取与写入之间被别的设备改过会拿到 409，此时重读重合并（最多 3 轮）。
   */
  async function syncNow(opts) {
    const silent = !!(opts && opts.silent);
    if (syncing) return null;
    if (!sync.enabled || !sync.token || !sync.owner || !sync.repo) {
      if (!silent) toast('先把仓库和 token 填好');
      return null;
    }
    syncing = true;
    setSyncStatus('同步中…');
    try {
      let changed = false, pushed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await remoteRead();
        const remoteSig = (remote && remote.data) ? payloadSig(remote.data) : '';
        if (mergeRemote(remote && remote.data)) { changed = true; saveStore(); }

        const payload = buildPayload();
        if (remoteSig && remoteSig === payloadSig(payload)) break;   // 两端一致，不用产生一次提交
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
      sync.lastResult = changed ? (pushed ? '双向合并' : '已拉取') : (pushed ? '已上传' : '已是最新');
      saveSync();
      setSyncStatus(describeSync(), 'ok');
      if (changed) { applySettingsToUI(); refreshIntro(); renderLibrary(); refreshCetReview(); }
      return { changed, pushed };
    } catch (e) {
      const msg = '同步失败：' + ((e && e.message) || '未知错误');
      sync.lastResult = msg;
      saveSync();
      setSyncStatus(describeSync(), 'error');
      if (!silent) toast(msg);
      return null;
    } finally {
      syncing = false;
    }
  }

  /* ---------- 会话 ---------- */
  /**
   * 开始一轮训练。
   * 没有到期的词时，自动把「今天已经练过、还在冷却里」的词再带上 ——
   * 这样一天之内可以反复刷同一个词（不管从「开始训练」还是「再来一轮」进来都一样）。
   */
  function startSession() {
    const t = now();
    const pick = (allowCooling) => WORDS
      .filter((w) => {
        const p = progressOf(w.id);
        if (p.stage === 'new') return false;
        if (p.due <= t) return true;
        return allowCooling && inCooling(p, t);
      })
      // 攒得最少的排前面：优先补上离升阶最远的词
      .sort((a, b) => (progressOf(a.id).credits || []).length - (progressOf(b.id).credits || []).length);

    let dueWords = pick(false);
    if (!dueWords.length) dueWords = pick(true);

    const newLimit = Math.max(0, Number(store.settings.newLimit) || 0);
    const freshWords = WORDS.filter((w) => progressOf(w.id).stage === 'new').slice(0, newLimit);

    const queue = dueWords.concat(freshWords).map((w) => w.id);

    if (!queue.length) {
      const allMastered = WORDS.length > 0 && WORDS.every((w) => progressOf(w.id).stage === 'mastered');
      toast(allMastered ? '全部单词已掌握，暂时没有待复习的' : '暂时没有到期的词，过一会儿再来');
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
      results: new Map(),   // id → {before, after, promoted, demoted}
      requeued: 0
    };

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
    const type = quizTypeFor(stage);
    let q;
    if (type === 'spell') {
      // 巩固期的词穿插例句填空，检验是否真的会用
      q = (stage === 'mastered' && Math.random() < 0.45)
        ? buildFillQuestion(word)
        : buildSpellQuestion(word);
    } else {
      q = WORDS.length >= 4 ? buildRecognizeQuestion(word) : buildSpellQuestion(word);
    }

    session.current = q;
    session.answered = false;
    renderQuiz(q);
  }

  function answer(isCorrect, userAnswer) {
    if (!session || session.answered) return;
    const word = session.current.word;
    const r = grade(word.id, isCorrect);
    session.answered = true;
    session.done++;
    if (isCorrect) session.correct++;

    // 记录（同一词多轮取最后一次）
    session.results.set(word.id, r);

    // 答错 → 本次稍后重来一遍，趁热打铁。
    // 答对则本轮不再出现：它的冷却（20 分钟）还没过，当天再刷要走下一轮。
    if (!isCorrect) {
      const insertAt = Math.min(session.queue.length, session.index + 3);
      session.queue.splice(insertAt, 0, word.id);
      session.requeued++;
      session.total = session.queue.length;
    }

    renderFeedback(session.current, isCorrect, userAnswer, r);
    // 把焦点交给「继续」，这样键盘作答后直接按 Enter / 空格就能推进
    const nextBtn = $('#btn-next');
    if (nextBtn && !nextBtn.hidden) nextBtn.focus({ preventScroll: true });
    updateProgress();
  }

  function endSession() {
    const stats = session ? {
      done: session.done,
      correct: session.correct,
      results: session.results
    } : null;
    session = null;

    if (!stats || stats.done === 0) {
      showPanel('intro');
      refreshIntro();
      return;
    }

    // 记录学习天数
    const today = new Date().toISOString().slice(0, 10);
    if (store.stats.lastDate !== today) {
      const y = new Date(Date.now() - DAY).toISOString().slice(0, 10);
      store.stats.streakDays = store.stats.lastDate === y ? (store.stats.streakDays || 0) + 1 : 1;
      store.stats.lastDate = today;
    }
    store.stats.sessions++;
    saveStore();

    renderSummary(stats);
    showPanel('summary');

    // 练完就推一次，别的设备打开就能拿到这次的进度
    if (sync && sync.enabled && sync.token) syncNow({ silent: true });
  }

  /* ---------- 渲染：训练视图 ---------- */
  function showPanel(which) {
    $('#session-intro').hidden = which !== 'intro';
    $('#session-quiz').hidden = which !== 'quiz';
    $('#session-summary').hidden = which !== 'summary';
  }

  function refreshIntro() {
    const t = now();
    let due = 0, fresh = 0, mastered = 0, recognize = 0, write = 0;
    for (const w of WORDS) {
      const p = progressOf(w.id);
      if (p.stage === 'new') fresh++;
      else {
        if (p.due <= t) due++;
        if (p.stage === 'mastered') mastered++;
        else if (p.stage === 'write') write++;
        else recognize++;
      }
    }
    $('#stat-due').textContent = due;
    $('#stat-new').textContent = Math.min(fresh, Number(store.settings.newLimit) || 0);
    $('#stat-mastered').textContent = mastered;

    const totalToday = due + Math.min(fresh, Number(store.settings.newLimit) || 0);
    const cooling = WORDS.some((w) => inCooling(progressOf(w.id), t));
    $('#intro-hint').textContent = totalToday
      ? `本轮约 ${totalToday} 个词 · 认词 ${recognize} · 拼写 ${write} · 已掌握 ${mastered}`
      : (!WORDS.length ? '词库还是空的。'
        : cooling ? '今天的词都记上了，正在冷却 —— 也可以直接再练一遍（同一天只记 1 天）。'
        : '暂时没有到期的词。');
    $('#intro-rule').textContent =
      `升阶规则：一个月内累计有 ${creditNeed()} 天答对（当天可反复刷，只记 1 天）· `
      + `答错则已攒天数全部清零 · 已掌握后每 ${Math.round(MASTERED_DUE / DAY)} 天回访一次`;
    // 冷却中的词也能重练，所以这种情况下不能让「开始训练」变成灰的
    $('#btn-start').disabled = totalToday === 0 && !cooling;
  }

  /* ---------- 四六级候选词确认卡 ----------
   * 补词脚本只负责「挑出来」（写进 data/cet-pending.json），
   * 加不加、加哪几个，必须在这里由你点头。决定记进 store.cet 并随进度同步，
   * 补词脚本读到后再真正写入词库 —— 所以决定在所有设备之间是共享的。
   */
  async function refreshCetReview() {
    const box = $('#cet-review');
    if (!box) return;
    let pending = [];
    try {
      // 时间戳绕开 SW 的 stale-while-revalidate，保证候选词列表是新的
      const res = await fetch(`data/cet-pending.json?t=${now()}`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        pending = Array.isArray(data.words) ? data.words : [];
      }
    } catch { /* 离线 / 还没有候选词文件：不出卡片 */ }

    const decided = new Set([...(store.cet?.approved || []), ...(store.cet?.rejected || [])]);
    const known = new Set(WORDS.map((w) => w.id));
    pending = pending.filter((w) => w && w.id && w.word && !decided.has(w.id) && !known.has(w.id));
    if (!pending.length) { box.hidden = true; box.innerHTML = ''; return; }

    box.hidden = false;
    box.innerHTML = `
      <h2 class="cet-review__title">四六级候选词 · 要加入词库吗？</h2>
      <p class="cet-review__sub">补词脚本按真题覆盖挑出来的新词，勾上想要的、去掉不想要的；确认后由脚本自动入库（不用等这一页刷新）。</p>
      <ul class="cet-review__list">
        ${pending.map((w) => `
          <li class="cet-review__item">
            <input type="checkbox" checked data-cet-id="${esc(w.id)}" id="cet-${esc(w.id)}">
            <label for="cet-${esc(w.id)}"><span class="cet-review__word">${esc(w.word)}</span>
              <span class="cet-review__pos">${esc(w.pos || '')}</span></label>
            <span class="cet-review__meaning">${esc(w.meaning)}</span>
            <span class="cet-review__tag">${esc((w.tags && w.tags[0]) || 'CET')}</span>
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
        ? `已选 ${approvedIds.length} 个，稍后自动加入词库`
        : '这批候选词已跳过，之后会换新的来');
      // 决定要尽快让补词脚本看到：开着同步就立刻推一次
      if (sync.enabled && sync.token && sync.owner && sync.repo) syncNow({ silent: true });
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
    // 用「当前第几题」而不是「已答几题」，否则答题后的反馈阶段会比实际题号多 1
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
    badge.textContent = STAGE_BADGE[stage] || '认词';
    badge.dataset.stage = stage;

    $('#feedback').innerHTML = '';
    $('#btn-next').hidden = true;

    const body = $('#quiz-body');
    if (q.kind === 'recognize') {
      body.innerHTML = `
        <div class="prompt">
          <p class="prompt__label">选出正确的中文释义</p>
          <p class="prompt__word">${esc(q.word.word)}</p>
        </div>
        <div class="options" role="group" aria-label="释义选项">
          ${q.options.map((o, i) => `
            <button class="option" type="button" data-index="${i}">
              <span class="option__key" aria-hidden="true">${i + 1}</span>
              <span>${esc(o.text)}</span>
              <span class="option__mark" aria-hidden="true"></span>
            </button>`).join('')}
        </div>`;
      $$('.option', body).forEach((btn) => {
        btn.addEventListener('click', () => onPickOption(q, Number(btn.dataset.index)));
      });
    } else {
      const isFill = q.kind === 'fill';
      body.innerHTML = `
        <div class="prompt">
          <p class="prompt__label">${isFill ? '把这个词填回例句' : '根据中文写出英文单词'}</p>
          ${isFill
            ? `<p class="prompt__blank">${blankExample(q.word.example, q.word.word)}</p>
               <p class="prompt__blank" style="margin-top:8px;background:none;padding:0">${esc(q.word.exampleZh)}</p>`
            : `<p class="prompt__zh">${esc(q.word.meaning)}</p>`}
        </div>
        <form class="spell" id="spell-form" novalidate>
          <div class="spell__row">
            <label class="sr-only" for="spell-input">输入英文单词</label>
            <input class="spell__input" id="spell-input" type="text"
                   autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
                   placeholder="输入英文…">
            <button class="btn btn--primary" type="submit">提交</button>
          </div>
          <p class="spell__letters">${esc(q.hint)} <span aria-hidden="true">·</span> ${q.word.word.replace(/[^a-z]/gi, '').length} 个字母</p>
        </form>`;
      const form = $('#spell-form');
      const input = $('#spell-input');
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

    if (store.settings.speak && q.kind !== 'fill') speak(q.word.word);
    updateProgress();
  }

  const normalize = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');

  function onPickOption(q, index) {
    if (session.answered) return;
    const chosen = q.options[index];
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

    // 攒天数进度：让「一个月内攒够多少天」这件事在每次作答后都看得见
    const need = r.need || creditNeed();
    const have = (r.after.credits || []).length;
    const cool = Math.round(CREDIT_DUE / MIN);
    let creditNote;
    if (!isCorrect) {
      creditNote = r.cleared
        ? `<p class="fb__credit fb__credit--bad">答错 → 已攒的 ${r.cleared} 天全部清零，重新计数一个月</p>`
        : `<p class="fb__credit fb__credit--bad">答错 → 这一关重新计数一个月</p>`;
    } else if (r.before.stage === 'new') {
      creditNote = `<p class="fb__credit">进入「认词中」，接下来要在一个月内攒够 ${need} 天答对</p>`;
    } else if (r.promoted) {
      creditNote = r.after.stage === 'mastered'
        ? `<p class="fb__credit">一个月内攒满 ${need} 天 → 已掌握 ✓</p>`
        : `<p class="fb__credit">一个月内攒满 ${need} 天 → 升入「${STAGE_BADGE[r.after.stage]}」关，重新开始攒</p>`;
    } else if (r.after.stage === 'mastered') {
      creditNote = `<p class="fb__credit">已掌握 · 之后每 ${Math.round(MASTERED_DUE / DAY)} 天回访一次</p>`;
    } else if (have === (r.before.credits || []).length) {
      // 今天已经记过了，这次只是加刷一遍
      creditNote = `<p class="fb__credit">今天已经记过了 · 已攒 <b>${have}</b> / ${need} 天 · ${cool} 分钟后可再刷</p>`;
    } else {
      creditNote = `<p class="fb__credit">已攒 <b>${have}</b> / ${need} 天（一个月内）· ${cool} 分钟后可再刷</p>`;
    }

    const userLine = (!isCorrect && q.kind !== 'recognize' && userAnswer)
      ? `<p class="fb__meaning" style="color:var(--color-danger)">你写的是：<s>${esc(userAnswer)}</s></p>` : '';

    $('#feedback').innerHTML = `
      <div class="fb ${isCorrect ? 'fb--ok' : 'fb--no'}">
        <p class="fb__head">
          ${isCorrect ? iconCheck() : iconCross()}
          ${isCorrect ? (q.kind === 'recognize' ? '认对了' : '拼对了') : (q.kind === 'recognize' ? '认错了' : '拼错了')}
        </p>
        <p class="fb__word">${esc(w.word)} <span class="prompt__pos">${esc(w.pos || '')}</span></p>
        <p class="fb__meaning">${esc(w.meaning)}</p>
        ${userLine}
        <div class="fb__ex">
          <p class="fb__ex-en">${highlight(w.example, w.word)}</p>
          <p class="fb__ex-zh">${esc(w.exampleZh || '')}</p>
        </div>
        ${stageNote}
        ${creditNote}
      </div>`;

    const next = $('#btn-next');
    next.hidden = false;
    next.textContent = session.done >= session.total ? '看小结' : '继续';
    next.focus({ preventScroll: true });
  }

  function renderSummary(stats) {
    const rate = stats.done ? Math.round((stats.correct / stats.done) * 100) : 0;
    $('#summary-title').textContent = rate >= 90 ? '干净利落' : rate >= 70 ? '稳步推进' : '有难点，正常';

    // 把结果分成四类，避免把「新词刚起步」说成「攒到了新的一天」
    const started = [], advanced = [], gained = [], lost = [];
    stats.results.forEach((r, id) => {
      const before = (r.before.credits || []).length;
      const after = (r.after.credits || []).length;
      if (r.promoted && r.before.stage === 'new') started.push(id);
      else if (r.promoted) advanced.push(id);
      else if (after > before) gained.push(id);
      if (!r.promoted && after < before) lost.push(id);
    });

    $('#summary-stats').innerHTML = `
      <div class="stat"><span class="stat__num">${stats.done}</span><span class="stat__label">答题</span></div>
      <div class="stat"><span class="stat__num">${rate}%</span><span class="stat__label">正确率</span></div>
      <div class="stat"><span class="stat__num">${gained.length}</span><span class="stat__label">攒到天数</span></div>`;

    const rows = [];
    if (started.length) rows.push(`<div class="summary__row"><b>${started.length} 个</b> 词进入「认词中」，开始攒天数</div>`);
    if (gained.length) rows.push(`<div class="summary__row"><b>${gained.length} 个</b> 词攒到了新的一天 <span class="tag tag--up">↑</span></div>`);
    if (lost.length) rows.push(`<div class="summary__row"><b>${lost.length} 个</b> 词答错清零，得重新攒 <span class="tag tag--down">↓</span></div>`);
    if (advanced.length) {
      rows.push(`<div class="summary__row">升阶：<b>${advanced.map((id) => esc(byId.get(id)?.word || id)).join('、')}</b> <span class="tag tag--up">晋级</span></div>`);
    }
    $('#summary-list').innerHTML = rows.join('') || '<div class="summary__row">这轮没有需要特别标记的词。</div>';
  }

  /* ---------- 词库视图 ---------- */
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
      if (libFilter !== 'all' && p.stage !== libFilter) return false;
      if (!q) return true;
      return w.word.toLowerCase().includes(q) || w.meaning.toLowerCase().includes(q);
    });

    const ul = $('#wordlist');
    ul.innerHTML = list.map((w) => {
      const p = progressOf(w.id);
      const need = creditNeed();
      const have = (p.credits || []).length;
      // 已掌握的词不再需要攒，直接把格子填满表示「已达成」
      const pips = Array.from({ length: need }, (_, i) =>
        `<i class="strength__pip ${(p.stage === 'mastered' || i < have) ? 'is-on' : ''}" data-stage="${p.stage}"></i>`).join('');
      const creditText = p.stage === 'new' ? '未开始'
        : p.stage === 'mastered' ? '已掌握'
        : `已攒 ${have}/${need} 天`;
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
          <p class="wcard__ex">${esc(w.example)}</p>
          <div class="wcard__foot">
            <span class="strength" role="img" aria-label="${creditText}">${pips}</span>
            <span class="wcard__meta">${creditText} · 对 ${p.correct} · 错 ${p.wrong} · ${dueText}</span>
          </div>
        </li>`;
    }).join('');

    $('#wordlist-empty').hidden = list.length > 0;
  }

  function formatDue(ts) {
    const diff = ts - now();
    if (diff < 60 * MIN) return `${Math.max(1, Math.round(diff / MIN))} 分钟后`;
    if (diff < DAY) return `${Math.round(diff / (60 * MIN))} 小时后`;
    return `${Math.round(diff / DAY)} 天后`;
  }

  /* ---------- 设置 ---------- */
  function bindSettings() {
    const nl = $('#set-newlimit');
    const nlo = $('#set-newlimit-out');
    nl.value = store.settings.newLimit;
    nlo.textContent = nl.value;
    nl.addEventListener('input', () => {
      nlo.textContent = nl.value;
      store.settings.newLimit = Number(nl.value);
      store.settingsAt = now();
      saveStore();
      refreshIntro();
    });

    const th = $('#set-threshold');
    const tho = $('#set-threshold-out');
    th.value = store.settings.threshold;
    tho.textContent = th.value;
    $('#set-threshold-text').textContent = th.value;
    th.addEventListener('input', () => {
      tho.textContent = th.value;
      $('#set-threshold-text').textContent = th.value;
      store.settings.threshold = Number(th.value);
      store.settingsAt = now();
      saveStore();
    });

    const sp = $('#set-speak');
    sp.checked = !!store.settings.speak;
    sp.addEventListener('change', () => {
      store.settings.speak = sp.checked;
      saveStore();
    });

    $('#btn-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `worddrill-progress-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已导出进度文件');
    });

    $('#import-file').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data || typeof data !== 'object' || !data.words) throw new Error('bad');
        store = Object.assign(defaultStore(), data, {
          settings: Object.assign(defaultStore().settings, data.settings || {}),
          stats: Object.assign(defaultStore().stats, data.stats || {})
        });
        // 导入的也可能是旧版导出的文件，同样按版本升级语义
        migrateStore(store, data.version);
        normalizeSettings(store.settings);
        saveStore();
        applySettingsToUI();
        refreshIntro();
        renderLibrary();
        toast('进度已导入');
      } catch {
        toast('导入失败：文件格式不对');
      } finally {
        e.target.value = '';
      }
    });

    $('#btn-reset').addEventListener('click', () => {
      if (!confirm('确认清空全部学习进度？词库本身不受影响，此操作不可撤销。')) return;
      store = defaultStore();
      saveStore();
      applySettingsToUI();
      refreshIntro();
      renderLibrary();
      toast('进度已清空');
    });

    $('#meta-count').textContent = WORDS.length;
    $('#meta-updated').textContent = META.updated || '—';
  }

  /* ---------- 同步面板 ---------- */
  function applySyncToUI() {
    $('#sync-owner').value = sync.owner || '';
    $('#sync-repo').value = sync.repo || '';
    $('#sync-path').value = sync.path || 'progress.json';
    $('#sync-token').value = sync.token || '';
    $('#sync-enabled').checked = !!sync.enabled;
    $('#sync-device').textContent = sync.deviceId;
    setSyncStatus(describeSync(), /失败/.test(sync.lastResult || ''));
    $('#btn-sync-now').disabled = !sync.enabled;
  }

  function bindSync() {
    const readForm = () => {
      normalizeRepoFields();
      sync.owner = $('#sync-owner').value.trim();
      sync.repo = $('#sync-repo').value.trim();
      sync.path = $('#sync-path').value.trim() || 'progress.json';
      sync.token = $('#sync-token').value.trim();
    };

    ['#sync-owner', '#sync-repo', '#sync-path'].forEach((sel) => {
      $(sel).addEventListener('change', () => { readForm(); saveSync(); });
    });
    $('#sync-token').addEventListener('change', () => { readForm(); saveSync(); });

    $('#sync-enabled').addEventListener('change', (e) => {
      readForm();
      sync.enabled = e.target.checked;
      saveSync();
      applySyncToUI();
      if (sync.enabled) {
        if (!sync.owner || !sync.repo || !sync.token) {
          toast('还差仓库名或 token');
        } else {
          syncNow({ silent: false });
        }
      } else {
        toast('已关闭同步（token 仍留在本机，可点「清除凭据」删掉）');
      }
    });

    $('#btn-toggle-token').addEventListener('click', () => {
      const el = $('#sync-token');
      el.type = el.type === 'password' ? 'text' : 'password';
      $('#btn-toggle-token').textContent = el.type === 'password' ? '显示' : '隐藏';
    });

    $('#btn-sync-now').addEventListener('click', () => { readForm(); saveSync(); syncNow({ silent: false }); });

    // 分层探测，避免用户对着一个 404 猜原因
    $('#btn-sync-test').addEventListener('click', async () => {
      readForm();
      saveSync();
      const btn = $('#btn-sync-test');
      btn.disabled = true;
      setSyncStatus('测试中…');
      try {
        const r = await diagnoseSync();
        setSyncStatus(r.text, r.mode);
        toast(r.mode === 'ok' ? '连接正常' : '连接测试没过，看设置面板下方的提示');
      } catch (e) {
        setSyncStatus('测试出错：' + ((e && e.message) || '未知错误'), 'error');
      } finally {
        btn.disabled = false;
      }
    });

    $('#btn-sync-forget').addEventListener('click', () => {
      if (!confirm('清除本机保存的仓库地址和 token？\n（只影响这台设备；远端进度文件不删，学习进度也不动）')) return;
      const keepId = sync.deviceId;
      sync = Object.assign(defaultSync(), { deviceId: keepId });
      saveSync();
      applySyncToUI();
      toast('已清除同步凭据');
    });
  }

  function applySettingsToUI() {
    $('#set-newlimit').value = store.settings.newLimit;
    $('#set-newlimit-out').textContent = store.settings.newLimit;
    $('#set-threshold').value = store.settings.threshold;
    $('#set-threshold-out').textContent = store.settings.threshold;
    $('#set-threshold-text').textContent = store.settings.threshold;
    $('#set-speak').checked = !!store.settings.speak;
  }

  /* ---------- 主题 ----------
   * 只有「跟随系统」一种模式：深浅色完全由 CSS 的
   * @media (prefers-color-scheme: dark) 决定，JS 不参与，也就没有切换按钮。
   */

  /* ---------- 发音 ---------- */
  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch { /* 静默失败：不影响答题 */ }
  }

  /* ---------- 视图切换 ---------- */
  function switchView(name) {
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
    if (name === 'learn') refreshIntro();
    location.hash = name === 'learn' ? '' : `#${name}`;
    $('#main').scrollIntoView({ block: 'start', behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    $$('.nav__item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
    $$('[data-view]').forEach((b) => {
      if (!b.classList.contains('nav__item')) b.addEventListener('click', () => switchView(b.dataset.view));
    });

    $('#btn-start').addEventListener('click', startSession);
    // 「再来一轮」也走同一逻辑：没有到期的词就把今天练过的再带上
    $('#btn-again').addEventListener('click', () => { showPanel('intro'); refreshIntro(); startSession(); });
    $('#btn-end').addEventListener('click', endSession);
    $('#btn-next').addEventListener('click', () => {
      if (session && session.done >= session.total) endSession();
      else nextQuestion();
    });

    $$('.segmented__item').forEach((b) => {
      b.addEventListener('click', () => {
        libFilter = b.dataset.filter;
        $$('.segmented__item').forEach((x) => x.classList.toggle('is-active', x === b));
        renderLibrary();
      });
    });

    $('#lib-search').addEventListener('input', (e) => {
      libQuery = e.target.value;
      renderLibrary();
    });

    // 键盘：选择题 1-4 直接作答；Enter 进入下一题
    document.addEventListener('keydown', (e) => {
      if ($('#view-learn').hidden) return;
      const quizVisible = !$('#session-quiz').hidden;
      if (!quizVisible || !session) return;
      const tag = document.activeElement?.tagName;
      const typing = tag === 'INPUT';

      if (!session.answered && /^[1-4]$/.test(e.key) && !typing) {
        const btn = $$('.option')[Number(e.key) - 1];
        if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
      }
      if (e.key === 'Enter' && session.answered) {
        // 焦点若落在别处「可用」按钮上，交给浏览器原生激活（比如「结束本次」）；
        // 焦点在「继续」或已禁用的选项按钮上时，由这里统一推进，保证 Enter 始终管用。
        const el = document.activeElement;
        if (el && el.tagName === 'BUTTON' && !el.disabled && el.id !== 'btn-next') return;
        e.preventDefault();
        $('#btn-next').click();
      }
    });
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    store = loadStore();
    if (storeMigrated) saveStore();   // 迁移结果立刻落盘：同浏览器的旧标签页不该再读到旧语义的 threshold
    sync = loadSync();

    try {
      const res = await fetch('data/words.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      WORDS = Array.isArray(data.words) ? data.words : [];
      META = data.meta || {};
    } catch (err) {
      WORDS = [];
      document.querySelector('#session-intro').innerHTML = `
        <p class="eyebrow">无法载入词库</p>
        <h2 class="intro__title">读不到 data/words.json</h2>
        <p class="intro__sub">如果这是直接双击打开的本地文件，浏览器会因为安全策略拦下读取请求。
        请用本地服务器打开，例如在项目目录运行：</p>
        <p class="prompt__blank" style="margin-top:16px"><b>python3 -m http.server 8000</b><br>然后访问 http://localhost:8000</p>`;
      return;
    }

    WORDS.forEach((w) => byId.set(w.id, w));
    if (!WORDS.length) {
      $('#session-intro').innerHTML = '<p class="eyebrow">词库是空的</p><h2 class="intro__title">还没有单词</h2><p class="intro__sub">把生词写进 data/words.json 就能开始。</p>';
      return;
    }

    bindEvents();
    bindSettings();
    bindSync();
    applySyncToUI();
    refreshIntro();
    showPanel('intro');

    const hash = location.hash.replace('#', '');
    if (['library', 'settings'].includes(hash)) switchView(hash);

    // 打开就同步一次：把另一台设备上练的进度合并进来（不阻塞首屏，失败也不打扰）
    if (sync.enabled && sync.token && sync.owner && sync.repo) syncNow({ silent: true });

    // 四六级候选词确认卡（async，不阻塞首屏；同步合并后 syncNow 里会再刷一次）
    refreshCetReview();

    // 标记今日待复习数量，方便一眼看到
    if (WORDS.some((w) => { const p = progressOf(w.id); return p.stage !== 'new' && p.due <= now(); })) {
      // 不打扰，只更新数字
      refreshIntro();
    }
  }

  // 注册 service worker（离线可用；file:// 或旧浏览器下静默跳过）
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 忽略：不影响主流程 */ });
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
