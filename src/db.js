// Base de dados: Postgres.
//  - Com DATABASE_URL, liga ao Postgres do Supabase (ou a qualquer Postgres).
//  - Sem DATABASE_URL, usa um Postgres local embebido (PGlite), na pasta data/pglite. O SQL é o mesmo nos dois.
// Todas as funções são assíncronas. O SQL usa "?" como marcador de parâmetros (convertido para $1, $2...).
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ESQUEMA, SEGURANCA } from './esquema.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
// Os talões novos ficam na base de dados. Esta pasta só serve para ler os ficheiros antigos (de antes dessa mudança).
export const UPLOAD_DIR = path.join(DATA_DIR, 'taloes');

// Numa função sem estado (Vercel) não há disco para escrever, as ligações são curtas e o esquema não se recria a cada arranque.
export const SEM_ESTADO = Boolean(process.env.VERCEL);
if (!SEM_ESTADO) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const URL_BD = (process.env.DATABASE_URL || '').trim();
export const DESTINO = URL_BD ? 'postgres' : 'local';
if (SEM_ESTADO && !URL_BD) {
  console.error('\nErro na base de dados: na Vercel é preciso definir a variável DATABASE_URL (Supabase).\n');
  process.exit(1);
}

class ErroBaseDeDados extends Error {}

function falhar(mensagem, causa) {
  const erro = new ErroBaseDeDados(mensagem);
  erro.cause = causa;
  console.error(`\nErro na base de dados: ${mensagem}\n`);
  process.exit(1);
}

// ---------- Ligação ----------
// Cada destino expõe: query(sql, params) -> { rows, rowCount }, exec(sql) para vários comandos, transaction(fn) e fechar().
async function ligarPostgres() {
  if (/\[[^\]]*(PASSWORD|PALAVRA|SENHA)[^\]]*\]/i.test(URL_BD)) {
    falhar('O DATABASE_URL ainda tem o marcador [YOUR-PASSWORD]. Substitua-o pela palavra-passe da base de dados do Supabase (sem os parênteses retos).');
  }
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(20, Number); // bigint (contagens, somas de inteiros) como número, como no SQLite
  pg.types.setTypeParser(1700, Number); // numeric
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(URL_BD);
  // O Supabase exige SSL. Por omissão não se verifica o certificado (DATABASE_SSL_VERIFICAR=1 para verificar).
  const ssl = process.env.DATABASE_SSL === 'off' || local ? false : { rejectUnauthorized: process.env.DATABASE_SSL_VERIFICAR === '1' };
  // Numa função sem estado, cada instância fica com poucas ligações (o "transaction pooler" do Supabase, porta 6543,
  // reparte-as); num servidor normal usa-se um conjunto maior.
  const pool = new pg.Pool({
    connectionString: URL_BD, ssl, max: Number(process.env.DATABASE_POOL) || (SEM_ESTADO ? 1 : 8),
    connectionTimeoutMillis: 15000, idleTimeoutMillis: SEM_ESTADO ? 5000 : 30000,
  });
  pool.on('error', (e) => console.error('Erro numa ligação inativa à base de dados:', e.message));
  return {
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(c);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    fechar: () => pool.end(),
  };
}

async function ligarLocal() {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const pasta = path.join(DATA_DIR, 'pglite');
  const bd = await PGlite.create(process.env.PGLITE_MEMORIA === '1' ? undefined : pasta, {
    parsers: { [types.INT8]: (v) => Number(v), [types.NUMERIC]: (v) => Number(v) },
  });
  const norm = (r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length });
  return {
    query: async (sql, params) => norm(await bd.query(sql, params)),
    exec: (sql) => bd.exec(sql),
    transaction: (fn) => bd.transaction((t) => fn({ query: async (sql, params) => norm(await t.query(sql, params)) })),
    fechar: () => bd.close(),
  };
}

const destino = URL_BD ? await ligarPostgres() : await ligarLocal();

