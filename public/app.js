'use strict';

// ---------- 상태 ----------
let state = null;
let editMode = false;
let structureSig = '';
const board = document.getElementById('board');

// ---------- 보기 상태 ----------
// mode: 'live' = 어제 정규 종가 대비 / 'each' = 고른 마켓 안에서의 등락
// session: each 에서 고른 마켓 (처음엔 아무것도 고르지 않은 상태로 시작)
// date: 'today' 또는 지난 날짜 'YYYY-MM-DD'
const SESSIONS = [
  ['dayMarket', '데이'],
  ['preMarket', '프리'],
  ['regularMarket', '정규'],
  ['afterMarket', '애프터'],
];
const ui = { mode: 'live', session: null, date: 'today', past: null, dates: [], sort: loadPref('sort', 'rank') };

// 화면에 보이는 순서 (섹터 id 목록, 섹터별 종목 목록)
let order = { sectors: [], stocks: {} };
const SORT_GAP = 0.001; // 추월 기준 0.1%p
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function loadPref(key, fallback) {
  try {
    return localStorage.getItem('sector-tree:' + key) || fallback;
  } catch {
    return fallback;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem('sector-tree:' + key, value);
  } catch {
    /* 저장 못 해도 동작에는 문제없음 */
  }
}

// 지금 화면에 보여줄 숫자
function stockValue(sector, stock) {
  if (ui.mode === 'each' && ui.session) {
    if (ui.date === 'today') return stock.each ? stock.each[ui.session] : null;
    const ps = ui.past && ui.past[sector.id];
    return ps && ps.stocks[stock.symbol] ? ps.stocks[stock.symbol][ui.session] : null;
  }
  return stock.change;
}
function sectorValue(sector) {
  if (ui.mode === 'each' && ui.session) {
    if (ui.date === 'today') return sector.each ? sector.each[ui.session] : null;
    const ps = ui.past && ui.past[sector.id];
    return ps ? ps.each[ui.session] : null;
  }
  return sector.change;
}

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

// 한글처럼 글자를 조합하는 입력기에서는, 조합 중에 엔터를 누르면 "조합 확정"용 엔터가 한 번 더 들어온다.
// 조합 중인 엔터는 무시해서 같은 동작이 두 번 실행되지 않게 한다.
function isEnter(e) {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
}

// 편집 요청이 끝날 때까지 다른 편집 요청을 받지 않는다 (빠른 연속 클릭·엔터로 중복 생성 방지).
let busy = false;
async function once(fn) {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } finally {
    busy = false;
  }
}

async function reload() {
  state = await api('GET', '/api/state');
  render();
}

// ---------- 섹터 카드 (SVG) ----------
// 그림과 같은 구조: 점선 둥근 사각형 + 왼쪽 위에 걸친 이름 라벨 + 라벨에서 내려오는 곡선 가지 + 종목
// 가지는 자리(1번째 줄, 2번째 줄…)에 고정되어 있고, 종목 글자만 자리를 옮겨 다닌다.
const G = {
  frameX: 20, frameY: 34, labelX: 40, labelY: 12, labelH: 44,
  firstRow: 116, rowGap: 52, trunkDx: 48, textDx: 116,
};

function labelWidth(name, pctText) {
  return Math.max(96, textWidth(name, '600 18px') + textWidth(pctText, '600 15px') + 40);
}

