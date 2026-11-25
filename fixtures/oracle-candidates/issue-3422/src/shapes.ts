// src/shapes.ts
export interface Shape {
	area(): number;
}
export class Maker {
	make(): Shape {
		return {area: () => 1};
	}
}
export interface MakerApi {
	make(): Shape;
}
export type MakerFn = {
	make: () => Shape;
};
