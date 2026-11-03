'use strict';

// 토스증권 웹소켓(실시간 체결) 클라이언트.
// - 연결 1개만 사용한다 (계정당 2개 한도 중 1개는 여유로 남긴다).
// - 구독은 선언형: 보낼 때마다 "현재 구독 전체"를 배열로 보낸다.
// - 180초 동안 보낸 게 없으면 서버가 끊으므로 60초마다 PING 을 보낸다.

const EventEmitter = require('events');
const WebSocket = require('ws');
const config = require('./config');

class TossRealtime extends EventEmitter {
  constructor({ getToken, refreshToken }) {
    super();
    this.getToken = getToken;
    this.refreshToken = refreshToken;
    this.ws = null;
    this.symbols = []; // [{ symbol, market: 'KR' | 'US' }]
    this.state = 'idle'; // idle | connecting | live | error
    this.lastError = null;
    this.backoff = 1000;
    this.pingTimer = null;
    this.declareTimer = null;
    this.stopped = false;
    this.loggedUnknown = false;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  setSymbols(list) {
    this.symbols = list;
    // 편집이 연달아 일어나도 선언은 한 번만 (초당 5회 한도)
    clearTimeout(this.declareTimer);
    this.declareTimer = setTimeout(() => this._declare(), 500);
  }

  _setState(state, error = null) {
    this.state = state;
    this.lastError = error;
    this.emit('state', state, error);
  }

  async _connect() {
    if (this.stopped) return;
    this._setState('connecting');
    let token;
    try {
      token = await this.getToken();
    } catch (e) {
      this._setState('error', e.code || e.message);
      return this._scheduleReconnect();
    }

    const ws = new WebSocket(config.WS_URL, { headers: { Authorization: `Bearer ${token}` } });
    this.ws = ws;

    ws.on('unexpected-response', async (_req, res) => {
      const code = res.statusCode === 403 ? 'ip-not-allowed' : res.statusCode === 401 ? 'invalid-token' : `http-${res.statusCode}`;
      this._setState('error', code);
      if (res.statusCode === 401) {
        try {
          await this.refreshToken();
        } catch {
          /* 다음 재연결 때 다시 시도 */
        }
      }
      ws.terminate();
    });

    ws.on('open', () => {
      this.backoff = 1000;
      this._declare();
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING');
      }, 60_000);
    });

    ws.on('message', (buf) => this._onMessage(buf.toString()));

    ws.on('error', (e) => {
      if (this.state !== 'error') this._setState('error', e.code || e.message);
    });

    ws.on('close', () => {
      clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = null;
      if (this.state === 'live' || this.state === 'connecting') this._setState('error', 'disconnected');
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const wait = this.backoff + Math.random() * 500;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    setTimeout(() => this._connect(), wait);
  }

  _declare() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const byMarket = { kr: [], us: [] };
    for (const s of this.symbols) byMarket[s.market === 'KR' ? 'kr' : 'us'].push(s.symbol);
    const items = [];
    for (const [m, codes] of Object.entries(byMarket)) {
      if (codes.length) items.push({ type: `trade:${m}`, codes });
    }
    // 빈 배열 [] 은 "전체 구독 해제"
    ws.send(JSON.stringify(items.length ? [{ id: 'decl-' + Date.now() }, ...items] : []));
  }

  _onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'subscriptions') {
      this._setState('live');
      if (msg.rejected && msg.rejected.length) this.emit('rejected', msg.rejected);
      return;
    }
    if (msg.type === 'error') {
      const code = (msg.error && msg.error.code) || 'ws-error';
      if (code === 'rate-limit-exceeded') setTimeout(() => this._declare(), 1100);
      else if (code === 'server-shutdown' && this.ws) this.ws.terminate();
      else this.emit('wsError', code);
      return;
    }
    if (msg.type !== 'message' || !msg.topic || !msg.topic.startsWith('trade:')) return;

    const symbol = msg.topic.split(':').slice(2).join(':');
    const price = extractPrice(msg.data);
    if (symbol && Number.isFinite(price)) {
      this.emit('trade', { symbol, price });
    } else if (!this.loggedUnknown) {
      // 체결 메시지 형식이 예상과 다르면 한 번만 기록해 둔다 (형식 확인용).
      this.loggedUnknown = true;
      console.warn('[realtime] 체결 메시지에서 가격을 찾지 못했어요. 예시:', text.slice(0, 500));
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    if (this.ws) this.ws.terminate();
  }
}

// 체결 payload 의 가격 필드 이름은 AsyncAPI 문서 기준으로 확인이 필요해서 여러 후보를 본다.
function extractPrice(data) {
  if (!data || typeof data !== 'object') return NaN;
  const src = Array.isArray(data) ? data[data.length - 1] : data;
  for (const key of ['price', 'tradePrice', 'lastPrice', 'closePrice', 'p']) {
    if (src && src[key] !== undefined && src[key] !== null) return Number(src[key]);
  }
  return NaN;
}

module.exports = { TossRealtime, extractPrice };