function sectorSvg(sector) {
  const trunkX = G.labelX + G.trunkDx;
  const textX = trunkX + G.textDx;
  const top = G.labelY + G.labelH;
  const n = sector.stocks.length;
  const lastY = n ? G.firstRow + (n - 1) * G.rowGap : G.firstRow;

  const maxText = Math.max(
    0,
    ...sector.stocks.map((s) => textWidth(s.symbol, '18px') + textWidth('+00.00%', '18px') + (s.securityType === 'ETF' ? 36 : 0) + 12)
  );
  const lp = fmtPct(sectorValue(sector));
  const lw = labelWidth(sector.name, lp.text);
  const width = Math.max(300, textX + maxText + 40, G.labelX + lw + 40);
  const frameH = lastY + 48 - G.frameY;
  const height = G.frameY + frameH + 4;

  const branches = sector.stocks
    .map((_, i) => {
      const y = G.firstRow + i * G.rowGap;
      const r = 46;
      return `<path class="branch" d="M ${trunkX} ${top} L ${trunkX} ${y - r} C ${trunkX} ${y - 8}, ${trunkX + 8} ${y}, ${trunkX + r} ${y} L ${textX - 18} ${y}"/>`;
    })
    .join('');

  const rows = sector.stocks
    .map((s) => {
      const p = fmtPct(stockValue(sector, s));
      const etf = s.securityType === 'ETF' ? `<tspan class="etf" dx="6">ETF</tspan>` : '';
      const rej = s.rejected ? `<tspan class="rejected" dx="6">(실시간 불가)</tspan>` : '';
      return `<g class="row" data-sym="${esc(s.symbol)}"><text x="${textX}" y="6"><title>${esc(s.name)}</title><tspan class="ticker">${esc(s.symbol)}</tspan>${etf}<tspan class="pct ${p.cls}" dx="10">${p.text}</tspan>${rej}</text></g>`;
    })
    .join('');

  const empty = n ? '' : `<text class="empty" x="${G.labelX + 8}" y="${G.firstRow}">종목이 없어요${editMode ? '' : ' · 편집에서 추가'}</text>`;

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(sector.name)}">
    <rect class="frame" x="${G.frameX}" y="${G.frameY}" width="${width - G.frameX - 4}" height="${frameH}" rx="40"/>
    ${branches}
    <rect class="label-box" x="${G.labelX}" y="${G.labelY}" width="${lw}" height="${G.labelH}" rx="9"/>
    <text x="${G.labelX + 16}" y="${G.labelY + 29}"><tspan class="label-name">${esc(sector.name)}</tspan><tspan class="label-pct ${lp.cls}" dx="8">${lp.text}</tspan></text>
    ${rows}${empty}
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
    if (isEnter(e) && !button.disabled) button.click();
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

  const run = (fn) => () =>
    once(async () => {
      try {
        await fn();
        await reload();
      } catch (e) {
        alert(e.message);
      }
    });

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
  const go = () =>
    once(async () => {
      try {
        await api('POST', '/api/sectors', { name: input.value });
        await reload();
      } catch (e) {
        alert(e.message);
      }
    });
  btn.onclick = go;
  input.addEventListener('keydown', (e) => isEnter(e) && go());
  return el;
}

// ---------- 정렬 ----------
const sortable = () => ui.sort === 'rank' && !editMode;
const rankValue = (v) => (v == null || !Number.isFinite(v) ? -Infinity : v); // 값 없는 건 맨 뒤로

// 지금 순서를 기준으로, 뒤의 항목이 앞 항목보다 gap 이상 앞설 때만 자리를 바꾼다 (자리싸움으로 깜빡이지 않게).
function reorder(current, value, gap) {
  const a = [...current];
  let swapped = true;
  while (swapped) {
    swapped = false;
    for (let i = 0; i < a.length - 1; i++) {
      if (rankValue(value(a[i + 1])) - rankValue(value(a[i])) > gap) {
        [a[i], a[i + 1]] = [a[i + 1], a[i]];
        swapped = true;
      }
    }
  }
  return a;
}

// full: 보기(모드·마켓·날짜)가 바뀌었을 때처럼 추월 기준 없이 새로 줄 세우기
function computeOrder(full) {
  const savedSectors = state.sectors.map((s) => s.id);
  const byId = Object.fromEntries(state.sectors.map((s) => [s.id, s]));
  if (!sortable()) {
    order = { sectors: savedSectors, stocks: Object.fromEntries(state.sectors.map((s) => [s.id, s.stocks.map((x) => x.symbol)])) };
    return;
  }
  const gap = full ? 0 : SORT_GAP;
  const keep = (prev, saved) => [...prev.filter((x) => saved.includes(x)), ...saved.filter((x) => !prev.includes(x))];
  const sectors = reorder(keep(order.sectors, savedSectors), (id) => sectorValue(byId[id]), gap);
  const stocks = {};
  for (const s of state.sectors) {
    const saved = s.stocks.map((x) => x.symbol);
    const bySym = Object.fromEntries(s.stocks.map((x) => [x.symbol, x]));
    stocks[s.id] = reorder(keep(order.stocks[s.id] || [], saved), (sym) => stockValue(s, bySym[sym]), gap);
  }
  order = { sectors, stocks };
}

