import { withRetry } from './tracing';
export function helperFirst() { return 1; }
function SyncJob() { return 2; }
export default withRetry(SyncJob);
