'use strict';

// 가짜 데이터 모드 (MOCK=1). 토스 서버에 접속하지 않고 화면·동작을 확인할 때 쓴다.

const EventEmitter = require('events');
const { TossApiError } = require('./toss');

const KNOWN = {
  MU: ['마이크론 테크놀로지', 'NASDAQ', 'STOCK', 110],
  MUU: ['Direxion 마이크론 2배', 'NASDAQ', 'ETF', 40],
  SNDK: ['샌디스크', 'NASDAQ', 'STOCK', 60],
  WDC: ['웨스턴 디지털', 'NASDAQ', 'STOCK', 70],
  INTC: ['인텔', 'NASDAQ', 'STOCK', 25],
  AMD: ['AMD', 'NASDAQ', 'STOCK', 160],
  ARM: ['ARM 홀딩스', 'NASDAQ', 'STOCK', 140],
  NVDA: ['엔비디아', 'NASDAQ', 'STOCK', 130],
  CRCL: ['서클 인터넷 그룹', 'NYSE', 'STOCK', 90],
  MSTR: ['스트래티지', 'NASDAQ', 'STOCK', 350],
  HOOD: ['로빈후드 마켓', 'NASDAQ', 'STOCK', 45],
  COIN: ['코인베이스', 'NASDAQ', 'STOCK', 250],
  RKLB: ['로켓랩', 'NASDAQ', 'STOCK', 22],
  LMT: ['록히드 마틴', 'NYSE', 'STOCK', 470],
  '005930': ['삼성전자', 'KOSPI', 'STOCK', 72000],
  '000660': ['SK하이닉스', 'KOSPI', 'STOCK', 190000],
};

function infoFor(symbol) {
  if (KNOWN[symbol]) {
    const [name, market, securityType, price] = KNOWN[symbol];
    return { name, market, securityType, price };
  }
  if (/^[A-Z]{1,4}$/.test(symbol)) return { name: `${symbol} (가짜 종목)`, market: 'NYSE', securityType: 'STOCK', price: 50 };
  if (/^\d{6}$/.test(symbol)) return { name: `${symbol} (가짜 종목)`, market: 'KOSDAQ', securityType: 'STOCK', price: 10000 };
  return null;
}

class MockClient {
  constructor() {
    this.prices = new Map();
    this.base = new Map();
  }

  _ensure(symbol) {
    if (!this.prices.has(symbol)) {
      const info = infoFor(symbol);
      if (!info) throw new TossApiError(404, 'stock-not-found', '종목을 찾을 수 없습니다.');
      this.base.set(symbol, info.price);
      this.prices.set(symbol, info.price * (1 + (Math.random() - 0.5) * 0.06));
    }
  }

  tick(symbol) {
    this._ensure(symbol);
    const p = this.prices.get(symbol) * (1 + (Math.random() - 0.5) * 0.004);
    this.prices.set(symbol, p);
    return p;
  }

  async getToken() {
    return 'mock-token';
  }

  async getPrices(symbols) {
    return symbols
      .filter((s) => infoFor(s))
      .map((s) => {
        this._ensure(s);
        return { symbol: s, lastPrice: String(this.prices.get(s)), currency: 'USD', timestamp: new Date().toISOString() };
      });
  }

  async getDailyCandles(symbol) {
    this._ensure(symbol);
    const day = (offset) => new Date(Date.now() - offset * 86400_000).toISOString().slice(0, 10) + 'T00:00:00+09:00';
    const base = this.base.get(symbol);
    return [
      { timestamp: day(0), closePrice: String(this.prices.get(symbol)) },
      { timestamp: day(1), closePrice: String(base) },
      { timestamp: day(2), closePrice: String(base * 0.99) },
    ];
  }

  async getStocks(symbols) {
    return symbols
      .map((s) => ({ s, info: infoFor(s) }))
      .filter((x) => x.info)
      .map(({ s, info }) => ({ symbol: s, name: info.name, market: info.market, securityType: info.securityType }));
  }

  async getMarketCalendar(market) {
    const now = Date.now();
    const iso = (t) => new Date(t).toISOString();
    const date = (offset) => new Date(now - offset * 86400_000).toISOString().slice(0, 10);
    // 가짜 하루: 데이마켓은 끝났고 지금은 프리마켓 진행 중, 정규·애프터는 아직
    const at = (h) => iso(now + h * 3600_000);
    const today =
      market === 'KR'
        ? { date: date(0), integrated: { preMarket: null, regularMarket: { startTime: at(-1), endTime: at(5) }, afterMarket: null } }
        : {
            date: date(0),
            dayMarket: { startTime: at(-9), endTime: at(-1.2) },
            preMarket: { startTime: at(-1), endTime: at(4) },
            regularMarket: { startTime: at(4), endTime: at(10) },
            afterMarket: { startTime: at(10), endTime: at(12) },
          };
    return { today, previousBusinessDay: { date: date(1) }, nextBusinessDay: { date: date(-1) } };
  }
}

class MockRealtime extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.symbols = [];
    this.state = 'idle';
    this.lastError = null;
  }
  start() {
    this.state = 'live';
    this.emit('state', 'live', null);
    this.timer = setInterval(() => {
      // 0.2초마다 임의의 종목 몇 개가 체결되는 것처럼 흉내낸다.
      for (const s of this.symbols) {
        if (Math.random() < 0.3) this.emit('trade', { symbol: s.symbol, price: this.client.tick(s.symbol) });
      }
    }, 200);
  }
  setSymbols(list) {
    this.symbols = list;
  }
  stop() {
    clearInterval(this.timer);
  }
}

// 가짜 데이터 모드에서 each 화면을 볼 수 있게, 오늘의 데이마켓 기록과 지난 이틀치 기록을 미리 채운다.
function seedSessions(book, store) {
  const day = (offset) => new Date(Date.now() - offset * 86400_000).toISOString().slice(0, 10);
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const symbol of store.uniqueSymbols()) {
    const info = infoFor(symbol);
    if (!info) continue;
    const base = info.price;
    // 오늘: 데이마켓만 끝난 상태 (ALOY 처럼 거래 없는 종목은 비워 둔다)
    if (symbol !== 'ALOY') book.record(symbol, { key: 'dayMarket', date: day(0) }, base * (1 + (rand() - 0.4) * 0.03), Date.now() - 2 * 3600_000);
    // 지난 이틀: 네 마켓 모두
    for (const off of [1, 2]) {
      let p = base * (1 + (rand() - 0.5) * 0.04);
      book.setBase(symbol, day(off), p);
      for (const key of ['dayMarket', 'preMarket', 'regularMarket', 'afterMarket']) {
        p *= 1 + (rand() - 0.5) * 0.02;
        book.record(symbol, { key, date: day(off) }, p, Date.now() - off * 86400_000);
      }
    }
  }
}

module.exports = { MockClient, MockRealtime, seedSessions };
