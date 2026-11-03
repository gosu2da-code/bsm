'use strict';

// 시세 엔진: 실시간 체결 + REST 보완 + 전일 종가(기준가)를 합쳐서 등락률을 만든다.

const config = require('./config');
const { currentSession, tradingDate, basePriceFromCandles, marketOfStock, SESSION_LABELS } = require('./market');

const ERROR_MESSAGES = {
  'ip-not-allowed': '허용되지 않은 IP예요. 토스증권 WTS > 설정 > Open API > 허용 IP 를 확인해 주세요',
  access_denied: '허용되지 않은 IP예요. 토스증권 WTS > 설정 > Open API > 허용 IP 를 확인해 주세요',
  invalid_client: 'Client Id / Secret 이 올바르지 않아요. .env 파일을 확인해 주세요',
  invalid_request: 'Client Id / Secret 이 비어 있거나 형식이 잘못됐어요. .env 파일을 확인해 주세요',
  'token-revoked': '다른 곳에서 같은 키로 토큰을 발급했어요. 같은 키를 쓰는 다른 프로그램을 꺼 주세요',
  maintenance: '토스증권 시스템 점검 중이에요',
  'rate-limit-exceeded': '요청이 많아 잠시 쉬는 중이에요',
};

function describeError(code) {
  return ERROR_MESSAGES[code] || `시세를 받지 못하고 있어요 (${code})`;
}

class QuoteEngine {
  constructor({ client, realtime, store }) {
    this.client = client;
    this.realtime = realtime;
    this.store = store;
    this.prices = new Map(); // symbol -> { price, at }
    this.bases = new Map(); // symbol -> { base, tradeDate }
    this.calendars = { KR: null, US: null };
    this.restError = null;
    this.tokenConflictAt = 0;
    this.lastRestAt = 0;
    this.lastTradeAt = 0;
    this.baseJob = null;
    this.rejected = new Map(); // symbol -> code (웹소켓 구독 거부)
  }

  start() {
    this.realtime.on('trade', ({ symbol, price }) => {
      this.prices.set(symbol, { price, at: Date.now() });
      this.lastTradeAt = Date.now();
    });
    this.realtime.on('rejected', (list) => {
      for (const r of list) {
        const key = r.topic || r.key || r.code;
        if (key) this.rejected.set(String(key).split(':').pop(), r.code || 'rejected');
      }
    });
    this.realtime.on('wsError', (code) => console.warn('[realtime] 오류:', code));

    this.store.onChange(() => this._syncSymbols());
    this._syncSymbols();
    this.realtime.start();

    this._refreshCalendars().finally(() => {
      this.calendarsLoaded = true;
      this._ensureBases();
    });
    setInterval(() => this._refreshCalendars(), config.CALENDAR_REFRESH_MS);
    // 1분마다 거래일이 바뀌었는지 확인 (바뀌면 기준가를 다시 받는다)
    setInterval(() => this._ensureBases(), 60_000);
    this._pollLoop();
  }

  _symbolList() {
    return this.store.uniqueSymbols().map((symbol) => ({
      symbol,
      market: marketOfStock(this.store.stockInfo(symbol) || {}),
    }));
  }

  _syncSymbols() {
    const list = this._symbolList();
    this.realtime.setSymbols(list);
    const missing = list.filter((s) => !this.prices.has(s.symbol)).map((s) => s.symbol);
    if (missing.length) this._fetchPrices(missing);
    // 장 운영 정보(거래일)를 받은 뒤에만 기준가를 받는다. 그래야 일봉을 두 번 받지 않는다.
    if (this.calendarsLoaded) this._ensureBases();
  }

  async _refreshCalendars() {
    for (const m of ['KR', 'US']) {
      try {
        this.calendars[m] = await this.client.getMarketCalendar(m);
      } catch (e) {
        this._recordError(e);
      }
    }
  }

