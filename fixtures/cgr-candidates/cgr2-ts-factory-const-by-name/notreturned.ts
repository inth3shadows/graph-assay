const makeB = () => { const go = (u: string) => u; const other = (u: string) => go(u) + '!'; return other; };
export const go = makeB();
