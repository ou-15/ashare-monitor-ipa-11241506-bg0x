# -*- coding: utf-8 -*-
"""美股数据层：三大指数、VIX、涨跌家数、个股行情、自建情绪分。

数据源（均实测可用）：
- 指数：东财 push2 ulist.np（CORS=*），失败回落腾讯 qt.gtimg.cn
- VIX：Cboe 官方日线 CSV（收盘粒度）
- 个股：腾讯 qt.gtimg.cn（GBK，与 A 股同域名）
"""
import gzip
import json
import time
import urllib.request
from datetime import datetime

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0 Safari/537.36")

IDX = [("DJIA", "道琼斯", "100.DJIA"), ("NDX", "纳斯达克", "100.NDX"), ("SPX", "标普 500", "100.SPX")]
VIX_URL = "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv"

_cache = {}
_br_cool = {"ts": 0, "err": ""}


def _cached(key, ttl, fn, force=False):
    now = time.time()
    if not force and key in _cache and now - _cache[key][0] < ttl:
        return _cache[key][1]
    val = fn()
    _cache[key] = (now, val)
    return val


def _http(url, referer=None, timeout=15):
    headers = {
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }
    if referer:
        headers["Referer"] = referer
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return raw
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(0.6 + attempt * 0.8)   # 东财偶发 RemoteDisconnected，退避重试
    raise last


def _json(url, referer=None, timeout=15):
    return json.loads(_http(url, referer, timeout).decode("utf-8", "replace"))


def _gbk(url, referer=None, timeout=15):
    return _http(url, referer, timeout).decode("gbk", "replace")


def _f(x, default=None):
    try:
        v = float(x)
        return v
    except (TypeError, ValueError):
        return default


# ---------------- 指数 ----------------
def _indexes_east():
    secids = ",".join(s for _, _, s in IDX)
    url = ("https://push2.eastmoney.com/api/qt/ulist.np/get?secids=" + secids +
           "&fields=f1,f2,f3,f4,f12,f13,f14,f124")
    data = _json(url, "https://quote.eastmoney.com/")
    rows = (data.get("data") or {}).get("diff") or []
    out = []
    for r in rows:
        code = r.get("f12") or ""
        name = r.get("f14") or code
        out.append({
            "code": code,
            "name": name,
            "price": round((_f(r.get("f2")) or 0) / 100.0, 2),
            "chg": round((_f(r.get("f4")) or 0) / 100.0, 2),
            "chg_pct": round((_f(r.get("f3")) or 0) / 100.0, 2),
            "ts": r.get("f124"),
        })
    return out


def _indexes_qq():
    syms = "usDJI,usIXIC,usINX"
    txt = _gbk("https://qt.gtimg.cn/q=" + syms, "https://finance.qq.com/")
    out = []
    mapping = {"usDJI": ("DJIA", "道琼斯"), "usIXIC": ("IXIC", "纳斯达克"), "usINX": ("SPX", "标普 500")}
    for line in txt.split(";"):
        line = line.strip()
        if not line.startswith("v_us"):
            continue
        sym = line.split("=", 1)[0][2:]
        fields = line.split("=", 1)[1].strip('"').split("~")
        if len(fields) < 33:
            continue
        code, name = mapping.get(sym, (sym, fields[1]))
        out.append({
            "code": code,
            "name": name,
            "price": _f(fields[3]) or 0,
            "chg": _f(fields[31]) or 0,
            "chg_pct": _f(fields[32]) or 0,
            "ts": fields[30],
        })
    return out


def get_indexes(force=False):
    def run():
        # 腾讯最稳（GBK script，与 A 股同域名），东财作对照与回落
        try:
            rows = _indexes_qq()
            if rows:
                return {"ok": True, "source": "腾讯 qt.gtimg.cn", "list": rows}
        except Exception:  # noqa: BLE001
            pass
        try:
            rows = _indexes_east()
            if rows:
                return {"ok": True, "source": "东财 push2", "list": rows}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "list": []}
        return {"ok": False, "error": "no data", "list": []}
    return _cached("indexes", 30, run, force)


# ---------------- VIX ----------------
def _parse_vix():
    txt = _http(VIX_URL, timeout=25).decode("utf-8", "replace")
    lines = [ln for ln in txt.strip().splitlines()[1:] if ln.strip()]
    rows = []
    for ln in lines[-320:]:
        parts = ln.split(",")
        if len(parts) < 5:
            continue
        close = _f(parts[4])
        if close is None:
            continue
        rows.append((parts[0], close))
    if not rows:
        return {}
    last = rows[-1]
    prev = rows[-2] if len(rows) > 1 else last
    tail = [r[1] for r in rows[-252:]] or [last[1]]
    below = sum(1 for v in tail if v <= last[1])
    pct = below / len(tail)
    chg_pct = ((last[1] - prev[1]) / prev[1] * 100) if prev[1] else 0.0
    return {
        "value": round(last[1], 2),
        "date": last[0],
        "prev": round(prev[1], 2),
        "chg_pct": round(chg_pct, 2),
        "percentile": round(pct, 3),
        "window": len(tail),
        "granularity": "daily_close",
    }


def get_vix(force=False):
    def run():
        try:
            return {"ok": True, **_parse_vix()}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    return _cached("vix", 1800, run, force)


