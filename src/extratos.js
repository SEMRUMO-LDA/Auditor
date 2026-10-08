// Leitura de extratos bancários e de relatórios de pagamentos (Booking.com e Stripe).
// Os ficheiros chegam em CSV, em Excel (.xlsx) ou em .xls "HTML" (como as exportações do PMS). Como cada banco
// usa colunas diferentes, as colunas são reconhecidas pelo nome do cabeçalho (em português ou inglês).
import zlib from 'node:zlib';
import { descodificar } from './parsers.js';
import { tabelaXLS, ErroXLS } from './xls.js';

export class ErroExtrato extends Error {}

const MAX_LINHAS = 20000;

// ---------- Texto, números e datas ----------
export const normalizar = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// "1.234,56" · "1,234.56" · "-12,5" · "(12,50)" · "12,50 EUR" -> número (null se não for número)
export function numeroFlex(s) {
  let t = String(s ?? '').trim();
  if (t === '') return null;
  let negativo = false;
  if (/^\(.*\)$/.test(t)) {
    negativo = true;
    t = t.slice(1, -1);
  }
  t = t.replace(/[^\d,.\-+]/g, '');
  if (t.endsWith('-')) {
    negativo = !negativo;
    t = t.slice(0, -1);
  }
  if (t.startsWith('-')) {
    negativo = !negativo;
    t = t.slice(1);
  }
  t = t.replace(/^\+/, '');
  if (!/\d/.test(t)) return null;
  const ponto = t.lastIndexOf('.');
  const virgula = t.lastIndexOf(',');
  if (ponto >= 0 && virgula >= 0) {
    t = virgula > ponto ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (virgula >= 0) {
    const partes = t.split(',');
    t = partes.length === 2 && partes[1].length <= 2 ? `${partes[0]}.${partes[1]}` : partes.join('');
  } else if (ponto >= 0) {
    const partes = t.split('.');
    // "1.234" ou "1.234.567" são milhares; "12.5" e "12.50" são decimais.
    if (partes.length > 2 || (partes.length === 2 && partes[1].length === 3)) t = partes.join('');
  }
  const n = Number(t);
  return Number.isFinite(n) ? (negativo ? -n : n) : null;
}

const serialExcel = (n) => {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  return d.toISOString().slice(0, 10);
};

// Aceita 2026-10-07, 07/10/2026, 07-10-2026, 07.10.2026, 07/10/26, datas com hora e números de série do Excel.
export function dataFlex(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  let m = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(t);
  if (m) return valida(m[1], m[2], m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(t);
  if (m) return valida(m[3], m[2], m[1]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})(?!\d)/.exec(t);
  if (m) return valida(`20${m[3]}`, m[2], m[1]);
  if (/^\d{5}(\.\d+)?$/.test(t) && Number(t) > 25000 && Number(t) < 80000) return serialExcel(Number(t));
  return null;
}
function valida(a, m, d) {
  const ano = Number(a);
  const mes = Number(m);
  const dia = Number(d);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || ano < 2000 || ano > 2100) return null;
  return `${a}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// ---------- Ler a tabela do ficheiro (CSV, HTML ou XLSX) ----------
function entidades(t) {
  return t
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function tabelaHTML(texto) {
  const linhas = [];
  for (const tr of texto.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const celulas = [...tr[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => entidades(c[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim());
    if (celulas.length) linhas.push(celulas);
  }
  return linhas;
}

function separador(texto) {
  const amostra = texto.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let melhor = ',';
  let pontos = 0;
  for (const sep of [';', '\t', ',', '|']) {
    const total = amostra.reduce((s, l) => s + (l.split(sep).length - 1), 0);
    if (total > pontos) {
      pontos = total;
      melhor = sep;
    }
  }
  return melhor;
}

function tabelaDelimitada(texto, sep) {
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
    else if (c === sep) {
      linha.push(campo.trim());
      campo = '';
    } else if (c === '\n') {
      linha.push(campo.trim());
      linhas.push(linha);
      linha = [];
      campo = '';
    } else if (c !== '\r') campo += c;
  }
  if (campo.length || linha.length) {
    linha.push(campo.trim());
    linhas.push(linha);
  }
  return linhas.filter((l) => l.some((c) => c !== ''));
}

// Leitor mínimo de .xlsx: só a primeira folha, com texto, números e datas (em série).
function entradasZip(buffer) {
  let fim = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      fim = i;
      break;
    }
  }
  if (fim < 0) throw new ErroExtrato('O ficheiro Excel está corrompido.');
  const total = buffer.readUInt16LE(fim + 10);
  let pos = buffer.readUInt32LE(fim + 16);
  const entradas = new Map();
  for (let k = 0; k < total; k++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const metodo = buffer.readUInt16LE(pos + 10);
    const tamanho = buffer.readUInt32LE(pos + 20);
    const nomeLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const comentLen = buffer.readUInt16LE(pos + 32);
    const local = buffer.readUInt32LE(pos + 42);
    const nome = buffer.toString('utf8', pos + 46, pos + 46 + nomeLen);
    entradas.set(nome, { metodo, tamanho, local });
    pos += 46 + nomeLen + extraLen + comentLen;
  }
  return entradas;
}
function lerEntrada(buffer, e) {
  const nomeLen = buffer.readUInt16LE(e.local + 26);
  const extraLen = buffer.readUInt16LE(e.local + 28);
  const inicio = e.local + 30 + nomeLen + extraLen;
  const dados = buffer.subarray(inicio, inicio + e.tamanho);
  return e.metodo === 0 ? dados : zlib.inflateRawSync(dados);
}
const colunaIndice = (ref) => {
  let n = 0;
  for (const c of /^[A-Z]+/.exec(ref)[0]) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
};
function tabelaXLSX(buffer) {
  const entradas = entradasZip(buffer);
  const texto = (nome) => (entradas.has(nome) ? lerEntrada(buffer, entradas.get(nome)).toString('utf8') : '');
  const partilhadas = [...texto('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
    entidades([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')),
  );
  const folhas = [...entradas.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (!folhas.length) throw new ErroExtrato('O ficheiro Excel não tem nenhuma folha.');
  const xml = texto(folhas[0]);
  const linhas = [];
  for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const linha = [];
    for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+\d+)"/.exec(c[1]);
      if (!ref) continue;
      const tipo = /t="([^"]*)"/.exec(c[1])?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] || '')?.[1];
      let valor = '';
      if (tipo === 's' && v !== undefined) valor = partilhadas[Number(v)] ?? '';
      else if (tipo === 'inlineStr') valor = entidades([...(c[2] || '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
      else if (v !== undefined) valor = entidades(v);
      linha[colunaIndice(ref[1])] = valor;
    }
    for (let i = 0; i < linha.length; i++) if (linha[i] === undefined) linha[i] = '';
    if (linha.some((x) => String(x).trim() !== '')) linhas.push(linha);
  }
  return linhas;
}

export function lerTabela(buffer) {
  if (buffer.length === 0) throw new ErroExtrato('O ficheiro está vazio.');
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return tabelaXLSX(buffer);
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf) {
    try {
      return tabelaXLS(buffer);
    } catch (erro) {
      throw erro instanceof ErroXLS ? new ErroExtrato(erro.message) : erro;
    }
  }
  if (buffer.subarray(0, 5).toString() === '%PDF-') throw new ErroExtrato('Os extratos em PDF ainda não são lidos. Exporte o extrato em CSV ou Excel no site do banco.');
  const texto = descodificar(buffer);
  if (/<table/i.test(texto)) return tabelaHTML(texto);
  return tabelaDelimitada(texto, separador(texto));
}

// ---------- Reconhecer as colunas ----------
const achar = (cab, ...regexes) => {
  for (const re of regexes) {
    const i = cab.findIndex((h) => re.test(h));
    if (i >= 0) return i;
  }
  return -1;
};
const texto = (linha, i) => (i >= 0 ? String(linha[i] ?? '').trim() : '');

function detetarTipo(linhas) {
  for (const l of linhas.slice(0, 40)) {
    const j = ` ${l.map(normalizar).join(' | ')} `;
    if (/automatic payout id|balance transaction id|reporting category|payout reconciliation/.test(j)) return 'stripe';
    const cab = l.map(normalizar);
    if (cab.includes('net') && (cab.includes('fees') || cab.includes('fee')) && (cab.includes('amount') || cab.includes('gross')) && (cab.includes('type') || cab.includes('id'))) return 'stripe';
  }
  for (const l of linhas.slice(0, 40)) {
    const cab = l.map(normalizar);
    const j = cab.join(' | ');
    const temEntrada = /check ?in|chegada|arrival/.test(j);
    const temSaida = /check ?out|partida|departure/.test(j);
    const temRef = /refer|reserva|reservation|booking number/.test(j);
    const eBanco = cab.some((h) => /^(saldo|balance)/.test(h)) || cab.some((h) => /^descri/.test(h));
    if (temEntrada && temSaida && temRef && !eBanco) return 'booking';
  }
  return 'banco';
}

// Banco: só os créditos (os débitos não interessam e não são guardados): transferências, Booking, Stripe e terminais TPA.
export function categoriaBanco(descricao) {
  const d = normalizar(descricao);
  if (/^credito comerciante/.test(d)) return 'comerciante'; // liquidação dos terminais TPA (valor líquido de cada fecho)
  if (/booking com|booking b v|bkg b v|bookingcom/.test(d)) return 'booking';
  if (/stripe/.test(d)) return 'stripe';
  return 'transferencia';
}

function lerBanco(linhas) {
  let cab = null;
  let inicio = -1;
  for (let i = 0; i < Math.min(linhas.length, 40); i++) {
    const h = linhas[i].map(normalizar);
    const data = achar(h, /^data (mov|do mov|operacao|lancamento|contabil|de mov)/, /^data$/, /^date$/, /^(booking|posting|transaction) date/, /^data valor/, /^value date/, /^data/);
    const descricao = achar(h, /^descri/, /^(detalhes?|details?|narrativ|memo|movimento|observ)/, /descri/);
    const valor = achar(h, /^(montante|valor|importancia|amount|quantia)$/, /^(montante|valor|amount)/);
    const credito = achar(h, /^(credito|credit|entrada|haver|creditos)/);
    const debito = achar(h, /^(debito|debit|saida|deve|debitos)/);
    if (data >= 0 && descricao >= 0 && (valor >= 0 || credito >= 0)) {
      cab = { data, descricao, valor, credito, debito, saldo: achar(h, /^saldo (contab|disponi|apos)?/, /^(saldo|balance)/), nomes: h };
      inicio = i + 1;
      break;
    }
  }
  if (!cab) {
    throw new ErroExtrato('Não encontrei as colunas do extrato (data, descrição e montante). Cabeçalhos vistos: ' + (linhas[0] || []).slice(0, 12).join(' | '));
  }
  const resultado = [];
  let debitos = 0;
  for (const l of linhas.slice(inicio)) {
    const data = dataFlex(l[cab.data]);
    if (!data) continue;
    let valor;
    if (cab.valor >= 0 && cab.credito < 0) valor = numeroFlex(l[cab.valor]);
    else {
      const c = numeroFlex(l[cab.credito]) ?? 0;
      const d = numeroFlex(l[cab.debito]) ?? 0;
      valor = cab.valor >= 0 && c === 0 && d === 0 ? numeroFlex(l[cab.valor]) : c - Math.abs(d);
    }
    if (valor === null || valor === undefined || Number.isNaN(valor)) continue;
    if (valor <= 0) {
      debitos++; // os débitos não são guardados
      continue;
    }
    const descricao = texto(l, cab.descricao);
    resultado.push({ data, descricao, valor, saldo: cab.saldo >= 0 ? numeroFlex(l[cab.saldo]) : null, categoria: categoriaBanco(descricao) });
  }
  if (!resultado.length) throw new ErroExtrato(`O extrato não tem nenhum crédito (${debitos} débito(s) ignorado(s)).`);
  const colunas = { Data: linhas[inicio - 1]?.[cab.data], Descrição: linhas[inicio - 1]?.[cab.descricao], Montante: linhas[inicio - 1]?.[cab.valor >= 0 ? cab.valor : cab.credito] };
  return { linhas: resultado, colunas, debitos };
}

function lerStripe(linhas) {
  const i0 = linhas.findIndex((l) => {
    const cab = l.map(normalizar);
    return cab.includes('gross') || (cab.includes('net') && (cab.includes('fees') || cab.includes('fee'))) || /automatic payout id|balance transaction id|reporting category/.test(cab.join(' | '));
  });
  if (i0 < 0) throw new ErroExtrato('Não reconheci o relatório do Stripe (esperava colunas como gross, fee, net e automatic_payout_id).');
  const h = linhas[i0].map(normalizar);
  const c = {
    id: achar(h, /^balance transaction id$/, /^id$/),
    data: achar(h, /^created/, /^date/, /^data/),
    bruto: achar(h, /^gross$/, /^amount$/, /^montante$/),
    convertido: achar(h, /^converted amount$/, /^valor convertido$/),
    taxa: achar(h, /^fee$/, /^fees$/, /^taxa$/),
    liquido: achar(h, /^net$/, /^liquido$/),
    categoria: achar(h, /^reporting category$/, /^type$/, /^tipo$/),
    descricao: achar(h, /^description$/, /^descricao$/),
    payout: achar(h, /^automatic payout id$/, /^payout id$/, /^payout$/, /^transfer id$/, /^transfer$/),
    payoutData: achar(h, /^automatic payout effective at/, /^payout date/, /^arrival date/, /^effective at/),
    clientes: h.map((x, i) => (/customer (email|name|description)|billing (name|email)|^email$|customer$|nome do cliente|cliente/.test(x) ? i : -1)).filter((i) => i >= 0),
  };
  if (c.bruto < 0 && c.liquido < 0) throw new ErroExtrato('O relatório do Stripe não tem as colunas gross/net.');
  const resultado = [];
  for (const l of linhas.slice(i0 + 1)) {
    const data = dataFlex(l[c.data]);
    if (!data) continue;
    const bruto = numeroFlex(l[c.bruto]);
    const taxa = Math.abs(numeroFlex(l[c.taxa]) ?? 0);
    const liquido = numeroFlex(l[c.liquido]) ?? (bruto !== null ? bruto - taxa : null);
    const cat = normalizar(texto(l, c.categoria));
    const grupo = texto(l, c.payout) || null;
    const grupoData = dataFlex(l[c.payoutData]);
    const descricao = texto(l, c.descricao);
    const cliente = c.clientes.map((i) => String(l[i] ?? '').trim()).filter(Boolean).join(' ');
    if (/payout|transfer/.test(cat) && !/charge|payment/.test(cat)) {
      const v = Math.abs(liquido ?? bruto ?? 0);
      if (v) resultado.push({ data, descricao: descricao || 'Payout Stripe', valor: v, categoria: 'payout', referencia: texto(l, c.id) || null, grupo: grupo || texto(l, c.id) || null, grupoData: grupoData || data });
      continue;
    }
    if (bruto === null) continue;
    const convertido = c.convertido >= 0 ? numeroFlex(l[c.convertido]) : null;
    resultado.push({
      data, descricao: [descricao, cliente].filter(Boolean).join(' · '), valor: bruto, convertido: convertido !== null && convertido !== bruto ? convertido : null, liquido, taxa,
      categoria: bruto > 0 && !/fee|dispute|refund|reserve/.test(cat) ? 'detalhe' : 'outro',
      referencia: texto(l, c.id) || null, hospede: cliente || null, grupo, grupoData,
    });
  }
  return { linhas: resultado, colunas: { Bruto: linhas[i0][c.bruto >= 0 ? c.bruto : c.liquido], Líquido: linhas[i0][c.liquido], Payout: linhas[i0][c.payout] } };
}

function lerBooking(linhas) {
  let cab = null;
  let inicio = -1;
  for (let i = 0; i < Math.min(linhas.length, 40); i++) {
    const h = linhas[i].map(normalizar);
    const referencia = achar(h, /^(numero de )?(referencia|reserva)/, /^(n |no |numero )?(da )?reserva/, /reference|reservation|booking number|booking id/);
    const checkin = achar(h, /check ?in|chegada|arrival/);
    const valor = achar(h, /(payout|pagamento|payment|final|liquido|net) ?(amount|valor|montante)?/, /^(valor|montante|amount)/, /(valor|montante|amount)/);
    if (referencia >= 0 && checkin >= 0 && valor >= 0) {
      cab = {
        referencia, checkin, checkout: achar(h, /check ?out|partida|departure/),
        hospede: achar(h, /^(nome do )?(hospede|guest)/, /hospede|guest|nome/),
        valor: achar(h, /(valor|montante|amount) (do |de )?(pagamento|payout|pago)/, /(payout|payment|pagamento) (amount|valor|montante)/, /(valor|montante|amount) (final|liquido|net)/, /^(final|net) amount/, /^(valor|montante|amount)$/, /(valor|montante|amount)/, /payout|pagamento/),
        pagoEm: achar(h, /data (do |de )?(pagamento|payout|liquidacao)/, /(payout|payment|paid) date/, /paid on|pago em/),
        grupo: achar(h, /(identificador|id|numero) (do |de )?(pagamento|payout|lote)/, /(payout|payment|batch) (id|number)/, /^batch/),
      };
      inicio = i + 1;
      break;
    }
  }
  if (!cab) throw new ErroExtrato('Não reconheci o relatório da Booking (esperava referência da reserva, check-in e valor do pagamento).');
  const cabecalho = linhas[inicio - 1];
  const resultado = [];
  for (const l of linhas.slice(inicio)) {
    const referencia = texto(l, cab.referencia);
    const valor = numeroFlex(l[cab.valor]);
    if (!referencia || valor === null) continue;
    const pagoEm = dataFlex(l[cab.pagoEm]);
    const checkin = dataFlex(l[cab.checkin]);
    const checkout = dataFlex(l[cab.checkout]);
    const data = pagoEm || checkout || checkin;
    if (!data) continue;
    resultado.push({
      data, descricao: `Reserva Booking ${referencia}`, valor, categoria: 'detalhe', referencia,
      hospede: texto(l, cab.hospede) || null, checkin, checkout, grupo: texto(l, cab.grupo) || pagoEm || null, grupoData: pagoEm,
    });
  }
  return { linhas: resultado, colunas: { Reserva: cabecalho[cab.referencia], 'Check-in': cabecalho[cab.checkin], Valor: cabecalho[cab.valor], 'Data do pagamento': cab.pagoEm >= 0 ? cabecalho[cab.pagoEm] : '—' } };
}

// tipoForcado: 'banco' | 'stripe' | 'booking' | '' (reconhecer sozinho)
export function lerExtrato(buffer, tipoForcado = '') {
  const tabela = lerTabela(buffer);
  if (tabela.length < 2) throw new ErroExtrato('O ficheiro não tem linhas de dados.');
  if (tabela.length > MAX_LINHAS) throw new ErroExtrato(`O ficheiro tem demasiadas linhas (máximo ${MAX_LINHAS}).`);
  const tipo = ['banco', 'stripe', 'booking'].includes(tipoForcado) ? tipoForcado : detetarTipo(tabela);
  const lido = tipo === 'stripe' ? lerStripe(tabela) : tipo === 'booking' ? lerBooking(tabela) : lerBanco(tabela);
  if (!lido.linhas.length) throw new ErroExtrato('Não encontrei nenhuma linha com data e valor.');
  const datas = lido.linhas.map((l) => l.data).sort();
  const colunas = Object.fromEntries(Object.entries(lido.colunas).filter(([, v]) => v));
  return { tipo, linhas: lido.linhas, colunas, debitos: lido.debitos || 0, de: datas[0], ate: datas[datas.length - 1] };
}

export const centimos = (v) => Math.round((v ?? 0) * 100);

// Chave para não duplicar linhas quando os extratos se sobrepõem.
export function chaveDaLinha(tipo, l) {
  return tipo === 'banco'
    ? `${l.data}|${normalizar(l.descricao)}|${centimos(l.valor)}|${l.saldo === null || l.saldo === undefined ? '' : centimos(l.saldo)}`
    : `${l.referencia || ''}|${l.data}|${centimos(l.valor)}|${l.grupo || ''}|${l.categoria}`;
}
