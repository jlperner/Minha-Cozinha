// Minha Cozinha: biblioteca de receitas guardada no próprio aparelho (IndexedDB), funciona sem internet.
// Cada receita pode ser um link (YouTube, Instagram, TikTok, site), um PDF, uma foto ou um texto.
// PDFs viram imagens das páginas na hora de adicionar, para abrir offline em qualquer aparelho.

const $ = (id) => document.getElementById(id);
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const TELA_W = 1240, THUMB_W = 480;

const TIPOS = {
  youtube: { nome: 'YouTube', ico: '▶', cor: '#fecaca' },
  instagram: { nome: 'Instagram', ico: '📷', cor: '#fbcfe8' },
  tiktok: { nome: 'TikTok', ico: '🎵', cor: '#e9d5ff' },
  pdf: { nome: 'PDF', ico: '📄', cor: '#fed7aa' },
  imagem: { nome: 'Foto', ico: '🖼', cor: '#bfdbfe' },
  link: { nome: 'Site', ico: '🔗', cor: '#bbf7d0' },
  texto: { nome: 'Texto', ico: '📝', cor: '#fef08a' },
};

// ---------- Banco de dados simples (chave → valor) ----------
let dbPromise;
function idb() {
  dbPromise ||= new Promise((ok, fail) => {
    const r = indexedDB.open('receitas', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  return dbPromise;
}
async function dbGet(k) {
  const db = await idb();
  return new Promise((ok, fail) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
}
async function dbSet(k, v) {
  const db = await idb();
  return new Promise((ok, fail) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => ok(); t.onerror = () => fail(t.error); });
}
async function dbDelPrefix(prefix) {
  const db = await idb();
  return new Promise((ok, fail) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(IDBKeyRange.bound(prefix, prefix + '￿')); t.oncomplete = () => ok(); t.onerror = () => fail(t.error); });
}
async function dbKeys(prefix) {
  const db = await idb();
  return new Promise((ok, fail) => { const r = db.transaction('kv').objectStore('kv').getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿')); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
}

// ---------- Estado ----------
// receita: { id, tipo, titulo, origem, nota (0-5), url, notas, cat, fav, criado, paginas, texto, temThumb, thumbUrl, arquivoNome, arquivoTipo }
let receitas = [];
let cats = [];
let filtroTipo = '', filtroCat = '', soFav = false;
const thumbs = {}; // id → object URL da miniatura guardada

const saveList = () => dbSet('lista', receitas);
const saveCats = () => dbSet('cats', cats);

async function init() {
  receitas = (await dbGet('lista').catch(() => null)) || [];
  cats = (await dbGet('cats').catch(() => null)) || [];
  for (const r of receitas) if (r.temThumb) {
    const b = await dbGet('thumb/' + r.id).catch(() => null);
    if (b) thumbs[r.id] = URL.createObjectURL(b);
  }
  renderTypes();
  fillCatBtn();
  render();
  await receiveShared();
  protectOnStart();
  completarFotos();
}

// ---------- Reconhecer o que foi colado ----------
const URL_RE = /https?:\/\/[^\s<>"']+/i;
function detectar(texto) {
  const t = (texto || '').trim();
  const m = t.match(URL_RE);
  if (!m) return t ? { tipo: 'texto' } : null;
  const url = m[0].replace(/[),.;!?]+$/, '');
  const resto = t.replace(m[0], '').trim();
  let u;
  try { u = new URL(url); } catch { return { tipo: 'texto' }; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let tipo = 'link', vid = null;
  if (host === 'youtu.be') { tipo = 'youtube'; vid = u.pathname.slice(1).split('/')[0]; }
  else if (host.endsWith('youtube.com')) {
    tipo = 'youtube';
    vid = u.searchParams.get('v') || (u.pathname.match(/\/(shorts|embed|live)\/([\w-]+)/) || [])[2];
  } else if (host.endsWith('instagram.com')) tipo = 'instagram';
  else if (host.endsWith('tiktok.com')) tipo = 'tiktok';
  else if (/\.pdf$/i.test(u.pathname)) tipo = 'pdf-link';
  else if (/\.(jpe?g|png|webp|gif)$/i.test(u.pathname)) tipo = 'imagem-link';
  return { tipo, url, vid, resto };
}
const ytId = (url) => detectar(url)?.vid;
const igPath = (url) => (url.match(/instagram\.com\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]+)/) || []);
const ttId = (url) => (url.match(/\/video\/(\d+)/) || [])[1];

// Título e foto automáticos do link (como a prévia do WhatsApp).
// 1º noembed (YouTube, Vimeo…), 2º oEmbed do TikTok, 3º microlink (lê a foto e o título de qualquer site).
const metaCache = {};
async function metaAuto(url) {
  if (metaCache[url]) return metaCache[url];
  const out = { title: '', image: '', author: '' };
  const enc = encodeURIComponent(url);
  const tenta = async (api, pega) => {
    if (out.title && out.image && out.author) return;
    try {
      const j = await (await fetch(api)).json();
      const r = pega(j) || {};
      out.title ||= r.title || '';
      out.image ||= r.image || '';
      out.author ||= r.author || '';
    } catch {}
  };
  await tenta('https://noembed.com/embed?url=' + enc, (j) => ({ title: j.title, image: j.thumbnail_url, author: j.author_name }));
  if (/tiktok\.com/.test(url)) await tenta('https://www.tiktok.com/oembed?url=' + enc, (j) => ({ title: j.title, image: j.thumbnail_url, author: j.author_name }));
  await tenta('https://api.microlink.io/?url=' + enc, (j) => j.status === 'success' && { title: j.data.title, image: j.data.image?.url || j.data.logo?.url, author: j.data.publisher || j.data.author });
  out.title = limpaTitulo(out.title, out.author);
  return (metaCache[url] = out);
}
// "Receita de Arroz carreteiro, enviada por fulano - TudoGostoso" → "Arroz carreteiro"
function limpaTitulo(t, site) {
  t = (t || '').trim();
  const partes = t.split(/\s+[-|–—]\s+/);
  if (partes.length > 1 && ((site && norm(partes.at(-1)).replace(/\s/g, '').includes(norm(site).replace(/\s/g, '').slice(0, 6))) || /receitas?|gostoso|panelinha|globo|nestle|cybercook|youtube|\.com/i.test(partes.at(-1)))) t = partes.slice(0, -1).join(' - ');
  t = t.replace(/,?\s+enviad[ao] por .*$/i, '').replace(/^receita (de|da|do)\s+/i, '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}
const tituloAuto = async (url) => (await metaAuto(url)).title;

// Guarda a foto do link no aparelho (para aparecer sem internet); se o site não deixar, usa o endereço dela
async function fotoDoLink(r) {
  if (r.temThumb || !r.url) return;
  if (!r.thumbUrl) r.thumbUrl = (await metaAuto(r.url)).image;
  if (!r.thumbUrl) return;
  try {
    const res = await fetch(r.thumbUrl);
    if (res.ok) await setThumb(r, await res.blob());
  } catch {}
}

// Receitas antigas sem foto: tenta buscar em segundo plano (algumas por vez)
async function completarFotos() {
  if (!navigator.onLine) return;
  const faltam = receitas.filter((r) => r.url && !r.temThumb && !r.thumbUrl && !r.semFoto).slice(0, 10);
  for (const r of faltam) {
    await fotoDoLink(r);
    if (!r.temThumb && !r.thumbUrl) r.semFoto = true; // não tenta de novo toda vez
    if (/^(Site|Instagram|TikTok|YouTube) \d/.test(r.titulo)) r.titulo = (await tituloAuto(r.url)) || r.titulo;
  }
  if (faltam.length) { await saveList(); render(); }
}

// ---------- Grade ----------
// dentro de uma categoria: barra com o nome dela e os filtros de tipo (YouTube, Site…)
function renderTypes() {
  const nav = $('types');
  nav.hidden = !filtroCat;
  if (!filtroCat) return;
  const daCat = receitas.filter((r) => (filtroCat === '__sem' ? !r.cat : r.cat === filtroCat));
  const pTipo = (t) => () => { filtroTipo = t; renderTypes(); render(); };
  nav.replaceChildren(
    Object.assign(button('', 'cat-atual', () => pickCat('')), { innerHTML: `${PANELA} ${esc(filtroCat === '__sem' ? 'Sem categoria' : filtroCat)} ✕` }),
    button(`Tudo (${daCat.length})`, filtroTipo ? '' : 'on', pTipo('')));
  for (const [t, d] of Object.entries(TIPOS)) {
    const n = daCat.filter((r) => r.tipo === t).length;
    if (n) nav.append(button(`${d.ico} ${d.nome} (${n})`, filtroTipo === t ? 'on' : '', pTipo(t)));
  }
}

// Busca na web: sites grandes de receita primeiro, depois outros lugares
const SITES = ['tudogostoso.com.br', 'receitas.globo.com', 'panelinha.com.br', 'receitasnestle.com.br', 'anamariabraga.globo.com', 'cybercook.com.br'];
function renderWeb(achou) {
  const t = $('search').value.trim();
  const web = $('web');
  web.hidden = !t;
  if (!t) return;
  // com resultados no app, a busca na web fica no fim da lista
  web.classList.toggle('fim', achou > 0);
  (achou > 0 ? $('grid') : $('status')).after(web);
  const e = encodeURIComponent;
  const g = (extra) => `https://www.google.com/search?q=${e(`receita ${t} ${extra}`.trim())}`;
  const a = (n, u, c = '') => `<a href="${esc(u)}" target="_blank" rel="noopener"${c && ` class="${c}"`}>${n}</a>`;
  // aberta quando não achou nada no app; se a pessoa abriu/fechou com a mesma situação, respeita
  const d = web.querySelector('details');
  const aberto = d && d.dataset.achou === String(!!achou) ? d.open : !achou;
  web.innerHTML = `<details data-achou="${!!achou}"${aberto ? ' open' : ''}><summary>🔎 Buscar "${esc(t)}" na web</summary><div class="opcoes">${[
    a('🍲 Sites de receita<small>TudoGostoso, Panelinha, Receitas Globo…</small>', g('(' + SITES.map((s) => 'site:' + s).join(' OR ') + ')')),
    a('🌐 Google<small>a internet toda</small>', g('')),
    a('▶ YouTube<small>vídeos</small>', `https://www.youtube.com/results?search_query=${e('receita ' + t)}`),
    a('🎵 TikTok<small>vídeos curtos</small>', `https://www.tiktok.com/search?q=${e('receita ' + t)}`),
    a('📷 Instagram<small>posts pela hashtag</small>', `https://www.instagram.com/explore/tags/${e(norm(t).replace(/[^a-z0-9]/g, ''))}/`),
  ].join('')}</div></details>`;
}

// clicar fora da sanfona da web fecha (menos na busca, para continuar digitando)
document.addEventListener('click', (e) => {
  const d = $('web').querySelector('details[open]');
  if (d && !d.contains(e.target) && !e.target.closest('.search-box')) d.open = false;
});

function render() {
  const q = norm($('search').value.trim());
  let list = [...receitas].sort((a, b) => b.criado - a.criado);
  if (filtroTipo) list = list.filter((r) => r.tipo === filtroTipo);
  if (filtroCat) list = list.filter((r) => (filtroCat === '__sem' ? !r.cat : r.cat === filtroCat));
  if (soFav) list = list.filter((r) => r.fav);
  if (q) list = list.filter((r) => q.split(/\s+/).every((w) => norm(`${r.titulo} ${r.origem || ''} ${r.notas} ${r.cat} ${r.url} ${r.texto || ''}`).includes(w)));
  const t = $('search').value.trim();
  $('status').textContent = !receitas.length ? '' : t && !list.length ? `Nada com "${t}" no app.` : `${list.length} receita(s)`;
  renderWeb(list.length);
  const grid = $('grid');
  grid.innerHTML = '';
  if (!receitas.length) {
    grid.innerHTML = `<div class="empty">Nenhuma receita ainda.<br><br>Toque no botão laranja <b>+</b> no canto da tela e cole um link do YouTube, Instagram, TikTok, de um site,
      uma mensagem do WhatsApp, ou escolha um PDF ou foto.<br><br>No Android, você também pode usar <b>Compartilhar → Minha Cozinha</b> direto do outro app.</div>`;
    return;
  }
  if (!list.length && !t) grid.innerHTML = '<div class="empty">Nada encontrado com esses filtros.</div>';
  for (const r of list) {
    const d = TIPOS[r.tipo] || TIPOS.link;
    const card = document.createElement('div');
    card.className = 'card';
    const src = thumbs[r.id] || r.thumbUrl;
    card.innerHTML = (src ? `<img class="thumb" loading="lazy" src="${esc(src)}" alt="">` : `<div class="ph" style="background:${d.cor}">${d.ico}</div>`) +
      (r.nota ? `<span class="badge nota">${'★'.repeat(r.nota)}<i>${'★'.repeat(5 - r.nota)}</i></span>` : '') +
      `<div class="info"><small class="tipo">${d.ico} ${d.nome}</small><b>${esc(r.titulo || 'Sem nome')}</b>${r.cat ? `<div class="cat">${esc(r.cat)}</div>` : ''}${q ? snippet(r, q) : ''}</div>`;
    const star = button(r.fav ? '★' : '☆', 'star', async (e) => {
      e.stopPropagation();
      r.fav = !r.fav;
      star.textContent = r.fav ? '★' : '☆';
      await saveList();
      if (soFav) render();
    });
    card.append(star);
    card.onclick = () => openView(r);
    grid.append(card);
  }
}
function snippet(r, q) {
  const w = q.split(/\s+/)[0];
  const txt = r.notas || r.texto || '';
  const i = norm(txt).indexOf(w);
  if (i < 0) return '';
  return `<div class="snip">…${esc(txt.slice(Math.max(0, i - 30), i))}<mark>${esc(txt.slice(i, i + w.length))}</mark>${esc(txt.slice(i + w.length, i + w.length + 50))}…</div>`;
}

function button(text, cls, onclick) {
  const b = document.createElement('button');
  b.textContent = text;
  if (cls) b.className = cls;
  b.onclick = onclick;
  return b;
}

let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3500);
}
function progress(text, frac) {
  $('prog').hidden = false;
  $('prog-text').textContent = text;
  $('prog-bar').style.width = Math.round(frac * 100) + '%';
}
const progressDone = () => ($('prog').hidden = true);

// ---------- Busca e filtros ----------
let st;
$('search').oninput = () => { $('clear').hidden = !$('search').value; clearTimeout(st); st = setTimeout(render, 200); };
$('clear').onclick = () => { $('search').value = ''; $('clear').hidden = true; render(); };
$('fav-btn').onclick = () => { soFav = !soFav; $('fav-btn').classList.toggle('on', soFav); render(); };

// ---------- Categorias ----------
// ícone de panela (desenho próprio: o emoji 🍲 varia muito entre aparelhos)
const PANELA = '<svg class="ico-panela" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M9 4.5c0-1 .7-1.5 1.5-1.5M14 3c.8 0 1.5.5 1.5 1.5"/><path d="M10 7h4"/><path d="M4 10h16"/><path d="M5 10v6a4 4 0 0 0 4 4h6a4 4 0 0 0 4-4v-6"/><path d="M2 10h2M20 10h2"/></svg>';
// botão de panela do topo: escolhe a categoria
function fillCatBtn() {
  const nome = filtroCat === '__sem' ? 'Sem categoria' : filtroCat;
  $('cat-btn').innerHTML = `${PANELA}<span class="txt"> ${esc(nome || 'Categorias')}</span>`;
  $('cat-btn').classList.toggle('active', !!filtroCat);
  renderTypes();
}
function openCatMenu() {
  const m = $('cat-menu');
  const conta = (c) => receitas.filter((r) => r.cat === c).length;
  m.replaceChildren(button(`Todas as receitas  (${receitas.length})`, filtroCat ? '' : 'on', () => pickCat('')));
  for (const c of cats) m.append(button(`${c}  (${conta(c)})`, c === filtroCat ? 'on' : '', () => pickCat(c)));
  const sem = receitas.filter((r) => !r.cat).length;
  if (sem) m.append(button(`Sem categoria  (${sem})`, filtroCat === '__sem' ? 'on' : '', () => pickCat('__sem')));
  m.append(button('⚙ Gerenciar categorias…', 'act', () => { m.hidden = true; openCatsDialog(); }));
  m.hidden = false;
}
// trocar de categoria zera o filtro de tipo
function pickCat(c) { filtroCat = c; filtroTipo = ''; $('cat-menu').hidden = true; fillCatBtn(); render(); }
$('cat-btn').onclick = (e) => { e.stopPropagation(); $('cat-menu').hidden ? openCatMenu() : ($('cat-menu').hidden = true); };

function openCatsDialog() {
  const box = $('cats-list');
  box.replaceChildren();
  if (!cats.length) box.innerHTML = '<p class="muted">Nenhuma categoria ainda.</p>';
  for (const c of cats) {
    const row = Object.assign(document.createElement('div'), { className: 'row' });
    const n = receitas.filter((r) => r.cat === c).length;
    row.append(Object.assign(document.createElement('b'), { textContent: `${c} (${n})` }));
    row.append(button('Renomear', '', () => {
      const input = Object.assign(document.createElement('input'), { value: c });
      const ok = button('OK', 'pri', async () => {
        const novo = input.value.trim();
        if (!novo || novo === c) return openCatsDialog();
        if (cats.includes(novo)) return toast('Já existe uma categoria com esse nome.');
        cats[cats.indexOf(c)] = novo;
        for (const r of receitas) if (r.cat === c) r.cat = novo;
        if (filtroCat === c) filtroCat = novo;
        await saveCats(); await saveList(); fillCatBtn(); render(); openCatsDialog();
      });
      row.replaceChildren(input, ok, button('Cancelar', '', openCatsDialog));
      input.focus();
    }));
    const del = button('Excluir', 'danger', async () => {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Confirmar?'; return; }
      cats = cats.filter((x) => x !== c);
      for (const r of receitas) if (r.cat === c) r.cat = '';
      if (filtroCat === c) filtroCat = '';
      await saveCats(); await saveList(); fillCatBtn(); render(); openCatsDialog();
      toast(`Categoria "${c}" excluída. As receitas continuam, sem categoria.`);
    });
    row.append(del);
    box.append(row);
  }
  if (!$('cats-dlg').open) $('cats-dlg').showModal();
}
async function addCat(nome) {
  nome = nome.trim();
  if (!nome) return '';
  if (!cats.includes(nome)) { cats.push(nome); cats.sort((a, b) => a.localeCompare(b, 'pt-BR')); await saveCats(); }
  return nome;
}
$('cat-new-btn').onclick = async () => { await addCat($('cat-new').value); $('cat-new').value = ''; openCatsDialog(); };
$('cats-close').onclick = () => $('cats-dlg').close();

// ---------- ⋯ Mais ----------
$('more-btn').onclick = (e) => {
  e.stopPropagation();
  const m = $('more-menu');
  if (!m.hidden) return (m.hidden = true);
  m.replaceChildren(
    button('💾 Backup (salvar / restaurar)', '', () => { m.hidden = true; openBackup(); }),
  );
  m.hidden = false;
};
document.addEventListener('click', (e) => {
  for (const id of ['cat-menu', 'more-menu']) if (!$(id).contains(e.target)) $(id).hidden = true;
});

// ---------- Adicionar / editar ----------
let editando = null;      // receita sendo editada (ou null para nova)
let novoArquivo = null;   // File escolhido (PDF ou foto)
let novaCapa = null;      // foto de capa escolhida para o cartão
let detectado = null;

// classificação no formulário: 1 a 5 estrelas (tocar de novo na mesma tira a nota)
let notaEscolhida = 0;
function fillNota(n) {
  notaEscolhida = n || 0;
  $('add-nota').replaceChildren(...[1, 2, 3, 4, 5].map((i) =>
    button(i <= notaEscolhida ? '★' : '☆', i <= notaEscolhida ? 'on' : '', () => fillNota(i === notaEscolhida ? 0 : i))),
    Object.assign(document.createElement('span'), { className: 'muted', textContent: ['Sem nota', 'Não gostei', 'Mais ou menos', 'Boa', 'Muito boa', 'Excelente!'][notaEscolhida] }));
}

// categoria no formulário: etiquetas clicáveis + "Nova" com campo na hora
let catEscolhida = '';
function fillCatChips(atual) {
  catEscolhida = atual || '';
  $('add-cat').classList.remove('falta');
  $('add-newcat-row').hidden = true;
  $('add-newcat').value = '';
  const box = $('add-cat');
  box.replaceChildren(
    ...cats.map((c) => button(c, c === catEscolhida ? 'on' : '', () => fillCatChips(c))),
    button('+ Nova', 'nova', () => { $('add-newcat-row').hidden = false; $('add-newcat').focus(); }),
  );
}
async function criarCatDoForm() {
  const nome = await addCat($('add-newcat').value);
  if (nome) fillCatChips(nome);
}
$('add-newcat-ok').onclick = criarCatDoForm;
$('add-newcat').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); criarCatDoForm(); } };

function openAdd(pre = {}) {
  editando = null;
  novoArquivo = pre.file || null;
  novaCapa = null;
  $('add-title').textContent = 'Adicionar receita';
  $('add-text').value = pre.text || '';
  $('add-name').value = pre.title || '';
  $('add-origem').value = '';
  $('add-notes').value = '';
  $('add-text').disabled = false;
  $('add-paste').hidden = $('add-file-btn').hidden = false;
  fillCatChips(filtroCat === '__sem' ? '' : filtroCat);
  fillNota(0);
  onAddChange();
  $('add-dlg').showModal();
}
function openEdit(r) {
  editando = r;
  novoArquivo = null;
  novaCapa = null;
  $('add-title').textContent = 'Editar receita';
  $('add-text').value = r.url || (r.tipo === 'texto' ? r.notas : '');
  $('add-text').disabled = !!r.arquivoNome;
  $('add-paste').hidden = $('add-file-btn').hidden = !!r.arquivoNome;
  $('add-name').value = r.titulo;
  $('add-origem').value = r.origem || '';
  $('add-notes').value = r.tipo === 'texto' ? '' : r.notas || '';
  fillCatChips(r.cat);
  fillNota(r.nota);
  $('add-detect').textContent = r.arquivoNome ? `${TIPOS[r.tipo].ico} ${r.arquivoNome}` : '';
  $('add-preview').replaceChildren();
  $('add-dlg').showModal();
}

let nameTimer;
async function onAddChange() {
  const prev = $('add-preview');
  prev.replaceChildren();
  if (novoArquivo) {
    const pdf = /pdf/i.test(novoArquivo.type) || /\.pdf$/i.test(novoArquivo.name);
    detectado = { tipo: pdf ? 'pdf' : 'imagem' };
    $('add-detect').textContent = `${pdf ? '📄 PDF' : '🖼 Foto'}: ${novoArquivo.name}`;
    if (!$('add-name').value) $('add-name').value = novoArquivo.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    if (!pdf) prev.append(Object.assign(document.createElement('img'), { src: URL.createObjectURL(novoArquivo) }));
    return;
  }
  detectado = detectar($('add-text').value);
  if (!detectado) { $('add-detect').textContent = ''; return; }
  const nomes = { 'pdf-link': '📄 Link de PDF', 'imagem-link': '🖼 Link de foto' };
  $('add-detect').textContent = 'Reconhecido: ' + (nomes[detectado.tipo] || `${TIPOS[detectado.tipo].ico} ${TIPOS[detectado.tipo].nome}`);
  if (novaCapa) prev.append(Object.assign(document.createElement('img'), { src: URL.createObjectURL(novaCapa) }));
  else if (detectado.tipo === 'youtube' && detectado.vid) {
    prev.append(Object.assign(document.createElement('img'), { src: `https://i.ytimg.com/vi/${detectado.vid}/hqdefault.jpg` }));
  }
  if (detectado.url) {
    clearTimeout(nameTimer);
    const url = detectado.url;
    nameTimer = setTimeout(async () => {
      const busca = Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Buscando foto e título…' });
      if (!prev.querySelector('img')) prev.append(busca);
      const m = await metaAuto(url);
      busca.remove();
      if (detectado?.url !== url) return;
      if (m.title && !$('add-name').value) $('add-name').value = m.title;
      if (m.author && !$('add-origem').value) $('add-origem').value = m.author;
      if (m.image && !prev.querySelector('img')) prev.append(Object.assign(document.createElement('img'), { src: m.image }));
      if (!m.image && !prev.querySelector('img')) prev.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Este site não mostra foto. Use 🖼 Foto de capa se quiser.' }));
    }, 400);
  }
}
$('add-text').oninput = () => { novoArquivo = null; onAddChange(); };
$('add-paste').onclick = async () => {
  try { $('add-text').value = await navigator.clipboard.readText(); novoArquivo = null; onAddChange(); }
  catch { toast('Não foi possível colar automaticamente. Toque e segure no campo e escolha Colar.'); }
};
$('add-file-btn').onclick = () => $('add-file').click();
$('add-cover-btn').onclick = () => $('add-cover').click();
$('add-cover').onchange = (e) => {
  if (!e.target.files[0]) return;
  novaCapa = e.target.files[0];
  e.target.value = '';
  const prev = $('add-preview');
  prev.replaceChildren(Object.assign(document.createElement('img'), { src: URL.createObjectURL(novaCapa) }),
    Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Foto de capa escolhida' }));
};
$('add-file').onchange = (e) => { if (e.target.files[0]) { novoArquivo = e.target.files[0]; onAddChange(); } e.target.value = ''; };
$('add-cancel').onclick = () => $('add-dlg').close();

$('add-save').onclick = async () => {
  // nome digitado em "Nova" e não confirmado também vale
  let cat = catEscolhida;
  if (!$('add-newcat-row').hidden && $('add-newcat').value.trim()) cat = await addCat($('add-newcat').value);
  // categoria é obrigatória
  if (!cat) {
    $('add-cat').classList.add('falta');
    $('add-cat').scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (!cats.length) { $('add-newcat-row').hidden = false; $('add-newcat').focus(); }
    return toast('Escolha uma categoria para a receita.');
  }
  const titulo = $('add-name').value.trim();
  const notas = $('add-notes').value.trim();
  const origem = $('add-origem').value.trim();

  if (editando) {
    const r = editando;
    r.titulo = titulo || r.titulo;
    r.origem = origem;
    r.nota = notaEscolhida;
    r.cat = cat;
    if (!r.arquivoNome) {
      const d = detectar($('add-text').value);
      if (d?.url) Object.assign(r, tipoDeLink(d), { notas });
      else if (d?.tipo === 'texto') Object.assign(r, { tipo: 'texto', url: '', notas: $('add-text').value.trim() });
    } else r.notas = notas;
    if (novaCapa) { await setThumb(r, novaCapa); r.semFoto = false; }
    else if (!r.temThumb && r.url) await fotoDoLink(r);
    await saveList();
    $('add-dlg').close();
    renderTypes(); render();
    toast('Receita atualizada.');
    if (!$('view').hidden) openView(r);
    return;
  }

  if (!novoArquivo && !detectado) return toast('Cole um link ou texto, ou escolha um PDF ou foto.');
  const r = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), titulo, origem, nota: notaEscolhida, notas, cat, fav: false, criado: Date.now() };
  $('add-dlg').close();
  try {
    if (novoArquivo) await guardarArquivo(r, novoArquivo);
    else if (detectado.tipo === 'texto') Object.assign(r, { tipo: 'texto', notas: [$('add-text').value.trim(), notas].filter(Boolean).join('\n\n') });
    else if (detectado.tipo === 'pdf-link' || detectado.tipo === 'imagem-link') await baixarArquivo(r, detectado.url);
    else Object.assign(r, tipoDeLink(detectado), { notas: [detectado.resto, notas].filter(Boolean).join('\n\n') });
  } catch (e) {
    progressDone();
    return toast('Não foi possível adicionar: ' + e.message);
  }
  if (novaCapa) await setThumb(r, novaCapa);
  else await fotoDoLink(r);
  if (!r.titulo) r.titulo = (r.url && (await tituloAuto(r.url))) || TIPOS[r.tipo].nome + ' ' + new Date().toLocaleDateString('pt-BR');
  receitas.push(r);
  await saveList();
  renderTypes(); render();
  toast(`"${r.titulo}" adicionada.`);
};

function tipoDeLink(d) {
  const out = { tipo: d.tipo, url: d.url, thumbUrl: '' };
  if (d.tipo === 'youtube' && d.vid) out.thumbUrl = `https://i.ytimg.com/vi/${d.vid}/hqdefault.jpg`;
  return out;
}

// PDF ou foto do aparelho → guardado no banco (PDF vira imagens das páginas, para abrir offline)
async function guardarArquivo(r, file) {
  const pdf = /pdf/i.test(file.type) || /\.pdf$/i.test(file.name);
  r.arquivoNome = file.name;
  r.arquivoTipo = file.type || (pdf ? 'application/pdf' : 'image/jpeg');
  if (!r.titulo) r.titulo = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  await dbSet('arq/' + r.id, file);
  if (pdf) {
    r.tipo = 'pdf';
    await loadScript(PDFJS);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const doc = await pdfjsLib.getDocument({ url: URL.createObjectURL(file) }).promise;
    r.paginas = doc.numPages;
    const textos = [];
    for (let n = 1; n <= doc.numPages; n++) {
      progress(`Preparando o PDF: página ${n} de ${doc.numPages}…`, (n - 1) / doc.numPages);
      const page = await doc.getPage(n);
      const tela = await renderPage(page, TELA_W);
      await dbSet(`pag/${r.id}/${n}`, tela);
      if (n === 1) await setThumb(r, tela);
      try { textos.push((await page.getTextContent()).items.map((i) => i.str).join(' ')); } catch {}
      page.cleanup();
    }
    r.texto = textos.join(' ').replace(/\s+/g, ' ').slice(0, 20000); // para a busca achar ingredientes
    doc.destroy();
    progressDone();
  } else {
    r.tipo = 'imagem';
    await setThumb(r, file);
  }
}
async function baixarArquivo(r, url) {
  progress('Baixando o arquivo…', 0.3);
  const res = await fetch(url).catch(() => null);
  progressDone();
  if (!res || !res.ok) {
    // o site não deixa baixar direto: guarda como link
    Object.assign(r, { tipo: 'link', url });
    return;
  }
  const blob = await res.blob();
  const nome = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'arquivo');
  await guardarArquivo(r, new File([blob], nome, { type: blob.type }));
  r.url = url;
}

