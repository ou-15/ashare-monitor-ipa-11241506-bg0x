#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
基金实时估值数据层（零第三方依赖，仅标准库）

职责边界：只负责「取原始事实 + 解析 + 缓存」，不做任何估算口径决策。
估算（持仓加权 / 指数跟踪 / 官方估值）全部在前端按用户选择的模式实时计算，
这样切换计算方式不需要任何一次网络请求。

数据源：
  1) 天天基金 前十大持仓  https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc
     需要 Referer: https://fundf10.eastmoney.com/ ，否则被拒。返回 JS 变量 + HTML 表。
  2) 天天基金 最新净值    https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo
     返回 NAV / PDATE / NAVCHGRT，支持 Fcodes 逗号批量。
     注意：GSZ / GSZZL（官方估值）当前全量为 null，故官方估值仅作可选兜底。
  3) 腾讯行情 三市场      https://qt.gtimg.cn/q=sh600519,hk00700,usAAPL
     GBK 编码，~ 分隔。字段：[1]名称 [3]现价 [4]昨收 [30]时间 [31]涨跌额 [32]涨跌幅
"""
from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

BASE = Path(__file__).resolve().parent
CACHE_DIR = BASE / "cache"
BJ = timezone(timedelta(hours=8))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

HDR_JJCC = {"User-Agent": UA, "Referer": "https://fundf10.eastmoney.com/",
            "Accept": "*/*", "Accept-Language": "zh-CN,zh;q=0.9"}
HDR_EM = {"User-Agent": UA, "Referer": "https://fund.eastmoney.com/",
          "Accept": "*/*", "Accept-Language": "zh-CN,zh;q=0.9"}
HDR_QT = {"User-Agent": UA, "Referer": "https://gu.qq.com/", "Accept": "*/*"}

JJCC_URL = ("https://fundf10.eastmoney.com/FundArchivesDatas.aspx"
            "?type=jjcc&code={code}&topline=10")
NAV_URL = ("https://api.fund.eastmoney.com/f10/lsjz?fundCode={code}"
           "&pageIndex=1&pageSize=3&_={ts}")
QUOTE_URL = "https://qt.gtimg.cn/q={symbols}"

QUOTE_BATCH = 50          # 单次行情请求代码数上限
HOLDINGS_DAILY = True     # 持仓每天只抓一次
SCHEMA = 2                # 缓存结构版本，改结构时 +1 让旧缓存失效
QUOTE_CACHE_SEC = 3.0     # 行情短缓存，避免多客户端重复打
NAV_CACHE_SEC = 300.0     # 净值一天只更新一次，5 分钟缓存足够
NAV_WORKERS = 6

_lock = threading.Lock()
_quote_cache: dict = {"ts": 0.0, "data": {}}
_nav_cache: dict = {"ts": 0.0, "data": {}}
_hold_cache: dict = {}    # code -> payload


# --------------------------------------------------------------------------- 网络
def http_text(url: str, headers: dict, decode: str = "utf-8",
              timeout: float = 10.0, retries: int = 2) -> str:
    last = None
    for i in range(retries):
        try:
            req = Request(url, headers=headers)
            with urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            return raw.decode(decode, "replace")
        except Exception as exc:  # noqa: BLE001
            last = exc
            if i + 1 < retries:
                time.sleep(0.25 * (i + 1))
    raise RuntimeError(f"request failed: {last}")


# --------------------------------------------------------------------------- 持仓
MARKET_PREFIX = {"1": "sh", "0": "sz", "116": "hk", "105": "us", "106": "us", "107": "us"}


def to_symbol(market_id: str, code: str) -> str:
    """东财市场号 + 代码 → 腾讯行情代码"""
    code = (code or "").strip()
    if not code:
        return ""
    if market_id in ("105", "106", "107"):
        return "us" + code.upper()
    if market_id == "116":
        return "hk" + code.zfill(5)
    if market_id == "1":
        return "sh" + code
    if market_id == "0":
        # 北交所（8/4 开头）与深市共用市场号 0
        return ("bj" if code[:1] in ("4", "8") else "sz") + code
    return ""


def guess_kind(name: str) -> str:
    n = name or ""
    if "联接" in n:
        return "link"
    if "货币" in n:
        return "money"
    if "QDII" in n.upper():
        return "qdii"
    if "债" in n:
        return "bond"
    if "ETF" in n.upper():
        return "etf"
    if "指数" in n or "LOF" in n.upper():
        return "index"
    return "active"


WEIGHT_RE = re.compile(r"class='tor'>([\d.]+)%</td>")
CODE_RE = re.compile(r"unify/r/(\d+)\.([0-9A-Za-z]+)'")
NAME_RE = re.compile(r"class='tol'><a[^>]*>([^<]+)</a>")
DATE_RE = re.compile(r"截止至：<font class='px12'>([\d-]+)</font>")
TITLE_RE = re.compile(r"(\d{4})年(\d?)(季度|中期|半年度|年度|年报|半年报)股票投资明细")
FUND_NAME_RE = re.compile(r"<a[^>]*title='([^']+)'[^>]*href='(?:https?:)?//fund\.eastmoney\.com/\d+\.html'")
FUND_NAME_RE2 = re.compile(r"<label class='left'><a[^>]*title='([^']+)'")
# 港美股持仓行用的是 class='toc'（A股是 class='tol'/'tor'），因此按单元格文本兜底
ROW_LINK_RE = re.compile(r"<a[^>]*>([^<]+)</a>")
CELL_PCT_RE = re.compile(r"\d+(?:\.\d+)?%")
ROW_CELL_SPLIT = re.compile(r"</td>")
TAG_RE = re.compile(r"<[^>]+>")


def _quarter_label(title_hit) -> str:
    """'2026年3季度' → '2026Q3季报'；中报/年报单独标记"""
    if not title_hit:
        return ""
    year, seq, span = title_hit.group(1), title_hit.group(2), title_hit.group(3)
    if span == "季度":
        return f"{year}Q{seq or '?'}季报"
    return f"{year}{'中报' if span in ('中期', '半年度', '半年报') else '年报'}"


def parse_holdings(raw: str) -> dict:
    """解析 FundArchivesDatas.aspx 返回的 JS+HTML，取最新一期前十大"""
    if "apidata" not in raw:
        raise RuntimeError("持仓接口返回异常（可能被风控拦截）")
    head = raw[:2000]
    date_hit = DATE_RE.search(raw)
    report_date = date_hit.group(1) if date_hit else ""
    title_hit = TITLE_RE.search(head)
    nm_fund = FUND_NAME_RE.search(head) or FUND_NAME_RE2.search(head)
    fund_name = nm_fund.group(1).strip() if nm_fund else ""

    rows = re.findall(r"<tr>(.*?)</tr>", raw, re.S)
    items: list[dict] = []
    for row in rows:
        if "<th" in row:
            continue
        cm = CODE_RE.search(row)
        if not cm:
            continue
        market_id, code = cm.group(1), cm.group(2)

        # 名称：行内第二个链接（第一个是代码）。A股是 class='tol'，港美股是 class='toc'
        links = [t.strip() for t in ROW_LINK_RE.findall(row)]
        name = ""
        if len(links) >= 2 and links[1] and links[1] != links[0]:
            name = links[1]
        if not name:
            nm = NAME_RE.search(row)
            name = nm.group(1).strip() if nm else code

        # 占比：数据行里唯一一个纯百分比的单元格（涨跌幅列是占位 span，不会命中）
        weight = 0.0
        for cell in ROW_CELL_SPLIT.split(row):
            text = TAG_RE.sub("", cell).strip()
            if CELL_PCT_RE.fullmatch(text):
                try:
                    weight = float(text.rstrip("%"))
                except ValueError:
                    weight = 0.0
                break
        if weight == 0.0:
            wm = WEIGHT_RE.search(row)
            if wm:
                try:
                    weight = float(wm.group(1))
                except ValueError:
                    weight = 0.0

        symbol = to_symbol(market_id, code)
        if not symbol:
            continue
        is_fund_holding = bool(re.search(r"(ETF|指数|基金)", name)) and not market_id == "116"
        items.append({
            "code": code,
            "name": name,
            "market": market_id,
            "symbol": symbol,
            "weight": weight,
            "is_fund": is_fund_holding,
        })
        if len(items) >= 10:
            break

    if not items:
        raise RuntimeError("未解析到持仓数据")

    sum_weight = round(sum(i["weight"] for i in items), 2)
    # 单只 ETF 占比极高 → 视为 ETF 联接/单标的基金
    single_etf = len(items) == 1 and items[0]["is_fund"] and items[0]["weight"] >= 60
    return {
        "fund_name": fund_name,
        "kind": guess_kind(fund_name),
        "report_date": report_date,
        "report_label": _quarter_label(title_hit),
        "quarter": (f"{title_hit.group(1)}Q{title_hit.group(2)}"
                    if title_hit and title_hit.group(3) == "季度" else _quarter_label(title_hit)),
        "items": items,
        "sum_weight": sum_weight,
        "single_etf": single_etf,
    }


def _cache_file(code: str) -> Path:
    return CACHE_DIR / f"holdings_{code}.json"


def _today_key() -> str:
    return datetime.now(BJ).strftime("%Y-%m-%d")


def get_holdings(code: str, force: bool = False) -> dict:
    """持仓：内存 → 磁盘 → 网络；每个自然日最多抓一次"""
    code = code.strip()
    with _lock:
        memo = _hold_cache.get(code)
    if memo and not force:
        return memo

    payload = None
    if not force and HOLDINGS_DAILY:
        try:
            disk = json.loads(_cache_file(code).read_text(encoding="utf-8"))
            if (disk.get("schema") == SCHEMA and disk.get("fetched_day") == _today_key()
                    and disk.get("items")):
                payload = disk
                payload["cached"] = True
        except Exception:  # noqa: BLE001
            payload = None

    if payload is None:
        raw = http_text(JJCC_URL.format(code=code), HDR_JJCC)
        payload = parse_holdings(raw)
        payload.update({
            "code": code,
            "schema": SCHEMA,
            "fetched_day": _today_key(),
            "fetched_at": datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S"),
            "cached": False,
        })
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        try:
            _cache_file(code).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass

    with _lock:
        _hold_cache[code] = payload
    return payload


# --------------------------------------------------------------------------- 净值
def _fetch_nav_one(code: str) -> dict | None:
    """单只基金最新净值：api.fund.eastmoney.com/f10/lsjz"""
    import time as _t
    url = NAV_URL.format(code=code, ts=int(_t.time() * 1000))
    for attempt in range(2):
        try:
            data = json.loads(http_text(url, HDR_JJCC))
            rows = ((data.get("Data") or {}).get("LSJZList") or [])
            if rows:
                row = rows[0]
                try:
                    nav = float(row.get("DWJZ")) if row.get("DWJZ") else None
                except (TypeError, ValueError):
                    nav = None
                try:
                    chg = float(row.get("JZZZL")) if row.get("JZZZL") else None
                except (TypeError, ValueError):
                    chg = None
                return {"code": code, "nav": nav, "nav_date": row.get("FSRQ") or "",
                        "nav_chg": chg, "acc_nav": row.get("LJJZ") or None,
                        "gz": None, "gz_pct": None}
            return None
        except Exception:  # noqa: BLE001
            if attempt == 0:
                _t.sleep(0.3)
    return None


def get_navs(codes: list[str], force: bool = False) -> dict:
    from concurrent.futures import ThreadPoolExecutor
    codes = [c.strip() for c in codes if c and c.strip()]
    if not codes:
        return {"ok": True, "items": {}}

    with _lock:
        cached_ts = _nav_cache["ts"]
        cached = dict(_nav_cache["data"])
    if not force and (time.time() - cached_ts) < NAV_CACHE_SEC:
        items = {c: cached[c] for c in codes if c in cached}
        if len(items) == len(codes):
            return {"ok": True, "items": items, "cached": True}

    todo = codes if force else [c for c in codes if c not in cached]
    results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=NAV_WORKERS) as pool:
        for item in pool.map(_fetch_nav_one, todo):
            if item:
                results[item["code"]] = item

    with _lock:
        merged = dict(_nav_cache["data"])
        merged.update(results)
        _nav_cache.update({"ts": time.time(), "data": merged})

    items = {}
    for c in codes:
        src = results.get(c) or merged.get(c)
        if src:
            items[c] = src
    return {"ok": True, "items": items, "failed": [c for c in codes if c not in items]}


# --------------------------------------------------------------------------- 行情
def _parse_quote_block(text: str, out: dict) -> None:
    for m in re.finditer(r'v_([A-Za-z0-9_]+)="([^"]*)"', text):
        sym, payload = m.group(1), m.group(2)
        if "~" not in payload:
            continue
        f = payload.split("~")
        if len(f) < 33:
            continue
        try:
            price = float(f[3]) if f[3] else 0.0
            prev = float(f[4]) if f[4] else 0.0
        except ValueError:
            continue
        pct = None
        try:
            if f[32] not in ("", "-"):
                pct = float(f[32])
        except ValueError:
            pct = None
        if pct is None and price and prev:
            pct = round((price - prev) / prev * 100, 2)
        if not price or price <= 0:
            # 停牌 / 无成交：涨跌幅按 0 处理，但标记 suspended
            out[sym] = {"symbol": sym, "name": f[1], "price": None, "prev": prev or None,
                        "pct": 0.0, "time": f[30], "suspended": True}
            continue
        out[sym] = {
            "symbol": sym,
            "name": f[1],
            "price": price,
            "prev": prev or None,
            "pct": pct if pct is not None else 0.0,
            "time": f[30],
            "high": f[33] or None,
            "low": f[34] or None,
            "suspended": False,
        }


def get_quotes(symbols: list[str], force: bool = False) -> dict:
    uniq = []
    for s in symbols:
        s = (s or "").strip()
        if s and s not in uniq:
            uniq.append(s)
    if not uniq:
        return {"ok": True, "quotes": {}, "count": 0}

    with _lock:
        ts = _quote_cache["ts"]
        data = dict(_quote_cache["data"])
    if not force and data and (time.time() - ts) < QUOTE_CACHE_SEC and all(s in data for s in uniq):
        return {"ok": True, "quotes": {s: data[s] for s in uniq}, "cached": True, "count": len(uniq)}

    out: dict = {}
    errors: list[str] = []
    for i in range(0, len(uniq), QUOTE_BATCH):
        chunk = uniq[i:i + QUOTE_BATCH]
        try:
            text = http_text(QUOTE_URL.format(symbols=",".join(chunk)), HDR_QT, decode="gbk")
            _parse_quote_block(text, out)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{type(exc).__name__}: {exc}")

    missing = [s for s in uniq if s not in out]
    if missing:
        # 港股/美股个别代码格式差异时，回退单条重试一次
        for sym in missing[:20]:
            try:
                text = http_text(QUOTE_URL.format(symbols=sym), HDR_QT, decode="gbk")
                _parse_quote_block(text, out)
            except Exception:  # noqa: BLE001
                continue

    with _lock:
        merged = dict(_quote_cache["data"])
        merged.update(out)
        _quote_cache.update({"ts": time.time(), "data": merged})

    return {
        "ok": True,
        "quotes": out,
        "count": len(out),
        "requested": len(uniq),
        "missing": [s for s in uniq if s not in out],
        "errors": errors,
        "fetched_at": datetime.now(BJ).strftime("%H:%M:%S"),
    }


# --------------------------------------------------------------------------- 偏差回看
SEARCH_URL = ("https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx"
              "?m=1&key={key}")
_name_cache: dict = {}


def search_name(code: str) -> str:
    """基金名称：仅在没有持仓数据的货基/债基添加时用一次"""
    code = (code or "").strip()
    if not code:
        return ""
    with _lock:
        if code in _name_cache:
            return _name_cache[code]
    name = ""
    try:
        data = json.loads(http_text(SEARCH_URL.format(key=code), HDR_EM))
        rows = data.get("Datas") or []
        for row in rows:
            if str(row.get("CODE") or "").strip() == code:
                name = (row.get("NAME") or "").strip()
                break
        if not name and rows:
            name = (rows[0].get("NAME") or "").strip()
    except Exception:  # noqa: BLE001
        name = ""
    if name:
        with _lock:
            _name_cache[code] = name
    return name


NAV_HIST_URL = ("https://api.fund.eastmoney.com/f10/lsjz?fundCode={code}"
                "&pageIndex=1&pageSize={size}&_={ts}")
SNAP_PATH = CACHE_DIR / "snapshots.json"
MAX_SNAP_DAYS = 90
DEVIATION_DAYS = 20
CALIB_CAP = 1.5            # 校准系数上限（百分点）

_hist_cache: dict = {"ts": 0.0, "data": {}}


def fetch_nav_history(code: str, size: int = 40, force: bool = False) -> list[dict]:
    """近 N 条净值记录（含每日涨跌幅 JZZZL），用于偏差比对"""
    with _lock:
        ts = _hist_cache["ts"]
        cached = _hist_cache["data"].get(code)
    if cached and not force and (time.time() - ts) < NAV_CACHE_SEC:
        return cached
    url = NAV_HIST_URL.format(code=code, size=size, ts=int(time.time() * 1000))
    try:
        data = json.loads(http_text(url, HDR_JJCC))
        rows = ((data.get("Data") or {}).get("LSJZList") or [])
    except Exception:  # noqa: BLE001
        return cached or []
    out = []
    for r in rows:
        try:
            nav = float(r.get("DWJZ")) if r.get("DWJZ") else None
            pct = float(r.get("JZZZL")) if r.get("JZZZL") else None
        except (TypeError, ValueError):
            continue
        out.append({"date": r.get("FSRQ") or "", "nav": nav, "pct": pct})
    with _lock:
        merged = dict(_hist_cache["data"])
        merged[code] = out
        _hist_cache.update({"ts": time.time(), "data": merged})
    return out


def _load_snaps() -> dict:
    try:
        return json.loads(SNAP_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def save_snapshots(items: list[dict]) -> int:
    """每天只保留「最后一次估算」，供收盘后与实际净值比对"""
    day = _today_key()
    now = datetime.now(BJ).strftime("%H:%M")
    snaps = _load_snaps()
    saved = 0
    for it in items:
        code = str(it.get("code") or "").strip()
        if not code:
            continue
        try:
            pct = float(it.get("pct"))
        except (TypeError, ValueError):
            continue
        per = snaps.setdefault(code, {})
        per[day] = {
            "est_pct": round(pct, 3),
            "est": round(float(it.get("est")), 4) if it.get("est") is not None else None,
            "nav_date": it.get("nav_date") or "",
            "mode": it.get("mode") or "",
            "at": now,
        }
        saved += 1
        if len(per) > MAX_SNAP_DAYS:
            for k in sorted(per.keys())[:len(per) - MAX_SNAP_DAYS]:
                per.pop(k, None)
    if saved:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = SNAP_PATH.with_name("snapshots.tmp")
        try:
            tmp.write_text(json.dumps(snaps, ensure_ascii=False), encoding="utf-8")
            tmp.replace(SNAP_PATH)
        except Exception:  # noqa: BLE001
            pass
    return saved


def get_deviation(code: str, days: int = DEVIATION_DAYS) -> dict:
    """把历史估算快照与当日实际净值涨跌幅逐日比对，给出偏差统计与校准系数"""
    code = code.strip()
    snaps = _load_snaps().get(code) or {}
    hist = fetch_nav_history(code, size=max(40, days + 10))

    rows = []
    for h in hist:
        s = snaps.get(h["date"])
        if not s or s.get("est_pct") is None or h.get("pct") is None:
            continue
        diff = round(float(h["pct"]) - float(s["est_pct"]), 3)
        rows.append({
            "date": h["date"],
            "nav_pct": round(float(h["pct"]), 3),
            "est_pct": round(float(s["est_pct"]), 3),
            "diff": diff,
            "at": s.get("at") or "",
        })
    rows.sort(key=lambda r: r["date"], reverse=True)
    recent = rows[:days]

    stats = {"n": 0, "mean_diff": None, "mae": None, "median_diff": None,
             "calib": 0.0, "ready": False}
    if recent:
        import statistics
        diffs = [r["diff"] for r in recent]
        mean_diff = sum(diffs) / len(diffs)
        mae = sum(abs(d) for d in diffs) / len(diffs)
        med = statistics.median(diffs)
        calib = max(-CALIB_CAP, min(CALIB_CAP, mean_diff))
        stats = {
            "n": len(recent),
            "mean_diff": round(mean_diff, 3),
            "mae": round(mae, 3),
            "median_diff": round(med, 3),
            "calib": round(calib, 3),
            "ready": len(recent) >= 5,
        }
    return {"ok": True, "code": code, "rows": recent, "stats": stats,
            "days": days, "cap": CALIB_CAP}


# --------------------------------------------------------------------------- 对外
def market_clock() -> dict:
    now = datetime.now(BJ)
    hm = now.hour * 100 + now.minute
    week = now.weekday()
    a_open = week < 5 and (915 <= hm <= 1130 or 1300 <= hm <= 1500)
    hk_open = week < 5 and (930 <= hm <= 1200 or 1300 <= hm <= 1600)
    us_open = week < 5 and (2130 <= hm or hm <= 400)
    return {"a": a_open, "hk": hk_open, "us": us_open,
            "now": now.strftime("%Y-%m-%d %H:%M:%S")}


if __name__ == "__main__":  # 本地自检
    import sys
    code = sys.argv[1] if len(sys.argv) > 1 else "110022"
    h = get_holdings(code)
    print(json.dumps({k: h[k] for k in ("report_date", "sum_weight", "single_etf")}, ensure_ascii=False))
    for it in h["items"]:
        print(it["symbol"], it["name"], it["weight"])
    q = get_quotes([i["symbol"] for i in h["items"]])
    print(json.dumps(q, ensure_ascii=False)[:800])
    print(json.dumps(get_navs([code]), ensure_ascii=False))
