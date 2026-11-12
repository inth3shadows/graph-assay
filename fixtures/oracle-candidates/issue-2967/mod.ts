export function a() {
  function helper() { return 1; }
  return helper();
}
function helper() { return 2; }
export { helper as run };
