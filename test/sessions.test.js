'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeChanges } = require('../src/sessions');
const { sessionAt, sessionState } = require('../src/market');

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const s = (last, n = 1) => ({ last, n, at: 0 });

test('마켓별 등락: 직전 마켓 마지막 가격 기준, 데이는 어제 정규 종가 기준', () => {
  const c = computeChanges(100, { dayMarket: s(102), preMarket: s(101), regularMarket: s(103), afterMarket: s(104) });
  near(c.dayMarket, 0.02);
  near(c.preMarket, 101 / 102 - 1);
  near(c.regularMarket, 103 / 101 - 1);
  near(c.afterMarket, 104 / 103 - 1); // 애프터는 오늘 정규 종가 기준
});

test('데이 + 프리 + 정규 를 이어 붙이면 live(어제 정규 종가 대비)와 같다', () => {
  const c = computeChanges(100, { dayMarket: s(102), preMarket: s(101), regularMarket: s(103) });
  near((1 + c.dayMarket) * (1 + c.preMarket) * (1 + c.regularMarket) - 1, 103 / 100 - 1);
});

test('거래 없는 마켓은 null, 다음 마켓은 그 앞의 마지막 가격에서 출발', () => {
  const c = computeChanges(100, { preMarket: s(105) });
  assert.strictEqual(c.dayMarket, null);
  near(c.preMarket, 0.05);
  assert.strictEqual(c.regularMarket, null);
});

test('거래가 있었는데 가격이 그대로면 0 (거래 없음과 구분)', () => {
  const c = computeChanges(100, { dayMarket: s(100, 3) });
  assert.strictEqual(c.dayMarket, 0);
});

const CAL = {
  previousBusinessDay: { date: '2026-11-02', regularMarket: { startTime: '2026-11-02T23:30:00+09:00', endTime: '2026-11-03T06:00:00+09:00' }, afterMarket: { startTime: '2026-11-03T06:00:00+09:00', endTime: '2026-11-03T08:00:00+09:00' } },
  today: {
    date: '2026-11-03',
    dayMarket: { startTime: '2026-11-03T10:00:00+09:00', endTime: '2026-11-03T17:50:00+09:00' },
    preMarket: { startTime: '2026-11-03T18:00:00+09:00', endTime: '2026-11-03T23:30:00+09:00' },
    regularMarket: { startTime: '2026-11-03T23:30:00+09:00', endTime: '2026-11-04T06:00:00+09:00' },
    afterMarket: { startTime: '2026-11-04T06:00:00+09:00', endTime: '2026-11-04T08:00:00+09:00' },
  },
  nextBusinessDay: { date: '2026-11-04' },
};
const at = (x) => Date.parse(x);

test('체결 시각으로 거래일과 마켓을 찾는다', () => {
  assert.deepStrictEqual(sessionAt('US', CAL, at('2026-11-03T07:00:00+09:00')), { key: 'afterMarket', date: '2026-11-02' });
  assert.deepStrictEqual(sessionAt('US', CAL, at('2026-11-03T11:40:00+09:00')), { key: 'dayMarket', date: '2026-11-03' });
  assert.strictEqual(sessionAt('US', CAL, at('2026-11-03T09:00:00+09:00')), null); // 빈 시간
});

test('오늘 아직 안 열린 마켓은 started=false', () => {
  const st = sessionState('US', CAL, at('2026-11-03T19:00:00+09:00'));
  assert.strictEqual(st.date, '2026-11-03');
  assert.strictEqual(st.current, 'preMarket');
  assert.deepStrictEqual(st.started, { dayMarket: true, preMarket: true, regularMarket: false, afterMarket: false });
});
