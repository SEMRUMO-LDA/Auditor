import './src/env.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import * as auth from './src/auth.js';
import { all, get, run, tx, agora, config, guardarConfig, UPLOAD_DIR } from './src/db.js';
import { ErroFicheiro } from './src/parsers.js';
import { importar } from './src/fechos.js';
import { reconciliar, reconciliarTudo, resumoReservas, PRAZO_OMISSAO } from './src/reconcile.js';
import { lerTaloes, ErroLeitura, MIMES_IMAGEM } from './src/leitor.js';
import * as v from './src/views.js';

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; object-src 'self'; frame-ancestors 'self'",
  });
  next();
});
app.use(express.static(path.join(import.meta.dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
app.use(auth.carregarUtilizador);

const { exigirLogin, exigirAuditor } = auth;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_USERNAME = /^[a-zA-Z0-9._-]{3,40}$/;
const lista = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const haUtilizadores = () => get('SELECT COUNT(*) AS n FROM users').n > 0;

// ---------- Entrada ----------
app.get('/', exigirLogin, (req, res) => res.redirect(req.user.role === 'auditor' ? '/fechos' : '/taloes/novo'));

app.get('/setup', (req, res) => (haUtilizadores() ? res.redirect('/login') : res.send(v.setupPage())));
app.post('/setup', (req, res) => {
  if (haUtilizadores()) return res.redirect('/login');
  const { nome = '', username = '', password = '' } = req.body || {};
  const erro = validarUtilizador(nome, username, password);
  if (erro) return res.status(400).send(v.setupPage(erro, { nome, username }));
  const id = Number(
    run('INSERT INTO users (username, nome, pass_hash, role, criado_em) VALUES (?, ?, ?, ?, ?)', username, nome.trim(), auth.hashPassword(password), 'auditor', agora()).lastInsertRowid,
  );
  auth.iniciarSessao(req, res, id);
  res.redirect('/');
});

function validarUtilizador(nome, username, password) {
  if (!nome.trim()) return 'Indique o nome.';
  if (!RE_USERNAME.test(username)) return 'O utilizador deve ter 3 a 40 caracteres: letras, números, ponto, hífen ou sublinhado.';
  if (password.length < 8) return 'A palavra-passe deve ter pelo menos 8 caracteres.';
  return null;
}

app.get('/login', (req, res) => {
  if (!haUtilizadores()) return res.redirect('/setup');
  if (req.user) return res.redirect('/');
  res.send(v.loginPage());
});
app.post('/login', (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const chave = `${username.toLowerCase()}|${req.ip}`;
  if (auth.loginBloqueado(chave)) return res.status(429).send(v.loginPage('Demasiadas tentativas. Aguarde 5 minutos.'));
  const u = get('SELECT * FROM users WHERE username = ? AND ativo = 1', username);
  if (!u || !auth.verificarPassword(password, u.pass_hash)) {
    auth.registarFalha(chave);
    return res.status(401).send(v.loginPage('Utilizador ou palavra-passe incorretos.'));
  }
  auth.limparFalhas(chave);
  auth.iniciarSessao(req, res, u.id);
  res.redirect('/');
});
app.post('/logout', (req, res) => {
  auth.terminarSessao(req, res);
  res.redirect('/login');
});

app.get('/conta', exigirLogin, (req, res) => res.send(v.contaPage(req.user, req.query.ok && 'Palavra-passe alterada.')));
app.post('/conta/password', exigirLogin, (req, res) => {
  const { atual = '', nova = '' } = req.body || {};
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!auth.verificarPassword(atual, u.pass_hash)) return res.status(400).send(v.contaPage(req.user, null, 'A palavra-passe atual não está correta.'));
  if (nova.length < 8) return res.status(400).send(v.contaPage(req.user, null, 'A nova palavra-passe deve ter pelo menos 8 caracteres.'));
  run('UPDATE users SET pass_hash = ? WHERE id = ?', auth.hashPassword(nova), u.id);
  res.redirect('/conta?ok=1');
});

// ---------- Fechos (auditor) ----------
app.get('/fechos', exigirAuditor, (req, res) => {
  const fechos = all(`
    SELECT f.*,
      (SELECT SUM(valor) FROM movimentos m WHERE m.data = f.data) AS total,
      (SELECT COUNT(*) FROM taloes t JOIN envios e ON e.id = t.envio_id WHERE t.data = f.data AND e.estado = 'confirmado') AS taloes,
      (SELECT COUNT(*) FROM inconsistencias i WHERE i.data = f.data AND i.ativa = 1 AND i.estado = 'pendente') AS pendentes,
      (SELECT COUNT(*) FROM inconsistencias i WHERE i.data = f.data AND i.estado = 'justificada') AS justificadas,
      (SELECT COUNT(*) FROM inconsistencias i WHERE i.data = f.data AND i.estado = 'resolvida') AS resolvidas
    FROM fechos f ORDER BY f.data DESC`);
  res.send(v.fechosPage(req.user, fechos));
});

const memoria = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const ficheirosPMS = memoria.array('ficheiros', 12);

app.get('/fechos/carregar', exigirAuditor, (req, res) => res.send(v.carregarPage(req.user)));
app.post('/fechos/carregar', exigirAuditor, (req, res, next) => {
  ficheirosPMS(req, res, (erroUpload) => {
    if (erroUpload) return res.status(400).send(v.carregarPage(req.user, 'Não foi possível receber os ficheiros (máximo 10 MB cada, até 12 ficheiros).'));
    try {
      // O nome do ficheiro chega em latin1 no multipart; converte-se para mostrar bem os acentos.
      const ficheiros = (req.files || []).map((f) => ({ nome: Buffer.from(f.originalname, 'latin1').toString('utf8'), buffer: f.buffer }));
      const { data } = importar(ficheiros, req.user.id);
      res.redirect(`/fechos/${data}`);
    } catch (erro) {
      if (erro instanceof ErroFicheiro) return res.status(400).send(v.carregarPage(req.user, erro.message));
      next(erro);
    }
  });
});

const CAMPOS_FILTRO = ['data', 'estado', 'gravidade', 'tipo', 'utilizador', 'caixa'];
function lerFiltros(query, fixos = {}) {
  const f = { ...fixos };
  for (const k of CAMPOS_FILTRO) if (typeof query[k] === 'string' && query[k] && !(k in fixos)) f[k] = query[k];
  return f;
}
function listarIncs(f) {
  const cond = ['1 = 1'];
  const ps = [];
  for (const k of CAMPOS_FILTRO) {
    if (f[k]) {
      cond.push(`i.${k} = ?`);
      ps.push(f[k]);
    }
  }
  return all(
    `SELECT i.*, (SELECT COUNT(*) FROM historico h WHERE h.inconsistencia_id = i.id AND h.kind = 'nota') AS notas
     FROM inconsistencias i WHERE ${cond.join(' AND ')}
     ORDER BY i.data DESC, CASE i.gravidade WHEN 'erro' THEN 0 WHEN 'aviso' THEN 1 ELSE 2 END, i.tipo, i.id LIMIT 2000`,
    ...ps,
  );
}
function opcoesFiltro(data) {
  const onde = data ? 'WHERE data = ?' : '';
  const ps = data ? [data] : [];
  const distintos = (col) => all(`SELECT DISTINCT ${col} AS x FROM inconsistencias ${onde} ORDER BY 1`, ...ps).map((r) => r.x).filter(Boolean);
  return { tipos: distintos('tipo'), utilizadores: distintos('utilizador'), caixas: distintos('caixa') };
}

const SQL_TALOES = `
  SELECT t.*, e.estado, u.nome AS enviado_por FROM taloes t
  JOIN envios e ON e.id = t.envio_id JOIN users u ON u.id = e.user_id`;

app.get('/fechos/:data', exigirAuditor, (req, res, next) => {
  const { data } = req.params;
  const fecho = RE_DATA.test(data) && get('SELECT * FROM fechos WHERE data = ?', data);
  if (!fecho) return next();
  const totais = get(
    `SELECT
      (SELECT COALESCE(SUM(valor), 0) FROM movimentos WHERE data = ?) AS diario,
      (SELECT COALESCE(SUM(valor), 0) FROM faturas WHERE data = ?) AS faturas,
      (SELECT COALESCE(SUM(valor), 0) FROM movimentos WHERE data = ? AND tipo IN (SELECT codigo FROM meios WHERE tpa = 1)) AS cartao,
      (SELECT COALESCE(SUM(t.valor), 0) FROM taloes t JOIN envios e ON e.id = t.envio_id
        WHERE t.data = ? AND t.tipo = 'compra' AND e.estado = 'confirmado') AS taloes`,
    data, data, data, data,
  );
  const meios = all(
    `SELECT x.tipo, COALESCE(m.tpa, 0) AS tpa,
      (SELECT COALESCE(SUM(valor), 0) FROM movimentos WHERE data = ? AND tipo = x.tipo) AS diario,
      (SELECT COALESCE(SUM(valor), 0) FROM faturas WHERE data = ? AND tipo = x.tipo) AS faturas
     FROM (SELECT tipo FROM movimentos WHERE data = ? UNION SELECT tipo FROM faturas WHERE data = ?) x
     LEFT JOIN meios m ON m.codigo = x.tipo ORDER BY x.tipo`,
    data, data, data, data,
  );
  const porUtilizador = all(
    `SELECT m.utilizador, COUNT(*) AS n, SUM(m.valor) AS total, REPLACE(GROUP_CONCAT(DISTINCT m.caixa), ',', ', ') AS caixas,
      (SELECT COUNT(*) FROM inconsistencias i WHERE i.data = m.data AND i.utilizador = m.utilizador AND i.estado = 'pendente' AND i.ativa = 1) AS pendentes
     FROM movimentos m WHERE m.data = ? GROUP BY m.utilizador ORDER BY m.utilizador`,
    data,
  );
  const contagem = Object.fromEntries(
    all(`SELECT estado, COUNT(*) AS n FROM inconsistencias WHERE data = ? AND (ativa = 1 OR estado <> 'pendente') GROUP BY estado`, data).map((r) => [r.estado, r.n]),
  );
  const filtros = lerFiltros(req.query, { data });
  res.send(
    v.fechoPage(req.user, {
      fecho, totais, meios, porUtilizador, contagem, filtros,
      reservas: resumoReservas(data),
      incs: listarIncs(filtros),
      opcoes: opcoesFiltro(data),
      taloes: all(`${SQL_TALOES} WHERE t.data = ? AND e.estado = 'confirmado' ORDER BY t.hora, t.id`, data),
    }),
  );
});

app.post('/fechos/:data/reconciliar', exigirAuditor, (req, res, next) => {
  if (!RE_DATA.test(req.params.data)) return next();
  reconciliar(req.params.data);
  res.redirect(`/fechos/${req.params.data}`);
});

// ---------- Diários: resumo geral das faturas de todos os dias carregados (auditor) ----------
function dadosDiarios(query) {
  const texto = (k) => (typeof query[k] === 'string' ? query[k] : '');
  const filtros = { mes: /^\d{4}-\d{2}$/.test(texto('mes')) ? texto('mes') : '', serie: texto('serie'), meio: texto('meio') };
  const cond = ['1 = 1'];
  const ps = [];
  if (filtros.mes) { cond.push('substr(f.data, 1, 7) = ?'); ps.push(filtros.mes); }
  if (filtros.serie) { cond.push(`substr(f.doc, 1, instr(f.doc, '/') - 1) = ?`); ps.push(filtros.serie); }
  if (filtros.meio) { cond.push('f.tipo = ?'); ps.push(filtros.meio); }
  const faturas = all(
    `SELECT f.*, (SELECT MIN(m.hora) FROM movimentos m WHERE m.data = f.data AND m.doc = f.doc) AS hora
     FROM faturas f WHERE ${cond.join(' AND ')} ORDER BY f.data, f.id`,
    ...ps,
  );

  // Dentro de cada dia, as linhas da mesma reserva ficam juntas (fatura, nota de crédito, nova fatura)
  // e as reservas seguem a ordem do primeiro documento.
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
    return { ...g, ordem: `${primeira.doc.split('/')[0]}/${String(numero(primeira.doc)).padStart(9, '0')}`, comNC: g.linhas.some((l) => /^NC\b/i.test(l.doc)) };
  });
  ordenados.sort((a, b) => a.data.localeCompare(b.data) || a.ordem.localeCompare(b.ordem));
  const dias = [...new Set(ordenados.map((g) => g.data))];
  const linhas = ordenados.flatMap((g) => g.linhas.map((l) => ({ ...l, comNC: g.comNC, grupo: dias.indexOf(g.data) })));

  const distintos = (sql) => all(sql).map((r) => r.x).filter(Boolean);
  return {
    filtros,
    linhas,
    opcoes: {
      meses: distintos('SELECT DISTINCT substr(data, 1, 7) AS x FROM faturas ORDER BY 1'),
      series: distintos(`SELECT DISTINCT substr(doc, 1, instr(doc, '/') - 1) AS x FROM faturas ORDER BY 1`),
      meios: distintos('SELECT DISTINCT tipo AS x FROM faturas ORDER BY 1'),
    },
    resumo: {
      dias: dias.length,
      documentos: new Set(linhas.map((l) => l.doc)).size,
      total: linhas.reduce((s, l) => s + l.valor, 0),
      notas: new Set(linhas.filter((l) => /^NC\b/i.test(l.doc)).map((l) => l.doc)).size,
      totalNotas: linhas.filter((l) => /^NC\b/i.test(l.doc)).reduce((s, l) => s + l.valor, 0),
      porDia: dias.map((d) => {
        const doDia = linhas.filter((l) => l.data === d);
        return { data: d, linhas: doDia.length, reservas: new Set(doDia.map((l) => l.reserva)).size, total: doDia.reduce((s, l) => s + l.valor, 0) };
      }),
    },
  };
}

