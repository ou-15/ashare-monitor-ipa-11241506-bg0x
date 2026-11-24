/* 基金实时估值 · 前端计算与渲染
 * 设计原则：数据源只给事实（净值 / 持仓 / 行情），所有估算口径在前端算，
 * 因此切换计算方式 = 本地重算，零网络请求。
 * 数据来源两选一：电脑上的 Python 服务（API_BASE），或 App 内本机直连（DIRECT）。
 */
(() => {
  'use strict';

  const LS_FUNDS = 'fund.panel.funds.v2';
  const LS_SET = 'fund.panel.settings.v2';
  const LS_HOLD = (code) => `fund.panel.hold.v2.${code}`;
  const NAV_TTL = 5 * 60 * 1000;
  const INDEX_RATIO = 0.97;   // 指数跟踪模式的仓位折算系数
  const DEMO_CODES = ['110022', '161725', '005827'];

  /* 数据地址：网页版留空=同源；App（file://）可填 ?api= 或 localStorage.apiBase
   * 指向电脑上的 Python 服务，与首页 app.js 使用同一个键，设置一次两页通用。
   * 不填服务地址时走「本机直连」：净值/行情由页面自己取，持仓由 App 原生代抓。
   */
  const FILE_MODE = location.protocol === 'file:';
  const API_BASE = (() => {
    const q = new URLSearchParams(location.search).get('api');
    if (q) {
      try { localStorage.setItem('apiBase', q); } catch (_) { /* ignore */ }
      return q.replace(/\/+$/, '');
    }
    try { return (localStorage.getItem('apiBase') || '').replace(/\/+$/, ''); } catch (_) { return ''; }
  })();

  /* App 内没填服务地址时，走「本机直连」：净值/行情由网页自己拿，持仓由原生通道代抓 */
  const DIRECT = FILE_MODE && !API_BASE && !!window.FundDirect;

  const state = {
    funds: [],
    navs: {},
    quotes: {},
    holds: {},
    mode: 'weighted',
    interval: 30,
    left: 30,
    lastAt: null,
    navAt: 0,
    busy: false,
    open: new Set(),
    error: '',
    editing: null,
    deviations: {},
    devAt: 0,
    snapAt: 0,
    calib: false,
    errs: {},
    group: '',
  };

  const $ = (sel) => document.querySelector(sel);
  const el = {
    body: () => $('#fundBody'),
    seg: () => $('#modeSeg'),
    statusDot: () => $('#statusDot'),
    statusText: () => $('#statusText'),
    countdown: () => $('#countdown'),
    summary: () => $('#summary'),
    mkt: () => $('#mktRow'),
    empty: () => $('#emptyState'),
    hint: () => $('#addHint'),
    addInput: () => $('#addInput'),
    modal: () => $('#editModal'),
  };

  /* ----------------------------------------------------------- 工具 */
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const fmtNav = (v) => (num(v) === null ? '—' : v.toFixed(4));
  const fmtPct = (v, digits = 2) => {
    const n = num(v);
    if (n === null) return '—';
    return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
  };
  const fmtMoney = (v) => {
    const n = num(v);
    if (n === null) return '—';
    const body = Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // 金额一律带 ¥，否则「+0.24」看起来只是个数字，认不出是多少钱
    return `${n > 0 ? '+' : n < 0 ? '-' : ''}¥${body}`;
  };
  const fmtWan = (v) => {
    const n = num(v);
    if (n === null) return '—';
    return Math.abs(n) >= 10000 ? `${(n / 10000).toFixed(2)} 万` : n.toFixed(2);
  };
  const cls = (v) => {
    const n = num(v);
    if (n === null || n === 0) return 'flat';
    return n > 0 ? 'up' : 'down';
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const KIND_LABEL = {
    active: '主动', index: '指数', etf: 'ETF', link: '联接',
    qdii: 'QDII', bond: '债券', money: '货币',
  };

  /* 指数映射表：按基金名称关键词匹配跟踪指数（腾讯行情代码），手动填写的优先。
   * 命中后指数跟踪模式无需手填代码；未命中的基金仍回落持仓加权。
   */
  const INDEX_MAP = [
    { re: /恒生科技/, sym: 'hkHSTECH', name: '恒生科技指数' },
    { re: /恒生|港股|香港/, sym: 'hkHSI', name: '恒生指数' },
    { re: /纳斯达克|纳指/, sym: 'usIXIC', name: '纳斯达克' },
    { re: /道琼斯/, sym: 'usDJI', name: '道琼斯' },
    { re: /沪深300/, sym: 'sh000300', name: '沪深300' },
    { re: /中证500/, sym: 'sh000905', name: '中证500' },
    { re: /中证1000/, sym: 'sh000852', name: '中证1000' },
    { re: /上证50/, sym: 'sh000016', name: '上证50' },
    { re: /科创50|科创板50|科创创业/, sym: 'sh000688', name: '科创50' },
    { re: /创业板/, sym: 'sz399006', name: '创业板指' },
    { re: /白酒/, sym: 'sz399997', name: '中证白酒' },
    { re: /消费/, sym: 'sh000932', name: '中证消费' },
    { re: /医药|医疗|生物|健康/, sym: 'sh000933', name: '中证医药' },
    { re: /证券|券商/, sym: 'sz399975', name: '证券公司' },
    { re: /银行/, sym: 'sz399986', name: '中证银行' },
    { re: /新能源车|新能车|新能源汽|智能汽车/, sym: 'sz399976', name: 'CS新能车' },
  ];

  function indexFor(fund, hold) {
    const manual = (fund.indexCode || '').trim();
    if (manual) return { sym: manual, name: (state.quotes[manual] && state.quotes[manual].name) || manual, auto: false };
    const nm = `${(hold && hold.fund_name) || ''} ${fund.name || ''}`;
    for (const m of INDEX_MAP) {
      if (m.re.test(nm)) return { sym: m.sym, name: m.name, auto: true };
    }
    return null;
  }

  async function api(name, params) {
    const qs = new URLSearchParams(params || {});
    const res = await fetch(`${API_BASE}/api/fund/${name}?${qs.toString()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function toast(msg, ms = 1800) {
    let t = document.querySelector('.toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), ms);
  }

  /* ----------------------------------------------------------- 持久化 */
  function loadLocal() {
    try {
      const f = JSON.parse(localStorage.getItem(LS_FUNDS) || '[]');
      if (Array.isArray(f)) state.funds = f.filter((x) => x && x.code);
    } catch (_) { state.funds = []; }
    try {
      const s = JSON.parse(localStorage.getItem(LS_SET) || '{}');
      if (s.mode) state.mode = s.mode;
      if (s.interval) state.interval = s.interval;
      if (typeof s.calib === 'boolean') state.calib = s.calib;
      if (typeof s.group === 'string') state.group = s.group;
    } catch (_) { /* ignore */ }
  }
    function saveFunds() {
    localStorage.setItem(LS_FUNDS, JSON.stringify(state.funds));
  }
  function saveSettings() {
    localStorage.setItem(LS_SET, JSON.stringify({
      mode: state.mode, interval: state.interval, calib: state.calib, group: state.group,
    }));
  }
  function readHoldCache(code) {
    try {
      const h = JSON.parse(localStorage.getItem(LS_HOLD(code)) || 'null');
      if (h && h.day === dayKey() && Array.isArray(h.items) && h.items.length) return h;
    } catch (_) { /* ignore */ }
    return null;
  }
  function writeHoldCache(code, payload) {
    try {
      localStorage.setItem(LS_HOLD(code), JSON.stringify({
        day: dayKey(),
        report_date: payload.report_date,
        report_label: payload.report_label,
        fund_name: payload.fund_name,
        kind: payload.kind,
        items: payload.items,
        sum_weight: payload.sum_weight,
        single_etf: payload.single_etf,
        cached: payload.cached,
        fetched_at: payload.fetched_at,
      }));
    } catch (_) { /* 配额满时忽略 */ }
  }

  /* ----------------------------------------------------------- 数据加载 */
  async function ensureHoldings(code, force) {
    if (!force) {
      const local = readHoldCache(code);
      if (local) {
        state.holds[code] = local;
        return local;
      }
    }
    if (DIRECT) {
      const res = await window.FundDirect.holdings(code);
      writeHoldCache(code, res);
      state.holds[code] = readHoldCache(code) || res;
      return state.holds[code];
    }
    const res = await api('holdings', { code, force: force ? 1 : 0 });
    if (!res.ok) throw new Error(res.error || '持仓获取失败');
    writeHoldCache(code, res);
    state.holds[code] = readHoldCache(code) || res;
    return state.holds[code];
  }

  async function loadQuotes(symbols, force) {
    const uniq = [...new Set(symbols.filter(Boolean))];
    if (!uniq.length) return;
    if (DIRECT) {
      const res = await window.FundDirect.quotes(uniq);
      if (res && res.quotes) Object.assign(state.quotes, res.quotes);
      (res.missing || []).forEach((s) => {
        if (!state.quotes[s]) state.quotes[s] = { symbol: s, pct: null, missing: true };
      });
      return;
    }
    const chunks = [];
    for (let i = 0; i < uniq.length; i += 200) chunks.push(uniq.slice(i, i + 200));
    for (const chunk of chunks) {
      const res = await api('quotes', { symbols: chunk.join(','), force: force ? 1 : 0 });
      if (res && res.quotes) Object.assign(state.quotes, res.quotes);
      if (res && res.missing && res.missing.length) {
        res.missing.forEach((s) => { if (!state.quotes[s]) state.quotes[s] = { symbol: s, pct: null, missing: true }; });
      }
    }
  }

  async function loadNavs(force) {
    const now = Date.now();
    const missing = state.funds.some((f) => !state.navs[f.code]);
    if (!force && !missing && now - state.navAt < NAV_TTL) return;
    const codes = state.funds.map((f) => f.code);
    if (!codes.length) return;
    const res = DIRECT
      ? await window.FundDirect.navs(codes)
      : await api('nav', { codes: codes.join(','), force: force ? 1 : 0 });
    if (res && res.items) Object.assign(state.navs, res.items);
    state.navFail = (res && Array.isArray(res.failed)) ? res.failed : [];
    state.navAt = now;
  }

  async function refresh(force) {
    if (state.busy) return;
    state.busy = true;
    setStatus('loading', '刷新中…');
    const errs = {};
    try {
      if (state.funds.length) {
        try {
          await loadNavs(force);
        } catch (err) {
          state.funds.forEach((f) => { errs[f.code] = `净值：${err.message}`; });
          throw err;
        }
        (state.navFail || []).forEach((c) => { errs[c] = '净值：代码无数据'; });
        await Promise.all(state.funds.map((f) => {
          if (f.noHoldings) return null;
          return ensureHoldings(f.code, false).catch((err) => {
            errs[f.code] = `持仓：${err.message}`;
            return null;
          });
        }));
        const symbols = [];
        state.funds.forEach((f) => {
          const h = state.holds[f.code];
          if (h) h.items.forEach((it) => symbols.push(it.symbol));
          const idx = indexFor(f, h);
          if (idx) symbols.push(idx.sym);
        });
        await loadQuotes(symbols, force);
        // 行情缺口归因：一只基金半数以上持仓拿不到实时价，就在行内标出来
        state.funds.forEach((f) => {
          if (errs[f.code]) return;
          const h = state.holds[f.code];
          if (!h || !h.items || !h.items.length) return;
          const miss = h.items.filter((it) => {
            const q = state.quotes[it.symbol];
            return !q || num(q.pct) === null;
          }).length;
          if (miss > h.items.length / 2) errs[f.code] = `行情：${miss}/${h.items.length} 只无报价`;
        });
        await loadDeviations(false);
        await pushSnapshots();
      }
      state.lastAt = new Date();
      state.error = '';
    } catch (err) {
      const msg = (err && err.message) || String(err);
      state.error = /Failed to fetch|NetworkError|Load failed/i.test(msg)
        ? (API_BASE ? `连不上数据服务 ${API_BASE}` : '连不上数据服务')
        : msg;
    } finally {
      state.busy = false;
      state.left = state.interval;
      state.errs = errs;
      paintStatus();
      render();
    }
  }

  /** 头部状态灯：未配置地址 > 整体失败 > 个别异常 > 正常 */
  function paintStatus() {
    if (FILE_MODE && !API_BASE && !DIRECT) {
      setStatus('bad', '未配置数据服务');
      return;
    }
    if (state.error) {
      setStatus('bad', `刷新失败：${state.error}`);
      return;
    }
    const n = Object.keys(state.errs).length;
    const t = state.lastAt ? state.lastAt.toLocaleTimeString('zh-CN', { hour12: false }) : '—';
    if (n) setStatus('warn', `已更新 ${t} · ${n} 只异常`);
    else setStatus('ok', `已更新 ${t}`);
  }

  /** 单只重试：跳过当日缓存放行重取持仓，并刷新它自己的净值与行情 */
  async function retryFund(code) {
    const f = state.funds.find((x) => x.code === code);
    if (!f) return;
    toast(`重试 ${code}…`, 1200);
    try {
      if (!f.noHoldings) await ensureHoldings(code, true);
      const res = DIRECT
        ? await window.FundDirect.navs([code])
        : await api('nav', { codes: code, force: 1 });
      if (res && res.items && res.items[code]) state.navs[code] = res.items[code];
      const h = state.holds[code];
      const symbols = [];
      if (h) h.items.forEach((it) => symbols.push(it.symbol));
      const idx = indexFor(f, h);
      if (idx) symbols.push(idx.sym);
      await loadQuotes(symbols, true);
      delete state.errs[code];
      toast(`已重试 ${code}`);
    } catch (err) {
      state.errs[code] = err.message || String(err);
      toast(`重试失败：${state.errs[code]}`, 2800);
    }
    paintStatus();
    render();
  }

  /** 把「当天下班前最后一次估算」存档，供收盘后与真实净值对账 */
  async function pushSnapshots() {
    if (!state.funds.length) return;
    const now = Date.now();
    if (now - state.snapAt < 90 * 1000) return;
    const items = [];
    state.funds.forEach((f) => {
      const e = estimate(f, true);   // 存原始模型值，校准值不进快照
      if (e.ready) {
        items.push({ code: f.code, pct: e.pct, est: e.est, nav_date: e.nav.nav_date, mode: e.mode });
      }
    });
    if (!items.length) return;
    state.snapAt = now;
    try {
      if (DIRECT) {
        window.FundDirect.saveSnapshots(items);
        return;
      }
      await fetch(`${API_BASE}/api/fund/snap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
    } catch (_) { /* 快照失败不影响主流程 */ }
  }

  async function loadDeviations(force) {
    if (!state.funds.length) return;
    const now = Date.now();
    if (!force && state.devAt && now - state.devAt < 10 * 60 * 1000) return;
    await Promise.all(state.funds.map(async (f) => {
      try {
        const r = DIRECT
          ? await window.FundDirect.deviation(f.code, 20)
          : await api('deviation', { code: f.code, days: 20 });
        if (r && r.ok) state.deviations[f.code] = r;
      } catch (_) { /* 单只失败不影响其他 */ }
    }));
    state.devAt = now;
  }

  function setStatus(kind, text) {
    const dot = el.statusDot();
    dot.className = `dot${kind && kind !== 'loading' ? ` ${kind}` : ''}`;
    el.statusText().textContent = text;
  }

  /* ----------------------------------------------------------- 估算口径 */
  function quoteOf(symbol) {
    return symbol ? state.quotes[symbol] : null;
  }

  function resolveMode(fund, hold, nav) {
    if (state.mode !== 'auto') return state.mode;
    const kind = hold.kind || 'active';
    if ((kind === 'index' || kind === 'etf' || kind === 'link') && indexFor(fund, hold)) return 'index';
    if (kind === 'qdii') return 'weighted';
    if (nav && num(nav.gz_pct) !== null) return 'official';
    return 'weighted';
  }

  function estimate(fund, rawOnly) {
    const nav = state.navs[fund.code] || null;
    const hold = state.holds[fund.code] || null;
    if (!nav || num(nav.nav) === null) {
      return { ready: false, reason: state.errs[fund.code] ? '数据异常 · 可重试' : (nav ? '净值缺失' : '净值加载中') };
    }
    if (!hold || !hold.items || !hold.items.length) {
      return {
        ready: false,
        reason: fund.noHoldings ? '无股票持仓（货币/债基）'
          : state.errs[fund.code] ? '数据异常 · 可重试'
            : (hold === undefined ? '持仓加载中' : '无持仓数据'),
      };
    }
    const mode = resolveMode(fund, hold, nav);
    const items = hold.items.map((it) => {
      const q = quoteOf(it.symbol);
      return { ...it, pct: q ? num(q.pct) : null, suspended: !!(q && q.suspended) };
    });
    const covered = items.filter((it) => it.pct !== null);
    const wsum = num(hold.sum_weight) || 0;
    // 贡献 = (占净值比 / 100) × 实时涨跌，单位是「占基金净值的百分点」
    const contrib = covered.reduce((s, it) => s + (it.weight / 100) * it.pct, 0);

    const normalized = !(wsum < 60 || hold.single_etf || hold.kind === 'link');
    let pct = null;
    let basis = '';
    let fallback = '';

    let indexInfo = null;
    if (mode === 'weighted') {
      pct = normalized ? contrib / ((wsum || 1) / 100) : contrib;
      basis = normalized
        ? `归一化：Σ(w×r) ÷ Σw（Σ持仓 ${wsum.toFixed(2)}%）`
        : `不归一：Σ(w×r)，剩余 ${(100 - wsum).toFixed(2)}% 按 0 计`;
    } else if (mode === 'index') {
      indexInfo = indexFor(fund, hold);
      if (!indexInfo) {
        fallback = '未匹配到跟踪指数（可在编辑里手填），回落到持仓加权';
      } else {
        const q = quoteOf(indexInfo.sym);
        if (q && num(q.pct) !== null) {
          pct = q.pct * INDEX_RATIO;
          basis = `跟踪 ${indexInfo.name}（${indexInfo.sym}${indexInfo.auto ? ' 自动匹配' : ''}）`
            + `实时 ${fmtPct(q.pct)} × 仓位 ${INDEX_RATIO}`;
        } else {
          fallback = `${indexInfo.name}（${indexInfo.sym}）行情未取到，回落到持仓加权`;
        }
      }
    } else if (mode === 'official') {
      if (num(nav.gz_pct) !== null) {
        pct = nav.gz_pct;
        basis = `天天基金官方估值 ${nav.gz_time || ''}`;
      } else {
        fallback = '官方估值字段为空（接口当前不可用），回落到持仓加权';
      }
    }
    if (pct === null) {
      pct = normalized ? contrib / ((wsum || 1) / 100) : contrib;
      if (!basis) basis = normalized ? '持仓加权（归一化）' : '持仓加权（不归一）';
    }

    // 历史偏差校准：把近 20 日「实际 − 估算」的均值加回估算（上限 ±1.5pp）
    const pctRaw = pct;
    let calibApplied = 0;
    const dev = state.deviations[fund.code];
    if (!rawOnly && state.calib && dev && dev.stats && dev.stats.ready) {
      calibApplied = num(dev.stats.calib) || 0;
      pct += calibApplied;
    }

    const est = nav.nav * (1 + pct / 100);
    const shares = num(fund.shares) || 0;
    const cost = num(fund.cost) || 0;
    const dayPnl = shares > 0 ? shares * (est - nav.nav) : null;
    const totalPnl = shares > 0 && cost > 0 ? shares * (est - cost) : null;

    // 置信度
    let conf = 'low';
    const confText = `前十 ${wsum.toFixed(0)}%`;
    if (wsum >= 70) conf = 'high';
    else if (wsum >= 40) conf = 'mid';
    const hasUS = items.some((it) => (it.symbol || '').startsWith('us'));
    const hasHK = items.some((it) => (it.symbol || '').startsWith('hk'));

    return {
      ready: true, mode, items, pct, pctRaw, calibApplied, est, basis, fallback, indexInfo,
      normalized, wsum, contrib, conf, confText, hasUS, hasHK,
      dayPnl, totalPnl, shares, nav, hold,
      coveredCount: covered.length,
    };
  }

  /* ----------------------------------------------------------- 渲染 */
  function renderNote() {
    const tip = {
      weighted: '当前模式：持仓加权。估算涨跌 = Σ(持仓占比×实时涨跌) ÷ Σ持仓占比；前十合计低于 60% 或 ETF 联接时自动改为不归一。',
      index: '当前模式：指数跟踪。按基金名称自动匹配跟踪指数（可手填覆盖），用该指数实时涨跌 × 97% 仓位折算；未匹配或行情缺失时回落持仓加权。',
      official: '当前模式：官方估值。取天天基金官方估值字段；该字段当前普遍为空，为空时自动回落到持仓加权，并在行内标「已回落」。',
      auto: '当前模式：自动。指数/ETF/联接基金走指数跟踪（优先手填代码，其次按名称自动匹配），QDII 与无官方估值的走持仓加权。',
    };
    const el0 = $('#noteMode');
    if (el0) el0.textContent = tip[state.mode] || tip.weighted;
  }

  function groupOf(fund) {
    return (fund.account || '').trim() || '未分组';
  }

  /** 分组条：每组一枚胶囊，显示该组持仓市值与只数；点一下就只看该组 */
  function renderGroups(all) {
    const bar = $('#groupBar');
    if (!bar) return;
    const map = new Map();
    all.forEach(({ fund, est }) => {
      const g = groupOf(fund);
      const m = map.get(g) || { n: 0, value: 0 };
      m.n += 1;
      const sh = num(fund.shares) || 0;
      if (est.ready && sh > 0) m.value += sh * est.est;
      map.set(g, m);
    });
    if (state.group && !map.has(state.group)) state.group = '';
    const named = [...map.keys()].filter((g) => g !== '未分组').length;
    if (map.size <= 1 && !named) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    const totalValue = [...map.values()].reduce((s, m) => s + m.value, 0);
    const chips = [`<button class="chip${state.group === '' ? ' on' : ''}" data-group="">
      全部<span>¥${fmtWan(totalValue)}</span><em>${all.length} 只</em></button>`];
    [...map.entries()]
      .sort((a, b) => b[1].value - a[1].value)
      .forEach(([g, m]) => {
        chips.push(`<button class="chip${state.group === g ? ' on' : ''}" data-group="${esc(g)}">
          ${esc(g)}<span>${m.value ? `¥${fmtWan(m.value)}` : '未填份额'}</span><em>${m.n} 只</em></button>`);
      });
    bar.innerHTML = chips.join('');
    bar.querySelectorAll('button[data-group]').forEach((b) => {
      b.addEventListener('click', () => {
        state.group = b.dataset.group;
        saveSettings();
        render();
      });
    });
  }

  function render() {
    const all = state.funds.map((f) => ({ fund: f, est: estimate(f) }));
    renderGroups(all);
    const list = state.group ? all.filter(({ fund }) => groupOf(fund) === state.group) : all;
    renderSummary(list);
    renderRows(list);
    renderMarket();
    renderNote();
    renderDev();
    el.empty().hidden = state.funds.length > 0;
    const cnt = $('#fundCount');
    if (cnt) cnt.textContent = `${state.funds.length} 只`;
    el.seg().querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.mode));
    $('#intervalSel').value = String(state.interval);
    el.countdown().textContent = `${state.left}s`;
  }

  function renderSummary(list) {
    let value = 0, prevValue = 0, day = 0, total = 0, costSum = 0, filled = 0, navDay = '';
    list.forEach(({ fund, est }) => {
      if (!est.ready) return;
      const shares = num(fund.shares) || 0;
      if (shares > 0) {
        filled += 1;
        value += shares * est.est;
        prevValue += shares * est.nav.nav;
        if (est.dayPnl !== null) day += est.dayPnl;
        if (est.totalPnl !== null) total += est.totalPnl;
        if (num(fund.cost) > 0) costSum += shares * fund.cost;
      }
      if (!navDay && est.nav.nav_date) navDay = est.nav.nav_date;
    });
    const dayPct = prevValue > 0 ? (day / prevValue) * 100 : null;
    const totalPct = costSum > 0 ? (total / costSum) * 100 : null;
    const missing = list.length - filled;
    const unEstimable = list.filter(({ fund, est }) => !est.ready && (num(fund.shares) || 0) > 0).length;
    const fillBtn = missing > 0
      ? `<button class="fill-link" data-open="bulk">${filled ? `还差 ${missing} 只，补填份额 →` : '填写份额 →'}</button>`
      : '';
    const skipHint = unEstimable ? ` · ${unEstimable} 只不可估未计入` : '';
    const fill = filled > 0;
    el.summary().innerHTML = `
      <div class="daycard ${cls(day)}">
        <div class="dc-top">
          <span class="dc-k">当日收益 · ${filled} 只可估${skipHint}</span>
          <span class="dc-tag">按估算估值</span>
        </div>
        <div class="dc-main">
          <span class="dc-v">${fill ? fmtMoney(day) : '—'}</span>
          <span class="dc-pct">${dayPct === null ? '' : fmtPct(dayPct)}</span>
        </div>
        <div class="dc-grid">
          <div><div class="k">持仓市值</div><div class="mono v">${fill ? `¥${fmtWan(value)}` : '—'}</div></div>
          <div><div class="k">累计收益</div><div class="mono v ${cls(total)}">${fill ? fmtMoney(total) : '—'}${totalPct === null ? '' : `<small>${fmtPct(totalPct)}</small>`}</div></div>
          <div><div class="k">成本合计</div><div class="mono v">${costSum > 0 ? `¥${fmtWan(costSum)}` : '—'}</div></div>
        </div>
        <div class="dc-foot">
          <span>${list.length} 只 · 净值 ${navDay || '—'}${state.group ? ` · ${state.group}` : ''}</span>
          ${fillBtn}
        </div>
      </div>`;
    el.summary().querySelectorAll('[data-open="bulk"]').forEach((b) => {
      b.addEventListener('click', (ev) => { ev.stopPropagation(); openBulk(); });
    });
  }

  /* ----------------------------------------------------------- 列表渲染
   * 每行 = 右侧固定的 .swipe-acts（改 / 删）+ 左侧可平移的 .sbody
   * 左滑超过一半宽度即驻留展开，再右滑或点别处收回；轻点行展开持仓明细。
   */
  const SWIPE_W = 116;
  let swipeRow = null;

  function closeSwipe(except) {
    if (!swipeRow || swipeRow === except) return;
    const a = swipeRow.querySelector('.swipe-acts');
    if (a) { a.style.transition = ''; a.style.transform = ''; }
    swipeRow.classList.remove('swiped');
    swipeRow = null;
  }

  function renderRows(list) {
    const body = el.body();
    if (!state.funds.length) { body.innerHTML = ''; return; }
    body.innerHTML = list.map(({ fund, est }) => rowHtml(fund, est)).join('');
    body.querySelectorAll('.srow').forEach((row) => bindRow(row));
  }

  function bindRow(row) {
    const body = row.querySelector('.sbody');
    const code = row.dataset.code;
    let x0 = 0, base = 0, moved = false, dragging = false;

    const apply = (open) => {
      row.classList.toggle('swiped', open);
      body.style.transition = '';
      body.style.transform = open ? `translateX(-${SWIPE_W}px)` : '';
      if (open) {
        if (swipeRow && swipeRow !== row) closeSwipe(row);
        swipeRow = row;
      } else if (swipeRow === row) {
        swipeRow = null;
      }
    };

    row.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.sact') || ev.target.closest('.fill-mini')) return;
      if (swipeRow && swipeRow !== row) closeSwipe(row);
      dragging = true; moved = false;
      x0 = ev.clientX;
      base = row.classList.contains('swiped') ? -SWIPE_W : 0;
      body.style.transition = 'none';
    });
    row.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 6) moved = true;
      body.style.transform = `translateX(${Math.max(-SWIPE_W, Math.min(0, base + dx))}px)`;
    });
    const end = (ev) => {
      if (!dragging) return;
      dragging = false;
      const dx = (ev.clientX || x0) - x0;
      apply(Math.max(-SWIPE_W, Math.min(0, base + dx)) < -SWIPE_W / 2);
      if (!moved && !row.classList.contains('swiped')) toggleDetail(row, code);
    };
    row.addEventListener('pointerup', end);
    row.addEventListener('pointercancel', end);

    row.querySelectorAll('.sact.edit').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation(); closeSwipe(); openEditor(b.dataset.code);
    }));
    row.querySelectorAll('.sact.del').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation(); closeSwipe(); removeFund(b.dataset.code);
    }));
    row.querySelectorAll('.fill-mini').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation(); closeSwipe(); openEditor(b.dataset.code);
    }));
    row.querySelectorAll('button.retry').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation(); retryFund(b.dataset.retry);
    }));
  }

  function toggleDetail(row, code) {
    const fund = state.funds.find((f) => f.code === code);
    const est = fund ? estimate(fund) : null;
    if (!est || !est.ready) return;   // 无持仓/无净值时没有明细
    const next = row.nextElementSibling;
    if (state.open.has(code)) {
      state.open.delete(code);
      row.classList.remove('open');
      if (next && next.classList.contains('detail')) next.remove();
      return;
    }
    state.open.add(code);
    row.classList.add('open');
    if (!(next && next.classList.contains('detail'))) {
      const box = document.createElement('div');
      box.className = 'detail';
      box.innerHTML = detailHtml(est, code);
      row.insertAdjacentElement('afterend', box);
    }
  }

  /* 删除：iOS 习惯不弹 confirm，改给 4 秒撤销 */
  let undoItem = null;
  function removeFund(code) {
    const fund = state.funds.find((f) => f.code === code);
    if (!fund) return;
    undoItem = { fund, hold: state.holds[code] || null, err: state.errs[code] || null };
    state.funds = state.funds.filter((f) => f.code !== code);
    state.open.delete(code);
    delete state.holds[code];
    delete state.errs[code];
    localStorage.removeItem(LS_HOLD(code));
    saveFunds();
    render();
    showUndo(`已移除 ${code}`, () => {
      if (!undoItem) return;
      state.funds.unshift(undoItem.fund);
      if (undoItem.hold) state.holds[code] = undoItem.hold;
      if (undoItem.err) state.errs[code] = undoItem.err;
      undoItem = null;
      saveFunds();
      render();
    });
  }

  function showUndo(text, onUndo) {
    let bar = document.getElementById('undoToast');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'undoToast';
      bar.className = 'undo-toast';
      document.body.appendChild(bar);
    }
    bar.innerHTML = `<span>${esc(text)}</span><button>撤销</button>`;
    bar.classList.add('show');
    const hide = () => { bar.classList.remove('show'); clearTimeout(bar._t); };
    bar.querySelector('button').onclick = (ev) => { ev.stopPropagation(); hide(); onUndo(); };
    clearTimeout(bar._t);
    bar._t = setTimeout(hide, 4000);
  }

  function errHtml(code) {
    const e = state.errs[code];
    if (!e) return '';
    return `<div class="errow"><span>${esc(e)}</span><button class="retry" data-retry="${code}">重试</button></div>`;
  }

  function deltaTag(est) {
    const bits = [];
    if (est.calibApplied) bits.push(`校准 ${est.calibApplied > 0 ? '+' : ''}${est.calibApplied.toFixed(2)}pp`);
    if (est.mode === 'index' && est.indexInfo) bits.push(`${est.indexInfo.name}${est.indexInfo.auto ? ' · 自动' : ''}`);
    if (est.fallback) bits.push('已回落');
    return bits.join(' · ');
  }

  function rowHtml(fund, est) {
    const hold = est.hold || state.holds[fund.code];
    const name = (hold && hold.fund_name) || fund.name
      || (state.navs[fund.code] && state.navs[fund.code].name) || fund.code;
    const kind = (hold && hold.kind) || fund.kind || 'active';
    const code = fund.code;
    const gTag = (!state.group && (fund.account || '').trim())
      ? `<span class="gbadge">${esc(fund.account)}</span>` : '';
    const open = state.open.has(code);
    const acts = `<div class="swipe-acts">
        <button class="sact edit" data-code="${code}">改</button>
        <button class="sact del" data-code="${code}">删</button>
      </div>`;

    if (!est.ready) {
      const navInfo = state.navs[code] || null;
      const isMoney = kind === 'money';
      return `<div class="srow" data-code="${code}">
        ${acts}
        <div class="sbody">
          <div class="sl1">
            <div class="nm">${esc(name)}<span class="tag ${kind}">${KIND_LABEL[kind] || kind}</span></div>
            <div class="pv">${isMoney ? '<span class="pct flat">—</span><span class="pv-d">另计</span>'
              : `<span class="pct ${cls(navInfo && navInfo.nav_chg)}">${fmtPct(navInfo && navInfo.nav_chg)}</span><span class="pv-d">昨日</span>`}</div>
          </div>
          <div class="sl2">
            <span class="code">${code}</span>${gTag}
            <span class="sep">·</span><span>净值 ${fmtNav(navInfo && navInfo.nav)}</span>
            <span class="sep">·</span><span>${isMoney ? '万份收益' : ((navInfo && navInfo.nav_date) || '—')}</span>
            <span class="sep">·</span><span class="dim">不可估</span>
          </div>
          <div class="sl3"><span class="reason">${esc(est.reason || '数据准备中')}</span></div>
          ${errHtml(code)}
        </div>
      </div>`;
    }

    const navTxt = fmtNav(est.nav.nav);
    const navDate = est.nav.nav_date || '';
    const estTxt = est.est.toFixed(4);
    const extra = deltaTag(est);
    return `<div class="srow ${open ? 'open' : ''}" data-code="${code}">
      ${acts}
      <div class="sbody">
        <div class="sl1">
          <div class="nm">${esc(name)}<span class="tag ${kind}">${KIND_LABEL[kind] || kind}</span></div>
          <div class="pv"><span class="pct ${cls(est.pct)}">${fmtPct(est.pct)}</span></div>
        </div>
        <div class="sl2">
          <span class="code">${code}</span>${gTag}
          <span class="sep">·</span><span>净值 ${navTxt}<i class="dim"> ${navDate}</i></span>
          <span class="sep">·</span><span>估值 ${estTxt}</span>
        </div>
        <div class="sl3">
          <div class="cell"><span class="k">当日</span>${(num(fund.shares) || 0) > 0
            ? `<span class="money ${cls(est.dayPnl)}">${est.dayPnl === null ? '—' : fmtMoney(est.dayPnl)}</span>`
            : `<button class="fill-mini" data-code="${code}">填份额</button>`}</div>
          <div class="cell"><span class="k">累计</span><span class="money ${cls(est.totalPnl)}">${est.totalPnl === null ? '—' : fmtMoney(est.totalPnl)}</span></div>
          <div class="cell cend">
            <span class="badge ${est.conf}">${est.conf === 'high' ? '高' : est.conf === 'mid' ? '中' : '低'}</span>
            <span class="conf-t">${esc(est.confText)}${est.hasUS ? ' · 美股延迟' : ''}</span>
          </div>
        </div>
        ${extra ? `<div class="sl4">${esc(extra)}</div>` : ''}
      </div>
    </div>`;
  }

  function detailHtml(est, code) {
    const rows = est.items.map((it) => {
      const q = quoteOf(it.symbol);
      const price = q && num(q.price) !== null ? q.price.toFixed(2) : '—';
      const pctTxt = it.pct === null ? '—' : fmtPct(it.pct);
      const contrib = it.pct === null ? 0 : (it.weight / 100) * it.pct;
      return `<tr>
        <td>${esc(it.name)}<div class="mini-sym">${esc(it.symbol)}${it.suspended ? ' <span class="susp">停牌</span>' : ''}</div></td>
        <td>${it.weight.toFixed(2)}%</td>
        <td>${price}</td>
        <td class="${cls(it.pct)}">${pctTxt}</td>
        <td class="${cls(contrib)}">${fmtPct(contrib, Math.abs(contrib) < 0.01 && contrib !== 0 ? 3 : 2)}</td>
      </tr>`;
    }).join('');
    return `<div class="detail-box">
      <div class="detail-head">
        <span>持仓期 ${est.hold.report_date || '—'}（${est.hold.report_label || '—'}） · 抓取 ${est.hold.fetched_at || '—'}</span>
        <span>${esc(est.basis)} · 覆盖 ${est.coveredCount}/${est.items.length} 只</span>
      </div>
      <div class="tbl-scroll">
      <table class="holds">
        <thead><tr><th>持仓</th><th>占净值</th><th>现价</th><th>实时涨跌</th><th>贡献</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td colspan="5">
          Σ持仓占比 ${est.wsum.toFixed(2)}% · 加权贡献 ${fmtPct(est.contrib)} ·
          ${est.normalized ? '归一化口径' : '不归一（剩余按 0）'} ·
          ${est.mode === 'index' ? '指数跟踪' : est.mode === 'official' ? '官方估值' : '持仓加权'}
          ${est.calibApplied ? ` · 校准 ${est.calibApplied > 0 ? '+' : ''}${est.calibApplied.toFixed(2)}pp（原模型 ${fmtPct(est.pctRaw)}）` : ''}
        </td></tr></tfoot>
      </table>
      </div>
      ${est.fallback ? `<p class="note-line">${esc(est.fallback)}</p>` : ''}
    </div>`;
  }

  function renderDev() {
    const body = $('#devBody');
    if (!body) return;
    const toggle = $('#calibToggle');
    if (toggle) toggle.checked = !!state.calib;

    const funds = state.group
      ? state.funds.filter((f) => groupOf(f) === state.group)
      : state.funds;

    if (!funds.length) {
      body.innerHTML = '<tr><td colspan="8" class="dim">先添加基金：收盘净值公布后会自动积累对账样本。</td></tr>';
      $('#devFoot').textContent = '';
      return;
    }

    body.innerHTML = funds.map((f) => {
      const d = state.deviations[f.code];
      const hold = state.holds[f.code];
      const name = (hold && hold.fund_name) || f.name || f.code;
      if (!d || !d.rows || !d.rows.length) {
        return `<tr class="warnrow">
          <td>${esc(name)}<div class="mini-sym">${f.code}</div></td>
          <td colspan="6" class="dim">暂无样本（等收盘净值公布后自动对账）</td>
          <td class="dim">—</td>
        </tr>`;
      }
      const last = d.rows[0];
      const st = d.stats || {};
      return `<tr>
        <td>${esc(name)}<div class="mini-sym">${f.code}</div></td>
        <td>${esc(last.date)}</td>
        <td>${fmtPct(last.est_pct)}</td>
        <td class="${cls(last.nav_pct)}">${fmtPct(last.nav_pct)}</td>
        <td class="${cls(last.diff)}">${fmtPct(last.diff)}</td>
        <td>${st.mean_diff == null ? '—' : fmtPct(st.mean_diff)}<span class="mini-sym"> n=${st.n}</span></td>
        <td>${st.mae == null ? '—' : `${st.mae.toFixed(2)}pp`}</td>
        <td>${st.ready
          ? `<strong>${st.calib > 0 ? '+' : ''}${st.calib.toFixed(2)}pp</strong>`
          : '<span class="mini-sym">样本不足</span>'}</td>
      </tr>`;
    }).join('');

    const ready = funds.filter((f) => state.deviations[f.code]
      && state.deviations[f.code].stats && state.deviations[f.code].stats.ready).length;
    $('#devFoot').textContent =
      '偏差 = 实际 − 估算（正数表示模型偏低）；校准值取近 20 日均偏差，上限 ±1.5pp，样本 ≥ 5 个交易日才生效。'
      + `当前 ${ready}/${funds.length} 只已具备校准条件。QDII 净值 T+1，偏差比对会滞后一天。`;
  }

  function renderMarket() {    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const weekday = now.getDay() >= 1 && now.getDay() <= 5;
    const aOpen = weekday && ((mins >= 570 && mins <= 690) || (mins >= 780 && mins <= 900));
    const hkOpen = weekday && ((mins >= 570 && mins <= 720) || (mins >= 780 && mins <= 960));
    const usOpen = weekday && (mins >= 1290 || mins <= 240);
    const items = [
      { k: 'A股', on: aOpen, t: '09:30-11:30 / 13:00-15:00' },
      { k: '港股', on: hkOpen, t: '09:30-12:00 / 13:00-16:00' },
      { k: '美股', on: usOpen, t: '21:30-04:00' },
    ];
    el.mkt().innerHTML = items.map((i) => `<span title="${i.t}"><i class="${i.on ? 'on' : ''}"></i>${i.k} ${i.on ? '交易中' : '休市'}</span>`).join('');
  }

  /* ----------------------------------------------------------- 交互 */
  function openEditor(code) {
    const fund = state.funds.find((f) => f.code === code);
    if (!fund) return;
    const hold = state.holds[code];
    state.editing = code;
    $('#modalTitle').textContent = `编辑 ${(hold && hold.fund_name) || code}`;
    $('#inShares').value = num(fund.shares) ? String(fund.shares) : '';
    $('#inCost').value = num(fund.cost) ? String(fund.cost) : '';
    $('#inAccount').value = fund.account || '';
    fillGroupList();
    $('#inIndex').value = fund.indexCode || '';
    const auto = indexFor(fund, hold);
    const tip = $('#inIndexTip');
    if (tip) {
      if (auto && auto.auto) {
        const hasManual = !!$('#inIndex').value.trim();
        tip.innerHTML = `留空则自动匹配：<strong>${esc(auto.name)}</strong>（${esc(auto.sym)}）`
          + (hasManual ? ' <button class="fill-link" id="useAuto">用自动匹配</button>' : '');
        const btn = $('#useAuto');
        if (btn) btn.addEventListener('click', () => {
          $('#inIndex').value = '';
          tip.innerHTML = `留空则自动匹配：<strong>${esc(auto.name)}</strong>（${esc(auto.sym)}）`;
        });
      } else if (auto) {
        tip.textContent = `当前手动指定 ${auto.sym}，清空可回到自动匹配。`;
      } else {
        tip.textContent = '未匹配到跟踪指数，可手填（如 sh000300 / sz399997 / hkHSI / usIXIC），留空则回落持仓加权。';
      }
    }
    el.modal().hidden = false;
  }

  function closeEditor() {
    el.modal().hidden = true;
    state.editing = null;
  }

  function saveEditor() {
    const code = state.editing;
    const fund = state.funds.find((f) => f.code === code);
    if (fund) {
      fund.shares = parseFloat($('#inShares').value) || 0;
      fund.cost = parseFloat($('#inCost').value) || 0;
      fund.indexCode = $('#inIndex').value.trim();
      fund.account = $('#inAccount').value.trim();
      saveFunds();
    }
    closeEditor();
    render();
  }

  /* ----------------------------------------------------------- 批量填份额 */
  function bulkName(f) {
    const hold = state.holds[f.code];
    return (hold && hold.fund_name) || f.name || f.code;
  }

  function fillGroupList() {
    const dl = $('#groupList');
    if (!dl) return;
    const names = [...new Set(state.funds.map((f) => (f.account || '').trim()).filter(Boolean))];
    dl.innerHTML = names.map((g) => `<option value="${esc(g)}"></option>`).join('');
  }

  function openBulk() {
    if (!state.funds.length) { toast('先添加基金'); return; }
    fillGroupList();
    $('#bulkBody').innerHTML = state.funds.map((f) => `<tr data-code="${f.code}">
      <td class="b-name">${esc(bulkName(f))}<div class="mini-sym">${f.code}</div></td>
      <td><input class="b-in b-shares" type="number" step="0.01" min="0" placeholder="0"
        value="${num(f.shares) ? f.shares : ''}"></td>
      <td><input class="b-in b-cost" type="number" step="0.0001" min="0" placeholder="买入均价"
        value="${num(f.cost) ? f.cost : ''}"></td>
      <td><input class="b-in b-acct" type="text" list="groupList" placeholder="未分组"
        value="${esc(f.account || '')}" spellcheck="false"></td>
    </tr>`).join('');
    $('#bulkModal').hidden = false;
    const first = $('#bulkBody').querySelector('.b-shares');
    if (first) first.focus();
  }

  function closeBulk() {
    const m = $('#bulkModal');
    if (m) m.hidden = true;
  }

  function saveBulk() {
    let changed = 0;
    $('#bulkBody').querySelectorAll('tr[data-code]').forEach((tr) => {
      const fund = state.funds.find((f) => f.code === tr.dataset.code);
      if (!fund) return;
      const s = parseFloat(tr.querySelector('.b-shares').value);
      const c = parseFloat(tr.querySelector('.b-cost').value);
      const g = tr.querySelector('.b-acct').value.trim();
      const ns = isFinite(s) && s > 0 ? s : 0;
      const nc = isFinite(c) && c > 0 ? c : 0;
      if (ns !== (num(fund.shares) || 0) || nc !== (num(fund.cost) || 0)
        || g !== (fund.account || '')) changed += 1;
      fund.shares = ns;
      fund.cost = nc;
      fund.account = g;
    });
    saveFunds();
    closeBulk();
    render();
    toast(changed ? `已保存 ${changed} 只基金的份额 / 成本` : '没有改动');
  }

  async function addFund(code) {
    code = (code || '').trim();
    if (!/^\d{6}$/.test(code)) {
      el.hint().textContent = '请输入 6 位数字代码';
      return;
    }
    if (state.funds.some((f) => f.code === code)) {
      el.hint().textContent = '已在列表里';
      return;
    }
    el.hint().textContent = '校验中…';

    // 货币/债券基金没有股票十大持仓，holdings 会失败，此时用净值兜底放行；
    // 但网络/原生通道类失败要记成异常，保留重试能力，不能当成「本来就没持仓」
    let hold = null;
    let holdErr = '';
    try {
      hold = await ensureHoldings(code);
    } catch (err) {
      holdErr = (err && err.message) || String(err);
    }
    const noStock = !hold && /未解析到持仓数据|无股票持仓|没有股票|不存在/i.test(holdErr);

    let navInfo = null;
    try {
      if (DIRECT) {
        const r = await window.FundDirect.navs([code]);
        navInfo = r && r.items ? r.items[code] : null;
      } else {
        const navRes = await api('nav', { codes: code });
        navInfo = navRes && navRes.items ? navRes.items[code] : null;
      }
    } catch (_) { navInfo = null; }

    if (!hold && !navInfo) {
      el.hint().textContent = '添加失败：代码无效或接口暂时不可用';
      return;
    }

    let displayName = hold ? hold.fund_name : '';
    let kind = hold ? hold.kind : 'bond';
    if (!hold) {
      try {
        const nres = DIRECT ? await window.FundDirect.name(code) : await api('name', { code });
        if (nres && nres.name) {
          displayName = nres.name;
          kind = (DIRECT && window.FundDirect.guessKind)
            ? window.FundDirect.guessKind(nres.name, [])
            : (/货币/.test(nres.name) ? 'money' : /债/.test(nres.name) ? 'bond' : 'active');
        }
      } catch (_) { /* 名字取不到就显示代码 */ }
    }

    state.funds.push({
      code, shares: 0, cost: 0, indexCode: '',
      noHoldings: noStock, name: displayName, kind,
    });
    if (holdErr && !noStock) state.errs[code] = holdErr;
    saveFunds();
    el.hint().textContent = '';
    el.addInput().value = '';
    await refresh(false);
    if (hold) toast(`已添加 ${displayName || code}`);
    else if (noStock) toast(`已添加 ${displayName || code}（无股票持仓，无法估算）`);
    else toast(`已添加 ${displayName || code}（持仓取不到，可点行内重试）`, 2600);
  }

  function bind() {
    el.seg().addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-mode]');
      if (!btn) return;
      state.mode = btn.dataset.mode;
      saveSettings();
      render();
    });
    $('#intervalSel').addEventListener('change', (ev) => {
      state.interval = parseInt(ev.target.value, 10) || 30;
      state.left = state.interval;
      saveSettings();
      render();
    });
    $('#refreshBtn').addEventListener('click', () => refresh(true));
    const bulkBtn = $('#bulkBtn');
    if (bulkBtn) bulkBtn.addEventListener('click', openBulk);
    const toSenti = $('#toSenti');
    if (toSenti) {
      toSenti.addEventListener('click', (ev) => {
        ev.preventDefault();
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'app-tab', tab: 'senti' }, '*');
            return;
          }
        } catch (_) { /* 跨域忽略 */ }
        location.href = 'index.html';
      });
    }
    const svcBtn = $('#svcBtn');
    if (svcBtn) {
      svcBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        // App 内：交给原生弹窗（系统导航栏已隐藏，这里是唯一入口）
        try {
          if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.appUI) {
            window.webkit.messageHandlers.appUI.postMessage({ action: 'server' });
            return;
          }
        } catch (_) { /* 忽略 */ }
        // Android 壳：原生直连公开接口，没有服务地址可填
        if (window.AshareNative && window.AshareNative.post) {
          toast('已内置直连数据源，无需填写服务地址');
          return;
        }
        // 桌面版 / 同源 http：内嵌服务已在跑，不需要地址
        if (location.protocol !== 'file:') {
          toast('正在使用内置数据服务，无需填写地址');
          return;
        }
        const cur = (function () { try { return localStorage.getItem('apiBase') || ''; } catch (e) { return ''; } })();
        const v = window.prompt('数据服务地址（留空 = App 内直连公开接口，不依赖电脑）', cur);
        if (v === null) return;
        try {
          if (v.trim()) localStorage.setItem('apiBase', v.trim());
          else localStorage.removeItem('apiBase');
        } catch (e) { /* 忽略 */ }
        location.reload();
      });
    }
    const calib = $('#calibToggle');
    if (calib) {
      calib.addEventListener('change', (ev) => {
        state.calib = ev.target.checked;
        saveSettings();
        render();
        toast(state.calib ? '已开启偏差校准（样本不足的基金不受影响）' : '已关闭偏差校准');
      });
    }
    $('#addBtn').addEventListener('click', () => addFund(el.addInput().value));
    el.addInput().addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') addFund(el.addInput().value);
    });
    $('#demoBtn').addEventListener('click', async () => {
      for (const code of DEMO_CODES) {
        if (!state.funds.some((f) => f.code === code)) {
          // eslint-disable-next-line no-await-in-loop
          await addFund(code);
        }
      }
    });
    $('#modalCancel').addEventListener('click', closeEditor);
    $('#modalSave').addEventListener('click', saveEditor);
    el.modal().addEventListener('click', (ev) => {
      if (ev.target === el.modal()) closeEditor();
    });
    $('#bulkCancel').addEventListener('click', closeBulk);
    $('#bulkSave').addEventListener('click', saveBulk);
    $('#bulkModal').addEventListener('click', (ev) => {
      if (ev.target === $('#bulkModal')) closeBulk();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) state.left = state.interval;
    });
  }

  function tick() {
    if (document.hidden) return;
    state.left -= 1;
    if (state.left <= 0) {
      state.left = state.interval;
      refresh(false);
      return;
    }
    el.countdown().textContent = `${state.left}s`;
  }

  async function boot() {
    loadLocal();
    const params = new URLSearchParams(location.search);
    if (params.get('mode')) state.mode = params.get('mode');
    if (params.get('expand')) state.open.add(params.get('expand'));

    // App 壳里跑时，把数据服务来源明确标出来；没配地址就直接提示
    const tag = $('#apiTag');
    if (tag) {
      tag.textContent = API_BASE
        ? `服务 ${API_BASE.replace(/^https?:\/\//, '')}`
        : (DIRECT ? '本机直连' : (FILE_MODE ? '未配置服务' : '同源服务'));
      tag.classList.toggle('bad', FILE_MODE && !API_BASE && !DIRECT);
    }
    if (FILE_MODE && !API_BASE && !DIRECT) {
      const banner = $('#fileBanner');
      if (banner) banner.hidden = false;
    }

    bind();
    render();
    refresh(false);
    setInterval(tick, 1000);
    // 首次体验：?demo=1 且列表为空时自动装入示例基金（等它装完再继续，避免后续 deep link 抢跑）
    if (/[?&]demo=1/.test(location.search) && !state.funds.length) {
      for (const code of DEMO_CODES) {
        if (!state.funds.some((f) => f.code === code)) await addFund(code);
      }
    }
    // 深链：?add=000198,110022 直接添加基金
    const addCodes = params.getAll('add').join(',').split(',').filter(Boolean);
    for (const c of addCodes) await addFund(c);
    // 调试/深链：?bulk=1 打开批量填份额，?edit=<code> 打开编辑弹窗
    if (params.get('bulk') === '1') openBulk();
    if (params.get('edit')) openEditor(params.get('edit'));
  }

  boot();
})();
