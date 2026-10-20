import './src/env.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import * as auth from './src/auth.js';
import { all, get, run, inserir, tx, agora, config, guardarConfig, medirPedido, medicaoAtual, DATA_DIR, DESTINO, SEM_ESTADO, UPLOAD_DIR } from './src/db.js';
import { ErroFicheiro } from './src/parsers.js';
import { importar } from './src/fechos.js';
import { reconciliar, reconciliarTudo, resumoReservas, calcularReservas, PRAZO_OMISSAO, SEM_AGENCIA } from './src/reconcile.js';
import { lerTaloes, ErroLeitura, MIMES_IMAGEM } from './src/leitor.js';
import { cifrarTexto, cifrarBytes, cifraAtiva } from './src/cifra.js';
import { DENOMINACOES, MAX_QUANTIDADE, MEIO_NUMERARIO, totalContado } from './src/numerario.js';
import { analisarMeios } from './src/meios.js';
import { lerExtrato, ErroExtrato, centimos } from './src/extratos.js';
import { comprovativosAteDia, liquidacoesAteDia, usoDasLinhas, guardarExtrato, MEIOS_BANCARIOS } from './src/comprovativos.js';
import { mapaValidacoes, validacaoDoDia, definirValidacao } from './src/validacao.js';
import * as v from './src/views.js';

const app = express();
app.disable('x-powered-by');
// Atrás de um proxy (Vercel, ou TRUST_PROXY=1), o endereço do cliente e o https vêm nos cabeçalhos: sem isto o cookie
// de sessão não ficaria "Secure" e o limite de tentativas de login veria sempre o mesmo endereço.
if (SEM_ESTADO || process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; object-src 'self'; frame-ancestors 'self'",
  });
  next();
});
// DEBUG_SQL=1: regista, por pedido, quantas consultas à base de dados foram feitas e quanto tempo se esperou por elas.
if (process.env.DEBUG_SQL) {
  app.use((req, res, next) => {
    const inicio = performance.now();
    medirPedido(() => {
      res.on('finish', () => {
        const m = medicaoAtual();
        if (m.consultas) console.log(`${req.method} ${req.originalUrl.split('?')[0]} → ${m.consultas} consultas, ${m.ms.toFixed(0)} ms na base de dados, ${(performance.now() - inicio).toFixed(0)} ms no total`);
      });
      next();
    });
  });
}
app.use(express.static(path.join(import.meta.dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(auth.carregarUtilizador);

const { exigirLogin, exigirAuditor } = auth;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_USERNAME = /^[a-zA-Z0-9._-]{3,40}$/;
const lista = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const haUtilizadores = async () => (await get('SELECT COUNT(*) AS n FROM users')).n > 0;

// ---------- Entrada ----------
app.get('/', exigirLogin, (req, res) => res.redirect(req.user.role === 'auditor' ? '/fechos' : '/taloes/novo'));

app.get('/setup', async (req, res) => (await haUtilizadores() ? res.redirect('/login') : res.send(v.setupPage())));
app.post('/setup', async (req, res) => {
  if (await haUtilizadores()) return res.redirect('/login');
  const { nome = '', username = '', password = '' } = req.body || {};
  const erro = validarUtilizador(nome, username, password);
  if (erro) return res.status(400).send(v.setupPage(erro, { nome, username }));
  const id = await inserir('INSERT INTO users (username, nome, pass_hash, role, criado_em) VALUES (?, ?, ?, ?, ?)', username, nome.trim(), auth.hashPassword(password), 'auditor', agora());
  await auth.iniciarSessao(req, res, id);
  res.redirect('/');
});

function validarUtilizador(nome, username, password) {
  if (!nome.trim()) return 'Indique o nome.';
  if (!RE_USERNAME.test(username)) return 'O utilizador deve ter 3 a 40 caracteres: letras, números, ponto, hífen ou sublinhado.';
  if (password.length < 8) return 'A palavra-passe deve ter pelo menos 8 caracteres.';
  return null;
}

app.get('/login', async (req, res) => {
  if (!await haUtilizadores()) return res.redirect('/setup');
  if (req.user) return res.redirect('/');
  res.send(v.loginPage());
});
app.post('/login', async (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const chave = `${username.toLowerCase()}|${req.ip}`;
  if (await auth.loginBloqueado(chave)) return res.status(429).send(v.loginPage('Demasiadas tentativas. Aguarde 5 minutos.'));
  const u = await get('SELECT * FROM users WHERE lower(username) = lower(?) AND ativo = 1', username);
  if (!u || !auth.verificarPassword(password, u.pass_hash)) {
    await auth.registarFalha(chave);
    return res.status(401).send(v.loginPage('Utilizador ou palavra-passe incorretos.'));
  }
  await auth.limparFalhas(chave);
  await auth.iniciarSessao(req, res, u.id);
  res.redirect('/');
});
app.post('/logout', async (req, res) => {
  await auth.terminarSessao(req, res);
  res.redirect('/login');
});

app.get('/conta', exigirLogin, (req, res) => res.send(v.contaPage(req.user, req.query.ok && 'Palavra-passe alterada.')));
app.post('/conta/password', exigirLogin, async (req, res) => {
  const { atual = '', nova = '' } = req.body || {};
  const u = await get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!auth.verificarPassword(atual, u.pass_hash)) return res.status(400).send(v.contaPage(req.user, null, 'A palavra-passe atual não está correta.'));
  if (nova.length < 8) return res.status(400).send(v.contaPage(req.user, null, 'A nova palavra-passe deve ter pelo menos 8 caracteres.'));
  await run('UPDATE users SET pass_hash = ? WHERE id = ?', auth.hashPassword(nova), u.id);
  res.redirect('/conta?ok=1');
});

// ---------- Fechos (auditor) ----------
// Aviso mostrado antes de apagar um fecho: diz o que se perde (e o que fica).
async function textoApagarFecho(data) {
  const notas = (await get('SELECT COUNT(*) AS n FROM historico h JOIN inconsistencias i ON i.id = h.inconsistencia_id WHERE i.data = ? AND h.kind = ?', data, 'nota')).n;
  const dia = data.split('-').reverse().join('/');
  return `Apagar o fecho de ${dia}? Apaga o diário, as faturas, as listas de saídas e entradas, a contagem de numerário, as validações e as inconsistências deste dia${notas ? `, incluindo ${notas} nota(s) escrita(s) pelo auditor` : ''}. Os talões enviados pela receção ficam guardados. Não é possível desfazer.`;
}

app.get('/fechos', exigirAuditor, async (req, res) => {
  const fechos = await all(`
    SELECT f.*,
      (SELECT COUNT(*) FROM taloes t JOIN envios e ON e.id = t.envio_id WHERE t.data = f.data) AS taloes,
      (SELECT COUNT(*) FROM inconsistencias i WHERE i.data = f.data AND i.ativa = 1 AND i.estado = 'pendente') AS pendentes,
      (SELECT COUNT(*) FROM inconsistencias i WHERE i.data = f.data AND i.estado = 'justificada') AS justificadas,
      (SELECT COUNT(*) FROM inconsistencias i WHERE i.data = f.data AND i.estado = 'resolvida') AS resolvidas
    FROM fechos f ORDER BY f.data ASC`); // do dia 1 para o dia 30/31: o dia mais antigo em cima
  // Valores por meio e validação do auditor (a mesma que aparece na página de cada fecho).
  const validacoes = await mapaValidacoes();
  for (const f of fechos) {
    f.validacao = await validacaoDoDia(f.data, validacoes);
    f.apagarTexto = await textoApagarFecho(f.data);
    f.total = ((await get('SELECT SUM(valor) AS v FROM movimentos WHERE data = ?', f.data)).v) ?? 0;
  }
  // Filtros: período, pendentes, ficheiros carregados e talões.
  const texto = (k, validos) => (typeof req.query[k] === 'string' && validos.includes(req.query[k]) ? req.query[k] : '');
  const filtros = { ...lerPeriodo(req.query), pendentes: texto('pendentes', ['com', 'sem']), ficheiros: texto('ficheiros', ['completos', 'incompletos']), taloes: texto('taloes', ['com', 'sem']) };
  const completo = (f) => Boolean(f.diario_ficheiro && f.faturas_ficheiro);
  const filtrados = fechos.filter((f) =>
    (!filtros.de || (f.data >= filtros.de && f.data <= filtros.ate)) &&
    (!filtros.pendentes || (filtros.pendentes === 'com') === f.pendentes > 0) &&
    (!filtros.ficheiros || (filtros.ficheiros === 'completos') === completo(f)) &&
    (!filtros.taloes || (filtros.taloes === 'com') === f.taloes > 0));
  res.send(v.fechosPage(req.user, filtrados, filtros, fechos.map((f) => f.data), fechos.length, new URLSearchParams(req.query).toString()));
});

// Apaga um fecho e tudo o que é só desse dia, de uma vez. Os talões (envios da receção) ficam, mas deixam de ter documento associado.
app.post('/fechos/:data/apagar', exigirAuditor, async (req, res) => {
  const { data } = req.params;
  if (!RE_DATA.test(data) || !await get('SELECT 1 AS x FROM fechos WHERE data = ?', data)) return res.redirect('/fechos');
  await tx(async () => {
    await run('DELETE FROM inconsistencias WHERE data = ?', data); // as notas e mudanças de estado saem em cascata
    for (const tabela of ['fecho_validacoes', 'resumo_diario', 'movimentos', 'faturas', 'reservas', 'faturas_reserva', 'contagens_numerario', 'extrato_associacoes']) {
      await run(`DELETE FROM ${tabela} WHERE data = ?`, data);
    }
    await run('UPDATE taloes SET doc_associado = NULL WHERE data = ?', data);
    await run('DELETE FROM fechos WHERE data = ?', data);
  });
  const q = /^[\w=&%.+-]*$/.test(String(req.body?.q || '')) ? String(req.body.q) : '';
  res.redirect(req.body?.origem === 'dia' ? '/fechos' : `/fechos${q ? '?' + q : ''}`);
});

// O auditor dá um valor (CASH, TPA...) como correto, ou retira a validação. Vale em toda a aplicação:
// a lista de fechos e a página do fecho leem a mesma validação. Volta à página de onde veio, no mesmo separador.
app.post('/fechos/:data/validar', exigirAuditor, async (req, res) => {
  const { data } = req.params;
  const texto = (k, re) => (re.test(String(req.body?.[k] || '')) ? String(req.body[k]) : '');
  if (!RE_DATA.test(data) || !await get('SELECT 1 AS x FROM fechos WHERE data = ?', data)) return res.redirect('/fechos');
  await definirValidacao(data, String(req.body?.meio || ''), Boolean(req.body?.validado), req.user.id);
  const hash = texto('hash', /^#[\w:-]*$/);
  if (req.body?.origem === 'dia') return res.redirect(`/fechos/${data}${hash}`);
  const q = texto('q', /^[\w=&%.+-]*$/);
  res.redirect(`/fechos${q ? '?' + q : ''}`);
});

// Tamanho máximo de cada ficheiro carregado. Na Vercel um pedido não pode passar de 4,5 MB.
const MAX_FICHEIRO = (SEM_ESTADO ? 4 : 15) * 1024 * 1024;
const TEXTO_MAX = `${SEM_ESTADO ? 4 : 15} MB`;
const memoria = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FICHEIRO } });
const ficheirosPMS = memoria.array('ficheiros', 12);

