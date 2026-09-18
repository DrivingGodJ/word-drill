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
  /** 强度 → 复习间隔（毫秒）。索引即 strength。 */
  const INTERVALS = [10 * MIN, 1 * DAY, 3 * DAY, 7 * DAY, 16 * DAY, 35 * DAY];
  /**
   * 下一次复习间隔按「当前所处阶段」给，而不是按强度。
   * 好处：同一个词答对一次不会被直接推到 1 天后，当轮还想再练就能继续练；
   * 真正掌握了（mastered）才拉长到天级间隔。
   */
  const STAGE_DUE = { recognize: 15 * MIN, write: 6 * HOUR, mastered: 3 * DAY };
  const REQUESTS_PER_ROUND = 40;   // 单轮最大题量，避免无限循环

  /* ---------- 状态 ---------- */
  let WORDS = [];          // 词库
  let META = {};
  const byId = new Map();
  let store = null;        // 持久化状态
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
  function defaultStore() {
    return {
      version: 1,
      settings: { newLimit: 10, threshold: 2, speak: true, theme: 'auto' },
      words: {},                       // id → 进度
      stats: { answers: 0, correct: 0, sessions: 0, lastDate: null, streakDays: 0 }
    };
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultStore();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultStore(), parsed, {
        settings: Object.assign(defaultStore().settings, parsed.settings || {}),
        stats: Object.assign(defaultStore().stats, parsed.stats || {}),
        words: parsed.words || {}
      });
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
      stage: 'new', strength: 0, streak: 0,
      correct: 0, wrong: 0, due: 0, lastSeen: 0
    };
  }

  /* ---------- SRS 引擎 ---------- */
  /**
   * 判定一次作答并推进状态。
   * @returns {{before:object, after:object, promoted:boolean, demoted:boolean}}
   */
  function grade(id, isCorrect) {
    const before = progressOf(id);
    const after = Object.assign({}, before);
    const threshold = Math.max(1, Number(store.settings.threshold) || 2);
    let promoted = false, demoted = false;

    after.lastSeen = now();
    store.stats.answers++;
    if (isCorrect) store.stats.correct++;

    if (isCorrect) {
      after.correct++;
      after.streak++;
      after.strength = Math.min(5, after.strength + 1);

      // 升阶
      if (after.stage === 'new') {
        after.stage = 'recognize';
        promoted = true;
      } else if (after.streak >= threshold) {
        // 每跨一关都要重新累计「连续答对」，否则一关只需再对一次就过
        if (after.stage === 'recognize') { after.stage = 'write'; after.streak = 0; promoted = true; }
        else if (after.stage === 'write') { after.stage = 'mastered'; after.streak = 0; promoted = true; }
      }
    } else {
      after.wrong++;
      after.streak = 0;
      after.strength = Math.max(0, after.strength - 1);

      // 降阶：写不出来 / 巩固失败 → 退回上一关
      if (after.stage === 'mastered') { after.stage = 'write'; demoted = true; }
      else if (after.stage === 'write' && after.strength === 0) { after.stage = 'recognize'; demoted = true; }
    }

    // 间隔调度：答错用最短间隔，让它在本次之后很快重现
    const base = isCorrect
      ? (STAGE_DUE[after.stage] || INTERVALS[Math.min(after.strength, 5)])
      : 3 * MIN;
    after.due = now() + base;

    store.words[id] = after;
    saveStore();
    return { before, after, promoted, demoted };
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

  /* ---------- 会话 ---------- */
  function startSession() {
    const t = now();
    const dueWords = WORDS
      .filter((w) => {
        const p = progressOf(w.id);
        return p.stage !== 'new' && p.due <= t;
      })
      .sort((a, b) => progressOf(a.id).strength - progressOf(b.id).strength);

    const newLimit = Math.max(0, Number(store.settings.newLimit) || 0);
    const freshWords = WORDS.filter((w) => progressOf(w.id).stage === 'new').slice(0, newLimit);

    const queue = dueWords.concat(freshWords).map((w) => w.id);

    if (!queue.length) {
      const allMastered = WORDS.length > 0 && WORDS.every((w) => progressOf(w.id).stage === 'mastered');
      toast(allMastered ? '全部单词已掌握，今天没有待复习的' : '暂时没有需要训练的词');
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

    const threshold = Math.max(1, Number(store.settings.threshold) || 2);
    // 答错 → 本次稍后重来一遍，趁热打铁
    // 答对但本关还没累计够「连续答对」→ 也稍后重现，让「先认后写」在同一轮里走完
    const needsMore = !isCorrect ||
      (r.after.stage !== 'mastered' && r.after.streak < threshold);
    if (needsMore) {
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
    $('#intro-hint').textContent = totalToday
      ? `本轮约 ${totalToday} 个词 · 认词 ${recognize} · 拼写 ${write} · 已掌握 ${mastered}`
      : (WORDS.length ? '今天的复习任务已完成，可以先去词库看看。' : '词库还是空的。');
    $('#btn-start').disabled = totalToday === 0;
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
      </div>`;

    const next = $('#btn-next');
    next.hidden = false;
    next.textContent = session.done >= session.total ? '看小结' : '继续';
    next.focus({ preventScroll: true });
  }

  function renderSummary(stats) {
    const rate = stats.done ? Math.round((stats.correct / stats.done) * 100) : 0;
    $('#summary-title').textContent = rate >= 90 ? '干净利落' : rate >= 70 ? '稳步推进' : '有难点，正常';

    const up = [], down = [];
    stats.results.forEach((r, id) => {
      if (r.after.strength > r.before.strength) up.push(id);
      if (r.after.strength < r.before.strength) down.push(id);
    });

    $('#summary-stats').innerHTML = `
      <div class="stat"><span class="stat__num">${stats.done}</span><span class="stat__label">答题</span></div>
      <div class="stat"><span class="stat__num">${rate}%</span><span class="stat__label">正确率</span></div>
      <div class="stat"><span class="stat__num">${up.length}</span><span class="stat__label">变扎实</span></div>`;

    const rows = [];
    if (up.length) rows.push(`<div class="summary__row"><b>${up.length} 个</b> 词的熟练度上升 <span class="tag tag--up">↑</span></div>`);
    if (down.length) rows.push(`<div class="summary__row"><b>${down.length} 个</b> 词需要巩固 <span class="tag tag--down">↓</span></div>`);
    const advanced = [];
    stats.results.forEach((r, id) => { if (r.promoted) advanced.push(byId.get(id)?.word); });
    if (advanced.length) {
      rows.push(`<div class="summary__row">升阶：<b>${advanced.map(esc).join('、')}</b> <span class="tag tag--up">晋级</span></div>`);
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
      const pips = Array.from({ length: 5 }, (_, i) =>
        `<i class="strength__pip ${i < p.strength ? 'is-on' : ''}" data-stage="${p.stage}"></i>`).join('');
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
            <span class="strength" role="img" aria-label="熟练度 ${p.strength} / 5">${pips}</span>
            <span class="wcard__meta">对 ${p.correct} · 错 ${p.wrong} · ${dueText}</span>
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

  function applySettingsToUI() {
    $('#set-newlimit').value = store.settings.newLimit;
    $('#set-newlimit-out').textContent = store.settings.newLimit;
    $('#set-threshold').value = store.settings.threshold;
    $('#set-threshold-out').textContent = store.settings.threshold;
    $('#set-threshold-text').textContent = store.settings.threshold;
    $('#set-speak').checked = !!store.settings.speak;
  }

  /* ---------- 主题 ---------- */
  function applyTheme() {
    const t = store.settings.theme || 'auto';
    document.documentElement.dataset.theme = t;
    $('#theme-toggle').setAttribute('aria-label',
      t === 'dark' ? '切换到浅色主题' : t === 'light' ? '切换到跟随系统' : '切换到深色主题');
  }

  function cycleTheme() {
    const order = ['auto', 'dark', 'light'];
    const i = order.indexOf(store.settings.theme || 'auto');
    store.settings.theme = order[(i + 1) % order.length];
    saveStore();
    applyTheme();
    toast({ auto: '跟随系统', dark: '深色主题', light: '浅色主题' }[store.settings.theme]);
  }

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
    $('#btn-again').addEventListener('click', () => { showPanel('intro'); refreshIntro(); startSession(); });
    $('#btn-end').addEventListener('click', endSession);
    $('#btn-next').addEventListener('click', () => {
      if (session && session.done >= session.total) endSession();
      else nextQuestion();
    });
    $('#theme-toggle').addEventListener('click', cycleTheme);

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
    applyTheme();

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
    refreshIntro();
    showPanel('intro');

    const hash = location.hash.replace('#', '');
    if (['library', 'settings'].includes(hash)) switchView(hash);

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
