// Relatório de pagamentos da Booking.com ("Payout") e cruzamento com as faturas TBBOOKING do PMS. Dados inventados.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auditoria-booking-'));
process.env.PGLITE_MEMORIA = '1';
delete process.env.DATABASE_URL;
const db = await import('../src/db.js');
const { identificar, ErroFicheiro } = await import('../src/parsers.js');
const { importar } = await import('../src/fechos.js');
const { mesmaPropriedade, cruzarBooking } = await import('../src/booking.js');
after(() => db.fecharBaseDeDados());

const CAB = 'Reference number,Check-in date,Check-out date,Issue date,Property ID,Property name,Payout type,Gross amount,Transaction amount,Transaction currency,Payable amount,Payout amount,Payout date';
// Como o relatório real: uma linha de total por propriedade (referência "-") e depois as reservas.
const PAYOUT = [
  CAB,
  '-,-,-,-,1,"Hotel Peregrinos de Fatima by Umbral",Gross,-,-,-,32.40,32.40,2026-10-19',
  '1001,2026-10-17,2026-10-18,2026-10-18,1,"Hotel Peregrinos de Fatima by Umbral",Gross,32.40,32.40,EUR,32.40,-,2026-10-19',
  '-,-,-,-,2,"Apartamentos Vale de Carros by Umbral",Gross,-,-,-,55.00,55.00,2026-10-19',
  '1002,2026-10-17,2026-10-18,2026-10-18,2,"Apartamentos Vale de Carros by Umbral",Gross,55.00,55.00,EUR,55.00,-,2026-10-19',
  '-,-,-,-,3,"Eirasol by Umbral",Gross,-,-,-,380.00,380.00,2026-10-19',
  '1003,2026-10-13,2026-10-18,2026-10-18,3,"Eirasol by Umbral",Gross,380.00,380.00,EUR,380.00,-,2026-10-19',
  '',
].join('\n');

const FATURAS_DIA = [
  'HouseTypeDescription1,ResNo2,Room3,GuestName4,GlobalCheckin5,GlobalCheckout6,TotalResCost7,InvoiceDate8,InvoiceNo_Formatted9,Amount_Total10,BookingCode11,Res_Info12',
  'Peregrinos de Fátima,501,103PF,"Silva, Ana",17-10-2026,18-10-2026,"32,40",20-10-2026,FR Z/1,"32,40",TBBOOKING,',
  'Vale Carros,502,116VC,"Costa, Rui",17-10-2026,18-10-2026,"54,00",20-10-2026,FR Z/2,"54,00",TBBOOKING,',
  'Huma,503,502HUMA,"Lima, Rita",17-10-2026,18-10-2026,"70,00",20-10-2026,FR Z/3,"70,00",TBBOOKING,',
  'ImperHotel,504,105IMP,"Rocha, Rui",08-10-2026,10-10-2026,"90,00",20-10-2026,FR Z/4,"90,00",TBBOOKING,',
  'Huma,505,503HUMA,"Pinto, Eva",18-10-2026,19-10-2026,"40,00",20-10-2026,FR Z/5,"40,00",VISA,',
].join('\r\n');

test('o relatório de pagamentos da Booking.com é reconhecido (valores com ponto decimal e linhas de total)', () => {
  const r = identificar(Buffer.from(PAYOUT));
  assert.equal(r.tipo, 'booking');
  assert.equal(r.data, '2026-10-18');
  assert.equal(r.pagamentos.length, 3, 'as linhas de total por propriedade não são reservas');
  assert.deepEqual(r.pagamentos.map((p) => p.bruto), [32.4, 55, 380]);
  assert.equal(r.pagamentos[0].checkin, '2026-10-17');
  assert.equal(r.pagamentos[0].pagamento_data, '2026-10-19');
  assert.equal(r.pagamentos[0].propriedade, 'Hotel Peregrinos de Fatima by Umbral');
  assert.equal(Object.values(r.totais).reduce((s, v) => s + v, 0), 467.4);
  assert.throws(() => identificar(Buffer.from('Reference number,Payout type\n-,Gross\n')), (e) => e instanceof ErroFicheiro && /faltam as colunas/.test(e.message));
});

