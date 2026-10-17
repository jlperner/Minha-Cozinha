// Guarda o app (e o leitor de PDF) para abrir sem internet; as receitas ficam no IndexedDB do app.
// Também recebe o que vem pelo "Compartilhar" do Android (share target) e entrega para o app.
const CACHE = 'receitas-v21';
const APP = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.json', 'icon.svg'];
const LIBS = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
];

self.addEventListener('install', (e) => e.waitUntil((async () => {
  const c = await caches.open(CACHE);
  await c.addAll(APP.map((u) => new Request(u, { cache: 'no-cache' })));
  try { await c.addAll(LIBS); } catch {}
  await self.skipWaiting();
})()));
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('receitas-v') && k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

async function receberCompartilhado(req) {
  const form = await req.formData();
  const inbox = await caches.open('inbox');
  const file = form.get('file');
  const meta = { title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', fileName: file && file.name };
  await inbox.put('inbox/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  if (file && file.size) await inbox.put('inbox/file', new Response(file, { headers: { 'Content-Type': file.type } }));
  else await inbox.delete('inbox/file');
  return Response.redirect('./?compartilhado=1', 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/compartilhar')) {
    e.respondWith(receberCompartilhado(e.request));
    return;
  }
  if (e.request.method !== 'GET' || !url.protocol.startsWith('http')) return;
  // Fotos de capa de outros sites (YouTube, Instagram, sites de receita): guarda para aparecerem offline
  if (e.request.destination === 'image' && url.origin !== location.origin) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open('receitas-fotos').then((c) => c.put(e.request, copy)); // fora do cache do app: não some nas atualizações
      return res;
    })));
    return;
  }
  // App e bibliotecas: rede primeiro (pega atualizações), sem internet usa o guardado
  if (url.origin === location.origin || LIBS.includes(url.href)) {
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(async () => (await caches.match(e.request, { ignoreSearch: true })) || (e.request.mode === 'navigate' ? caches.match('./') : Response.error())));
  }
});
