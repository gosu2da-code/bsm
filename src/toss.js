'use strict';

// 토스증권 Open API REST 클라이언트.
// 이 앱은 "시세·종목 정보" 카테고리만 사용한다. 주문·계좌 API 는 일부러 구현하지 않는다.

const config = require('./config');

class TossApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// 문서의 Rate Limits Group 별 초당 한도. 여유를 두고 80% 만 사용한다.
const RATE_LIMITS = {
  AUTH: 5,
  STOCK: 5,
  MARKET_INFO: 3,
  MARKET_DATA: 15,
  MARKET_DATA_CHART: 20,
};

class GroupLimiter {
  constructor(perSecond) {
    this.gapMs = Math.ceil(1000 / (perSecond * 0.8));
    this.next = 0;
  }
  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) await sleep(at - now);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TossClient {
  constructor({ clientId, clientSecret, onStatus }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.onStatus = onStatus || (() => {});
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenPromise = null;
    this.lastIssueAt = 0;
    this.conflictAt = 0;
    this.limiters = {};
    for (const [g, n] of Object.entries(RATE_LIMITS)) this.limiters[g] = new GroupLimiter(n);
  }

  // ---------- 토큰 ----------

  // client 당 유효한 토큰은 1개뿐이다. 재발급하면 이전 토큰이 즉시 무효가 되므로
  // 꼭 필요할 때만, 그리고 최소 간격을 두고 발급한다.
  async getToken({ force = false } = {}) {
    const fresh = this.token && Date.now() < this.tokenExpiresAt - 5 * 60_000;
    if (fresh && !force) return this.token;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = this._issueToken().finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }

  async _issueToken() {
    // 토큰 충돌(다른 곳에서 같은 키 사용) 직후에는 5분 동안 재발급하지 않는다. (서로 끊는 무한 반복 방지)
    if (Date.now() - this.conflictAt < 5 * 60_000 && Date.now() - this.lastIssueAt < 5 * 60_000) {
      throw new TossApiError(401, 'token-revoked', '다른 곳에서 같은 키로 토큰을 발급했어요');
    }
    const minGap = 30_000;
    const since = Date.now() - this.lastIssueAt;
    if (since < minGap) await sleep(minGap - since);
    this.lastIssueAt = Date.now();

    await this.limiters.AUTH.wait();
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await fetch(`${config.REST_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 토큰 엔드포인트는 OAuth2 표준 에러 형식(error, error_description)을 쓴다.
      const code = res.status === 403 ? 'ip-not-allowed' : json.error || 'token-error';
      throw new TossApiError(res.status, code, json.error_description || json.error);
    }
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + (json.expires_in || 86400) * 1000;
    return this.token;
  }

  // ---------- 공통 요청 ----------

  async request(group, pathAndQuery, { retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      await this.limiters[group].wait();
      const token = await this.getToken();
      const res = await fetch(`${config.REST_BASE}${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) return (await res.json()).result;

      const json = await res.json().catch(() => ({}));
      const err = json.error && typeof json.error === 'object' ? json.error : {};
      const code = err.code || `http-${res.status}`;

      if (res.status === 429 && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await sleep(retryAfter * 1000 + Math.random() * 300);
        continue;
      }
      if (res.status === 401 && attempt < 1) {
        if (code === 'token-revoked') {
          // 다른 곳(다른 PC, 다른 프로그램)에서 같은 키로 토큰을 새로 발급받았다는 뜻.
          // 바로 재발급하면 서로의 토큰을 끊어버리는 무한 반복이 생기므로 5분에 한 번만 재발급한다.
          this.conflictAt = Date.now();
          this.onStatus({ tokenConflict: true });
        }
        this.token = null;
        await this.getToken({ force: true });
        continue;
      }
      throw new TossApiError(res.status, code, err.message, { data: err.data });
    }
  }

  // ---------- 시세·종목 정보 ----------

  // 현재가. 최대 200개씩 나눠서 조회한다.
  async getPrices(symbols) {
    const out = [];
    for (let i = 0; i < symbols.length; i += 200) {
      const chunk = symbols.slice(i, i + 200);
      const result = await this.request(
        'MARKET_DATA',
        `/api/v1/prices?symbols=${encodeURIComponent(chunk.join(','))}`
      );
      out.push(...(result || []));
    }
    return out;
  }

  // 일봉 (최신순).
  async getDailyCandles(symbol, count = 5) {
    const result = await this.request(
      'MARKET_DATA_CHART',
      `/api/v1/candles?symbol=${encodeURIComponent(symbol)}&interval=1d&count=${count}`
    );
    return (result && result.candles) || [];
  }

  // 종목 기본 정보 (이름, 시장, 종류).
  async getStocks(symbols) {
    const result = await this.request(
      'STOCK',
      `/api/v1/stocks?symbols=${encodeURIComponent(symbols.join(','))}`
    );
    return result || [];
  }

  // 장 운영 정보. market = 'KR' | 'US'
  async getMarketCalendar(market) {
    return this.request('MARKET_INFO', `/api/v1/market-calendar/${market}`);
  }
}

module.exports = { TossClient, TossApiError, sleep };
