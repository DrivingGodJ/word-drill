/* ============================================================
   WordDrill — app
   两阶段记忆模型：认（Recognition）→ 写（Production）
   调度：FSRS-6；认词与拼写分别积累，升关后开始新的记忆卡
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

  // 答对天数保留，不再过期或因一次答错清零。升阶还要求 FSRS 的稳定性达标。
  const PROMOTION_STABILITY = { recognize: 7, write: 21 };
  const CREDIT_NEED_MIN = 2, CREDIT_NEED_MAX = 10, CREDIT_NEED_DEFAULT = 3;
  const REQUESTS_PER_ROUND = 40;   // 单轮最大题量，避免无限循环

  /* ---------- 多设备同步（GitHub 私有仓库当存储） ---------- */
  const SYNC_KEY = 'worddrill.sync.v1';
  const SYNC_API = 'https://api.github.com';
  /** 学习参数才同步；主题/发音是设备偏好，各设备自己存 */
  const SYNCED_SETTINGS = ['newLimit', 'threshold', 'retention'];
  /** 学习参数的合法区间，必须和设置页滑块的 min/max 一致，否则同步进来的值会让界面与实际不一致 */
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
    return s;
  }

  /* ---------- 状态 ---------- */
  let WORDS = [];          // 词库
  let META = {};
  let DISTRACTORS = [];    // 词库外的干扰释义池（data/distractors.json，只为凑选项用，不进训练队列）
  const byId = new Map();
  let store = null;        // 持久化状态
  let storeMigrated = false;  // 本次启动是否把旧存档升级过（升级结果要立刻写回，免得旧标签页又读到老值）
  let sync = null;         // 多设备同步配置（token 只在本机）
  let syncing = false;
  let session = null;      // 当前会话
  let libFilter = 'all';
  let libQuery = '';
  let summaryMistakes = [];

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
  const STORE_VERSION = 5;   // v5 FSRS + 累计跨天证据；保留所有词条与统计
  const BACKUP_KEY = 'worddrill.backup.before-v5';

  function defaultStore() {
    return {
      version: STORE_VERSION,
      settings: { newLimit: 10, threshold: CREDIT_NEED_DEFAULT, retention: 90, speak: true },
      settingsAt: 0,                   // 学习参数最后修改时间，用于多设备合并
      cet: { approved: [], rejected: [] },   // 四六级候选词的取舍决定，随进度一起同步
      words: {},                       // id → 进度
      stats: { answers: 0, correct: 0, sessions: 0, lastDate: null, streakDays: 0 }
    };
  }

  /** 只改新的学习参数；词条的阶段、天数、次数、到期时间和统计原样保留。 */
  function migrateStore(s, fromVersion) {
    if ((fromVersion || 1) >= STORE_VERSION) return false;
    s.version = STORE_VERSION;
    s.settings.threshold = CREDIT_NEED_DEFAULT;
    s.settings.retention = 90;
    s.settingsAt = now();
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
        if (!p || typeof p !== 'object' || !STAGES.includes(p.stage || 'new')) {
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

  function keepBackup(raw) {
    if (raw && !localStorage.getItem(BACKUP_KEY)) localStorage.setItem(BACKUP_KEY, raw);
  }

  function loadStore() {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultStore();
    const parsed = JSON.parse(raw);
    const merged = readStore(parsed);
    if ((parsed.version || 1) < STORE_VERSION) {
      // 备份失败时抛出并停止启动，不能覆盖唯一一份旧进度。
      keepBackup(raw);
      storeMigrated = migrateStore(merged, parsed.version);
    }
    return merged;
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
      correct: 0, wrong: 0, due: 0, lastSeen: 0, introducedAt: 0
    };
  }

  /* ---------- SRS 引擎 ---------- */
  /** 本地日期键（YYYY-MM-DD），用来判断两次答对是不是同一天。 */
  const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  /** 当前设置要求的最少独立答对天数。 */
  const creditNeed = () =>
    Math.min(CREDIT_NEED_MAX, Math.max(CREDIT_NEED_MIN, Number(store.settings.threshold) || CREDIT_NEED_DEFAULT));

  /** 是否还需要攒天数（已掌握的词不再需要）。 */
  const needsCredits = (stage) => stage === 'recognize' || stage === 'write';

  function scheduler() {
    return FSRS.fsrs({ request_retention: store.settings.retention / 100,
      enable_fuzz: false, enable_short_term: true, learning_steps: ['1m', '10m'], relearning_steps: ['10m'] });
  }

  function schedule(p, rating, at) {
    // 旧存档没有完整作答历史：从第一次新作答建立记忆卡，不伪造历史评分。
    const card = p.memory || FSRS.createEmptyCard(new Date(at));
    const result = scheduler().next(card, new Date(at), rating).card;
    return { ...result, due: +result.due, last_review: +result.last_review };
  }

  function newAllowance(t = now()) {
    const started = Object.values(store.words).filter((p) => p.introducedAt && dayKey(p.introducedAt) === dayKey(t)).length;
    return Math.max(0, store.settings.newLimit - started);
  }

  /**
   * 判定一次作答并推进状态。
   * @returns {{before:object, after:object, promoted:boolean, demoted:boolean, credited:boolean}}
   */
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
      // 提示后答对不等于独立回忆成功，按 Again 重学，避免虚增间隔。
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
          after.stage = after.stage === 'recognize' ? 'write' : 'mastered';
          after.credits = [];
          promoted = true;
          if (after.stage === 'write') {
            // 认得不代表会拼：拼写关建立自己的记忆卡。
            after.memory = undefined;
            after.due = at + 10 * MIN;
          }
        }
      }
    } else if (!isCorrect && !practice) {
      // 只撤销今天的证据，之前跨天答对的积累保留。
      after.credits = after.credits.filter((ts) => dayKey(ts) !== dayKey(at));
      if (after.stage === 'mastered') { after.stage = 'write'; demoted = true; }
    }

    store.words[id] = after;
    saveStore();
    return { before, after, promoted, demoted, credited, aided, practice, need };
  }

  /** 根据当前阶段决定出题方式。 */
  function quizTypeFor(stage) {
    if (stage === 'write' || stage === 'mastered') return 'spell';
    return 'recognize';
  }

  /** 词性归一：'n./v.' → 'n.'，用来把干扰释义和词按词性配对。 */
  function posKey(pos) {
    return String(pos || '').split('/')[0].trim();
  }

  /* ---------- 出题 ---------- */
  /**
   * 四选一。
   * 干扰项特意掺进库外的释义（data/distractors.json）：词库里只有二十来个词时，
   * 全靠库内互当干扰项，靠排除法就能蒙对，起不到认词作用。
   * 词性相同的优先配对；库外 1–2 个，其余由库内补，两边都不够时互相兜底。
   */
  function buildRecognizeQuestion(word) {
    const key = posKey(word.pos);
    const others = WORDS.filter((w) => w.id !== word.id);
    const inSame = shuffle(others.filter((w) => posKey(w.pos) === key)).map((w) => w.meaning);
    const inRest = shuffle(others.filter((w) => posKey(w.pos) !== key)).map((w) => w.meaning);
    const outSame = shuffle(DISTRACTORS.filter((d) => posKey(d.pos) === key)).map((d) => d.meaning);
    const outRest = shuffle(DISTRACTORS.filter((d) => posKey(d.pos) !== key)).map((d) => d.meaning);

    const outAll = outSame.concat(outRest);
    const inAll = inSame.concat(inRest);
    const wantOutside = outAll.length ? 1 + Math.floor(Math.random() * 2) : 0;   // 每题 1~2 个库外

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
    add(outAll, wantOutside);   // 先放库外的
    add(inAll, 3);              // 再用库内的补满
    add(outAll, 3);             // 库内不够时，库外继续补

    const options = shuffle([
      { text: word.meaning, correct: true },
      ...distractors.map((text) => ({ text, correct: false }))
    ]);
    return { kind: 'recognize', word, options };
  }

  function buildSpellQuestion(word) {
    return { kind: 'spell', word, hint: letterHint(word.word) };
  }

  function buildFillQuestion(word) {
    return { kind: 'fill', word, hint: letterHint(word.word) };
  }

  const fillPattern = (word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  const hasFillExample = (word) => !!word.example && fillPattern(word.word).test(word.example);

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
    const re = fillPattern(esc(target));
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
    let data;
    try { data = JSON.parse(b64Decode(j.content)); }
    catch { throw new Error('远端进度无法解析，已暂停同步并保留原文件'); }
    readStore(data);  // 验证成功后才能合并或覆盖；损坏的远端不能当作空进度。
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
    memory: normalMemory(r.memory)
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
    if (Number(remote.version) > STORE_VERSION) throw new Error('远端进度来自更新版本，请刷新本站后同步');
    readStore(remote);
    let changed = false;

    const rw = (remote.words && typeof remote.words === 'object') ? remote.words : {};
    for (const id of new Set([...Object.keys(rw), ...Object.keys(store.words)])) {
      const mine = store.words[id];
      const theirs = rw[id];
      if (!theirs) continue;
      if (!mine) { store.words[id] = Object.assign(normalRec(theirs), { lastSeen: theirs.lastSeen || 0 }); changed = true; continue; }

      const newer = (theirs.lastSeen || 0) > (mine.lastSeen || 0) ? theirs : mine;
      const merged = normalRec(newer);
      merged.introducedAt = Math.min(mine.introducedAt || Infinity, theirs.introducedAt || Infinity);
      if (!Number.isFinite(merged.introducedAt)) merged.introducedAt = 0;
      merged.correct = Math.max(mine.correct || 0, theirs.correct || 0);
      merged.wrong = Math.max(mine.wrong || 0, theirs.wrong || 0);
      if (JSON.stringify(merged) !== JSON.stringify(normalRec(mine))) {
        store.words[id] = merged;
        changed = true;
      }
    }

    // 学习参数只在「两边语义版本一致」时互相同步。
    // 旧版本客户端（payload 里 version 落后）存的 threshold 是另一套含义的数字，
    // 不能让旧版「一个月内 15 天」的门槛覆盖新升阶规则。
    const remoteModel = Number(remote.version) || 1;
    const settingsOk = remoteModel >= STORE_VERSION;
    if (settingsOk && (remote.settingsAt || 0) > (store.settingsAt || 0) && remote.settings) {
      for (const k of SYNCED_SETTINGS) {
        const v = clampSetting(k, remote.settings[k]);
        if (v !== undefined && store.settings[k] !== v) { store.settings[k] = v; changed = true; }
      }
      store.settingsAt = remote.settingsAt || 0;
      changed = true;
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
        if (remote?.data && Number(remote.data.version || 1) < STORE_VERSION) {
          keepBackup(JSON.stringify(remote.data));
        }
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
  /** 到期复习优先；加练与错词练习不改变复习时间或升阶证据。 */
  function startSession(mode = 'learn', ids = null) {
    const t = now();
    const practice = mode === 'practice' || mode === 'mistakes';
    let selected;
    if (practice) {
      selected = shuffle(WORDS.filter((w) => mode === 'mistakes'
        ? progressOf(w.id).wrong > 0 && (!ids || ids.includes(w.id)) : progressOf(w.id).stage !== 'new'));
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
      toast(mode === 'mistakes' ? '还没有错词记录' : '本轮没有可练的词，可以稍后复习或自由加练');
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
      startedAt: t,
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
      q = (stage === 'mastered' && hasFillExample(word) && Math.random() < 0.45)
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
    const r = grade(word.id, isCorrect, !!session.current.aided, session.practice);
    session.answered = true;
    session.done++;
    if (isCorrect) session.correct++;

    // 保留首次状态与整轮错词；之后答对不能掩盖本轮曾经答错。
    const previous = session.results.get(word.id);
    if (previous) {
      r.before = previous.before;
      r.promoted = previous.promoted || r.promoted;
      r.demoted = previous.demoted || r.demoted;
    }
    session.results.set(word.id, r);

    // 答错 → 本次稍后重来一遍，趁热打铁。
    // 即时回练不记新的跨天证据。
    if (!isCorrect) {
      session.missed.add(word.id);
      const insertAt = Math.min(session.queue.length, session.index + 3);
      session.queue.splice(insertAt, 0, word.id);
      session.requeued++;
      session.total = Math.min(session.queue.length, REQUESTS_PER_ROUND);
    }

    renderFeedback(session.current, isCorrect, userAnswer, r);
    // 把焦点交给「继续」，这样键盘作答后直接按 Enter / 空格就能推进
    const nextBtn = $('#btn-next');
    if (nextBtn && !nextBtn.hidden && !nextBtn.disabled) nextBtn.focus({ preventScroll: true });
    updateProgress();
  }

  function endSession() {
    const stats = session ? {
      done: session.done,
      correct: session.correct,
      results: session.results,
      missed: session.missed,
      elapsed: now() - session.startedAt,
      practice: session.practice
    } : null;
    session = null;

    if (!stats || stats.done === 0) {
      showPanel('intro');
      refreshIntro();
      return;
    }

    // 记录学习天数
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
      if (p.stage === 'new' && !p.introducedAt) fresh++;
      else {
        if (p.due <= t) due++;
        if (p.stage === 'mastered') mastered++;
        else if (p.stage === 'write') write++;
        else recognize++;
      }
    }
    $('#stat-due').textContent = due;
    const remaining = Math.min(fresh, newAllowance(t));
    $('#stat-new').textContent = remaining;
    $('#stat-mastered').textContent = mastered;

    const totalToday = due + remaining;
    $('#intro-hint').textContent = totalToday
      ? `本轮最多 ${Math.min(totalToday, REQUESTS_PER_ROUND)} 个词 · 待复习 ${due} · 今日可加新词 ${remaining}`
      : (!WORDS.length ? '词库还是空的。'
        : '暂时没有到期的词；自由加练不会提前推迟下次复习。');
    $('#intro-rule').textContent =
      `升阶：至少 ${creditNeed()} 个不同日子独立答对，并达到认词 7 天 / 拼写 21 天的记忆稳定性。答错保留之前的积累。`;
    $('#btn-start').disabled = totalToday === 0;
    $('#btn-review').disabled = due === 0;
    $('#btn-practice').disabled = !WORDS.some((w) => progressOf(w.id).stage !== 'new');
    $('#btn-mistakes').disabled = !WORDS.some((w) => progressOf(w.id).wrong > 0);
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
      <p class="cet-review__sub">优先选词书有真题记录、带完整例句的难词。勾选想学的词；取消勾选的词以后不再推荐。补词量按学习节奏和复习积压调整，7 个是参考量；暂时加不了的词会保留，等下一次补词任务处理。</p>
      ${!(sync.enabled && sync.token && sync.owner && sync.repo) ? '<p class="cet-review__sub">开启设置里的 GitHub 同步后，补词任务才能收到你的选择。</p>' : ''}
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
              <p>${esc(w.exampleSource || '词书例句')}。例句与真题收录记录分别展示。</p>
              ${Array.isArray(w.selection?.examSources) && w.selection.examSources.length
                ? `<p>词书记录的真题来源（${w.selection.examSources.length} 条）：${w.selection.examSources.map(esc).join('；')}</p><p><a href="https://github.com/kajweb/dict" target="_blank" rel="noopener noreferrer">查看词书来源</a></p>`
                : '<p>旧候选的例句与来源会由补词任务补齐。</p>'}
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
    $('#btn-next').disabled = false;

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
          <button class="btn btn--ghost" id="btn-hint" type="button">看首字母提示</button>
          <p class="spell__letters" id="spell-hint" hidden>${esc(q.hint)} · 提示后答对不记升阶天数</p>
        </form>`;
      const form = $('#spell-form');
      const input = $('#spell-input');
      $('#btn-hint').addEventListener('click', () => {
        q.aided = true;
        $('#spell-hint').hidden = false;
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

    // 默写前不朗读答案；认词可以听音，拼写只在作答后发音。
    if (store.settings.speak && q.kind === 'recognize') speak(q.word.word);
    updateProgress();
  }

  const normalize = (s) => String(s).normalize('NFKC').trim().toLowerCase()
    .replace(/[‘’]/g, "'").replace(/\s+/g, ' ');

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

    // 独立答对天数与下一次复习时间在每次作答后可见。
    const need = r.need || creditNeed();
    const have = (r.after.credits || []).length;
    const nextDue = formatDue(r.after.due);
    let creditNote;
    if (r.practice) {
      creditNote = '<p class="fb__credit">自由加练 · 不改变升阶天数与下次复习时间</p>';
    } else if (!isCorrect) {
      creditNote = `<p class="fb__credit fb__credit--bad">保留之前的 ${have} 天积累 · 本轮稍后重练 · 下次复习 ${nextDue}</p>`;
    } else if (r.aided) {
      creditNote = `<p class="fb__credit">借助提示答对，本次不记升阶天数 · 下次复习 ${nextDue}</p>`;
    } else if (r.before.stage === 'new') {
      creditNote = `<p class="fb__credit">进入「认词中」· 下次复习 ${nextDue}</p>`;
    } else if (r.promoted) {
      creditNote = r.after.stage === 'mastered'
        ? `<p class="fb__credit">跨天答对与拼写稳定性达标 → 已掌握 · 下次复习 ${nextDue}</p>`
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
        $('#correction-hint').textContent = '已订正，稍后还会再练这个词。';
        next.disabled = false;
        next.focus({ preventScroll: true });
      });
      input.focus({ preventScroll: true });
    } else next.focus({ preventScroll: true });
    if (store.settings.speak && q.kind !== 'recognize') speak(w.word);
  }

  function renderSummary(stats) {
    const rate = stats.done ? Math.round((stats.correct / stats.done) * 100) : 0;
    $('#summary-title').textContent = rate >= 90 ? '干净利落' : rate >= 70 ? '稳步推进' : '有难点，正常';

    // 把结果分成四类，避免把「新词刚起步」说成「攒到了新的一天」
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
      <div class="stat"><span class="stat__num">${rate}%</span><span class="stat__label">正确率</span></div>
      <div class="stat"><span class="stat__num">${gained.length}</span><span class="stat__label">攒到天数</span></div>`;

    const rows = [];
    if (started.length) rows.push(`<div class="summary__row"><b>${started.length} 个</b> 词进入「认词中」，开始攒天数</div>`);
    if (gained.length) rows.push(`<div class="summary__row"><b>${gained.length} 个</b> 词攒到了新的一天 <span class="tag tag--up">↑</span></div>`);
    summaryMistakes = [...stats.missed];
    if (summaryMistakes.length) rows.push(`<div class="summary__row">本轮错词：<b>${summaryMistakes.map((id) => esc(byId.get(id)?.word || id)).join('、')}</b></div>`);
    $('#btn-summary-mistakes').hidden = !summaryMistakes.length;
    rows.push(`<div class="summary__row">用时 ${Math.max(1, Math.round(stats.elapsed / MIN))} 分钟${stats.practice ? ' · 自由加练，不影响复习计划' : ''}</div>`);
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
      if (libFilter === 'mistakes' ? !p.wrong : libFilter !== 'all' && p.stage !== libFilter) return false;
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
          <p class="wcard__ex">${esc(w.example)}</p>
          <div class="wcard__foot">
            <span class="strength" role="img" aria-label="${creditText}">${pips}</span>
            <span class="wcard__meta">${creditText} · 对 ${p.correct} · 错 ${p.wrong} · ${dueText}${p.memory ? ` · 稳定性 ${p.memory.stability.toFixed(1)} 天` : ''}</span>
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
      refreshIntro();
      renderLibrary();
    });

    const retention = $('#set-retention');
    retention.value = store.settings.retention;
    $('#set-retention-out').textContent = retention.value + '%';
    retention.addEventListener('input', () => {
      store.settings.retention = Number(retention.value);
      store.settingsAt = now();
      $('#set-retention-out').textContent = retention.value + '%';
      saveStore();
    });

    const sp = $('#set-speak');
    sp.checked = !!store.settings.speak;
    sp.addEventListener('change', () => {
      store.settings.speak = sp.checked;
      saveStore();
    });

    $('#btn-export').addEventListener('click', () => exportProgress(JSON.stringify(store, null, 2)));
    $('#btn-backup').disabled = !localStorage.getItem(BACKUP_KEY);
    $('#btn-backup').addEventListener('click', () => exportProgress(localStorage.getItem(BACKUP_KEY), 'before-upgrade'));

    $('#import-file').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const imported = readStore(data);
        // 导入的也可能是旧版导出的文件，同样按版本升级语义
        migrateStore(imported, data.version);
        keepBackup(localStorage.getItem(STORE_KEY) || JSON.stringify(data));
        store = imported;
        saveStore();
        $('#btn-backup').disabled = false;
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
    $('#set-retention').value = store.settings.retention;
    $('#set-retention-out').textContent = store.settings.retention + '%';
    $('#btn-backup').disabled = !localStorage.getItem(BACKUP_KEY);
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

    $('#btn-start').addEventListener('click', () => startSession());
    $('#btn-review').addEventListener('click', () => startSession('review'));
    $('#btn-practice').addEventListener('click', () => startSession('practice'));
    $('#btn-mistakes').addEventListener('click', () => startSession('mistakes'));
    $('#btn-summary-mistakes').addEventListener('click', () => startSession('mistakes', summaryMistakes));
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
      if (e.isComposing) return;
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
        if (typing) return;  // 订正表单使用原生 Enter 提交
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
    try {
      if (typeof FSRS === 'undefined') throw new Error('复习算法未载入，请联网刷新一次');
      store = loadStore();
    } catch (err) {
      $('#session-intro').innerHTML = `<h2 class="intro__title">进度未被改动</h2>
        <p class="intro__sub">${esc(err.message || '无法读取进度')}。为保护原记录，本次暂停训练。</p>
        <button class="btn btn--ghost" id="btn-rescue" type="button">导出原始进度</button>`;
      $('#btn-rescue').addEventListener('click', () => exportProgress(localStorage.getItem(STORE_KEY), 'original'));
      return;
    }
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

    // 库外干扰释义池：拿不到就退化成只用库内词当干扰项，不影响训练
    try {
      const dres = await fetch('data/distractors.json', { cache: 'no-cache' });
      if (dres.ok) {
        const ddata = await dres.json();
        DISTRACTORS = Array.isArray(ddata.words) ? ddata.words : [];
      }
    } catch (err) {
      DISTRACTORS = [];
    }

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
    setInterval(() => { if (!session) refreshIntro(); }, MIN);
    window.addEventListener('focus', refreshIntro);

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
