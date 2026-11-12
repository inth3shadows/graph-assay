import { createRoot } from 'react-dom/client';
import * as net from 'net';
import { createServer } from 'net';
export function a(el: HTMLElement) { const root = createRoot(el); root.render(null); }
export function b() { const s = net.createServer(); s.close(); }
export function c() { const s = createServer(); s.close(); }
export function d(canvas: HTMLCanvasElement) { const ctx = canvas.getContext('2d')!; ctx.translate(1); }
export function e(canvas: HTMLCanvasElement) { canvas.getContext('2d')!.translate(1); }
