/* A股情绪监测 · 实时前端
   两种数据模式：
   1) server  —— 同源/自填地址的 Python 服务（Windows 本地，稳定、无跨域风险）
   2) direct  —— 浏览器 JSONP 直连东方财富公开接口（iPhone / iOS 壳独立运行）
   服务不可用时自动切换到 direct，两端都是「实时取数」而非静态数据。
*/
const CFG = {
  UT: "bd1d9ddb04089700cf9c27f6f7426281",
  UT_EX: "7eea3edcaed734bea9cbfc24409ed989",
  HOSTS: ["push2.eastmoney.com", "push2delay.eastmoney.com", "82.push2.eastmoney.com"],
  FS_HS: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",
  FS_ALL: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
  weights: { zt_count: 0.20, zt_ratio: 0.15, max_board: 0.20,
             promote_1to2: 0.20, zhaban_neg: 0.15, high_feedback: 0.10 },
  caps: { zt_count: 120, zt_ratio: 0.05, max_board: 8,
          promote_1to2: 0.50, zhaban_neg: 0.60, high_feedback: 0.60 },
  labels: { zt_count: "涨停家数", zt_ratio: "涨停占比", max_board: "最高连板",
            promote_1to2: "一进二晋级率", zhaban_neg: "炸板率(负向)", high_feedback: "高位股反馈" }
};

const state = { mode: "server", auto: true, interval: 30, left: 30, busy: false, data: null, seq: 0,
                quoteCache: null, prevCache: null, badHosts: {} };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (v, d = 2) => v == null ? "—" : (v * 100).toFixed(d) + "%";
const num = (v, d = 2) => v == null ? "—" : Number(v).toFixed(d);
const fmtInt = (v) => v == null ? "—" : Number(v).toLocaleString("zh-CN");

/* ---------------------------------------------------------- 数据地址 */
function apiBase() {
  const q = new URLSearchParams(location.search).get("api");
  return q || localStorage.getItem("apiBase") || "";
}
function serverUrl(force) {
  const b = apiBase().replace(/\/+$/, "");
  return (b ? b : "") + "/api/snapshot" + (force ? "?force=1" : "");
}

/* ---------------------------------------------------------- JSONP */
function qs(params) {
  return Object.keys(params).map((k) => k + "=" + encodeURIComponent(params[k])
    .replace(/%3A/g, ":").replace(/%2C/g, ",").replace(/%2B/g, "+")).join("&");
}
function jsonp(url, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const cb = "__emcb_" + (++state.seq) + "_" + Date.now();
    const s = document.createElement("script");
    const done = (fn, val) => {
      clearTimeout(timer);
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      if (s.parentNode) s.parentNode.removeChild(s);
      fn(val);
    };
    const timer = setTimeout(() => done(reject, new Error("timeout")), timeout);
    window[cb] = (data) => done(resolve, data);
    s.onerror = () => done(reject, new Error("network"));
    s.src = url + (url.indexOf("?") >= 0 ? "&" : "?") + "cb=" + cb;
    document.head.appendChild(s);
  });
}
async function poolGet(ep, date) {
  const url = "https://push2ex.eastmoney.com/" + ep + "?" + qs({
    ut: CFG.UT_EX, dpt: "wz.ztzt", Pageindex: 0, pagesize: 400, sort: "fbt:asc", date: date
  });
  const j = await jsonp(url);
  const d = j.data || {};
  return { tc: d.tc || 0, pool: d.pool || [], qdate: d.qdate };
}
function clistParams(pn, pz) {
  return { pn: pn, pz: pz, po: 1, np: 1, ut: CFG.UT, fltt: 2, invt: 2,
           fid: "f3", fs: CFG.FS_ALL, fields: "f2,f3,f6,f12,f13,f14" };
}
async function fetchQuotes() {
  for (const host of CFG.HOSTS) {
    if ((state.badHosts[host] || 0) > Date.now()) continue;
    try {
      const j = await jsonp("https://" + host + "/api/qt/clist/get?" + qs(clistParams(1, 6000)), 3500);
      const d = j.data || {};
      const rows = d.diff || [];
      if (d.total > 1000 && rows.length >= d.total * 0.9) return { rows: rows, host: host, mode: "单次全量" };
      if (host === "push2delay.eastmoney.com") break;  // 该主机每页上限 100，直接转分页
    } catch (e) {
      state.badHosts[host] = Date.now() + 180000;    // 3 分钟内不再探测该主机
    }
  }
  const host = "push2delay.eastmoney.com";
  const first = await jsonp("https://" + host + "/api/qt/clist/get?" + qs(clistParams(1, 100)), 8000);
  const total = (first.data || {}).total || 0;
  const rows = ((first.data || {}).diff || []).slice();
  const pages = Math.ceil(total / 100);
  const tasks = [];
  for (let p = 2; p <= pages; p++) tasks.push(p);
  for (let i = 0; i < tasks.length; i += 12) {
    const batch = tasks.slice(i, i + 12);
    const res = await Promise.allSettled(batch.map((p) =>
      jsonp("https://" + host + "/api/qt/clist/get?" + qs(clistParams(p, 100)), 8000)));
    res.forEach((r) => {
      if (r.status === "fulfilled") rows.push.apply(rows, ((r.value.data || {}).diff || []));
    });
  }
  const seen = new Set(); const uniq = [];
  rows.forEach((r) => {
    const k = r.f12 + "_" + r.f13;
    if (!seen.has(k)) { seen.add(k); uniq.push(r); }
  });
  if (!total || uniq.length < total * 0.5) throw new Error("全市场行情覆盖不足，涨跌家数不可用");
  return { rows: uniq, host: host, mode: "分页 " + pages + " 页" };
}
/* ---------------------------------------------------- iOS 原生代抓桥（可选）
   壳内 window.webkit.messageHandlers.fundFetch 可代抓白名单 URL，不受跨域限制。
   东财 clist 被限流时，改由原生代抓新浪全市场全量分页，家数不估算、不填 0。 */
