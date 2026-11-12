export type ClientInstance = {
	(url: string): string;
	get: (url: string) => string;
	post: (url: string, body: string) => string;
};