app.get('/fechos/carregar', exigirAuditor, (req, res) => res.send(v.carregarPage(req.user)));
app.post('/fechos/carregar', exigirAuditor, (req, res, next) => {
  ficheirosPMS(req, res, async (erroUpload) => {
    if (erroUpload) return res.status(400).send(v.carregarPage(req.user, `Não foi possível receber os ficheiros (máximo ${TEXTO_MAX} cada, até 12 ficheiros).`));
    try {
      // O nome do ficheiro chega em latin1 no multipart; converte-se para mostrar bem os acentos.
      const ficheiros = (req.files || []).map((f) => ({ nome: Buffer.from(f.originalname, 'latin1').toString('utf8'), buffer: f.buffer }));
      const { data } = await importar(ficheiros, req.user.id);
      res.redirect(`/fechos/${data}`);
    } catch (erro) {
      if (erro instanceof ErroFicheiro) return res.status(400).send(v.carregarPage(req.user, erro.message));
      next(erro);
    }
  });
});

// Período pedido na ligação (?de=AAAA-MM-DD&ate=AAAA-MM-DD). Aceita só uma das pontas, corrige a ordem e,
// por compatibilidade com ligações antigas, trata ?data= como um único dia.
function lerPeriodo(query) {
  const dia = (k) => (typeof query[k] === 'string' && RE_DATA.test(query[k]) ? query[k] : '');
  let de = dia('de') || (dia('ate') ? '' : dia('data'));
  let ate = dia('ate') || (dia('de') ? '' : dia('data'));
  if (de && !ate) ate = de;
  if (ate && !de) de = ate;
  if (de > ate) [de, ate] = [ate, de];
  return { de, ate };
}

const CAMPOS_FILTRO = ['data', 'estado', 'gravidade', 'tipo', 'utilizador', 'caixa'];
function lerFiltros(query, fixos = {}) {
  const f = { ...fixos };
  for (const k of CAMPOS_FILTRO) if (typeof query[k] === 'string' && query[k] && !(k in fixos)) f[k] = query[k];
  return f;
}
async function listarIncs(f) {
  const cond = ['1 = 1'];
  const ps = [];
  if (f.de) {
    cond.push('i.data >= ? AND i.data <= ?');
    ps.push(f.de, f.ate);
  }
  for (const k of CAMPOS_FILTRO) {
    if (f[k]) {
      cond.push(`i.${k} = ?`);
      ps.push(f[k]);
    }
  }
  return await all(
    `SELECT i.*, (SELECT COUNT(*) FROM historico h WHERE h.inconsistencia_id = i.id AND h.kind = 'nota') AS notas
     FROM inconsistencias i WHERE ${cond.join(' AND ')}
     ORDER BY i.data DESC, CASE i.gravidade WHEN 'erro' THEN 0 WHEN 'aviso' THEN 1 ELSE 2 END, i.tipo, i.id LIMIT 2000`,
    ...ps,
  );
}
async function opcoesFiltro(data) {
  const onde = data ? 'WHERE data = ?' : '';
  const ps = data ? [data] : [];
  const distintos = async (col) => (await all(`SELECT DISTINCT ${col} AS x FROM inconsistencias ${onde} ORDER BY 1`, ...ps)).map((r) => r.x).filter(Boolean);
  return { tipos: await distintos('tipo'), utilizadores: await distintos('utilizador'), caixas: await distintos('caixa'), dias: await distintos('data') };
}

const SQL_TALOES = `
  SELECT t.*, e.estado, u.nome AS enviado_por FROM taloes t
  JOIN envios e ON e.id = t.envio_id JOIN users u ON u.id = e.user_id`;

// Terminais (TPA) com as caixas a que pertencem, em duas consultas (não uma por terminal).
async function carregarTerminais() {
  const [tpas, ligacoes] = await Promise.all([all('SELECT id, numero, nome FROM tpas ORDER BY numero'), all('SELECT tpa_id, caixa FROM tpa_caixas ORDER BY caixa')]);
  const porTpa = new Map();
  for (const l of ligacoes) porTpa.set(l.tpa_id, [...(porTpa.get(l.tpa_id) || []), l.caixa]);
  return tpas.map((t) => ({ ...t, caixas: porTpa.get(t.id) || [] }));
}

