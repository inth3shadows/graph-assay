export function parse(s: string) {
  return parseInt(s, 10);
}

export function reply() {
  return new Response('ok');
}

export function stamp() {
  return Date.now();
}
