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

// ---------- Google Gemini ----------
const CHAVE_GEMINI = 'AIzaSy' + 'g'.repeat(33);
const resposta = (estado, corpo) => new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), { status: estado, headers: { 'content-type': 'application/json' } });
const TALAO = { tipo: 'compra', tpa: '01595874', data: '2026-10-19', hora: '12:30:15', valor: 85.5, cartao: 'VISA', ultimos4: '1234', num_compras: null, id_reserva: '123456, 654321', id_reserva_duvidoso: false, legivel: true };
let pedidos;
const simular = (fn) => { pedidos = []; globalThis.fetch = async (url, opcoes) => { pedidos.push({ url: String(url), opcoes }); return fn(String(url), opcoes); }; };
const fetchReal = globalThis.fetch;
after(() => { globalThis.fetch = fetchReal; });

test('Gemini: validar a chave (e o modelo) antes de guardar', async () => {
  simular(() => resposta(400, { error: { status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }));
  await assert.rejects(() => leitor.validarChave(CHAVE_GEMINI, 'gemini'), /não aceitou esta chave/);
  simular(() => resposta(200, { models: [] }));
  assert.deepEqual(await leitor.validarChave(CHAVE_GEMINI, 'gemini'), { confirmada: true });
  assert.equal(pedidos[0].opcoes.headers['x-goog-api-key'], CHAVE_GEMINI, 'a chave vai no cabeçalho, não no endereço');
  assert.ok(!pedidos[0].url.includes(CHAVE_GEMINI));
  simular((url) => (url.includes('/models/modelo-que-nao-existe') ? resposta(404, {}) : resposta(200, {})));
  await assert.rejects(() => leitor.validarChave(CHAVE_GEMINI, 'gemini', 'modelo-que-nao-existe'), /não existe/);
  simular(() => { throw new Error('sem rede'); });
  assert.deepEqual(await leitor.validarChave(CHAVE_GEMINI, 'gemini'), { confirmada: false });
  await assert.rejects(() => leitor.validarChave('curta', 'gemini'), /não parece uma chave/);
});

test('Gemini: guardar a chave torna-o o fornecedor em uso, encriptada na base de dados', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await leitor.guardarChave(CHAVE_GEMINI, 'gemini', { modelo: '' });
  const e = await leitor.estadoLeitura();
  assert.equal(e.ativo, 'gemini');
  assert.deepEqual({ ...e.fornecedores.gemini }, { origem: 'base', fim: 'gggg', modelo: leitor.MODELO_GEMINI_OMISSAO });
  assert.equal(e.fornecedores.anthropic.origem, null);
  const guardado = (await db.get("SELECT valor FROM config WHERE chave = 'gemini_api_key'")).valor;
  assert.ok(guardado.startsWith('enc:v1:') && !guardado.includes('AIza'));
});

test('Gemini: lê um talão (pedido bem formado, resposta normalizada, mesmo dentro de um bloco de código)', async () => {
  const foto = Buffer.from([255, 216, 255, 224, 1, 2, 3]);
  simular(() => resposta(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '```json\n' + JSON.stringify({ taloes: [TALAO, { ...TALAO, tipo: 'outro' }] }) + '\n```' }] } }] }));
  const lidos = await leitor.lerTaloes(foto, 'image/jpeg');
  assert.equal(lidos.length, 1, 'o tipo "outro" é ignorado');
  assert.deepEqual({ ...lidos[0] }, { tipo: 'compra', tpa: '01595874', data: '2026-10-19', hora: '12:30:15', valor: 85.5, cartao: 'VISA', ultimos4: '1234', reserva: '123456,654321', duvidoso: false });
  const [p] = pedidos;
  assert.ok(p.url.endsWith(`/models/${leitor.MODELO_GEMINI_OMISSAO}:generateContent`));
  assert.equal(p.opcoes.headers['x-goog-api-key'], CHAVE_GEMINI);
  const corpo = JSON.parse(p.opcoes.body);
  assert.equal(corpo.contents[0].parts[0].inlineData.mimeType, 'image/jpeg');
  assert.deepEqual(Buffer.from(corpo.contents[0].parts[0].inlineData.data, 'base64'), foto);
  assert.equal(corpo.generationConfig.responseMimeType, 'application/json');
  assert.match(corpo.systemInstruction.parts[0].text, /id_reserva/);
});

test('Gemini: erros do serviço viram mensagens claras para o utilizador', async () => {
  const foto = Buffer.from([1, 2, 3]);
  const caso = async (fn, esperado) => { simular(fn); await assert.rejects(() => leitor.lerTaloes(foto, 'image/png'), (e) => e instanceof leitor.ErroLeitura && esperado.test(e.message)); };
  await caso(() => resposta(403, {}), /chave da API não é válida/);
  await caso(() => resposta(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }), /chave da API não é válida/);
  await caso(() => resposta(429, {}), /limite de uso/);
  await caso(() => resposta(404, {}), /não está disponível/);
  await caso(() => resposta(500, {}), /erro \(500\)/);
  await caso(() => resposta(200, { promptFeedback: { blockReason: 'SAFETY' } }), /recusou/);
  await caso(() => resposta(200, { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{' }] } }] }), /incompleta/);
  await caso(() => resposta(200, { candidates: [{ content: { parts: [{ text: 'isto não é JSON' }] } }] }), /não foi possível interpretar/);
  await caso(() => { throw new Error('sem rede'); }, /contactar o serviço/);
});

test('escolher o fornecedor: só com chave, e remover o ativo passa para o outro', async () => {
  await assert.rejects(() => leitor.definirAtivo('anthropic'), /Adicione primeiro a chave/);
  await assert.rejects(() => leitor.definirAtivo('outro'), /desconhecido/);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-do-ambiente-' + 'y'.repeat(20) + 'ABCD';
  await leitor.definirAtivo('anthropic');
  assert.equal((await leitor.estadoLeitura()).ativo, 'anthropic');
  await leitor.definirAtivo('gemini');
  assert.equal((await leitor.estadoLeitura()).ativo, 'gemini');
  await leitor.removerChave('gemini');
  assert.equal((await leitor.estadoLeitura()).ativo, 'anthropic', 'sem chave Gemini, volta ao Anthropic (variável de ambiente)');
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await leitor.estadoLeitura()).ativo, null);
});