  // 기준가(전 거래일 종가)가 없거나 거래일이 바뀐 종목만 일봉을 다시 받는다.
  _ensureBases() {
    if (this.baseJob) {
      this.baseAgain = true; // 진행 중이면 끝난 뒤 한 번 더 확인 (새로 추가된 종목용)
      return this.baseJob;
    }
    this.baseAgain = false;
    this.baseJob = (async () => {
      for (const { symbol, market } of this._symbolList()) {
        const td = tradingDate(market, this.calendars[market]);
        const cur = this.bases.get(symbol);
        if (cur && cur.tradeDate === td && cur.base) continue;
        try {
          const candles = await this.client.getDailyCandles(symbol, 5);
          const base = basePriceFromCandles(candles, td);
          if (base) this.bases.set(symbol, { base, tradeDate: td });
          // 실시간/현재가가 아직 없으면 최신 일봉 종가로 화면을 채운다.
          if (!this.prices.has(symbol) && candles[0]) {
            this.prices.set(symbol, { price: Number(candles[0].closePrice), at: 0 });
          }
        } catch (e) {
          this._recordError(e);
        }
      }
    })().finally(() => {
      this.baseJob = null;
      if (this.baseAgain) this._ensureBases();
    });
    return this.baseJob;
  }

  async _fetchPrices(symbols) {
    if (!symbols.length) return;
    try {
      const rows = await this.client.getPrices(symbols);
      const now = Date.now();
      for (const r of rows) {
        const prev = this.prices.get(r.symbol);
        // 실시간 체결이 더 최근이면 덮어쓰지 않는다.
        if (!prev || now - prev.at > 2000) this.prices.set(r.symbol, { price: Number(r.lastPrice), at: now });
      }
      this.lastRestAt = now;
      this.restError = null;
    } catch (e) {
      this._recordError(e);
    }
  }

  _recordError(e) {
    const code = e.code || e.message || 'unknown';
    if (code === 'token-revoked') this.tokenConflictAt = Date.now();
    if (code === 'stock-not-found') return; // 개별 종목 문제는 전체 오류로 보지 않는다
    this.restError = code;
    // 같은 오류는 1분에 한 번만 기록
    if (code !== this.lastLogged || Date.now() - this.lastLoggedAt > 60_000) {
      this.lastLogged = code;
      this.lastLoggedAt = Date.now();
      console.warn('[toss]', code, e.message || '');
    }
  }

  // 웹소켓이 살아 있으면 60초마다(안전망), 아니면 10초마다 REST 로 현재가를 받는다.
  async _pollLoop() {
    const live = this.realtime.state === 'live';
    const gap = live ? config.SAFETY_POLL_MS : config.FALLBACK_POLL_MS;
    if (Date.now() - this.lastRestAt >= gap - 50) {
      await this._fetchPrices(this.store.uniqueSymbols());
    }
    setTimeout(() => this._pollLoop(), 1000);
  }

  snapshot() {
    const now = Date.now();
    const sectors = this.store.getSectors().map((sector) => {
      const stocks = sector.stocks.map((st) => {
        const p = this.prices.get(st.symbol);
        const b = this.bases.get(st.symbol);
        const price = p ? p.price : null;
        const change = price != null && b && b.base ? (price - b.base) / b.base : null;
        return {
          symbol: st.symbol,
          name: st.name,
          securityType: st.securityType,
          market: marketOfStock(st),
          price,
          change,
          rejected: this.rejected.get(st.symbol) || null,
        };
      });
      const changes = stocks.map((s) => s.change).filter((c) => c != null);
      const avg = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null;
      return { id: sector.id, name: sector.name, change: avg, stocks };
    });

    const markets = {};
    for (const m of ['KR', 'US']) {
      const s = currentSession(m, this.calendars[m], now);
      markets[m] = { session: s, label: s ? SESSION_LABELS[s] : '장 마감' };
    }

    let connection;
    const rt = this.realtime.state;
    if (rt === 'live') connection = { mode: 'live', label: '실시간' };
    else connection = { mode: 'polling', label: '10초 조회' };

    const warnings = [];
    if (this.restError) warnings.push(describeError(this.restError));
    else if (rt === 'error' && this.realtime.lastError && this.realtime.lastError !== 'disconnected') {
      warnings.push('실시간 연결 실패: ' + describeError(this.realtime.lastError));
    }
    if (now - this.tokenConflictAt < 10 * 60_000 && this.restError !== 'token-revoked') {
      warnings.push(describeError('token-revoked'));
    }

    return {
      mock: config.MOCK,
      sectors,
      markets,
      connection,
      warnings,
      count: this.store.uniqueSymbols().length,
      max: config.MAX_SYMBOLS,
      updatedAt: now,
    };
  }
}

module.exports = { QuoteEngine, describeError };
