// Páginas HTML. Tudo o que é interpolado em h`...` é escapado, exceto o que vier de outro h`...` ou de raw().
import { TIPOS } from './reconcile.js';
import { NOTAS, MOEDAS, MEIO_NUMERARIO, rotuloDenominacao } from './numerario.js';
import { ROTULO_CANAL, canalDoMeio } from './validacao.js';

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(String(s));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function render(v) {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}
export function h(partes, ...valores) {
  let out = '';
  partes.forEach((p, i) => {
    out += p;
    if (i < valores.length) out += render(valores[i]);
  });
  return new Raw(out);
}

// ---------- Formatação ----------
export const euros = (v) =>
  v === null || v === undefined ? '' : Number(v).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
export const dataPT = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const diaSemana = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('pt-PT', { weekday: 'long', timeZone: 'UTC' });
export const quandoPT = (iso) =>
  iso ? new Date(iso).toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon', dateStyle: 'short', timeStyle: 'short' }) : '';
const valorCampo = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

// Caixa com que o auditor valida o valor de um meio (CASH, TPA...). É a mesma validação em todo o lado:
// grava ao marcar (app.js) e volta à página de onde veio, a lista ('lista') ou a página do fecho ('dia').
function formValidar(data, canal, x, conteudo, { origem = 'lista', query = '' } = {}) {
  // Validado pelos talões (TPA): a prova são os talões, por isso não se desmarca à mão.
  if (x.auto) {
    const dica = `Validado automaticamente: ${x.taloes} talão(ões) comprovam o valor por inteiro${x.porConfirmar ? ` (${x.porConfirmar} ainda por confirmar)` : ''}`;
    return h`<span class="valida auto" title="${dica}"><input type="checkbox" checked disabled aria-label="${ROTULO_CANAL[canal]} validado automaticamente"> <span>${conteudo}</span> <small class="auto-tag">auto</small></span>`;
  }
  const dica = x.validado ? `Validado por ${x.autor} em ${quandoPT(x.quando)}` : x.mudou ? 'O valor mudou desde a validação; valide de novo' : 'Marque para validar este valor';
  return h`<form method="post" action="/fechos/${data}/validar" data-validar>
    <input type="hidden" name="meio" value="${canal}"><input type="hidden" name="origem" value="${origem}"><input type="hidden" name="q" value="${query}"><input type="hidden" name="hash" value="">
    <label class="valida" title="${dica}"><input type="checkbox" name="validado" value="1" ${x.validado ? raw('checked') : ''} aria-label="Validar ${ROTULO_CANAL[canal]}"> <span>${conteudo}</span></label>
  </form>`;
}

const ESTADOS = { pendente: 'Pendente', justificada: 'Justificada', resolvida: 'Resolvida' };
const GRAVIDADES = { erro: 'Erro', aviso: 'Aviso', info: 'Informação' };
const etiqueta = (classe, texto) => h`<span class="tag ${classe}">${texto}</span>`;

// ---------- Estrutura ----------
const VERSAO = Date.now();
const ICONES = {
  fechos: '<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="16" x2="16" y1="14" y2="18"/><path d="M16 10h.01M12 10h.01M8 10h.01M12 14h.01M8 14h.01M12 18h.01M8 18h.01"/>',
  incs: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  diarios: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  taloes: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  novo: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  meus: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  config: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
};
const icone = (chave) => h`<svg class="icone" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(ICONES[chave])}</svg>`;

