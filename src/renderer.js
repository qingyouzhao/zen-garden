import { CELL } from './garden.js';

const SAND_BASE = '#c8b89a';
const SAND_LINE = '#a8956d';
const BG = '#b5a882';
const LINE_LEN = CELL * 0.9;
const LINE_W = 0.8;

export class Renderer {
  constructor(ctx, w, h) {
    this.ctx = ctx;
    this.w = w;
    this.h = h;
  }

  clear() {
    const { ctx, w, h } = this;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
  }

  drawGarden(garden) {
    const { ctx } = this;

    // Sand base
    ctx.fillStyle = SAND_BASE;
    ctx.fillRect(0, 0, garden.w, garden.h);

    // Raked lines
    ctx.strokeStyle = SAND_LINE;
    ctx.lineWidth = LINE_W;
    ctx.lineCap = 'round';

    for (let row = 0; row < garden.rows; row++) {
      for (let col = 0; col < garden.cols; col++) {
        const angle = garden.sand[row][col];
        if (angle === null) continue;
        const cx = col * CELL + CELL / 2;
        const cy = row * CELL + CELL / 2;
        const dx = Math.cos(angle) * LINE_LEN / 2;
        const dy = Math.sin(angle) * LINE_LEN / 2;
        ctx.beginPath();
        ctx.moveTo(cx - dx, cy - dy);
        ctx.lineTo(cx + dx, cy + dy);
        ctx.stroke();
      }
    }

    // Stones
    for (const stone of garden.stones) {
      this._drawStone(stone);
    }
  }

  _drawStone({ x, y, r }) {
    const { ctx } = this;
    const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    grad.addColorStop(0, '#888');
    grad.addColorStop(1, '#444');
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }
}
