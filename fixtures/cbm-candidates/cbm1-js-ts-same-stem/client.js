export function send(msg) {
  return format(msg);
}

function format(m) {
  return `[js] ${m}`;
}