async function setThumb(r, blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = Math.min(THUMB_W, bmp.width);
  c.height = Math.round(bmp.height * (c.width / bmp.width));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const t = await toJpg(c, 0.75);
  await dbSet('thumb/' + r.id, t);
  r.temThumb = true;
  thumbs[r.id] = URL.createObjectURL(t);
}
const toJpg = (c, q) => new Promise((ok) => c.toBlob(ok, 'image/jpeg', q));
async function renderPage(page, width) {
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / base.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return toJpg(c, 0.8);
}
const scripts = {};
function loadScript(src) {
  scripts[src] ||= new Promise((ok, fail) => {
    document.head.append(Object.assign(document.createElement('script'), { src, onload: ok, onerror: () => fail(new Error('sem internet para carregar o leitor de PDF')) }));
  });
  return scripts[src];
}

$('add-btn').onclick = () => openAdd();

// ---------- Ver receita ----------
let vendo = null;
async function openView(r) {
  vendo = r;
  $('view').hidden = false;
  $('v-title').textContent = `${TIPOS[r.tipo].ico} ${r.titulo}`;
  $('v-fav').textContent = r.fav ? '★' : '☆';
  $('v-open').hidden = !r.url;
  delete $('v-del').dataset.armed;
  $('v-del').textContent = '🗑';
  const body = $('v-body');
  body.replaceChildren();
  body.scrollTo(0, 0);
  const offline = !navigator.onLine;
  let media = '';
  if (r.tipo === 'youtube' && ytId(r.url)) {
    media = `<div class="v-media"><iframe src="https://www.youtube-nocookie.com/embed/${ytId(r.url)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
  } else if (r.tipo === 'instagram' && igPath(r.url)[2]) {
    const [, k, code] = igPath(r.url);
    media = `<div class="v-media"><iframe class="tall" src="https://www.instagram.com/${k === 'reels' ? 'reel' : k}/${code}/embed/captioned/"></iframe></div>`;
  } else if (r.tipo === 'tiktok' && ttId(r.url)) {
    media = `<div class="v-media"><iframe class="tall" src="https://www.tiktok.com/embed/v2/${ttId(r.url)}"></iframe></div>`;
  }
  const card = document.createElement('div');
  card.className = 'v-card';
  const precisaNet = ['youtube', 'instagram', 'tiktok', 'link'].includes(r.tipo);
  card.innerHTML = `${offline && precisaNet ? '<div class="offline">Sem internet: o vídeo/post só aparece com conexão. As anotações estão abaixo.</div>' : ''}
    ${r.tipo === 'link' && r.thumbUrl ? `<div class="v-link"><img src="${esc(r.thumbUrl)}" alt=""></div>` : ''}
    <h2>${esc(r.titulo)}</h2>
    ${r.nota ? `<div class="v-nota">${'★'.repeat(r.nota)}<i>${'★'.repeat(5 - r.nota)}</i></div>` : ''}
    ${r.origem ? `<div class="meta">👤 Autor: ${esc(r.origem)}</div>` : ''}
    <div class="meta">${r.cat ? '🏷 ' + esc(r.cat) + ' · ' : ''}${TIPOS[r.tipo].nome}${r.url ? ' · ' + esc(r.url) : ''}</div>
    ${r.url && (r.tipo === 'link' || !media) ? `<a class="open" href="${esc(r.url)}" target="_blank" rel="noopener">🌐 Abrir ${r.tipo === 'link' ? 'o site' : 'no ' + TIPOS[r.tipo].nome}</a>` : ''}
    ${r.notas ? `<div class="notes">${esc(r.notas)}</div>` : r.tipo !== 'pdf' && r.tipo !== 'imagem' ? '<p class="muted">Sem anotações. Toque em ✏ Editar para escrever ingredientes e dicas.</p>' : ''}`;
  if (media) body.insertAdjacentHTML('beforeend', media);
  if (r.tipo === 'pdf' || r.tipo === 'imagem') {
    const pagesBox = document.createElement('div');
    pagesBox.className = 'v-pages';
    body.append(pagesBox);
    if (r.tipo === 'pdf') {
      for (let n = 1; n <= (r.paginas || 0); n++) {
        const b = await dbGet(`pag/${r.id}/${n}`);
        if (b) pagesBox.append(Object.assign(document.createElement('img'), { src: URL.createObjectURL(b), loading: 'lazy' }));
      }
    } else {
      const b = await dbGet('arq/' + r.id);
      if (b) pagesBox.append(Object.assign(document.createElement('img'), { src: URL.createObjectURL(b) }));
    }
  }
  body.append(card);
}
$('v-close').onclick = () => { $('view').hidden = true; $('v-body').replaceChildren(); render(); };
$('v-fav').onclick = async () => { vendo.fav = !vendo.fav; $('v-fav').textContent = vendo.fav ? '★' : '☆'; await saveList(); };
$('v-open').onclick = () => window.open(vendo.url, '_blank', 'noopener');
$('v-edit').onclick = () => openEdit(vendo);
$('v-del').onclick = async () => {
  const b = $('v-del');
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Excluir?'; return; }
  const r = vendo;
  receitas = receitas.filter((x) => x.id !== r.id);
  await saveList();
  await Promise.all([dbDelPrefix('arq/' + r.id), dbDelPrefix('thumb/' + r.id), dbDelPrefix(`pag/${r.id}/`)]);
  $('view').hidden = true;
  renderTypes(); render();
  toast(`"${r.titulo}" excluída.`);
};

// ---------- Enviar (WhatsApp e outros) ----------
function textoDaReceita(r) {
  return [`🍽 ${r.titulo}`, r.origem && `Autor: ${r.origem}`, r.url, r.notas].filter(Boolean).join('\n\n');
}
async function arquivoDaReceita(r) {
  if (!r.arquivoNome) return null;
  const b = await dbGet('arq/' + r.id);
  return b ? new File([b], r.arquivoNome, { type: r.arquivoTipo || b.type }) : null;
}
async function enviar(r, soWhats) {
  const text = textoDaReceita(r);
  const file = await arquivoDaReceita(r);
  if (file && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text }); } catch {}
    return;
  }
  if (!soWhats && navigator.share) {
    try { await navigator.share({ title: r.titulo, text }); } catch {}
    return;
  }
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
}
$('v-zap').onclick = () => enviar(vendo, true);
$('v-share').onclick = () => enviar(vendo, false);

// ---------- Receber pelo "Compartilhar" do Android (share target) ----------
// O service worker guarda o que chegou e abre o app com ?compartilhado=1
async function receiveShared() {
  if (!new URLSearchParams(location.search).has('compartilhado')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('inbox');
    const meta = await (await cache.match('inbox/meta'))?.json();
    const fileRes = await cache.match('inbox/file');
    let file = null;
    if (fileRes) {
      const blob = await fileRes.blob();
      file = new File([blob], meta?.fileName || 'arquivo', { type: blob.type });
    }
    await caches.delete('inbox');
    const text = [meta?.text, meta?.url].filter(Boolean).join(' ').trim();
    openAdd({ text, title: meta?.title || '', file });
  } catch {
    toast('Não foi possível receber o conteúdo compartilhado.');
  }
}

// ---------- Backup ----------
const blobToDataUrl = (b) => new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); });
async function openBackup() {
  $('bkp-dlg').showModal();
  showStorageInfo();
}
$('bkp-close').onclick = () => $('bkp-dlg').close();
$('bkp-export').onclick = async () => {
  try {
    const arquivos = {};
    const keys = [...(await dbKeys('arq/')), ...(await dbKeys('thumb/')), ...(await dbKeys('pag/'))];
    for (const [i, k] of keys.entries()) {
      progress(`Preparando backup: ${i + 1} de ${keys.length} arquivos…`, i / Math.max(1, keys.length));
      const b = await dbGet(k);
      if (b) arquivos[k] = await blobToDataUrl(b);
    }
    progressDone();
    const data = JSON.stringify({ app: 'receitas', versao: 1, receitas, cats, arquivos });
    const nome = `receitas-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([data], nome, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: nome }); return; } catch {}
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: nome });
    a.click();
    toast('Backup salvo.');
  } catch (e) {
    progressDone();
    toast('Não foi possível salvar o backup: ' + e.message);
  }
};
$('bkp-import-btn').onclick = () => $('bkp-file').click();
$('bkp-file').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.app !== 'receitas') throw new Error('não é um backup de receitas');
    const ids = new Set(receitas.map((r) => r.id));
    const novas = d.receitas.filter((r) => !ids.has(r.id));
    const entradas = Object.entries(d.arquivos || {}).filter(([k]) => novas.some((r) => k.includes(r.id)));
    for (const [i, [k, url]] of entradas.entries()) {
      progress(`Restaurando: ${i + 1} de ${entradas.length} arquivos…`, i / Math.max(1, entradas.length));
      await dbSet(k, await (await fetch(url)).blob());
    }
    progressDone();
    receitas.push(...novas);
    for (const c of d.cats || []) if (!cats.includes(c)) cats.push(c);
    await saveList(); await saveCats();
    for (const r of novas) if (r.temThumb) { const b = await dbGet('thumb/' + r.id); if (b) thumbs[r.id] = URL.createObjectURL(b); }
    $('bkp-dlg').close();
    renderTypes(); fillCatBtn(); render();
    toast(`${novas.length} receita(s) restaurada(s)${d.receitas.length - novas.length ? `, ${d.receitas.length - novas.length} já existiam` : ''}.`);
  } catch (err) {
    progressDone();
    toast('Não foi possível restaurar: ' + err.message);
  }
};

