import crypto from 'node:crypto';
import { get, run, agora } from './db.js';

const DIAS_SESSAO = 14;
const COOKIE = 'sid';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verificarPassword(password, guardado) {
  const [saltHex, hashHex] = String(guardado).split(':');
  if (!saltHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const obtido = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), esperado.length);
  return crypto.timingSafeEqual(esperado, obtido);
}

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function lerCookie(req, nome) {
  for (const par of (req.headers.cookie || '').split(';')) {
    const i = par.indexOf('=');
    if (i > 0 && par.slice(0, i).trim() === nome) return decodeURIComponent(par.slice(i + 1).trim());
  }
  return null;
}

export async function iniciarSessao(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + DIAS_SESSAO * 86400e3);
  await run('INSERT INTO sessions (token_hash, user_id, expira_em) VALUES (?, ?, ?)', hashToken(token), userId, expira.toISOString());
  // Limpeza: as sessões expiradas e as falhas de login antigas não se acumulam.
  await run('DELETE FROM sessions WHERE expira_em < ?', agora());
  await run('DELETE FROM login_falhas WHERE ultima < ?', Date.now() - 86400e3);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, expires: expira });
}

export async function terminarSessao(req, res) {
  const token = lerCookie(req, COOKIE);
  if (token) await run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
  res.clearCookie(COOKIE);
}

export async function terminarSessoesDe(userId) {
  await run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export async function carregarUtilizador(req, res, next) {
  const token = lerCookie(req, COOKIE);
  req.user = null;
  if (token) {
    const u = await get(
      `SELECT u.id, u.username, u.nome, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expira_em > ? AND u.ativo = 1`,
      hashToken(token),
      agora(),
    );
    if (u) req.user = u;
  }
  next();
}

export function exigirLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

export function exigirAuditor(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'auditor') return res.status(403).send('Acesso reservado ao auditor.');
  next();
}

// Travão simples contra tentativas repetidas de login: 5 falhas bloqueiam 5 minutos. Guarda-se na base de dados
// (e não em memória) para valer entre instâncias, como acontece numa função sem estado.
const MAX_FALHAS = 5;
const BLOQUEIO_MS = 5 * 60e3;

export async function loginBloqueado(chave) {
  const f = await get('SELECT n, ultima FROM login_falhas WHERE chave = ?', chave);
  return Boolean(f && f.n >= MAX_FALHAS && Date.now() - f.ultima < BLOQUEIO_MS);
}
export async function registarFalha(chave) {
  // Passado o tempo de bloqueio, a contagem recomeça em 1.
  await run(
    `INSERT INTO login_falhas (chave, n, ultima) VALUES (?, 1, ?)
     ON CONFLICT (chave) DO UPDATE SET n = CASE WHEN excluded.ultima - login_falhas.ultima > ? THEN 1 ELSE login_falhas.n + 1 END, ultima = excluded.ultima`,
    chave, Date.now(), BLOQUEIO_MS,
  );
}
export async function limparFalhas(chave) {
  await run('DELETE FROM login_falhas WHERE chave = ?', chave);
}
