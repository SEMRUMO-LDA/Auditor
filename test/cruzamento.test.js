// O cruzamento (diário x faturas x talões), a validação automática do TPA e a importação, com dados inventados.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auditoria-teste-'));
process.env.PGLITE_MEMORIA = '1';
process.env.ENCRYPTION_KEY = 'b'.repeat(64); // o cruzamento tem de funcionar com a encriptação ligada
delete process.env.DATABASE_URL;
const db = await import('../src/db.js');
const { reconciliar } = await import('../src/reconcile.js');
const { importar } = await import('../src/fechos.js');
const { validacaoDoDia, definirValidacao } = await import('../src/validacao.js');

const DIA = '2026-03-05';
const DIA2 = '2026-03-06';
let auditor;

const novoDia = (data) => db.run("INSERT INTO fechos (data, diario_ficheiro, faturas_ficheiro) VALUES (?, 'd.csv', 'f.csv')", data);
const mov = (data, doc, tipo, valor, hora, caixa = 'HOTEL1') =>
  db.run('INSERT INTO movimentos (data, utilizador, tipo, hora, doc, valor, caixa) VALUES (?, ?, ?, ?, ?, ?, ?)', data, 'AA', tipo, hora, doc, valor, caixa);
const fat = (data, doc, tipo, valor, reserva) =>
  db.run('INSERT INTO faturas (data, hotel, reserva, doc, valor, tipo) VALUES (?, ?, ?, ?, ?, ?)', data, 'Hotel 1', reserva, doc, valor, tipo);
async function talao(data, tipo, valor, hora, reservas = '', estado = 'confirmado') {
  const envio = await db.inserir('INSERT INTO envios (user_id, ficheiro, mime, criado_em, estado) VALUES (?, ?, ?, ?, ?)', auditor, 'x.jpg', 'image/jpeg', db.agora(), estado);
  return db.inserir('INSERT INTO taloes (envio_id, tipo, tpa, data, hora, valor, reservas) VALUES (?, ?, ?, ?, ?, ?, ?)', envio, tipo, 'T1', data, hora, valor, reservas);
}
const incs = (data, tipo) => db.all('SELECT * FROM inconsistencias WHERE data = ? AND tipo = ? AND ativa = 1 ORDER BY chave', data, tipo);

before(async () => {
  auditor = await db.inserir("INSERT INTO users (username, nome, pass_hash, role, criado_em) VALUES ('auditor', 'Auditor', 'x', 'auditor', ?)", db.agora());
  for (const [codigo, tpa] of [['CASH', 0], ['VISA', 1], ['MC', 1], ['TRFBANCO', 0]]) await db.run('INSERT INTO meios (codigo, tpa) VALUES (?, ?)', codigo, tpa);
});
after(() => db.fecharBaseDeDados());

