export function send(msg: string): string {
  return encode(msg);
}

function encode(m: string): string {
  return `[ts] ${m}`;
}
