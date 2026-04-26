import { Garden } from './garden.js';
import { Renderer } from './renderer.js';
import { load, save } from './save.js';

const LOGICAL_W = 1200;
const LOGICAL_H = 800;

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.garden = null;
    this.renderer = null;
    this.tool = 'rake'; // 'rake' | 'stone' | 'erase'
  }

  init() {
    this._resize();
    window.addEventListener('resize', () => this._resize());

    const saved = load();
    this.garden = saved ? Garden.fromJSON(saved) : new Garden(LOGICAL_W, LOGICAL_H);
    this.renderer = new Renderer(this.ctx, LOGICAL_W, LOGICAL_H);

    window.addEventListener('keydown', (e) => {
      if (e.key === 's') save(this.garden.toJSON());
    });
  }

  update(dt, intents) {
    for (const intent of intents) {
      if (intent.type === 'stroke') {
        this.garden.applyStroke(intent.x, intent.y, intent.angle, intent.pressure);
      }
    }
  }

  draw() {
    this.renderer.clear();
    this.renderer.drawGarden(this.garden);
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(window.innerWidth / LOGICAL_W, window.innerHeight / LOGICAL_H);
    this.canvas.style.width = `${LOGICAL_W * scale}px`;
    this.canvas.style.height = `${LOGICAL_H * scale}px`;
    this.canvas.width = LOGICAL_W * scale * dpr;
    this.canvas.height = LOGICAL_H * scale * dpr;
    this.ctx.scale(scale * dpr, scale * dpr);
  }
}
