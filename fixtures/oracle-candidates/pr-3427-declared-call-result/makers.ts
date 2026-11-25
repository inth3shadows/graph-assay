import { Shape } from './shape';
export declare class Maker { make(): Shape }
export interface MakerApi { make(): Shape }
export type MakerFn = { make: () => Shape };
