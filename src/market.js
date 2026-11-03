'use strict';

// 장 운영 정보(market-calendar)로 "현재 거래일"과 "지금 열린 세션"을 계산한다.

const SESSION_LABELS = {
  dayMarket: '데이마켓',
  preMarket: '프리마켓',
  regularMarket: '정규장',
  afterMarket: '애프터마켓',
};

// KR 응답은 세션이 integrated 안에, US 응답은 날짜 객체 바로 아래에 있다.
function sessionsOf(market, day) {
  if (!day) return {};
  const src = market === 'KR' ? day.integrated || {} : day;
  const out = {};
  for (const key of Object.keys(SESSION_LABELS)) {
    const s = src[key];
    if (s && s.startTime && s.endTime) out[key] = { start: Date.parse(s.startTime), end: Date.parse(s.endTime) };
  }
  return out;
}

// 지금 진행 중인 세션 이름. 없으면 null (장 마감).
function currentSession(market, cal, now = Date.now()) {
  if (!cal) return null;
  for (const day of [cal.previousBusinessDay, cal.today, cal.nextBusinessDay]) {
    for (const [key, s] of Object.entries(sessionsOf(market, day))) {
      if (now >= s.start && now < s.end) return key;
    }
  }
  return null;
}

// 등락률 기준이 되는 "현재 거래일".
// 오늘이 영업일이고 첫 세션이 시작됐으면 오늘, 아니면 직전 영업일.
function tradingDate(market, cal, now = Date.now()) {
  if (!cal || !cal.today) return null;
  const today = Object.values(sessionsOf(market, cal.today));
  if (today.length) {
    const firstStart = Math.min(...today.map((s) => s.start));
    if (now >= firstStart) return cal.today.date;
  }
  return cal.previousBusinessDay ? cal.previousBusinessDay.date : null;
}

// 하루 거래일 안에서 마켓이 열리는 순서
const SESSION_ORDER = ['dayMarket', 'preMarket', 'regularMarket', 'afterMarket'];

function dayOf(cal, date) {
  if (!cal || !date) return null;
  return [cal.previousBusinessDay, cal.today, cal.nextBusinessDay].find((d) => d && d.date === date) || null;
}

// 시각 t 의 체결이 어느 거래일의 어느 마켓에 속하는지. 마켓 밖(빈 시간)이면 null.
function sessionAt(market, cal, t) {
  if (!cal) return null;
  for (const day of [cal.previousBusinessDay, cal.today, cal.nextBusinessDay]) {
    for (const [key, s] of Object.entries(sessionsOf(market, day))) {
      if (t >= s.start && t < s.end) return { key, date: day.date };
    }
  }
  return null;
}

// 현재 거래일과, 그 거래일의 마켓별 "이미 시작했는지" 여부
function sessionState(market, cal, now = Date.now()) {
  const date = tradingDate(market, cal, now);
  const sessions = sessionsOf(market, dayOf(cal, date));
  const started = {};
  for (const key of SESSION_ORDER) started[key] = sessions[key] ? now >= sessions[key].start : false;
  return { date, current: currentSession(market, cal, now), started, known: Object.keys(sessions).length > 0 };
}

// 일봉(최신순)에서 기준가(전 거래일 종가)를 고른다.
function basePriceFromCandles(candles, tradeDate) {
  if (!candles || !candles.length) return null;
  if (tradeDate) {
    const prev = candles.find((c) => String(c.timestamp).slice(0, 10) < tradeDate);
    if (prev) return Number(prev.closePrice);
  }
  // 거래일 정보를 모르면 두 번째 봉(직전 봉)을 쓴다.
  return candles.length > 1 ? Number(candles[1].closePrice) : null;
}

function marketOfStock(stock) {
  const m = String(stock.market || '').toUpperCase();
  if (m === 'KR' || m === 'KOSPI' || m === 'KOSDAQ' || m === 'KR_ETC') return 'KR';
  return 'US';
}

module.exports = {
  SESSION_LABELS,
  SESSION_ORDER,
  currentSession,
  tradingDate,
  sessionAt,
  sessionState,
  basePriceFromCandles,
  marketOfStock,
};
