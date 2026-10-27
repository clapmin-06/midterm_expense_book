// ---- 통계 탭: 월별 / 년도별 / 전체 카드 (외부 라이브러리 없이 SVG 로 그림) ----
// app.js 의 $, el, api, won, signed 를 사용한다.
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

const stats = { monthly: [], order: [], month: '', year: '' };

const compact = (n) => {
  const f = (v, u) => `${+v.toFixed(1)}${u}`;
  return n >= 1e8 ? f(n / 1e8, '억') : n >= 1e4 ? f(n / 1e4, '만') : n >= 1e3 ? f(n / 1e3, '천') : String(Math.round(n));
};
function niceMax(max) {
  if (max <= 0) return 1000;
  const p = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 4, 6, 8, 10].find((s) => max / p <= s) * p;
}
const pctText = (v, total) => {
  if (!total) return '0%';
  const p = (v / total) * 100;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
};
const pad2 = (n) => String(n).padStart(2, '0');
function shiftMonth(ym, d) {
  let [y, m] = ym.split('-').map(Number);
  m += d;
  y += Math.floor((m - 1) / 12);
  m = ((((m - 1) % 12) + 12) % 12) + 1; // d 가 음수여도 1~12 로
  return `${y}-${pad2(m)}`;
}

// 카테고리 색은 "카테고리 목록의 순서"에 고정(순위가 바뀌어도 색은 그대로). 8개를 넘는 카테고리는 회색 '그 외'
const OTHER = 'var(--series-other)';
function catColor(name) {
  const i = stats.order.indexOf(name);
  return i >= 0 && i < 8 ? `var(--series-${i + 1})` : OTHER;
}

// ---- 툴팁 (마우스를 올리면 나타남) ----
const tip = el('div', 'viz-tip hidden');
document.body.append(tip);
function showTip(ev, lines) {
  tip.replaceChildren(...lines.map(([t, cls]) => el('div', cls || '', t)));
  tip.classList.remove('hidden');
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 12;
  let y = ev.clientY + 12;
  if (x + r.width > innerWidth - 8) x = innerWidth - r.width - 8;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 12;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}
const hideTip = () => tip.classList.add('hidden');
addEventListener('scroll', hideTip, { passive: true });

// ---- 막대그래프: 기간이 위아래로 쌓이고, 왼쪽 절반은 지출·오른쪽 절반은 수입 ----
// items: [{key, label, sub?, full, expense, income}] (오래된 순). 화면에는 최신이 맨 위.
// HTML 로 그려서 화면 크기와 상관없이 글씨 크기가 일정하다. 두 쪽은 같은 눈금(최댓값)을 공유한다.
function drawBars(host, items, selKey, onSelect) {
  const max = Math.max(1, ...items.flatMap((d) => [d.expense, d.income]));
  const chart = el('div', 'hbars');

  const head = el('div', 'hb-head');
  head.append(el('span'));
  for (const [cls, name] of [['exp', '지출'], ['inc', '수입']]) {
    const h = el('span', 'hb-col');
    h.append(el('i', cls), name);
    head.append(h);
  }
  chart.append(head);

  const cell = (v, cls) => {
    const c = el('div', 'hb-cell');
    c.style.setProperty('--r', v / max);
    if (v > 0) c.append(el('div', `hb-fill ${cls}`)); // 0원이면 막대 없이 숫자만
    c.append(el('span', 'hb-val', v > 0 ? compact(v) : '0'));
    if (v <= 0) c.classList.add('zero');
    return c;
  };
  for (const d of [...items].reverse()) {
    const row = el('button', d.key === selKey ? 'hb-row sel' : 'hb-row');
    row.type = 'button';
    const lab = el('div', 'hb-lab');
    lab.append(el('span', 'hb-m', d.label));
    if (d.sub) lab.append(el('span', 'hb-y', d.sub));
    row.append(lab, cell(d.expense, 'exp'), cell(d.income, 'inc'));
    row.setAttribute('aria-label', `${d.full} 지출 ${won(d.expense)} 수입 ${won(d.income)}`);
    row.addEventListener('pointermove', (e) => showTip(e, [[d.full, 'tt-h'], [`지출 ${won(d.expense)}`], [`수입 ${won(d.income)}`], [`순수익 ${signed(d.income - d.expense)}`]]));
    row.addEventListener('pointerleave', hideTip);
    row.addEventListener('click', () => { hideTip(); onSelect(d.key); });
    chart.append(row);
  }
  host.append(chart);
}

