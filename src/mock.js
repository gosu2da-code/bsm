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
    const session = { startTime: iso(now - 3600_000), endTime: iso(now + 5 * 3600_000) };
    const today =
      market === 'KR'
        ? { date: date(0), integrated: { preMarket: null, regularMarket: session, afterMarket: null } }
        : { date: date(0), dayMarket: null, preMarket: null, regularMarket: session, afterMarket: null };
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

module.exports = { MockClient, MockRealtime };
