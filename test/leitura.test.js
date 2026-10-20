// A chave da API da Anthropic, definida pelo administrador: guarda-se encriptada e é o que a leitura de talões usa.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auditoria-leitura-'));
process.env.PGLITE_MEMORIA = '1';
process.env.ENCRYPTION_KEY = 'd'.repeat(64);
delete process.env.DATABASE_URL;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
const db = await import('../src/db.js');
const leitor = await import('../src/leitor.js');
after(() => db.fecharBaseDeDados());

const CHAVE = 'sk-ant-api03-' + 'x'.repeat(40) + 'WXYZ';

test('sem chave, a leitura diz ao utilizador o que fazer', async () => {
  assert.deepEqual(await leitor.estadoChave(), { origem: null, fim: '' });
  await assert.rejects(() => leitor.lerTaloes(Buffer.from([1, 2, 3]), 'image/jpeg'), (e) => e instanceof leitor.ErroLeitura && /Configuração › Leitura de talões/.test(e.message));
});

test('chave guardada: fica encriptada na base de dados e só se mostram os 4 últimos caracteres', async () => {
  await leitor.guardarChave(CHAVE);
  const estado = await leitor.estadoChave();
  assert.deepEqual(estado, { origem: 'base', fim: 'WXYZ' });
  const guardado = (await db.get("SELECT valor FROM config WHERE chave = 'anthropic_api_key'")).valor;
  assert.ok(guardado.startsWith('enc:v1:'));
  assert.ok(!guardado.includes('sk-ant'));
});

test('a chave da base de dados tem prioridade sobre a variável de ambiente; remover volta ao ambiente', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-do-ambiente-' + 'y'.repeat(20) + 'ABCD';
  assert.equal((await leitor.estadoChave()).origem, 'base');
  await leitor.removerChave();
  assert.deepEqual(await leitor.estadoChave(), { origem: 'ambiente', fim: 'ABCD' });
});

test('uma chave com formato errado é recusada sem chamar a rede', async () => {
  for (const mau of ['', 'abc', 'sk-ant-curta', 'chave com espaços sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxx']) {
    await assert.rejects(() => leitor.validarChave(mau), /não parece uma chave/);
  }
});
