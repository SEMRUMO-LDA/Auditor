// Leitura das exportações do PMS: "Diário de Caixa" e "Invoices by Check-in".

export class ErroFicheiro extends Error {}

export function descodificar(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le').slice(1);
  const texto = buffer.toString('utf8').replace(/^﻿/, '');
  // Se o ficheiro não for UTF-8 válido (exportação antiga em Windows-1252), relê-se nessa codificação.
  return texto.includes('�') ? buffer.toString('latin1') : texto;
}

export function parseCSV(texto) {
  const linhas = [];
  let linha = [];
  let campo = '';
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else aspas = false;
      } else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ',') {
      linha.push(campo);
      campo = '';
    } else if (c === '\n') {
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = '';
    } else if (c !== '\r') campo += c;
  }
  if (campo.length || linha.length) {
    linha.push(campo);
    linhas.push(linha);
  }
  return linhas;
}

// "4 536,04" -> 4536.04
export function numero(s) {
  const limpo = String(s ?? '').replace(/[\s €]/g, '').replace(/\./g, '').replace(',', '.');
  if (limpo === '') return null;
  const n = Number(limpo);
  return Number.isFinite(n) ? n : null;
}

// "05-10-2026" ou "05/10/2026" -> "2026-10-05"
export function dataISO(s) {
  const m = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(String(s ?? '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function dataUnica(datas, nomeFicheiro) {
  const distintas = [...new Set(datas.filter(Boolean))].sort();
  if (distintas.length === 0) throw new ErroFicheiro(`O ${nomeFicheiro} não tem nenhuma linha com data.`);
  if (distintas.length > 1) {
    throw new ErroFicheiro(
      `O ${nomeFicheiro} contém mais de um dia (${distintas.join(', ')}). Exporte um dia de cada vez.`,
    );
  }
  return distintas[0];
}

const vazia = (linha) => linha.every((c) => c === '');

export function parseDiario(buffer) {
  const linhas = parseCSV(descodificar(buffer));
  const resumo = [];
  const movimentos = [];
  let cabecalho = null;
  let bloco = null;

  for (const linha of linhas) {
    if (vazia(linha)) {
      cabecalho = null;
      bloco = null;
      continue;
    }
    if (!cabecalho) {
      cabecalho = linha;
      bloco = linha.includes('UserCode') && linha.includes('uAmount') ? 'movimentos' : linha.includes('Group22') ? 'resumo' : null;
      continue;
    }
    const campo = (nome) => {
      const i = cabecalho.indexOf(nome);
      return i < 0 ? '' : (linha[i] ?? '').trim();
    };
    if (bloco === 'resumo') {
      const valor = numero(campo('Textbox161'));
      if (campo('Group22') && valor !== null) {
        resumo.push({ tipo: campo('Group22'), descricao: campo('Description9'), valor, total: numero(campo('Textbox162')) });
      }
    } else if (bloco === 'movimentos') {
      const valor = numero(campo('uAmount'));
      if (valor === null) continue;
      movimentos.push({
        data: dataISO(campo('BookingDate')),
        utilizador: campo('UserCode'),
        secao: campo('Group2'),
        tipo: campo('Group4'),
        tipo_desc: campo('Description'),
        hora: campo('CreatedOn'),
        doc: campo('Textbox70'),
        obs: campo('InterfaceDescription'),
        quarto: campo('Room'),
        nome: campo('NAME1'),
        valor,
        caixa: campo('CashboxCode'),
        motivo: campo('Reason').replace(/^Cancelamento:\s*/, ''),
        total_utilizador: numero(campo('Textbox108')),
        doc_data: dataISO(campo('DocDate')),
      });
    }
  }

  if (!movimentos.length) {
    throw new ErroFicheiro('Não reconheço este ficheiro como um Diário de Caixa (não encontrei movimentos).');
  }
  return {
    data: dataUnica(movimentos.map((m) => m.data), 'diário de caixa'),
    resumo,
    movimentos,
    totalDeclarado: resumo[0]?.total ?? null,
  };
}

// Lê todas as linhas do relatório "Invoices by Check-in", incluindo as de reservas ainda sem fatura
// (que vêm com o documento vazio e a data 01/01/1900).
function lerRelatorioFaturas(texto) {
  const linhas = parseCSV(texto);
  // Os nomes das colunas trazem um sufixo numérico que pode mudar ("resno6"), por isso ignora-se.
  const cabecalho = (linhas[0] || []).map((c) => c.trim().replace(/\d+$/, '').toLowerCase());
  const col = (nome) => cabecalho.indexOf(nome);
  const idx = {
    hotel: col('housetypedescription'),
    reserva: col('resno'),
    quarto: col('room'),
    hospede: col('guestname'),
    checkin: col('globalcheckin'),
    checkout: col('globalcheckout'),
    total_reserva: col('totalrescost'),
    data: col('invoicedate'),
    doc: col('invoiceno_formatted'),
    valor: col('amount_total'),
    tipo: col('bookingcode'),
    info: col('res_info'),
  };
  if (idx.doc < 0 || idx.valor < 0 || idx.reserva < 0 || idx.data < 0) {
    throw new ErroFicheiro('Não reconheço este ficheiro como o relatório de faturas (faltam colunas esperadas).');
  }
  const campo = (linha, i) => (i < 0 ? '' : (linha[i] ?? '').trim());
  const todas = [];
  for (const linha of linhas.slice(1)) {
    if (vazia(linha) || !campo(linha, idx.reserva)) continue;
    const doc = campo(linha, idx.doc);
    todas.push({
      data: doc ? dataISO(campo(linha, idx.data)) : null,
      hotel: campo(linha, idx.hotel),
      reserva: campo(linha, idx.reserva),
      quarto: campo(linha, idx.quarto),
      hospede: campo(linha, idx.hospede),
      checkin: dataISO(campo(linha, idx.checkin)),
      checkout: dataISO(campo(linha, idx.checkout)),
      total_reserva: numero(campo(linha, idx.total_reserva)),
      doc,
      valor: numero(campo(linha, idx.valor)) ?? 0,
      tipo: campo(linha, idx.tipo),
      info: campo(linha, idx.info).replace(/\s+/g, ' ').trim(),
    });
  }
  return todas;
}

// Relatório de faturas exportado pela data da fatura: as faturas emitidas num dia.
export function parseFaturas(buffer) {
  const faturas = lerRelatorioFaturas(descodificar(buffer)).filter((f) => f.doc);
  if (!faturas.length) throw new ErroFicheiro('O relatório de faturas não tem nenhuma linha.');
  return { data: dataUnica(faturas.map((f) => f.data), 'relatório de faturas'), faturas };
}

// O valor mais frequente de um campo e quantas linhas o têm.
function moda(linhas, campo) {
  const contagem = new Map();
  for (const l of linhas) if (l[campo]) contagem.set(l[campo], (contagem.get(l[campo]) || 0) + 1);
  return [...contagem].sort((a, b) => b[1] - a[1])[0] || [null, 0];
}

// O mesmo relatório serve três exportações. Distinguem-se pelo conteúdo: por data da fatura todas as
// linhas têm fatura do mesmo dia; por check-out (saídas) ou check-in (entradas) é essa data que se repete.
function classificarRelatorio(todas) {
  if (!todas.length) throw new ErroFicheiro('O relatório de faturas não tem nenhuma linha.');
  const comFatura = todas.filter((f) => f.doc);
  if (comFatura.length === todas.length && new Set(comFatura.map((f) => f.data)).size === 1) {
    return { tipo: 'faturas', data: comFatura[0].data, faturas: comFatura };
  }
  const [diaSaida, nSaida] = moda(todas, 'checkout');
  const [diaEntrada, nEntrada] = moda(todas, 'checkin');
  if (Math.max(nSaida, nEntrada) < todas.length * 0.9) {
    throw new ErroFicheiro('Não consigo perceber de que dia é este relatório de faturas: as datas de check-in e de check-out variam.');
  }
  const lado = nSaida >= nEntrada ? 'saida' : 'entrada';
  return { tipo: 'faturas_reserva', lado, data: lado === 'saida' ? diaSaida : diaEntrada, faturas: comFatura };
}

const ENTIDADES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const semHtml = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTIDADES[n.toLowerCase()] ?? m)
    .trim();

// Lista de reservas exportada do PMS (.xls que na verdade é uma tabela HTML), com uma linha por quarto.
export function parseListaReservas(buffer) {
  const html = descodificar(buffer);
  const linhas = html
    .split(/<tr[^>]*>/i)
    .slice(1)
    .map((tr) => [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => semHtml(m[1])));
  const cabecalho = linhas[0] || [];
  const col = (nome) => cabecalho.indexOf(nome);
  const idx = {
    reserva: col('Reservation number'), checkin: col('Check-In'), checkout: col('Check-Out'), unidade: col('Unit'),
    hospede: col('Guest'), agencia: col('Agency'), pax: col('Pax'), mercado: col('Market'), canal: col('Dist. Channel'),
    info: col('Info'), total: col('Total Price'), status: col('Status'), criada_por: col('User'),
  };
  if (idx.reserva < 0 || idx.checkin < 0 || idx.checkout < 0 || idx.total < 0 || idx.status < 0) {
    throw new ErroFicheiro('Não reconheço este ficheiro como uma lista de reservas (faltam colunas esperadas).');
  }
  const campo = (linha, i) => (i < 0 ? '' : (linha[i] ?? '').trim());
  const reservas = linhas.slice(1).filter((l) => campo(l, idx.reserva)).map((l) => ({
    reserva: campo(l, idx.reserva),
    checkin: dataISO(campo(l, idx.checkin)),
    checkout: dataISO(campo(l, idx.checkout)),
    unidade: campo(l, idx.unidade),
    hospede: campo(l, idx.hospede),
    agencia: campo(l, idx.agencia),
    pax: Number(campo(l, idx.pax)) || 0,
    mercado: campo(l, idx.mercado),
    canal: campo(l, idx.canal),
    info: campo(l, idx.info).replace(/\s+/g, ' ').trim(),
    total: numero(campo(l, idx.total)) ?? 0,
    status: campo(l, idx.status),
    criada_por: campo(l, idx.criada_por),
  }));
  if (!reservas.length) throw new ErroFicheiro('A lista de reservas não tem nenhuma linha.');
  const [diaSaida, nSaida] = moda(reservas, 'checkout');
  const [diaEntrada, nEntrada] = moda(reservas, 'checkin');
  const lado = nSaida >= nEntrada ? 'saida' : 'entrada';
  return { tipo: 'lista', lado, data: lado === 'saida' ? diaSaida : diaEntrada, reservas };
}

// Reconhece qualquer um dos ficheiros do dia pelo conteúdo, sem depender do nome.
export function identificar(buffer) {
  const inicio = buffer.subarray(0, 6000).toString('latin1');
  if (/<table/i.test(inicio)) return parseListaReservas(buffer);
  if (inicio.includes('UserCode') || inicio.includes('Group22')) return { tipo: 'diario', ...parseDiario(buffer) };
  if (/InvoiceNo_formatted/i.test(inicio)) return classificarRelatorio(lerRelatorioFaturas(descodificar(buffer)));
  throw new ErroFicheiro('Não reconheço este ficheiro. São aceites o diário de caixa, os relatórios de faturas e as listas de reservas.');
}
