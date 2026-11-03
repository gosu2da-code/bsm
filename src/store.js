'use strict';

// 섹터·종목 구성을 NAS(데이터 폴더)의 JSON 파일에 저장한다.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const FILE = () => path.join(config.DATA_DIR, 'sectors.json');

const DEFAULT_DATA = {
  sectors: [
    {
      id: 's-memory',
      name: '메모리',
      stocks: [
        { symbol: 'SNDK', name: '샌디스크', market: 'US', securityType: 'STOCK' },
        { symbol: 'MU', name: '마이크론 테크놀로지', market: 'US', securityType: 'STOCK' },
      ],
    },
  ],
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class Store {
  constructor() {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    this.data = this._load();
    this.listeners = new Set();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (Array.isArray(data.sectors)) return data;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[store] sectors.json 을 읽지 못했어요:', e.message);
    }
    return structuredClone(DEFAULT_DATA);
  }

  _save() {
    // 임시 파일에 쓰고 이름을 바꿔서, 저장 도중 꺼져도 파일이 깨지지 않게 한다.
    const tmp = FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, FILE());
    for (const fn of this.listeners) fn();
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  getSectors() {
    return this.data.sectors;
  }

  // 여러 섹터에 겹치는 종목은 하나로 센다.
  uniqueSymbols() {
    const set = new Set();
    for (const s of this.data.sectors) for (const st of s.stocks) set.add(st.symbol);
    return [...set];
  }

  stockInfo(symbol) {
    for (const s of this.data.sectors) {
      const st = s.stocks.find((x) => x.symbol === symbol);
      if (st) return st;
    }
    return null;
  }

  _sector(id) {
    const s = this.data.sectors.find((x) => x.id === id);
    if (!s) throw new HttpError(404, '섹터를 찾을 수 없어요');
    return s;
  }

  addSector(name) {
    name = cleanName(name);
    const sector = { id: 's-' + crypto.randomUUID().slice(0, 8), name, stocks: [] };
    this.data.sectors.push(sector);
    this._save();
    return sector;
  }

  renameSector(id, name) {
    this._sector(id).name = cleanName(name);
    this._save();
  }

  deleteSector(id) {
    this._sector(id);
    this.data.sectors = this.data.sectors.filter((x) => x.id !== id);
    this._save();
  }

  // 새 종목이 전체 고유 종목 수 한도를 넘는지 확인
  _checkLimit(symbol) {
    const set = new Set(this.uniqueSymbols());
    if (!set.has(symbol) && set.size >= config.MAX_SYMBOLS) {
      throw new HttpError(409, `종목은 최대 ${config.MAX_SYMBOLS}개까지 등록할 수 있어요`);
    }
  }

  addStock(sectorId, info) {
    const sector = this._sector(sectorId);
    if (sector.stocks.some((x) => x.symbol === info.symbol)) {
      throw new HttpError(409, '이미 이 섹터에 있는 종목이에요');
    }
    this._checkLimit(info.symbol);
    sector.stocks.push(info);
    this._save();
  }

  replaceStock(sectorId, oldSymbol, info) {
    const sector = this._sector(sectorId);
    const idx = sector.stocks.findIndex((x) => x.symbol === oldSymbol);
    if (idx < 0) throw new HttpError(404, '종목을 찾을 수 없어요');
    if (oldSymbol !== info.symbol && sector.stocks.some((x) => x.symbol === info.symbol)) {
      throw new HttpError(409, '이미 이 섹터에 있는 종목이에요');
    }
    // 바꾸는 종목은 빠지므로 그 자리를 비운 상태에서 한도 확인
    const others = new Set();
    for (const s of this.data.sectors) {
      for (const st of s.stocks) if (!(s === sector && st.symbol === oldSymbol)) others.add(st.symbol);
    }
    if (!others.has(info.symbol) && others.size >= config.MAX_SYMBOLS) {
      throw new HttpError(409, `종목은 최대 ${config.MAX_SYMBOLS}개까지 등록할 수 있어요`);
    }
    sector.stocks[idx] = info;
    this._save();
  }

  deleteStock(sectorId, symbol) {
    const sector = this._sector(sectorId);
    const before = sector.stocks.length;
    sector.stocks = sector.stocks.filter((x) => x.symbol !== symbol);
    if (sector.stocks.length === before) throw new HttpError(404, '종목을 찾을 수 없어요');
    this._save();
  }
}

function cleanName(name) {
  name = String(name || '').trim();
  if (!name) throw new HttpError(400, '섹터 이름을 입력해 주세요');
  if (name.length > 30) throw new HttpError(400, '섹터 이름은 30자까지 가능해요');
  return name;
}

module.exports = { Store, HttpError };
