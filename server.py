#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
매크로 알리미 - step 2: 진짜 데이터 (KIS + 하이퍼리퀴드)
- /            → static/index.html
- /api/bars    → 패널별 5분봉 + 현재가 (?full=1 이면 전체 봉, 아니면 최근 2개)
- /health      → 상태 확인 (소스별 마지막 갱신 시각 포함)
데이터
- 하이퍼리퀴드(키 없음): 나스닥 · 10년 · 2년 · 오일 · 유로 · 비트   5초마다
- KIS(kis_core):        SOXX · IWM · HYG · IEF                      10초마다
표준 라이브러리만 사용.
"""
import os, json, time, threading, mimetypes, urllib.request
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "0.0.0.0", 8780
BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
BAR = 300                      # 5분봉
MAX_BARS = 300
HL_EVERY, KIS_EVERY = 5, 10    # 초
KST = timezone(timedelta(hours=9))
STARTED = time.time()
SPIKE = 0.02                   # KIS: 앞 봉들에서 2% 넘게 튄 값은 잘못된 체결로 보고 버림


def us_session_open(ts=None):
    """미국 ETF 거래 시간(뉴욕 평일 04:00~20:00, 프리~애프터)인지. 서머타임 반영."""
    utc = datetime.fromtimestamp(ts or time.time(), timezone.utc)
    y = utc.year
    def nth_sunday(month, n):
        d = datetime(y, month, 1, tzinfo=timezone.utc)
        d += timedelta(days=(6 - d.weekday()) % 7)
        return d + timedelta(weeks=n - 1)
    dst_start = nth_sunday(3, 2) + timedelta(hours=7)    # 3월 둘째 일요일 02:00 EST
    dst_end = nth_sunday(11, 1) + timedelta(hours=6)     # 11월 첫째 일요일 02:00 EDT
    et = utc + timedelta(hours=-4 if dst_start <= utc < dst_end else -5)
    return et.weekday() < 5 and 4 <= et.hour < 20


def despike(bars, pct=SPIKE):
    """봉 목록에서 튄 값 정리: 직전 정상 종가 기준 pct 넘게 벗어난 값은 버리고 직전 종가로."""
    out, ref = [], None
    for b in bars:
        if ref is None:
            ref = b["close"]
        ok = lambda v: ref * (1 - pct) <= v <= ref * (1 + pct)
        o = b["open"] if ok(b["open"]) else ref
        c = b["close"] if ok(b["close"]) else ref
        h = b["high"] if ok(b["high"]) else max(o, c)
        l = b["low"] if ok(b["low"]) else min(o, c)
        out.append({"time": b["time"], "open": o, "close": c, "high": max(o, c, h), "low": min(o, c, l)})
        ref = c
    return out

# ---------------- 패널 → 데이터 출처 ----------------
#  hl: (dex, coin, 가격필드)   oraclePx = 거래 얇은 시장은 오라클(실제 시세 추종) 사용
HL = {
    "NQ":    ("xyz",  "xyz:XYZ100", "markPx"),
    "US10Y": ("para", "para:10Y",   "oraclePx"),
    "WTI":   ("xyz",  "xyz:CL",     "markPx"),
    "US2Y":  ("para", "para:2Y",    "oraclePx"),
    "EUR":   ("xyz",  "xyz:EUR",    "markPx"),
    "BTC":   ("",     "BTC",        "markPx"),
}
KIS_SYMS = {"SOX": "SOXX", "RTY": "IWM", "_HYG": "HYG", "_IEF": "IEF"}  # _ 는 신용 계산용

# 패널 말고 현재가만 필요한 종목 (보보조용)
QUOTE = {"SNDK": ("xyz", "xyz:SNDK", "markPx")}
Q = {}            # sym -> {"price":x, "t":ts, "pending":x}
BOBOJO_FILE = os.path.join(BASE, "bobojo.json")   # static 밖 → 브라우저로 직접 못 읽음
MULTI_FILE = os.path.join(BASE, "bobojo_multi.json")   # 멀티보조: 원 최대 4개
_candle_cache = {}  # (sym, start분) -> (저장시각, 데이터)
EXCD_TRY = ("NAS", "AMS", "NYS")

# ---------------- 공용 상태 ----------------
_lock = threading.Lock()
S = {}            # id -> {"bars":[...], "last":x, "prev":x, "changed":ts, "src":"hl|kis"}
_last_ok = {"hl": None, "kis": None}
_err = {"hl": None, "kis": None}


def _panel(pid, src):
    return S.setdefault(pid, {"bars": [], "last": None, "prev": None, "changed": 0, "src": src})


def _apply(pid, price, prev, src, t=None):
    """현재가를 받아서 5분봉 갱신."""
    t = int(t or time.time())
    with _lock:
        p = _panel(pid, src)
        if price is None:
            return
        bars = p["bars"]
        if src == "kis" and p["last"]:
            if abs(price / p["last"] - 1) > SPIKE:
                pend = p.get("pending")
                if not (pend and abs(price / pend - 1) < SPIKE / 4):
                    p["pending"] = price      # 한 번 튄 값은 보류, 다음에도 그 근처면 인정
                    return
            p["pending"] = None
        ref = p["last"] if p["last"] is not None else (bars[-1]["close"] if bars else None)
        moved = ref is None or abs(price - ref) > 1e-12
        if moved:
            p["changed"] = t
        p["last"], p["prev"] = price, (prev if prev else p["prev"])
        b0 = t - t % BAR
        if not moved and (not bars or bars[-1]["time"] != b0):
            return      # 장외에 값이 그대로면 빈 봉 만들지 않음
        if bars and bars[-1]["time"] == b0:
            b = bars[-1]
            b["high"], b["low"], b["close"] = max(b["high"], price), min(b["low"], price), price
        elif not bars or b0 > bars[-1]["time"]:
            o = bars[-1]["close"] if bars else price
            bars.append({"time": b0, "open": o, "high": max(o, price), "low": min(o, price), "close": price})
            del bars[:-MAX_BARS]


def _set_history(pid, bars, src):
    with _lock:
        p = _panel(pid, src)
        bars = sorted({b["time"]: b for b in bars}.values(), key=lambda b: b["time"])
        if src == "kis":
            bars = despike(bars)
        p["bars"] = bars[-MAX_BARS:]
        if p["bars"]:
            p["changed"] = p["changed"] or p["bars"][-1]["time"]


# ---------------- 하이퍼리퀴드 ----------------
def _hl(body):
    req = urllib.request.Request("https://api.hyperliquid.xyz/info", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def hl_history():
    now = int(time.time() * 1000)
    for pid, (dex, coin, field) in HL.items():
        if field == "oraclePx":
            continue   # 체결 봉은 오라클 값과 어긋나서 섞지 않음. 실시간으로 쌓아감
        try:
            c = _hl({"type": "candleSnapshot", "req": {"coin": coin, "interval": "5m",
                                                        "startTime": now - 12 * 3600 * 1000, "endTime": now}})
            _set_history(pid, [{"time": int(x["t"]) // 1000, "open": float(x["o"]), "high": float(x["h"]),
                                "low": float(x["l"]), "close": float(x["c"])} for x in c], "hl")
        except Exception as e:
            print("[HL] 과거봉 실패", coin, e, flush=True)
        time.sleep(0.3)


def _quote(sym, price, t):
    """보보조용 현재가. 2% 넘게 튄 값은 한 번 보류했다가 다음에도 그 근처면 인정."""
    with _lock:
        q = Q.setdefault(sym, {"price": None, "t": 0, "pending": None})
        last = q["price"]
        if last and abs(price / last - 1) > SPIKE:
            pend = q["pending"]
            if not (pend and abs(price / pend - 1) < SPIKE / 4):
                q["pending"] = price
                return
        q["price"], q["t"], q["pending"] = price, t, None


def hl_loop():
    hl_history()
    dexes = sorted({d for d, _, _ in list(HL.values()) + list(QUOTE.values())})
    while True:
        try:
            ctx_by_coin = {}
            for dex in dexes:
                body = {"type": "metaAndAssetCtxs"}
                if dex:
                    body["dex"] = dex
                meta, ctx = _hl(body)
                for u, c in zip(meta["universe"], ctx):
                    ctx_by_coin[u["name"]] = c
            now = time.time()
            for pid, (dex, coin, field) in HL.items():
                c = ctx_by_coin.get(coin)
                if c and c.get(field):
                    _apply(pid, float(c[field]), float(c.get("prevDayPx") or 0), "hl", now)
            for sym, (dex, coin, field) in QUOTE.items():
                c = ctx_by_coin.get(coin)
                if c and c.get(field):
                    _quote(sym, float(c[field]), now)
            _last_ok["hl"], _err["hl"] = now, None
        except Exception as e:
            _err["hl"] = str(e)
            print("[HL] 실패", e, flush=True)
        time.sleep(HL_EVERY)


# ---------------- KIS ----------------
def kis_loop():
    try:
        import kis_core as k
    except Exception as e:
        _err["kis"] = "kis_core 불러오기 실패: %s" % e
        print("[KIS]", _err["kis"], flush=True)
        return

    excd = {}
    # 1) 거래소 코드 찾기 + 과거 5분봉
    for pid, sym in KIS_SYMS.items():
        for ex in EXCD_TRY:
            try:
                rt, mc, msg, d = k.get("/uapi/overseas-price/v1/quotations/price", "HHDFS00000300",
                                       {"AUTH": "", "EXCD": ex, "SYMB": sym})
                if rt == "0" and (d.get("output") or {}).get("last"):
                    excd[pid] = ex
                    break
            except Exception as e:
                print("[KIS] 현재가 실패", sym, e, flush=True)
            time.sleep(0.3)
        if pid not in excd:
            print("[KIS] 거래소 못 찾음", sym, flush=True)
            continue
        try:
            rt, mc, msg, d = k.get("/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice", "HHDFS76950200",
                                   {"AUTH": "", "EXCD": excd[pid], "SYMB": sym, "NMIN": "5", "PINC": "1",
                                    "NEXT": "", "NREC": "120", "FILL": "", "KEYB": ""})
            bars = []
            for x in (d.get("output2") or []):
                try:
                    t = datetime.strptime(x["kymd"] + x["khms"], "%Y%m%d%H%M%S").replace(tzinfo=KST).timestamp()
                    bars.append({"time": int(t) - int(t) % BAR, "open": float(x["open"]), "high": float(x["high"]),
                                 "low": float(x["low"]), "close": float(x["last"])})
                except Exception:
                    pass
            _set_history(pid, bars, "kis")
            if rt != "0":
                print("[KIS] 분봉 실패", sym, mc, msg, flush=True)
        except Exception as e:
            print("[KIS] 분봉 실패", sym, e, flush=True)
        time.sleep(0.3)
    _credit_history()

    # 2) 현재가 반복
    while True:
        try:
            now = time.time()
            for pid, sym in KIS_SYMS.items():
                if pid not in excd:
                    continue
                rt, mc, msg, d = k.get("/uapi/overseas-price/v1/quotations/price", "HHDFS00000300",
                                       {"AUTH": "", "EXCD": excd[pid], "SYMB": sym})
                o = d.get("output") or {}
                if rt == "0" and o.get("last"):
                    _apply(pid, float(o["last"]), float(o.get("base") or 0), "kis", now)
                else:
                    print("[KIS] 현재가 실패", sym, mc, msg, flush=True)
                time.sleep(0.3)
            _credit_live(now)
            _last_ok["kis"], _err["kis"] = now, None
        except Exception as e:
            _err["kis"] = str(e)
            print("[KIS] 실패", e, flush=True)
        time.sleep(KIS_EVERY)


def _credit_history():
    """HYG ÷ IEF 5분봉 (같은 시각 봉끼리 나눔)."""
    with _lock:
        h = {b["time"]: b for b in S.get("_HYG", {}).get("bars", [])}
        i = {b["time"]: b for b in S.get("_IEF", {}).get("bars", [])}
    bars = [{"time": t, "open": h[t]["open"] / i[t]["open"], "high": h[t]["high"] / i[t]["low"],
             "low": h[t]["low"] / i[t]["high"], "close": h[t]["close"] / i[t]["close"]}
            for t in sorted(set(h) & set(i))]
    for b in bars:   # 고/저 순서 보정
        v = [b["open"], b["high"], b["low"], b["close"]]
        b["high"], b["low"] = max(v), min(v)
    _set_history("CREDIT", bars, "kis")


def _credit_live(now):
    with _lock:
        h, i = S.get("_HYG"), S.get("_IEF")
        if not (h and i and h["last"] and i["last"]):
            return
        price = h["last"] / i["last"]
        prev = (h["prev"] / i["prev"]) if (h["prev"] and i["prev"]) else None
    _apply("CREDIT", price, prev, "kis", now)


# ---------------- HTTP ----------------
def _is_stale(p, now):
    if p["src"] == "kis" and not us_session_open(now):
        return True                      # KIS(미국 ETF)는 시계 기준
    return (now - p["changed"]) > 15 * 60 if p["changed"] else True

def snapshot(full):
    now = time.time()
    out = {}
    with _lock:
        for pid, p in S.items():
            if pid.startswith("_"):
                continue
            out[pid] = {"bars": p["bars"] if full else p["bars"][-2:], "last": p["last"], "prev": p["prev"],
                        "src": p["src"], "stale": _is_stale(p, now)}
    return out


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj):
        self._send(200, json.dumps(obj).encode(), "application/json; charset=utf-8")

    def do_GET(self):
        path, _, q = self.path.partition("?")
        if path == "/api/bars":
            return self._json(snapshot("full=1" in q))
        if path == "/health":
            now = time.time()
            age = {k: (int(now - v) if v else None) for k, v in _last_ok.items()}
            return self._json({"ok": True, "uptime_sec": int(now - STARTED), "sec_since_update": age, "error": _err})
        if path == "/api/quote":
            sym = q.partition("sym=")[2].split("&")[0].upper() or "SNDK"
            with _lock:
                d = dict(Q.get(sym) or {})
            if not d.get("price"):
                return self._json({"sym": sym, "price": None})
            return self._json({"sym": sym, "price": d["price"], "t": int(d["t"]),
                               "stale": time.time() - d["t"] > 60})
        if path == "/api/bobojo":
            try:
                with open(BOBOJO_FILE, encoding="utf-8") as f:
                    return self._json(json.load(f))
            except FileNotFoundError:
                return self._json({})
        if path == "/api/candles":
            return self._candles(q)
        if path == "/api/multi":
            try:
                with open(MULTI_FILE, encoding="utf-8") as f:
                    return self._json(json.load(f))
            except FileNotFoundError:
                return self._json({"circles": []})
        if path in ("/bobojo", "/bobojo/"):
            path = "/static/bobojo.html"
        if path in ("/multi", "/multi/"):
            path = "/static/bobojo_multi.html"
        if path in ("/", "/index.html"):
            path = "/static/index.html"
        if path.startswith("/static/"):
            full = os.path.realpath(os.path.join(STATIC, path[len("/static/"):]))
            if full.startswith(os.path.realpath(STATIC) + os.sep) and os.path.isfile(full):
                ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
                if ctype.startswith("text/") or ctype.endswith("javascript"):
                    ctype += "; charset=utf-8"
                with open(full, "rb") as f:
                    return self._send(200, f.read(), ctype)
        self._send(404, b"not found", "text/plain; charset=utf-8")

    def _candles(self, q):
        """멀티보조용: 하이퍼리퀴드 5분봉 [{t(ms), o, h, l, c}] (같은 요청은 30초 캐시)."""
        qs = dict(x.split("=", 1) for x in q.split("&") if "=" in x)
        sym = (qs.get("sym") or "SNDK").upper()
        if sym not in QUOTE:
            return self._send(404, b"unknown sym", "text/plain; charset=utf-8")
        now = int(time.time() * 1000)
        try:
            start = int(qs.get("start") or now - 86400000)
        except ValueError:
            start = now - 86400000
        start = max(start, now - 17 * 86400000)          # 5분봉은 약 17일치까지
        key = (sym, start // 60000)
        hit = _candle_cache.get(key)
        if hit and time.time() - hit[0] < 30:
            return self._json(hit[1])
        try:
            c = _hl({"type": "candleSnapshot", "req": {"coin": QUOTE[sym][1], "interval": "5m",
                                                        "startTime": start, "endTime": now}})
            out = [{"t": int(x["t"]), "o": float(x["o"]), "h": float(x["h"]), "l": float(x["l"]),
                    "c": float(x["c"])} for x in c]
        except Exception as e:
            return self._send(502, ("candles fail: %s" % e).encode(), "text/plain; charset=utf-8")
        _candle_cache.clear()
        _candle_cache[key] = (time.time(), out)
        return self._json(out)

    def _post_multi(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 4000:
                raise ValueError("too big")
            d = json.loads(self.rfile.read(n) or b"{}")
            circles = d.get("circles") or []
            if not isinstance(circles, list) or len(circles) > 4:
                raise ValueError("원은 최대 4개")
            out = []
            for c in circles:
                item = {"name": str(c.get("name") or "")[:20]}
                for k in ("t0", "t1"):
                    v = str(c.get(k) or "")[:16]
                    datetime.strptime(v, "%Y-%m-%dT%H:%M")
                    item[k] = v
                for k in ("p0", "p1"):
                    item[k] = float(c.get(k))
                out.append(item)
            keep = {"circles": out, "saved": int(time.time())}
            tmp = MULTI_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(keep, f, ensure_ascii=False)
            os.replace(tmp, MULTI_FILE)
            return self._json({"ok": True, **keep})
        except Exception as e:
            return self._send(400, ("bad input: %s" % e).encode(), "text/plain; charset=utf-8")

    def do_POST(self):
        if self.path == "/api/multi":
            return self._post_multi()
        if self.path != "/api/bobojo":
            return self._send(404, b"not found", "text/plain; charset=utf-8")
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 2000:
                raise ValueError("too big")
            d = json.loads(self.rfile.read(n) or b"{}")
            keep = {}
            for k in ("t0", "t1"):          # "2026-10-23T18:00" 형식 (KST)
                v = str(d.get(k) or "")[:16]
                datetime.strptime(v, "%Y-%m-%dT%H:%M")
                keep[k] = v
            for k in ("p0", "p1"):
                keep[k] = float(d.get(k))
            keep["saved"] = int(time.time())
            tmp = BOBOJO_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(keep, f, ensure_ascii=False)
            os.replace(tmp, BOBOJO_FILE)
            return self._json({"ok": True, **keep})
        except Exception as e:
            return self._send(400, ("bad input: %s" % e).encode(), "text/plain; charset=utf-8")


if __name__ == "__main__":
    threading.Thread(target=hl_loop, daemon=True).start()
    threading.Thread(target=kis_loop, daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), H)
    print("=" * 52)
    print("  매크로 알리미 실행 중 (step 2 · KIS + 하이퍼리퀴드)")
    print("  이 기기에서:   http://localhost:%d" % PORT)
    print("  상태 확인:     http://localhost:%d/health" % PORT)
    print("  끄려면  Control + C")
    print("=" * 52, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n종료.")
