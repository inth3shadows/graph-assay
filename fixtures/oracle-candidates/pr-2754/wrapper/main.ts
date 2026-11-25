import provision from './provisioner';
import job from './job';
import make from './svc';
export async function start() { await provision(); job(); return make(); }
