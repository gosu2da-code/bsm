'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { Store, HttpError } = require('./store');
const { TossClient } = require('./toss');
const { TossRealtime } = require('./realtime');
const { MockClient, MockRealtime } = require('./mock');
const { QuoteEngine, describeError } = require('./quotes');
const { SessionBook } = require('./sessions');

// ---------- 구성 ----------

if (!config.MOCK && (!config.CLIENT_ID || !config.CLIENT_SECRET)) {
  console.error('TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 설정되지 않았어요. .env 파일을 확인해 주세요.');
  console.error('화면만 확인하려면 MOCK=1 로 실행하세요.');
  process.exit(1);
}

const store = new Store();
let client;
let realtime;
if (config.MOCK) {
  client = new MockClient();
  realtime = new MockRealtime(client);
} else {
  client = new TossClient({ clientId: config.CLIENT_ID, clientSecret: config.CLIENT_SECRET });
  realtime = new TossRealtime({
    getToken: () => client.getToken(),
    refreshToken: () => client.getToken({ force: true }),
  });
}
const book = new SessionBook();
if (config.MOCK) require('./mock').seedSessions(book, store);
const engine = new QuoteEngine({ client, realtime, store, book });

// ---------- 종목 확인 ----------

async function lookupSymbol(raw) {
  const symbol = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) throw new HttpError(400, '티커 형식이 올바르지 않아요');
  let rows;
  try {
    rows = await client.getStocks([symbol]);
  } catch (e) {
    if (e.code === 'stock-not-found') throw new HttpError(404, '없는 종목이에요');
    throw new HttpError(502, describeError(e.code || e.message));
  }
  const s = rows.find((r) => String(r.symbol).toUpperCase() === symbol);
  if (!s) throw new HttpError(404, '없는 종목이에요');
  if (s.status === 'DELISTED') throw new HttpError(400, '상장폐지된 종목이에요');
  return { symbol: s.symbol, name: s.name, market: s.market, securityType: s.securityType };
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new HttpError(413, '요청이 너무 커요');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'JSON 형식이 아니에요');
  }
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(config.PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(config.PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// 실시간 화면 갱신: Server-Sent Events 로 1초마다 전체 상태를 보낸다.
const streams = new Set();
setInterval(() => {
  if (!streams.size) return;
  const payload = `data: ${JSON.stringify(engine.snapshot())}\n\n`;
  for (const res of streams) res.write(payload);
}, config.PUSH_INTERVAL_MS);

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // 'api' 제거
  const method = req.method;

  if (method === 'GET' && parts[0] === 'stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(engine.snapshot())}\n\n`);
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }
  if (method === 'GET' && parts[0] === 'state') return sendJson(res, 200, engine.snapshot());
  // 마켓별 기록이 있는 날짜 목록 / 지난 날짜의 마켓별 등락률
  if (method === 'GET' && parts[0] === 'sessions' && parts[1] === 'dates') return sendJson(res, 200, { dates: book.dates() });
  if (method === 'GET' && parts[0] === 'sessions' && !parts[1]) {
    const date = url.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, '날짜 형식이 올바르지 않아요');
    return sendJson(res, 200, engine.sessionsFor(date));
  }
  if (method === 'GET' && parts[0] === 'lookup') {
    return sendJson(res, 200, await lookupSymbol(url.searchParams.get('symbol')));
  }

  if (parts[0] === 'sectors') {
    const [, sectorId, sub, symbol] = parts;
    // /api/sectors
    if (!sectorId && method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, 201, store.addSector(body.name));
    }
    // /api/sectors/:id
    if (sectorId && !sub) {
      if (method === 'PATCH') {
        const body = await readBody(req);
        store.renameSector(sectorId, body.name);
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        store.deleteSector(sectorId);
        return sendJson(res, 200, { ok: true });
      }
    }
    // /api/sectors/:id/stocks[/:symbol]
    if (sectorId && sub === 'stocks') {
      if (!symbol && method === 'POST') {
        const body = await readBody(req);
        store.addStock(sectorId, await lookupSymbol(body.symbol));
        return sendJson(res, 201, { ok: true });
      }
      if (symbol && method === 'PATCH') {
        const body = await readBody(req);
        store.replaceStock(sectorId, symbol, await lookupSymbol(body.symbol));
        return sendJson(res, 200, { ok: true });
      }
      if (symbol && method === 'DELETE') {
        store.deleteStock(sectorId, symbol);
        return sendJson(res, 200, { ok: true });
      }
    }
  }
  throw new HttpError(404, '없는 API 예요');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    serveStatic(req, res);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    sendJson(res, status, { error: e.message || '오류가 발생했어요' });
  }
});

server.listen(config.PORT, () => {
  console.log(`섹터 트리 대시보드: http://localhost:${config.PORT}${config.MOCK ? '  (가짜 데이터 모드)' : ''}`);
  engine.start();
});

function shutdown() {
  realtime.stop();
  book.flush();
  for (const res of streams) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
