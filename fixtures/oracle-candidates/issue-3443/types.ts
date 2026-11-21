import type { Scene } from './scene';
export type OnChange = (props: { scene: Scene; value: number }) => void;
export type OnScene = (scene: Scene) => void;
