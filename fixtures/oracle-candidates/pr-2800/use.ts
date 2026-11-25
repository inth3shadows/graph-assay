import Resolver, { resolveRunner } from './lib';

export const find = (name: string) => Resolver.findNodeModule(name);
export const make = () => new Resolver();
export const keep = (r: Resolver) => [r, resolveRunner('x')];
