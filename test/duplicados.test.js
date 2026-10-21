// Talões repetidos: o mesmo ficheiro e o mesmo talão (outra fotografia do mesmo papel).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auditoria-dup-'));
process.env.PGLITE_MEMORIA = '1';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
delete process.env.DATABASE_URL;
const db = await import('../src/db.js');
const cifra = await import('../src/cifra.js');
const { hashFicheiro, envioComFicheiro, taloesRepetidos, descreverRepetido } = await import('../src/duplicados.js');
const { preencherHashes } = await import('../src/migracao.js');
after(() => db.fecharBaseDeDados());

const user = await db.inserir("INSERT INTO users (username, nome, pass_hash, role, criado_em) VALUES ('d', 'D', 'x', 'auditor', ?)", db.agora());
const novoEnvio = (hash = null) => db.inserir("INSERT INTO envios (user_id, ficheiro, mime, criado_em, hash) VALUES (?, 'a.jpg', 'image/jpeg', ?, ?)", user, db.agora(), hash);
const novoTalao = (envio, t) => db.run(
  'INSERT INTO taloes (envio_id, tipo, tpa, data, hora, valor, ultimos4) VALUES (?, ?, ?, ?, ?, ?, ?)',
  envio, t.tipo ?? 'compra', t.tpa, t.data, t.hora, t.valor, cifra.cifrarTexto(t.ultimos4 ?? null),
);
const TALAO = { tipo: 'compra', tpa: '01401532', data: '2026-10-07', hora: '09:50:38', valor: 59, ultimos4: '1234' };

test('o mesmo ficheiro é reconhecido pela impressão digital', async () => {
  const bytes = Buffer.from([255, 216, 255, 1, 2, 3]);
  const e = await novoEnvio(hashFicheiro(bytes));
  assert.equal((await envioComFicheiro(hashFicheiro(bytes)))?.id, e);
  assert.equal(await envioComFicheiro(hashFicheiro(Buffer.from([9, 9]))), undefined);
  assert.equal(await envioComFicheiro(hashFicheiro(bytes), e), undefined, 'ignora o próprio envio');
});

test('o mesmo talão noutra fotografia é repetido; qualquer diferença relevante torna-o novo', async () => {
  const e1 = await novoEnvio();
  await novoTalao(e1, TALAO);
  const e2 = await novoEnvio();
  const verifica = async (t) => (await taloesRepetidos([{ ...TALAO, ...t }], e2))[0];

  const r = await verifica({});
  assert.equal(r.envio_id, e1);
  assert.ok(await verifica({ valor: 59.004 }), 'diferença de meio cêntimo é o mesmo valor');
  assert.ok(await verifica({ hora: '09:50:38', ultimos4: null }), 'sem os 4 dígitos, compara o resto');
  assert.equal(await verifica({ valor: 59.01 }), null, 'valor diferente');
  assert.equal(await verifica({ hora: '09:50:39' }), null, 'hora diferente');
  assert.equal(await verifica({ data: '2026-10-08' }), null, 'dia diferente');
  assert.equal(await verifica({ tpa: '99' }), null, 'terminal diferente');
  assert.equal(await verifica({ ultimos4: '9999' }), null, 'cartão diferente (outro cliente, mesmo minuto)');
  assert.equal(await verifica({ tipo: 'fecho', ultimos4: null }), null, 'tipo diferente');
  assert.equal(await verifica({ hora: null }), null, 'sem hora não se pode afirmar que é repetido');
  assert.equal((await taloesRepetidos([TALAO], e1))[0], null, 'o próprio envio não conta');
});

test('a hora com e sem segundos é a mesma; e dois iguais na mesma fotografia são apanhados', async () => {
  const e1 = await novoEnvio();
  await novoTalao(e1, { ...TALAO, tpa: '77', hora: '10:15' }); // guardado sem segundos
  const e2 = await novoEnvio();
  assert.ok((await taloesRepetidos([{ ...TALAO, tpa: '77', hora: '10:15:00' }], e2))[0]);

  const dois = await taloesRepetidos([{ ...TALAO, tpa: '55' }, { ...TALAO, tpa: '55' }, { ...TALAO, tpa: '56' }], e2);
  assert.deepEqual(dois.map((x) => (x ? Object.keys(x)[0] : null)), [null, 'dentro', null]);
  assert.equal(dois[1].dentro, 1);
});

test('a mensagem diz que talão é e onde já está', async () => {
  const texto = descreverRepetido(TALAO, { envio_id: 4, criado_em: '2026-10-20T11:18:00.000Z' }, 2);
  assert.match(texto, /^Talão 2: compra do terminal 01401532, 07\/10\/2026 às 09:50:38, 59,00/);
  assert.match(texto, /já foi enviado \(envio #4/);
  assert.match(descreverRepetido(TALAO, { dentro: 1 }, 2), /igual ao talão 1 desta mesma fotografia/);
});

test('envios antigos sem impressão digital recebem-na a partir do ficheiro guardado (mesmo cifrado)', async () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7]);
  const e = await novoEnvio(null);
  await db.run('INSERT INTO envio_ficheiros (envio_id, conteudo) VALUES (?, ?)', e, cifra.cifrarBytes(bytes));
  assert.ok((await preencherHashes()) >= 1);
  assert.equal((await db.get('SELECT hash FROM envios WHERE id = ?', e)).hash, hashFicheiro(bytes));
  assert.equal(await preencherHashes(), 0, 'segunda vez: nada a fazer');
});