app.get('/diarios', exigirAuditor, (req, res) => res.send(v.diariosPage(req.user, dadosDiarios(req.query), new URLSearchParams(req.query).toString())));
app.get('/diarios.xls', exigirAuditor, (req, res) => {
  const dados = dadosDiarios(req.query);
  res.set({
    'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
    'Content-Disposition': `attachment; filename="diarios${dados.filtros.mes ? '-' + dados.filtros.mes : ''}.xls"`,
  });
  res.send('﻿' + v.diariosExcel(dados));
});

// ---------- Inconsistências (auditor) ----------
app.get('/inconsistencias', exigirAuditor, (req, res) => {
  // Ao entrar sem filtros mostram-se as pendentes; "Todos" no filtro mostra tudo.
  const filtros = lerFiltros(req.query);
  if (!('estado' in req.query)) filtros.estado = 'pendente';
  res.send(v.incsPage(req.user, listarIncs(filtros), filtros, opcoesFiltro(null)));
});

function podeMudarEstado(id) {
  const ultima = (kind) => get('SELECT MAX(id) AS id FROM historico WHERE inconsistencia_id = ? AND kind = ?', id, kind).id;
  const nota = ultima('nota');
  // Cada mudança de estado exige uma nota escrita depois da mudança anterior.
  return nota !== null && nota > (ultima('estado') ?? 0);
}

