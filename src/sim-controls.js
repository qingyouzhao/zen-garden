export function buildControlsUI(params, onReset) {
  const style = document.createElement('style');
  style.textContent = `
    #sim-controls {
      position: fixed; bottom: 20px; right: 16px; z-index: 100;
      font-family: system-ui, sans-serif; user-select: none;
    }
    #sim-toggle {
      display: block; margin-left: auto;
      width: 52px; height: 52px; border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(14,13,11,0.88); color: #e8dcc8;
      font-size: 22px; cursor: pointer; touch-action: manipulation;
    }
    #sim-panel {
      display: none; margin-bottom: 10px;
      background: rgba(14,13,11,0.92); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px; padding: 18px 16px; min-width: 220px;
      touch-action: pan-y;
    }
    #sim-panel.open { display: block; }
    .sim-row { margin-bottom: 16px; }
    .sim-row-head {
      display: flex; justify-content: space-between; align-items: baseline;
      color: #e8dcc8; font-size: 11px; letter-spacing: 0.05em;
      text-transform: uppercase; margin-bottom: 6px; opacity: 0.75;
    }
    .sim-val { font-variant-numeric: tabular-nums; opacity: 0.55; }
    .sim-row input[type=range] {
      -webkit-appearance: none; appearance: none;
      width: 100%; height: 32px; background: transparent;
      cursor: pointer; touch-action: pan-x;
    }
    .sim-row input[type=range]::-webkit-slider-runnable-track {
      height: 3px; background: rgba(255,255,255,0.2); border-radius: 2px;
    }
    .sim-row input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none; width: 22px; height: 22px;
      margin-top: -9px; border-radius: 50%;
      background: #c8b89a; border: none;
    }
    .sim-row input[type=range]::-moz-range-track {
      height: 3px; background: rgba(255,255,255,0.2);
    }
    .sim-row input[type=range]::-moz-range-thumb {
      width: 22px; height: 22px; border-radius: 50%;
      background: #c8b89a; border: none;
    }
    #sim-reset {
      width: 100%; padding: 12px; margin-top: 4px;
      border-radius: 8px; border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.05); color: #e8dcc8;
      font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
      cursor: pointer; touch-action: manipulation;
    }
    #sim-reset:active { background: rgba(255,255,255,0.12); }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'sim-controls';

  const panel = document.createElement('div');
  panel.id = 'sim-panel';

  for (const p of params) {
    const row = document.createElement('div');
    row.className = 'sim-row';

    const valSpan = document.createElement('span');
    valSpan.className = 'sim-val';
    const decimals = p.step < 0.01 ? 3 : p.step < 0.1 ? 2 : p.step < 1 ? 2 : 0;
    valSpan.textContent = Number(p.value).toFixed(decimals);

    const head = document.createElement('div');
    head.className = 'sim-row-head';
    head.append(Object.assign(document.createElement('span'), { textContent: p.label }), valSpan);

    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min: p.min, max: p.max, step: p.step, value: p.value });
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      p.onChange(v);
      valSpan.textContent = v.toFixed(decimals);
    });

    row.append(head, input);
    panel.appendChild(row);
  }

  const resetBtn = document.createElement('button');
  resetBtn.id = 'sim-reset';
  resetBtn.textContent = 'Reset Sand';
  resetBtn.addEventListener('click', onReset);
  panel.appendChild(resetBtn);

  const toggle = document.createElement('button');
  toggle.id = 'sim-toggle';
  toggle.setAttribute('aria-label', 'Toggle controls');
  toggle.textContent = '⚙';
  toggle.addEventListener('click', () => panel.classList.toggle('open'));

  root.append(panel, toggle);
  document.body.appendChild(root);
}
