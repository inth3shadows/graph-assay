import type {AliasMethod, AliasProp, IfaceMethod, IfaceProp} from './types';
export function useAliasProp(c: AliasProp) { return c.get('/a'); }
export function useAliasMethod(c: AliasMethod) { return c.get('/a'); }
export function useIfaceProp(c: IfaceProp) { return c.get('/a'); }
export function useIfaceMethod(c: IfaceMethod) { return c.get('/a'); }