// 섹터 카드를 새 순서로 옮긴다. 애니메이션이면 이전 자리에서 새 자리로 미끄러지게 (FLIP).
function placeCards(animate) {
  const cards = order.sectors.map((id) => board.querySelector(`.sector[data-id="${CSS.escape(id)}"]`)).filter(Boolean);
  const before = new Map(cards.map((c) => [c, c.getBoundingClientRect()]));
  const tail = board.querySelector('.add-sector');
  for (const c of cards) board.insertBefore(c, tail);
  if (!animate || reduceMotion) return;
  for (const c of cards) {
    const a = before.get(c);
    const b = c.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (!dx && !dy) continue;
    c.style.transition = 'none';
    c.style.transform = `translate(${dx}px, ${dy}px)`;
    c.getBoundingClientRect();
    c.style.transition = 'transform 650ms cubic-bezier(.2,.7,.2,1)';
    c.style.transform = '';
  }
}

// ---------- 렌더링 ----------
function signature() {
  return JSON.stringify([editMode, state.sectors.map((s) => [s.id, s.name, s.stocks.map((x) => [x.symbol, x.rejected])])]);
}

// 구조(섹터·종목 구성)가 바뀌었을 때만 카드를 새로 만든다. 그 밖에는 숫자와 자리만 바꾼다.
function render() {
  structureSig = signature();
  computeOrder(true);
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
  board.classList.add('no-anim'); // 처음 그릴 때는 줄이 미끄러지지 않게
  placeCards(false);
  updateNumbers();
  board.getBoundingClientRect();
  board.classList.remove('no-anim');
  renderStatus();
  renderModeBar();
}

// 1초마다: 숫자를 바꾸고, 정렬이 켜져 있으면 자리도 바꾼다
function update(full = false) {
  computeOrder(full);
  placeCards(true);
  updateNumbers();
  renderStatus();
  renderModeBar();
}

function updateNumbers() {
  board.classList.toggle('dim', ui.mode === 'each' && !ui.session);
  for (const sector of state.sectors) {
    const card = board.querySelector(`.sector[data-id="${CSS.escape(sector.id)}"]`);
    if (!card) continue;
    const lp = fmtPct(sectorValue(sector));
    const label = card.querySelector('.label-pct');
    if (label && label.textContent !== lp.text) {
      label.textContent = lp.text;
      label.setAttribute('class', `label-pct ${lp.cls}`);
      card.querySelector('.label-box').setAttribute('width', labelWidth(sector.name, lp.text));
    }
    const rows = order.stocks[sector.id] || [];
    for (const s of sector.stocks) {
      const g = card.querySelector(`.row[data-sym="${CSS.escape(s.symbol)}"]`);
      if (!g) continue;
      const idx = Math.max(0, rows.indexOf(s.symbol));
      g.style.transform = `translateY(${G.firstRow + idx * G.rowGap}px)`;
      const t = g.querySelector('.pct');
      const p = fmtPct(stockValue(sector, s));
      if (t.textContent !== p.text) {
        t.textContent = p.text;
        t.setAttribute('class', `pct ${p.cls}`);
      }
    }
  }
}

// ---------- live / each 막대 ----------
const modeBar = {
  seg: document.getElementById('mode-seg'),
  strip: document.getElementById('strip'),
  date: document.getElementById('each-date'),
  hint: document.getElementById('each-hint'),
  sort: document.getElementById('sort-toggle'),
};

function usState() {
  return (state && state.markets && state.markets.US && state.markets.US.state) || { date: null, current: null, started: {}, known: false };
}