// ---------- Proteção do armazenamento e aviso para instalar ----------
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
async function showStorageInfo() {
  const el = $('bkp-storage');
  if (!navigator.storage?.estimate) return;
  let persisted = false, usado = 0;
  try { persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch {}
  try { usado = (await navigator.storage.estimate()).usage || 0; } catch {}
  const mb = Math.round(usado / 1048576);
  el.hidden = false;
  el.className = 'storage ' + (persisted ? 'ok' : 'warn');
  el.textContent = persisted
    ? `🔒 Protegido · ${mb} MB guardados. O sistema não apaga sozinho.`
    : `⚠ Não protegido · ${mb} MB guardados. ${isIOS() ? 'Para proteger: Safari → Compartilhar → Adicionar à Tela de Início, e use pelo ícone.' : 'Para proteger: no Chrome, menu ⋮ → Instalar app, e use pelo ícone.'} Faça backups de vez em quando.`;
}
let installEvent = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; showInstallBanner(); });
function showInstallBanner() {
  if (isInstalled() || !matchMedia('(pointer: coarse)').matches) return;
  let adiado = 0;
  try { adiado = +localStorage.getItem('install-adiado') || 0; } catch {}
  if (Date.now() - adiado < 3 * 86400000) return;
  $('install-text').innerHTML = isIOS()
    ? '<b>Instale o app para guardar suas receitas com segurança:</b> toque em <b>Compartilhar</b> (□↑) e depois em <b>Adicionar à Tela de Início</b>.'
    : installEvent ? '<b>Instale o app</b> para guardar suas receitas com segurança e receber links pelo <b>Compartilhar</b> do WhatsApp, Instagram e YouTube.'
      : '<b>Instale o app:</b> no menu <b>⋮</b> do Chrome, toque em <b>Instalar app</b>.';
  $('install-go').hidden = !installEvent;
  $('install-bar').hidden = false;
}
$('install-go').onclick = async () => { if (!installEvent) return; installEvent.prompt(); await installEvent.userChoice.catch(() => {}); installEvent = null; $('install-bar').hidden = true; };
$('install-later').onclick = () => { try { localStorage.setItem('install-adiado', Date.now()); } catch {} $('install-bar').hidden = true; };
addEventListener('appinstalled', () => ($('install-bar').hidden = true));
function protectOnStart() {
  if (navigator.storage?.persist && isInstalled()) navigator.storage.persist().catch(() => {});
  showInstallBanner();
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
init();
