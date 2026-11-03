'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tradingDate, currentSession, basePriceFromCandles, marketOfStock } = require('../src/market');
const { extractPrice } = require('../src/realtime');

// 문서 예시 형태의 미국 장 운영 정보
const US = {
  today: {
    date: '2026-03-25',
    dayMarket: { startTime: '2026-03-25T09:00:00+09:00', endTime: '2026-03-25T16:50:00+09:00' },
    preMarket: { startTime: '2026-03-25T17:00:00+09:00', endTime: '2026-03-25T22:30:00+09:00' },
    regularMarket: { startTime: '2026-03-25T22:30:00+09:00', endTime: '2026-03-26T05:00:00+09:00' },
    afterMarket: { startTime: '2026-03-26T05:00:00+09:00', endTime: '2026-03-26T07:00:00+09:00' },
  },
  previousBusinessDay: { date: '2026-03-24' },
  nextBusinessDay: { date: '2026-03-26' },
};
const KR_HOLIDAY = {
  today: { date: '2026-05-05', integrated: null },
  previousBusinessDay: { date: '2026-05-04', integrated: null },
  nextBusinessDay: { date: '2026-05-06', integrated: null },
};
const candles = [
  { timestamp: '2026-03-25T00:00:00-04:00', closePrice: '110' },
  { timestamp: '2026-03-24T00:00:00-04:00', closePrice: '100' },
  { timestamp: '2026-03-23T00:00:00-04:00', closePrice: '90' },
];
const at = (s) => Date.parse(s);

test('세션이 시작되기 전에는 직전 영업일이 거래일', () => {
  assert.strictEqual(tradingDate('US', US, at('2026-03-25T08:00:00+09:00')), '2026-03-24');
});
test('첫 세션(데이마켓)이 시작되면 오늘이 거래일', () => {
  assert.strictEqual(tradingDate('US', US, at('2026-03-25T09:30:00+09:00')), '2026-03-25');
});
test('휴장일에는 직전 영업일이 거래일', () => {
  assert.strictEqual(tradingDate('KR', KR_HOLIDAY, at('2026-05-05T10:00:00+09:00')), '2026-05-04');
});
test('기준가는 거래일 이전의 가장 최근 종가', () => {
  assert.strictEqual(basePriceFromCandles(candles, '2026-03-25'), 100);
  assert.strictEqual(basePriceFromCandles(candles, '2026-03-24'), 90);
  assert.strictEqual(basePriceFromCandles(candles, null), 100);
});
test('현재 세션 판정', () => {
  assert.strictEqual(currentSession('US', US, at('2026-03-25T23:00:00+09:00')), 'regularMarket');
  assert.strictEqual(currentSession('US', US, at('2026-03-26T03:00:00+09:00')), 'regularMarket');
  assert.strictEqual(currentSession('US', US, at('2026-03-25T16:55:00+09:00')), null);
  assert.strictEqual(currentSession('KR', KR_HOLIDAY, at('2026-05-05T10:00:00+09:00')), null);
});
test('시장 구분', () => {
  assert.strictEqual(marketOfStock({ market: 'KOSPI' }), 'KR');
  assert.strictEqual(marketOfStock({ market: 'NASDAQ' }), 'US');
});
test('체결 메시지 가격 추출', () => {
  assert.strictEqual(extractPrice({ price: '185.7' }), 185.7);
  assert.ok(Number.isNaN(extractPrice({ foo: 1 })));
});
