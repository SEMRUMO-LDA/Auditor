// Relatório "Invoices by Check-in" sem a coluna da data da fatura (exportado por check-out/check-in). Dados inventados.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auditoria-parsers-'));
process.env.PGLITE_MEMORIA = '1';
delete process.env.DATABASE_URL;
const db = await import('../src/db.js');
const { identificar, ErroFicheiro } = await import('../src/parsers.js');
const { importar } = await import('../src/fechos.js');
after(() => db.fecharBaseDeDados());

// Sem InvoiceDate, datas dd/mm/aaaa, BOM no início, campos com várias linhas e milhares com espaço.
const CSV = [
  '﻿HouseTypeDescription,resno,room,GuestName2,GlobalCheckIn,GlobalCheckOut,TotalResCost,InvoiceNo_formatted,amount_total2,BookingCode,res_info',
  'Hotel Exemplo,100001,101EX,"Silva, Ana",16/10/2026,20/10/2026,"117,35",FA 1021201/1,"0,00",,"caução link"',
  'Hotel Exemplo,100002,102EX,"Costa, Rui",16/10/2026,20/10/2026,"3 906,48",FR 1021300/2,"163,56",TRFBANCO,"Pag conf',
  'Caução link "',
  'Hotel Exemplo,100003,,"TESTE, TESTE",18/10/2026,20/10/2026,"90,36",,,,',
  'Hotel Exemplo,100001,101EX,"Silva, Ana",16/10/2026,20/10/2026,"117,35",FR 1021300/3,"117,35",VISA,',
  '',
].join('\n');

test('reconhece-se o relatório sem data da fatura como faturas das saídas do dia do check-out', () => {
  const r = identificar(Buffer.from(CSV));
  assert.equal(r.tipo, 'faturas_reserva');
  assert.equal(r.lado, 'saida');
  assert.equal(r.data, '2026-10-20');
  assert.equal(r.faturas.length, 3, 'só as linhas com documento; a reserva sem fatura fica de fora');
  assert.deepEqual(r.faturas.map((f) => f.valor), [0, 163.56, 117.35]);
  assert.equal(r.faturas[1].tipo, 'TRFBANCO');
  assert.equal(r.faturas[1].info, 'Pag conf Caução link');
  assert.equal(r.faturas[1].total_reserva, 3906.48);
  assert.equal(r.faturas[0].data, null, 'sem data da fatura');
});

test('importa-se e fica como faturas das saídas desse dia', async () => {
  const out = await importar([{ nome: 'HFO_Fin_InvoicesByCheckin.csv', buffer: Buffer.from(CSV) }], null);
  assert.equal(out.data, '2026-10-20');
  assert.equal(out.ficheiros[0].descricao, 'faturas das saídas');
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM faturas_reserva WHERE data = '2026-10-20' AND lado = 'saida'")).n, 3);
  assert.equal((await db.get('SELECT saidas_faturas FROM fechos WHERE data = ?', '2026-10-20')).saidas_faturas, 'HFO_Fin_InvoicesByCheckin.csv');
});

test('um relatório com faturas mas sem datas de check-in/out repetidas continua a ser recusado com mensagem clara', () => {
  const variado = CSV.replace('16/10/2026,20/10/2026,"117,35",FR 1021300/3', '10/10/2026,25/10/2026,"117,35",FR 1021300/3').replace('18/10/2026,20/10/2026,"90,36"', '12/10/2026,22/10/2026,"90,36"');
  assert.throws(() => identificar(Buffer.from(variado)), (e) => e instanceof ErroFicheiro && /datas de check-in e de check-out variam/.test(e.message));
});

// ---------- Lista de reservas (.xls que é uma tabela HTML) ----------
const { parseListaReservas } = await import('../src/parsers.js');
const html = (linhas) => `<html><body><table>${linhas.map((l, i) => `<tr>${l.map((c) => `<t${i === 0 ? 'h' : 'd'}>${c}</t${i === 0 ? 'h' : 'd'}>`).join('')}</tr>`).join('')}</table></body></html>`;
const CAB = ['Reservation number', 'Check-In', 'Check-Out', 'Unit', 'Guest', 'Agency', 'Pax', 'Market', 'Dist. Channel', 'Info', 'Total Price', 'Status', 'User'];
const RES = (n) => [n, '16-10-2026', '20-10-2026', 'Hotel Exemplo', 'Hóspede', '', '2', '', '', '', '117,35', 'Confirmed', 'rec'];

test('lista de reservas: formato habitual', () => {
  const r = parseListaReservas(Buffer.from(html([CAB, RES('1'), RES('2')])));
  assert.equal(r.reservas.length, 2);
  assert.equal(r.lado, 'saida');
  assert.equal(r.data, '2026-10-20');
  assert.equal(r.reservas[0].total, 117.35);
});

test('lista de reservas: cabeçalho que não é a primeira linha e nomes de colunas com outra grafia', () => {
  const cab = ['reservation  number', 'CHECK IN', 'check-out', 'unit', 'guest', 'agency', 'pax', 'market', 'dist channel', 'info', 'Total price', 'STATUS', 'user'];
  const tabelaComTitulo = `<table><tr><td>Lista de reservas</td></tr><tr><td></td></tr><tr>${cab.map((c) => `<td>${c}</td>`).join('')}</tr>${[RES('7'), RES('8')].map((l) => `<tr>${l.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
  const r = parseListaReservas(Buffer.from(tabelaComTitulo));
  assert.deepEqual(r.reservas.map((x) => x.reserva), ['7', '8']);
  assert.equal(r.reservas[0].status, 'Confirmed');
});

test('lista de reservas: sem uma coluna obrigatória, a mensagem diz quais faltam e quais foram encontradas', () => {
  const semTotal = CAB.filter((c) => c !== 'Total Price' && c !== 'Status');
  assert.throws(
    () => parseListaReservas(Buffer.from(html([semTotal, RES('1').slice(0, 11).filter((_, i) => i !== 10)]))),
    (e) => e instanceof ErroFicheiro && /faltam as colunas Total Price, Status\. Colunas encontradas: Reservation number, Check-In/.test(e.message),
  );
});