function pagina(user, titulo, corpo, ativo = '') {
  const link = (href, texto, chave) => h`<a href="${href}" title="${texto}" class="${ativo === chave ? 'ativo' : ''}">${icone(chave)}<span>${texto}</span></a>`;
  const nav = !user
    ? ''
    : user.role === 'auditor'
      ? h`${link('/fechos', 'Fechos', 'fechos')}${link('/inconsistencias', 'Inconsistências', 'incs')}${link('/diarios', 'Diários', 'diarios')}${link('/taloes', 'Talões', 'taloes')}${link('/taloes/novo', 'Enviar talão', 'novo')}${link('/config/terminais', 'Configuração', 'config')}`
      : h`${link('/taloes/novo', 'Enviar talão', 'novo')}${link('/taloes/meus', 'Os meus envios', 'meus')}`;
  const papel = user && (user.role === 'auditor' ? 'Auditor' : 'Receção');
  return h`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${titulo} · Auditoria de caixas</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/style.css?v=${VERSAO}">
</head>
<body class="${user ? 'com-menu' : ''}${user?.menuRecolhido ? ' menu-recolhido' : ''}">
<header class="topo">
  <a class="marca" href="/" aria-label="Umbral · Auditoria de caixas"><img src="/umbral-logo-white.png" alt="Umbral" width="205" height="40"><span>Auditoria de caixas</span></a>
  ${user && h`<p class="marca-sub"><b>CAIXAS</b><span>Auditoria de fechos</span></p>
  <p class="nav-rotulo"><span>Espaço de trabalho</span><button type="button" class="recolher" aria-label="Minimizar o menu" title="Minimizar o menu" aria-expanded="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button></p>`}
  ${user && h`<button type="button" class="hamburguer" aria-label="Abrir o menu" aria-expanded="false" aria-controls="menu-principal"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path class="h-barras" d="M4 6h16M4 12h16M4 18h16"/><path class="h-x" d="M6 6l12 12M18 6L6 18"/></svg></button>`}
  <nav id="menu-principal">${nav}</nav>
  ${user && h`<div class="conta"><span class="marca-conta">${user.nome.trim().charAt(0).toUpperCase()}</span><div class="conta-texto"><a href="/conta">${user.nome}</a><small>${papel}</small></div><form method="post" action="/logout"><button class="link" title="Terminar sessão">Sair</button></form></div>`}
</header>
${user && h`<div class="barra"><nav class="migalhas" aria-label="Localização"><span>Auditoria de caixas</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg><strong>${titulo}</strong></nav><span class="pilula">${papel}</span></div>`}
<main>${corpo}</main>
<script src="/app.js" defer></script>
</body>
</html>`.toString();
}

const aviso = (texto, classe = 'erro') => texto && h`<p class="aviso ${classe}">${texto}</p>`;

function subnavConfig(ativo) {
  const item = (href, texto, chave) => h`<a href="${href}" class="${ativo === chave ? 'ativo' : ''}">${texto}</a>`;
  return h`<nav class="subnav">${item('/config/terminais', 'Terminais TPA', 'terminais')}${item('/config/meios', 'Meios de pagamento', 'meios')}${item('/config/utilizadores', 'Utilizadores', 'utilizadores')}${item('/config/leitura', 'Leitura de talões', 'leitura')}</nav>`;
}

// ---------- Entrada ----------
export function loginPage(erro) {
  return pagina(null, 'Entrar', h`
<section class="cartao estreito">
  <h1>Entrar</h1>
  ${aviso(erro)}
  <form method="post" action="/login">
    <label>Utilizador <input name="username" autocomplete="username" autocapitalize="none" required autofocus></label>
    <label>Palavra-passe <input name="password" type="password" autocomplete="current-password" required></label>
    <button class="primario">Entrar</button>
  </form>
</section>`);
}

export function setupPage(erro, v = {}) {
  return pagina(null, 'Primeira configuração', h`
<section class="cartao estreito">
  <h1>Primeira configuração</h1>
  <p>Ainda não existe nenhum utilizador. Crie a conta do auditor, que depois poderá criar as restantes.</p>
  ${aviso(erro)}
  <form method="post" action="/setup">
    <label>Nome <input name="nome" value="${v.nome || ''}" required></label>
    <label>Utilizador <input name="username" value="${v.username || ''}" autocapitalize="none" required></label>
    <label>Palavra-passe (mínimo 8 caracteres) <input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
    <button class="primario">Criar conta de auditor</button>
  </form>
</section>`);
}

export function contaPage(user, msg, erro) {
  return pagina(user, 'A minha conta', h`
<section class="cartao estreito">
  <h1>A minha conta</h1>
  <p>${user.nome} · ${user.username} · ${user.role === 'auditor' ? 'Auditor' : 'Receção'}</p>
  ${aviso(msg, 'ok')}${aviso(erro)}
  <form method="post" action="/conta/password">
    <label>Palavra-passe atual <input name="atual" type="password" autocomplete="current-password" required></label>
    <label>Nova palavra-passe (mínimo 8 caracteres) <input name="nova" type="password" minlength="8" autocomplete="new-password" required></label>
    <button class="primario">Alterar palavra-passe</button>
  </form>
</section>`);
}

export function erroPage(user, titulo, texto) {
  return pagina(user, titulo, h`<section class="cartao estreito"><h1>${titulo}</h1><p>${texto}</p><p><a href="/">Voltar ao início</a></p></section>`);
}

// ---------- Fechos ----------
export function fechosPage(user, fechos, filtros = {}, dias = [], totalGeral = fechos.length, query = '') {
  const opcoes = (nome, rotulo, lista) => h`<label>${rotulo}
  <select name="${nome}"><option value="">Todos</option>${lista.map(([valor, texto]) => h`<option value="${valor}" ${filtros[nome] === valor ? raw('selected') : ''}>${texto}</option>`)}</select></label>`;
  return pagina(user, 'Fechos', h`
<div class="cabecalho"><h1>Fechos de caixa</h1><a class="botao primario" href="/fechos/carregar">Carregar ficheiros do PMS</a></div>
${totalGeral > 0 && h`<form class="filtros" method="get" action="/fechos">
  ${seletorPeriodo(filtros.de, filtros.ate, dias)}
  ${opcoes('pendentes', 'Inconsistências', [['com', 'Com pendentes'], ['sem', 'Sem pendentes']])}
  ${opcoes('ficheiros', 'Ficheiros', [['completos', 'Diário e faturas carregados'], ['incompletos', 'Em falta']])}
  ${opcoes('taloes', 'Talões', [['com', 'Com talões'], ['sem', 'Sem talões']])}
  <button>Filtrar</button> <a href="/fechos">Limpar</a>
</form>`}
${totalGeral === 0
    ? h`<p class="vazio">Ainda não há nenhum fecho. Comece por carregar o diário de caixa e o relatório de faturas de um dia.</p>`
    : fechos.length === 0
    ? h`<p class="vazio">Nenhum fecho com estes filtros.</p>`
    : h`<div class="tabela-wrap"><table>
<thead><tr><th>Dia</th><th class="num">Total do diário</th><th class="num">CASH</th><th class="num">TPA</th><th class="num">STRIPE</th><th class="num">TBBOOKING</th><th class="num">TRFBANCO</th><th></th></tr></thead>
<tbody>${fechos.map((f) => h`<tr>
  <td><a href="/fechos/${f.data}"><strong>${dataPT(f.data)}</strong></a> <span class="suave">${diaSemana(f.data)}</span></td>
  <td class="num total-fecho ${f.validacao.validado ? 'valido' : ''}" title="${f.validacao.validado ? 'Todos os valores foram validados pelo auditor' : `Validados: ${f.validacao.validados} de ${f.validacao.exigidos}`}">
    <strong>${f.validacao.validado ? h`<span class="visto" aria-hidden="true">✓</span> ` : ''}${euros(f.total)}</strong>
    <small class="suave">${f.validacao.validado ? 'Validado' : `${f.validacao.validados}/${f.validacao.exigidos} validados`}</small>
  </td>
  ${Object.keys(ROTULO_CANAL).map((k) => {
    const x = f.validacao.canais[k];
    if (!x.valor) return h`<td class="num">${traco}</td>`;
    return h`<td class="num ${x.validado ? 'validado' : ''}">${formValidar(f.data, k, x, euros(x.valor / 100), { query })}</td>`;
  })}
  <td class="num"><form method="post" action="/fechos/${f.data}/apagar" data-confirmar="${f.apagarTexto}"><input type="hidden" name="q" value="${query}"><button class="link perigo">Apagar</button></form></td>
</tr>`)}</tbody></table></div>`}`, 'fechos');
}

export function carregarPage(user, erro) {
  return pagina(user, 'Carregar ficheiros', h`
<section class="cartao estreito">
  <h1>Carregar ficheiros do PMS</h1>
  <p>Escolha de uma vez todos os ficheiros do mesmo dia. Cada um é reconhecido pelo conteúdo, por isso o nome e a ordem não interessam.</p>
  <ul>
    <li>Diário de caixa (CSV)</li>
    <li>Relatório de faturas por data da fatura (CSV)</li>
    <li>Lista de saídas e relatório de faturas por data de check-out</li>
    <li>Lista de entradas e relatório de faturas por data de check-in</li>
  </ul>
  <p class="suave">Pode carregar só alguns e juntar os restantes mais tarde. Se o dia já existir, cada ficheiro substitui o anterior do mesmo tipo e as notas já escritas mantêm-se.</p>
  ${aviso(erro)}
  <form method="post" action="/fechos/carregar" enctype="multipart/form-data">
    <label>Ficheiros do dia <input type="file" name="ficheiros" accept=".csv,.xls,text/csv" multiple required></label>
    <button class="primario">Carregar e cruzar</button>
  </form>
</section>`, 'fechos');
}

function tabelaIncs(incs, mostrarDia) {
  if (!incs.length) return h`<p class="vazio">Nenhuma inconsistência com estes filtros.</p>`;
  return h`<div class="tabela-wrap"><table class="incs">
<thead><tr>${mostrarDia && h`<th>Dia</th>`}<th>Gravidade</th><th>Tipo</th><th>Descrição</th><th>Utilizador</th><th>Caixa</th><th class="num">Valor</th><th>Estado</th><th class="num">Notas</th></tr></thead>
<tbody>${incs.map((i) => h`<tr class="${[i.ativa ? '' : 'inativa', i.tipo === 'NOTA_CREDITO' ? 'nc' : ''].join(' ').trim()}">
  ${mostrarDia && h`<td><a href="/fechos/${i.data}">${dataPT(i.data)}</a></td>`}
  <td>${etiqueta('g-' + i.gravidade, GRAVIDADES[i.gravidade])}</td>
  <td>${TIPOS[i.tipo] || i.tipo}</td>
  <td><a href="/inconsistencias/${i.id}">${i.titulo}</a>${!i.ativa && h` <span class="suave">(já não é detetada)</span>`}</td>
  <td>${i.utilizador}</td>
  <td>${i.caixa}</td>
  <td class="num">${euros(i.valor)}</td>
  <td>${etiqueta('e-' + i.estado, ESTADOS[i.estado])}</td>
  <td class="num">${i.notas ? h`<a href="/inconsistencias/${i.id}#notas" title="Ver as notas">${i.notas}</a>` : ''}</td>
</tr>`)}</tbody></table></div>`;
}

function filtrosIncs(acao, f, opcoes, comDia) {
  const select = (nome, rotulo, valores, rotulos = {}) => h`<label>${rotulo}
  <select name="${nome}"><option value="">Todos</option>${valores.map((v) => h`<option value="${v}" ${f[nome] === v ? raw('selected') : ''}>${rotulos[v] || v}</option>`)}</select></label>`;
  return h`<form class="filtros" method="get" action="${acao}">
  ${comDia && seletorPeriodo(f.de, f.ate, opcoes.dias)}
  ${select('estado', 'Estado', Object.keys(ESTADOS), ESTADOS)}
  ${select('gravidade', 'Gravidade', Object.keys(GRAVIDADES), GRAVIDADES)}
  ${select('tipo', 'Tipo', opcoes.tipos, TIPOS)}
  ${select('utilizador', 'Utilizador', opcoes.utilizadores)}
  ${select('caixa', 'Caixa', opcoes.caixas)}
  <button>Filtrar</button> <a href="${acao}">Limpar</a>
</form>`;
}

// ---------- Por meio de pagamento: resumo geral e um separador por meio ----------
const ICONE_RELOGIO = '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>';
const ROTULO_ESTADO = { ok: 'Tudo certo', erro: 'Não confere', pendente: 'Por validar' };
const CLASSE_ESTADO = { ok: 'ok', erro: 'falta', pendente: 'suave' };
const PONTO_ESTADO = { ok: 'ok', erro: 'erro', pendente: 'pend' };
const pior = (estados) => (estados.includes('erro') ? 'erro' : estados.includes('pendente') ? 'pendente' : 'ok');
const traco = h`<span class="suave">—</span>`;

// Os meios TPA ficam num único separador "TPA"; cada um dos outros tem o seu.
function gruposDeMeios(porMeio) {
  const grupos = [];
  for (const a of porMeio) {
    if (!a.tpa) grupos.push({ chave: a.chave, titulo: a.tipo, itens: [a] });
    else if (!grupos.some((g) => g.chave === 'tpa')) grupos.push({ chave: 'tpa', titulo: 'TPA', itens: porMeio.filter((x) => x.tpa) });
  }
  for (const g of grupos) g.estado = pior(g.itens.map((a) => a.estado));
  return grupos;
}

const chipsTaloes = (lista) => h`<div class="taloes-meio">${lista.map((x) => h`<a class="chip-talao" href="/envios/${x.envio_id}" title="Talão ${x.id}: ${euros(x.valor)}">#${x.id}</a>`)}</div>`;
const tagValidacao = (dif) => (dif === 0 ? h`<span class="tag ok">Bate certo</span>` : h`<span class="tag falta">${dif > 0 ? 'Sobram' : 'Faltam'} ${euros(Math.abs(dif) / 100)}</span>`);

function linhasMeios(analise, fecho, numerario, meios, validacao) {
  const comFaturas = Boolean(fecho.faturas_ficheiro);
  const porTipo = new Map(meios.map((m) => [m.tipo, m]));
  const valores = (n, diario, faturas) => h`<td class="num">${n}</td><td class="num">${euros(diario / 100)}</td>
    <td class="num">${comFaturas ? euros(faturas / 100) : '—'}</td><td class="num">${comFaturas ? euros((faturas - diario) / 100) : '—'}</td>`;
  const destaque = (diario, faturas) => (comFaturas && diario !== faturas ? 'destaque' : '');
  const resumo = (a) => ({ n: a.movimentos.length, diario: a.diario, faturas: Math.round(porTipo.get(a.tipo).faturas * 100), taloes: a.taloes, soma: a.taloesSoma });
  const linhaTaloes = (r, ehGrupo) => h`<td>${r.taloes.length ? (ehGrupo ? h`<span class="suave">${r.taloes.length} ${r.taloes.length === 1 ? 'talão' : 'talões'}</span>` : chipsTaloes(r.taloes)) : h`<span class="suave">sem talões</span>`}</td>
    <td class="num">${euros(r.soma / 100)}</td><td>${tagValidacao(r.soma - r.diario)}</td>`;

  // Validação do auditor (a mesma da lista de fechos): uma caixa por meio; os submétodos TPA seguem a do TPA.
  const celulaValidar = (canal) => {
    const x = canal && validacao.canais[canal];
    if (!x || !x.valor) return h`<td>${traco}</td>`;
    return h`<td class="${x.validado ? 'validado' : ''}">${formValidar(fecho.data, canal, x, x.validado ? 'Validado' : 'Por validar', { origem: 'dia' })}</td>`;
  };
  const validadoTPA = h`<td>${validacao.canais.tpa.validado ? h`<span class="tag ok">Validado</span>` : traco}</td>`;

  const linhas = [];
  let grupoFeito = false;
  for (const a of analise.porMeio) {
    const r = resumo(a);
    if (!a.tpa) {
      linhas.push(h`<tr class="${destaque(r.diario, r.faturas)}"><td>${a.tipo}${a.tipo === MEIO_NUMERARIO ? h` <a class="tag ${estadoNumerario(numerario).classe}" href="/fechos/${fecho.data}?contagem=1#numerario" data-abrir-contagem title="Abrir a contagem de numerário">${estadoNumerario(numerario).rotulo}</a>` : ''}</td>
        ${valores(r.n, r.diario, r.faturas)}<td>${traco}</td><td class="num">${traco}</td><td>${traco}</td>${celulaValidar(canalDoMeio(a.tipo, false))}</tr>`);
    } else if (!grupoFeito) {
      grupoFeito = true;
      const filhos = analise.porMeio.filter((x) => x.tpa).map(resumo);
      const soma = (campo) => filhos.reduce((s, x) => s + x[campo], 0);
      const pai = { n: soma('n'), diario: soma('diario'), faturas: soma('faturas'), taloes: filhos.flatMap((x) => x.taloes), soma: soma('soma') };
      linhas.push(h`<tr class="grupo ${destaque(pai.diario, pai.faturas)}"><td><strong>TPA</strong></td>${valores(pai.n, pai.diario, pai.faturas)}${linhaTaloes(pai, true)}${celulaValidar('tpa')}</tr>`);
      for (const [k, x] of filhos.entries()) {
        const meio = analise.porMeio.filter((y) => y.tpa)[k];
        linhas.push(h`<tr class="sub ${destaque(x.diario, x.faturas)}"><td><span class="submetodo">${meio.tipo}</span></td>${valores(x.n, x.diario, x.faturas)}${linhaTaloes(x, false)}${validadoTPA}</tr>`);
      }
    }
  }
  return linhas;
}

const ROTULOS_VALIDACAO = {
  totais: 'Total do diário = total das faturas',
  faturas: 'Cada movimento tem a sua fatura',
  taloes: 'Talões (pay slips) = diário',
  pagamentos: 'Cada pagamento tem o seu talão',
  terminal: 'Terminal (nº do TPA) = caixa do pagamento',

  contagem: 'Contagem de notas e moedas = diário',
};
const iconeCelula = (ok) => (ok === true ? ICONE_OK : ok === false ? ICONE_ERRO : ICONE_RELOGIO);

// Matriz de validações: uma linha por validação e uma coluna por meio (ou submétodo TPA). Simples de ler de relance.
function matrizValidacoes(itens) {
  const chaves = Object.keys(ROTULOS_VALIDACAO).filter((k) => itens.some((a) => a.verificacoes.some((x) => x.chave === k)));
  return h`<div class="tabela-wrap"><table class="matriz">
  <thead><tr><th>Validação</th>${itens.map((a) => h`<th>${itens.length > 1 ? h`<span class="matriz-meio">${a.tipo}</span> ` : ''}${etiqueta(CLASSE_ESTADO[a.estado], ROTULO_ESTADO[a.estado])}</th>`)}</tr></thead>
  <tbody>${chaves.map((k) => h`<tr><th scope="row">${ROTULOS_VALIDACAO[k]}</th>${itens.map((a) => {
    const x = a.verificacoes.find((y) => y.chave === k);
    if (!x) return h`<td class="val nd"><span class="suave">—</span></td>`;
    return h`<td class="val ${x.ok === true ? 'ok' : x.ok === false ? 'erro' : 'pend'}" title="${x.titulo}. ${x.detalhe}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(iconeCelula(x.ok))}</svg><span>${x.curto}</span></td>`;
  })}</tr>`)}</tbody></table></div>`;
}