app.get('/fechos/:data', exigirAuditor, async (req, res, next) => {
  const { data } = req.params;
  const fecho = RE_DATA.test(data) && await get('SELECT * FROM fechos WHERE data = ?', data);
  if (!fecho) return next();
  // As consultas independentes correm em paralelo: com a base de dados no Supabase cada uma custa uma viagem pela rede.
  const SQL_TALOES_DIA = `SELECT t.id, t.envio_id, t.valor, t.doc_associado, t.hora, t.tpa, t.cartao, t.ultimos4, t.reservas
    FROM taloes t JOIN envios e ON e.id = t.envio_id WHERE t.data = ? AND t.tipo = ? ORDER BY t.hora, t.id`;
  const [
    totais, meios, porUtilizador, valoresPorUtilizador, contagemLinhas, alojamentos, alojamentosPendentes, quantidadesLinhas, esperadoNumerario,
    terminais, movimentosDia, faturasDia, taloesCompra, fechos, movimentosCartao, caixasLista, taloesDoDia,
    bancario, liquidacoes, validacao, apagarTexto, reservas, incs, opcoes,
  ] = await Promise.all([
    get(
      `SELECT
        (SELECT COALESCE(SUM(valor), 0) FROM movimentos WHERE data = ?) AS diario,
        (SELECT COALESCE(SUM(valor), 0) FROM faturas WHERE data = ?) AS faturas,
        (SELECT COALESCE(SUM(valor), 0) FROM movimentos WHERE data = ? AND tipo IN (SELECT codigo FROM meios WHERE tpa = 1)) AS cartao,
        (SELECT COALESCE(SUM(t.valor), 0) FROM taloes t JOIN envios e ON e.id = t.envio_id
          WHERE t.data = ? AND t.tipo = 'compra') AS taloes`,
      data, data, data, data,
    ),
    all(
      `SELECT x.tipo, COALESCE(m.tpa, 0) AS tpa,
        (SELECT COALESCE(SUM(valor), 0) FROM movimentos WHERE data = ? AND tipo = x.tipo) AS diario,
        (SELECT COUNT(*) FROM movimentos WHERE data = ? AND tipo = x.tipo) AS movimentos,
        (SELECT COALESCE(SUM(valor), 0) FROM faturas WHERE data = ? AND tipo = x.tipo) AS faturas
       FROM (SELECT tipo FROM movimentos WHERE data = ? UNION SELECT tipo FROM faturas WHERE data = ?) x
       LEFT JOIN meios m ON m.codigo = x.tipo ORDER BY x.tipo`,
      data, data, data, data, data,
    ),
    all(
      `SELECT m.utilizador, COUNT(*) AS n, SUM(m.valor) AS total, REPLACE(STRING_AGG(DISTINCT m.caixa, ',' ORDER BY m.caixa), ',', ', ') AS caixas,
        (SELECT COUNT(*) FROM inconsistencias i WHERE i.data = m.data AND i.utilizador = m.utilizador AND i.estado = 'pendente' AND i.ativa = 1) AS pendentes
       FROM movimentos m WHERE m.data = ? GROUP BY m.data, m.utilizador ORDER BY m.utilizador`,
      data,
    ),
    all('SELECT utilizador, tipo, SUM(valor) AS v FROM movimentos WHERE data = ? GROUP BY utilizador, tipo', data),
    all(`SELECT estado, COUNT(*) AS n FROM inconsistencias WHERE data = ? AND (ativa = 1 OR estado <> 'pendente') GROUP BY estado`, data),
    all('SELECT caixa, tipo, COUNT(*) AS n, SUM(valor) AS v FROM movimentos WHERE data = ? GROUP BY caixa, tipo', data),
    all(`SELECT caixa, COUNT(*) AS n FROM inconsistencias WHERE data = ? AND estado = 'pendente' AND ativa = 1 GROUP BY caixa`, data),
    all('SELECT valor, quantidade FROM contagens_numerario WHERE data = ?', data),
    get('SELECT COALESCE(SUM(valor), 0) AS v FROM movimentos WHERE data = ? AND tipo = ?', data, MEIO_NUMERARIO),
    // Terminais (nº do TPA) e as caixas a que pertencem; os que partilham caixas formam um grupo, como no cruzamento.
    carregarTerminais(),
    all('SELECT doc, hora, quarto, nome, valor, tipo, caixa, utilizador FROM movimentos WHERE data = ? ORDER BY hora, id', data),
    all('SELECT doc, tipo, valor, reserva, hospede, quarto FROM faturas WHERE data = ? ORDER BY id', data),
    all(SQL_TALOES_DIA, data, 'compra'),
    all(SQL_TALOES_DIA, data, 'fecho'),
    all('SELECT caixa, tipo, valor FROM movimentos WHERE data = ?', data),
    all('SELECT codigo FROM caixas ORDER BY lower(codigo)'),
    all(`${SQL_TALOES} WHERE t.data = ? ORDER BY t.hora, t.id`, data),
    comprovativosAteDia(data),
    liquidacoesAteDia(data),
    validacaoDoDia(data),
    textoApagarFecho(data),
    resumoReservas(data),
    listarIncs(lerFiltros(req.query, { data })),
    opcoesFiltro(data),
  ]);

  const valoresUtilizador = new Map();
  for (const r of valoresPorUtilizador) {
    if (!valoresUtilizador.has(r.utilizador)) valoresUtilizador.set(r.utilizador, {});
    valoresUtilizador.get(r.utilizador)[r.tipo] = r.v;
  }
  for (const u of porUtilizador) u.porMeio = valoresUtilizador.get(u.utilizador) || {};
  const contagem = Object.fromEntries(contagemLinhas.map((r) => [r.estado, r.n]));
  // Por alojamento (unidade/caixa): movimentos e valor por meio de pagamento, mais as inconsistências pendentes.
  const aloj = new Map();
  const doAloj = (caixa) => {
    if (!aloj.has(caixa)) aloj.set(caixa, { caixa, n: 0, total: 0, porMeio: {}, pendentes: 0 });
    return aloj.get(caixa);
  };
  for (const r of alojamentos) {
    const a = doAloj(r.caixa || '');
    a.n += r.n;
    a.total += r.v;
    a.porMeio[r.tipo] = (a.porMeio[r.tipo] || 0) + r.v;
  }
  let pendentesSemAlojamento = 0;
  for (const r of alojamentosPendentes) {
    if (r.caixa) doAloj(r.caixa).pendentes += r.n;
    else pendentesSemAlojamento += r.n;
  }
  const porAlojamento = [...aloj.values()].sort((x, y) => x.caixa.localeCompare(y.caixa, 'pt', { sensitivity: 'base' }));

  const quantidades = Object.fromEntries(quantidadesLinhas.map((c) => [c.valor, c.quantidade]));
  const numerario = {
    quantidades,
    existe: Boolean(fecho.contagem_em),
    em: fecho.contagem_em,
    contado: totalContado(quantidades),
    esperado: Math.round(esperadoNumerario.v * 100),
    temDiario: Boolean(fecho.diario_ficheiro),
    abrir: req.query.contagem === '1',
  };
  // Análise por meio de pagamento: diário contra faturas e, nos meios TPA, contra os talões enviados.
  const terminaisPorNumero = new Map(terminais.map((t) => [t.numero, t]));
  const analise = analisarMeios({
    meios,
    movimentos: movimentosDia,
    faturas: faturasDia,
    taloes: taloesCompra,
    numerario,
    temFaturas: Boolean(fecho.faturas_ficheiro),
    temDiario: numerario.temDiario,
    terminais: terminaisPorNumero,
    bancario,
  });
  const pai = new Map();
  const raiz = (x) => {
    if (!pai.has(x)) pai.set(x, x);
    while (pai.get(x) !== x) x = pai.get(x);
    return x;
  };
  for (const t of terminais) for (const c of t.caixas) pai.set(raiz(`T:${t.numero}`), raiz(`C:${c}`));
  const meiosTPA = new Set(meios.filter((m) => m.tpa).map((m) => m.tipo));
  const movimentosTPA = movimentosCartao.filter((m) => meiosTPA.has(m.tipo));
  const fechosTPA = fechos.map((f) => {
    const terminal = terminaisPorNumero.get(f.tpa) || null;
    const base = { ...f, terminal, caixas: terminal?.caixas || [], credito: liquidacoes.mapa.get(f.id) || null, temCreditos: liquidacoes.temCreditos };
    if (!base.caixas.length) return base;
    const grupo = raiz(`T:${f.tpa}`);
    const tpasDoGrupo = new Set(terminais.filter((t) => t.caixas.length && raiz(`T:${t.numero}`) === grupo).map((t) => t.numero));
    const caixasDoGrupo = new Set(terminais.filter((t) => tpasDoGrupo.has(t.numero)).flatMap((t) => t.caixas));
    const fecho = fechos.filter((x) => tpasDoGrupo.has(x.tpa)).reduce((s, x) => s + Math.round(x.valor * 100), 0);
    const diario = movimentosTPA.filter((m) => caixasDoGrupo.has(m.caixa)).reduce((s, m) => s + Math.round(m.valor * 100), 0);
    return { ...base, grupo: { terminais: [...tpasDoGrupo], caixas: [...caixasDoGrupo], fecho, diario } };
  });
  const filtros = lerFiltros(req.query, { data });
  res.send(
    v.fechoPage(req.user, {
      fecho, totais, meios, porUtilizador, porAlojamento, pendentesSemAlojamento, analise, bancario, fechosTPA, terminaisPorNumero: Object.fromEntries(terminaisPorNumero),
      caixasLista: caixasLista.map((c) => c.codigo), contagem, filtros, numerario,
      validacao, apagarTexto, reservas, incs, opcoes, taloes: taloesDoDia,
    }),
  );
});