// ---------- Consultas ----------
// Dentro de tx(), as consultas seguem sozinhas pela ligação da transação (mesmo noutras funções chamadas lá de dentro).
const contexto = new AsyncLocalStorage();
// Para medir o desempenho: com DEBUG_SQL=1, cada pedido regista quantas consultas fez e quanto tempo esperou pela base de dados.
const medicao = new AsyncLocalStorage();
export const medirPedido = (fn) => medicao.run({ consultas: 0, ms: 0 }, fn);
export const medicaoAtual = () => medicao.getStore();

const paraPostgres = (sql) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};
const limpar = (ps) => ps.map((p) => (p === undefined ? null : p));

// Só para testes: DEBUG_LATENCIA_MS=30 simula a viagem pela rede até uma base de dados remota.
const LATENCIA_MS = Number(process.env.DEBUG_LATENCIA_MS) || 0;

async function consultar(sql, ps) {
  if (LATENCIA_MS) await new Promise((r) => setTimeout(r, LATENCIA_MS));
  const ligacao = contexto.getStore() ?? destino;
  const m = medicao.getStore();
  if (m && process.env.DEBUG_SQL === '2') console.log(`   SQL> ${sql.replace(/\s+/g, ' ').slice(0, 110)}`);
  const inicio = m ? performance.now() : 0;
  try {
    return await ligacao.query(paraPostgres(sql), limpar(ps));
  } finally {
    if (m) {
      m.consultas++;
      m.ms += performance.now() - inicio;
    }
  }
}

export const all = async (sql, ...ps) => (await consultar(sql, ps)).rows;
export const get = async (sql, ...ps) => (await consultar(sql, ps)).rows[0];
export const run = async (sql, ...ps) => {
  const r = await consultar(sql, ps);
  return { changes: r.rowCount ?? 0 };
};
// INSERT numa tabela com coluna "id": devolve o id criado.
export const inserir = async (sql, ...ps) => (await get(`${sql} RETURNING id`, ...ps)).id;

export async function tx(fn) {
  if (contexto.getStore()) return fn(); // já dentro de uma transação: junta-se a ela
  return destino.transaction((ligacao) => contexto.run(ligacao, fn));
}

export const agora = () => new Date().toISOString();

export async function config(chave, omissao) {
  return (await get('SELECT valor FROM config WHERE chave = ?', chave))?.valor ?? omissao;
}
export async function guardarConfig(chave, valor) {
  await run('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor', chave, String(valor));
}

export const fecharBaseDeDados = () => destino.fechar();

// ---------- Esquema ----------
// Cria as tabelas que faltarem (e liga o RLS). Num servidor normal faz-se a cada arranque; na Vercel não (cada arranque
// a frio pagaria ~40 comandos pela rede): corra "npm run esquema" ou DATABASE_ESQUEMA=1 quando o esquema mudar.
export const CRIAR_ESQUEMA = process.env.DATABASE_ESQUEMA ? process.env.DATABASE_ESQUEMA !== '0' : !SEM_ESTADO;
export async function criarEsquema() {
  await destino.exec(ESQUEMA);
  await destino.exec(SEGURANCA);
}
try {
  if (CRIAR_ESQUEMA) await criarEsquema();
} catch (e) {
  const motivo = e?.code === 'ENETUNREACH' || /ENETUNREACH|EHOSTUNREACH/.test(String(e?.message))
    ? 'Não consegui chegar ao servidor. O endereço "db.<projeto>.supabase.co" só funciona com IPv6; use o endereço do "Session pooler" (aws-0-…pooler.supabase.com) do painel Connect do Supabase.'
    : e?.code === '28P01' || /password authentication failed/i.test(String(e?.message))
      ? 'Palavra-passe ou utilizador errados no DATABASE_URL.'
      : e?.code === 'ENOTFOUND' ? 'O endereço do servidor no DATABASE_URL não existe.'
        : e?.code === 'ETIMEDOUT' || /timeout/i.test(String(e?.message)) ? 'O servidor não respondeu a tempo (rede ou firewall).'
          : `${e?.message || e}`;
  falhar(`Não consegui preparar a base de dados (${DESTINO === 'postgres' ? 'DATABASE_URL' : 'Postgres local'}). ${motivo}`, e);
}