// Associar um terminal (nº do TPA) a uma caixa sem sair da página do fecho.
function formAssociar(terminal, ctx, data) {
  if (!terminal) return h`<span class="suave">Terminal desconhecido</span>`;
  return h`<form method="post" action="/config/terminais/${terminal.id}/associar" class="linha"><input type="hidden" name="data" value="${data}">
    <select name="caixa" required aria-label="Caixa do terminal ${terminal.numero}"><option value="">Escolher caixa…</option>${ctx.caixas.map((c) => h`<option value="${c}">${c}</option>`)}</select>
    <button>Associar</button></form>`;
}
const celulaTerminal = (numero, ctx) => h`${numero}${ctx.terminais[numero]?.nome ? h` <span class="suave">${ctx.terminais[numero].nome}</span>` : ''}`;

function tabelaTaloesDoMeio(taloes, ctx, data) {
  if (!taloes.length) return h`<p class="vazio">Nenhum talão (pay slip) associado.</p>`;
  return h`<div class="tabela-wrap"><table>
  <thead><tr><th>ID</th><th>Hora</th><th>Terminal (nº do TPA)</th><th>Caixa do terminal</th><th class="num">Valor</th><th>Cartão</th><th>Reserva</th><th>Documento</th><th>Nota</th></tr></thead>
  <tbody>${taloes.map((t) => h`<tr><td><a class="chip-talao" href="/envios/${t.envio_id}">#${t.id}</a></td><td>${t.hora}</td><td>${celulaTerminal(t.tpa, ctx)}</td>
    <td>${!t.caixasTerminal.length ? formAssociar(ctx.terminais[t.tpa], ctx, data)
      : t.terminalOk === false ? h`${etiqueta('falta', t.caixasTerminal.join(', '))} <span class="suave">pagamento na caixa ${t.caixasDiario.join(', ')}</span>`
      : t.terminalOk === true ? etiqueta('ok', `${t.caixasTerminal.join(', ')} ✓`) : etiqueta('suave', t.caixasTerminal.join(', '))}</td>
    <td class="num">${euros(t.valor)}</td><td>${t.cartao} ${t.ultimos4 ? `****${t.ultimos4}` : ''}</td><td>${t.reservas}</td><td>${t.doc_associado}</td><td class="nota-celula">${t.nota_envio}</td></tr>`)}</tbody>
  <tfoot><tr><th>Total</th><th></th><th></th><th></th><th class="num">${euros(taloes.reduce((s, t) => s + t.valor, 0))}</th><th></th><th></th><th></th><th></th></tr></tfoot>
  </table></div>`;
}

// Legenda da cor das notas de crédito (a mesma dos Diários).
const legendaNC = h`<p class="suave legenda"><span class="amostra nc"></span> Reserva com nota de crédito no mesmo dia (fatura anulada ou reemitida)</p>`;

function tabelaMovimentosDoMeio(a, comFaturas, comTalao) {
  if (!a.movimentos.length && !a.faturasSemMovimento.length) return h`<p class="vazio">Sem movimentos neste meio.</p>`;
  const temNC = a.movimentos.some((m) => m.comNC) || a.faturasSemMovimento.some((f) => f.comNC);
  return h`${temNC ? legendaNC : ''}<div class="tabela-wrap"><table>
  <thead><tr><th>Documento</th><th>Reserva</th><th>Hora</th><th>Quarto</th><th>Hóspede</th><th>Caixa</th><th class="num">Valor (diário)</th><th>Fatura</th>${comTalao ? h`<th>Talão</th>` : ''}</tr></thead>
  <tbody>${a.movimentos.map((m) => h`<tr class="${m.comNC ? 'nc' : comFaturas && !m.fatura ? 'destaque' : ''}"><td>${m.doc}</td><td class="reserva">${m.reserva}</td><td>${m.hora}</td><td>${m.quarto}</td><td>${m.nome}</td><td>${m.caixa}</td>
    <td class="num">${euros(m.valor)}</td>
    <td>${comFaturas ? (m.fatura ? etiqueta('ok', 'Fatura confere') : etiqueta('falta', 'Sem fatura')) : traco}</td>
    ${comTalao ? h`<td>${m.anulado ? h`<span class="suave">Anulado (nota de crédito)</span>` : m.taloes.length ? chipsTaloes(m.taloes) : m.c > 0 ? etiqueta('falta', 'Sem talão') : traco}</td>` : ''}</tr>`)}
  ${a.faturasSemMovimento.map((f) => h`<tr class="${f.comNC ? 'nc' : 'destaque'}"><td>${f.doc}</td><td class="reserva">${f.reserva}</td><td>${traco}</td><td>${f.quarto}</td><td>${f.hospede}</td><td>${traco}</td><td class="num">${traco}</td>
    <td>${etiqueta('falta', `Fatura sem movimento · ${euros(f.valor)}`)}</td>${comTalao ? h`<td>${traco}</td>` : ''}</tr>`)}</tbody>
  </table></div>`;
}

function contagemNumerario(n, data) {
  const linhas = [...NOTAS, ...MOEDAS].filter((c) => n.quantidades[c]);
  return h`<h3>Contagem de notas e moedas</h3>
  ${n.existe ? h`<div class="tabela-wrap estreita"><table>
    <thead><tr><th>Denominação</th><th class="num">Quantidade</th><th class="num">Valor</th></tr></thead>
    <tbody>${linhas.map((c) => h`<tr><td>${rotuloDenominacao(c)}</td><td class="num">${n.quantidades[c]}</td><td class="num">${euros((c * n.quantidades[c]) / 100)}</td></tr>`)}</tbody>
    <tfoot><tr><th>Total contado</th><th></th><th class="num">${euros(n.contado / 100)}</th></tr></tfoot></table></div>` : h`<p class="vazio">Ainda sem contagem guardada.</p>`}
  <p><a class="botao" href="/fechos/${data}?contagem=1#numerario" data-abrir-contagem>${n.existe ? 'Refazer a contagem' : 'Contar notas e moedas'}</a></p>`;
}

function contagemValidacoes(itens) {
  const todas = itens.flatMap((a) => a.verificacoes);
  const erros = todas.filter((x) => x.ok === false).length;
  const porValidar = todas.filter((x) => x.ok === null).length;
  const certas = todas.length - erros - porValidar;
  return [`${certas} certa(s)`, erros ? `${erros} a corrigir` : '', porValidar ? `${porValidar} por validar` : ''].filter(Boolean).join(' · ');
}

