/* 底部四 Tab：基金 / 情绪 / 美股 / 资讯
 * 采用页面间跳转而非 iframe —— iOS 的 WKWebView 在 file:// 下 iframe 内 localStorage
 * 与相对路径都不稳，跳转版在原生壳和浏览器里行为一致。
 */
(function () {
  var PAGES = [
    { tab: 'fund', file: 'fund.html', icon: '◈', name: '基金' },
    { tab: 'senti', file: 'index.html', icon: '◉', name: '情绪' },
    { tab: 'us', file: 'us.html', icon: '◐', name: '美股' },
    { tab: 'news', file: 'news.html', icon: '☰', name: '资讯' }
  ];
  var MAP = {
    'fund.html': 'fund', 'index.html': 'senti', 'us.html': 'us', 'news.html': 'news',
    'fund': 'fund', 'index': 'senti', 'us': 'us', 'news': 'news', '': 'senti'
  };
  var here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if (here === '' || here === '/') here = 'index.html';
  var cur = MAP[here] || 'senti';

  var scroller = document.querySelector('.shell') || document.querySelector('.app');
  document.body.classList.add('with-tabbar');
  if (scroller) document.body.classList.add('scroller-page');

  var nav = document.createElement('nav');
  nav.className = 'app-tabbar';
  nav.setAttribute('role', 'tablist');
  // 用 <a href> 让 WebKit 自己导航：div + location.href 在 WKWebView 里偶发点了没反应
  nav.innerHTML = PAGES.map(function (p) {
    var q = location.search || '';
    return '<a class="atb-i' + (p.tab === cur ? ' on' : '') + '" role="tab" tabindex="-1" draggable="false" href="' + p.file + q + '">'
      + '<i>' + p.icon + '</i>' + p.name + '</a>';
  }).join('');
  document.body.appendChild(nav);
})();
