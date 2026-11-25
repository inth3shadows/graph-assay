// src/use.ts
import ky from 'ky';

export function selfImport() {
	return ky.create({});
}

export async function dynamicImport() {
	const {default: ky} = await import('./index.js');
	return ky.create({});
}
