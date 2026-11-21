export class Viewport {
  translate(x: number, y: number): number { return x + y; }
}

export function chained() {
  const context = document.createElement('canvas').getContext('2d')!;
  context.translate(1, 2);
}

export function twoSteps() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  context.translate(1, 2);
}

export function annotated() {
  const context: CanvasRenderingContext2D = document.createElement('canvas').getContext('2d')!;
  context.translate(1, 2);
}

function createCanvas(): HTMLCanvasElement {
  return document.createElement('canvas');
}

export function fromFactory() {
  const canvas = createCanvas();
  const context = canvas.getContext('2d')!;
  context.translate(1, 2);
}

export function fromParam(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d')!;
  context.translate(1, 2);
}
