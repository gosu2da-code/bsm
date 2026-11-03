'use strict';

// 마켓별(데이·프리·정규·애프터) 가격 기록.
// 거래일마다, 종목마다, 마켓마다 "마지막 체결가"와 "체결 횟수"를 저장한다.
// 이 기록으로 each 모드의 마켓별 등락률을 계산한다.
//
// 계산 규칙 (직전 마켓 마지막 가격 → 이 마켓 마지막 가격)
//   데이   : 어제 정규 종가(기준가)  → 데이 마지막
//   프리   : 데이 마지막            → 프리 마지막
//   정규   : 프리 마지막            → 정규 마지막(종가)
//   애프터 : 오늘 정규 종가          → 애프터 마지막
//   (앞 마켓에 체결이 없으면 그보다 앞의 마지막 가격을 출발점으로 쓴다)
//   그래서 데이 + 프리 + 정규 = live(어제 정규 종가 대비) 와 맞는다.
// 그 마켓에 체결이 한 건도 없으면 null (화면에는 '–', 평균에서 제외).

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { SESSION_ORDER } = require('./market');

const KEEP_DAYS = 90;

class SessionBook {
  constructor(file = path.join(config.DATA_DIR, 'sessions.json')) {
    this.file = file;
    this.data = {}; // { [date]: { [symbol]: { base, s: { [sessionKey]: { last, n, at } } } } }
    this.dirty = false;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[sessions] sessions.json 을 읽지 못했어요:', e.message);
    }
    this.timer = setInterval(() => this.flush(), 15_000);
    this.timer.unref();
  }

  _rec(date, symbol) {
    const d = (this.data[date] ||= {});
    return (d[symbol] ||= { s: {} });
  }

  // 체결 한 건 기록. where = sessionAt() 결과 { key, date }
  record(symbol, where, price, t) {
    if (!where || !Number.isFinite(price)) return;
    const s = this._rec(where.date, symbol).s;
    const cur = (s[where.key] ||= { n: 0, last: null, at: 0 });
    if (t < cur.at) return; // 더 오래된 가격으로 덮어쓰지 않는다
    cur.n += 1;
    cur.last = price;
    cur.at = t;
    this.dirty = true;
  }

  setBase(symbol, date, base) {
    if (!date || !Number.isFinite(base)) return;
    const r = this._rec(date, symbol);
    if (r.base !== base) {
      r.base = base;
      this.dirty = true;
    }
  }

  // 마켓별 등락률 { dayMarket, preMarket, regularMarket, afterMarket } (소수 비율 또는 null)
  compute(date, symbol, fallbackBase) {
    const r = (this.data[date] && this.data[date][symbol]) || { s: {} };
    return computeChanges(r.base ?? fallbackBase ?? null, r.s);
  }

  dates() {
    return Object.keys(this.data).sort().reverse();
  }

  flush() {
    if (!this.dirty) return;
    // 오래된 날짜는 지운다
    const dates = Object.keys(this.data).sort();
    for (const d of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) delete this.data[d];
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) {
      console.error('[sessions] 저장하지 못했어요:', e.message);
    }
  }
}

function computeChanges(base, s) {
  const out = {};
  let prev = Number.isFinite(base) ? base : null;
  for (const key of SESSION_ORDER) {
    const sess = s[key];
    const traded = sess && sess.n > 0 && Number.isFinite(sess.last);
    let start = prev;
    if (key === 'afterMarket') {
      // 애프터는 "오늘 정규 종가"에서 출발 (정규 체결이 없었으면 그 앞의 마지막 가격)
      start = s.regularMarket && s.regularMarket.n > 0 ? s.regularMarket.last : prev;
    }
    out[key] = traded && start ? sess.last / start - 1 : null;
    if (traded && key !== 'afterMarket') prev = sess.last;
  }
  return out;
}

module.exports = { SessionBook, computeChanges };
