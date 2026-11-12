import {ky} from './returned';
import {go} from './notreturned';
import {run} from './renamed';
export function callReturned() { return ky('/a'); }
export function callNotReturned() { return go('/a'); }
export function callRenamed() { return run('/a'); }
