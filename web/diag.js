/* 接口自检：逐项跑真实请求，把「哪一层没数据」暴露出来 */
(function () {
  var lines = [];
  var box = document.getElementById('out');
  var env = document.getElementById('env');

  function push(s) {
    lines.push(s);
    box.textContent = lines.join('\n');
  }

  function hasBridge() {
    try {
      return !!(window.AshareNative && window.AshareNative.post)
        || !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.fundFetch);
    } catch (e) { return false; }
  }

  var seq = 0;
  function bridgeGet(url, referer) {
    return new Promise(function (resolve, reject) {
      var id = 'dg_' + (++seq) + '_' + Date.now();
      var reply = window.__fundFetchReply = window.__fundFetchReply || {};
      var t = setTimeout(function () {
        try { delete reply[id]; } catch (e) {}
        reject(new Error('桥超时 20s'));
      }, 20000);
      reply[id] = function (r) {
        clearTimeout(t);
        try { delete reply[id]; } catch (e) {}
        if (!r || !r.ok) { reject(new Error((r && r.error) || '桥失败')); return; }
        resolve(r.body);
      };
      try {
        if (window.AshareNative && window.AshareNative.post) {
          window.AshareNative.post(JSON.stringify({ id: id, url: url, referer: referer || '' }));
        } else {
          window.webkit.messageHandlers.fundFetch.postMessage({ id: id, url: url, referer: referer || '' });
        }
      }
      catch (e) { clearTimeout(t); reject(e); }
    });
  }

  function jsonp(url, timeout) {
    return new Promise(function (resolve, reject) {
      var cb = '__dgc_' + (++seq);
      var s = document.createElement('script');
      var t = setTimeout(function () { done(new Error('timeout')); }, timeout || 8000);
      function done(err, val) {
        clearTimeout(t);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (s.parentNode) s.parentNode.removeChild(s);
        err ? reject(err) : resolve(val);
      }
      window[cb] = function (d) { done(null, d); };
      s.onerror = function () { done(new Error('network')); };
      s.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'cb=' + cb;
      document.head.appendChild(s);
    });
  }

  async function older(name, fn) {
    var t = Date.now();
    try {
      var info = await fn();
      push('OK   ' + name + '  ' + (Date.now() - t) + 'ms  ' + info);
    } catch (e) {
      push('ERR  ' + name + '  ' + (Date.now() - t) + 'ms  ' + (e && e.message ? e.message : e));
    }
  }

  function apiBase() {
    var v = '';
    try { v = new URLSearchParams(location.search).get('api') || ''; } catch (e) {}
    if (!v) { try { v = localStorage.getItem('apiBase') || ''; } catch (e) {} }
    return (v || '').replace(/\/+$/, '');
  }

  async function run() {
    lines = [];
    box.textContent = '';
    var API = apiBase();
    var BR = hasBridge();
    env.textContent = 'protocol=' + location.protocol + ' | apiBase=' + (API || '(空)') +
      ' | 原生桥=' + (BR ? '有' : '无') + ' | UA=' + navigator.userAgent.slice(0, 60);

    if (API) {
      await older('服务 /api/health', async function () {
        var r = await fetch(API + '/api/health', { cache: 'no-store' });
        return 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 60);
      });
    }

    if (!BR) {
      push('（没有原生桥：下面走网页直连，第三方接口多半跨域失败，属正常）');
    }

    var get = BR ? bridgeGet : async function (u) { throw new Error('无桥，跳过'); };

    await older('东财 clist A股(直连JSONP)', async function () {
      var j = await jsonp('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&np=1&fltt=2&invt=2&ut=bd1d9ddb04089700cf9c27f6f7426281&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f3', 6000);
      var d = j.data || {};
      return 'total=' + d.total + ' rows=' + ((d.diff || []).length);
    });

    await older('新浪家数(桥)', async function () {
      var t = await get('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=hs_a', 'https://vip.stock.finance.sina.com.cn/');
      return 'count=' + String(t).trim().slice(0, 30);
    });

    await older('新浪第1页(桥)', async function () {
      var t = await get('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page', 'https://vip.stock.finance.sina.com.cn/');
      var arr = JSON.parse(t);
      return 'rows=' + (arr.length || 0) + ' first=' + (arr[0] && arr[0].symbol) + ' ' + (arr[0] && arr[0].name);
    });

    await older('腾讯A股指数(桥,GBK)', async function () {
      var t = await get('https://qt.gtimg.cn/q=s_sh000001,s_sz399001,s_sz399006', 'https://finance.qq.com/');
      var m = String(t).match(/s_sh000001="([^"]+)"/);
      return m ? ('上证段=' + m[1].slice(0, 60)) : ('返回=' + String(t).slice(0, 60));
    });

    await older('腾讯美股指数(桥)', async function () {
      var t = await get('https://qt.gtimg.cn/q=usDJI,usIXIC,usINX', 'https://finance.qq.com/');
      var m = String(t).match(/v_usDJI="([^"]+)"/);
      if (!m) throw new Error('无 v_usDJI：' + String(t).slice(0, 60));
      var f = m[1].split('~');
      return 'fields=' + f.length + ' name=' + f[1] + ' price=' + f[3] + ' pct=' + f[32];
    });

    await older('Cboe VIX 日线(桥)', async function () {
      var t = await get('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv', '');
      var ls = String(t).trim().split(/\r?\n/);
      return 'lines=' + ls.length + ' head=' + ls[0].slice(0, 30) + ' tail=' + ls[ls.length - 1].slice(0, 30);
    });

    await older('东财美股家数(桥)', async function () {
      var t = await get('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=0&np=1&fltt=2&invt=2&fid=f12&fs=m:105,m:106,m:107&fields=f3,f12,f14', 'https://quote.eastmoney.com/');
      var d = JSON.parse(t).data || {};
      return 'total=' + d.total + ' rows=' + ((d.diff || []).length);
    });

    await older('资讯-同花顺(桥)', async function () {
      var t = await get('https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&track=website', 'https://news.10jqka.com.cn/');
      var d = JSON.parse(t);
      return 'items=' + (((d.data || {}).list || []).length);
    });

    await older('资讯-东财(桥)', async function () {
      var t = await get('https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=40&req_trace=1', 'https://kuaixun.eastmoney.com/');
      var d = JSON.parse(t);
      return 'items=' + (((d.data || {}).fastNewsList || []).length);
    });

    await older('资讯-新浪(桥)', async function () {
      var t = await get('https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=40&zhibo_id=152&tag_id=0&dire=f&dpc=1', 'https://finance.sina.com.cn/7x24/');
      var d = JSON.parse(t);
      var feed = (((d.result || {}).data || {}).feed) || {};
      return 'items=' + ((feed.list || []).length);
    });

    await older('基金持仓-东财F10(桥)', async function () {
      var t = await get('https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=110022&topline=10&year=&month=&rt=0.1', 'https://fundf10.eastmoney.com/');
      return 'len=' + String(t).length + ' head=' + String(t).slice(0, 50).replace(/\s+/g, ' ');
    });

    await older('基金净值-天天基金(桥)', async function () {
      var t = await get('https://fund.eastmoney.com/pingzhongdata/110022.js', 'https://fund.eastmoney.com/');
      return 'len=' + String(t).length + ' hasData=' + (String(t).indexOf('Data_netWorthTrend') >= 0);
    });

    await older('A股涨停池(桥)', async function () {
      var t = await get('https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=20&sort=fbt:asc&date=20261124', 'https://quote.eastmoney.com/');
      var d = typeof t === 'string' ? JSON.parse(t.replace(/^[^{]*/, '').replace(/[^}]*$/, '')) : t;
      return 'tc=' + ((d.data || {}).tc) + ' pool=' + (((d.data || {}).pool || []).length);
    });

    push('');
    push('===== 结束 ' + new Date().toLocaleTimeString() + ' =====');
  }

  document.getElementById('again').addEventListener('click', run);
  document.getElementById('copy').addEventListener('click', function () {
    var text = env.textContent + '\n' + box.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { alert('已复制'); }, function () { alert('复制失败，请手动选择'); });
    } else {
      alert('长按文本手动复制');
    }
  });

  run();
})();
