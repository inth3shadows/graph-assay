// src/index.ts
export type KyInstance = {
	create: (defaults?: object) => KyInstance;
};

declare function createInstance(): KyInstance;

const ky = createInstance();
export default ky;
