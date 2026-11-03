'use strict';

const path = require('path');
const fs = require('fs');

// .env 파일을 직접 읽는다 (외부 의존성 없이). 이미 설정된 환경변수가 우선한다.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const ROOT = path.resolve(__dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));

module.exports = {
  ROOT,
  DATA_DIR: process.env.DATA_DIR || path.join(ROOT, 'data'),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  PORT: Number(process.env.PORT || 3000),
  MOCK: process.env.MOCK === '1' || process.env.MOCK === 'true',
  CLIENT_ID: process.env.TOSS_CLIENT_ID || '',
  CLIENT_SECRET: process.env.TOSS_CLIENT_SECRET || '',
  REST_BASE: process.env.TOSS_REST_BASE || 'https://openapi.tossinvest.com', // 테스트용으로만 바꾼다
  WS_URL: process.env.TOSS_WS_URL || 'wss://openapi-ws.tossinvest.com/ws/v1',

  MAX_SYMBOLS: 100, // 웹소켓 연결 1개당 구독 한도
  PUSH_INTERVAL_MS: 1000, // 브라우저 화면 갱신 주기
  FALLBACK_POLL_MS: 10_000, // 웹소켓이 동작하지 않을 때 REST 조회 주기
  SAFETY_POLL_MS: 60_000, // 웹소켓이 동작 중일 때도 값이 어긋나지 않게 하는 안전망 조회 주기
  CALENDAR_REFRESH_MS: 10 * 60_000, // 장 운영 정보 갱신 주기
};
