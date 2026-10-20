// A camada de dados (Postgres): consultas, identidades, transações e segurança. Corre no Postgres embebido, em memória.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auditoria-teste-'));
process.env.PGLITE_MEMORIA = '1';
delete process.env.DATABASE_URL;
const db = await import('../src/db.js');
const { TABELAS } = await import('../src/esquema.js');
after(() => db.fecharBaseDeDados());

const novoUtilizador = (nome) => db.inserir('INSERT INTO users (username, nome, pass_hash, role, criado_em) VALUES (?, ?, ?, ?, ?)', nome, nome, 'x', 'auditor', db.agora());

test('o esquema cria todas as tabelas', async () => {
  const existentes = (await db.all("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).map((t) => t.table_name);
  for (const t of TABELAS) assert.ok(existentes.includes(t), `falta a tabela ${t}`);
});

test('segurança: todas as tabelas têm o RLS ligado (a chave pública do Supabase não lê nada)', async () => {
  const semRls = (await db.all("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity")).map((r) => r.relname);
  assert.deepEqual(semRls, []);
});

test('inserir devolve o id e os números vêm como números', async () => {
  const id = await novoUtilizador('Ana');
  assert.equal(typeof id, 'number');
  assert.equal(typeof (await db.get('SELECT COUNT(*) AS n FROM users')).n, 'number');
  assert.equal(typeof (await db.get('SELECT SUM(ativo) AS s FROM users')).s, 'number');
  assert.equal((await db.get('SELECT 1.5::double precision AS x')).x, 1.5);
});

test('o nome de utilizador não distingue maiúsculas de minúsculas', async () => {
  await assert.rejects(() => novoUtilizador('ANA'), (e) => e.code === '23505');
  assert.ok(await db.get('SELECT id FROM users WHERE lower(username) = lower(?)', 'aNa'));
});

test('transação: confirma tudo ou desfaz tudo', async () => {
  await assert.rejects(() => db.tx(async () => {
    await db.run("INSERT INTO caixas (codigo) VALUES ('A')");
    throw new Error('falha a meio');
  }), /falha a meio/);
  assert.equal((await db.all('SELECT * FROM caixas')).length, 0);

  await db.tx(async () => {
    await db.run("INSERT INTO caixas (codigo) VALUES ('B')");
    await db.run("INSERT INTO caixas (codigo) VALUES ('a')");
  });
  // ordenação binária, como no SQLite: maiúsculas antes das minúsculas
  assert.deepEqual((await db.all('SELECT codigo FROM caixas ORDER BY codigo')).map((c) => c.codigo), ['B', 'a']);
});

test('transações em simultâneo não se misturam', async () => {
  await Promise.all([1, 2, 3, 4].map((i) => db.tx(async () => {
    await db.run('INSERT INTO caixas (codigo) VALUES (?)', `T${i}`);
    await new Promise((r) => setTimeout(r, 15));
    await db.run('INSERT INTO caixas (codigo) VALUES (?)', `U${i}`);
  })));
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM caixas WHERE codigo LIKE 'T%' OR codigo LIKE 'U%'")).n, 8);
});

test('uma transação dentro de outra junta-se a ela (e desfaz-se com ela)', async () => {
  await assert.rejects(() => db.tx(async () => {
    await db.run("INSERT INTO caixas (codigo) VALUES ('X1')");
    await db.tx(async () => db.run("INSERT INTO caixas (codigo) VALUES ('X2')"));
    throw new Error('desfaz');
  }));
  assert.equal((await db.all("SELECT * FROM caixas WHERE codigo LIKE 'X%'")).length, 0);
});

test('configuração: guardar e ler, com atualização no conflito', async () => {
  assert.equal(await db.config('prazo_dias', 'omissao'), 'omissao');
  await db.guardarConfig('prazo_dias', 9);
  await db.guardarConfig('prazo_dias', 12);
  assert.equal(await db.config('prazo_dias', 'omissao'), '12');
});

test('apagar um envio apaga os seus talões (em cascata)', async () => {
  const user = await novoUtilizador('Rui');
  const envio = await db.inserir("INSERT INTO envios (user_id, ficheiro, mime, criado_em) VALUES (?, 'x.jpg', 'image/jpeg', ?)", user, db.agora());
  await db.run("INSERT INTO taloes (envio_id, tipo, tpa, data, valor) VALUES (?, 'compra', '1', '2026-01-01', 10)", envio);
  await db.run('DELETE FROM envios WHERE id = ?', envio);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM taloes WHERE envio_id = ?', envio)).n, 0);
});