function subPainel(g, fecho, numerario, fechosTPA, ctx) {
  const comFaturas = Boolean(fecho.faturas_ficheiro);
  const itens = g.itens;
  const soma = (campo) => itens.reduce((s, a) => s + a[campo], 0);
  const diario = soma('diario');
  const faturado = soma('faturado');
  const movs = itens.reduce((s, a) => s + a.movimentos.length, 0);
  const ehTPA = g.chave === 'tpa';
  const ehNumerario = !ehTPA && itens[0].tipo === MEIO_NUMERARIO;

  const canal = ehTPA ? 'tpa' : canalDoMeio(itens[0].tipo, false);
  const validar = canal && ctx.validacao.canais[canal];
  return h`<div class="subpainel" id="subpainel-${g.chave}" data-subpainel="${g.chave}" role="tabpanel">
  <div class="indicadores">
    <div><span>Movimentos</span><strong>${movs}</strong></div>
    <div><span>Diário</span><strong>${euros(diario / 100)}</strong></div>
    <div><span>Faturas</span><strong>${comFaturas ? euros(faturado / 100) : '—'}</strong></div>
    <div class="${comFaturas && diario !== faturado ? 'alerta' : ''}"><span>Diferença</span><strong>${comFaturas ? euros((faturado - diario) / 100) : '—'}</strong></div>
    ${validar && validar.valor ? h`<div class="valida-card ${validar.validado ? 'validado' : ''}"><span>Validação do auditor</span>${formValidar(fecho.data, canal, validar, validar.validado ? 'Valor validado' : 'Validar este valor', { origem: 'dia' })}</div>` : ''}
    ${ehTPA ? h`<div class="${soma('taloesSoma') !== diario ? 'alerta' : ''}"><span>Talões (pay slips)</span><strong>${euros(soma('taloesSoma') / 100)}</strong></div>` : ''}
  </div>
  <h3>Validações <span class="suave">${contagemValidacoes(itens)}</span></h3>
  ${matrizValidacoes(itens)}
  ${ehTPA ? itens.map((a) => h`<h3>${a.tipo} — talões (pay slips) que comprovam o valor</h3>
    ${tabelaTaloesDoMeio(a.taloes, ctx, fecho.data)}
    <h3>${a.tipo} — pagamentos do diário e talão de cada um</h3>
    ${tabelaMovimentosDoMeio(a, comFaturas, true)}`) : h`${ehNumerario ? contagemNumerario(numerario, fecho.data) : ''}
    <h3>Movimentos do diário e fatura de cada um</h3>
    ${tabelaMovimentosDoMeio(itens[0], comFaturas, false)}
`}
  ${ehTPA ? h`<h3>Fechos dos terminais <span class="suave">talão de fecho de cada terminal contra os pagamentos TPA do diário nas caixas a que pertence</span></h3>
    ${fechosTPA.length ? h`<div class="tabela-wrap"><table>
      <thead><tr><th>ID</th><th>Hora</th><th>Terminal (nº do TPA)</th><th>Caixa</th><th class="num">Valor do fecho</th><th class="num">Diário TPA da caixa</th><th>Validação</th></tr></thead>
      <tbody>${fechosTPA.map((t) => h`<tr><td><a class="chip-talao" href="/envios/${t.envio_id}">#${t.id}</a></td><td>${t.hora}</td><td>${celulaTerminal(t.tpa, ctx)}</td>
        <td>${t.caixas.length ? t.caixas.map((c) => etiqueta('suave', c)) : formAssociar(t.terminal, ctx, fecho.data)}</td>
        <td class="num">${euros(t.valor)}</td>
        <td class="num">${t.grupo ? euros(t.grupo.diario / 100) : traco}</td>
        <td>${t.grupo ? (t.grupo.fecho === t.grupo.diario ? etiqueta('ok', 'Bate certo') : etiqueta('falta', `${t.grupo.fecho > t.grupo.diario ? 'Sobram' : 'Faltam'} ${euros(Math.abs(t.grupo.fecho - t.grupo.diario) / 100)}${t.grupo.terminais.length > 1 ? ` · grupo ${t.grupo.terminais.join(' + ')}` : ''}`)) : h`<span class="suave">Associe o terminal a uma caixa</span>`}</td></tr>`)}</tbody></table></div>` : h`<p class="vazio">Nenhum talão de fecho enviado para este dia.</p>`}` : ''}
</div>`;
}

function estadoNumerario(n) {
  if (!n.existe) return { classe: 'suave', rotulo: 'Por validar' };
  return n.contado === n.esperado ? { classe: 'ok', rotulo: 'Validado' } : { classe: 'falta', rotulo: 'Não confere' };
}

const ICONE_OK = '<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>';
const ICONE_ERRO = '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>';
const resultado = (classe, icone, titulo, texto) => h`<div class="resultado ${classe}" role="status" data-resultado>
  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(icone)}</svg>
  <div><strong>${titulo}</strong><p>${texto}</p></div></div>`;

function blocoNumerario(fecho, n) {
  const q = n.quantidades;
  const linha = (c) => h`<label class="contagem-linha"><span class="den">${rotuloDenominacao(c)}</span>
    <input type="number" min="0" max="99999" step="1" inputmode="numeric" name="q[${c}]" value="${q[c] || ''}" placeholder="0" data-valor="${c}">
    <output data-sub>${euros((c * (q[c] || 0)) / 100)}</output></label>`;
  const dif = n.contado - n.esperado;
  const veredito = !n.temDiario
    ? aviso('Carregue o diário de caixa para poder validar a contagem.', 'info')
    : !n.existe
      ? aviso('Indique quantas notas e moedas há na caixa e guarde para validar com o diário.', 'info')
      : dif === 0
        ? resultado('ok', ICONE_OK, 'Os valores batem certo', `A contagem de ${euros(n.contado / 100)} é igual ao total em ${MEIO_NUMERARIO} do diário.`)
        : resultado('erro', ICONE_ERRO, 'Os valores não batem certo', `Contados ${euros(n.contado / 100)}, o diário regista ${euros(n.esperado / 100)}: ${dif > 0 ? 'sobram' : 'faltam'} ${euros(Math.abs(dif) / 100)}. Foi registada uma inconsistência.`);
  return h`<dialog class="modal" id="numerario" aria-labelledby="numerario-titulo" ${n.abrir ? raw('open data-abrir="1"') : ''}>
  <form method="post" action="/fechos/${fecho.data}/contagem" data-contagem data-esperado="${n.esperado}">
    <header class="modal-topo">
      <h2 id="numerario-titulo">Contagem de numerário (${MEIO_NUMERARIO})</h2>
      <button type="button" class="modal-fechar" data-fechar aria-label="Fechar"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
    </header>
    <div class="modal-corpo">
      <div data-estado>${veredito}</div>
      <div class="contagem-grupos">
        <fieldset><legend>Notas</legend>${NOTAS.map(linha)}</fieldset>
        <fieldset><legend>Moedas</legend>${MOEDAS.map(linha)}</fieldset>
      </div>
    </div>
    <footer class="modal-rodape">
      <dl class="contagem-totais">
        <div><dt>Contado</dt><dd data-contado>${euros(n.contado / 100)}</dd></div>
        <div><dt>Diário (${MEIO_NUMERARIO})</dt><dd>${euros(n.esperado / 100)}</dd></div>
        <div><dt>Diferença</dt><dd data-diferenca class="${n.existe && dif !== 0 ? 'erro' : ''}">${euros(dif / 100)}</dd></div>
      </dl>
      <div class="modal-acoes">
        ${n.existe && h`<span class="suave">Guardada em ${quandoPT(n.em)}</span>`}
        <button type="button" data-fechar>Cancelar</button>
        <button class="primario">Guardar e validar</button>
      </div>
    </footer>
  </form>
</dialog>`;
}