function mostrarInc(req, res, inc, erro, status = 200) {
  const historico = all(
    'SELECT h.*, u.nome AS autor FROM historico h JOIN users u ON u.id = h.user_id WHERE h.inconsistencia_id = ? ORDER BY h.id',
    inc.id,
  );
  const ids = lista(JSON.parse(inc.detalhe_json).taloes).map(Number).filter(Number.isInteger);
  const envios = ids.length
    ? all(`SELECT DISTINCT e.id, e.mime FROM taloes t JOIN envios e ON e.id = t.envio_id WHERE t.id IN (${ids.map(() => '?').join(',')})`, ...ids)
    : [];
  res.status(status).send(v.incPage(req.user, inc, historico, podeMudarEstado(inc.id), envios, erro));
}

app.get('/inconsistencias/:id', exigirAuditor, (req, res, next) => {
  const inc = get('SELECT * FROM inconsistencias WHERE id = ?', Number(req.params.id));
  if (!inc) return next();
  mostrarInc(req, res, inc);
});

app.post('/inconsistencias/:id/nota', exigirAuditor, (req, res, next) => {
  const inc = get('SELECT * FROM inconsistencias WHERE id = ?', Number(req.params.id));
  if (!inc) return next();
  const texto = String(req.body?.texto || '').trim();
  if (!texto) return mostrarInc(req, res, inc, 'Escreva a nota antes de guardar.', 400);
  run('INSERT INTO historico (inconsistencia_id, user_id, quando, kind, texto) VALUES (?, ?, ?, ?, ?)', inc.id, req.user.id, agora(), 'nota', texto.slice(0, 5000));
  res.redirect(`/inconsistencias/${inc.id}`);
});

