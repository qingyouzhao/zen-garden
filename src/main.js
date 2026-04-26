import { Game } from './game.js';
import { createInput } from './input.js';

const canvas = document.getElementById('garden');
const game = new Game(canvas);
const input = createInput(canvas);

let last = 0;
function loop(ts) {
  const dt = Math.min((ts - last) / 1000, 0.05); // cap at 50ms
  last = ts;
  game.update(dt, input.flush());
  game.draw();
  requestAnimationFrame(loop);
}

game.init();
requestAnimationFrame((ts) => { last = ts; loop(ts); });