test('cruzamento de um dia: o que falta e o que sobra', async () => {
  await novoDia(DIA);
  await mov(DIA, 'FR A/1', 'VISA', 100, '10:00:00');
  await mov(DIA, 'FR A/2', 'CASH', 50, '11:00:00');
  await mov(DIA, 'FR A/3', 'TRFBANCO', 70, '12:00:00'); // sem fatura
  await mov(DIA, '', 'MC', 20, '13:00:00'); // sem documento
  await mov(DIA, 'FR A/4', 'VISA', 40, '14:00:00');
  await fat(DIA, 'FR A/1', 'VISA', 100, '111');
  await fat(DIA, 'FR A/2', 'CASH', 50, '112');
  await fat(DIA, 'FR A/9', 'CASH', 10, '113'); // sem movimento
  await fat(DIA, 'FR A/4', 'VISA', 40, '114');
  const casado = await talao(DIA, 'compra', 100, '10:01:00', '111'); // casa com FR A/1
  await talao(DIA, 'compra', 30, '15:00:00', '999'); // reserva sem fatura
  await talao(DIA, 'fecho', 130, '23:00:00');
  await reconciliar(DIA);

  assert.equal((await db.get('SELECT doc_associado FROM taloes WHERE id = ?', casado)).doc_associado, 'FR A/1');
  assert.deepEqual((await incs(DIA, 'MOV_SEM_FATURA')).map((i) => i.chave), ['FR A/3|TRFBANCO|7000']);
  assert.deepEqual((await incs(DIA, 'FATURA_SEM_MOV')).map((i) => i.chave), ['FR A/9|CASH|1000']);
  assert.equal((await incs(DIA, 'MOV_SEM_DOC')).length, 1);
  const semRegisto = await incs(DIA, 'TALAO_SEM_FATURA');
  assert.equal(semRegisto.length, 1);
  assert.match(semRegisto[0].titulo, /30,00/);
  // os dois pagamentos de cartão que não têm talão: FR A/4 (40 €) e o MC sem documento (20 €)
  assert.deepEqual((await incs(DIA, 'CARTAO_SEM_TALAO')).map((i) => i.valor).sort((a, b) => a - b), [20, 40]);
  // fecho do terminal (130) = soma das compras enviadas (100 + 30)
  assert.equal((await incs(DIA, 'FECHO_VS_COMPRAS')).length, 0);
  const seq = await incs(DIA, 'SEQ_DOCS');
  assert.equal(seq.length, 1);
  assert.match(seq[0].titulo, /^Série FR A: 4 número/);
});

test('cruzar de novo não duplica e as notas do auditor sobrevivem', async () => {
  const antes = (await db.get('SELECT COUNT(*) AS n FROM inconsistencias WHERE data = ?', DIA)).n;
  const inc = (await incs(DIA, 'MOV_SEM_FATURA'))[0];
  await db.run("INSERT INTO historico (inconsistencia_id, user_id, quando, kind, texto) VALUES (?, ?, ?, 'nota', 'verificado')", inc.id, auditor, db.agora());
  await db.run("UPDATE inconsistencias SET estado = 'justificada' WHERE id = ?", inc.id);
  await reconciliar(DIA);
  await reconciliar(DIA);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM inconsistencias WHERE data = ?', DIA)).n, antes);
  const depois = await db.get('SELECT * FROM inconsistencias WHERE id = ?', inc.id);
  assert.equal(depois.estado, 'justificada');

  // o que deixa de ser detetado desaparece, exceto se tiver notas (fica como histórico)
  await db.run("DELETE FROM movimentos WHERE data = ? AND doc = 'FR A/3'", DIA);
  await reconciliar(DIA);
  const guardada = await db.get('SELECT ativa FROM inconsistencias WHERE id = ?', inc.id);
  assert.equal(guardada.ativa, 0);
});

test('TPA: valida-se sozinho quando os talões comprovam o valor por inteiro', async () => {
  await novoDia(DIA2);
  await mov(DIA2, 'FR B/1', 'VISA', 100, '10:00:00', 'C1');
  await mov(DIA2, 'FR B/2', 'VISA', 50, '11:00:00', 'C1');
  await mov(DIA2, 'FR B/3', 'CASH', 20, '12:00:00', 'C1');
  await fat(DIA2, 'FR B/1', 'VISA', 100, '201');
  await fat(DIA2, 'FR B/2', 'VISA', 50, '202');
  await fat(DIA2, 'FR B/3', 'CASH', 20, '203');
  await reconciliar(DIA2);
  assert.equal((await validacaoDoDia(DIA2)).canais.tpa.validado, false, 'sem talões não valida');

  await talao(DIA2, 'compra', 100, '10:01:00', '201', 'rascunho'); // conta mesmo por confirmar
  await reconciliar(DIA2);
  assert.equal((await validacaoDoDia(DIA2)).canais.tpa.validado, false, 'com um só talão ainda não valida');

  await talao(DIA2, 'compra', 50, '11:01:00', '202', 'confirmado');
  await reconciliar(DIA2);
  const tpa = (await validacaoDoDia(DIA2)).canais.tpa;
  assert.equal(tpa.validado, true);
  assert.equal(tpa.auto, true);
  assert.equal(tpa.taloes, 2);
  assert.equal(tpa.porConfirmar, 1);

  // um pagamento novo sem talão tira a validação
  await mov(DIA2, 'FR B/4', 'VISA', 25, '13:00:00', 'C1');
  assert.equal((await validacaoDoDia(DIA2)).canais.tpa.validado, false);
  await db.run("DELETE FROM movimentos WHERE doc = 'FR B/4'");
});

