// Pagamentos da Booking.com ("Payout"): guardar o relatório e cruzá-lo com os documentos TBBOOKING do PMS.
// O pagamento da Booking de cada reserva (referência da Booking, check-in, check-out, valor) liga-se à fatura TBBOOKING do PMS
// pela propriedade (nome), pelas datas de check-in/check-out e pelo valor.
import { all, run, tx, agora } from './db.js';

// ---------- Guardar ----------
// Cada linha (referência, tipo, dia de check-out, data de pagamento) guarda-se uma vez: carregar o mesmo relatório de novo
// atualiza-a em vez de a duplicar.
export async function guardarBooking(dados, nomeFicheiro) {
  const colunas = ['ref', 'tipo', 'checkin', 'checkout', 'emitida', 'propriedade_id', 'propriedade', 'bruto', 'a_pagar', 'moeda', 'pagamento_data', 'ficheiro', 'importado_em'];
  const quando = agora();
  const dias = [...new Set(dados.pagamentos.map((p) => p.emitida))].sort();
  await tx(async () => {
    const porLote = Math.floor(3000 / colunas.length);
    for (let i = 0; i < dados.pagamentos.length; i += porLote) {
      const grupo = dados.pagamentos.slice(i, i + porLote);
      await run(
        `INSERT INTO booking_pagamentos (${colunas.join(', ')}) VALUES ${grupo.map(() => `(${colunas.map(() => '?').join(', ')})`).join(', ')}
         ON CONFLICT (ref, tipo, emitida, pagamento_data) DO UPDATE SET checkin = excluded.checkin, checkout = excluded.checkout,
           propriedade_id = excluded.propriedade_id, propriedade = excluded.propriedade, bruto = excluded.bruto, a_pagar = excluded.a_pagar,
           moeda = excluded.moeda, ficheiro = excluded.ficheiro, importado_em = excluded.importado_em`,
        ...grupo.flatMap((p) => [p.ref, p.tipo, p.checkin, p.checkout, p.emitida, p.propriedade_id, p.propriedade, p.bruto, p.a_pagar, p.moeda, p.pagamento_data, nomeFicheiro, quando]),
      );
    }
    // O relatório fica associado ao dia principal (que passa a existir) e aos outros dias que já tenham fecho.
    await run('INSERT INTO fechos (data) VALUES (?) ON CONFLICT(data) DO NOTHING', dados.data);
    for (const d of dias) await run('UPDATE fechos SET booking_ficheiro = ?, booking_em = ? WHERE data = ?', nomeFicheiro, quando, d);
  });
  return dias;
}

// ---------- Nomes das propriedades ----------
// "Hotel Peregrinos de Fatima by Umbral" (Booking) e "Peregrinos de Fátima" (PMS) são a mesma propriedade.
const PALAVRAS_VAZIAS = new Set(['hotel', 'apartamentos', 'apartamento', 'residencial', 'casa', 'guesthouse', 'by', 'umbral', 'de', 'da', 'das', 'do', 'dos', 'the']);
const ACENTOS = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g'); // marcas de acentuação (depois de normalizar)
const ficha = (nome) => String(nome ?? '').toLowerCase().normalize('NFD').replace(ACENTOS, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((p) => p && !PALAVRAS_VAZIAS.has(p));

function distancia(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Palavras iguais, ou parecidas (uma letra de diferença, como "Vitória" e "Victória"), quando têm 5 letras ou mais.
const palavraIgual = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && distancia(a, b) <= 1);
export function mesmaPropriedade(nomePMS, nomeBooking) {
  const a = ficha(nomePMS);
  const b = ficha(nomeBooking);
  if (!a.length || !b.length || a.length !== b.length) return false;
  return a.every((p) => b.some((q) => palavraIgual(p, q))) && b.every((q) => a.some((p) => palavraIgual(p, q)));
}

// ---------- Cruzamento ----------
// A Booking paga cada reserva no dia do check-out ("Issue date"), mas o PMS só emite a fatura TBBOOKING alguns dias depois (num
// dia pode haver faturas de check-outs de vários dias anteriores). Por isso o cruzamento não é "dia a dia": cada fatura
// TBBOOKING procura o seu pagamento em todos os relatórios carregados.
const cent = (v) => Math.round((v ?? 0) * 100);
const DIAS_PARA_FATURAR = 5; // depois destes dias, um pagamento da Booking ainda sem fatura passa de informação a aviso

// Liga cada fatura TBBOOKING (por ordem de dia) ao pagamento da Booking com a mesma propriedade, check-in, check-out e valor;
// cada pagamento serve uma só fatura.
async function ligarTudo() {
  const pagamentos = (await all("SELECT * FROM booking_pagamentos WHERE tipo = 'Gross' AND bruto > 0 ORDER BY emitida, id")).map((p) => ({ ...p, usado: false }));
  const faturas = await all("SELECT id, data, doc, hotel, reserva, quarto, hospede, checkin, checkout, valor FROM faturas WHERE tipo = 'TBBOOKING' AND valor > 0 ORDER BY data, id");
  const candidatos = (f, comPropriedade) => pagamentos.filter((p) => !p.usado && p.checkin === f.checkin && p.checkout === f.checkout && cent(p.bruto) === cent(f.valor)
    && (!comPropriedade || mesmaPropriedade(f.hotel, p.propriedade)));
  const ligadas = new Map();
  for (const f of faturas) {
    const exato = candidatos(f, true)[0];
    // Sem a propriedade certa: só se for a única possibilidade (os nomes do PMS e da Booking podem diferir muito).
    const unico = !exato && candidatos(f, false).length === 1 ? candidatos(f, false)[0] : null;
    const p = exato || unico;
    if (p) {
      p.usado = true;
      ligadas.set(f.id, { pagamento: p, propriedadeConfere: Boolean(exato) });
    }
  }
  return { pagamentos, faturas, ligadas, cobertos: new Set(pagamentos.map((p) => p.emitida)) };
}

// O que há a dizer sobre o dia: faturas TBBOOKING ligadas ou não a pagamentos da Booking, e pagamentos do dia ainda sem fatura.
// { carregado, ligados: [{ item, pagamento, propriedadeConfere }], semPagamento: [item] (com relatório da Booking desse check-out),
//   semRelatorio: [item] (não há relatório carregado para esse check-out), pagamentosDoDia, semFatura: [pagamento], atrasados: boolean }
export async function cruzarBooking(data) {
  const { pagamentos, faturas, ligadas, cobertos } = await ligarTudo();
  if (!pagamentos.length) return { carregado: false };
  const doDia = faturas.filter((f) => f.data === data);
  const ligados = [];
  const semPagamento = [];
  const semRelatorio = [];
  for (const item of doDia) {
    const l = ligadas.get(item.id);
    if (l) ligados.push({ item, ...l });
    else if (cobertos.has(item.checkout)) semPagamento.push(item);
    else semRelatorio.push(item);
  }
  const pagamentosDoDia = pagamentos.filter((p) => p.emitida === data);
  const semFatura = pagamentosDoDia.filter((p) => !p.usado);
  const ultimo = (await all('SELECT MAX(data) AS d FROM fechos'))[0]?.d || data;
  const atrasados = (new Date(ultimo) - new Date(data)) / 86400e3 > DIAS_PARA_FATURAR;
  return {
    carregado: true, ligados, semPagamento, semRelatorio, pagamentosDoDia, semFatura, atrasados,
    totalPago: ligados.reduce((s, l) => s + cent(l.pagamento.bruto), 0),
    totalFaturas: doDia.reduce((s, f) => s + cent(f.valor), 0),
  };
}
