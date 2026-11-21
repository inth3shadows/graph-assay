import type { Scene } from './scene';
import type { OnChange, OnScene } from './types';

export const destructured: OnChange = ({ scene, value }) => {
  scene.mutateElement(value);
};

export const plain: OnScene = (scene) => {
  scene.mutateElement(1);
};

export const annotated = ({ scene, value }: { scene: Scene; value: number }) => {
  scene.mutateElement(value);
};