// ---- 원그래프(도넛): 카테고리별 지출 비중 ----
// slices: [{name, value, color, detail?}]
function drawDonut(host, slices, total) {
  const wrap = el('div', 'donut-wrap');
  const size = 168, c = size / 2, r = 60, sw = 26, C = 2 * Math.PI * r;
  const s = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, class: 'donut', role: 'img', 'aria-label': '카테고리별 지출 비중 원그래프' });
  svgEl('circle', { cx: c, cy: c, r, fill: 'none', class: 'donut-track', 'stroke-width': sw }, s);
  const gap = slices.length > 1 ? 2 : 0; // 조각 사이 2px 간격
  let cum = 0;
  for (const sl of slices) {
    const len = (sl.value / total) * C;
    const dl = Math.max(len - gap, 0.5);
    const ring = svgEl('circle', {
      cx: c, cy: c, r, fill: 'none', 'stroke-width': sw, stroke: sl.color,
      'stroke-dasharray': `${dl} ${C - dl}`, 'stroke-dashoffset': -cum, transform: `rotate(-90 ${c} ${c})`, class: 'ring',
    }, s);
    ring.addEventListener('pointermove', (e) => showTip(e, [[sl.name, 'tt-h'], [`${won(sl.value)} · ${pctText(sl.value, total)}`], ...(sl.detail ? [[sl.detail, 'tt-sub']] : [])]));
    ring.addEventListener('pointerleave', hideTip);
    cum += len;
  }
  svgEl('text', { x: c, y: c - 3, 'text-anchor': 'middle', class: 'donut-lab' }, s).textContent = '총지출';
  svgEl('text', { x: c, y: c + 15, 'text-anchor': 'middle', class: 'donut-val' }, s).textContent = compact(total);
  wrap.append(s);

  // 범례: 색 칸 + 이름 + 비중 + 금액 (색만으로 구분하지 않도록 항상 표시)
  const ul = el('ul', 'legend-list');
  for (const sl of slices) {
    const li = el('li');
    const sw2 = el('i');
    sw2.style.background = sl.color;
    li.append(sw2, el('span', 'nm', sl.name), el('span', 'pc', pctText(sl.value, total)), el('span', 'am', won(sl.value)));
    ul.append(li);
  }
  wrap.append(ul);
  host.append(wrap);
}

function makeSlices(rows) {
  const slices = [];
  const other = { value: 0, names: [] };
  for (const r of rows) {
    if (r.total <= 0) continue;
    const color = catColor(r.category);
    if (color === OTHER) { other.value += r.total; other.names.push(r.category); }
    else slices.push({ name: r.category, value: r.total, color });
  }
  if (other.value > 0) slices.push({ name: '그 외', value: other.value, color: OTHER, detail: other.names.join(', ') });
  return slices.sort((a, b) => b.value - a.value);
}

// ---- 총지출/총수입/순수익 + 지출 TOP 3 ----
function drawTotals(host, expense, income) {
  const net = income - expense;
  const box = el('div', 'totals');
  const row = (label, value, cls) => {
    const d = el('div', cls || '');
    d.append(el('span', 'muted', label), el('strong', '', value));
    return d;
  };
  box.append(row('총지출', won(expense)), row('총수입', won(income)));
  const netRow = row('순수익', (net > 0 ? '▲ ' : net < 0 ? '▼ ' : '') + signed(net), 'net ' + (net > 0 ? 'up' : net < 0 ? 'down' : ''));
  box.append(netRow);
  host.append(box);
}
function drawTop3(host, rows, expense) {
  const box = el('div', 'top3');
  box.append(el('h3', '', '지출이 가장 많은 카테고리 TOP 3'));
  const top = rows.filter((r) => r.total > 0).slice(0, 3);
  if (!top.length) { box.append(el('p', 'muted small', '지출 내역이 없습니다.')); host.append(box); return; }
  top.forEach((r, i) => {
    const row = el('div', 'top-row');
    const main = el('div', 'top-main');
    const line = el('div', 'top-line');
    line.append(el('span', 'top-name', `${i + 1}위 ${r.category}`), el('span', 'top-amt', `${won(r.total)} · ${pctText(r.total, expense)}`));
    const track = el('div', 'track');
    const fill = el('i');
    fill.style.width = `${Math.max(2, (r.total / expense) * 100)}%`;
    fill.style.background = catColor(r.category);
    track.append(fill);
    main.append(line, track);
    row.append(main);
    box.append(row);
  });
  host.append(box);
}

// ---- 카드 공통 ----
// cfg: {title, select?:{options, value, onChange}, bars?:{items, selKey, onSelect}, catRows, expense, income, note?}
function renderCard(host, cfg) {
  host.replaceChildren();
  const head = el('div', 'row-between');
  head.append(el('h2', '', cfg.title));
  if (cfg.select) {
    const sel = el('select');
    sel.setAttribute('aria-label', `${cfg.title} 기간 선택`);
    for (const [v, label] of cfg.select.options) sel.append(new Option(label, v));
    sel.value = cfg.select.value;
    sel.onchange = () => cfg.select.onChange(sel.value);
    head.append(sel);
    enhanceSelect(sel, `${cfg.title} 기간 선택`);
  } else if (cfg.note) {
    head.append(el('span', 'muted small', cfg.note));
  }
  host.append(head);

  if (cfg.bars) {
    drawBars(host, cfg.bars.items, cfg.bars.selKey, cfg.bars.onSelect);
  }

  host.append(el('h3', 'sub-h', '카테고리별 지출 비중'));
  const slices = makeSlices(cfg.catRows);
  if (slices.length) drawDonut(host, slices, slices.reduce((a, b) => a + b.value, 0));
  else host.append(el('p', 'muted small', '이 기간의 지출 내역이 없습니다.'));

  drawTotals(host, cfg.expense, cfg.income);
  drawTop3(host, cfg.catRows, cfg.expense);
}
function emptyCard(host, title) {
  host.replaceChildren(el('h2', '', title), el('p', 'muted small', '아직 표시할 내역이 없습니다.'));
}

