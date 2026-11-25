import type { Maker, MakerApi, MakerFn } from './makers';
export function viaClass(m: Maker) { const s = m.make(); return s.area(); }
export function viaInterface(m: MakerApi) { const s = m.make(); return s.area(); }
export function viaProperty(m: MakerFn) { const s = m.make(); return s.area(); }