app.post('/fechos/:data/contagem', exigirAuditor, async (req, res, next) => {
  const { data } = req.params;
  if (!RE_DATA.test(data) || !await get('SELECT 1 AS x FROM fechos WHERE data = ?', data)) return next();
  const q = req.body?.q && typeof req.body.q === 'object' ? req.body.q : {};
  const quantidades = {};
  for (const c of DENOMINACOES) {
    const bruto = String(q[c] ?? '').trim();
    if (bruto !== '' && !/^\d{1,5}$/.test(bruto)) {
      return res.status(400).send(v.erroPage(req.user, 'Contagem inválida', `As quantidades têm de ser números inteiros entre 0 e ${MAX_QUANTIDADE}.`));
    }
    quantidades[c] = bruto === '' ? 0 : Number(bruto);
  }
  await tx(async () => {
    await run('DELETE FROM contagens_numerario WHERE data = ?', data);
    for (const c of DENOMINACOES) await run('INSERT INTO contagens_numerario (data, valor, quantidade) VALUES (?, ?, ?)', data, c, quantidades[c]);
    await run('UPDATE fechos SET contagem_por = ?, contagem_em = ? WHERE data = ?', req.user.id, agora(), data);
  });
  await reconciliar(data);
  res.redirect(`/fechos/${data}?contagem=1#numerario`);
});

app.post('/fechos/:data/reconciliar', exigirAuditor, async (req, res, next) => {
  if (!RE_DATA.test(req.params.data)) return next();
  await reconciliar(req.params.data);
  res.redirect(`/fechos/${req.params.data}`);
});

// ---------- Diários: resumo geral das faturas de todos os dias carregados (auditor) ----------
const SEM_CANAL = '__sem__'; // valor do filtro de operador para faturas sem canal conhecido
async function dadosDiarios(query) {
  const texto = (k) => (typeof query[k] === 'string' ? query[k] : '');
  const { de, ate } = lerPeriodo(query);
  const filtros = { de, ate, serie: texto('serie'), unidade: texto('unidade'), meio: texto('meio'), reserva: texto('reserva').trim().slice(0, 40), operador: texto('operador'), caixa: texto('caixa'), faturacao: ['faturadas', 'porfaturar'].includes(texto('faturacao')) ? texto('faturacao') : '' };
  const cond = ['1 = 1'];
  const ps = [];
  if (filtros.de) { cond.push('f.data >= ? AND f.data <= ?'); ps.push(filtros.de, filtros.ate); }
  if (filtros.serie) { cond.push(`substr(f.doc, 1, strpos(f.doc, '/') - 1) = ?`); ps.push(filtros.serie); }
  if (filtros.unidade) { cond.push('f.hotel = ?'); ps.push(filtros.unidade); }
  if (filtros.meio) { cond.push('f.tipo = ?'); ps.push(filtros.meio); }
  if (filtros.reserva) { cond.push(`f.reserva LIKE ? ESCAPE '\\'`); ps.push(`%${filtros.reserva.replace(/[\\%_]/g, '\\$&')}%`); }
  let faturas = await all(
    `SELECT f.*, (SELECT MIN(m.hora) FROM movimentos m WHERE m.data = f.data AND m.doc = f.doc) AS hora
     FROM faturas f WHERE ${cond.join(' AND ')} ORDER BY f.data, f.id`,
    ...ps,
  );

  // Operador = canal de venda da reserva (Booking, Mirai, EC Travel...). Vem da agência das listas de entradas/saídas;
  // sem a reserva carregada, deduz-se do meio de pagamento (TBBOOKING) ou das notas da fatura (Mirai).
  const agenciaDaReserva = new Map();
  for (const r of await all('SELECT reserva, agencia FROM reservas ORDER BY data')) {
    if (r.agencia || !agenciaDaReserva.has(r.reserva)) agenciaDaReserva.set(r.reserva, r.agencia || SEM_AGENCIA);
  }
  const operadorDe = (f) => agenciaDaReserva.get(f.reserva) || (f.tipo === 'TBBOOKING' ? 'Booking' : /mirai/i.test(f.info || '') ? 'Mirai' : '');
  const operadorCombina = (op) => !filtros.operador || (filtros.operador === SEM_CANAL ? !op : op === filtros.operador);
  // Caixa onde a fatura foi paga: a do movimento do diário com o mesmo documento e meio de pagamento.
  const caixaDoDocumento = new Map((await all('SELECT data, doc, tipo, MIN(caixa) AS caixa FROM movimentos GROUP BY data, doc, tipo')).map((m) => [`${m.data}|${m.doc}|${m.tipo}`, m.caixa]));
  const caixaDoDoc = new Map((await all('SELECT data, doc, MIN(caixa) AS caixa FROM movimentos GROUP BY data, doc')).map((m) => [`${m.data}|${m.doc}`, m.caixa]));
  for (const f of faturas) {
    f.operador = operadorDe(f);
    f.caixa = caixaDoDocumento.get(`${f.data}|${f.doc}|${f.tipo}`) || caixaDoDoc.get(`${f.data}|${f.doc}`) || '';
  }
  faturas = filtros.faturacao === 'porfaturar' ? [] : faturas.filter((f) => operadorCombina(f.operador) && (!filtros.caixa || f.caixa === filtros.caixa));

  // Reservas por faturar: estão nas listas de saídas/entradas (ativas e com valor) e não têm nenhuma fatura.
  // Sem fatura não há série, meio de pagamento nem caixa, por isso esses filtros deixam-nas de fora.
  let porFaturar = null;
  if (filtros.faturacao !== 'faturadas' && !filtros.serie && !filtros.meio && !filtros.caixa) {
    porFaturar = [];
    const comFatura = new Set((await all('SELECT reserva AS r FROM faturas UNION SELECT reserva FROM faturas_reserva')).map((x) => x.r));
    const hotelDoQuarto = new Map((await all('SELECT DISTINCT quarto, hotel FROM faturas')).map((x) => [x.quarto, x.hotel]));
    const vistas = new Set();
    for (const { data, lado } of await all('SELECT DISTINCT data, lado FROM reservas ORDER BY data')) {
      if (filtros.de && (data < filtros.de || data > filtros.ate)) continue;
      for (const r of await calcularReservas(data, lado)) {
        if (!r.ativas.length || r.total <= 0 || comFatura.has(r.reserva) || vistas.has(r.reserva)) continue;
        const quarto = r.ativas[0].unidade;
        const hotel = hotelDoQuarto.get(quarto) || '';
        const operador = r.agencia;
        if (filtros.unidade && hotel !== filtros.unidade) continue;
        if (filtros.reserva && !r.reserva.includes(filtros.reserva)) continue;
        if (!operadorCombina(operador)) continue;
        vistas.add(r.reserva);
        porFaturar.push({
          id: 0, data, hotel, reserva: r.reserva, quarto, hospede: r.hospede,
          checkin: r.ativas.map((l) => l.checkin).filter(Boolean).sort()[0] || '', checkout: r.checkout || '',
          doc: 'Por faturar', valor: r.total / 100, tipo: '', operador, porFaturar: true,
        });
      }
    }
  }

  // Dentro de cada dia, as linhas da mesma reserva ficam juntas (fatura, nota de crédito, nova fatura)
  // e as reservas seguem a ordem do primeiro documento; as por faturar vêm no fim do dia.
  const numero = (doc) => Number(/\/(\d+)$/.exec(doc)?.[1] ?? 0);
  const grupos = new Map();
  for (const f of faturas) {
    const chave = `${f.data}|${f.reserva}`;
    if (!grupos.has(chave)) grupos.set(chave, { data: f.data, linhas: [] });
    grupos.get(chave).linhas.push(f);
  }
  const ordenados = [...grupos.values()].map((g) => {
    g.linhas.sort((a, b) => (a.hora || '').localeCompare(b.hora || '') || a.id - b.id);
    const emitidas = g.linhas.filter((l) => !/^NC\b/i.test(l.doc));
    const primeira = (emitidas.length ? emitidas : g.linhas).reduce((m, l) => (numero(l.doc) < numero(m.doc) ? l : m));
    return { ...g, fim: 0, ordem: `${primeira.doc.split('/')[0]}/${String(numero(primeira.doc)).padStart(9, '0')}`, comNC: g.linhas.some((l) => /^NC\b/i.test(l.doc)) };
  });
  for (const p of porFaturar || []) ordenados.push({ data: p.data, linhas: [p], fim: 1, ordem: p.reserva.padStart(12, '0'), comNC: false });
  ordenados.sort((a, b) => a.data.localeCompare(b.data) || a.fim - b.fim || a.ordem.localeCompare(b.ordem));
  const dias = [...new Set(ordenados.map((g) => g.data))];
  const linhas = ordenados.flatMap((g) => g.linhas.map((l) => ({ ...l, comNC: g.comNC, grupo: dias.indexOf(g.data) })));
  const faturadas = linhas.filter((l) => !l.porFaturar);

  // Canais existentes (nas faturas e nas reservas), para o filtro de operador.
  const canais = new Set((await all('SELECT reserva, tipo, info FROM faturas')).map(operadorDe));
  for (const r of agenciaDaReserva.values()) canais.add(r);
  const semCanal = canais.delete('');

  const distintos = async (sql) => (await all(sql)).map((r) => r.x).filter(Boolean);
  return {
    filtros,
    linhas,
    opcoes: {
      dias: await distintos('SELECT DISTINCT data AS x FROM faturas ORDER BY 1'),
      series: await distintos(`SELECT DISTINCT substr(doc, 1, strpos(doc, '/') - 1) AS x FROM faturas ORDER BY 1`),
      unidades: await distintos('SELECT DISTINCT hotel AS x, lower(hotel) AS o FROM faturas ORDER BY o, x'),
      meios: await distintos('SELECT DISTINCT tipo AS x FROM faturas ORDER BY 1'),
      caixas: (await all('SELECT codigo AS x FROM caixas ORDER BY lower(codigo)')).map((c) => c.x),
      operadores: [...[...canais].sort((x, y) => x.localeCompare(y, 'pt', { sensitivity: 'base' })), ...(semCanal ? [SEM_CANAL] : [])],
    },
    resumo: {
      dias: new Set(faturadas.map((l) => l.data)).size,
      documentos: new Set(faturadas.map((l) => l.doc)).size,
      total: faturadas.reduce((s, l) => s + l.valor, 0),
      notas: new Set(faturadas.filter((l) => /^NC\b/i.test(l.doc)).map((l) => l.doc)).size,
      totalNotas: faturadas.filter((l) => /^NC\b/i.test(l.doc)).reduce((s, l) => s + l.valor, 0),
      porFaturar: porFaturar && { reservas: porFaturar.length, total: porFaturar.reduce((t, p) => t + p.valor, 0) },
    },
  };
}