export function fechoPage(user, d) {
  const { fecho, totais, meios, porUtilizador, porAlojamento, pendentesSemAlojamento, analise, fechosTPA, terminaisPorNumero, caixasLista, incs, filtros, opcoes, taloes, contagem, reservas, numerario, validacao, apagarTexto } = d;
  const dif = totais.faturas - totais.diario;
  const grupos = gruposDeMeios(analise.porMeio);
  const totalIncs = (contagem.pendente || 0) + (contagem.justificada || 0) + (contagem.resolvida || 0);
  // Comprovativos: contagem de notas e moedas (CASH), talões nos meios TPA e faturas nos restantes meios.
  const diarioC = Math.round(totais.diario * 100);
  const faturasC = Math.round(totais.faturas * 100);
  const comprovativosC = analise.porMeio.reduce((s, a) => s + (a.tipo === MEIO_NUMERARIO ? (numerario.existe ? numerario.contado : 0) : a.tpa ? a.taloesSoma : a.faturado), 0);
  const caixaCorreta = Boolean(fecho.diario_ficheiro && fecho.faturas_ficheiro) && diarioC === faturasC && faturasC === comprovativosC && !contagem.pendente;
  const colunasMeios = meios.filter((m) => porAlojamento.some((a) => m.tipo in a.porMeio));
  const colunasMeiosUtil = meios.filter((m) => porUtilizador.some((u) => m.tipo in u.porMeio));
  return pagina(user, `Fecho de ${dataPT(fecho.data)}`, h`
<div class="cabecalho">
  <div><h1>Fecho de ${dataPT(fecho.data)}</h1><p class="suave">${diaSemana(fecho.data)}</p></div>
  <div class="acoes">
    <form method="post" action="/fechos/${fecho.data}/reconciliar"><button>Cruzar de novo</button></form>
    <a class="botao" href="/fechos/carregar">Substituir ficheiros</a>
    <form method="post" action="/fechos/${fecho.data}/apagar" data-confirmar="${apagarTexto}"><input type="hidden" name="origem" value="dia"><button class="perigo">Apagar fecho</button></form>
  </div>
</div>
<div class="indicadores indicadores-fecho">
  <div class="${validacao.validado ? 'valido-auditor' : ''}" title="${validacao.validado ? 'Todos os valores foram validados pelo auditor' : `Validados pelo auditor: ${validacao.validados} de ${validacao.exigidos}`}"><span>Total do diário${validacao.validado ? ' · validado' : validacao.validados ? ` · ${validacao.validados}/${validacao.exigidos} validados` : ''}</span><strong>${validacao.validado ? h`<span class="visto" aria-hidden="true">✓</span> ` : ''}${euros(totais.diario)}</strong></div>
  <div class="${fecho.faturas_ficheiro && faturasC !== diarioC ? 'alerta' : ''}"><span>Total das faturas</span><strong>${fecho.faturas_ficheiro ? euros(totais.faturas) : '—'}</strong></div>
  <div class="${comprovativosC !== diarioC ? 'alerta' : ''}" title="Contagem de notas e moedas (CASH) + talões dos meios TPA + faturas dos restantes meios"><span>Total dos comprovativos</span><strong>${euros(comprovativosC / 100)}</strong></div>
  ${caixaCorreta
    ? h`<div class="certo"><span>Caixa correta${totalIncs ? ` · ${totalIncs} inconsistência(s) tratada(s)` : ''}</span><strong>Tudo confere</strong></div>`
    : h`<div class="${contagem.pendente ? 'alerta' : ''}"><span>Inconsistências${contagem.pendente ? h` · ${contagem.pendente} pendente(s)` : ''}</span><strong>${totalIncs}</strong></div>`}
</div>
${caixaCorreta ? h`<p class="aviso ok caixa-correta">O total do diário, o total das faturas e o total dos comprovativos são iguais e não há inconsistências por tratar: a caixa está correta.</p>` : ''}

<div class="abas" role="tablist" aria-label="Análises do fecho" data-abas>
  ${[
    ['meios', 'Por meio de pagamento', meios.length, ''],
    ['utilizadores', 'Por utilizador', porUtilizador.length, ''],
    ['alojamentos', 'Por Caixa', porAlojamento.length, ''],
    ...(reservas.some((r) => r.reservas) ? [['reservas', 'Saídas e entradas', '', '']] : []),
    ...(totalIncs ? [['incs', 'Inconsistências', contagem.pendente || 0, contagem.pendente ? 'alerta' : '']] : []),
    ['taloes', 'Talões do dia', taloes.length, ''],
  ].map(([chave, nome, n, classe]) => h`<button type="button" role="tab" id="aba-${chave}" data-aba="${chave}" aria-controls="painel-${chave}" aria-selected="false">${nome}${n !== '' ? h` <span class="contador ${classe}">${n}</span>` : ''}</button>`)}
</div>

<section class="painel-aba" id="painel-meios" role="tabpanel" aria-labelledby="aba-meios" data-painel="meios">
  <div class="subabas" role="tablist" aria-label="Meios de pagamento" data-subabas>
    <button type="button" role="tab" data-subaba="geral" aria-selected="false">Geral</button>
    ${grupos.map((g) => h`<button type="button" role="tab" data-subaba="${g.chave}" aria-selected="false"><span class="ponto ${PONTO_ESTADO[g.estado]}"></span>${g.titulo}</button>`)}
  </div>

  <div class="subpainel" id="subpainel-geral" data-subpainel="geral" role="tabpanel">
    <div class="tabela-wrap"><table class="meios">
    <thead><tr><th>Meio</th><th class="num">Movimentos</th><th class="num">Diário</th><th class="num">Faturas</th><th class="num">Diferença</th><th>Comprovativos (ID)</th><th class="num">Valor comprovado</th><th>Validação</th><th>Validado pelo auditor</th></tr></thead>
    <tbody>${linhasMeios(analise, fecho, numerario, meios, validacao)}</tbody>
    <tfoot><tr><th>Total</th><th class="num">${meios.reduce((s, m) => s + m.movimentos, 0)}</th><th class="num">${euros(totais.diario)}</th><th class="num">${fecho.faturas_ficheiro ? euros(totais.faturas) : '—'}</th><th class="num">${fecho.faturas_ficheiro ? euros(dif) : '—'}</th><th></th><th class="num">${euros(comprovativosC / 100)}</th><th></th><th>${validacao.validado ? h`<span class="tag ok">Total validado</span>` : `${validacao.validados}/${validacao.exigidos}`}</th></tr></tfoot>
    </table></div>

    ${analise.taloesSemMeio.length ? aviso(`${analise.taloesSemMeio.length} talão(ões) de compra sem fatura associada ficam fora da validação por meio: ${analise.taloesSemMeio.map((t) => '#' + t.id).join(', ')}.`, 'info') : ''}
  </div>

  ${grupos.map((g) => subPainel(g, fecho, numerario, fechosTPA, { terminais: terminaisPorNumero, caixas: caixasLista, validacao }))}
  ${blocoNumerario(fecho, numerario)}
</section>

<section class="painel-aba" id="painel-utilizadores" role="tabpanel" aria-labelledby="aba-utilizadores" data-painel="utilizadores">
  <div class="tabela-wrap"><table class="utilizadores">
  <thead><tr><th>Utilizador</th><th>Caixas</th><th class="num">Movimentos</th>${colunasMeiosUtil.map((m) => h`<th class="num">${m.tipo}</th>`)}<th class="num">Total</th><th class="num">Pendentes</th></tr></thead>
  <tbody>${porUtilizador.map((u) => h`<tr>
    <td><a href="/fechos/${fecho.data}?utilizador=${encodeURIComponent(u.utilizador)}#incs">${u.utilizador}</a></td><td>${u.caixas}</td>
    <td class="num">${u.n}</td>
    ${colunasMeiosUtil.map((m) => h`<td class="num">${m.tipo in u.porMeio ? euros(u.porMeio[m.tipo]) : h`<span class="suave">—</span>`}</td>`)}
    <td class="num"><strong>${euros(u.total)}</strong></td>
    <td class="num">${u.pendentes ? h`<a href="/fechos/${fecho.data}?utilizador=${encodeURIComponent(u.utilizador)}&estado=pendente#incs"><strong class="pendente">${u.pendentes}</strong></a>` : '0'}</td></tr>`)}</tbody>
  <tfoot><tr><th>Total</th><th></th><th class="num">${porUtilizador.reduce((s, u) => s + u.n, 0)}</th>${colunasMeiosUtil.map((m) => h`<th class="num">${euros(porUtilizador.reduce((s, u) => s + (u.porMeio[m.tipo] || 0), 0))}</th>`)}<th class="num">${euros(porUtilizador.reduce((s, u) => s + u.total, 0))}</th><th class="num">${porUtilizador.reduce((s, u) => s + u.pendentes, 0)}</th></tr></tfoot>
  </table></div>
</section>

<section class="painel-aba" id="painel-alojamentos" role="tabpanel" aria-labelledby="aba-alojamentos" data-painel="alojamentos">
  <p class="suave">Movimentos do diário, por caixa e meio de pagamento.</p>
  <div class="tabela-wrap"><table class="alojamentos">
  <thead><tr><th>Alojamento (caixa)</th><th class="num">Movimentos</th>${colunasMeios.map((m) => h`<th class="num">${m.tipo}</th>`)}<th class="num">Total</th><th class="num">Pendentes</th></tr></thead>
  <tbody>${porAlojamento.map((a) => h`<tr>
    <td>${a.caixa ? h`<a href="/fechos/${fecho.data}?caixa=${encodeURIComponent(a.caixa)}#incs">${a.caixa}</a>` : '(sem caixa)'}</td>
    <td class="num">${a.n}</td>
    ${colunasMeios.map((m) => h`<td class="num">${m.tipo in a.porMeio ? euros(a.porMeio[m.tipo]) : h`<span class="suave">—</span>`}</td>`)}
    <td class="num"><strong>${euros(a.total)}</strong></td>
    <td class="num">${a.pendentes ? h`<a href="/fechos/${fecho.data}?caixa=${encodeURIComponent(a.caixa)}&estado=pendente#incs"><strong class="pendente">${a.pendentes}</strong></a>` : '0'}</td></tr>`)}
  ${pendentesSemAlojamento ? h`<tr><td><span class="suave">Sem alojamento associado</span></td><td class="num"><span class="suave">—</span></td>${colunasMeios.map(() => h`<td class="num"><span class="suave">—</span></td>`)}<td class="num"><span class="suave">—</span></td><td class="num"><strong class="pendente">${pendentesSemAlojamento}</strong></td></tr>` : ''}</tbody>
  <tfoot><tr><th>Total</th><th class="num">${porAlojamento.reduce((s, a) => s + a.n, 0)}</th>${colunasMeios.map((m) => h`<th class="num">${euros(porAlojamento.reduce((s, a) => s + (a.porMeio[m.tipo] || 0), 0))}</th>`)}<th class="num">${euros(porAlojamento.reduce((s, a) => s + a.total, 0))}</th><th class="num">${porAlojamento.reduce((s, a) => s + a.pendentes, 0) + pendentesSemAlojamento}</th></tr></tfoot>
  </table></div>
</section>

${reservas.some((r) => r.reservas) && h`<section class="painel-aba" id="painel-reservas" role="tabpanel" aria-labelledby="aba-reservas" data-painel="reservas">
  <p class="suave">Total das reservas contra o que está faturado.</p>
  <div class="tabela-wrap"><table class="saidas">
  <thead><tr><th></th><th class="num">Reservas</th><th class="num">Canceladas / no-show</th><th class="num">Total das reservas</th><th class="num">Faturado</th><th class="num">Por faturar</th><th class="num">Sem nenhuma fatura</th></tr></thead>
  <tbody>${reservas.filter((r) => r.reservas).map((r) => h`<tr>
    <td><strong>${r.nome}s</strong></td><td class="num">${r.ativas}</td><td class="num">${r.canceladas}</td>
    <td class="num">${euros(r.total)}</td><td class="num">${euros(r.faturado)}</td><td class="num">${euros(r.total - r.faturado)}</td><td class="num">${r.semFatura}</td></tr>`)}</tbody>
  </table></div>
</section>`}

${totalIncs ? h`<section class="painel-aba" id="painel-incs" role="tabpanel" aria-labelledby="aba-incs" data-painel="incs">
  <p class="suave">${contagem.pendente || 0} pendentes · ${contagem.justificada || 0} justificadas · ${contagem.resolvida || 0} resolvidas</p>
  ${filtrosIncs(`/fechos/${fecho.data}#incs`, filtros, opcoes, false)}
  ${tabelaIncs(incs, false)}
</section>
`: ''}

<section class="painel-aba" id="painel-taloes" role="tabpanel" aria-labelledby="aba-taloes" data-painel="taloes">
  ${tabelaTaloes(taloes, false)}
</section>`, 'fechos');
}

// ---------- Seletor de período (dia, semana, mês, ano ou intervalo) ----------
// O calendário é montado em app.js; aqui só vão os campos escondidos (de/ate) que seguem no formulário.
function seletorPeriodo(de, ate, diasComDados = []) {
  return h`<div class="periodo" data-periodo data-dias="${diasComDados.join(',')}">
  <input type="hidden" name="de" value="${de || ''}"><input type="hidden" name="ate" value="${ate || ''}">
  <label>Período
    <button type="button" class="periodo-botao" aria-haspopup="dialog" aria-expanded="false">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4M16 2v4M3 10h18"/><rect width="18" height="18" x="3" y="4" rx="2"/></svg>
      <span data-texto>${de ? (de === ate ? dataPT(de) : `${dataPT(de)} – ${dataPT(ate)}`) : 'Todos os dias'}</span>
    </button>
  </label>
  <div class="periodo-painel" role="dialog" aria-label="Escolher período" hidden></div>
</div>`;
}

// ---------- Diários (resumo geral) ----------
const COLUNAS_DIARIOS = ['Data', 'Reserva', 'Unidade', 'Quarto', 'Hóspede', 'Check-in', 'Check-out', 'Documento', 'Valor', 'Meio', 'Caixa', 'Operador'];

