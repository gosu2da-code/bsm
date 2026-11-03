'use strict';

// ---------- 상태 ----------
let state = null;
let editMode = false;
let structureSig = '';
const board = document.getElementById('board');

// ---------- 유틸 ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtPct(change) {
  if (change == null || !Number.isFinite(change)) return { text: '–', cls: 'flat' };
  const v = change * 100;
  const rounded = Math.round(v * 100) / 100;
  if (rounded === 0) return { text: '0.00%', cls: 'flat' }; // 0% 는 회색
  return { text: (rounded > 0 ? '+' : '') + rounded.toFixed(2) + '%', cls: rounded > 0 ? 'up' : 'down' };
}

const canvas = document.createElement('canvas').getContext('2d');
function textWidth(text, font) {
  canvas.font = font + ' -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
  return canvas.measureText(text).width;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `오류 (${res.status})`);
  return json;
}

async function reload() {
  state = await api('GET', '/api/state');
  render();
}

// ---------- 섹터 카드 (SVG) ----------
// 그림과 같은 구조: 점선 둥근 사각형 + 왼쪽 위에 걸친 이름 라벨 + 라벨에서 내려오는 곡선 가지 + 종목
const G = {
  frameX: 20, frameY: 34, labelX: 40, labelY: 12, labelH: 44,
  firstRow: 116, rowGap: 52, trunkDx: 48, textDx: 116,
};

function labelWidth(sector) {
  const pct = fmtPct(sector.change).text;
  return Math.max(96, textWidth(sector.name, '600 18px') + textWidth(pct, '600 15px') + 40);
}

