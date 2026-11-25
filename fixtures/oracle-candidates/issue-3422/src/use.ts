// src/use.ts
import {Maker, type MakerApi, type MakerFn, type Shape} from './shapes';

export function viaClass(m: Maker) {
	const s = m.make();
	return s.area();
}
export function viaInterface(m: MakerApi) {
	const s = m.make();
	return s.area();
}
export function viaProperty(m: MakerFn) {
	const s = m.make();
	return s.area();
}
export function annotated(m: MakerFn) {
	const s: Shape = m.make();
	return s.area();
}