export function diariosPage(user, d, query) {
  const { filtros, linhas, opcoes, resumo } = d;
  const select = (nome, rotulo, valores, texto = (x) => x) => h`<label>${rotulo}
  <select name="${nome}"><option value="">Todos</option>${valores.map((x) => h`<option value="${x}" ${filtros[nome] === x ? raw('selected') : ''}>${texto(x)}</option>`)}</select></label>`;
  return pagina(user, 'Diários', h`
<div class="cabecalho">
  <div><h1>Diários</h1><p class="suave">Resumo geral das faturas e notas de crédito de todos os dias carregados, pela data do documento.</p></div>
  <a class="botao" href="/diarios.xls${query ? '?' + query : ''}">Descarregar para Excel</a>
</div>
<form class="filtros uma-linha" method="get" action="/diarios">
  ${seletorPeriodo(filtros.de, filtros.ate, opcoes.dias)}
  ${select('serie', 'Série', opcoes.series)}
  ${select('unidade', 'Unidade', opcoes.unidades)}
  ${select('meio', 'Meio de pagamento', opcoes.meios)}
  ${select('caixa', 'Caixa', opcoes.caixas)}
  ${select('operador', 'Operador', opcoes.operadores, (x) => (x === '__sem__' ? '(sem operador)' : x))}
  <label>Faturação
  <select name="faturacao">${[['', 'Todas'], ['faturadas', 'Faturadas'], ['porfaturar', 'Por faturar']].map(([valor, texto]) => h`<option value="${valor}" ${filtros.faturacao === valor ? raw('selected') : ''}>${texto}</option>`)}</select></label>
  <label>ID da reserva <input type="search" name="reserva" value="${filtros.reserva}" placeholder="Pesquisar reserva" inputmode="numeric" autocomplete="off"></label>
  <button>Filtrar</button> <a href="/diarios">Limpar</a>
</form>
<div class="indicadores">
  <div><span>Dias</span><strong>${resumo.dias}</strong></div>
  <div><span>Documentos</span><strong>${resumo.documentos}</strong></div>
  <div><span>Total</span><strong>${euros(resumo.total)}</strong></div>
  <div><span>Notas de crédito</span><strong>${resumo.notas}</strong></div>
  <div><span>Valor das notas de crédito</span><strong>${euros(resumo.totalNotas)}</strong></div>
  ${resumo.porFaturar && h`<div class="por-faturar"><span>Reservas por faturar</span><strong>${resumo.porFaturar.reservas} · ${euros(resumo.porFaturar.total)}</strong></div>`}
</div>
<p class="suave legenda"><span class="amostra nc"></span> Reserva com nota de crédito no mesmo dia (fatura anulada ou reemitida)${resumo.porFaturar && h` · <span class="amostra pf"></span> Reserva das listas de saídas/entradas ainda sem fatura (valor = total da reserva)`}</p>
${linhas.length === 0 ? h`<p class="vazio">Sem faturas com estes filtros. Carregue o relatório de faturas de um dia em Fechos.</p>` : h`
<div class="tabela-wrap"><table class="diarios">
<thead><tr>${COLUNAS_DIARIOS.map((c) => h`<th class="${c === 'Valor' ? 'num' : ''}">${c}</th>`)}</tr></thead>
<tbody>${linhas.map((l) => h`<tr class="${l.comNC ? 'nc' : l.porFaturar ? 'por-faturar' : ''}">
  <td class="dia-${l.grupo % 3}">${dataPT(l.data)}</td>
  <td class="reserva">${l.reserva}</td>
  <td>${l.hotel}</td>
  <td>${l.quarto}</td>
  <td>${l.hospede}</td>
  <td>${dataPT(l.checkin)}</td>
  <td>${dataPT(l.checkout)}</td>
  <td>${l.doc}</td>
  <td class="num dia-${l.grupo % 3}">${euros(l.valor)}</td>
  <td>${l.tipo}</td>
  <td>${l.caixa}</td>
  <td>${l.operador}</td>
</tr>`)}</tbody></table></div>`}`, 'diarios');
}

// O mesmo quadro como ficheiro que o Excel abre: uma tabela HTML com as cores no próprio ficheiro.
export function diariosExcel({ linhas }) {
  const CORES = ['#ffffff', '#ffc000', '#5b9bd5'];
  const ROSA = '#e59adf';
  const AMARELO = '#fff2cc'; // reservas por faturar
  const borda = 'border:0.5pt solid #000;font-family:Calibri;font-size:11pt;';
  const celula = (valor, fundo, extra = '', attrs = '') => h`<td ${raw(attrs)} style="${borda}background:${fundo};${extra}">${valor}</td>`;
  return h`<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body>
<table>
<tr>${COLUNAS_DIARIOS.map((c) => h`<th style="${borda}background:#d9d9d9;">${c}</th>`)}</tr>
${linhas.map((l) => {
    const dia = CORES[l.grupo % 3];
    const linha = l.comNC ? ROSA : l.porFaturar ? AMARELO : '#ffffff';
    const valor = l.comNC ? ROSA : l.porFaturar ? AMARELO : dia;
    return h`<tr>
${celula(dataPT(l.data), l.comNC ? '#ffc7ce' : dia, 'text-align:center;')}
${celula(l.reserva, l.comNC ? '#ffc7ce' : '#ffffff', `text-align:center;${l.comNC ? 'color:#c00000;' : ''}`)}
${celula(l.hotel, linha, 'text-align:center;')}
${celula(l.quarto, linha, 'text-align:center;')}
${celula(l.hospede, linha, 'text-align:center;')}
${celula(dataPT(l.checkin), linha, 'text-align:center;')}
${celula(dataPT(l.checkout), linha, 'text-align:center;')}
${celula(l.doc, linha)}
${celula(euros(l.valor), valor, `text-align:right;${l.comNC ? 'font-weight:bold;' : ''}mso-number-format:'\\#\\,\\#\\#0\\.00\\ \\€';`, `x:num="${Number(l.valor).toFixed(2)}"`)}
${celula(l.tipo, linha, 'text-align:center;')}
${celula(l.caixa, linha, 'text-align:center;')}
${celula(l.operador, linha, 'text-align:center;')}
</tr>`;
  })}
</table></body></html>`.toString();
}

export function incsPage(user, incs, filtros, opcoes) {
  return pagina(user, 'Inconsistências', h`
<div class="cabecalho"><h1>Inconsistências</h1></div>
${filtrosIncs('/inconsistencias', filtros, opcoes, true)}
${tabelaIncs(incs, true)}`, 'incs');
}

// Uma linha é de nota de crédito quando algum documento começa por NC.
const eNC = (linha) => Object.entries(linha).some(([k, val]) => /doc/i.test(k) && /^NC\b/i.test(String(val ?? '')));

function tabelaRegistos(registos) {
  const porOrigem = new Map();
  for (const r of registos) {
    if (!porOrigem.has(r.origem)) porOrigem.set(r.origem, []);
    porOrigem.get(r.origem).push(r);
  }
  return [...porOrigem].map(([origem, linhas]) => {
    const colunas = Object.keys(linhas[0]).filter((c) => c !== 'origem' && linhas.some((l) => l[c] !== null && l[c] !== undefined && l[c] !== ''));
    const dinheiro = (c) => /valor|total|faturado/i.test(c);
    const celula = (c, v) => (typeof v === 'number' && dinheiro(c) ? euros(v) : v);
    return h`<h3>${origem}</h3><div class="tabela-wrap"><table>
<thead><tr>${colunas.map((c) => h`<th class="${dinheiro(c) ? 'num' : ''}">${c}</th>`)}</tr></thead>
<tbody>${linhas.map((l) => h`<tr class="${eNC(l) ? 'nc' : ''}">${colunas.map((c) => h`<td class="${[dinheiro(c) ? 'num' : '', /reserva/i.test(c) ? 'reserva' : ''].join(' ').trim()}">${celula(c, l[c])}</td>`)}</tr>`)}</tbody></table></div>${linhas.some(eNC) ? legendaNC : ''}`;
  });
}

export function incPage(user, inc, historico, envios, erro, { texto = '', estado: estadoEscolhido = '' } = {}) {
  const detalhe = JSON.parse(inc.detalhe_json);
  return pagina(user, TIPOS[inc.tipo] || inc.tipo, h`
<p><a href="/fechos/${inc.data}#incs">← Fecho de ${dataPT(inc.data)}</a></p>
<div class="cabecalho">
  <div>
    <p>${etiqueta('g-' + inc.gravidade, GRAVIDADES[inc.gravidade])} ${etiqueta('e-' + inc.estado, ESTADOS[inc.estado])} <span class="suave">${TIPOS[inc.tipo] || inc.tipo}</span></p>
    <h1>${inc.titulo}</h1>
  </div>
</div>
${!inc.ativa && aviso('Esta inconsistência já não é detetada com os dados atuais. Fica guardada porque tem notas.', 'info')}
<dl class="meta">
  <div><dt>Dia</dt><dd>${dataPT(inc.data)}</dd></div>
  ${inc.utilizador && h`<div><dt>Utilizador</dt><dd>${inc.utilizador}</dd></div>`}
  ${inc.caixa && h`<div><dt>Caixa</dt><dd>${inc.caixa}</dd></div>`}
  ${inc.valor !== null && h`<div><dt>Valor</dt><dd>${euros(inc.valor)}</dd></div>`}
</dl>
<p>${detalhe.texto}</p>
${tabelaRegistos(detalhe.registos || [])}
${envios.length > 0 && h`<h3>Fotografias</h3><div class="fotos">${envios.map((e) => h`<a href="/envios/${e.id}">${e.mime === 'application/pdf' ? h`<span class="pdf">PDF</span>` : h`<img src="/envios/${e.id}/ficheiro" alt="Talão" loading="lazy">`}</a>`)}</div>`}

<section class="cartao" id="notas">
  <h2>Notas e estado</h2>
  ${historico.length === 0 && h`<p class="vazio">Ainda sem notas.</p>`}
  <ol class="historico">${historico.map((x) => h`<li class="${x.kind}">
    <span class="suave">${quandoPT(x.quando)} · ${x.autor}</span>
    ${x.kind === 'nota' ? h`<p>${x.texto}</p>` : h`<p>Estado alterado de <strong>${ESTADOS[x.estado_de]}</strong> para <strong>${ESTADOS[x.estado_para]}</strong></p>`}
  </li>`)}</ol>
  ${aviso(erro)}
  <form method="post" action="/inconsistencias/${inc.id}/nota">
    <label>Nova nota <textarea name="texto" rows="3" required placeholder="O que foi verificado e o que se concluiu">${texto}</textarea></label>
    <fieldset class="estados">
      <legend>Estado depois de guardar</legend>
      <label><input type="radio" name="estado" value="" ${estadoEscolhido ? '' : raw('checked')}> Manter (${ESTADOS[inc.estado]})</label>
      ${Object.keys(ESTADOS).filter((e) => e !== inc.estado).map((e) => h`<label><input type="radio" name="estado" value="${e}" ${estadoEscolhido === e ? raw('checked') : ''}> ${ESTADOS[e]}</label>`)}
    </fieldset>
    <button class="primario">Guardar</button>
  </form>
</section>`, 'incs');
}

