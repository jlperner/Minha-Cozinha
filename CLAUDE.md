# Minha Cozinha

PWA (site instalável) de biblioteca de receitas, em português, para tablet e celular. Feito a partir do app de catálogo em `C:\Users\Jean L Perner\Desktop\catálogo fábio` (mesma base: instalar na tela inicial, offline, busca, favoritos, categorias, envio pelo WhatsApp). Não alterar o projeto do catálogo a partir daqui.

## Arquivos
- `index.html`, `styles.css`, `app.js`: o app inteiro (sem build, sem framework).
- `sw.js`: service worker. Guarda o app e o leitor de PDF (pdf.js do cdnjs) para abrir sem internet; fotos de outros sites ficam no cache `receitas-fotos`; recebe o "Compartilhar" do Android (`POST ./compartilhar`, share target do `manifest.json`) e redireciona para `./?compartilhado=1`.
- Ao mudar arquivos do app, aumentar a versão `CACHE` em `sw.js` para os aparelhos pegarem a nova versão.

## Como funciona
- Receitas ficam **no aparelho** (IndexedDB `receitas`, chave→valor): `lista` (metadados), `cats`, `arq/<id>` (arquivo original), `pag/<id>/<n>` (páginas do PDF em JPEG), `thumb/<id>`.
- Tipos: youtube, instagram, tiktok, pdf, imagem, link, texto (`detectar()` em `app.js`). Mensagem do WhatsApp com link vira o tipo do link, com a mensagem nas anotações.
- Título e foto automáticos: `metaAuto()` usa noembed, oEmbed do TikTok e microlink (grátis, ~50/dia). Instagram quase nunca dá foto → botão "🖼 Foto de capa".
- Campo "Autor" (guardado como `origem`; preenchido sozinho com canal/site via `metaAuto().author`, título limpo por `limpaTitulo()`): entra na busca, na tela da receita e no envio pelo WhatsApp.
- Categoria obrigatória no formulário (etiquetas `fillCatChips()`). Botão 🍲 no topo escolhe a categoria (`openCatMenu()`); dentro de uma categoria aparece a barra `#types` com o nome dela e os filtros de tipo (`renderTypes()`).
- Classificação: `nota` 0–5 estrelas, escolhida no formulário (`fillNota()`), aparece no canto superior esquerdo do cartão e na tela da receita.
- Ordenar (`ORDENS` em `app.js`, botão ⇅ ao lado da contagem): recentes, antigas, nome, nota, autor; a escolha fica no `localStorage`.
- Busca: mostra as receitas do app e, abaixo, a sanfona "Buscar na web" (`renderWeb()`): sites grandes de receita (lista `SITES`), Google, YouTube, TikTok, Instagram. Abre aberta quando não acha nada no app; fecha ao clicar fora.
- Backup: ⋯ → Backup gera um JSON com tudo (arquivos em base64) e restaura juntando.

## Teste local
Clique duas vezes em `abrir-receitas.bat` (ou `python -m http.server 8766` nesta pasta) → http://localhost:8766

## Pendente
- Publicar (ex.: GitHub Pages num repositório novo, como foi feito com o catálogo em https://jlperner.github.io/catalogo-ms-brasil/). Só com https o "Compartilhar" do Android, o envio de arquivos e a instalação funcionam no aparelho.
- Não foi testado em tablet/celular real, só no navegador do PC.
