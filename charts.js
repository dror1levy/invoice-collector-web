// One time chart for the whole dashboard (as on the phone): bars for amounts, a line for levels
// (prices, running totals). One series in the primary color, recessive grid, real time axis,
// details of the nearest point on hover / tap. Time runs left to right even in the Hebrew page.

const NS = 'http://www.w3.org/2000/svg';
const DAY = 86400000;

function el(name, attrs = {}, parent) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
}

const shortDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;

function axisNumber(v) {
  if (Math.abs(v) >= 10000) return Math.round(v / 1000).toLocaleString('en-US') + 'K';
  if (Math.abs(v) >= 100 || Number.isInteger(v)) return Math.round(v).toLocaleString('en-US');
  return v.toFixed(1);
}

/**
 * points: [{date: 'YYYY-MM-DD', value, detail?}], sorted by date.
 * mark: 'bars' | 'line'. format(value) -> text for the details line.
 */
export function timeChart(container, points, { mark = 'bars', format = String, fromZero = mark === 'bars' } = {}) {
  container.replaceChildren();
  if (!points.length) return;
  const info = document.createElement('div');
  info.className = 'chart-info';
  container.appendChild(info);
  const holder = document.createElement('div');
  holder.className = 'chart-holder';
  container.appendChild(holder);

  const draw = () => {
    holder.replaceChildren();
    const W = Math.max(280, holder.clientWidth || 600), H = 220;
    const left = 52, right = W - 14, top = 10, bottom = H - 26;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img' }, holder);
    const values = points.map((p) => p.value);
    const lo = fromZero ? Math.min(0, ...values) : Math.min(...values);
    const hi = Math.max(...values);
    const pad = hi > lo ? (hi - lo) * 0.15 : Math.max(Math.abs(hi) * 0.1, 1);
    const yMin = fromZero ? lo : Math.max(0, lo - pad), yMax = hi + pad;
    const t0 = Date.parse(points[0].date), t1 = Date.parse(points[points.length - 1].date);
    const span = Math.max(0, t1 - t0);
    const x = (iso) => (span === 0 ? (left + right) / 2 : left + ((right - left) * (Date.parse(iso) - t0)) / span);
    const y = (v) => bottom - ((bottom - top) * (v - yMin)) / (yMax - yMin);

    for (let k = 0; k <= 2; k++) {
      const v = yMin + ((yMax - yMin) * k) / 2;
      el('line', { x1: left, x2: right, y1: y(v), y2: y(v), class: 'grid' }, svg);
      el('text', { x: left - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = axisNumber(v);
    }
    const ticks = span === 0 ? [points[0].date] : [points[0].date, new Date(t0 + Math.floor(span / DAY / 2) * DAY).toISOString().slice(0, 10), points[points.length - 1].date];
    ticks.forEach((d, i) => {
      const anchor = ticks.length === 1 || (i > 0 && i < ticks.length - 1) ? 'middle' : i === 0 ? 'start' : 'end';
      const tx = ticks.length === 1 ? x(d) : i === 0 ? left : i === ticks.length - 1 ? right : x(d);
      el('text', { x: tx, y: bottom + 18, 'text-anchor': anchor, class: 'tick' }, svg).textContent = shortDate(d);
    });

    const cursor = el('line', { y1: top, y2: bottom, class: 'grid', visibility: 'hidden' }, svg);
    const marks = [];
    if (mark === 'bars') {
      const gaps = points.slice(1).map((p, i) => x(p.date) - x(points[i].date));
      const width = Math.min(14, Math.max(3, gaps.length ? Math.min(...gaps) - 2 : 14));
      const zero = y(Math.max(0, yMin));
      points.forEach((p) => {
        const vy = y(p.value), h = Math.abs(zero - vy);
        const r = Math.min(4, width / 2, h);
        const topY = Math.min(vy, zero);
        // Rounded at the data end, square at the baseline.
        const path = vy < zero
          ? `M${x(p.date) - width / 2},${zero} V${topY + r} Q${x(p.date) - width / 2},${topY} ${x(p.date) - width / 2 + r},${topY} H${x(p.date) + width / 2 - r} Q${x(p.date) + width / 2},${topY} ${x(p.date) + width / 2},${topY + r} V${zero} Z`
          : `M${x(p.date) - width / 2},${zero} V${zero + h - r} Q${x(p.date) - width / 2},${zero + h} ${x(p.date) - width / 2 + r},${zero + h} H${x(p.date) + width / 2 - r} Q${x(p.date) + width / 2},${zero + h} ${x(p.date) + width / 2},${zero + h - r} V${zero} Z`;
        marks.push(el('path', { d: h > 0 ? path : '', class: 'bar' }, svg));
      });
      el('line', { x1: left, x2: right, y1: zero, y2: zero, class: 'baseline' }, svg);
    } else {
      if (points.length > 1) el('polyline', { points: points.map((p) => `${x(p.date)},${y(p.value)}`).join(' '), class: 'line' }, svg);
      points.forEach((p) => marks.push(el('circle', { cx: x(p.date), cy: y(p.value), r: 4, class: 'dot' }, svg)));
    }

    const select = (i) => {
      const p = points[i];
      info.textContent = [shortDate(p.date), format(p.value), p.detail].filter(Boolean).join(' · ');
      cursor.setAttribute('x1', x(p.date));
      cursor.setAttribute('x2', x(p.date));
      cursor.setAttribute('visibility', 'visible');
      marks.forEach((m, k) => m.classList.toggle('on', k === i));
      if (mark === 'line') marks.forEach((m, k) => m.setAttribute('r', k === i ? 6 : 4));
    };
    // Hit target: the whole plot, nearest point by time.
    const hit = el('rect', { x: left, y: top, width: right - left, height: bottom - top, fill: 'transparent' }, svg);
    const nearest = (evt) => {
      const box = svg.getBoundingClientRect();
      const px = ((evt.clientX - box.left) / box.width) * W;
      let best = 0;
      points.forEach((p, i) => { if (Math.abs(x(p.date) - px) < Math.abs(x(points[best].date) - px)) best = i; });
      select(best);
    };
    hit.addEventListener('pointermove', nearest);
    hit.addEventListener('pointerdown', nearest);
    select(points.length - 1);
  };
  draw();
  new ResizeObserver(() => draw()).observe(holder);
}
