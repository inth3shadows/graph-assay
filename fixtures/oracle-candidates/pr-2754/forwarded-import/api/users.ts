import { presentUser, team } from '../presenters';
export function show() { return presentUser() + team(); }
