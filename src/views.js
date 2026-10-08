// Páginas HTML. Tudo o que é interpolado em h`...` é escapado, exceto o que vier de outro h`...` ou de raw().
import { TIPOS } from './reconcile.js';

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
const quandoPT = (iso) =>
  iso ? new Date(iso).toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon', dateStyle: 'short', timeStyle: 'short' }) : '';
const valorCampo = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

const ESTADOS = { pendente: 'Pendente', justificada: 'Justificada', resolvida: 'Resolvida' };
const GRAVIDADES = { erro: 'Erro', aviso: 'Aviso', info: 'Informação' };
const etiqueta = (classe, texto) => h`<span class="tag ${classe}">${texto}</span>`;

// ---------- Estrutura ----------
function pagina(user, titulo, corpo, ativo = '') {
  const link = (href, texto, chave) => h`<a href="${href}" class="${ativo === chave ? 'ativo' : ''}">${texto}</a>`;
  const nav = !user
    ? ''
    : user.role === 'auditor'
      ? h`${link('/fechos', 'Fechos', 'fechos')}${link('/inconsistencias', 'Inconsistências', 'incs')}${link('/diarios', 'Diários', 'diarios')}${link('/taloes', 'Talões', 'taloes')}${link('/taloes/novo', 'Enviar talão', 'novo')}${link('/config/terminais', 'Configuração', 'config')}`
      : h`${link('/taloes/novo', 'Enviar talão', 'novo')}${link('/taloes/meus', 'Os meus envios', 'meus')}`;
  return h`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo} · Auditoria de caixas</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="topo">
  <a class="marca" href="/">Auditoria de caixas</a>
  <nav>${nav}</nav>
  ${user && h`<div class="conta"><a href="/conta">${user.nome}</a><form method="post" action="/logout"><button class="link">Sair</button></form></div>`}
</header>
<main>${corpo}</main>
<script src="/app.js" defer></script>
</body>
</html>`.toString();
}

const aviso = (texto, classe = 'erro') => texto && h`<p class="aviso ${classe}">${texto}</p>`;