const sumOf = (rows) => rows.reduce((a, m) => ({ expense: a.expense + m.total, income: a.income + m.income }), { expense: 0, income: 0 });

async function renderMonthCard() {
  const host = $('st-month');
  const months = stats.monthly.map((m) => m.month); // 최신순
  if (!months.length) return emptyCard(host, '월별 통계');
  const by = Object.fromEntries(stats.monthly.map((m) => [m.month, m]));
  const catRows = await api('/summary/category?month=' + stats.month);

  // 최근 6개월 (고른 달이 그보다 오래됐으면 그 달이 보이도록 창을 옮김)
  const latest = months[0];
  let end = latest;
  if (stats.month < shiftMonth(latest, -5)) end = shiftMonth(stats.month, 2) < latest ? shiftMonth(stats.month, 2) : latest;
  const start = shiftMonth(end, -5);
  const items = [];
  for (let k = start; k <= end; k = shiftMonth(k, 1)) {
    const [y, m] = k.split('-');
    items.push({
      key: k, label: `${+m}월`, sub: items.length === 0 || m === '01' ? y : '', full: `${y}년 ${+m}월`,
      expense: by[k]?.total || 0, income: by[k]?.income || 0,
    });
  }
  const cur = by[stats.month];
  renderCard(host, {
    title: '월별 통계',
    select: {
      options: months.map((m) => [m, `${m.slice(0, 4)}년 ${+m.slice(5)}월`]), value: stats.month,
      onChange: (v) => { stats.month = v; renderMonthCard(); },
    },
    bars: { items, selKey: stats.month, onSelect: (k) => { stats.month = k; renderMonthCard(); } },
    catRows, expense: cur?.total || 0, income: cur?.income || 0,
  });
}

async function renderYearCard() {
  const host = $('st-year');
  if (!stats.monthly.length) return emptyCard(host, '년도별 통계');
  const byYear = {};
  for (const m of stats.monthly) {
    const y = m.month.slice(0, 4);
    byYear[y] = byYear[y] || { expense: 0, income: 0 };
    byYear[y].expense += m.total;
    byYear[y].income += m.income;
  }
  const years = Object.keys(byYear).sort().reverse(); // 최신순
  const catRows = await api('/summary/category?year=' + stats.year);
  const first = Math.max(+years[years.length - 1], +years[0] - 4); // 최근 5년까지
  const items = [];
  for (let y = first; y <= +years[0]; y++) {
    items.push({ key: String(y), label: `${y}`, full: `${y}년`, expense: byYear[y]?.expense || 0, income: byYear[y]?.income || 0 });
  }
  const cur = byYear[stats.year] || { expense: 0, income: 0 };
  renderCard(host, {
    title: '년도별 통계',
    select: {
      options: years.map((y) => [y, `${y}년`]), value: stats.year,
      onChange: (v) => { stats.year = v; renderYearCard(); },
    },
    bars: { items, selKey: stats.year, onSelect: (k) => { stats.year = k; renderYearCard(); } },
    catRows, expense: cur.expense, income: cur.income,
  });
}

async function renderAllCard() {
  const host = $('st-all');
  if (!stats.monthly.length) return emptyCard(host, '전체 통계');
  const catRows = await api('/summary/category');
  const months = stats.monthly.map((m) => m.month);
  const { expense, income } = sumOf(stats.monthly);
  renderCard(host, {
    title: '전체 통계',
    note: `${months[months.length - 1]} ~ ${months[0]}`,
    catRows, expense, income,
  });
}

async function loadSummaries() {
  const [monthly, order] = await Promise.all([api('/summary/monthly'), api('/categories?kind=expense')]);
  stats.monthly = monthly;
  stats.order = order;
  const months = monthly.map((m) => m.month);
  // 기본 선택은 이번 달/올해(내역이 있을 때), 없으면 가장 최근
  const nowMonth = today().slice(0, 7);
  if (!months.includes(stats.month)) stats.month = months.includes(nowMonth) ? nowMonth : months[0] || '';
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];
  if (!years.includes(stats.year)) stats.year = years.includes(nowMonth.slice(0, 4)) ? nowMonth.slice(0, 4) : years[0] || '';
  await Promise.all([renderMonthCard(), renderYearCard(), renderAllCard()]);
}
