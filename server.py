#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A股连板梯队与情绪监测 · 实时数据服务
零第三方依赖（仅 Python 标准库），为 Windows 桌面 App / iPhone 主屏 App / iOS 壳提供数据。

数据源：东方财富公开行情接口（无需 API Key），逐项口径见 config.json 与页面「数据口径」区块。
所有数值均为接口实时返回值，缺失时显式标记 unavailable，不做任何推测填充。
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import mimetypes
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qs
from urllib.request import Request, urlopen

import fund as fundmod
import news as newsmod
import us as usmod

# 桌面 exe（PyInstaller）里 __file__ 在临时解包目录，资源根由 ASHARE_BASE 指定
BASE = Path(os.environ.get("ASHARE_BASE") or Path(__file__).resolve().parent).resolve()
WEB = BASE / "web"
CONFIG_PATH = BASE / "config.json"
BJ = timezone(timedelta(hours=8))

UT = "bd1d9ddb04089700cf9c27f6f7426281"
UT_EX = "7eea3edcaed734bea9cbfc24409ed989"
HOSTS = ["push2.eastmoney.com", "push2delay.eastmoney.com", "82.push2.eastmoney.com"]
FS_HS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"  # 沪深 A 股，不含北交所
FS_ALL = FS_HS + ",m:0+t:81+s:2048"          # 含北交所，用于全市场涨跌家数
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://quote.eastmoney.com/",
    "Accept-Encoding": "identity",
    "Connection": "close",
}

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CFG = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
_bad_hosts: dict[str, float] = {}
_lock = threading.Lock()
_snapshot_cache = {"ts": 0.0, "data": None}
_quote_cache = {"ts": 0.0, "rows": None, "host": None, "mode": None, "warnings": []}
_prev_cache = {"date": None, "value": None, "ts": 0.0}