// ---------- Talões ----------
function tabelaTaloes(taloes, mostrarDia) {
  if (!taloes.length) return h`<p class="vazio">Sem talões.</p>`;
  return h`<div class="tabela-wrap"><table>
<thead><tr><th>ID</th>${mostrarDia && h`<th>Dia</th>`}<th>Hora</th><th>Tipo</th><th>TPA</th><th class="num">Valor</th><th>Cartão</th><th>Reserva</th><th>Documento</th><th>Nota</th><th>Enviado por</th><th></th></tr></thead>
<tbody>${taloes.map((t) => h`<tr>
  <td><strong>#${t.id}</strong></td>
  ${mostrarDia && h`<td>${t.data ? h`<a href="/fechos/${t.data}">${dataPT(t.data)}</a>` : ''}</td>`}
  <td>${t.hora}</td>
  <td>${t.tipo === 'fecho' ? 'Fecho' : 'Compra'}${t.estado === 'rascunho' ? h` ${etiqueta('falta', 'Por confirmar')}` : ''}</td>
  <td>${t.tpa}</td>
  <td class="num">${euros(t.valor)}</td>
  <td>${t.cartao} ${t.ultimos4 && `****${t.ultimos4}`}</td>
  <td>${t.reservas}${t.reserva_origem === 'manual' ? h` <span class="suave" title="Introduzida à mão">✎</span>` : ''}</td>
  <td>${t.doc_associado}</td>
  <td class="nota-celula">${t.nota_envio}</td>
  <td>${t.enviado_por}</td>
  <td><a href="/envios/${t.envio_id}">Ver</a></td>
</tr>`)}</tbody></table></div>`;
}

export function taloesPage(user, taloes, filtros, dias = []) {
  return pagina(user, 'Talões', h`
<div class="cabecalho"><h1>Talões</h1><a class="botao primario" href="/taloes/novo">Enviar talão</a></div>
<form class="filtros" method="get" action="/taloes">
  ${seletorPeriodo(filtros.de, filtros.ate, dias)}
  <label>Tipo <select name="tipo"><option value="">Todos</option><option value="compra" ${filtros.tipo === 'compra' ? raw('selected') : ''}>Compra</option><option value="fecho" ${filtros.tipo === 'fecho' ? raw('selected') : ''}>Fecho</option></select></label>
  <button>Filtrar</button> <a href="/taloes">Limpar</a>
</form>
${tabelaTaloes(taloes, true)}`, 'taloes');
}

export function novoTalaoPage(user, erro) {
  return pagina(user, 'Enviar talão', h`
<section class="cartao estreito">
  <h1>Enviar talão</h1>
  <p>Fotografe o talão de compra com o número da reserva escrito à mão e, se o tiver, o talão de fecho do terminal. Podem ir os dois na mesma fotografia.</p>
  ${aviso(erro)}
  <form method="post" action="/taloes/enviar" enctype="multipart/form-data" id="form-envio">
    <input type="file" name="ficheiro" id="ficheiro" accept="image/*,application/pdf" hidden>
    <div class="botoes-grandes">
      <button type="button" class="primario grande" data-capturar>Tirar fotografia</button>
      <button type="button" class="grande" data-escolher>Escolher ficheiro</button>
    </div>
    <div id="previa" hidden><img alt="Pré-visualização do talão"><p class="suave" id="previa-nome"></p></div>
    <label class="nota-envio">Nota para o auditor <span class="suave">(opcional)</span>
      <textarea name="nota" maxlength="500" rows="3" placeholder="Ex.: cliente pagou metade em dinheiro; talão repetido por falha do terminal…"></textarea>
    </label>
    <button class="primario grande" id="enviar" hidden>Enviar e ler talão</button>
    <p class="suave" id="a-ler" hidden>A ler o talão… pode demorar alguns segundos.</p>
  </form>
</section>`, 'novo');
}

function blocoTalao(i, t, editavel) {
  const dis = editavel ? '' : raw('disabled');
  const n = (campo) => `t[${i}][${campo}]`;
  return h`<fieldset class="talao ${t.duvidoso ? 'duvidoso' : ''}" data-talao>
  <legend>Talão</legend>
  ${t.id && h`<input type="hidden" name="${n('id')}" value="${t.id}">`}
  <input type="hidden" name="${n('reserva_lida')}" value="${t.reserva_lida || ''}">
  <div class="grelha">
    <label>Tipo <select name="${n('tipo')}" data-tipo ${dis}>
      <option value="compra" ${t.tipo !== 'fecho' ? raw('selected') : ''}>Compra</option>
      <option value="fecho" ${t.tipo === 'fecho' ? raw('selected') : ''}>Fecho do terminal</option></select></label>
    <label>Terminal (TPA) <input name="${n('tpa')}" value="${t.tpa || ''}" inputmode="numeric" required ${dis}></label>
    <label>Dia <input type="date" name="${n('data')}" value="${t.data || ''}" required ${dis}></label>
    <label>Hora <input type="time" step="1" name="${n('hora')}" value="${t.hora || ''}" ${dis}></label>
    <label>Valor (€) <input name="${n('valor')}" value="${valorCampo(t.valor)}" inputmode="decimal" required ${dis}></label>
    <label data-so-compra>N.º da reserva <input name="${n('reservas')}" value="${t.reservas || ''}" inputmode="numeric" placeholder="Ex.: 190307" ${dis}>
      ${t.duvidoso ? h`<small class="pendente">Leitura com dúvidas: confirme pelo talão.</small>` : ""}</label>
    <label data-so-compra>Cartão <input name="${n('cartao')}" value="${t.cartao || ''}" ${dis}></label>
    <label data-so-compra>Últimos 4 dígitos <input name="${n('ultimos4')}" value="${t.ultimos4 || ''}" inputmode="numeric" maxlength="4" ${dis}></label>
  </div>
  ${editavel && h`<label class="remover"><input type="checkbox" name="${n('remover')}" value="1"> Remover este talão</label>`}
</fieldset>`;
}

export function envioPage(user, envio, taloes, editavel, erros = []) {
  const lista = taloes.length ? taloes : [{ tipo: 'compra' }];
  const intro = !editavel
    ? null
    : envio.estado === 'confirmado'
      ? aviso('Talão já confirmado. Como auditor, pode corrigir os dados.', 'info')
      : envio.leitura_erro
        ? aviso(`Não foi possível ler o talão automaticamente: ${envio.leitura_erro} Preencha os dados à mão.`, 'info')
        : taloes.length
          ? aviso('Confirme se os dados lidos estão certos, sobretudo o número da reserva. Corrija o que for preciso.', 'ok')
          : aviso('Não encontrei nenhum talão nesta imagem. Preencha os dados à mão ou envie outra fotografia.', 'info');
  return pagina(user, 'Confirmar talão', h`
<div class="cabecalho"><h1>${editavel ? 'Confirmar talão' : 'Talão enviado'}</h1>
  <p class="suave">Enviado por ${envio.enviado_por} em ${quandoPT(envio.criado_em)}</p></div>
${intro}
${erros.map((e) => aviso(e))}
<div class="envio">
  <div class="foto">${envio.mime === 'application/pdf'
    ? h`<object data="/envios/${envio.id}/ficheiro" type="application/pdf"><a href="/envios/${envio.id}/ficheiro">Abrir o PDF</a></object>`
    : h`<a href="/envios/${envio.id}/ficheiro" target="_blank"><img src="/envios/${envio.id}/ficheiro" alt="Fotografia do talão"></a>`}</div>
  <form method="post" action="/envios/${envio.id}" class="dados">
    ${editavel
    ? h`<label class="nota-envio">Nota <span class="suave">(opcional)</span>
      <textarea name="nota" maxlength="500" rows="3" placeholder="Uma nota para o auditor sobre este talão">${envio.nota || ''}</textarea>
    </label>`
    : envio.nota && h`<div class="nota-lida"><strong>Nota de ${envio.enviado_por}</strong><p>${envio.nota}</p></div>`}
    <div id="taloes">${lista.map((t, i) => blocoTalao(i, t, editavel))}</div>
    ${editavel && h`
    <template id="modelo-talao">${blocoTalao('__i__', { tipo: 'compra' }, true)}</template>
    <p><button type="button" data-adicionar-talao>Adicionar outro talão desta fotografia</button></p>
    <button class="primario grande">${envio.estado === 'confirmado' ? 'Guardar alterações' : 'Confirmar'}</button>`}
  </form>
</div>
${editavel && h`<form method="post" action="/envios/${envio.id}/apagar" class="apagar" data-confirmar="Apagar este envio e a fotografia?"><button class="link perigo">Apagar este envio</button></form>`}`,
    user.role === 'auditor' ? 'taloes' : 'meus');
}

export function meusEnviosPage(user, envios, ok) {
  return pagina(user, 'Os meus envios', h`
<div class="cabecalho"><h1>Os meus envios</h1><a class="botao primario" href="/taloes/novo">Enviar talão</a></div>
${ok && aviso('Talão registado. Obrigado.', 'ok')}
${envios.length === 0 ? h`<p class="vazio">Ainda não enviou nenhum talão.</p>` : h`<div class="tabela-wrap"><table>
<thead><tr><th>Enviado em</th><th>Estado</th><th>Talões</th><th class="num">Valor</th><th>Reserva</th><th>Nota</th><th></th></tr></thead>
<tbody>${envios.map((e) => h`<tr>
  <td>${quandoPT(e.criado_em)}</td>
  <td>${e.estado === 'confirmado' ? etiqueta('ok', 'Confirmado') : etiqueta('falta', 'Por confirmar')}</td>
  <td>${e.n}</td><td class="num">${euros(e.total)}</td><td>${e.reservas}</td><td class="nota-celula">${e.nota}</td>
  <td><a href="/envios/${e.id}">${e.estado === 'confirmado' ? 'Ver' : 'Confirmar'}</a></td>
</tr>`)}</tbody></table></div>`}`, 'meus');
}