app.get('/diarios', exigirAuditor, async (req, res) => res.send(v.diariosPage(req.user, await dadosDiarios(req.query), new URLSearchParams(req.query).toString())));
app.get('/diarios.xls', exigirAuditor, async (req, res) => {
  const dados = await dadosDiarios(req.query);
  res.set({
    'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
    'Content-Disposition': `attachment; filename="diarios${dados.filtros.de ? '-' + dados.filtros.de + (dados.filtros.ate !== dados.filtros.de ? '_' + dados.filtros.ate : '') : ''}.xls"`,
  });
  res.send('﻿' + v.diariosExcel(dados));
});

// ---------- Inconsistências (auditor) ----------
app.get('/inconsistencias', exigirAuditor, async (req, res) => {
  // Ao entrar sem filtros mostram-se as pendentes; "Todos" no filtro mostra tudo.
  const filtros = lerFiltros(req.query);
  delete filtros.data;
  Object.assign(filtros, lerPeriodo(req.query));
  if (!('estado' in req.query)) filtros.estado = 'pendente';
  res.send(v.incsPage(req.user, await listarIncs(filtros), filtros, await opcoesFiltro(null)));
});

async function mostrarInc(req, res, inc, erro, status = 200, formulario) {
  const historico = await all(
    'SELECT h.*, u.nome AS autor FROM historico h JOIN users u ON u.id = h.user_id WHERE h.inconsistencia_id = ? ORDER BY h.id',
    inc.id,
  );
  const ids = lista(JSON.parse(inc.detalhe_json).taloes).map(Number).filter(Number.isInteger);
  const envios = ids.length
    ? await all(`SELECT DISTINCT e.id, e.mime FROM taloes t JOIN envios e ON e.id = t.envio_id WHERE t.id IN (${ids.map(() => '?').join(',')})`, ...ids)
    : [];
  res.status(status).send(v.incPage(req.user, inc, historico, envios, erro, formulario));
}

app.get('/inconsistencias/:id', exigirAuditor, async (req, res, next) => {
  const inc = await get('SELECT * FROM inconsistencias WHERE id = ?', Number(req.params.id));
  if (!inc) return next();
  await mostrarInc(req, res, inc);
});

// Uma só ação: guarda a nota e, se o auditor escolheu um estado, muda-o na mesma operação (a nota explica a mudança).
app.post('/inconsistencias/:id/nota', exigirAuditor, async (req, res, next) => {
  const inc = await get('SELECT * FROM inconsistencias WHERE id = ?', Number(req.params.id));
  if (!inc) return next();
  const texto = String(req.body?.texto || '').trim();
  const pedido = String(req.body?.estado || '');
  const novo = ['pendente', 'justificada', 'resolvida'].includes(pedido) && pedido !== inc.estado ? pedido : null;
  if (!texto) return await mostrarInc(req, res, inc, 'Escreva a nota antes de guardar.', 400, { texto: '', estado: novo || '' });
  await tx(async () => {
    await run('INSERT INTO historico (inconsistencia_id, user_id, quando, kind, texto) VALUES (?, ?, ?, ?, ?)', inc.id, req.user.id, agora(), 'nota', texto.slice(0, 5000));
    if (novo) {
      await run('UPDATE inconsistencias SET estado = ? WHERE id = ?', novo, inc.id);
      await run(
        'INSERT INTO historico (inconsistencia_id, user_id, quando, kind, estado_de, estado_para) VALUES (?, ?, ?, ?, ?, ?)',
        inc.id, req.user.id, agora(), 'estado', inc.estado, novo,
      );
    }
  });
  res.redirect(`/inconsistencias/${inc.id}#notas`);
});

// ---------- Extratos bancários e relatórios de pagamentos ----------
const nomeUTF8 = (f) => Buffer.from(f.originalname, 'latin1').toString('utf8');

async function listarExtratos() {
  return await all(
    `SELECT e.*, u.nome AS enviado_por, (SELECT COUNT(*) FROM extrato_linhas l WHERE l.extrato_id = e.id) AS n
     FROM extratos e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC`,
  );
}

const ficheirosExtratos = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FICHEIRO, files: 12 } }).array('ficheiros', 12);

app.get('/extratos', exigirAuditor, async (req, res) => res.send(v.extratosPage(req.user, await listarExtratos(), null)));
app.post('/extratos', exigirAuditor, (req, res, next) => {
  ficheirosExtratos(req, res, async (erroUpload) => {
    if (erroUpload) return res.status(400).send(v.extratosPage(req.user, await listarExtratos(), [{ nome: 'Carregamento', erro: `Não foi possível receber os ficheiros (máximo ${TEXTO_MAX} cada, até 12 ficheiros).` }]));
    try {
      const resultados = [];
      for (const f of req.files || []) {
        const nome = nomeUTF8(f);
        try {
          const lido = lerExtrato(f.buffer, String(req.body?.tipo || ''));
          resultados.push({ nome, tipo: lido.tipo, colunas: lido.colunas, debitos: lido.debitos, de: lido.de, ate: lido.ate, total: lido.linhas.length, ...await guardarExtrato(nome, lido, req.user.id) });
        } catch (erro) {
          if (!(erro instanceof ErroExtrato)) throw erro;
          resultados.push({ nome, erro: erro.message });
        }
      }
      if (!resultados.length) resultados.push({ nome: 'Carregamento', erro: 'Escolha pelo menos um ficheiro.' });
      res.status(resultados.every((r) => r.erro) ? 400 : 200).send(v.extratosPage(req.user, await listarExtratos(), resultados));
    } catch (erro) {
      next(erro);
    }
  });
});
app.get('/extratos/:id', exigirAuditor, async (req, res, next) => {
  const extrato = await get('SELECT e.*, u.nome AS enviado_por FROM extratos e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?', Number(req.params.id));
  if (!extrato) return next();
  const linhas = await all('SELECT * FROM extrato_linhas WHERE extrato_id = ? ORDER BY data, n, id LIMIT 5000', extrato.id);
  res.send(v.extratoPage(req.user, extrato, linhas, await usoDasLinhas()));
});
app.post('/extratos/:id/apagar', exigirAuditor, async (req, res, next) => {
  if (!await get('SELECT 1 AS x FROM extratos WHERE id = ?', Number(req.params.id))) return next();
  await run('DELETE FROM extratos WHERE id = ?', Number(req.params.id));
  res.redirect('/extratos');
});

