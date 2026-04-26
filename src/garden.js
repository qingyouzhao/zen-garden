const CELL = 8; // px per sand cell

export class Garden {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.cols = Math.ceil(w / CELL);
    this.rows = Math.ceil(h / CELL);
    // Each cell: null (unraked) or angle in radians
    this.sand = Array.from({ length: this.rows }, () => new Array(this.cols).fill(null));
    this.stones = []; // { x, y, r }
  }

  applyStroke(x, y, angle, pressure = 1) {
    const radius = Math.round(3 + pressure * 2); // cells
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const col = cx + dx;
        const row = cy + dy;
        if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) continue;
        this.sand[row][col] = angle;
      }
    }
  }

  toJSON() {
    return { w: this.w, h: this.h, sand: this.sand, stones: this.stones };
  }

  static fromJSON(data) {
    const g = new Garden(data.w, data.h);
    g.sand = data.sand;
    g.stones = data.stones ?? [];
    return g;
  }
}

export { CELL };
