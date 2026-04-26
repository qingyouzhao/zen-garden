export function createInput(canvas) {
  const intents = [];
  let prev = null;

  function pointerAngle(prev, cur) {
    if (!prev) return 0;
    return Math.atan2(cur.y - prev.y, cur.x - cur.x === 0 ? 0.001 : cur.x - prev.x);
  }

  function toCanvas(e) {
    const r = canvas.getBoundingClientRect();
    const scaleX = (canvas.width / window.devicePixelRatio) / r.width;
    const scaleY = (canvas.height / window.devicePixelRatio) / r.height;
    return {
      x: (e.clientX - r.left) * scaleX,
      y: (e.clientY - r.top) * scaleY,
    };
  }

  function onMove(e) {
    if (!e.buttons) { prev = null; return; }
    e.preventDefault();
    const cur = toCanvas(e);
    const angle = pointerAngle(prev, cur);
    intents.push({ type: 'stroke', x: cur.x, y: cur.y, angle, pressure: e.pressure ?? 0.5 });
    prev = cur;
  }

  function onUp() { prev = null; }

  canvas.addEventListener('pointermove', onMove, { passive: false });
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onUp);

  return {
    flush() {
      const batch = intents.splice(0);
      return batch;
    },
  };
}