# --------------------------------------------------------------------------- 网络层
def http_json(url: str, timeout: float = 8.0, retries: int = 2) -> dict:
    last = None
    for i in range(retries):
        try:
            req = Request(url, headers=HEADERS)
            with urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
            return json.loads(raw.decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001
            last = exc
            if i + 1 < retries:
                time.sleep(0.2 * (i + 1))
    if last is None:
        raise RuntimeError("request failed")
    raise last


def em_url(host: str, path: str, params: dict) -> str:
    return "https://" + host + path + "?" + urlencode(params, safe="+:,")


def em_get(path: str, params: dict, timeout: float = 8.0) -> tuple[dict, str]:
    """按 HOSTS 顺序尝试；某个 (主机, 接口) 组合失败后短时间内直接跳过。
    注意按接口分开冷却：clist 被限流不代表 ulist 也不可用。"""
    last = None
    for host in HOSTS:
        key = host + "|" + path
        if _bad_hosts.get(key, 0) > time.time():
            continue
        try:
            data = http_json(em_url(host, path, params), timeout=timeout, retries=1)
            if isinstance(data, dict):
                return data, host
        except Exception as exc:  # noqa: BLE001
            last = exc
            _bad_hosts[key] = time.time() + 180
    raise RuntimeError(f"所有行情主机均不可用: {type(last).__name__ if last else 'unknown'}")


def tencent_quote(codes: list[str]) -> list[dict]:
    """腾讯行情原始块解析：[{code,price,chg,pct,amount,volume}]"""
    url = "https://qt.gtimg.cn/q=" + ",".join(codes)
    try:
        req = Request(url, headers={"User-Agent": HEADERS["User-Agent"], "Referer": "https://gu.qq.com/"})
        with urlopen(req, timeout=8) as resp:
            text = resp.read().decode("gbk", "replace")
    except Exception:  # noqa: BLE001
        return []
    out = []
    for line in text.split(";"):
        if "=" not in line or '"' not in line:
            continue
        body = line.split('"')[1] if line.count('"') >= 2 else ""
        parts = body.split("~")
        if len(parts) < 10:
            continue
        code = parts[2].strip()
        def num(idx):
            try:
                return float(parts[idx])
            except (ValueError, IndexError):
                return None
        price, chg, pct = num(3), num(4), num(5)
        # s_ 简洁接口：[6]=成交量(手) [7]=成交额(万元) [9]=成交额(万元) 兜底
        amount_wan = num(7) or num(9) or 0.0
        out.append({"code": code, "name": parts[1].strip(), "price": price,
                    "chg": chg, "pct": pct, "volume": num(6),
                    "amount": amount_wan * 1e4})
    return out


def sina_index_quote(codes: list[str]) -> list[dict]:
    """新浪指数兜底：sh000001 / sz399001 ..."""
    url = "https://hq.sinajs.cn/list=" + ",".join(codes)
    try:
        req = Request(url, headers={"User-Agent": HEADERS["User-Agent"],
                                    "Referer": "https://finance.sina.com.cn/"})
        with urlopen(req, timeout=8) as resp:
            text = resp.read().decode("gbk", "replace")
    except Exception:  # noqa: BLE001
        return []
    out = []
    for line in text.split(";"):
        if '"' not in line:
            continue
        key = line.split("=")[0].strip().replace("var hq_str_", "")
        body = line.split('"')[1]
        parts = body.split(",") if body else []
        if len(parts) < 10:
            continue
        try:
            price = float(parts[3]); prev = float(parts[2])
            chg = price - prev
            pct = (chg / prev * 100) if prev else None
            amount = float(parts[9] or 0)
        except (ValueError, IndexError):
            continue
        out.append({"code": key[2:], "name": parts[0], "price": price, "chg": chg,
                    "pct": pct, "volume": None, "amount": amount})
    return out


def pool_get(endpoint: str, date: str, pagesize: int = 400) -> tuple[int, list, object]:
    params = {
        "ut": UT_EX, "dpt": "wz.ztzt", "Pageindex": 0,
        "pagesize": pagesize, "sort": "fbt:asc", "date": date,
    }
    url = "https://push2ex.eastmoney.com/" + endpoint + "?" + urlencode(params, safe="+:,")
    data = http_json(url, timeout=10, retries=2)
    d = data.get("data") or {}
    return int(d.get("tc") or 0), (d.get("pool") or []), d.get("qdate")


def clist_page(host: str, pn: int, pz: int) -> tuple[list, int]:
    params = {
        "pn": pn, "pz": pz, "po": 1, "np": 1, "ut": UT, "fltt": 2, "invt": 2,
        "fid": "f3", "fs": FS_ALL if CFG["filters"].get("breadth_include_bj", True) else FS_HS,
        "fields": "f2,f3,f6,f12,f13,f14",
    }
    data = http_json(em_url(host, "/api/qt/clist/get", params), timeout=4, retries=1)
    d = data.get("data") or {}
    return (d.get("diff") or []), int(d.get("total") or 0)


def fetch_quotes_sina() -> tuple[list, str, str, list]:
    """东财 clist 不可用时的兜底：走新浪全市场分页接口，**抓全量**而不是抽样。
    新浪每页上限 100 条，全 A 约 56 页，12 线程并发约 2~3 秒，数据完整。
    只有确实有页抓不到、覆盖率不足 95% 时，才按比例估算并打 estimated 标记。"""
    warnings: list[str] = []
    node = "hs_a"
    per = 100
    try:
        count_raw = http_text_plain(
            "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
            f"Market_Center.getHQNodeStockCount?node={node}")
        total = int(str(count_raw).strip().strip('"') or 0)
    except Exception:  # noqa: BLE001
        total = 0

    def one(pn: int):
        url = ("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/"
               f"Market_Center.getHQNodeData?page={pn}&num={per}&sort=symbol&asc=1&node={node}"
               "&symbol=&_s_r_a=page")
        txt = http_text_plain(url, referer="https://vip.stock.finance.sina.com.cn/")
        return json.loads(txt)

    rows: list[dict] = []
    failed: list[int] = []
    pages = max(1, math.ceil(total / per)) if total else 60

    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = {pool.submit(one, pn): pn for pn in range(1, pages + 1)}
        for fut in as_completed(futures):
            try:
                part = fut.result()
                if isinstance(part, list):
                    rows.extend(part)
            except Exception:  # noqa: BLE001
                failed.append(futures[fut])

    # 失败页串行补拉一次
    for pn in failed:
        try:
            part = one(pn)
            if isinstance(part, list):
                rows.extend(part)
        except Exception:  # noqa: BLE001
            pass

    mapped: list[dict] = []
    seen: set = set()
    for r in rows:
        try:
            pct = float(r.get("changepercent"))
        except (TypeError, ValueError):
            continue
        code = str(r.get("code") or "")
        if not code or code in seen:
            continue
        seen.add(code)
        sym = str(r.get("symbol") or "")
        market = 1 if sym.startswith("sh") else 0
        mapped.append({
            "f12": code, "f13": market,
            "f14": r.get("name"), "f2": r.get("trade"), "f3": pct,
            "f6": None,
        })
    if not mapped:
        raise RuntimeError("新浪全市场行情不可用")

    est = int(total) if total else len(mapped)
    if est and len(mapped) < est * 0.95:
        warnings.append(
            f"新浪全市场抓取 {len(mapped)}/{est} 只（{len(failed)} 页缺失），家数按实测计数")
        return mapped, "vip.stock.finance.sina.com.cn", "sina_partial", warnings

    warnings.append(f"东财 clist 不可用，已改用新浪全市场接口取全量 {len(mapped)} 只（家数为真实计数）")
    return mapped, "vip.stock.finance.sina.com.cn", "sina_full", warnings


def http_text_plain(url: str, referer: str | None = None, timeout: float = 8.0) -> str:
    hdr = {"User-Agent": HEADERS["User-Agent"], "Accept": "*/*",
           "Accept-Language": "zh-CN,zh;q=0.9", "Connection": "close"}
    if referer:
        hdr["Referer"] = referer
    req = Request(url, headers=hdr)
    with urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def fetch_quotes() -> tuple[list, str, str, list]:
    """全市场涨跌家数：优先一次性拉全量，失败则分页并发（延时主机每页上限 100），
    东财全系列不可用时退回新浪抽样估算。"""
    warnings: list[str] = []
    conn_fail = 0
    for host in HOSTS:
        key = host + "|/api/qt/clist/get"
        if _bad_hosts.get(key, 0) > time.time():
            continue
        try:
            rows, total = clist_page(host, 1, 6000)
            if total > 1000 and len(rows) >= total * 0.9:
                return rows, host, "single", warnings
            warnings.append(f"{host} 单次仅返回 {len(rows)}/{total} 条，改用分页")
            break
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"{host} 全量行情不可用（{type(exc).__name__}）")
            _bad_hosts[key] = time.time() + 180
            conn_fail += 1
            # 同一 IP 被限流时三个主机通常同时断，探测一次就够，省掉首屏等待
            if conn_fail >= 1 and isinstance(exc, (OSError,)) :
                for other in HOSTS:
                    _bad_hosts[other + "|/api/qt/clist/get"] = time.time() + 180
                break

    host = "push2delay.eastmoney.com"
    key_delay = host + "|/api/qt/clist/get"
    paged_ok = False
    rows: list = []
    total = 0
    try:
        rows, total = clist_page(host, 1, 100)
        paged_ok = bool(total)
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"延时行情全量不可用（{type(exc).__name__}）")
        _bad_hosts[key_delay] = time.time() + 180

    if paged_ok and total:
        pages = max(1, math.ceil(total / 100))
        failed: list[int] = []

        def one(pn: int):
            return pn, clist_page(host, pn, 100)[0]

        with ThreadPoolExecutor(max_workers=10) as pool:
            futures = {pool.submit(one, pn): pn for pn in range(2, pages + 1)}
            for fut in as_completed(futures):
                try:
                    _, part = fut.result()
                    rows.extend(part)
                except Exception:  # noqa: BLE001
                    failed.append(futures[fut])

        # 对失败页串行补拉一次，避免涨跌家数出现偏差
        for pn in failed:
            try:
                _, part = one(pn)
                rows.extend(part)
            except Exception:  # noqa: BLE001
                pass

        seen, uniq = set(), []
        for row in rows:
            key = (row.get("f12"), row.get("f13"))
            if key not in seen:
                seen.add(key)
                uniq.append(row)
        if failed:
            warnings.append(f"{len(failed)} 页补拉仍失败，家数为实际抓到的计数")
        if uniq:
            if total and len(uniq) < total * 0.95:
                warnings.append(f"行情覆盖 {len(uniq)}/{total}（{round(len(uniq)/total*100)}%），家数按实测计数")
            return uniq, host, "paged", warnings

    # 东财 clist 全线不可用 → 新浪全市场兜底
    samples, sina_host, mode, swarns = fetch_quotes_sina()
    return samples, sina_host, mode, warnings + swarns