app.post('/inconsistencias/:id/estado', exigirAuditor, (req, res, next) => {
  const inc = get('SELECT * FROM inconsistencias WHERE id = ?', Number(req.params.id));
  if (!inc) return next();
  const novo = req.body?.estado;
  if (!['pendente', 'justificada', 'resolvida'].includes(novo) || novo === inc.estado) return res.redirect(`/inconsistencias/${inc.id}`);
  if (!podeMudarEstado(inc.id)) return mostrarInc(req, res, inc, 'Guarde primeiro uma nota a explicar a situação; só depois pode alterar o estado.', 400);
  tx(() => {
    run('UPDATE inconsistencias SET estado = ? WHERE id = ?', novo, inc.id);
    run(
      'INSERT INTO historico (inconsistencia_id, user_id, quando, kind, estado_de, estado_para) VALUES (?, ?, ?, ?, ?, ?)',
      inc.id, req.user.id, agora(), 'estado', inc.estado, novo,
    );
  });
  res.redirect(`/inconsistencias/${inc.id}`);
});

// ---------- Talões ----------
const EXTENSAO = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };
const fotos = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + EXTENSAO[file.mimetype]),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype in EXTENSAO),
}).single('ficheiro');

app.get('/taloes/novo', exigirLogin, (req, res) => res.send(v.novoTalaoPage(req.user)));

