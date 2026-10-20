// Encriptação dos dados sensíveis: texto, ficheiros, chaves e integração com a base de dados (Postgres em memória).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auditoria-cifra-'));
process.env.PGLITE_MEMORIA = '1';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
delete process.env.DATABASE_URL;
const cifra = await import('../src/cifra.js');
const db = await import('../src/db.js');
after(() => db.fecharBaseDeDados());

test('texto: cifra, decifra, e o que não está cifrado passa sem alteração', () => {
  const c = cifra.cifrarTexto('VISA ****1234');
  assert.ok(c.startsWith('enc:v1:'));
  assert.ok(!c.includes('1234'));
  assert.equal(cifra.decifrarTexto(c), 'VISA ****1234');
  assert.equal(cifra.decifrarTexto('texto antigo, em claro'), 'texto antigo, em claro');
  assert.equal(cifra.cifrarTexto(null), null);
  assert.equal(cifra.cifrarTexto(''), '');
  assert.equal(cifra.cifrarTexto(c), c, 'não cifra duas vezes');
  assert.notEqual(cifra.cifrarTexto('x'), cifra.cifrarTexto('x'), 'cada cifra usa um IV novo');
});

test('ficheiros: o conteúdo binário volta intacto e o cifrado não deixa ver o original', () => {
  const original = Buffer.concat([Buffer.from('%PDF-1.7 '), Buffer.from([0, 1, 2, 255, 254])]);
  const c = cifra.cifrarBytes(original);
  assert.ok(!c.includes(Buffer.from('%PDF')));
  assert.deepEqual(cifra.decifrarBytes(c), original);
  assert.deepEqual(cifra.decifrarBytes(original), original, 'ficheiro antigo, em claro, passa sem alteração');
});

test('dados alterados ou chave errada não se decifram', () => {
  const c = cifra.cifrarTexto('segredo');
  const partes = Buffer.from(c.slice(7), 'base64');
  partes[partes.length - 1] ^= 1; // um bit alterado
  assert.throws(() => cifra.decifrarTexto('enc:v1:' + partes.toString('base64')), /decifrar/);
});

test('na base de dados fica cifrado, mas a app lê o valor original', async () => {
  const user = await db.inserir("INSERT INTO users (username, nome, pass_hash, role, criado_em) VALUES ('c', 'C', 'x', 'auditor', ?)", db.agora());
  const envio = await db.inserir("INSERT INTO envios (user_id, ficheiro, mime, criado_em) VALUES (?, 'a.jpg', 'image/jpeg', ?)", user, db.agora());
  const foto = Buffer.from([255, 216, 255, 1, 2, 3]);
  await db.run('INSERT INTO envio_ficheiros (envio_id, conteudo) VALUES (?, ?)', envio, cifra.cifrarBytes(foto));
  await db.run(
    "INSERT INTO taloes (envio_id, tipo, tpa, data, valor, cartao, ultimos4) VALUES (?, 'compra', '1', '2026-01-01', 10, ?, ?)",
    envio, cifra.cifrarTexto('MASTERCARD'), cifra.cifrarTexto('9876'),
  );
  // o que está guardado (sem passar pelas colunas cifradas, que a leitura decifra)
  const guardado = await db.get(
    "SELECT cartao LIKE 'enc:v1:%' AS c1, ultimos4 LIKE 'enc:v1:%' AS c2, position('9876' in ultimos4) AS pos FROM taloes WHERE envio_id = ?", envio,
  );
  assert.equal(guardado.c1, true);
  assert.equal(guardado.c2, true);
  assert.equal(guardado.pos, 0);
  const bruto = await db.get("SELECT substring(conteudo from 1 for 4) = 'ENC1'::bytea AS cifrado FROM envio_ficheiros WHERE envio_id = ?", envio);
  assert.equal(bruto.cifrado, true);
  // o que a app vê
  const t = await db.get('SELECT cartao, ultimos4 FROM taloes WHERE envio_id = ?', envio);
  assert.deepEqual({ ...t }, { cartao: 'MASTERCARD', ultimos4: '9876' });
  const f = await db.get('SELECT conteudo FROM envio_ficheiros WHERE envio_id = ?', envio);
  assert.deepEqual(Buffer.from(f.conteudo), foto);
});

test('o detalhe das inconsistências guarda-se cifrado e lê-se normalmente', async () => {
  const detalhe = JSON.stringify({ texto: 'Hóspede João Silva', registos: [{ Cartão: 'VISA ****1111' }] });
  await db.run(
    "INSERT INTO inconsistencias (data, tipo, chave, gravidade, titulo, detalhe_json, criada_em, atualizada_em) VALUES ('2026-01-01', 'T', 'k', 'aviso', 't', ?, ?, ?)",
    cifra.cifrarTexto(detalhe), db.agora(), db.agora(),
  );
  const bruto = await db.get("SELECT position('Silva' in detalhe_json) AS pos FROM inconsistencias WHERE chave = 'k'");
  assert.equal(bruto.pos, 0, 'o nome do hóspede não aparece na base de dados');
  assert.equal((await db.get("SELECT detalhe_json FROM inconsistencias WHERE chave = 'k'")).detalhe_json, detalhe);
});
