// Every request to pinnit.pages.dev (pages, files and /api) is answered by the Pinnit Worker.
// Normally through the service binding in wrangler.toml; if that binding is ever missing,
// it falls back to fetching the Worker's own address.
const WORKER = 'https://pinnit.tpotter098.workers.dev';

export async function onRequest({ request, env }) {
  if (env.PINNIT) return env.PINNIT.fetch(request);
  const url = new URL(request.url);
  return fetch(new Request(WORKER + url.pathname + url.search, request), { redirect: 'manual' });
}
