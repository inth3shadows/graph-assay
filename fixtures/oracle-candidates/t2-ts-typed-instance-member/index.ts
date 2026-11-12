import type {ClientInstance} from './types';

const request = (method: string, url: string) => `${method} ${url}`;

const createClient = (): ClientInstance => {
	const client: Partial<ClientInstance> = {};
	client.get = (url: string) => request('get', url);
	client.post = (url: string, body: string) => request('post', `${url} ${body}`);
	return client as ClientInstance;
};

const client = createClient();

export default client;
