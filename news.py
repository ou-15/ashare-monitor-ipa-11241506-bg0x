# -*- coding: utf-8 -*-
"""资讯数据层：同花顺 7×24 / 东财快讯 / 新浪 7×24。

实测（2026-11-24）：
- 同花顺 news.10jqka.com.cn/tapp/news/push/stock/  ✅ JSON，无 CORS 头（App 内需原生代抓）
- 东财   np-listapi.eastmoney.com getFastNewsList  ✅ JSON，需 req_trace
- 新浪   zhibo.sina.com.cn/api/zhibo/feed          ✅ JSON
- 金十   flash-api.jin10.com → 502（带 x-app-id 仍 502），官网首页为 SPA 空壳，当前不可用
"""
import gzip
import json
import re
import time
import urllib.request
from datetime import datetime

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0 Safari/537.36")

SOURCES = {
    "ths": {"name": "同花顺", "url": "https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&track=website",
            "ref": "https://news.10jqka.com.cn/"},
    "east": {"name": "东财", "url": ("https://np-listapi.eastmoney.com/comm/web/getFastNewsList?"
                                    "client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=40&req_trace=1"),
             "ref": "https://kuaixun.eastmoney.com/"},
    "sina": {"name": "新浪", "url": ("https://zhibo.sina.com.cn/api/zhibo/feed?"
                                    "page=1&page_size=40&zhibo_id=152&tag_id=0&dire=f&dpc=1"),
             "ref": "https://finance.sina.com.cn/7x24/"},
}

_cache = {}
_TAG = re.compile(r"^【[^】]{0,40}】")


def _http(url, referer=None, timeout=15):
    headers = {"User-Agent": UA}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return raw.decode("utf-8", "replace")


def _hhmm(ts):
    """统一成 HH:MM。"""
    if isinstance(ts, (int, float)) or (isinstance(ts, str) and ts.isdigit()):
        try:
            return datetime.fromtimestamp(int(ts)).strftime("%H:%M")
        except (ValueError, OSError):
            return ""
    s = str(ts or "")
    m = re.search(r"(\d{1,2}):(\d{2})", s)
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else ""


def _split_rich(text):
    """把「【标题】正文」拆成 (标题, 正文)。"""
    t = (text or "").strip()
    m = _TAG.match(t)
    if m:
        head = t[len(m.group(0)):].strip()
        # 标题到第一个句号/逗号为止，过长则截断
        cut = re.split(r"[，。！？]", t[1:m.end() - 1], maxsplit=1)[0]
        return cut.strip() or head[:40], t[m.end():].strip()
    return t[:48], ""


def _from_ths():
    src = SOURCES["ths"]
    data = json.loads(_http(src["url"], src["ref"]))
    out = []
    for it in (data.get("data") or {}).get("list") or []:
        title = (it.get("title") or "").strip()
        digest = (it.get("digest") or "").strip()
        out.append({
            "id": str(it.get("id") or ""),
            "time": _hhmm(it.get("ctime")),
            "title": title or digest[:40],
            "digest": digest if title else "",
            "source": "同花顺",
            "url": it.get("url") or "",
            "important": str(it.get("import") or "") in ("1", "2"),
        })
    return out


def _from_east():
    src = SOURCES["east"]
    data = json.loads(_http(src["url"], src["ref"]))
    out = []
    for it in (data.get("data") or {}).get("fastNewsList") or []:
        title = (it.get("title") or "").strip()
        summary = (it.get("summary") or "").strip()
        body = _TAG.sub("", summary).strip() if summary else ""
        out.append({
            "id": str(it.get("code") or ""),
            "time": _hhmm(it.get("showTime")),
            "title": title or body[:40],
            "digest": body if title and body != title else "",
            "source": "东财",
            "url": "https://kuaixun.eastmoney.com/",
            "important": str(it.get("titleColor") or "0") not in ("0", ""),
        })
    return out


def _from_sina():
    src = SOURCES["sina"]
    data = json.loads(_http(src["url"], src["ref"]))
    feed = ((data.get("result") or {}).get("data") or {}).get("feed") or {}
    out = []
    for it in feed.get("list") or []:
        title, body = _split_rich(it.get("rich_text") or "")
        out.append({
            "id": str(it.get("id") or ""),
            "time": _hhmm(it.get("create_time")),
            "title": title,
            "digest": body,
            "source": "新浪",
            "url": it.get("docurl") or "https://finance.sina.com.cn/7x24/",
            "important": False,
        })
    return out


_FETCH = {"ths": _from_ths, "east": _from_east, "sina": _from_sina}


def list_news(src="ths", force=False, ttl=180):
    key = "news_" + src
    now = time.time()
    if not force and key in _cache and now - _cache[key][0] < ttl:
        return _cache[key][1]
    fn = _FETCH.get(src)
    if not fn:
        return {"ok": False, "error": f"未知来源 {src}", "list": []}
    try:
        items = fn()
        payload = {"ok": True, "src": src, "source_name": SOURCES[src]["name"],
                   "list": items[:40], "count": len(items),
                   "time": datetime.now().strftime("%H:%M")}
    except Exception as exc:  # noqa: BLE001
        payload = {"ok": False, "src": src, "error": f"{type(exc).__name__}: {exc}", "list": []}
    _cache[key] = (now, payload)
    return payload


def merged(force=False):
    """三源合并，按时间倒序（时间只有 HH:MM，跨零点会不准，仅用于首屏混合流）。"""
    all_items = []
    for src in ("ths", "east", "sina"):
        res = list_news(src, force)
        if res.get("ok"):
            all_items.extend(res["list"])
    all_items.sort(key=lambda x: x.get("time") or "", reverse=True)
    # 多源会重复推送同一条，按标题前 24 字去重（保留时间最新的那条）
    seen = set()
    uniq = []
    for it in all_items:
        key = (it.get("title") or "").strip()[:24]
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        uniq.append(it)
    return {"ok": True, "mixed": True, "list": uniq[:60], "count": len(uniq)}