function sectorSvg(sector) {
  const trunkX = G.labelX + G.trunkDx;
  const textX = trunkX + G.textDx;
  const top = G.labelY + G.labelH;
  const n = sector.stocks.length;
  const rows = sector.stocks.map((_, i) => G.firstRow + i * G.rowGap);
  const lastY = n ? rows[n - 1] : G.firstRow;

  const maxText = Math.max(
    0,
    ...sector.stocks.map((s) => textWidth(s.symbol, '18px') + textWidth('+00.00%', '18px') + (s.securityType === 'ETF' ? 36 : 0) + 12)
  );
  const width = Math.max(300, textX + maxText + 40, G.labelX + labelWidth(sector) + 40);
  const frameH = lastY + 48 - G.frameY;
  const height = G.frameY + frameH + 4;

  const branches = rows
    .map((y) => {
      const r = 46;
      return `<path class="branch" d="M ${trunkX} ${top} L ${trunkX} ${y - r} C ${trunkX} ${y - 8}, ${trunkX + 8} ${y}, ${trunkX + r} ${y} L ${textX - 18} ${y}"/>`;
    })
    .join('');

  const stocks = sector.stocks
    .map((s, i) => {
      const p = fmtPct(s.change);
      const etf = s.securityType === 'ETF' ? `<tspan class="etf" dx="6">ETF</tspan>` : '';
      const rej = s.rejected ? `<tspan class="rejected" dx="6">(실시간 불가)</tspan>` : '';
      return `<text x="${textX}" y="${rows[i] + 6}" data-sym="${esc(s.symbol)}"><title>${esc(s.name)}</title><tspan class="ticker">${esc(s.symbol)}</tspan>${etf}<tspan class="pct ${p.cls}" dx="10">${p.text}</tspan>${rej}</text>`;
    })
    .join('');

  const empty = n ? '' : `<text class="empty" x="${G.labelX + 8}" y="${G.firstRow}">종목이 없어요${editMode ? '' : ' · 편집에서 추가'}</text>`;
  const lp = fmtPct(sector.change);
  const lw = labelWidth(sector);

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(sector.name)}">
    <rect class="frame" x="${G.frameX}" y="${G.frameY}" width="${width - G.frameX - 4}" height="${frameH}" rx="40"/>
    ${branches}
    <rect class="label-box" x="${G.labelX}" y="${G.labelY}" width="${lw}" height="${G.labelH}" rx="9"/>
    <text x="${G.labelX + 16}" y="${G.labelY + 29}"><tspan class="label-name">${esc(sector.name)}</tspan><tspan class="label-pct ${lp.cls}" dx="8">${lp.text}</tspan></text>
    ${stocks}${empty}
  </svg>`;
}

// ---------- 편집 패널 ----------
function existingSymbols() {
  const set = new Set();
  for (const s of state.sectors) for (const st of s.stocks) set.add(st.symbol);
  return set;
}

function canAdd(symbol) {
  return state.count < state.max || existingSymbols().has(symbol);
}

// 티커 입력칸 + 실시간 확인 미리보기
function attachLookup(input, preview, button) {
  let timer;
  let seq = 0;
  const run = async () => {
    const sym = input.value.trim().toUpperCase();
    button.disabled = true;
    preview.className = 'preview';
    preview.textContent = '';
    if (!sym) return;
    if (!canAdd(sym)) {
      preview.className = 'preview bad';
      preview.textContent = `종목은 최대 ${state.max}개까지 등록할 수 있어요`;
      return;
    }
    const my = ++seq;
    preview.textContent = '확인 중…';
    try {
      const info = await api('GET', '/api/lookup?symbol=' + encodeURIComponent(sym));
      if (my !== seq) return;
      preview.className = 'preview ok';
      preview.textContent = `${info.name}${info.securityType === 'ETF' ? ' · ETF' : ''} ✓`;
      button.disabled = false;
    } catch (e) {
      if (my !== seq) return;
      preview.className = 'preview bad';
      preview.textContent = e.message + ' ✗';
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 350);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !button.disabled) button.click();
  });
}

function editPanel(sector) {
  const el = document.createElement('div');
  el.className = 'edit-panel';
  el.innerHTML = `
    <div class="edit-row">
      <input class="sector-name" value="${esc(sector.name)}" maxlength="30" aria-label="섹터 이름">
      <button class="btn small" data-act="rename">이름 저장</button>
      <button class="btn small danger" data-act="del-sector">섹터 삭제</button>
    </div>
    <ul class="stock-list">
      ${sector.stocks
        .map(
          (s) => `<li data-sym="${esc(s.symbol)}">
            <span class="sym">${esc(s.symbol)}</span>
            <span class="nm">${esc(s.name)}</span>
            ${s.securityType === 'ETF' ? '<span class="tag">ETF</span>' : ''}
            <button class="btn small" data-act="edit-stock">수정</button>
            <button class="btn small danger" data-act="del-stock">삭제</button>
          </li>`
        )
        .join('')}
    </ul>
    <div class="edit-row">
      <input class="new-sym" placeholder="티커 입력 (예: MU, 005930)" autocapitalize="characters" aria-label="추가할 티커">
      <button class="btn small primary" data-act="add-stock" disabled>추가</button>
    </div>
    <div class="preview"></div>`;

  const run = (fn) => async () => {
    try {
      await fn();
      await reload();
    } catch (e) {
      alert(e.message);
    }
  };

  el.querySelector('[data-act=rename]').onclick = run(() =>
    api('PATCH', `/api/sectors/${sector.id}`, { name: el.querySelector('.sector-name').value })
  );
  el.querySelector('[data-act=del-sector]').onclick = () => {
    if (confirm(`'${sector.name}' 섹터를 삭제할까요? 안에 있는 종목도 함께 지워져요.`)) {
      run(() => api('DELETE', `/api/sectors/${sector.id}`))();
    }
  };

  const addInput = el.querySelector('.new-sym');
  const addBtn = el.querySelector('[data-act=add-stock]');
  attachLookup(addInput, el.querySelector(':scope > .preview'), addBtn);
  addBtn.onclick = run(() => api('POST', `/api/sectors/${sector.id}/stocks`, { symbol: addInput.value }));

  for (const li of el.querySelectorAll('.stock-list li')) {
    const sym = li.dataset.sym;
    li.querySelector('[data-act=del-stock]').onclick = run(() =>
      api('DELETE', `/api/sectors/${sector.id}/stocks/${encodeURIComponent(sym)}`)
    );
    li.querySelector('[data-act=edit-stock]').onclick = () => {
      // 이 줄을 티커 수정 입력칸으로 바꾼다
      li.innerHTML = `<div style="flex:1">
          <div class="edit-row" style="margin:0">
            <input value="${esc(sym)}" autocapitalize="characters" aria-label="새 티커">
            <button class="btn small primary" data-act="ok" disabled>확인</button>
            <button class="btn small" data-act="cancel">취소</button>
          </div>
          <div class="preview"></div>
        </div>`;
      const input = li.querySelector('input');
      const ok = li.querySelector('[data-act=ok]');
      attachLookup(input, li.querySelector('.preview'), ok);
      ok.onclick = run(() =>
        api('PATCH', `/api/sectors/${sector.id}/stocks/${encodeURIComponent(sym)}`, { symbol: input.value })
      );
      li.querySelector('[data-act=cancel]').onclick = render;
      input.focus();
      input.select();
    };
  }
  return el;
}

function addSectorCard() {
  const el = document.createElement('div');
  el.className = 'add-sector';
  el.innerHTML = `
    <strong>새 섹터</strong>
    <div class="edit-row" style="margin:0">
      <input placeholder="섹터 이름 (예: 우주항공)" maxlength="30" aria-label="새 섹터 이름">
      <button class="btn small primary">추가</button>
    </div>
    <div class="hint">고유 종목 ${state.count} / ${state.max}</div>`;
  const input = el.querySelector('input');
  const btn = el.querySelector('button');
  const go = async () => {
    try {
      await api('POST', '/api/sectors', { name: input.value });
      await reload();
    } catch (e) {
      alert(e.message);
    }
  };
  btn.onclick = go;
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  return el;
}

// ---------- 렌더링 ----------
function signature() {
  return JSON.stringify([editMode, state.sectors.map((s) => [s.id, s.name, s.stocks.map((x) => [x.symbol, x.rejected])])]);
}

// 구조(섹터·종목 구성)가 바뀌었을 때만 전체를 다시 그린다. 시세만 바뀌면 숫자만 바꾼다.
function render() {
  structureSig = signature();
  board.innerHTML = '';
  for (const sector of state.sectors) {
    const card = document.createElement('section');
    card.className = 'sector';
    card.dataset.id = sector.id;
    card.innerHTML = sectorSvg(sector);
    const svg = card.querySelector('svg');
    card.style.width = svg.getAttribute('width') + 'px';
    if (editMode) card.appendChild(editPanel(sector));
    board.appendChild(card);
  }
  if (editMode) board.appendChild(addSectorCard());
  if (!state.sectors.length && !editMode) {
    board.innerHTML = '<p class="hint">섹터가 없어요. 오른쪽 위 <b>편집</b>을 눌러 추가해 주세요.</p>';
  }
  renderStatus();
}

function updateNumbers() {
  for (const sector of state.sectors) {
    const card = board.querySelector(`.sector[data-id="${CSS.escape(sector.id)}"]`);
    if (!card) continue;
    const lp = fmtPct(sector.change);
    const label = card.querySelector('.label-pct');
    if (label && label.textContent !== lp.text) {
      label.textContent = lp.text;
      label.setAttribute('class', `label-pct ${lp.cls}`);
      card.querySelector('.label-box').setAttribute('width', labelWidth(sector));
    }
    for (const s of sector.stocks) {
      const t = card.querySelector(`text[data-sym="${CSS.escape(s.symbol)}"] .pct`);
      if (!t) continue;
      const p = fmtPct(s.change);
      if (t.textContent !== p.text) {
        t.textContent = p.text;
        t.setAttribute('class', `pct ${p.cls}`);
      }
    }
  }
  renderStatus();
}

function renderStatus() {
  const kr = state.markets.KR;
  const us = state.markets.US;
  const chip = (id, text, open) => {
    const el = document.getElementById(id);
    el.textContent = text;
    el.classList.toggle('open', !!open);
  };
  chip('chip-kr', `국내 ${kr.label}`, kr.session);
  chip('chip-us', `미국 ${us.label}`, us.session);

  const conn = document.getElementById('chip-conn');
  conn.querySelector('.dot').className = 'dot ' + state.connection.mode;
  conn.querySelector('span').textContent = state.connection.label;
  document.getElementById('chip-count').textContent = `종목 ${state.count} / ${state.max}`;
  document.getElementById('chip-time').textContent = new Date(state.updatedAt).toLocaleTimeString('ko-KR');

  const banners = [...state.warnings];
  if (state.mock) banners.unshift('가짜 데이터 모드예요 (MOCK=1). 실제 시세가 아니에요.');
  const html = banners.map((w) => `<div class="banner">${esc(w)}</div>`).join('');
  const box = document.getElementById('banners');
  if (box.innerHTML !== html) box.innerHTML = html;
}

// ---------- 시작 ----------
document.getElementById('edit-toggle').onclick = (e) => {
  editMode = !editMode;
  e.target.textContent = editMode ? '완료' : '편집';
  e.target.classList.toggle('primary', editMode);
  if (state) render();
};

function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (ev) => {
    state = JSON.parse(ev.data);
    if (signature() !== structureSig) {
      // 편집 중 입력칸에 글자가 있으면 화면을 통째로 다시 그리지 않는다
      const typing = editMode && [...board.querySelectorAll('input')].some((i) => i === document.activeElement);
      if (!typing) render();
    } else {
      updateNumbers();
    }
  };
  es.onerror = () => {
    const conn = document.getElementById('chip-conn');
    conn.querySelector('.dot').className = 'dot';
    conn.querySelector('span').textContent = '서버 연결 끊김';
  };
}
connect();
