// Documentos FA: faturas dos operadores, em conta corrente (pagamento a 30 dias). Dados inventados.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auditoria-fa-'));
process.env.PGLITE_MEMORIA = '1';
delete process.env.DATABASE_URL;
const db = await import('../src/db.js');
const { importar } = await import('../src/fechos.js');
after(() => db.fecharBaseDeDados());

const cabecalho = ['Reservation number', 'Check-In', 'Check-Out', 'Unit', 'Guest', 'Agency', 'Pax', 'Market', 'Dist. Channel', 'Info', 'Total Price', 'Status', 'User'];
const linha = (reserva, total) => [reserva, '16-10-2026', '20-10-2026', 'Hotel Exemplo', 'Hóspede ' + reserva, '', 2, '', '', '', total, 'Confirmed', 'rec'];
const tabela = (linhas) => `<table><tr>${cabecalho.map((c) => `<th>${c}</th>`).join('')}</tr>${linhas.map((l) => `<tr>${l.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
const LISTA = tabela([linha('900001', '117,35'), linha('900002', '100,00'), linha('900003', '100,00'), linha('900004', '50,00')]);
const FATURAS = [
  '﻿HouseTypeDescription,resno,room,GuestName2,GlobalCheckIn,GlobalCheckOut,TotalResCost,InvoiceNo_formatted,amount_total2,BookingCode,res_info',
  'Hotel Exemplo,900001,101,"Operador, A",16/10/2026,20/10/2026,"117,35",FA 1021201/10,"0,00",,',
  'Hotel Exemplo,900002,102,"Costa, Rui",16/10/2026,20/10/2026,"100,00",FR 1021300/20,"60,00",VISA,',
  'Hotel Exemplo,900004,104,"Silva, Ana",16/10/2026,20/10/2026,"50,00",FR 1021300/21,"50,00",CASH,',
  'Hotel Exemplo,900004,104,"Silva, Ana",16/10/2026,20/10/2026,"50,00",FA 1021201/11,"0,00",,',
].join('\n');

test('uma reserva faturada com documento FA conta como faturada; as outras regras mantêm-se', async () => {
  const r = await importar([{ nome: 'saidas.xls', buffer: Buffer.from(LISTA) }, { nome: 'faturas.csv', buffer: Buffer.from(FATURAS) }], null);
  assert.equal(r.data, '2026-10-20');
  const incs = await db.all("SELECT tipo, chave, titulo FROM inconsistencias WHERE data = ? AND ativa = 1 ORDER BY tipo, chave", r.data);
  const por = (tipo) => incs.filter((i) => i.tipo === tipo);

  // 900001: só FA → faturada a operador, sem "faturada abaixo" nem "sem fatura"
  assert.ok(!por('RESERVA_FATURADA_ABAIXO').some((i) => i.chave.includes('900001')));
  assert.ok(!por('RESERVA_SEM_FATURA').some((i) => i.chave.includes('900001')));
  const fa = por('RESERVAS_COM_FA');
  assert.equal(fa.length, 1);
  assert.match(fa[0].titulo, /1 reserva\(s\) faturadas a operadores com documento FA \(117,35/);
  const detalhe = JSON.parse((await db.get("SELECT detalhe_json FROM inconsistencias WHERE tipo = 'RESERVAS_COM_FA'")).detalhe_json);
  assert.equal(detalhe.registos.length, 1);
  assert.equal(detalhe.registos[0]['Documento FA'], 'FA 1021201/10');
  assert.match(detalhe.texto, /conta corrente e com pagamento a 30 dias/);

  // 900002: paga só 60 de 100 e sem FA → continua "faturada abaixo"
  assert.ok(por('RESERVA_FATURADA_ABAIXO').some((i) => i.chave.includes('900002')));
  // 900003: sem nenhuma fatura → continua "sem fatura"
  assert.ok(por('RESERVA_SEM_FATURA').some((i) => i.chave.includes('900003')));
  // 900004: totalmente paga (FR) + uma FA de valor 0 → não aparece em nada
  for (const i of incs) assert.ok(!i.chave.includes('900004'), `a reserva 900004 não devia gerar ${i.tipo}`);
});

test('uma fatura FA emitida no dia não pede movimento de caixa (é conta corrente), mas as FR continuam a pedir', async () => {
  const diario = [
    'Group22,Description9,Textbox161,Textbox162',
    'CASH,Numerário,"20,00","20,00"',
    '',
    'BookingDate,UserCode,Group2,Group4,Description,CreatedOn,Textbox70,InterfaceDescription,Room,NAME1,uAmount,CashboxCode,Reason,Textbox108,DocDate',
    '21-10-2026,AA,Caixa,CASH,Numerário,11:00:00,FR Z/2,,102,Rui,"20,00",HOTEL1,,"20,00",21-10-2026',
  ].join('\r\n');
  const faturas = [
    'HouseTypeDescription1,ResNo2,Room3,GuestName4,GlobalCheckin5,GlobalCheckout6,TotalResCost7,InvoiceDate8,InvoiceNo_Formatted9,Amount_Total10,BookingCode11,Res_Info12',
    'Hotel 1,800001,101,Operador,19-10-2026,21-10-2026,"90,00",21-10-2026,FA 1021201/50,"0,00",,',
    'Hotel 1,800002,102,Rui,19-10-2026,21-10-2026,"20,00",21-10-2026,FR Z/2,"20,00",CASH,',
    'Hotel 1,800003,103,Ana,19-10-2026,21-10-2026,"30,00",21-10-2026,FR Z/3,"30,00",CASH,',
  ].join('\r\n');
  const r = await importar([{ nome: 'diario.csv', buffer: Buffer.from(diario) }, { nome: 'faturas.csv', buffer: Buffer.from(faturas) }], null);
  const semMov = await db.all("SELECT titulo FROM inconsistencias WHERE data = ? AND tipo = 'FATURA_SEM_MOV' AND ativa = 1", r.data);
  assert.equal(semMov.length, 1, 'só a FR Z/3 (30,00 em CASH sem movimento); a FA não');
  assert.match(semMov[0].titulo, /FR Z\/3/);
});