# --------------------------------------------------------------------------- 离线快照
# 任何一路实时接口失败时，回落到「本机最近一次成功抓到的真实数据」，并在页面标注
# 数据时点；永远不用比例放大之类的估算值冒充实时计数。
CACHE_DIR = BASE / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
CACHE_TTL = 6 * 3600


def cache_put(name: str, data: dict) -> None:
    try:
        payload = {"at": datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S"), "data": data}
        (CACHE_DIR / f"{name}.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def cache_get(name: str, max_age: float = CACHE_TTL) -> dict | None:
    try:
        p = CACHE_DIR / f"{name}.json"
        if not p.exists():
            return None
        payload = json.loads(p.read_text(encoding="utf-8"))
        at = datetime.strptime(payload.get("at", ""), "%Y-%m-%d %H:%M:%S").replace(tzinfo=BJ)
        if (datetime.now(BJ) - at).total_seconds() > max_age:
            return None
        return {"at": payload.get("at"), "data": payload.get("data") or {}}
    except Exception:  # noqa: BLE001
        return None


def breadth_stats(rows: list) -> dict:
    """由行情行算出涨跌家数（只数真实抓到的，不放大）。"""
    clean = [r for r in rows if not r.get("__market_total")]
    numeric = [r for r in clean if isinstance(r.get("f3"), (int, float))]
    if not clean:
        raise RuntimeError("无有效行情")
    up = sum(1 for r in numeric if r["f3"] > 0)
    down = sum(1 for r in numeric if r["f3"] < 0)
    flat = sum(1 for r in numeric if r["f3"] == 0)
    return {
        "up": up, "down": down, "flat": flat,
        "suspended": len(clean) - len(numeric),
        "quote_count": len(clean),
    }



def get_quotes() -> tuple[list, str, str, list]:
    ttl = int(CFG["server"]["quotes_cache_seconds"])
    with _lock:
        if _quote_cache["rows"] and time.time() - _quote_cache["ts"] < ttl:
            return (_quote_cache["rows"], _quote_cache["host"],
                    _quote_cache["mode"], list(_quote_cache["warnings"]))
    rows, host, mode, warns = fetch_quotes()
    with _lock:
        _quote_cache.update({"ts": time.time(), "rows": rows, "host": host,
                             "mode": mode, "warnings": warns})
    return rows, host, mode, warns


def fetch_indices() -> tuple[list, str]:
    """指数与成交额：腾讯最稳 → 东财 ulist.np → 新浪，三源依次回落。"""
    codes = [("s_sh000001", "000001"), ("s_sz399001", "399001"),
             ("s_sz399006", "399006"), ("s_sh000688", "000688"),
             ("s_bj899050", "899050")]
    got = tencent_quote([c for c, _ in codes])
    if len(got) >= 3:
        rows = [{"f12": r["code"], "f13": 1 if r["code"].startswith(("0000", "68")) else 0,
                 "f14": r["name"], "f2": r["price"], "f3": r["pct"],
                 "f4": r["chg"], "f6": r["amount"]} for r in got]
        return rows, "腾讯 qt.gtimg.cn"

    params = {
        "fltt": 2, "invt": 2, "ut": UT,
        "secids": "1.000001,0.399001,0.399006,1.000688,0.899050",
        "fields": "f2,f3,f4,f6,f12,f13,f14",
    }
    try:
        data, host = em_get("/api/qt/ulist.np/get", params)
        rows = (data.get("data") or {}).get("diff") or []
        if rows:
            return rows, host
    except Exception:  # noqa: BLE001
        pass

    sina = sina_index_quote(["sh000001", "sz399001", "sz399006", "sh000688", "bj899050"])
    if sina:
        rows = [{"f12": r["code"], "f13": 1 if r["code"].startswith(("0000", "68")) else 0,
                 "f14": r["name"], "f2": r["price"], "f3": r["pct"],
                 "f4": r["chg"], "f6": r["amount"]} for r in sina]
        return rows, "新浪 hq.sinajs.cn"
    raise RuntimeError("指数三源均不可用")


def find_prev_pool(today: str) -> tuple[str | None, int, list]:
    cur = datetime.strptime(today, "%Y%m%d")
    for i in range(1, 12):
        day = cur - timedelta(days=i)
        if day.weekday() >= 5:
            continue
        ds = day.strftime("%Y%m%d")
        try:
            tc, rows, _ = pool_get("getTopicZTPool", ds, 400)
            if tc > 0 and rows:
                return ds, tc, rows
        except Exception:  # noqa: BLE001
            continue
    return None, 0, []


def get_prev_pool(today: str) -> tuple[str | None, int, list]:
    """前一交易日数据是历史快照，按日缓存，避免重复请求造成数值跳动。"""
    with _lock:
        if _prev_cache["date"] == today and _prev_cache["value"] and \
                time.time() - _prev_cache["ts"] < 3600:
            return _prev_cache["value"]
    value = find_prev_pool(today)
    with _lock:
        _prev_cache.update({"date": today, "value": value, "ts": time.time()})
    return value


# --------------------------------------------------------------------------- 计算层
def is_st(name: str) -> bool:
    return "ST" in str(name).upper()


def is_bj(code: str) -> bool:
    c = str(code)
    return c.startswith(("8", "4", "92"))


def fmt_time(v) -> str:
    s = str(int(v or 0)).zfill(6)
    return f"{s[:2]}:{s[2:4]}:{s[4:6]}"


def market_status(now: datetime) -> str:
    if now.weekday() >= 5:
        return "休市"
    hm = now.strftime("%H:%M")
    if "09:15" <= hm < "09:30":
        return "集合竞价"
    if "09:30" <= hm < "11:30" or "13:00" <= hm < "15:00":
        return "盘中"
    if hm >= "15:00":
        return "已收盘"
    return "盘前"


def calc_score(metrics: dict) -> dict:
    weights = CFG["score"]["weights"]
    caps = CFG["score"]["caps"]
    labels = CFG["score"]["labels"]
    factors, total = [], 0.0
    for key, weight in weights.items():
        raw = metrics.get(key)
        if raw is None:
            factors.append({"key": key, "name": labels[key], "weight": weight,
                            "raw": None, "sub": None, "contrib": None})
            continue
        cap = float(caps[key]) or 1.0
        base = (1.0 - raw) if key == "zhaban_neg" else raw
        sub = max(0.0, min(100.0, base / cap * 100.0))
        contrib = round(sub * weight, 2)
        total += contrib
        factors.append({"key": key, "name": labels[key], "weight": weight,
                        "raw": round(float(raw), 6), "sub": round(sub, 1),
                        "contrib": contrib})
    return {"score": round(total, 1), "factors": factors}


def build_snapshot() -> dict:
    started = time.time()
    now = datetime.now(BJ)
    today = now.strftime("%Y%m%d")
    warnings: list[str] = []

    with ThreadPoolExecutor(max_workers=6) as pool:
        fq = pool.submit(get_quotes)
        fzt = pool.submit(pool_get, "getTopicZTPool", today, 400)
        fzb = pool.submit(pool_get, "getTopicZBPool", today, 400)
        fdt = pool.submit(pool_get, "getTopicDTPool", today, 400)
        fidx = pool.submit(fetch_indices)
        fprev = pool.submit(get_prev_pool, today)

    def safe(fut, label, default):
        try:
            return fut.result()
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"{label} 获取失败：{type(exc).__name__}")
            return default

    quotes, quote_host, quote_mode, qwarns = safe(
        fq, "全市场行情", ([], None, None, ["全市场行情不可用"]))
    warnings.extend(qwarns)
    zt_total, zt_pool, qdate = safe(fzt, "涨停池", (0, [], None))
    zb_total, zb_pool, _ = safe(fzb, "炸板池", (0, [], None))
    dt_total, _, _ = safe(fdt, "跌停池", (0, [], None))
    indices, index_host = safe(fidx, "指数行情", ([], None))
    prev_date, prev_total, prev_pool = safe(fprev, "昨日涨停池", (None, 0, []))

    # 涨停池 / 炸板池 / 跌停池 / 指数：接口失败时回落本机最近一次成功快照
    if zt_pool:
        cache_put("pool_zt_" + today, {"tc": zt_total, "pool": zt_pool, "qdate": qdate})
    else:
        cached = cache_get("pool_zt_" + today, 1800)
        if cached:
            zt_total = cached["data"].get("tc") or 0
            zt_pool = cached["data"].get("pool") or []
            qdate = cached["data"].get("qdate")
            warnings.append(f"涨停池接口不可用，取 {cached['at']} 的快照")
    if zb_total:
        cache_put("pool_zb_" + today, {"tc": zb_total})
    else:
        cached = cache_get("pool_zb_" + today, 1800)
        if cached:
            zb_total = cached["data"].get("tc") or 0
            warnings.append(f"炸板池接口不可用，取 {cached['at']} 的快照")
    if dt_total:
        cache_put("pool_dt_" + today, {"tc": dt_total})
    else:
        cached = cache_get("pool_dt_" + today, 1800)
        if cached:
            dt_total = cached["data"].get("tc") or 0
            warnings.append(f"跌停池接口不可用，取 {cached['at']} 的快照")
    if indices:
        cache_put("indices", {"rows": [{"code": r.get("f12"), "name": r.get("f14"),
                                        "value": r.get("f2"), "pct": r.get("f3"),
                                        "chg": r.get("f4"), "amount": r.get("f6")}
                                       for r in indices], "host": index_host})
    else:
        cached = cache_get("indices", 1800)
        if cached:
            indices = [{"f12": r["code"], "f14": r["name"], "f2": r["value"],
                        "f3": r["pct"], "f4": r["chg"], "f6": r["amount"]}
                       for r in (cached["data"].get("rows") or [])]
            index_host = "%s（%s 快照）" % (cached["data"].get("host") or "缓存", cached["at"])
            warnings.append(f"指数接口不可用，取 {cached['at']} 的快照")

    flt = CFG["filters"]

    def keep(row):
        if flt["exclude_st"] and is_st(row.get("n", "")):
            return False
        if flt["exclude_bj"] and is_bj(row.get("c", "")):
            return False
        return True

    clean = [r for r in zt_pool if keep(r)]
    prev_clean = [r for r in prev_pool if keep(r)]

    # 涨跌家数：只用真实抓到的行情计数；抓不到就回落本机上次成功的快照（标 stale）
    breadth_src_at, breadth_stale = None, False
    try:
        stats = breadth_stats(quotes)
        up, down = stats["up"], stats["down"]
        flat, suspended = stats["flat"], stats["suspended"]
        quote_count = stats["quote_count"]
        cache_put("breadth", stats)
    except Exception:  # noqa: BLE001
        cached = cache_get("breadth")
        if cached:
            stats = cached["data"]
            up, down = stats.get("up"), stats.get("down")
            flat, suspended = stats.get("flat"), stats.get("suspended")
            quote_count = stats.get("quote_count")
            breadth_src_at, breadth_stale = cached["at"], True
            warnings.append(f"实时行情不可用，涨跌家数取自 {cached['at']} 的快照（非实时）")
        else:
            up = down = flat = suspended = quote_count = None
            warnings.append("全市场行情接口不可用，且本机无可用快照，涨跌家数显示 —（不填 0）")

    idx_by_code = {str(r.get("f12")): r for r in indices}

    def amount(code):
        v = (idx_by_code.get(code) or {}).get("f6")
        return float(v) if isinstance(v, (int, float)) else 0.0

    sh, sz, bj = amount("000001"), amount("399001"), amount("899050")
    amount_hs = (sh + sz) / 1e8
    amount_hsbj = (sh + sz + bj) / 1e8

    max_board = max((int(r.get("lbc") or 1) for r in clean), default=0)
    t2 = sum(1 for r in clean if int(r.get("lbc") or 1) == 2)
    t3 = sum(1 for r in clean if int(r.get("lbc") or 1) == 3)
    t4 = sum(1 for r in clean if int(r.get("lbc") or 1) >= 4)
    y1 = sum(1 for r in prev_clean if int(r.get("lbc") or 1) == 1)
    y2 = sum(1 for r in prev_clean if int(r.get("lbc") or 1) == 2)
    y3 = sum(1 for r in prev_clean if int(r.get("lbc") or 1) >= 3)

    p12 = (t2 / y1) if y1 else None
    p23 = (t3 / y2) if y2 else None
    high_fb = (t4 / y3) if y3 else None
    zhaban_rate = zb_total / (zt_total + zb_total) if (zt_total + zb_total) else None
    zt_ratio = (zt_total / up) if up else None

    metrics = {
        "zt_count": zt_total,
        "zt_ratio": zt_ratio,
        "max_board": max_board,
        "promote_1to2": p12,
        "zhaban_neg": zhaban_rate,
        "high_feedback": high_fb,
    }
    gauge = calc_score(metrics)

    groups: dict[int, list] = {}
    for r in clean:
        groups.setdefault(int(r.get("lbc") or 1), []).append(r)
    ladder = []
    for board in sorted(groups.keys(), reverse=True):
        rows = []
        for r in sorted(groups[board], key=lambda x: int(x.get("fbt") or 0)):
            zttj = r.get("zttj") or {}
            rows.append({
                "name": r.get("n"), "code": r.get("c"),
                "chg": round(float(r.get("zdp") or 0), 2),
                "price": round(float(r.get("p") or 0) / 1000, 2),
                "seal": fmt_time(r.get("fbt")), "last_seal": fmt_time(r.get("lbt")),
                "broken": int(r.get("zbc") or 0),
                "stat": f"{zttj.get('days', '-')}/{zttj.get('ct', '-')}",
                "turnover": round(float(r.get("hs") or 0), 2),
                "industry": r.get("hybk") or "—",
                "fund": r.get("fund"), "amount": r.get("amount"),
            })
        ladder.append({"board": board, "count": len(rows), "rows": rows})

    from collections import Counter
    industries = [{"name": k, "count": v}
                  for k, v in Counter(r.get("hybk") or "—" for r in clean).most_common(8)]

    index_rows = [{
        "name": r.get("f14"), "code": r.get("f12"),
        "value": r.get("f2"), "change": r.get("f3"),
    } for r in indices if r.get("f14")]

    trade_date = str(qdate or today)
    return {
        "ok": True,
        "generated_at": now.strftime("%Y-%m-%d %H:%M:%S"),
        "trade_date": trade_date,
        "market_status": market_status(now),
        "market": {
            "up": up, "down": down, "flat": flat, "suspended": suspended,
            "quote_count": quote_count, "estimated": False,
            "source_at": breadth_src_at, "stale": breadth_stale,
            "zt_total": zt_total, "zt_filtered": len(clean),
            "dt_total": dt_total, "zb_total": zb_total,
            "touch_total": zt_total + zb_total,
            "zhaban_rate": zhaban_rate, "promote_1to2": p12, "promote_2to3": p23,
            "high_feedback": high_fb, "max_board": max_board,
            "zt_ratio": zt_ratio, "amount_hs_yi": round(amount_hs, 2),
            "amount_hsbj_yi": round(amount_hsbj, 2),
            "prev_date": prev_date, "prev_zt_total": prev_total,
        },
        "indices": index_rows,
        "gauge": gauge,
        "ladder": ladder,
        "industries": industries,
        "sources": {
            "quote_host": quote_host, "quote_mode": quote_mode,
            "index_host": index_host,
            "endpoints": [
                "push2(或 push2delay).eastmoney.com /api/qt/clist/get — 全A涨跌家数",
                "push2(或 push2delay).eastmoney.com /api/qt/ulist.np/get — 指数与成交额",
                "push2ex.eastmoney.com /getTopicZTPool — 涨停池 / 连板梯队",
                "push2ex.eastmoney.com /getTopicZBPool — 炸板池",
                "push2ex.eastmoney.com /getTopicDTPool — 跌停池",
                f"push2ex.eastmoney.com /getTopicZTPool?date={prev_date or '前一交易日'} — 晋级率分母",
            ],
        },
        "config": {"exclude_st": flt["exclude_st"], "exclude_bj": flt["exclude_bj"],
                   "weights": CFG["score"]["weights"], "caps": CFG["score"]["caps"]},
        "warnings": warnings,
        "elapsed_ms": int((time.time() - started) * 1000),
    }


# --------------------------------------------------------------------------- HTTP 层
MIME = {
    ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "AshareMonitor/1.0"

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path):
        if not path.is_file():
            self.send_error(404)
            return
        ext = path.suffix.lower()
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, mimetypes.guess_type(str(path))[0] or "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        if ext in (".html", ".js", ".css"):
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        """App 内(file://)跨域访问本机服务时，POST JSON 前会先发预检。"""
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            self._json({"ok": True, "time": datetime.now(BJ).strftime("%Y-%m-%d %H:%M:%S")})
            return
        if path == "/api/snapshot":
            force = parse_qs(parsed.query).get("force", ["0"])[0] == "1"
            ttl = int(CFG["server"]["cache_seconds"])
            with _lock:
                cached = _snapshot_cache["data"]
                fresh = cached and (time.time() - _snapshot_cache["ts"] < ttl)
            if fresh and not force:
                self._json(cached)
                return
            try:
                data = build_snapshot()
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)
                return
            with _lock:
                _snapshot_cache.update({"ts": time.time(), "data": data})
            self._json(data)
            return
        if path in ("/fund", "/fund/"):
            self._file(WEB / "fund.html")
            return
        if path == "/api/fund/holdings":
            qs = parse_qs(parsed.query)
            code = (qs.get("code", [""])[0] or "").strip()
            if not code:
                self._json({"ok": False, "error": "缺少 code 参数"}, 400)
                return
            force = qs.get("force", ["0"])[0] == "1"
            try:
                self._json({"ok": True, **fundmod.get_holdings(code, force)})
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "code": code,
                            "error": f"{type(exc).__name__}: {exc}"}, 200)
            return
        if path == "/api/fund/quotes":
            qs = parse_qs(parsed.query)
            raw = (qs.get("symbols", [""])[0] or "").strip()
            symbols = [s for s in raw.replace(" ", "").split(",") if s][:400]
            force = qs.get("force", ["0"])[0] == "1"
            try:
                self._json(fundmod.get_quotes(symbols, force))
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 200)
            return
        if path == "/api/fund/nav":
            qs = parse_qs(parsed.query)
            raw = (qs.get("codes", [""])[0] or "").strip()
            codes = [c for c in raw.replace(" ", "").split(",") if c][:60]
            force = qs.get("force", ["0"])[0] == "1"
            try:
                self._json(fundmod.get_navs(codes, force))
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 200)
            return
        if path == "/api/fund/name":
            code = (parse_qs(parsed.query).get("code", [""])[0] or "").strip()
            if not code:
                self._json({"ok": False, "error": "缺少 code 参数"}, 400)
                return
            try:
                name = fundmod.search_name(code)
            except Exception as exc:  # noqa: BLE001
                name = ""
            self._json({"ok": bool(name), "code": code, "name": name})
            return
        if path == "/api/fund/deviation":
            qs = parse_qs(parsed.query)
            code = (qs.get("code", [""])[0] or "").strip()
            if not code:
                self._json({"ok": False, "error": "缺少 code 参数"}, 400)
                return
            try:
                days = int(qs.get("days", ["20"])[0])
            except ValueError:
                days = 20
            days = max(3, min(60, days))
            try:
                self._json(fundmod.get_deviation(code, days))
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "code": code,
                            "error": f"{type(exc).__name__}: {exc}"}, 200)
            return
        if path == "/api/fund/market":
            self._json({"ok": True, **fundmod.market_clock()})
            return
        if path == "/api/us/dashboard":
            qs = parse_qs(parsed.query)
            force = qs.get("force", ["0"])[0] == "1"
            try:
                self._json(usmod.dashboard(force))
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 200)
            return
        if path == "/api/us/quotes":
            qs = parse_qs(parsed.query)
            raw = (qs.get("symbols", [""])[0] or "usDJI,usIXIC,usINX,usVIX").strip()
            symbols = [s for s in raw.replace(" ", "").split(",") if s][:60]
            try:
                self._json(usmod.get_quotes(symbols))
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 200)
            return
        if path == "/api/news/list":
            qs = parse_qs(parsed.query)
            src = (qs.get("src", ["ths"])[0] or "ths").strip()
            force = qs.get("force", ["0"])[0] == "1"
            try:
                if src in ("all", "mixed"):
                    self._json(newsmod.merged(force))
                else:
                    self._json(newsmod.list_news(src, force))
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": f"{type(exc).__name__}: {exc}", "list": []}, 200)
            return
        if path in ("/us", "/us/"):
            self._file(WEB / "us.html")
            return
        if path in ("/news", "/news/"):
            self._file(WEB / "news.html")
            return
        if path in ("/app", "/app/"):
            # 旧的四 Tab iframe 壳已废弃，统一跳到基金页
            self._file(WEB / "fund.html")
            return
        rel = path.lstrip("/") or "index.html"
        target = (WEB / rel).resolve()
        if WEB.resolve() not in target.parents and target != WEB.resolve():
            self.send_error(403)
            return
        if target.is_dir():
            target = target / "index.html"
        self._file(target)

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/fund/snap":
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            raw = self.rfile.read(length) if length else b"{}"
            try:
                payload = json.loads(raw.decode("utf-8", "replace") or "{}")
            except Exception:  # noqa: BLE001
                self._json({"ok": False, "error": "请求体不是合法 JSON"}, 400)
                return
            items = payload.get("items")
            if not isinstance(items, list):
                self._json({"ok": False, "error": "items 必须是数组"}, 400)
                return
            try:
                saved = fundmod.save_snapshots(items[:60])
            except Exception as exc:  # noqa: BLE001
                self._json({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)
                return
            self._json({"ok": True, "saved": saved})
            return
        self._json({"ok": False, "error": "not found"}, 404)


class FundHTTPServer(ThreadingHTTPServer):
    """Windows 下禁用 SO_REUSEADDR，避免端口被占用时仍"绑定成功"造成假监听"""
    allow_reuse_address = (sys.platform != "win32")
    daemon_threads = True


def port_usable(port: int) -> bool:
    """确认端口真的空闲：先试着连（有人监听就算占用），再试 bind。

    Windows 上 SO_REUSEADDR 会让 bind 假成功，所以先做一次连接探测，
    否则会和已在跑的服务抢同一个端口，出现「两个进程监听 8765、请求随机落到其中一边」。
    """
    import socket
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(0.4)
    try:
        probe.connect(("127.0.0.1", port))
        return False
    except OSError:
        pass
    finally:
        probe.close()

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(description="A股情绪监测实时数据服务")
    ap.add_argument("--host", default=CFG["server"]["bind"])
    ap.add_argument("--port", type=int, default=CFG["server"]["port"])
    args = ap.parse_args()

    server = None
    for port in range(args.port, args.port + 6):
        if not port_usable(port):
            print(f"端口 {port} 被占用，尝试下一个…", flush=True)
            continue
        try:
            server = FundHTTPServer((args.host, port), Handler)
            break
        except OSError:
            print(f"端口 {port} 绑定失败，尝试下一个…", flush=True)
    if server is None:
        raise SystemExit("候选端口全部被占用，请用 --port 指定")
    port = server.server_address[1]
    try:
        (BASE / "runtime_port.txt").write_text(str(port), encoding="utf-8")
    except OSError:
        pass

    print(f"数据服务已启动: http://127.0.0.1:{port}", flush=True)
    print(f"  情绪监测  http://127.0.0.1:{port}/", flush=True)
    print(f"  基金估值  http://127.0.0.1:{port}/fund", flush=True)
    print(f"局域网/手机访问: http://<本机IP>:{port}  (绑定 {args.host})", flush=True)
    print("按 Ctrl+C 退出", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
