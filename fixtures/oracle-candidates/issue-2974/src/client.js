async function loadGithubProfile (name) { return fetch(`https://api.github.com/users/${name}`) }
async function loadOwn (id) { return fetch(`/users/${id}`) }
