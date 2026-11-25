import Resolver from './resolver';

export const resolveTestEnvironment = (name: string) => Resolver.findNodeModule(name);
export function resolveRunner(name: string): string {
  return name;
}