// ---------- Configuração ----------
export function terminaisPage(user, tpas, caixas, msg, erro) {
  return pagina(user, 'Terminais TPA', h`
<div class="cabecalho"><h1>Configuração</h1></div>
${subnavConfig('terminais')}
<p>Indique as unidades (caixas do PMS) em que cada terminal é usado. Um terminal pode servir várias unidades. É esta ligação que permite comparar o fecho de cada TPA com os pagamentos por cartão do diário. Os terminais novos aparecem aqui sozinhos quando chega o primeiro talão.</p>
${aviso(msg, 'ok')}${aviso(erro)}
${caixas.length === 0 && aviso('Ainda não há unidades: aparecem depois de carregar o primeiro diário de caixa.', 'info')}
${tpas.map((t) => h`<form method="post" action="/config/terminais/${t.id}" class="cartao terminal">
  <div class="grelha">
    <label>Terminal <input value="${t.numero}" disabled></label>
    <label>Nome <input name="nome" value="${t.nome || ''}" placeholder="Ex.: Reservas central"></label>
  </div>
  <div class="caixas">${caixas.map((c) => h`<label><input type="checkbox" name="caixas" value="${c}" ${t.caixas.includes(c) ? raw('checked') : ''}> ${c}</label>`)}</div>
  <button>Guardar</button>
</form>`)}
<form method="post" action="/config/terminais" class="cartao">
  <h2>Adicionar terminal</h2>
  <div class="grelha">
    <label>Número do TPA <input name="numero" inputmode="numeric" required></label>
    <label>Nome <input name="nome"></label>
  </div>
  <button class="primario">Adicionar</button>
</form>`, 'config');
}

export function agenciasPage(user, agencias, prazo, msg) {
  const REGRAS = {
    imediata: 'Faturada até à estadia',
    prazo: 'Faturada depois da saída, dentro do prazo',
    agencia: 'Faturada à parte (não é erro faltar fatura)',
  };
  return pagina(user, 'Agências', h`
<div class="cabecalho"><h1>Configuração</h1></div>
${subnavConfig('agencias')}
<p>Indique como cada agência é faturada. É isto que decide se uma reserva sem fatura é assinalada como erro, fica a aguardar o prazo ou é só listada. As agências aparecem aqui quando surgem numa lista de reservas.</p>
${aviso(msg, 'ok')}
${agencias.length === 0 ? aviso('As agências aparecem depois de carregar a primeira lista de saídas ou de entradas.', 'info') : h`
<form method="post" action="/config/agencias" class="cartao">
  <label class="curto">Prazo de faturação depois da saída (dias) <input type="number" name="prazo" min="0" max="90" value="${prazo}"></label>
  <div class="tabela-wrap"><table>
  <thead><tr><th>Agência</th><th>Como é faturada</th></tr></thead>
  <tbody>${agencias.map((a, i) => h`<tr><td>${a.nome}<input type="hidden" name="n${i}" value="${a.nome}"></td>
    <td><select name="r${i}">${Object.entries(REGRAS).map(([k, t]) => h`<option value="${k}" ${a.regra === k ? raw('selected') : ''}>${t}</option>`)}</select></td></tr>`)}</tbody>
  </table></div>
  <p><button class="primario">Guardar</button></p>
</form>`}`, 'config');
}

export function meiosPage(user, meios, msg) {
  return pagina(user, 'Meios de pagamento', h`
<div class="cabecalho"><h1>Configuração</h1></div>
${subnavConfig('meios')}
<p>Marque os meios de pagamento que passam num terminal TPA. Só para esses é exigido talão.</p>
${aviso(msg, 'ok')}
${meios.length === 0 ? aviso('Os meios de pagamento aparecem depois de carregar o primeiro diário de caixa.', 'info') : h`
<form method="post" action="/config/meios" class="cartao">
  <div class="caixas vertical">${meios.map((m) => h`<label><input type="checkbox" name="tpa" value="${m.codigo}" ${m.tpa ? raw('checked') : ''}> <strong>${m.codigo}</strong> <span class="suave">${m.descricao}</span></label>`)}</div>
  <button class="primario">Guardar</button>
</form>`}`, 'config');
}

export function leituraPage(user, estado, cifrada, msg, erro) {
  const { ativo, fornecedores } = estado;
  const NOMES = { anthropic: 'Anthropic (Claude)', gemini: 'Google Gemini' };
  const situacao = ativo
    ? aviso(h`A leitura automática está <strong>ativa</strong>, com <strong>${NOMES[ativo]}</strong>. Aplica-se a todos os utilizadores, em Enviar talão.`, 'ok')
    : aviso(h`A leitura automática está <strong>desligada</strong>: sem chave, os talões têm de ser preenchidos à mão.`, 'info');
  const cartao = (f, titulo, ajuda, extra) => {
    const e = fornecedores[f];
    const fim = e.fim ? h` (termina em <strong>${e.fim}</strong>)` : '';
    const estadoTxt = e.origem === 'base' ? h`Chave guardada na base de dados${fim}${cifrada ? ', encriptada' : ''}.`
      : e.origem === 'ambiente' ? h`Chave definida no servidor (variável de ambiente)${fim}. Pode substituí-la aqui.`
        : 'Sem chave.';
    return h`<section class="cartao estreito">
  <h2>${titulo} ${ativo === f ? etiqueta('ok', 'Em uso') : e.origem ? etiqueta('suave', 'Configurado') : ''}</h2>
  <p class="suave">${estadoTxt}</p>
  <form method="post" action="/config/leitura" autocomplete="off">
    <input type="hidden" name="fornecedor" value="${f}">
    <label>${e.origem ? 'Substituir a chave' : 'Chave da API'}
      <input name="chave" type="password" placeholder="${f === 'anthropic' ? 'sk-ant-...' : 'Chave do Google AI Studio'}" autocomplete="off" spellcheck="false" required>
    </label>
    ${extra && extra(e)}
    <p class="suave">${ajuda}</p>
    <button class="primario">Validar e guardar</button>
  </form>
  <div class="acoes">
    ${e.origem && ativo !== f && h`<form method="post" action="/config/leitura/ativar"><input type="hidden" name="fornecedor" value="${f}"><button>Usar este fornecedor</button></form>`}
    ${e.origem === 'base' && h`<form method="post" action="/config/leitura/remover" data-confirmar="Remover a chave de ${NOMES[f]}?"><input type="hidden" name="fornecedor" value="${f}"><button class="perigo">Remover a chave</button></form>`}
  </div>
</section>`;
  };
  return pagina(user, 'Leitura de talões', h`
<div class="cabecalho"><h1>Configuração</h1></div>
${subnavConfig('leitura')}
<p>Os talões enviados por qualquer utilizador são lidos automaticamente. Escolha o serviço e adicione aqui a chave da API; passa a valer logo para todos, em Enviar talão. As fotografias e PDF dos talões são enviados ao serviço escolhido para leitura.</p>
${aviso(msg, 'ok')}${aviso(erro)}
${situacao}
${cartao('gemini', 'Google Gemini',
    h`Crie a chave em aistudio.google.com/apikey. <strong>Atenção:</strong> no nível gratuito a Google pode usar o conteúdo enviado para melhorar os seus produtos, e os talões incluem dados de clientes; para evitar isso, ative a faturação (nível pago) no Google AI Studio.${cifrada ? '' : ' Sem ENCRYPTION_KEY no servidor, a chave fica guardada sem encriptar.'}`,
    (e) => h`<label>Modelo <span class="suave">(opcional)</span>
      <input name="modelo" value="${e.modelo}" placeholder="gemini-3.6-flash" autocomplete="off" spellcheck="false">
    </label>`)}
${cartao('anthropic', 'Anthropic (Claude)',
    h`Crie a chave em console.anthropic.com › Settings › API Keys (a conta precisa de crédito). A chave não volta a ser mostrada: só os últimos 4 caracteres.${cifrada ? '' : ' Sem ENCRYPTION_KEY no servidor, a chave fica guardada sem encriptar.'}`)}`, 'config');
}

export function utilizadoresPage(user, users, msg, erro) {
  return pagina(user, 'Utilizadores', h`
<div class="cabecalho"><h1>Configuração</h1></div>
${subnavConfig('utilizadores')}
${aviso(msg, 'ok')}${aviso(erro)}
<div class="tabela-wrap"><table>
<thead><tr><th>Nome</th><th>Utilizador</th><th>Perfil</th><th>Estado</th><th>Repor palavra-passe</th><th></th></tr></thead>
<tbody>${users.map((u) => h`<tr>
  <td>${u.nome}</td><td>${u.username}</td><td>${u.role === 'auditor' ? 'Auditor' : 'Receção'}</td>
  <td>${u.ativo ? etiqueta('ok', 'Ativo') : etiqueta('falta', 'Inativo')}</td>
  <td><form method="post" action="/config/utilizadores/${u.id}/password" class="linha">
    <input name="password" type="password" minlength="8" placeholder="Nova palavra-passe" autocomplete="new-password" required><button>Repor</button></form></td>
  <td>${u.id !== user.id && h`<form method="post" action="/config/utilizadores/${u.id}/ativo"><button class="link">${u.ativo ? 'Desativar' : 'Reativar'}</button></form>`}</td>
</tr>`)}</tbody></table></div>
<form method="post" action="/config/utilizadores" class="cartao">
  <h2>Novo utilizador</h2>
  <div class="grelha">
    <label>Nome <input name="nome" required></label>
    <label>Utilizador <input name="username" autocapitalize="none" required></label>
    <label>Perfil <select name="role"><option value="rececionista">Receção (só envia talões)</option><option value="auditor">Auditor</option></select></label>
    <label>Palavra-passe inicial <input name="password" type="password" minlength="8" autocomplete="new-password" required></label>
  </div>
  <button class="primario">Criar utilizador</button>
</form>`, 'config');
}