# ---------------- 涨跌家数（抽样） ----------------
def _breadth_once(pz=100, pages=3):
    """东财单页上限约 100 条，翻 pages 页抽样（默认 300 只）。"""
    up = down = flat = 0
    total = 0
    for pn in range(1, pages + 1):
        url = ("https://push2.eastmoney.com/api/qt/clist/get?pn=" + str(pn) +
               "&pz=" + str(pz) +
               "&po=0&np=1&fltt=2&invt=2&fid=f12&fs=m:105,m:106,m:107&fields=f3,f12,f14")
        data = _json(url, "https://quote.eastmoney.com/")
        d = data.get("data") or {}
        total = d.get("total") or total
        rows = d.get("diff") or []
        if not rows:
            break
        for r in rows:
            p = _f(r.get("f3"))
            if p is None:
                continue
            if p > 0:
                up += 1
            elif p < 0:
                down += 1
            else:
                flat += 1
    n = up + down + flat
    return {"total": total, "sample": n, "up": up, "down": down, "flat": flat,
            "up_ratio": round(up / n, 4) if n else 0}


def get_breadth(force=False):
    # 东财 clist 被限流会对脚本请求直接断连，失败后冷却 30 分钟，避免越试越封
    if _br_cool["err"] and time.time() - _br_cool["ts"] < 1800:
        return {"ok": False, "sample": 0, "cooling": True,
                "error": "冷却中（{}）".format(_br_cool["err"])}

    def run():
        try:
            res = {"ok": True, **_breadth_once()}
            _br_cool.update({"ts": 0, "err": ""})
            return res
        except Exception as exc:  # noqa: BLE001
            msg = "{}: {}".format(type(exc).__name__, exc)
            _br_cool.update({"ts": time.time(), "err": msg})
            return {"ok": False, "sample": 0, "error": msg}
    return _cached("breadth", 600, run, force)


# ---------------- 情绪分（自建，非官方指数） ----------------
def _label(score):
    if score >= 70:
        return "贪婪", "情绪偏强 · 追高需谨慎"
    if score >= 55:
        return "偏强", "中性偏强 · 科技领涨"
    if score >= 45:
        return "中性", "多空均衡 · 方向待选"
    if score >= 30:
        return "偏弱", "中性偏弱 · 观望为主"
    return "恐慌", "情绪偏弱 · 风险偏好收缩"


def dashboard(force=False):
    idx = get_indexes(force)
    vix = get_vix(force)
    br = get_breadth(force)

    avg_pct = 0.0
    if idx.get("list"):
        avg_pct = sum(x.get("chg_pct") or 0 for x in idx["list"]) / len(idx["list"])
    mom = max(0.0, min(100.0, 50 + avg_pct * 13.0))

    vix_score = 50.0
    vix_txt = "VIX 不可用"
    if vix.get("ok"):
        p = vix.get("percentile") or 0
        vix_score = max(0.0, min(100.0, (1 - p) * 100))
        vix_txt = f"VIX {vix['value']}（分位 {round(p * 100)}%）"

    br_score = 50.0
    br_note = "不可用"
    if br.get("ok") and br.get("sample"):
        br_score = br["up_ratio"] * 100
        br_note = "涨 {} / 跌 {}（样本 {}）".format(br.get("up"), br.get("down"), br.get("sample"))
    elif idx.get("list"):
        # 东财抽样偶发被断连，降级用三大指数涨跌宽度做代理
        ups = sum(1 for x in idx["list"] if (x.get("chg_pct") or 0) > 0)
        br_score = ups / len(idx["list"]) * 100
        br_note = "东财抽样暂不可用，按三大指数宽度代理（{}/{}）".format(ups, len(idx["list"]))

    score = 0.5 * mom + 0.3 * vix_score + 0.2 * br_score
    tag, desc = _label(score)
    return {
        "ok": True,
        "score": round(score, 1),
        "tag": tag,
        "desc": desc,
        "parts": [
            {"name": "指数动量", "weight": 0.5, "value": round(mom, 1), "score": round(mom, 1),
             "note": "三大指数均值 {:+.2f}%".format(avg_pct)},
            {"name": "VIX 分位", "weight": 0.3, "value": round(vix_score, 1), "note": vix_txt},
            {"name": "涨跌家数", "weight": 0.2, "value": round(br_score, 1), "note": br_note},
        ],
        "indexes": idx.get("list") or [],
        "index_source": idx.get("source"),
        "vix": vix,
        "breadth": br,
        "disclaimer": "自建加权（动量 50% / VIX 30% / 家数 20%），非官方指数，仅供参考",
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


# ---------------- 美股个股 ----------------
def get_quotes(symbols, force=False):
    syms = [s.strip().lower() for s in symbols if s.strip()][:60]
    if not syms:
        return {"ok": False, "error": "缺少 symbols"}

    def run():
        q = ",".join(("us" + s.upper()) for s in syms)
        txt = _gbk("https://qt.gtimg.cn/q=" + q, "https://finance.qq.com/")
        out = []
        for line in txt.split(";"):
            line = line.strip()
            if not line.startswith("v_us"):
                continue
            sym = line.split("=", 1)[0][2:].upper().replace("US", "")
            f = line.split("=", 1)[1].strip('"').split("~")
            if len(f) < 33:
                continue
            out.append({
                "sym": sym, "name": f[1], "price": _f(f[3]), "prev": _f(f[4]),
                "chg": _f(f[31]), "chg_pct": _f(f[32]), "ts": f[30],
            })
        return {"ok": bool(out), "list": out}
    return _cached("q_" + ",".join(syms), 20, run, force)
