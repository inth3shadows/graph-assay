function buildMember(n: number) {
  return n;
}

export const api = {
  buildMember,
};

export function useApi() {
  return api.buildMember(1);
}