test('o nome da propriedade do PMS e o da Booking reconhecem-se apesar das diferenças de escrita', () => {
  const casos = [
    ['Peregrinos de Fátima', 'Hotel Peregrinos de Fatima by Umbral', true],
    ['Vale Carros', 'Apartamentos Vale de Carros by Umbral', true],
    ['Pátio Vitória', 'Apartamentos Pátio Victória by Umbral', true],
    ['Residencial Campo Mar', 'Residencial Campo-Mar by Umbral', true],
    ['Casa do Vale', 'Casa Do Vale Hotel by Umbral', true],
    ['ImperHotel', 'Imperhotel by Umbral', true],
    ['Vale Carros', 'Casa Do Vale Hotel by Umbral', false],
    ['Apartamentos Atlântico', 'Cerro Atlantico by Umbral', false],
    ['Huma', 'Hotel Rosa Mística by Umbral', false],
  ];
  for (const [pms, booking, esperado] of casos) assert.equal(mesmaPropriedade(pms, booking), esperado, `${pms} ~ ${booking}`);
});

test('as faturas TBBOOKING procuram o pagamento da Booking em qualquer dia; os pagamentos esperam pela fatura', async () => {
  // Primeiro o dia 20/10 com as faturas (de check-outs de 18/10 e 10/10) e só depois o relatório da Booking de 18/10.
  await importar([{ nome: 'faturas.csv', buffer: Buffer.from(FATURAS_DIA) }], null);
  assert.equal((await cruzarBooking('2026-10-20')).carregado, false, 'sem relatório da Booking não há cruzamento');
  assert.equal((await db.all("SELECT 1 FROM inconsistencias WHERE tipo LIKE 'BOOKING%'")).length, 0);

  const r = await importar([{ nome: 'Payout_from_2026-10-19_until_2026-10-19.csv', buffer: Buffer.from(PAYOUT) }], null);
  assert.equal(r.data, '2026-10-18');
  assert.equal(r.ficheiros[0].descricao, 'pagamentos da Booking.com');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM booking_pagamentos')).n, 3);
  assert.equal((await db.get("SELECT booking_ficheiro FROM fechos WHERE data = '2026-10-18'")).booking_ficheiro, 'Payout_from_2026-10-19_until_2026-10-19.csv');

  // o dia 20/10 foi cruzado de novo ao carregar o relatório
  const c = await cruzarBooking('2026-10-20');
  assert.equal(c.carregado, true);
  assert.deepEqual(c.ligados.map((l) => l.item.doc), ['FR Z/1'], 'só a de 32,40 (propriedade, datas e valor iguais)');
  assert.equal(c.ligados[0].propriedadeConfere, true);
  assert.deepEqual(c.semPagamento.map((i) => i.doc).sort(), ['FR Z/2', 'FR Z/3'], '54 ≠ 55 (valor), e a Huma não tem pagamento; ambas com relatório do dia 18/10');
  assert.deepEqual(c.semRelatorio.map((i) => i.doc), ['FR Z/4'], 'o check-out de 10/10 não tem relatório da Booking carregado: nada a assinalar');

  const incs = await db.all("SELECT tipo, chave, gravidade, titulo FROM inconsistencias WHERE data = '2026-10-20' AND tipo LIKE 'BOOKING%' AND ativa = 1 ORDER BY chave");
  assert.deepEqual(incs.map((i) => i.chave), ['FR Z/2|5400', 'FR Z/3|7000']);
  assert.ok(incs.every((i) => i.tipo === 'BOOKING_SEM_PAGAMENTO' && i.gravidade === 'aviso'));

  // os pagamentos de 18/10 sem fatura (Vale de Carros 55 e Eirasol 380) esperam: só informação
  const sem = await db.all("SELECT gravidade, titulo FROM inconsistencias WHERE data = '2026-10-18' AND tipo = 'BOOKING_SEM_FATURA' AND ativa = 1");
  assert.equal(sem.length, 1);
  assert.equal(sem[0].gravidade, 'info', 'só passaram 2 dias até ao último dia carregado (20/10): o PMS ainda pode faturar');
  assert.match(sem[0].titulo, /2 pagamento\(s\) deste dia \(435,00/);
});

test('um pagamento da Booking que continua sem fatura passados vários dias passa a aviso', async () => {
  const mais = FATURAS_DIA.split('\r\n').slice(0, 2).join('\r\n').replaceAll('20-10-2026', '30-10-2026').replace('FR Z/1', 'FR Z/99');
  await importar([{ nome: 'faturas-30.csv', buffer: Buffer.from(mais) }], null);
  const { reconciliar } = await import('../src/reconcile.js');
  await reconciliar('2026-10-18');
  const sem = await db.get("SELECT gravidade FROM inconsistencias WHERE data = '2026-10-18' AND tipo = 'BOOKING_SEM_FATURA' AND ativa = 1");
  assert.equal(sem.gravidade, 'aviso', '30/10 − 18/10 = 12 dias');
});

test('carregar o mesmo relatório outra vez não duplica nada', async () => {
  await importar([{ nome: 'Payout.csv', buffer: Buffer.from(PAYOUT) }], null);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM booking_pagamentos')).n, 3);
});
