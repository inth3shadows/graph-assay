import client from './index';

export function loadUser(id: string) {
	return client.get(`/users/${id}`);
}
