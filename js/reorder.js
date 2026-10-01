// Drag-to-reorder for task rows, shared by the table and the Gantt chart.
// A press on a grip starts a drag once the pointer moves a few pixels
// vertically; a plain click still falls through to selection. While
// dragging, a line marks the insertion point and the pane auto-scrolls near
// its top and bottom edges.

const THRESHOLD = 5;   // px of vertical travel before a press becomes a drag
const EDGE = 30;       // px from the pane edge where auto-scroll kicks in
const SPEED = 12;      // px per frame of auto-scroll

// pane:      the scrolling element
// grip:      selector for elements that start a drag (must have data-id or sit inside one)
// rows:      () => [{ id, el }] in plan order, el used for its vertical extent
// canDrop:   (id, index) => bool, false hides the line for invalid targets
// onDrop:    (id, index) => void, index is an insertion point 0..rows.length
// enabled:   () => bool
export function attachReorder(pane, { grip, rows, canDrop, onDrop, enabled }) {
  let drag = null;
  const line = document.createElement('div');
  line.className = 'drop-line';
  line.hidden = true;
  document.body.appendChild(line);

  pane.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !enabled()) return;
    const g = e.target.closest(grip);
    const holder = g?.closest('[data-id]');
    if (!g || !holder || !pane.contains(g)) return;
    drag = { id: Number(holder.dataset.id), y0: e.clientY, x: e.clientX, y: e.clientY, active: false, index: null, pointer: e.pointerId };
  });

  pane.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointer) return;
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.active) {
      if (Math.abs(e.clientY - drag.y0) < THRESHOLD) return;
      drag.active = true;
      try { pane.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      document.body.classList.add('dragging-row');
      drag.timer = requestAnimationFrame(tick);
    }
    update();
  });

  const finish = commit => {
    if (!drag) return;
    const d = drag;
    drag = null;
    line.hidden = true;
    document.body.classList.remove('dragging-row');
    if (!d.active) return;
    cancelAnimationFrame(d.timer);
    // Swallow the click that follows a drag so it doesn't reselect another row
    // (that click, if any, arrives before timers run).
    const swallow = ev => ev.stopPropagation();
    pane.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => pane.removeEventListener('click', swallow, { capture: true }), 0);
    if (commit && d.index !== null) onDrop(d.id, d.index);
  };
  pane.addEventListener('pointerup', () => finish(true));
  pane.addEventListener('pointercancel', () => finish(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && drag?.active) finish(false); });

  function tick() {
    if (!drag?.active) return;
    const r = pane.getBoundingClientRect();
    const dy = drag.y < r.top + EDGE ? -SPEED : drag.y > r.bottom - EDGE ? SPEED : 0;
    if (dy) { pane.scrollTop += dy; update(); }
    drag.timer = requestAnimationFrame(tick);
  }

  function update() {
    const list = rows();
    const rects = list.map(r => r.el.getBoundingClientRect());
    let index = rects.findIndex(r => drag.y < (r.top + r.bottom) / 2);
    if (index < 0) index = list.length;
    if (!canDrop(drag.id, index)) { drag.index = null; line.hidden = true; return; }
    drag.index = index;
    const y = index < rects.length ? rects[index].top : rects[rects.length - 1].bottom;
    const p = pane.getBoundingClientRect();
    line.hidden = y < p.top || y > p.bottom;
    line.style.top = `${y - 1}px`;
    line.style.left = `${p.left}px`;
    line.style.width = `${pane.clientWidth}px`;
  }
}
