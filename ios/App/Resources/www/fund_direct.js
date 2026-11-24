/* 基金直连数据层（App 内脱机模式）
 * 浏览器里能拿的：净值/名称/历史涨跌（pingzhongdata 的 script 变量）
 *                实时行情（qt.gtimg.cn，GBK）
 * 浏览器拿不到的：前十大持仓（服务端校验 Referer）→ 由 iOS 原生通道代抓
 * 输出结构与 server.py 的 /api/fund/* 保持一致，页面无需区分来源。
 */
(() => {
  'use strict';

  const seq = { n: 0 };
  let queue = Promise.resolve();          // 所有 script 加载串行，避免全局变量互相覆盖
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  function loadScript(url, charset) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      if (charset) s.charset = charset;
      s.async = true;
      const done = (ok) => {
        s.onload = s.onerror = null;
        s.remove();
        if (ok) resolve(); else reject(new Error('数据源加载失败'));
      };
      s.onload = () => done(true);
      s.onerror = () => done(false);
      document.head.appendChild(s);
      setTimeout(() => { if (s.parentNode) done(false); }, 18000);
    });
  }

  /* ---------------------------------------------------- 原生通道 */
  function hasBridge() {
    return !!(window.AshareNative && window.AshareNative.post)
      || !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.fundFetch);
  }

  function bridgeFetch(url, referer) {
    return new Promise((resolve, reject) => {
      if (window.__FUND_NATIVE_MOCK__) {   // 测试用：本地注入假原生通道
        Promise.resolve(window.__FUND_NATIVE_MOCK__(url, referer)).then(resolve, reject);
        return;
      }
      if (!hasBridge()) { reject(new Error('当前环境没有原生代理通道')); return; }
      const id = `r${seq.n += 1}`;
      window.__fundFetchReply = window.__fundFetchReply || {};
      window.__fundFetchReply[id] = (payload) => {
        delete window.__fundFetchReply[id];
        resolve(payload || { ok: false });
      };
      try {
        if (window.AshareNative && window.AshareNative.post) {
          window.AshareNative.post(JSON.stringify({ id, url, referer: referer || '' }));
        } else {
          window.webkit.messageHandlers.fundFetch.postMessage({ id, url, referer });
        }
      } catch (err) {
        delete window.__fundFetchReply[id];
        reject(new Error(`原生通道调用失败：${err.message}`));
        return;
      }
      setTimeout(() => {
        if (window.__fundFetchReply[id]) {
          delete window.__fundFetchReply[id];
          reject(new Error('原生请求超时'));
        }
      }, 22000);
    });
  }

  /* ---------------------------------------------------- 行情 */
  function parseQuote(sym, raw) {
    if (!raw) return null;
    const f = raw.split('~');
    const price = parseFloat(f[3]);
    const prev = parseFloat(f[4]);
    if (!isFinite(price) || !isFinite(prev) || price <= 0) {
      return { symbol: sym, name: f[1] || '', price: null, prev: null, pct: null, suspended: true };
    }
    const pct = f[32] !== undefined && f[32] !== '' ? parseFloat(f[32]) : ((price - prev) / prev) * 100;
    return {
      symbol: sym,
      name: f[1] || '',
      price,
      prev,
      pct: isFinite(pct) ? pct : null,
      time: f[30] || '',
      suspended: false,
    };
  }

  async function quotes(symbols) {
    const uniq = [...new Set(symbols.filter(Boolean))];
    const out = {};
    const missing = [];
    for (let i = 0; i < uniq.length; i += 40) {
      const chunk = uniq.slice(i, i + 40);
      try {
        await serial(() => loadScript(`https://qt.gtimg.cn/q=${chunk.join(',')}&_=${Date.now()}`, 'gbk'));
      } catch (_) { /* 单批失败不阻塞其它 */ }
      chunk.forEach((sym) => {
        const q = parseQuote(sym, window[`v_${sym}`]);
        if (q && q.pct !== null) out[sym] = q;
        else missing.push(sym);
      });
    }
    return { ok: true, quotes: out, missing };
  }

  /* ---------------------------------------------------- 净值/名称/历史 */
  const metaCache = {};   // code -> { ts, name, trend: [{ date, nav, pct, acc }] }
  const META_TTL = 5 * 60 * 1000;

  const pad = (n) => String(n).padStart(2, '0');
  function dayStr(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  async function meta(code) {
    const hit = metaCache[code];
    if (hit && Date.now() - hit.ts < META_TTL) return hit;
    window.fS_name = undefined;
    window.fS_code = undefined;
    window.Data_netWorthTrend = undefined;   // 不能 delete：var 声明的全局属性删不掉，严格模式会抛 TypeError
    window.Data_millionCopiesIncome = undefined;   // 货币基金的万份收益序列
    window.Data_sevenDaysYearIncome = undefined;
    await serial(() => loadScript(`https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`));
    if (window.fS_code && String(window.fS_code) !== String(code) && !window.fS_name) return null;
    const trend = (window.Data_netWorthTrend || []).map((p) => ({
      date: dayStr(p.x),
      nav: typeof p.y === 'number' ? p.y : parseFloat(p.y),
      pct: typeof p.equityReturn === 'number' ? p.equityReturn : parseFloat(p.equityReturn),
    })).filter((p) => isFinite(p.nav));
    if (!trend.length) {
      // 货币基金没有净值曲线，只有「万份收益」，界面按万份收益展示、不参与估值
      const million = (window.Data_millionCopiesIncome || [])
        .filter((p) => Array.isArray(p) && isFinite(p[1]));
      if (million.length) {
        const last = million[million.length - 1];
        const data = {
          ts: Date.now(),
          name: window.fS_name || '',
          trend: [],
          money: { date: dayStr(last[0]), value: last[1] },
        };
        metaCache[code] = data;
        return data;
      }
      return null;
    }
    const data = { ts: Date.now(), name: window.fS_name || '', trend };
    metaCache[code] = data;
    return data;
  }

  async function navs(codes) {
    const items = {};
    const failed = [];
    for (const code of codes) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const m = await meta(code);
        if (!m) { failed.push(code); continue; }
        if (m.money) {
          items[code] = {
            code,
            name: m.name,
            nav: m.money.value,
            nav_date: m.money.date,
            nav_chg: 0,
            acc_nav: '',
            gz: null,
            gz_pct: null,
            gz_time: null,
            money: true,
          };
          continue;
        }
        const last = m.trend[m.trend.length - 1];
        items[code] = {
          code,
          name: m.name,
          nav: last.nav,
          nav_date: last.date,
          nav_chg: isFinite(last.pct) ? last.pct : 0,
          acc_nav: '',
          gz: null,
          gz_pct: null,
          gz_time: null,
        };
      } catch (_) { failed.push(code); }
    }
    return { ok: true, items, failed };
  }

  async function name(code) {
    try {
      const m = await meta(code);
      return { ok: !!m, code, name: m ? m.name : '' };
    } catch (_) {
      return { ok: false, code, name: '' };
    }
  }

  /* ---------------------------------------------------- 持仓（原生代抓 + 本地解析） */
  const MARKET_PREFIX = { 1: 'sh', 0: 'sz', 116: 'hk' };
  function symbolOf(market, code) {
    const mkt = Number(market);
    if (mkt === 116) return `hk${String(code).padStart(5, '0')}`;
    if (mkt === 105 || mkt === 106 || mkt === 107) return `us${String(code).toUpperCase()}`;
    if (mkt === 0) {
      const c = String(code);
      if (c.startsWith('4') || c.startsWith('8')) return `bj${c}`;
      return `sz${c}`;
    }
    return `${MARKET_PREFIX[mkt] || 'sh'}${code}`;
  }

  function guessKind(fundName, items) {
    const n = fundName || '';
    if (/ETF联接|联接基金|联接/.test(n)) return 'link';
    if (/ETF/.test(n)) return 'etf';
    if (/指数|LOF/i.test(n)) return 'index';
    if (/QDII|全球|海外|美元|纳斯达克|标普|恒生/.test(n)) return 'qdii';
    if (/货币/.test(n)) return 'money';
    if (/债/.test(n)) return 'bond';
    if (items.length === 1) return 'link';
    return 'active';
  }

  function decodeContent(raw) {
    // 形如 var apidata={ content:"<div ...>",arryear:[...],curyear:2026};
    const m = raw.match(/content:"([\s\S]*?)",arryear/);
    if (!m) return '';
    return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\'/g, "'");
  }

  function parseHoldings(code, raw) {
    const html = decodeContent(raw);
    if (!html) throw new Error('未解析到持仓数据');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table.tzxq') || doc.querySelector('table');
    if (!table) throw new Error('持仓表格缺失');

    const titleText = (doc.querySelector('h4.t label.left') || {}).textContent || '';
    const dateMatch = titleText.match(/(\d{4})年([\d.]*?)(季度|中期|半年度|年度|年报|半年报)/);
    const fundNameMatch = titleText.match(/^(.+?)\s*[\d]{4}年/);
    let fundName = fundNameMatch ? fundNameMatch[1].replace(/^\s*|\s*$/g, '') : '';
    let label = '';
    if (dateMatch) {
      const q = dateMatch[2].replace('.', '');
      const suffix = dateMatch[3];
      label = suffix === '季度' ? `${dateMatch[1]}年${q}季度`
        : `${dateMatch[1]}年${suffix}`;
    }
    const cut = html.match(/截止至：?[\s\S]*?<font[^>]*>(\d{4}-\d{2}-\d{2})/);
    const reportDate = cut ? cut[1] : '';

    const items = [];
    table.querySelectorAll('tr').forEach((tr) => {
      const cells = tr.querySelectorAll('td');
      if (cells.length < 7) return;
      const codeCell = cells[1].querySelector('a');
      const nameCell = cells[2].querySelector('a') || cells[2];
      if (!codeCell) return;
      const href = codeCell.getAttribute('href') || '';
      const hit = href.match(/unify\/r\/(\d+)\.(\w+)/);
      const stockCode = hit ? hit[2] : codeCell.textContent.trim();
      const market = hit ? hit[1] : '1';
      const weight = parseFloat((cells[6].textContent || '').replace('%', '').trim());
      if (!stockCode || !isFinite(weight)) return;
      items.push({
        symbol: symbolOf(market, stockCode),
        code: stockCode,
        market: String(market),
        name: (nameCell.textContent || '').replace(/\s+/g, '').replace(/\*/g, ''),
        weight,
      });
    });
    if (!items.length) throw new Error('未解析到持仓数据');

    const sum_weight = items.reduce((s, it) => s + it.weight, 0);
    const single_etf = items.length === 1 && /ETF/.test(items[0].name);
    return {
      ok: true,
      code,
      fund_name: fundName,
      kind: guessKind(fundName, items),
      report_date: reportDate,
      report_label: label,
      items,
      sum_weight: Math.round(sum_weight * 100) / 100,
      single_etf,
      fetched_at: new Date().toLocaleString('zh-CN', { hour12: false }),
      cached: false,
    };
  }

  async function holdings(code) {
    const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10&rt=${Math.random()}`;
    const payload = await bridgeFetch(url, `https://fundf10.eastmoney.com/ccmx_${code}.html`);
    if (!payload || !payload.ok) throw new Error(payload && payload.error ? payload.error : '持仓请求失败');
    return parseHoldings(code, payload.body);
  }

  /* ---------------------------------------------------- 收盘对账（本地快照） */
  const SNAP_KEY = 'fund.panel.snap.v1';
  const MAX_DAYS = 90;

  function readSnaps() {
    try {
      const o = JSON.parse(localStorage.getItem(SNAP_KEY) || '{}');
      return o && typeof o === 'object' ? o : {};
    } catch (_) { return {}; }
  }

  function saveSnapshots(items) {
    const all = readSnaps();
    const today = dayStr(Date.now());
    items.forEach((it) => {
      all[it.code] = all[it.code] || {};
      all[it.code][today] = {
        est_pct: it.pct, est: it.est, nav_date: it.nav_date, mode: it.mode,
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5),
      };
      const days = Object.keys(all[it.code]).sort();
      while (days.length > MAX_DAYS) delete all[it.code][days.shift()];
    });
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(all)); } catch (_) { /* ignore */ }
    return { ok: true, saved: items.length };
  }

  async function deviation(code, days) {
    const all = readSnaps();
    const snaps = all[code] || {};
    let m = null;
    try { m = await meta(code); } catch (_) { m = null; }
    const rows = [];
    if (m) {
      const byDate = {};
      m.trend.forEach((p) => { byDate[p.date] = p.pct; });
      Object.entries(snaps).forEach(([day, s]) => {
        const navPct = byDate[day];
        if (!isFinite(navPct) || !isFinite(s.est_pct)) return;
        rows.push({
          date: day, nav_pct: navPct, est_pct: s.est_pct,
          diff: Math.round((navPct - s.est_pct) * 100) / 100, at: s.at || '',
        });
      });
      rows.sort((a, b) => (a.date < b.date ? 1 : -1));
    }
    const use = rows.slice(0, days || 20);
    const n = use.length;
    const mean = n ? use.reduce((s, r) => s + r.diff, 0) / n : null;
    const mae = n ? use.reduce((s, r) => s + Math.abs(r.diff), 0) / n : null;
    const sorted = [...use].map((r) => r.diff).sort((a, b) => a - b);
    const median = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null;
    const calib = mean === null ? 0 : Math.max(-1.5, Math.min(1.5, mean));
    return {
      ok: true, code, rows: use, days: days || 20, cap: 1.5,
      stats: {
        n,
        mean_diff: mean === null ? null : Math.round(mean * 100) / 100,
        mae: mae === null ? null : Math.round(mae * 100) / 100,
        median_diff: median === null ? null : Math.round(median * 100) / 100,
        calib: Math.round(calib * 100) / 100,
        ready: n >= 5,
      },
    };
  }

  window.FundDirect = {
    available: () => true,
    hasBridge,
    quotes,
    navs,
    name,
    holdings,
    deviation,
    saveSnapshots,
    parseHoldings,   // 供自测
    guessKind,
    _meta: meta,
  };
})();