app.post('/taloes/enviar', exigirLogin, (req, res, next) => {
  fotos(req, res, async (erroUpload) => {
    try {
      if (erroUpload) return res.status(400).send(v.novoTalaoPage(req.user, 'O ficheiro é demasiado grande (máximo 15 MB).'));
      const f = req.file;
      if (!f) return res.status(400).send(v.novoTalaoPage(req.user, 'Escolha uma fotografia (JPEG ou PNG) ou um PDF.'));
      const id = Number(
        run('INSERT INTO envios (user_id, ficheiro, mime, nome_original, criado_em) VALUES (?, ?, ?, ?, ?)', req.user.id, f.filename, f.mimetype, f.originalname, agora()).lastInsertRowid,
      );
      try {
        const lidos = await lerTaloes(f.path, f.mimetype);
        tx(() => {
          run('UPDATE envios SET leitura_json = ? WHERE id = ?', JSON.stringify(lidos), id);
          for (const t of lidos) {
            run(
              `INSERT INTO taloes (envio_id, tipo, tpa, data, hora, valor, cartao, ultimos4, reservas, reserva_lida, duvidoso)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              id, t.tipo, t.tpa, t.data, t.hora, t.valor, t.cartao, t.ultimos4, t.reserva, t.reserva, t.duvidoso ? 1 : 0,
            );
          }
        });
      } catch (erro) {
        if (!(erro instanceof ErroLeitura)) console.error('Erro na leitura do talão:', erro);
        run('UPDATE envios SET leitura_erro = ? WHERE id = ?', erro instanceof ErroLeitura ? erro.message : 'Erro inesperado na leitura.', id);
      }
      res.redirect(`/envios/${id}`);
    } catch (erro) {
      next(erro);
    }
  });
});

app.get('/taloes/meus', exigirLogin, (req, res) => {
  const envios = all(
    `SELECT e.id, e.criado_em, e.estado, COUNT(t.id) AS n, SUM(CASE WHEN t.tipo = 'compra' THEN t.valor END) AS total,
      REPLACE(GROUP_CONCAT(DISTINCT NULLIF(t.reservas, '')), ',', ', ') AS reservas
     FROM envios e LEFT JOIN taloes t ON t.envio_id = e.id WHERE e.user_id = ? GROUP BY e.id ORDER BY e.id DESC LIMIT 200`,
    req.user.id,
  );
  res.send(v.meusEnviosPage(req.user, envios, Boolean(req.query.ok)));
});

app.get('/taloes', exigirAuditor, (req, res) => {
  const data = RE_DATA.test(req.query.data || '') ? req.query.data : null;
  const taloes = data
    ? all(`${SQL_TALOES} WHERE t.data = ? ORDER BY t.hora, t.id`, data)
    : all(`${SQL_TALOES} ORDER BY e.id DESC, t.id LIMIT 500`);
  res.send(v.taloesPage(req.user, taloes, { data }));
});

// Um rececionista só vê os seus envios e só os altera enquanto não os confirmar; depois disso, só o auditor.
function carregarEnvio(req, res, next) {
  const envio = get('SELECT e.*, u.nome AS enviado_por FROM envios e JOIN users u ON u.id = e.user_id WHERE e.id = ?', Number(req.params.id));
  if (!envio) return next('route');
  const auditor = req.user.role === 'auditor';
  if (!auditor && envio.user_id !== req.user.id) return next('route');
  req.envio = envio;
  req.editavel = auditor || envio.estado === 'rascunho';
  next();
}
const taloesDoEnvio = (id) => all('SELECT * FROM taloes WHERE envio_id = ? ORDER BY id', id);

app.get('/envios/:id', exigirLogin, carregarEnvio, (req, res) => {
  res.send(v.envioPage(req.user, req.envio, taloesDoEnvio(req.envio.id), req.editavel));
});

app.get('/envios/:id/ficheiro', exigirLogin, carregarEnvio, (req, res) => {
  res.sendFile(req.envio.ficheiro, { root: UPLOAD_DIR, headers: { 'Content-Type': req.envio.mime, 'Cache-Control': 'private, max-age=3600' } });
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

app.post('/envios/:id', exigirLogin, carregarEnvio, (req, res) => {
  const envio = req.envio;
  if (!req.editavel) return res.status(403).send(v.erroPage(req.user, 'Envio já confirmado', 'Só o auditor pode alterar um talão depois de confirmado.'));
  const { taloes, erros } = lerFormularioTaloes(req.body);
  if (erros.length) return res.status(400).send(v.envioPage(req.user, envio, taloes, true, erros));

  const antes = taloesDoEnvio(envio.id);
  const mantidos = new Set();
  tx(() => {
    for (const t of taloes) {
      const existente = t.id && antes.find((a) => a.id === t.id);
      if (existente) {
        mantidos.add(t.id);
        run(
          `UPDATE taloes SET tipo = ?, tpa = ?, data = ?, hora = ?, valor = ?, cartao = ?, ultimos4 = ?, reservas = ?, reserva_origem = ?, duvidoso = 0 WHERE id = ?`,
          t.tipo, t.tpa, t.data, t.hora, t.valor, t.cartao, t.ultimos4, t.reservas, t.reserva_origem, t.id,
        );
      } else {
        run(
          `INSERT INTO taloes (envio_id, tipo, tpa, data, hora, valor, cartao, ultimos4, reservas, reserva_lida, reserva_origem)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
          envio.id, t.tipo, t.tpa, t.data, t.hora, t.valor, t.cartao, t.ultimos4, t.reservas, t.reserva_origem,
        );
      }
      run('INSERT OR IGNORE INTO tpas (numero) VALUES (?)', t.tpa);
    }
    for (const a of antes) if (!mantidos.has(a.id)) run('DELETE FROM taloes WHERE id = ?', a.id);
    if (envio.estado === 'rascunho') {
      run(`UPDATE envios SET estado = 'confirmado', confirmado_em = ?, confirmado_por = ? WHERE id = ?`, agora(), req.user.id, envio.id);
    }
  });
  for (const data of new Set([...antes, ...taloes].map((t) => t.data).filter(Boolean))) reconciliar(data);

  if (req.user.role !== 'auditor') return res.redirect('/taloes/meus?ok=1');
  const dia = taloes[0].data;
  res.redirect(get('SELECT 1 AS x FROM fechos WHERE data = ?', dia) ? `/fechos/${dia}` : `/taloes?data=${dia}`);
});

app.post('/envios/:id/apagar', exigirLogin, carregarEnvio, (req, res) => {
  if (!req.editavel) return res.status(403).send(v.erroPage(req.user, 'Envio já confirmado', 'Só o auditor pode apagar um talão depois de confirmado.'));
  const datas = new Set(taloesDoEnvio(req.envio.id).map((t) => t.data).filter(Boolean));
  run('DELETE FROM envios WHERE id = ?', req.envio.id);
  fs.rmSync(path.join(UPLOAD_DIR, req.envio.ficheiro), { force: true });
  for (const data of datas) reconciliar(data);
  res.redirect(req.user.role === 'auditor' ? '/taloes' : '/taloes/meus');
});

// ---------- Configuração (auditor) ----------
const MENSAGENS = { guardado: 'Alterações guardadas.', criado: 'Criado.', password: 'Palavra-passe reposta.' };
const mensagem = (req) => MENSAGENS[req.query.ok];

function paginaTerminais(req, res, erro, status = 200) {
  const tpas = all('SELECT * FROM tpas ORDER BY numero').map((t) => ({
    ...t,
    caixas: all('SELECT caixa FROM tpa_caixas WHERE tpa_id = ?', t.id).map((c) => c.caixa),
  }));
  const caixas = all('SELECT codigo FROM caixas ORDER BY codigo').map((c) => c.codigo);
  res.status(status).send(v.terminaisPage(req.user, tpas, caixas, mensagem(req), erro));
}
app.get('/config/terminais', exigirAuditor, (req, res) => paginaTerminais(req, res));
app.post('/config/terminais', exigirAuditor, (req, res) => {
  const numero = String(req.body?.numero || '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9]{1,20}$/.test(numero)) return paginaTerminais(req, res, 'Indique o número do terminal.', 400);
  if (get('SELECT 1 AS x FROM tpas WHERE numero = ?', numero)) return paginaTerminais(req, res, 'Esse terminal já existe.', 400);
  run('INSERT INTO tpas (numero, nome) VALUES (?, ?)', numero, String(req.body?.nome || '').trim().slice(0, 80));
  res.redirect('/config/terminais?ok=criado');
});
app.post('/config/terminais/:id', exigirAuditor, (req, res, next) => {
  const tpa = get('SELECT * FROM tpas WHERE id = ?', Number(req.params.id));
  if (!tpa) return next();
  const validas = new Set(all('SELECT codigo FROM caixas').map((c) => c.codigo));
  tx(() => {
    run('UPDATE tpas SET nome = ? WHERE id = ?', String(req.body?.nome || '').trim().slice(0, 80), tpa.id);
    run('DELETE FROM tpa_caixas WHERE tpa_id = ?', tpa.id);
    for (const c of lista(req.body?.caixas)) if (validas.has(c)) run('INSERT OR IGNORE INTO tpa_caixas (tpa_id, caixa) VALUES (?, ?)', tpa.id, c);
  });
  reconciliarTudo();
  res.redirect('/config/terminais?ok=guardado');
});

app.get('/config/meios', exigirAuditor, (req, res) => res.send(v.meiosPage(req.user, all('SELECT * FROM meios ORDER BY codigo'), mensagem(req))));
app.post('/config/meios', exigirAuditor, (req, res) => {
  const marcados = new Set(lista(req.body?.tpa));
  tx(() => {
    for (const m of all('SELECT codigo FROM meios')) run('UPDATE meios SET tpa = ? WHERE codigo = ?', marcados.has(m.codigo) ? 1 : 0, m.codigo);
  });
  reconciliarTudo();
  res.redirect('/config/meios?ok=guardado');
});

app.get('/config/agencias', exigirAuditor, (req, res) => {
  res.send(v.agenciasPage(req.user, all('SELECT * FROM agencias ORDER BY nome'), Number(config('prazo_dias', PRAZO_OMISSAO)), mensagem(req)));
});
app.post('/config/agencias', exigirAuditor, (req, res) => {
  // Os nomes das agências têm vírgulas, pontos e travessões, por isso vão em campos numerados (n0/r0, n1/r1…).
  const body = req.body || {};
  const prazo = Number(body.prazo);
  tx(() => {
    for (let i = 0; typeof body[`n${i}`] === 'string'; i++) {
      if (['imediata', 'prazo', 'agencia'].includes(body[`r${i}`])) run('UPDATE agencias SET regra = ? WHERE nome = ?', body[`r${i}`], body[`n${i}`]);
    }
    if (Number.isInteger(prazo) && prazo >= 0 && prazo <= 90) guardarConfig('prazo_dias', prazo);
  });
  reconciliarTudo();
  res.redirect('/config/agencias?ok=guardado');
});

function paginaUtilizadores(req, res, erro, status = 200) {
  const users = all('SELECT id, username, nome, role, ativo FROM users ORDER BY ativo DESC, nome');
  res.status(status).send(v.utilizadoresPage(req.user, users, mensagem(req), erro));
}
app.get('/config/utilizadores', exigirAuditor, (req, res) => paginaUtilizadores(req, res));
app.post('/config/utilizadores', exigirAuditor, (req, res) => {
  const { nome = '', username = '', password = '', role } = req.body || {};
  const erro = validarUtilizador(nome, username, password) || (get('SELECT 1 AS x FROM users WHERE username = ?', username) ? 'Já existe um utilizador com esse nome de utilizador.' : null);
  if (erro) return paginaUtilizadores(req, res, erro, 400);
  run(
    'INSERT INTO users (username, nome, pass_hash, role, criado_em) VALUES (?, ?, ?, ?, ?)',
    username, nome.trim(), auth.hashPassword(password), role === 'auditor' ? 'auditor' : 'rececionista', agora(),
  );
  res.redirect('/config/utilizadores?ok=criado');
});
app.post('/config/utilizadores/:id/ativo', exigirAuditor, (req, res, next) => {
  const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) return next();
  if (u.id === req.user.id) return paginaUtilizadores(req, res, 'Não pode desativar a sua própria conta.', 400);
  run('UPDATE users SET ativo = ? WHERE id = ?', u.ativo ? 0 : 1, u.id);
  if (u.ativo) auth.terminarSessoesDe(u.id);
  res.redirect('/config/utilizadores?ok=guardado');
});
app.post('/config/utilizadores/:id/password', exigirAuditor, (req, res, next) => {
  const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) return next();
  const password = String(req.body?.password || '');
  if (password.length < 8) return paginaUtilizadores(req, res, 'A palavra-passe deve ter pelo menos 8 caracteres.', 400);
  run('UPDATE users SET pass_hash = ? WHERE id = ?', auth.hashPassword(password), u.id);
  if (u.id !== req.user.id) auth.terminarSessoesDe(u.id);
  res.redirect('/config/utilizadores?ok=password');
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

const porta = Number(process.env.PORT) || 3000;
app.listen(porta, () => {
  console.log(`Auditoria de caixas a correr em http://localhost:${porta}`);
  for (const redes of Object.values(os.networkInterfaces())) {
    for (const r of redes || []) if (r.family === 'IPv4' && !r.internal) console.log(`  Na rede local: http://${r.address}:${porta}`);
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log('  Aviso: sem ANTHROPIC_API_KEY no ficheiro .env, os talões têm de ser preenchidos à mão.');
  }
});