function hasBridge() {
  try {
    return !!(window.AshareNative && window.AshareNative.post)
      || !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.fundFetch);
  } catch (e) { return false; }
}
let bridgeSeq = 0;
function bridgeGet(url, referer) {
  return new Promise((resolve, reject) => {
    const id = "bg_" + (++bridgeSeq) + "_" + Date.now();
    const reply = window.__fundFetchReply = window.__fundFetchReply || {};
    const timer = setTimeout(() => {
      try { delete reply[id]; } catch (e) {}
      reject(new Error("原生代抓超时"));
    }, 20000);
    reply[id] = (r) => {
      clearTimeout(timer);
      try { delete reply[id]; } catch (e) {}
      if (!r || !r.ok) { reject(new Error((r && r.error) || "原生代抓失败")); return; }
      resolve(r.body);
    };
    try {
      if (window.AshareNative && window.AshareNative.post) {
        window.AshareNative.post(JSON.stringify({ id: id, url: url, referer: referer || "" }));
      } else {
        window.webkit.messageHandlers.fundFetch.postMessage({ id: id, url: url, referer: referer || "" });
      }
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}
async function fetchQuotesViaBridge() {
  const REF = "https://vip.stock.finance.sina.com.cn/";
  const base = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/";
  const cnt = await bridgeGet(base + "Market_Center.getHQNodeStockCount?node=hs_a", REF);
  const total = parseInt(String(cnt).replace(/[^0-9]/g, ""), 10) || 0;
  if (!total) throw new Error("新浪全市场家数返回异常");
  const pages = Math.ceil(total / 100);
  const rows = [];
  const bad = [];
  const one = async (p) => {
    const txt = await bridgeGet(base + "Market_Center.getHQNodeData?page=" + p +
      "&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page", REF);
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) throw new Error("分页返回非数组");
    return arr;
  };
  for (let i = 1; i <= pages; i += 8) {
    const batch = [];
    for (let p = i; p < Math.min(i + 8, pages + 1); p++) batch.push(p);
    const res = await Promise.allSettled(batch.map(one));
    res.forEach((r, k) => {
      if (r.status === "fulfilled") rows.push.apply(rows, r.value);
      else bad.push(batch[k]);
    });
  }
  for (const p of bad) {                     // 失败页串行补拉一次
    try { rows.push.apply(rows, await one(p)); } catch (e) { /* 该页确实拿不到 */ }
  }
  const seen = new Set();
  const uniq = [];
  rows.forEach((r) => {
    const k = r.symbol || r.code;
    if (!k || seen.has(k)) return;
    seen.add(k);
    const price = Number(r.trade);
    const chg = Number(r.changepercent);
    uniq.push({
      f12: r.code,
      f13: /^(6|9)/.test(String(r.code || "")) ? 1 : 0,
      f14: r.name,
      f2: isFinite(price) ? price : 0,
      f3: (price === 0 || !isFinite(chg)) ? null : chg,
      f6: Number(r.amount) || 0
    });
  });
  if (!uniq.length || uniq.length < total * 0.9) {
    throw new Error("新浪全市场覆盖不足（" + uniq.length + "/" + total + "）");
  }
  return { rows: uniq, host: "vip.stock.finance.sina.com.cn", mode: "原生桥全量 " + pages + " 页" };
}
async function fetchQuotesSafe() {
  try {
    return await fetchQuotes();
  } catch (e) {
    if (!hasBridge()) throw e;
    try {
      return await fetchQuotesViaBridge();
    } catch (e2) {
      throw new Error(e.message + "；原生新浪兜底亦失败：" + e2.message);
    }
  }
}
async function fetchIndices() {
  const params = { fltt: 2, invt: 2, ut: CFG.UT,
    secids: "1.000001,0.399001,0.399006,1.000688,0.899050",
    fields: "f2,f3,f4,f6,f12,f13,f14" };
  for (const host of CFG.HOSTS) {
    try {
      const j = await jsonp("https://" + host + "/api/qt/ulist.np/get?" + qs(params), 5000);
      const diff = (j.data || {}).diff || [];
      if (diff.length) return { rows: diff, host: host };
    } catch (e) { /* 继续 */ }
  }
  return { rows: [], host: null };
}
function bjDate() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
}
function dateStr(d) {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}
function marketStatus(d) {
  if (d.getDay() === 0 || d.getDay() === 6) return "休市";
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  if (hm >= "09:15" && hm < "09:30") return "集合竞价";
  if ((hm >= "09:30" && hm < "11:30") || (hm >= "13:00" && hm < "15:00")) return "盘中";
  if (hm >= "15:00") return "已收盘";
  return "盘前";
}
async function findPrevPool(today) {
  const base = new Date(today.slice(0, 4) + "-" + today.slice(4, 6) + "-" + today.slice(6, 8));
  for (let i = 1; i <= 10; i++) {
    const d = new Date(base.getTime() - i * 86400000);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    try {
      const r = await poolGet("getTopicZTPool", dateStr(d));
      if (r.tc > 0 && r.pool.length) return { date: dateStr(d), total: r.tc, pool: r.pool };
    } catch (e) { /* 继续回退 */ }
  }
  return { date: null, total: 0, pool: [] };
}

/* ---------------------------------------------------------- 聚合（与服务端同口径） */
const isST = (n) => String(n || "").toUpperCase().indexOf("ST") >= 0;
const isBJ = (c) => /^(8|4|92)/.test(String(c || ""));
const fmtSeal = (v) => { const s = String(Math.round(v || 0)).padStart(6, "0"); return s.slice(0, 2) + ":" + s.slice(2, 4) + ":" + s.slice(4, 6); };

function aggregate(raw, elapsed) {
  const warnings = (raw.warnings || []).slice();
  const now = bjDate();
  const quotes = raw.quotes.rows || [];
  const numeric = quotes.filter((r) => typeof r.f3 === "number");
  const hasBreadth = quotes.length > 0;
  const up = hasBreadth ? numeric.filter((r) => r.f3 > 0).length : null;
  const down = hasBreadth ? numeric.filter((r) => r.f3 < 0).length : null;
  const flat = hasBreadth ? numeric.filter((r) => r.f3 === 0).length : null;
  const suspended = hasBreadth ? quotes.length - numeric.length : null;
  if (!hasBreadth) warnings.push("全市场行情接口不可用，涨跌家数与涨停占比暂缺（显示 —，不填 0）");

  const idx = {};
  raw.indices.rows.forEach((r) => { idx[String(r.f12)] = r; });
  const amt = (c) => typeof (idx[c] || {}).f6 === "number" ? idx[c].f6 : 0;
  const sh = amt("000001"), sz = amt("399001"), bj = amt("899050");

  const ztPool = raw.zt.pool || [];
  const clean = ztPool.filter((r) => !isST(r.n) && !isBJ(r.c));
  const prevClean = (raw.prev.pool || []).filter((r) => !isST(r.n) && !isBJ(r.c));
  const lbc = (r) => Math.round(r.lbc || 1);
  const t2 = clean.filter((r) => lbc(r) === 2).length;
  const t3 = clean.filter((r) => lbc(r) === 3).length;
  const t4 = clean.filter((r) => lbc(r) >= 4).length;
  const y1 = prevClean.filter((r) => lbc(r) === 1).length;
  const y2 = prevClean.filter((r) => lbc(r) === 2).length;
  const y3 = prevClean.filter((r) => lbc(r) >= 3).length;

  const ztTotal = raw.zt.tc || 0;
  const zbTotal = raw.zb.tc || 0;
  const touch = ztTotal + zbTotal;
  const zhaban = touch ? zbTotal / touch : null;
  const p12 = y1 ? t2 / y1 : null;
  const p23 = y2 ? t3 / y2 : null;
  const highFb = y3 ? t4 / y3 : null;
  const maxBoard = clean.reduce((mx, r) => Math.max(mx, lbc(r)), 0);
  const ztRatio = up ? ztTotal / up : null;

  const metrics = { zt_count: ztTotal, zt_ratio: ztRatio, max_board: maxBoard,
                    promote_1to2: p12, zhaban_neg: zhaban, high_feedback: highFb };
  const weights = (raw.config && raw.config.weights) || CFG.weights;
  const caps = (raw.config && raw.config.caps) || CFG.caps;
  let score = 0;
  const factors = Object.keys(weights).map((k) => {
    const rawVal = metrics[k];
    if (rawVal == null) return { key: k, name: CFG.labels[k], weight: weights[k], raw: null, sub: null, contrib: null };
    const base = k === "zhaban_neg" ? 1 - rawVal : rawVal;
    const sub = Math.max(0, Math.min(100, base / (caps[k] || 1) * 100));
    const contrib = Math.round(sub * weights[k] * 100) / 100;
    score += contrib;
    return { key: k, name: CFG.labels[k], weight: weights[k],
             raw: Math.round(rawVal * 1e6) / 1e6, sub: Math.round(sub * 10) / 10, contrib: contrib };
  });

  const groups = {};
  clean.forEach((r) => { (groups[lbc(r)] = groups[lbc(r)] || []).push(r); });
  const ladder = Object.keys(groups).map(Number).sort((a, b) => b - a).map((board) => ({
    board: board, count: groups[board].length,
    rows: groups[board].sort((a, b) => (a.fbt || 0) - (b.fbt || 0)).map((r) => {
      const z = r.zttj || {};
      return { name: r.n, code: r.c, chg: Math.round((r.zdp || 0) * 100) / 100,
               price: Math.round((r.p || 0) / 10) / 100, seal: fmtSeal(r.fbt),
               broken: r.zbc || 0, stat: (z.days == null ? "-" : z.days) + "/" + (z.ct == null ? "-" : z.ct),
               turnover: Math.round((r.hs || 0) * 100) / 100, industry: r.hybk || "—" };
    })
  }));

  const cnt = {};
  clean.forEach((r) => { const k = r.hybk || "—"; cnt[k] = (cnt[k] || 0) + 1; });
  const industries = Object.keys(cnt).map((k) => ({ name: k, count: cnt[k] }))
    .sort((a, b) => b.count - a.count).slice(0, 8);

  return {
    ok: true,
    generated_at: now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" +
      String(now.getDate()).padStart(2, "0") + " " + String(now.getHours()).padStart(2, "0") + ":" +
      String(now.getMinutes()).padStart(2, "0") + ":" + String(now.getSeconds()).padStart(2, "0"),
    trade_date: String(raw.zt.qdate || raw.today),
    market_status: marketStatus(now),
    market: { up: up, down: down, flat: flat, suspended: suspended, quote_count: quotes.length,
              zt_total: ztTotal, zt_filtered: clean.length, dt_total: raw.dt.tc || 0,
              zb_total: zbTotal, touch_total: touch, zhaban_rate: zhaban,
              promote_1to2: p12, promote_2to3: p23, high_feedback: highFb,
              max_board: maxBoard, zt_ratio: ztRatio,
              amount_hs_yi: Math.round((sh + sz) / 1e8 * 100) / 100,
              amount_hsbj_yi: Math.round((sh + sz + bj) / 1e8 * 100) / 100,
              prev_date: raw.prev.date, prev_zt_total: raw.prev.total },
    indices: raw.indices.rows.filter((r) => r.f14).map((r) =>
      ({ name: r.f14, code: r.f12, value: r.f2, change: r.f3 })),
    gauge: { score: Math.round(score * 10) / 10, factors: factors },
    ladder: ladder, industries: industries,
    sources: { quote_host: raw.quotes.host, quote_mode: raw.quotes.mode,
               index_host: raw.indices.host,
               endpoints: [
                 "push2(或 push2delay).eastmoney.com /api/qt/clist/get — 全A涨跌家数",
                 "push2(或 push2delay).eastmoney.com /api/qt/ulist.np/get — 指数与成交额",
                 "push2ex.eastmoney.com /getTopicZTPool — 涨停池 / 连板梯队",
                 "push2ex.eastmoney.com /getTopicZBPool — 炸板池",
                 "push2ex.eastmoney.com /getTopicDTPool — 跌停池",
                 "push2ex.eastmoney.com /getTopicZTPool?date=" + (raw.prev.date || "前一交易日") + " — 晋级率分母"
               ] },
    config: { weights: weights, caps: caps },
    warnings: warnings, elapsed_ms: elapsed
  };
}

async function fetchDirect() {
  const t0 = Date.now();
  const now = bjDate();
  const today = dateStr(now);
  const cachedQuotes = async () => {
    if (state.quoteCache && Date.now() - state.quoteCache.ts < 60000) return state.quoteCache.value;
    const v = await fetchQuotesSafe();
    state.quoteCache = { ts: Date.now(), value: v };
    return v;
  };
  const cachedPrev = async () => {
    if (state.prevCache && state.prevCache.date === today) return state.prevCache.value;
    const v = await findPrevPool(today);
    state.prevCache = { date: today, value: v };
    return v;
  };
  const tasks = {
    quotes: cachedQuotes(),
    indices: fetchIndices(),
    zt: poolGet("getTopicZTPool", today),
    zb: poolGet("getTopicZBPool", today),
    dt: poolGet("getTopicDTPool", today),
    prev: cachedPrev()
  };
  const warnings = [];
  const out = {};
  await Promise.all(Object.keys(tasks).map(async (k) => {
    try { out[k] = await tasks[k]; }
    catch (e) {
      warnings.push(k + " 接口失败：" + e.message);
      out[k] = k === "quotes" ? { rows: [], host: null, mode: "不可用" }
        : k === "indices" ? { rows: [], host: null }
        : k === "prev" ? { date: null, total: 0, pool: [] } : { tc: 0, pool: [], qdate: today };
    }
  }));
  out.warnings = warnings;
  out.today = today;
  return aggregate(out, Date.now() - t0);
}

/* ---------------------------------------------------------- 取数调度 */
async function load(force) {
  if (state.busy) return;
  state.busy = true;
  $("refreshBtn").disabled = true;
  setStatus("loading", "正在取数…");
  let data = null;
  try {
    if (state.mode === "server") {
      try {
        const r = await fetch(serverUrl(force), { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || "服务返回错误");
        data = j;
      } catch (e) {
        state.mode = "direct";
      }
    }
    if (!data) data = await fetchDirect();
    state.data = data;
    render(data);
    setStatus("ok", data.market_status);
    $("errorPanel").hidden = true;
  } catch (e) {
    setStatus("error", "取数失败");
    $("errorPanel").hidden = false;
    $("errorPanel").innerHTML = "<b>实时数据获取失败：</b>" + esc(e.message) +
      "<br>请检查网络能否访问东方财富（push2.eastmoney.com / push2ex.eastmoney.com）；" +
      "Windows 上也可双击 start.bat 启动本地数据服务。";
  } finally {
    state.busy = false;
    state.left = state.interval;
    $("refreshBtn").disabled = false;
    updateCountdown();
  }
}
function setStatus(kind, text) {
  $("statusDot").className = "dot " + kind;
  $("statusText").textContent = text;
}
function updateCountdown() {
  $("countdown").textContent = state.auto ? "下次刷新 " + Math.max(0, state.left) + "s" : "自动刷新已关";
}

/* ---------------------------------------------------------- 渲染 */
function render(d) {
  const m = d.market, g = d.gauge;
  const modeName = state.mode === "server" ? "本地数据服务" : "浏览器直连东方财富";
  const src = d.sources || {};
  const breadthSrc = /sina/i.test(src.quote_host || "")
    ? (m.estimated ? "新浪行情（估算）" : "新浪全市场行情")
    : "东方财富公开接口";
  const idxSrc = /gtimg|qq\.com/i.test(src.index_host || "") ? "腾讯指数" : "东方财富指数";
  const srcLine = breadthSrc === "东方财富公开接口" && idxSrc === "东方财富指数"
    ? "东方财富公开接口" : breadthSrc + " · " + idxSrc;
  $("metaLine").innerHTML = "数据源：<b>" + esc(srcLine) + "</b>（" + esc(modeName) + "）｜抓取 " +
    esc(d.generated_at) + "｜交易日 " + esc(d.trade_date) + "｜状态 " + esc(d.market_status) +
    "｜耗时 " + esc(d.elapsed_ms) + " ms｜行情主机 " + esc(src.quote_host || "—") +
    (m.stale ? "｜<b>当前为 " + esc(String(m.source_at || "").slice(11, 16)) + " 快照</b>" : "");
  $("subTitle").textContent = "实时刷新 · " + srcLine + " · " + modeName;

  const band = g.score < 35 ? "偏冷" : g.score < 65 ? "中性" : "偏热";
  $("tldr").hidden = false;
  $("tldrScore").textContent = g.score.toFixed(1);
  $("tldrTitle").textContent = "情绪温度 " + g.score.toFixed(1) + " · " + band;
  const breadthText = m.up == null
    ? "涨跌家数暂不可用"
    : fmtInt(m.up) + " 只上涨" + (m.stale ? "（" + String(m.source_at || "").slice(11, 16) + " 快照）" : "");
  $("tldrText").textContent = breadthText + "、" + m.dt_total + " 只跌停，涨停 " +
    m.zt_total + " 家；炸板率 " + pct(m.zhaban_rate) + "，一进二晋级率 " + pct(m.promote_1to2) +
    "，最高连板 " + m.max_board + " 板。情绪分由 6 个分项加权得到，非交易所官方指标。";

  const staleTag = m.stale ? "（" + String(m.source_at || "").slice(11, 16) + " 快照）" : "";
  const cards = [
    { lb: "上涨家数", vl: fmtInt(m.up), tone: "up", nt: "含北交所全市场" + staleTag },
    { lb: "下跌家数", vl: fmtInt(m.down), tone: "down", nt: "平盘 " + fmtInt(m.flat) + " 家" },
    { lb: "涨停", vl: fmtInt(m.zt_total), tone: "up", nt: "触板 " + fmtInt(m.touch_total) + " 只" },
    { lb: "跌停", vl: fmtInt(m.dt_total), tone: "down", nt: "炸板 " + fmtInt(m.zb_total) + " 只" },
    { lb: "成交额", vl: (m.amount_hsbj_yi / 10000).toFixed(2), unit: "万亿", tone: "neutral",
      nt: "沪深京三市 " + fmtInt(m.amount_hsbj_yi) + " 亿" }
  ];
  $("statGrid").innerHTML = cards.map((c) => '<div class="stat"><div class="lb">' + c.lb +
    '</div><div class="vl ' + c.tone + '">' + c.vl +
    (c.unit ? '<span class="unit">' + c.unit + '</span>' : '') +
    '</div><div class="nt">' + esc(c.nt) + '</div></div>').join("");

  const pills = [
    { lb: "炸板率", vl: pct(m.zhaban_rate), tip: m.zb_total + " / " + m.touch_total },
    { lb: "一进二晋级率", vl: pct(m.promote_1to2), tip: "" },
    { lb: "二进三晋级率", vl: pct(m.promote_2to3), tip: "" },
    { lb: "最高连板", vl: m.max_board + " 板", tip: "" }
  ];
  $("pillRow").innerHTML = pills.map((p) => '<div class="pill">' + p.lb + '<b>' + p.vl + '</b>' +
    (p.tip ? ' <span class="tip">· ' + p.tip + '</span>' : '') + '</div>').join("");

  $("idxRow").innerHTML = (d.indices || []).map((x) => '<div><div class="n">' + esc(x.name) +
    '</div><div class="v">' + num(x.value, 2) + '</div><div class="c ' +
    (Number(x.change) >= 0 ? "up" : "down") + '">' +
    (Number(x.change) >= 0 ? "+" : "") + num(x.change, 2) + '%</div></div>').join("");

  $("marketNote").innerHTML = "<b>来源：</b>" +
    (/sina/i.test((d.sources || {}).quote_host || "")
      ? (m.estimated ? "涨跌家数走新浪行情（部分页缺失，按比例估算）" : "涨跌家数走新浪全市场接口全量抓取")
      : "东方财富 clist 全市场接口") +
    "，指数与成交额走 " + esc((d.sources || {}).index_host || "—") +
    "，涨停池 / 炸板池 / 跌停池走东方财富，" +
    "时点 " + esc(d.generated_at) + "（" + esc(d.market_status) + "）。" +
    (m.up == null
      ? "<b>涨跌家数当前不可用，已显示 — 而非 0。</b>"
      : "涨跌家数为含北交所的全市场有效报价口径" +
        (m.stale ? "，<b>本次实时接口不可用，数字取自 " +
          esc(String(m.source_at || "").slice(11, 16)) + " 的本机快照</b>" : "") +
        "，无报价（停牌/退市）" + fmtInt(m.suspended) + " 只未计入；") +
    "沪深两市成交额 " + fmtInt(m.amount_hs_yi) + " 亿元，加北交所后 " + fmtInt(m.amount_hsbj_yi) + " 亿元。";

  renderGauge(d);
  renderLadder(d);
  renderIndustry(d);
  renderSources(d);
}
function renderGauge(d) {
  const g = d.gauge, score = g.score;
  const cx = 135, cy = 128, r = 92, start = 135, sweep = 270;
  const polar = (deg, rad) => ({ x: cx + rad * Math.cos(deg * Math.PI / 180), y: cy + rad * Math.sin(deg * Math.PI / 180) });
  const arc = (d1, d2) => {
    const a = polar(d1, r), b = polar(d2, r);
    return "M " + a.x.toFixed(2) + " " + a.y.toFixed(2) + " A " + r + " " + r + " 0 " +
      ((d2 - d1) > 180 ? 1 : 0) + " 1 " + b.x.toFixed(2) + " " + b.y.toFixed(2);
  };
  const cs = getComputedStyle(document.documentElement);
  const c = (n, d) => (cs.getPropertyValue(n).trim() || d);
  const GOOD = c("--g-good", "#22a45d"), MID = c("--g-mid", "#7b61ff"), HOT = c("--g-hot", "#ef4444");
  const PLATE = c("--g-plate", "#fbfbfd"), TICK = c("--g-tick", "#c9cdd9");
  const LABEL = c("--g-label", "#9aa0b0"), NEEDLE = c("--g-needle", "#3b4a7a");
  const segs = [[0, 35, GOOD], [35, 60, MID], [60, 100, HOT]];
  const p = ['<svg viewBox="0 0 270 250" width="100%" role="img" aria-label="情绪温度计 ' + score + '">'];
  p.push('<circle cx="135" cy="128" r="105" fill="' + PLATE + '"/>');
  segs.forEach((s) => p.push('<path d="' + arc(start + sweep * s[0] / 100, start + sweep * s[1] / 100) +
    '" fill="none" stroke="' + s[2] + '" stroke-width="15" stroke-linecap="round"/>'));
  for (let v = 0; v <= 100; v += 10) {
    const a = polar(start + sweep * v / 100, 71), b = polar(start + sweep * v / 100, 78);
    p.push('<line x1="' + a.x.toFixed(2) + '" y1="' + a.y.toFixed(2) + '" x2="' + b.x.toFixed(2) +
      '" y2="' + b.y.toFixed(2) + '" stroke="' + TICK + '" stroke-width="1.2"/>');
    if (v % 20 === 0) {
      const t = polar(start + sweep * v / 100, 60);
      p.push('<text x="' + t.x.toFixed(2) + '" y="' + (t.y + 3).toFixed(2) +
        '" text-anchor="middle" font-size="9" fill="' + LABEL + '">' + v + '</text>');
    }
  }
  const tip = polar(start + sweep * score / 100, 62);
  p.push('<line x1="135" y1="128" x2="' + tip.x.toFixed(2) + '" y2="' + tip.y.toFixed(2) +
    '" stroke="' + NEEDLE + '" stroke-width="3.2" stroke-linecap="round"/>');
  p.push('<circle cx="135" cy="128" r="6" fill="' + NEEDLE + '"/>');
  const color = score < 35 ? GOOD : score < 65 ? MID : HOT;
  p.push('<text x="135" y="174" text-anchor="middle" font-size="30" font-weight="700" fill="' + color + '">' +
    score.toFixed(1) + '</text>');
  p.push('<text x="135" y="192" text-anchor="middle" font-size="10" fill="' + LABEL + '">情绪温度 / 100</text>');
  p.push('</svg>');
  $("gauge").innerHTML = p.join("");

  $("gaugeTitle").textContent = "当前情绪分 " + score.toFixed(1);
  const weak = g.factors.filter((f) => f.contrib != null).sort((a, b) => a.contrib - b.contrib)[0];
  const strong = g.factors.filter((f) => f.contrib != null).sort((a, b) => b.contrib - a.contrib)[0];
  $("gaugeList").innerHTML = [
    "6 个分项按权重加权，权重可在 config.json 调整。",
    strong ? "贡献最高：" + strong.name + " " + strong.contrib.toFixed(1) + " 分" : "",
    weak ? "最弱环节：" + weak.name + " " + weak.contrib.toFixed(1) + " 分" : "",
    "炸板率为负向指标，数值越低得分越高。"
  ].filter(Boolean).map((t) => "<li>" + esc(t) + "</li>").join("");

  $("factorBody").innerHTML = g.factors.map((f) => "<tr><td>" + esc(f.name) +
    "</td><td class='num'>" + Number(f.weight).toFixed(2) + "</td><td class='num'>" +
    (f.sub == null ? "—" : f.sub.toFixed(1)) + "</td><td class='num'><b>" +
    (f.contrib == null ? "—" : f.contrib.toFixed(1)) + "</b></td><td class='num'>" +
    (f.raw == null ? "—" : f.raw) + "</td></tr>").join("") +
    "<tr><td><b>合计</b></td><td class='num'><b>1.00</b></td><td>—</td><td class='num'><b>" +
    score.toFixed(1) + "</b></td><td>—</td></tr>";

  const max = Math.max.apply(null, g.factors.map((f) => f.contrib || 0).concat([1]));
  $("barChart").innerHTML = g.factors.map((f) => {
    const w = Math.max(2, Math.round((f.contrib || 0) / max * 100));
    return '<div class="bar-row"><span>' + esc(f.name) + '</span><div class="bar-track">' +
      '<div class="bar-fill" style="width:' + w + '%"></div></div><span class="bar-val">' +
      (f.contrib == null ? "—" : f.contrib.toFixed(1)) + '</span></div>';
  }).join("") + '<p class="src-note">横条按贡献分绘制；切回「分项明细」可看权重、子分与原始值。</p>';

  $("gaugeNote").innerHTML = "<b>口径：</b>子分 = min(100, 原始值 / cap × 100)，炸板率用 (1 − 原始值) / cap；" +
    "贡献 = 子分 × 权重，合计即情绪分。这是本应用自定义指标，非交易所发布数据，" +
    "与任何第三方报告的分数不可直接比较。权重与 cap 见 config.json。";
}
function renderLadder(d) {
  const groups = d.ladder || [];
  $("ladder").innerHTML = groups.map((g) => {
    const open = g.board >= 2 ? " open" : "";
    const rows = g.rows.map((r) => "<tr><td><b>" + esc(r.name) + "</b></td><td class='num'>" +
      esc(r.code) + "</td><td class='num up'>+" + num(r.chg, 2) + "%</td><td class='num'>" +
      esc(r.seal) + "</td><td class='num'>" + esc(r.broken) + "</td><td class='num'>" +
      esc(r.stat) + "</td><td class='num'>" + num(r.turnover, 1) + "%</td><td>" +
      esc(r.industry) + "</td></tr>").join("");
    return '<details class="ladder-group"' + open + '><summary><span class="board-tag">' +
      g.board + ' 板 · ' + g.count + ' 只</span><span class="fold">展开 / 收起</span></summary>' +
      '<div class="tbl-scroll"><table><thead><tr><th>名称</th><th>代码</th><th>涨跌幅</th>' +
      '<th>封板时间</th><th>炸板</th><th>涨停统计</th><th>换手</th><th>行业</th></tr></thead><tbody>' +
      rows + '</tbody></table></div></details>';
  }).join("") || '<p class="src-note">当前无连板数据。</p>';
  $("ladderNote").innerHTML = "<b>来源：</b>东方财富涨停池接口（getTopicZTPool），时点 " +
    esc(d.generated_at) + "。已剔除 ST 与北交所；涨停池总数 " + d.market.zt_total +
    " 只，过滤后 " + d.market.zt_filtered + " 只。封板时间、炸板次数、涨停统计、换手率、行业均为接口原字段，未做推算。";
}
function renderIndustry(d) {
  const items = d.industries || [];
  const max = Math.max.apply(null, items.map((x) => x.count).concat([1]));
  $("industry").innerHTML = items.map((x) => '<div class="bar-row"><span>' + esc(x.name) +
    '</span><div class="bar-track"><div class="bar-fill red" style="width:' +
    Math.round(x.count / max * 100) + '%"></div></div><span class="bar-val">' +
    x.count + ' 家</span></div>').join("") || '<p class="src-note">当前无行业数据。</p>';
  $("industryNote").innerHTML = "<b>来源：</b>东方财富涨停池接口的行业板块字段（hybk），时点 " +
    esc(d.generated_at) + "，按涨停个股数统计；与其他媒体按申万一级/细分行业统计的口径可能不同。";
}
function renderSources(d) {
  const s = d.sources;
  const rows = [
    ["数据模式", state.mode === "server" ? "本地/自填服务 → 东方财富" : "浏览器 JSONP 直连 → 东方财富"],
    ["行情主机", s.quote_host || "—"],
    ["取数方式", s.quote_mode || "—"],
    ["指数主机", s.index_host || "—"],
    ["交易日", d.trade_date],
    ["抓取时点", d.generated_at],
    ["市场状态", d.market_status],
    ["无报价股票", fmtInt(d.market.suspended) + " 只（停牌/退市，不计入涨跌家数）"],
    ["前一交易日", (d.market.prev_date || "—") + "（涨停 " + fmtInt(d.market.prev_zt_total) + " 只，用于晋级率分母）"]
  ];
  $("sourceBox").innerHTML = '<div class="tbl-scroll"><table class="src-table"><tbody>' +
    rows.map((r) => "<tr><td>" + esc(r[0]) + "</td><td>" + esc(r[1]) + "</td></tr>").join("") +
    "</tbody></table></div><h3>调用的接口</h3><ul class='ep-list'>" +
    (s.endpoints || []).map((e) => "<li><code>" + esc(e) + "</code></li>").join("") + "</ul>" +
    (d.warnings && d.warnings.length
      ? '<div class="warn"><b>取数提示：</b>' + d.warnings.map(esc).join("；") + "</div>" : "");
  $("sourceNote").innerHTML = "全部数字由上述接口在 " + esc(d.generated_at) +
    " 实时返回后计算，未使用任何预置或推测数值。东方财富接口为公开行情接口，无需 API Key；" +
    "非交易时段返回最近一个交易日收盘数据，法定节假日未内置交易日历。";
}

/* ---------------------------------------------------------- 交互 */
function bind() {
  $("refreshBtn").addEventListener("click", () => load(true));
  $("autoToggle").addEventListener("change", (e) => {
    state.auto = e.target.checked; state.left = state.interval; updateCountdown();
  });
  $("intervalSel").addEventListener("change", (e) => {
    state.interval = Number(e.target.value); state.left = state.interval; updateCountdown();
  });
  $("settingsBtn").addEventListener("click", () => {
    $("settingsPanel").hidden = !$("settingsPanel").hidden;
    $("apiBaseInput").value = apiBase();
  });
  const toFund = document.getElementById("toFund");
  if (toFund) {
    toFund.addEventListener("click", (ev) => {
      ev.preventDefault();
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: "app-tab", tab: "fund" }, "*");
          return;
        }
      } catch (_) { /* 跨域忽略 */ }
      location.href = "fund.html";
    });
  }
  $("saveApiBtn").addEventListener("click", () => {
    const v = $("apiBaseInput").value.trim();
    if (v) localStorage.setItem("apiBase", v); else localStorage.removeItem("apiBase");
    state.mode = "server";
    $("apiHint").textContent = "已保存，正在重连…";
    load(true).then(() => { $("apiHint").textContent = "当前模式：" + (state.mode === "server" ? "服务模式" : "直连模式（服务不可用）"); });
  });
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      $("paneTable").style.display = btn.dataset.pane === "paneTable" ? "block" : "none";
      $("paneBar").style.display = btn.dataset.pane === "paneBar" ? "block" : "none";
    });
  });
  if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
setInterval(() => {
  if (!state.auto) { updateCountdown(); return; }
  state.left -= 1;
  if (state.left <= 0) {
    if (!document.hidden && !state.busy) load(false);
    else state.left = 1;
  }
  updateCountdown();
}, 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.auto && state.left <= 2 && !state.busy) load(false);
});
bind();
updateCountdown();
load(false);