test('validação do auditor: valor guardado, total só com tudo validado, e muda se o valor mudar', async () => {
  let r = await validacaoDoDia(DIA2);
  assert.equal(r.exigidos, 2); // TPA e CASH
  assert.equal(r.validado, false);

  await definirValidacao(DIA2, 'cash', true, auditor);
  r = await validacaoDoDia(DIA2);
  assert.equal(r.canais.cash.validado, true);
  assert.equal(r.canais.cash.auto, undefined, 'a validação do auditor não é automática');
  assert.equal(r.validados, 2); // o TPA continua validado pelos talões
  assert.equal(r.validado, true);

  // o valor do diário muda depois de validado: a validação deixa de contar
  await db.run("UPDATE movimentos SET valor = 25 WHERE doc = 'FR B/3'");
  r = await validacaoDoDia(DIA2);
  assert.equal(r.canais.cash.validado, false);
  assert.equal(r.canais.cash.mudou, true);
  assert.equal(r.validado, false);

  await definirValidacao(DIA2, 'cash', true, auditor);
  assert.equal((await validacaoDoDia(DIA2)).validado, true);
  await definirValidacao(DIA2, 'cash', false, auditor);
  assert.equal((await validacaoDoDia(DIA2)).canais.cash.validado, false);
});

test('importar os ficheiros do PMS de um dia', async () => {
  const diario = [
    'Group22,Description9,Textbox161,Textbox162',
    'VISA,Visa,"100,00","150,00"',
    'CASH,Numerário,"50,00","150,00"',
    '',
    'BookingDate,UserCode,Group2,Group4,Description,CreatedOn,Textbox70,InterfaceDescription,Room,NAME1,uAmount,CashboxCode,Reason,Textbox108,DocDate',
    '07-03-2026,AA,Caixa,VISA,Visa,10:00:00,FR Z/1,,101,Ana,"100,00",HOTEL1,,"150,00",07-03-2026',
    '07-03-2026,AA,Caixa,CASH,Numerário,11:00:00,FR Z/2,,102,Rui,"50,00",HOTEL1,,"150,00",07-03-2026',
  ].join('\r\n');
  const faturas = [
    'HouseTypeDescription1,ResNo2,Room3,GuestName4,GlobalCheckin5,GlobalCheckout6,TotalResCost7,InvoiceDate8,InvoiceNo_Formatted9,Amount_Total10,BookingCode11,Res_Info12',
    'Hotel 1,301,101,Ana,05-03-2026,07-03-2026,"100,00",07-03-2026,FR Z/1,"100,00",VISA,',
    'Hotel 1,302,102,Rui,05-03-2026,07-03-2026,"50,00",07-03-2026,FR Z/2,"50,00",CASH,',
  ].join('\r\n');
  const r = await importar([{ nome: 'diario.csv', buffer: Buffer.from(diario) }, { nome: 'faturas.csv', buffer: Buffer.from(faturas) }], auditor);
  assert.equal(r.data, '2026-03-07');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM movimentos WHERE data = ?', r.data)).n, 2);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM faturas WHERE data = ?', r.data)).n, 2);
  assert.equal((await db.get('SELECT total_declarado AS t FROM fechos WHERE data = ?', r.data)).t, 150);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM caixas WHERE codigo = 'HOTEL1'")).n, 1);
  // diário e faturas batem certo: não há erros de cruzamento
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM inconsistencias WHERE data = ? AND gravidade = 'erro' AND ativa = 1", r.data)).n, 0);

  // carregar de novo substitui (não duplica)
  await importar([{ nome: 'diario.csv', buffer: Buffer.from(diario) }], auditor);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM movimentos WHERE data = ?', r.data)).n, 2);
});