function subnavConfig(ativo) {
  const item = (href, texto, chave) => h`<a href="${href}" class="${ativo === chave ? 'ativo' : ''}">${texto}</a>`;
  return h`<nav class="subnav">${item('/config/terminais', 'Terminais TPA', 'terminais')}${item('/config/meios', 'Meios de pagamento', 'meios')}${item('/config/agencias', 'Agências', 'agencias')}${item('/config/utilizadores', 'Utilizadores', 'utilizadores')}</nav>`;
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
export function fechosPage(user, fechos) {
  return pagina(user, 'Fechos', h`
<div class="cabecalho"><h1>Fechos de caixa</h1><a class="botao primario" href="/fechos/carregar">Carregar ficheiros do PMS</a></div>
${fechos.length === 0
    ? h`<p class="vazio">Ainda não há nenhum fecho. Comece por carregar o diário de caixa e o relatório de faturas de um dia.</p>`
    : h`<div class="tabela-wrap"><table>
<thead><tr><th>Dia</th><th>Ficheiros</th><th class="num">Total do diário</th><th class="num">Talões</th><th class="num">Pendentes</th><th class="num">Justificadas</th><th class="num">Resolvidas</th></tr></thead>
<tbody>${fechos.map((f) => h`<tr>
  <td><a href="/fechos/${f.data}"><strong>${dataPT(f.data)}</strong></a> <span class="suave">${diaSemana(f.data)}</span></td>
  <td>${f.diario_ficheiro ? etiqueta('ok', 'Diário') : etiqueta('falta', 'Falta o diário')} ${f.faturas_ficheiro ? etiqueta('ok', 'Faturas') : etiqueta('falta', 'Faltam as faturas')}
    ${f.saidas_lista && f.saidas_faturas ? etiqueta('ok', 'Saídas') : ''} ${f.entradas_lista && f.entradas_faturas ? etiqueta('ok', 'Entradas') : ''}</td>
  <td class="num">${euros(f.total)}</td>
  <td class="num">${f.taloes}</td>
  <td class="num">${f.pendentes ? h`<strong class="pendente">${f.pendentes}</strong>` : '0'}</td>
  <td class="num">${f.justificadas}</td>
  <td class="num">${f.resolvidas}</td>
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
<tbody>${incs.map((i) => h`<tr class="${i.ativa ? '' : 'inativa'}">
  ${mostrarDia && h`<td><a href="/fechos/${i.data}">${dataPT(i.data)}</a></td>`}
  <td>${etiqueta('g-' + i.gravidade, GRAVIDADES[i.gravidade])}</td>
  <td>${TIPOS[i.tipo] || i.tipo}</td>
  <td><a href="/inconsistencias/${i.id}">${i.titulo}</a>${!i.ativa && h` <span class="suave">(já não é detetada)</span>`}</td>
  <td>${i.utilizador}</td>
  <td>${i.caixa}</td>
  <td class="num">${euros(i.valor)}</td>
  <td>${etiqueta('e-' + i.estado, ESTADOS[i.estado])}</td>
  <td class="num">${i.notas || ''}</td>
</tr>`)}</tbody></table></div>`;
}

function filtrosIncs(acao, f, opcoes, comDia) {
  const select = (nome, rotulo, valores, rotulos = {}) => h`<label>${rotulo}
  <select name="${nome}"><option value="">Todos</option>${valores.map((v) => h`<option value="${v}" ${f[nome] === v ? raw('selected') : ''}>${rotulos[v] || v}</option>`)}</select></label>`;
  return h`<form class="filtros" method="get" action="${acao}">
  ${comDia && h`<label>Dia <input type="date" name="data" value="${f.data || ''}"></label>`}
  ${select('estado', 'Estado', Object.keys(ESTADOS), ESTADOS)}
  ${select('gravidade', 'Gravidade', Object.keys(GRAVIDADES), GRAVIDADES)}
  ${select('tipo', 'Tipo', opcoes.tipos, TIPOS)}
  ${select('utilizador', 'Utilizador', opcoes.utilizadores)}
  ${select('caixa', 'Caixa', opcoes.caixas)}
  <button>Filtrar</button> <a href="${acao}">Limpar</a>
</form>`;
}

export function fechoPage(user, d) {
  const { fecho, totais, meios, porUtilizador, incs, filtros, opcoes, taloes, contagem, reservas } = d;
  const dif = totais.faturas - totais.diario;
  return pagina(user, `Fecho de ${dataPT(fecho.data)}`, h`
<div class="cabecalho">
  <div><h1>Fecho de ${dataPT(fecho.data)}</h1><p class="suave">${diaSemana(fecho.data)}</p></div>
  <div class="acoes">
    <form method="post" action="/fechos/${fecho.data}/reconciliar"><button>Cruzar de novo</button></form>
    <a class="botao" href="/fechos/carregar">Substituir ficheiros</a>
  </div>
</div>
<ul class="ficheiros">${[
    ['Diário de caixa', fecho.diario_ficheiro, fecho.diario_em],
    ['Faturas do dia', fecho.faturas_ficheiro, fecho.faturas_em],
    ['Lista de saídas', fecho.saidas_lista, fecho.saidas_lista_em],
    ['Faturas das saídas', fecho.saidas_faturas, fecho.saidas_faturas_em],
    ['Lista de entradas', fecho.entradas_lista, fecho.entradas_lista_em],
    ['Faturas das entradas', fecho.entradas_faturas, fecho.entradas_faturas_em],
  ].map(([nome, ficheiro, em]) => h`<li>${ficheiro ? etiqueta('ok', nome) : etiqueta('falta', nome)} <span class="suave">${ficheiro ? h`${ficheiro} · ${quandoPT(em)}` : 'por carregar'}</span></li>`)}</ul>

<div class="indicadores">
  <div><span>Total do diário</span><strong>${euros(totais.diario)}</strong></div>
  <div><span>Total das faturas</span><strong>${fecho.faturas_ficheiro ? euros(totais.faturas) : '—'}</strong></div>
  <div class="${fecho.faturas_ficheiro && Math.abs(dif) > 0.004 ? 'alerta' : ''}"><span>Diferença</span><strong>${fecho.faturas_ficheiro ? euros(dif) : '—'}</strong></div>
  <div><span>Cartão no diário</span><strong>${euros(totais.cartao)}</strong></div>
  <div class="${Math.abs(totais.cartao - totais.taloes) > 0.004 ? 'alerta' : ''}"><span>Talões de compra</span><strong>${euros(totais.taloes)}</strong></div>
  <div class="${contagem.pendente ? 'alerta' : ''}"><span>Pendentes</span><strong>${contagem.pendente || 0}</strong></div>
</div>

<div class="colunas">
<section>
  <h2>Por meio de pagamento</h2>
  <div class="tabela-wrap"><table>
  <thead><tr><th>Meio</th><th class="num">Diário</th><th class="num">Faturas</th><th class="num">Diferença</th></tr></thead>
  <tbody>${meios.map((m) => h`<tr class="${Math.abs(m.faturas - m.diario) > 0.004 && fecho.faturas_ficheiro ? 'destaque' : ''}">
    <td>${m.tipo} ${m.tpa ? etiqueta('suave', 'TPA') : ''}</td><td class="num">${euros(m.diario)}</td>
    <td class="num">${fecho.faturas_ficheiro ? euros(m.faturas) : '—'}</td><td class="num">${fecho.faturas_ficheiro ? euros(m.faturas - m.diario) : '—'}</td></tr>`)}</tbody>
  </table></div>
</section>
<section>
  <h2>Por utilizador</h2>
  <div class="tabela-wrap"><table>
  <thead><tr><th>Utilizador</th><th>Caixas</th><th class="num">Movimentos</th><th class="num">Total</th><th class="num">Pendentes</th></tr></thead>
  <tbody>${porUtilizador.map((u) => h`<tr>
    <td><a href="/fechos/${fecho.data}?utilizador=${encodeURIComponent(u.utilizador)}#incs">${u.utilizador}</a></td><td>${u.caixas}</td>
    <td class="num">${u.n}</td><td class="num">${euros(u.total)}</td>
    <td class="num">${u.pendentes ? h`<strong class="pendente">${u.pendentes}</strong>` : '0'}</td></tr>`)}</tbody>
  </table></div>
</section>
</div>

${reservas.some((r) => r.reservas) && h`<section>
  <h2>Saídas e entradas <span class="suave">total das reservas contra o que está faturado</span></h2>
  <div class="tabela-wrap"><table>
  <thead><tr><th></th><th class="num">Reservas</th><th class="num">Canceladas / no-show</th><th class="num">Total das reservas</th><th class="num">Faturado</th><th class="num">Sem nenhuma fatura</th></tr></thead>
  <tbody>${reservas.filter((r) => r.reservas).map((r) => h`<tr>
    <td><strong>${r.nome}s</strong></td><td class="num">${r.ativas}</td><td class="num">${r.canceladas}</td>
    <td class="num">${euros(r.total)}</td><td class="num">${euros(r.faturado)}</td><td class="num">${r.semFatura}</td></tr>`)}</tbody>
  </table></div>
</section>`}

<section id="incs">
  <h2>Inconsistências <span class="suave">${contagem.pendente || 0} pendentes · ${contagem.justificada || 0} justificadas · ${contagem.resolvida || 0} resolvidas</span></h2>
  ${filtrosIncs(`/fechos/${fecho.data}`, filtros, opcoes, false)}
  ${tabelaIncs(incs, false)}
</section>

<section>
  <h2>Talões do dia <span class="suave">${taloes.length}</span></h2>
  ${tabelaTaloes(taloes, false)}
</section>`, 'fechos');
}

// ---------- Diários (resumo geral) ----------
const mesPT = (ym) => new Date(ym + '-15T12:00:00Z').toLocaleDateString('pt-PT', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const COLUNAS_DIARIOS = ['Data', 'Reserva', 'Unidade', 'Quarto', 'Hóspede', 'Check-in', 'Check-out', 'Documento', 'Valor', 'Meio'];

export function diariosPage(user, d, query) {
  const { filtros, linhas, opcoes, resumo } = d;
  const select = (nome, rotulo, valores, texto = (x) => x) => h`<label>${rotulo}
  <select name="${nome}"><option value="">Todos</option>${valores.map((x) => h`<option value="${x}" ${filtros[nome] === x ? raw('selected') : ''}>${texto(x)}</option>`)}</select></label>`;
  return pagina(user, 'Diários', h`
<div class="cabecalho">
  <div><h1>Diários</h1><p class="suave">Resumo geral das faturas e notas de crédito de todos os dias carregados, pela data do documento.</p></div>
  <a class="botao" href="/diarios.xls${query ? '?' + query : ''}">Descarregar para Excel</a>
</div>
<form class="filtros" method="get" action="/diarios">
  ${select('mes', 'Mês', opcoes.meses, mesPT)}
  ${select('serie', 'Série', opcoes.series)}
  ${select('meio', 'Meio de pagamento', opcoes.meios)}
  <button>Filtrar</button> <a href="/diarios">Limpar</a>
</form>
<div class="indicadores">
  <div><span>Dias</span><strong>${resumo.dias}</strong></div>
  <div><span>Documentos</span><strong>${resumo.documentos}</strong></div>
  <div><span>Total</span><strong>${euros(resumo.total)}</strong></div>
  <div><span>Notas de crédito</span><strong>${resumo.notas}</strong></div>
  <div><span>Valor das notas de crédito</span><strong>${euros(resumo.totalNotas)}</strong></div>
</div>
${resumo.porDia.length > 1 && h`<div class="tabela-wrap estreita"><table>
<thead><tr><th>Dia</th><th class="num">Linhas</th><th class="num">Reservas</th><th class="num">Total</th></tr></thead>
<tbody>${resumo.porDia.map((p, i) => h`<tr><td class="dia-${i % 3}"><a href="/fechos/${p.data}">${dataPT(p.data)}</a></td><td class="num">${p.linhas}</td><td class="num">${p.reservas}</td><td class="num">${euros(p.total)}</td></tr>`)}</tbody>
</table></div>`}
<p class="suave legenda"><span class="amostra nc"></span> Reserva com nota de crédito no mesmo dia (fatura anulada ou reemitida)</p>
${linhas.length === 0 ? h`<p class="vazio">Sem faturas com estes filtros. Carregue o relatório de faturas de um dia em Fechos.</p>` : h`
<div class="tabela-wrap"><table class="diarios">
<thead><tr>${COLUNAS_DIARIOS.map((c) => h`<th class="${c === 'Valor' ? 'num' : ''}">${c}</th>`)}</tr></thead>
<tbody>${linhas.map((l) => h`<tr class="${l.comNC ? 'nc' : ''}">
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
</tr>`)}</tbody></table></div>`}`, 'diarios');
}

// O mesmo quadro como ficheiro que o Excel abre: uma tabela HTML com as cores no próprio ficheiro.
export function diariosExcel({ linhas }) {
  const CORES = ['#ffffff', '#ffc000', '#5b9bd5'];
  const ROSA = '#e59adf';
  const borda = 'border:0.5pt solid #000;font-family:Calibri;font-size:11pt;';
  const celula = (valor, fundo, extra = '', attrs = '') => h`<td ${raw(attrs)} style="${borda}background:${fundo};${extra}">${valor}</td>`;
  return h`<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body>
<table>
<tr>${COLUNAS_DIARIOS.map((c) => h`<th style="${borda}background:#d9d9d9;">${c}</th>`)}</tr>
${linhas.map((l) => {
    const dia = CORES[l.grupo % 3];
    const linha = l.comNC ? ROSA : '#ffffff';
    const valor = l.comNC ? ROSA : dia;
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
<tbody>${linhas.map((l) => h`<tr>${colunas.map((c) => h`<td class="${dinheiro(c) ? 'num' : ''}">${celula(c, l[c])}</td>`)}</tr>`)}</tbody></table></div>`;
  });
}

export function incPage(user, inc, historico, podeMudar, envios, erro) {
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

<section class="cartao">
  <h2>Notas e estado</h2>
  ${historico.length === 0 && h`<p class="vazio">Ainda sem notas.</p>`}
  <ol class="historico">${historico.map((x) => h`<li class="${x.kind}">
    <span class="suave">${quandoPT(x.quando)} · ${x.autor}</span>
    ${x.kind === 'nota' ? h`<p>${x.texto}</p>` : h`<p>Estado alterado de <strong>${ESTADOS[x.estado_de]}</strong> para <strong>${ESTADOS[x.estado_para]}</strong></p>`}
  </li>`)}</ol>
  ${aviso(erro)}
  <form method="post" action="/inconsistencias/${inc.id}/nota">
    <label>Nova nota <textarea name="texto" rows="3" required placeholder="O que foi verificado e o que se concluiu"></textarea></label>
    <button class="primario">Guardar nota</button>
  </form>
  <form method="post" action="/inconsistencias/${inc.id}/estado" class="estados">
    <span>Alterar estado:</span>
    ${Object.keys(ESTADOS).filter((e) => e !== inc.estado).map((e) => h`<button name="estado" value="${e}" ${podeMudar ? '' : raw('disabled')}>${ESTADOS[e]}</button>`)}
    ${!podeMudar && h`<span class="suave">Guarde primeiro uma nota a explicar a situação.</span>`}
  </form>
</section>`, 'incs');
}

// ---------- Talões ----------
function tabelaTaloes(taloes, mostrarDia) {
  if (!taloes.length) return h`<p class="vazio">Sem talões.</p>`;
  return h`<div class="tabela-wrap"><table>
<thead><tr>${mostrarDia && h`<th>Dia</th>`}<th>Hora</th><th>Tipo</th><th>TPA</th><th class="num">Valor</th><th>Cartão</th><th>Reserva</th><th>Documento</th><th>Enviado por</th><th></th></tr></thead>
<tbody>${taloes.map((t) => h`<tr>
  ${mostrarDia && h`<td>${t.data ? h`<a href="/fechos/${t.data}">${dataPT(t.data)}</a>` : ''}</td>`}
  <td>${t.hora}</td>
  <td>${t.tipo === 'fecho' ? 'Fecho' : 'Compra'}${t.estado === 'rascunho' ? h` ${etiqueta('falta', 'Por confirmar')}` : ''}</td>
  <td>${t.tpa}</td>
  <td class="num">${euros(t.valor)}</td>
  <td>${t.cartao} ${t.ultimos4 && `****${t.ultimos4}`}</td>
  <td>${t.reservas}${t.reserva_origem === 'manual' ? h` <span class="suave" title="Introduzida à mão">✎</span>` : ''}</td>
  <td>${t.doc_associado}</td>
  <td>${t.enviado_por}</td>
  <td><a href="/envios/${t.envio_id}">Ver</a></td>
</tr>`)}</tbody></table></div>`;
}

export function taloesPage(user, taloes, filtros) {
  return pagina(user, 'Talões', h`
<div class="cabecalho"><h1>Talões</h1><a class="botao primario" href="/taloes/novo">Enviar talão</a></div>
<form class="filtros" method="get" action="/taloes">
  <label>Dia <input type="date" name="data" value="${filtros.data || ''}"></label>
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
      ${t.duvidoso && h`<small class="pendente">Leitura com dúvidas: confirme pelo talão.</small>`}</label>
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
<thead><tr><th>Enviado em</th><th>Estado</th><th>Talões</th><th class="num">Valor</th><th>Reserva</th><th></th></tr></thead>
<tbody>${envios.map((e) => h`<tr>
  <td>${quandoPT(e.criado_em)}</td>
  <td>${e.estado === 'confirmado' ? etiqueta('ok', 'Confirmado') : etiqueta('falta', 'Por confirmar')}</td>
  <td>${e.n}</td><td class="num">${euros(e.total)}</td><td>${e.reservas}</td>
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