// Associação feita à mão: um movimento do diário e uma linha de extrato com o mesmo valor.
const voltaAoFecho = (req) => {
  const data = String(req.body?.data || '');
  const meio = /^[a-z0-9-]{1,20}$/.test(String(req.body?.meio || '')) ? req.body.meio : 'geral';
  return RE_DATA.test(data) ? `/fechos/${data}#meios:${meio}` : '/extratos';
};
app.post('/extratos/associar', exigirAuditor, async (req, res) => {
  const data = String(req.body?.data || '');
  const cent = Number(req.body?.valor_cent);
  const linha = await get('SELECT * FROM extrato_linhas WHERE id = ?', Number(req.body?.linha_id));
  const doc = String(req.body?.doc || '').slice(0, 60);
  if (RE_DATA.test(data) && doc && Number.isInteger(cent) && linha && centimos(linha.valor) === cent) {
    await run(
      `INSERT INTO extrato_associacoes (data, doc, valor_cent, linha_id, criado_em, user_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(data, doc, valor_cent) DO UPDATE SET linha_id = excluded.linha_id, criado_em = excluded.criado_em, user_id = excluded.user_id`,
      data, doc, cent, linha.id, agora(), req.user.id,
    );
  }
  res.redirect(voltaAoFecho(req));
});
app.post('/extratos/desassociar', exigirAuditor, async (req, res) => {
  await run('DELETE FROM extrato_associacoes WHERE data = ? AND doc = ? AND valor_cent = ?', String(req.body?.data || ''), String(req.body?.doc || ''), Number(req.body?.valor_cent));
  res.redirect(voltaAoFecho(req));
});

// ---------- Talões ----------
const EXTENSAO = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };
// O ficheiro fica em memória e daí vai para a base de dados (sem disco). Na Vercel os pedidos aceitam até 4,5 MB.
const fotos = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FICHEIRO },
  fileFilter: (req, file, cb) => cb(null, file.mimetype in EXTENSAO),
}).single('ficheiro');

app.get('/taloes/novo', exigirLogin, (req, res) => res.send(v.novoTalaoPage(req.user)));

