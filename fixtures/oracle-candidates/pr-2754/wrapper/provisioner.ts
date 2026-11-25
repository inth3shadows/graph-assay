import { traceFunction } from './tracing';
export function helperFirst() { return 1; }
async function accountProvisioner() { return { ok: true }; }
export default traceFunction({ spanName: 'accountProvisioner' })(accountProvisioner);