function renderModeBar() {
  for (const b of modeBar.seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === ui.mode));
  const st = usState();
  const html = SESSIONS.map(([key, label]) => {
    const started = !st.known || ui.date !== 'today' || st.started[key];
    const now = ui.date === 'today' && st.current === key ? ' now' : '';
    if (ui.mode === 'live') {
      // 읽기 전용 진행 표시: live 숫자에 들어간 마켓(초록), 아직(옅게), 애프터는 live 에서 빠짐(회색)
      const cls = key === 'afterMarket' ? 'excl' : started ? 'inc' : 'wait';
      return `<span class="step ${cls}${now}">${label}</span>`;
    }
    const pressed = ui.session === key;
    return `<button class="step tab${now}" data-key="${key}" aria-pressed="${pressed}" ${started ? '' : 'disabled'}>${label}</button>`;
  }).join('');
  if (modeBar.strip.innerHTML !== html) modeBar.strip.innerHTML = html;
  modeBar.strip.classList.toggle('as-tabs', ui.mode === 'each');
  modeBar.date.hidden = ui.mode !== 'each';
  modeBar.hint.hidden = !(ui.mode === 'each' && !ui.session);
  modeBar.sort.textContent = ui.sort === 'rank' ? '정렬: 등락률순' : '정렬: 넣은 순서';
  renderDateOptions();
}

function renderDateOptions() {
  const today = usState().date;
  const opts = [['today', today ? `오늘 (${today.slice(5)})` : '오늘'], ...ui.dates.filter((d) => d !== today).map((d) => [d, d])];
  const html = opts.map(([v, t]) => `<option value="${v}" ${v === ui.date ? 'selected' : ''}>${t}</option>`).join('');
  if (modeBar.date.dataset.html !== html) {
    modeBar.date.innerHTML = html;
    modeBar.date.dataset.html = html;
  }
}

// 고르는 순간 숫자가 "짠" 하고 바뀌게 반짝인다
function flash() {
  if (reduceMotion) return;
  board.classList.remove('flash');
  board.getBoundingClientRect();
  board.classList.add('flash');
  clearTimeout(flash.t);
  flash.t = setTimeout(() => board.classList.remove('flash'), 700);
}

async function loadPast(date) {
  const res = await api('GET', '/api/sessions?date=' + encodeURIComponent(date));
  const map = {};
  for (const s of res.sectors) {
    map[s.id] = { each: s.each, stocks: Object.fromEntries(s.stocks.map((x) => [x.symbol, x.each])) };
  }
  return map;
}

modeBar.seg.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || b.dataset.mode === ui.mode) return;
  ui.mode = b.dataset.mode;
  ui.session = null; // each 를 누르면 아무것도 고르지 않은 상태에서 시작
  ui.date = 'today';
  ui.past = null;
  if (ui.mode === 'each') {
    api('GET', '/api/sessions/dates')
      .then((r) => {
        ui.dates = r.dates || [];
        renderModeBar();
      })
      .catch(() => {});
  }
  update(true);
});

modeBar.strip.addEventListener('click', (e) => {
  const b = e.target.closest('button.tab');
  if (!b || b.disabled || ui.mode !== 'each') return;
  ui.session = b.dataset.key;
  update(true);
  flash();
});

modeBar.date.addEventListener('change', async () => {
  const v = modeBar.date.value;
  try {
    ui.past = v === 'today' ? null : await loadPast(v);
    ui.date = v;
  } catch (err) {
    alert(err.message);
    modeBar.date.value = ui.date;
    return;
  }
  // 오늘로 돌아왔는데 고른 마켓이 아직 안 열렸으면 선택을 비운다
  const st = usState();
  if (ui.date === 'today' && ui.session && st.known && !st.started[ui.session]) ui.session = null;
  update(true);
  if (ui.session) flash();
});

modeBar.sort.addEventListener('click', () => {
  ui.sort = ui.sort === 'rank' ? 'saved' : 'rank';
  savePref('sort', ui.sort);
  update(true);
});

const CONN_TEXT = { live: '실시간 연결 중', polling: '실시간 연결이 안 돼서 10초마다 조회 중', down: '서버 연결 끊김' };
function setConn(mode) {
  const dot = document.getElementById('conn-dot');
  dot.className = 'dot ' + mode;
  dot.title = CONN_TEXT[mode] || mode;
  dot.setAttribute('aria-label', dot.title);
}

function renderStatus() {
  setConn(state.connection.mode);
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
      update();
    }
  };
  es.onerror = () => setConn('down');
}
connect();