app.post('/taloes/enviar', exigirLogin, (req, res, next) => {
  fotos(req, res, async (erroUpload) => {
    try {
      if (erroUpload) return res.status(400).send(v.novoTalaoPage(req.user, `O ficheiro é demasiado grande (máximo ${TEXTO_MAX}).`));
      const f = req.file;
      if (!f) return res.status(400).send(v.novoTalaoPage(req.user, 'Escolha uma fotografia (JPEG ou PNG) ou um PDF.'));
      const id = await inserir('INSERT INTO envios (user_id, ficheiro, mime, nome_original, criado_em) VALUES (?, ?, ?, ?, ?)', req.user.id, crypto.randomBytes(16).toString('hex') + EXTENSAO[f.mimetype], f.mimetype, f.originalname, agora());
      await run('INSERT INTO envio_ficheiros (envio_id, conteudo) VALUES (?, ?)', id, cifrarBytes(f.buffer));
      try {
        const lidos = await lerTaloes(f.buffer, f.mimetype);
        await tx(async () => {
          await run('UPDATE envios SET leitura_json = ? WHERE id = ?', JSON.stringify(lidos), id);
          for (const t of lidos) {
            await run(
              `INSERT INTO taloes (envio_id, tipo, tpa, data, hora, valor, cartao, ultimos4, reservas, reserva_lida, duvidoso)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              id, t.tipo, t.tpa, t.data, t.hora, t.valor, cifrarTexto(t.cartao), cifrarTexto(t.ultimos4), t.reserva, t.reserva, t.duvidoso ? 1 : 0,
            );
          }
        });
        // O talão lido tenta logo casar com um pagamento do dia (e valida o TPA se o comprovar), sem esperar pela confirmação.
        for (const data of new Set(lidos.map((t) => t.data).filter(Boolean))) await reconciliar(data);
      } catch (erro) {
        if (!(erro instanceof ErroLeitura)) console.error('Erro na leitura do talão:', erro);
        await run('UPDATE envios SET leitura_erro = ? WHERE id = ?', erro instanceof ErroLeitura ? erro.message : 'Erro inesperado na leitura.', id);
      }
      res.redirect(`/envios/${id}`);
    } catch (erro) {
      next(erro);
    }
  });
});

app.get('/taloes/meus', exigirLogin, async (req, res) => {
  const envios = await all(
    `SELECT e.id, e.criado_em, e.estado, COUNT(t.id) AS n, SUM(CASE WHEN t.tipo = 'compra' THEN t.valor END) AS total,
      REPLACE(STRING_AGG(DISTINCT NULLIF(t.reservas, ''), ',' ORDER BY NULLIF(t.reservas, '')), ',', ', ') AS reservas
     FROM envios e LEFT JOIN taloes t ON t.envio_id = e.id WHERE e.user_id = ? GROUP BY e.id ORDER BY e.id DESC LIMIT 200`,
    req.user.id,
  );
  res.send(v.meusEnviosPage(req.user, envios, Boolean(req.query.ok)));
});

app.get('/taloes', exigirAuditor, async (req, res) => {
  const periodo = lerPeriodo(req.query);
  const tipo = ['compra', 'fecho'].includes(req.query.tipo) ? req.query.tipo : '';
  const cond = [];
  const ps = [];
  if (periodo.de) {
    cond.push('t.data >= ? AND t.data <= ?');
    ps.push(periodo.de, periodo.ate);
  }
  if (tipo) {
    cond.push('t.tipo = ?');
    ps.push(tipo);
  }
  const onde = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const taloes = await all(`${SQL_TALOES} ${onde} ORDER BY ${periodo.de ? 't.data, t.hora, t.id' : 'e.id DESC, t.id LIMIT 500'}`, ...ps);
  const dias = (await all('SELECT DISTINCT data AS x FROM taloes WHERE data IS NOT NULL ORDER BY 1')).map((r) => r.x);
  res.send(v.taloesPage(req.user, taloes, { ...periodo, tipo }, dias));
});

// Um rececionista só vê os seus envios e só os altera enquanto não os confirmar; depois disso, só o auditor.
async function carregarEnvio(req, res, next) {
  const envio = await get('SELECT e.*, u.nome AS enviado_por FROM envios e JOIN users u ON u.id = e.user_id WHERE e.id = ?', Number(req.params.id));
  if (!envio) return next('route');
  const auditor = req.user.role === 'auditor';
  if (!auditor && envio.user_id !== req.user.id) return next('route');
  req.envio = envio;
  req.editavel = auditor || envio.estado === 'rascunho';
  next();
}
const taloesDoEnvio = async (id) => await all('SELECT * FROM taloes WHERE envio_id = ? ORDER BY id', id);

app.get('/envios/:id', exigirLogin, carregarEnvio, async (req, res) => {
  res.send(v.envioPage(req.user, req.envio, await taloesDoEnvio(req.envio.id), req.editavel));
});

app.get('/envios/:id/ficheiro', exigirLogin, carregarEnvio, async (req, res, next) => {
  let conteudo = (await get('SELECT conteudo FROM envio_ficheiros WHERE envio_id = ?', req.envio.id))?.conteudo;
  // Envios de antes de os ficheiros irem para a base de dados: ainda podem estar na pasta data/taloes.
  if (!conteudo) {
    const antigo = path.join(UPLOAD_DIR, path.basename(req.envio.ficheiro));
    if (!SEM_ESTADO && fs.existsSync(antigo)) conteudo = fs.readFileSync(antigo);
  }
  if (!conteudo) return next();
  res.set({ 'Content-Type': req.envio.mime, 'Cache-Control': 'private, max-age=3600' }).send(Buffer.from(conteudo));
});

// "116,00", "116.00" e "1.234,56" são todos aceites.
function valorCampo(s) {
  let t = String(s ?? '').replace(/[\s €]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Number(t);
}

function lerFormularioTaloes(body) {
  const erros = [];
  const taloes = [];
  Object.values(body?.t || {}).forEach((e, i) => {
    if (!e || typeof e !== 'object' || e.remover) return;
    const n = taloes.length + 1;
    const tipo = e.tipo === 'fecho' ? 'fecho' : 'compra';
    const tpa = String(e.tpa || '').replace(/\s/g, '');
    const data = RE_DATA.test(e.data || '') ? e.data : null;
    let hora = String(e.hora || '').trim();
    if (/^\d{2}:\d{2}$/.test(hora)) hora += ':00';
    const valor = valorCampo(e.valor);
    const reservas = tipo === 'compra' ? String(e.reservas || '').split(/[^\d]+/).filter(Boolean).join(',') : '';
    const lida = String(e.reserva_lida || '');
    const ultimos4 = String(e.ultimos4 || '').trim();
    if (!/^[A-Za-z0-9]{1,20}$/.test(tpa)) erros.push(`Talão ${n}: indique o número do terminal (TPA).`);
    if (!data) erros.push(`Talão ${n}: indique o dia.`);
    if (hora && !/^\d{2}:\d{2}:\d{2}$/.test(hora)) erros.push(`Talão ${n}: a hora não é válida.`);
    if (valor === null) erros.push(`Talão ${n}: o valor não é válido.`);
    if (ultimos4 && !/^\d{4}$/.test(ultimos4)) erros.push(`Talão ${n}: os últimos 4 dígitos do cartão não são válidos.`);
    taloes.push({
      id: Number(e.id) || null, tipo, tpa, data, hora: hora || null, valor, reservas,
      reserva_lida: lida,
      reserva_origem: !reservas ? '' : lida && reservas === lida ? 'lido' : 'manual',
      cartao: tipo === 'compra' ? String(e.cartao || '').trim().slice(0, 60) || null : null,
      ultimos4: tipo === 'compra' ? ultimos4 || null : null,
    });
  });
  if (!taloes.length) erros.push('Tem de ficar pelo menos um talão. Para descartar a fotografia, apague o envio.');
  return { taloes, erros };
}

app.post('/envios/:id', exigirLogin, carregarEnvio, async (req, res) => {
  const envio = req.envio;
  if (!req.editavel) return res.status(403).send(v.erroPage(req.user, 'Envio já confirmado', 'Só o auditor pode alterar um talão depois de confirmado.'));
  const { taloes, erros } = lerFormularioTaloes(req.body);
  if (erros.length) return res.status(400).send(v.envioPage(req.user, envio, taloes, true, erros));

  const antes = await taloesDoEnvio(envio.id);
  const mantidos = new Set();
  await tx(async () => {
    for (const t of taloes) {
      const existente = t.id && antes.find((a) => a.id === t.id);
      if (existente) {
        mantidos.add(t.id);
        await run(
          `UPDATE taloes SET tipo = ?, tpa = ?, data = ?, hora = ?, valor = ?, cartao = ?, ultimos4 = ?, reservas = ?, reserva_origem = ?, duvidoso = 0 WHERE id = ?`,
          t.tipo, t.tpa, t.data, t.hora, t.valor, cifrarTexto(t.cartao), cifrarTexto(t.ultimos4), t.reservas, t.reserva_origem, t.id,
        );
      } else {
        await run(
          `INSERT INTO taloes (envio_id, tipo, tpa, data, hora, valor, cartao, ultimos4, reservas, reserva_lida, reserva_origem)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
          envio.id, t.tipo, t.tpa, t.data, t.hora, t.valor, cifrarTexto(t.cartao), cifrarTexto(t.ultimos4), t.reservas, t.reserva_origem,
        );
      }
      await run('INSERT INTO tpas (numero) VALUES (?) ON CONFLICT DO NOTHING', t.tpa);
    }
    for (const a of antes) if (!mantidos.has(a.id)) await run('DELETE FROM taloes WHERE id = ?', a.id);
    if (envio.estado === 'rascunho') {
      await run(`UPDATE envios SET estado = 'confirmado', confirmado_em = ?, confirmado_por = ? WHERE id = ?`, agora(), req.user.id, envio.id);
    }
  });
  for (const data of new Set([...antes, ...taloes].map((t) => t.data).filter(Boolean))) await reconciliar(data);

  if (req.user.role !== 'auditor') return res.redirect('/taloes/meus?ok=1');
  const dia = taloes[0].data;
  res.redirect(await get('SELECT 1 AS x FROM fechos WHERE data = ?', dia) ? `/fechos/${dia}` : `/taloes?data=${dia}`);
});

app.post('/envios/:id/apagar', exigirLogin, carregarEnvio, async (req, res) => {
  if (!req.editavel) return res.status(403).send(v.erroPage(req.user, 'Envio já confirmado', 'Só o auditor pode apagar um talão depois de confirmado.'));
  const datas = new Set((await taloesDoEnvio(req.envio.id)).map((t) => t.data).filter(Boolean));
  await run('DELETE FROM envios WHERE id = ?', req.envio.id);
  if (!SEM_ESTADO) fs.rmSync(path.join(UPLOAD_DIR, path.basename(req.envio.ficheiro)), { force: true }); // ficheiro antigo, se existir
  for (const data of datas) await reconciliar(data);
  res.redirect(req.user.role === 'auditor' ? '/taloes' : '/taloes/meus');
});

// ---------- Configuração (auditor) ----------
const MENSAGENS = { guardado: 'Alterações guardadas.', criado: 'Criado.', password: 'Palavra-passe reposta.' };
const mensagem = (req) => MENSAGENS[req.query.ok];

async function paginaTerminais(req, res, erro, status = 200) {
  const [tpas, caixasLinhas] = await Promise.all([carregarTerminais(), all('SELECT codigo FROM caixas ORDER BY codigo')]);
  const caixas = caixasLinhas.map((c) => c.codigo);
  res.status(status).send(v.terminaisPage(req.user, tpas, caixas, mensagem(req), erro));
}
app.get('/config/terminais', exigirAuditor, async (req, res) => await paginaTerminais(req, res));
app.post('/config/terminais', exigirAuditor, async (req, res) => {
  const numero = String(req.body?.numero || '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9]{1,20}$/.test(numero)) return await paginaTerminais(req, res, 'Indique o número do terminal.', 400);
  if (await get('SELECT 1 AS x FROM tpas WHERE numero = ?', numero)) return await paginaTerminais(req, res, 'Esse terminal já existe.', 400);
  await run('INSERT INTO tpas (numero, nome) VALUES (?, ?)', numero, String(req.body?.nome || '').trim().slice(0, 80));
  res.redirect('/config/terminais?ok=criado');
});
// Associa um terminal a mais uma caixa (a partir da página do fecho) e volta a cruzar tudo.
app.post('/config/terminais/:id/associar', exigirAuditor, async (req, res, next) => {
  const tpa = await get('SELECT * FROM tpas WHERE id = ?', Number(req.params.id));
  if (!tpa) return next();
  const caixa = String(req.body?.caixa || '');
  if (await get('SELECT 1 AS x FROM caixas WHERE codigo = ?', caixa)) {
    await run('INSERT INTO tpa_caixas (tpa_id, caixa) VALUES (?, ?) ON CONFLICT DO NOTHING', tpa.id, caixa);
    await reconciliarTudo();
  }
  const data = String(req.body?.data || '');
  res.redirect(RE_DATA.test(data) ? `/fechos/${data}#meios:tpa` : '/config/terminais?ok=guardado');
});
app.post('/config/terminais/:id', exigirAuditor, async (req, res, next) => {
  const tpa = await get('SELECT * FROM tpas WHERE id = ?', Number(req.params.id));
  if (!tpa) return next();
  const validas = new Set((await all('SELECT codigo FROM caixas')).map((c) => c.codigo));
  await tx(async () => {
    await run('UPDATE tpas SET nome = ? WHERE id = ?', String(req.body?.nome || '').trim().slice(0, 80), tpa.id);
    await run('DELETE FROM tpa_caixas WHERE tpa_id = ?', tpa.id);
    for (const c of lista(req.body?.caixas)) if (validas.has(c)) await run('INSERT INTO tpa_caixas (tpa_id, caixa) VALUES (?, ?) ON CONFLICT DO NOTHING', tpa.id, c);
  });
  await reconciliarTudo();
  res.redirect('/config/terminais?ok=guardado');
});

app.get('/config/meios', exigirAuditor, async (req, res) => res.send(v.meiosPage(req.user, await all('SELECT * FROM meios ORDER BY codigo'), mensagem(req))));
app.post('/config/meios', exigirAuditor, async (req, res) => {
  const marcados = new Set(lista(req.body?.tpa));
  await tx(async () => {
    for (const m of await all('SELECT codigo FROM meios')) await run('UPDATE meios SET tpa = ? WHERE codigo = ?', marcados.has(m.codigo) ? 1 : 0, m.codigo);
  });
  await reconciliarTudo();
  res.redirect('/config/meios?ok=guardado');
});

app.get('/config/agencias', exigirAuditor, async (req, res) => {
  res.send(v.agenciasPage(req.user, await all('SELECT * FROM agencias ORDER BY nome'), Number(await config('prazo_dias', PRAZO_OMISSAO)), mensagem(req)));
});
app.post('/config/agencias', exigirAuditor, async (req, res) => {
  // Os nomes das agências têm vírgulas, pontos e travessões, por isso vão em campos numerados (n0/r0, n1/r1…).
  const body = req.body || {};
  const prazo = Number(body.prazo);
  await tx(async () => {
    for (let i = 0; typeof body[`n${i}`] === 'string'; i++) {
      if (['imediata', 'prazo', 'agencia'].includes(body[`r${i}`])) await run('UPDATE agencias SET regra = ? WHERE nome = ?', body[`r${i}`], body[`n${i}`]);
    }
    if (Number.isInteger(prazo) && prazo >= 0 && prazo <= 90) await guardarConfig('prazo_dias', prazo);
  });
  await reconciliarTudo();
  res.redirect('/config/agencias?ok=guardado');
});

async function paginaUtilizadores(req, res, erro, status = 200) {
  const users = await all('SELECT id, username, nome, role, ativo FROM users ORDER BY ativo DESC, nome');
  res.status(status).send(v.utilizadoresPage(req.user, users, mensagem(req), erro));
}
app.get('/config/utilizadores', exigirAuditor, async (req, res) => await paginaUtilizadores(req, res));
app.post('/config/utilizadores', exigirAuditor, async (req, res) => {
  const { nome = '', username = '', password = '', role } = req.body || {};
  const erro = validarUtilizador(nome, username, password) || (await get('SELECT 1 AS x FROM users WHERE lower(username) = lower(?)', username) ? 'Já existe um utilizador com esse nome de utilizador.' : null);
  if (erro) return await paginaUtilizadores(req, res, erro, 400);
  await run(
    'INSERT INTO users (username, nome, pass_hash, role, criado_em) VALUES (?, ?, ?, ?, ?)',
    username, nome.trim(), auth.hashPassword(password), role === 'auditor' ? 'auditor' : 'rececionista', agora(),
  );
  res.redirect('/config/utilizadores?ok=criado');
});
app.post('/config/utilizadores/:id/ativo', exigirAuditor, async (req, res, next) => {
  const u = await get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) return next();
  if (u.id === req.user.id) return await paginaUtilizadores(req, res, 'Não pode desativar a sua própria conta.', 400);
  await run('UPDATE users SET ativo = ? WHERE id = ?', u.ativo ? 0 : 1, u.id);
  if (u.ativo) await auth.terminarSessoesDe(u.id);
  res.redirect('/config/utilizadores?ok=guardado');
});
app.post('/config/utilizadores/:id/password', exigirAuditor, async (req, res, next) => {
  const u = await get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) return next();
  const password = String(req.body?.password || '');
  if (password.length < 8) return await paginaUtilizadores(req, res, 'A palavra-passe deve ter pelo menos 8 caracteres.', 400);
  await run('UPDATE users SET pass_hash = ? WHERE id = ?', auth.hashPassword(password), u.id);
  if (u.id !== req.user.id) await auth.terminarSessoesDe(u.id);
  res.redirect('/config/utilizadores?ok=password');
});

if (SEM_ESTADO && !cifraAtiva) console.warn('Aviso: sem ENCRYPTION_KEY os dados sensíveis (cartões, detalhes, ficheiros dos talões) ficam sem encriptar na base de dados.');

// Verificação do serviço (e da ligação à base de dados), sem sessão: útil para ver se o deploy está bem.
app.get('/saude', async (req, res) => {
  try {
    await get('SELECT 1 AS ok');
    res.json({ ok: true, baseDeDados: DESTINO === 'postgres' ? 'postgres' : 'local', encriptacao: cifraAtiva });
  } catch (erro) {
    console.error('Falha na verificação da base de dados:', erro.message);
    res.status(503).json({ ok: false });
  }
});

// ---------- Erros ----------
app.use((req, res) => {
  if (!req.user) return res.redirect('/login');
  res.status(404).send(v.erroPage(req.user, 'Página não encontrada', 'O endereço não existe ou não tem acesso a ele.'));
});
app.use((erro, req, res, next) => {
  console.error(erro);
  if (res.headersSent) return next(erro);
  res.status(500).send(v.erroPage(req.user, 'Ocorreu um erro', 'Não foi possível concluir o pedido. Tente de novo; se continuar, avise o responsável pela aplicação.'));
});

// Arranque (só num servidor normal; numa função sem estado cada arranque a frio tem de ser o mais curto possível).
if (!SEM_ESTADO) {
  const { migrar, importarFicheirosLocais } = await import('./src/migracao.js');
  // Se a base de dados nova estiver vazia mas existir a antiga (SQLite), os dados não podem "desaparecer".
  const SQLITE_ANTIGO = path.join(DATA_DIR, 'caixas.db');
  if (fs.existsSync(SQLITE_ANTIGO) && (await get('SELECT COUNT(*) AS n FROM users')).n === 0) {
    if (DESTINO === 'local') {
      console.log('A copiar os dados do SQLite antigo (data/caixas.db) para o Postgres local...');
      const r = await migrar({ origem: SQLITE_ANTIGO });
      console.log(`  copiadas ${r.reduce((x, y) => x + y.destino, 0)} linhas em ${r.length} tabelas. O ficheiro antigo fica como cópia de segurança.`);
    } else {
      console.log('\n  AVISO: a base de dados do Supabase está vazia, mas existe a base de dados antiga (data/caixas.db).');
      console.log('         Para copiar os dados para o Supabase, pare a app e corra: npm run migrar\n');
    }
  }
  // Fotografias e PDF de talões de antes de passarem para a base de dados.
  const n = await importarFicheirosLocais();
  if (n) console.log(`  ${n} ficheiro(s) de talões da pasta data/taloes copiados para a base de dados.`);
}

const porta = Number(process.env.PORT) || 3000;
// Na Vercel não se põe à escuta: ela chama a app exportada em cada pedido.
if (!SEM_ESTADO) {
  app.listen(porta, () => {
    console.log(`Auditoria de caixas a correr em http://localhost:${porta}`);
    console.log(`  Encriptação dos dados sensíveis: ${cifraAtiva ? 'ligada' : 'DESLIGADA (defina ENCRYPTION_KEY)'}`);
    console.log(`  Base de dados: ${DESTINO === 'postgres' ? 'Postgres do DATABASE_URL (Supabase)' : 'Postgres local (data/pglite) — defina DATABASE_URL no .env para usar o Supabase'}`);
    for (const redes of Object.values(os.networkInterfaces())) {
      for (const r of redes || []) if (r.family === 'IPv4' && !r.internal) console.log(`  Na rede local: http://${r.address}:${porta}`);
    }
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      console.log('  Aviso: sem ANTHROPIC_API_KEY no ficheiro .env, os talões têm de ser preenchidos à mão.');
    }
  });
}

export default app;
