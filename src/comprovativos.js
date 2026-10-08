// Comprovativos bancários: liga os movimentos do diário pagos por transferência (TRFBANCO), Booking.com (TBBOOKING)
// e Stripe (STRIPE) às linhas dos extratos carregados. Só lê os dados: quem decide é o auditor.
//
//  - Transferência: o movimento tem de ter um crédito no extrato bancário com o mesmo valor.
//  - Booking / Stripe: o movimento tem de estar no relatório de pagamentos e o lote desse relatório
//    (payout) tem de ter entrado no extrato bancário com o valor total.
//
// Cada linha de extrato só prova um movimento (ou um lote), e as associações feitas à mão pelo auditor valem sempre.
import { all, run, tx, agora } from './db.js';
import { normalizar, centimos, chaveDaLinha } from './extratos.js';

// Meio de pagamento do diário -> tipo de comprovativo.
export const MEIOS_BANCARIOS = { TRFBANCO: 'transferencia', TBBOOKING: 'booking', STRIPE: 'stripe' };
const TIPOS = Object.keys(MEIOS_BANCARIOS);
const JANELA = { transferencia: 45, booking: 120, stripe: 30 }; // dias entre o diário e a linha do extrato
const MINIMO_FORTE = { transferencia: 2, booking: 3, stripe: 2 };
const PALAVRAS_VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'lda', 'sa', 'unipessoal', 'hotel', 'hotels', 'sociedade', 'the', 'and', 'ltd', 'gmbh', 'trf', 'sepa', 'transferencia', 'pagamento', 'ordenante', 'ref', 'cliente']);

const dias = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const palavras = (...textos) =>
  new Set(textos.flatMap((t) => normalizar(t).split(' ')).filter((p) => p.length >= 3 && !/^\d+$/.test(p) && !PALAVRAS_VAZIAS.has(p)));
const numeros = (...textos) => new Set(textos.flatMap((t) => String(t ?? '').match(/\d{5,}/g) || []));
export const chaveDoMovimento = (data, doc, c) => `${data}|${doc}|${c}`;

export function carregarLinhas() {
  return all(
    `SELECT l.*, e.tipo AS ex_tipo, e.nome_original FROM extrato_linhas l JOIN extratos e ON e.id = l.extrato_id ORDER BY l.data, l.id`,
  ).map((l) => ({ ...l, c: centimos(l.valor), cc: l.convertido === null || l.convertido === undefined ? null : centimos(l.convertido) }));
}

// Pontuação de um candidato: 4 por referência igual, até 2 pelos nomes, mais as datas.
function pontuar(item, linha, tipo) {
  let pontos = 0;
  const razoes = [];
  const refs = numeros(item.reserva, item.info, item.obs);
  const refsLinha = numeros(linha.descricao, linha.referencia);
  if ([...refs].some((r) => refsLinha.has(r))) {
    pontos += 4;
    razoes.push('referência');
  }
  const nomes = palavras(item.nome, item.hospede);
  const nomesLinha = palavras(linha.descricao, linha.hospede);
  const comuns = [...nomes].filter((p) => nomesLinha.has(p)).length;
  if (comuns >= 2) {
    pontos += 2;
    razoes.push('nome');
  } else if (comuns === 1) {
    pontos += 1;
    razoes.push('nome (parcial)');
  }
  if (tipo === 'booking') {
    if (linha.checkin && linha.checkin === item.checkin) pontos += 1;
    if (linha.checkout && linha.checkout === item.checkout) pontos += 1;
    if (linha.checkin === item.checkin && linha.checkout === item.checkout) razoes.push('datas');
  } else if (Math.abs(dias(linha.data, item.data)) <= 7) {
    pontos += 1;
    razoes.push('data próxima');
  }
  return { pontos, razoes };
}

function candidatos(item, tipo, linhas, usadas) {
  const janela = JANELA[tipo];
  return linhas
    .filter((l) => !usadas.has(l.id) && (l.c === item.c || l.cc === item.c))
    .filter((l) => (tipo === 'transferencia' ? l.ex_tipo === 'banco' && l.categoria === 'transferencia' : l.ex_tipo === tipo && l.categoria === 'detalhe'))
    .filter((l) => {
      const referencia = tipo === 'booking' ? l.checkout || l.grupo_data || l.data : l.data;
      return Math.abs(dias(referencia, item.data)) <= janela;
    })
    .map((l) => ({ linha: l, ...pontuar(item, l, tipo) }))
    .sort((a, b) => b.pontos - a.pontos || Math.abs(dias(a.linha.data, item.data)) - Math.abs(dias(b.linha.data, item.data)));
}

// Dia a dia (do mais antigo para o mais recente) para que uma linha de extrato nunca prove dois movimentos.
export function comprovativosAteDia(data, opcoes = {}) {
  const linhas = opcoes.linhas || carregarLinhas();
  const porId = new Map(linhas.map((l) => [l.id, l]));
  const manuais = new Map();
  for (const a of all('SELECT * FROM extrato_associacoes')) manuais.set(chaveDoMovimento(a.data, a.doc, a.valor_cent), a.linha_id);
  const usadas = new Set(manuais.values()); // reservadas para os movimentos a que o auditor as ligou
  const usadasBanco = new Set();
  const ctx = { linhas, porId, manuais, usadas, usadasBanco, gruposBanco: new Map() };

  const diasComMovimentos = all(
    `SELECT DISTINCT data FROM movimentos WHERE data <= ? AND tipo IN (${TIPOS.map(() => '?').join(',')}) ORDER BY data`,
    data, ...TIPOS,
  ).map((r) => r.data);
  const resultados = new Map();
  for (const dia of diasComMovimentos) resultados.set(dia, associarDia(dia, ctx));
  return { dia: resultados.get(data) || vazio(), resultados, linhas, temExtratos: linhas.length > 0, ctx };
}

const vazio = () => ({ itens: new Map(), porTipo: Object.fromEntries(TIPOS.map((t) => [t, { itens: [], comprovado: 0, exigido: 0 }])) });

function associarDia(dia, ctx) {
  const movs = all(
    `SELECT doc, tipo, valor, nome, obs, caixa, hora FROM movimentos WHERE data = ? AND tipo IN (${TIPOS.map(() => '?').join(',')}) ORDER BY hora, id`,
    dia, ...TIPOS,
  );
  const faturas = all('SELECT doc, tipo, valor, reserva, hospede, checkin, checkout, info FROM faturas WHERE data = ?', dia);
  const itens = movs.map((m) => {
    const c = centimos(m.valor);
    const f = faturas.find((x) => x.doc === m.doc && x.tipo === m.tipo && centimos(x.valor) === c);
    return {
      chave: chaveDoMovimento(dia, m.doc, c), data: dia, doc: m.doc, tipo: m.tipo, kind: MEIOS_BANCARIOS[m.tipo], c,
      nome: m.nome, obs: m.obs, caixa: m.caixa, hora: m.hora,
      reserva: f?.reserva || '', hospede: f?.hospede || '', checkin: f?.checkin || '', checkout: f?.checkout || '', info: f?.info || '',
      estado: 'sem', origem: 'auto', detalhe: null, banco: null, candidatos: [],
    };
  });

  // Pagamentos anulados por uma nota de crédito do mesmo valor não precisam de comprovativo.
  for (const tipo of TIPOS) {
    const negativos = itens.filter((i) => i.tipo === tipo && i.c < 0).map((i) => ({ i, usado: false }));
    for (const i of itens.filter((x) => x.tipo === tipo && x.c > 0)) {
      const n = negativos.find((x) => !x.usado && -x.i.c === i.c);
      if (n) {
        n.usado = true;
        i.estado = 'anulado';
        n.i.estado = 'anulado';
      }
    }
  }
  for (const i of itens) if (i.c < 0 && i.estado !== 'anulado') i.estado = 'nota'; // nota de crédito sem pagamento para anular

  const porAssociar = itens.filter((i) => i.c > 0 && i.estado === 'sem');

  // 1. Associações feitas à mão.
  for (const i of porAssociar) {
    const id = ctx.manuais.get(i.chave);
    const linha = id && ctx.porId.get(id);
    if (linha) {
      i.origem = 'manual';
      atribuir(i, linha, 'forte', ctx);
    }
  }
  // 2. Associações seguras (referência ou nome + datas), das mais fortes para as mais fracas.
  const pendentes = () => porAssociar.filter((i) => i.estado === 'sem');
  const propostas = pendentes().map((i) => ({ i, lista: candidatos(i, i.kind, ctx.linhas, ctx.usadas) }));
  propostas.sort((a, b) => (b.lista[0]?.pontos ?? -1) - (a.lista[0]?.pontos ?? -1));
  for (const p of propostas) {
    const [melhor, segundo] = p.lista;
    if (!melhor || p.i.estado !== 'sem' || ctx.usadas.has(melhor.linha.id)) continue;
    if (melhor.pontos >= MINIMO_FORTE[p.i.kind] && (!segundo || segundo.pontos < melhor.pontos)) {
      p.i.razoes = melhor.razoes;
      atribuir(p.i, melhor.linha, 'forte', ctx);
    }
  }
  // 2b. A Booking.com paga reserva a reserva: cada crédito "Booking.com B.V." do extrato tem o valor da reserva.
  // Sem relatório de pagamentos não há nome nem referência, por isso a prova é o valor (um crédito por pagamento).
  const creditosBooking = ctx.linhas.filter((l) => l.ex_tipo === 'banco' && l.categoria === 'booking');
  for (const i of pendentes().filter((x) => x.kind === 'booking')) {
    const escolhido = creditosBooking
      .filter((l) => !ctx.usadas.has(l.id) && l.c === i.c && dias(l.data, i.data) >= -10 && dias(l.data, i.data) <= 45)
      .sort((x, y) => Math.abs(dias(x.data, i.data)) - Math.abs(dias(y.data, i.data)))[0];
    if (!escolhido) continue;
    // Os créditos da Booking costumam juntar várias reservas; um valor igual pode ser coincidência.
    // Por isso fica "provável" até o auditor confirmar ou até haver o relatório de pagamentos da Booking.
    ctx.usadas.add(escolhido.id);
    i.estado = 'provavel';
    i.direto = true;
    i.detalhe = escolhido;
    i.banco = escolhido;
    i.razoes = ['valor igual'];
  }
  // 3. O que sobra: uma única hipótese é "provável"; várias são ambíguas.
  const propostasUsadas = new Set();
  for (const i of pendentes()) {
    const lista = candidatos(i, i.kind, ctx.linhas, ctx.usadas).filter((x) => !propostasUsadas.has(x.linha.id));
    i.candidatos = lista.slice(0, 8);
    if (lista.length === 1) {
      i.estado = 'provavel';
      i.razoes = lista[0].razoes;
      i.detalhe = lista[0].linha;
      propostasUsadas.add(lista[0].linha.id);
    } else if (lista.length > 1) i.estado = 'ambiguo';
  }
  // 4. Para os que ficaram "provável", mostra-se também onde está o dinheiro no banco (sem consumir a linha).
  for (const i of itens) if (i.detalhe && i.kind !== 'transferencia' && !i.banco) i.banco = procurarBanco(i.detalhe, i.kind, ctx, false);

  const porTipo = Object.fromEntries(
    TIPOS.map((tipo) => {
      const lista = itens.filter((i) => i.tipo === tipo);
      const exigido = lista.filter((i) => i.estado !== 'anulado').reduce((s, i) => s + i.c, 0);
      const comprovado = lista.filter((i) => i.estado === 'confirmado').reduce((s, i) => s + i.c, 0);
      return [tipo, { itens: lista, comprovado, exigido }];
    }),
  );
  return { itens: new Map(itens.map((i) => [i.chave, i])), porTipo };
}

// Fixa a linha que prova o movimento. Nas transferências a linha é o próprio crédito no banco;
// na Booking e no Stripe é a linha do relatório, e o crédito no banco prova o lote inteiro.
function atribuir(item, linha, forca, ctx) {
  ctx.usadas.add(linha.id);
  item.detalhe = linha;
  if (linha.ex_tipo === 'banco' && item.kind !== 'transferencia') {
    // Ligado à mão directamente a um crédito do banco (sem relatório de pagamentos).
    item.direto = true;
    item.banco = linha;
    item.estado = 'confirmado';
    return;
  }
  if (item.kind === 'transferencia') {
    item.banco = linha;
    item.estado = 'confirmado';
    return;
  }
  item.banco = procurarBanco(linha, item.kind, ctx, true);
  item.estado = item.banco ? 'confirmado' : 'parcial';
}

// Total do lote (payout) a que pertence a linha do relatório e o crédito do banco que o cobre.
function procurarBanco(linha, kind, ctx, consumir) {
  const chaveGrupo = `${linha.extrato_id}|${linha.grupo || ''}`;
  const doGrupo = ctx.linhas.filter((l) => l.extrato_id === linha.extrato_id && (l.grupo || '') === (linha.grupo || '') && l.categoria !== 'payout');
  const total = kind === 'stripe'
    ? doGrupo.reduce((s, l) => s + centimos(l.liquido ?? l.valor - (l.taxa || 0)), 0)
    : doGrupo.reduce((s, l) => s + l.c, 0);
  const payout = ctx.linhas.find((l) => l.extrato_id === linha.extrato_id && l.categoria === 'payout' && (l.grupo || '') === (linha.grupo || ''));
  const alvos = new Set([total]);
  if (payout) alvos.add(payout.c);
  if (ctx.gruposBanco.has(chaveGrupo)) {
    const guardado = ctx.gruposBanco.get(chaveGrupo);
    return guardado ? { ...guardado, lote: { total, linhas: doGrupo.length, grupo: linha.grupo } } : null;
  }
  const referencia = linha.grupo_data || linha.data;
  const encontrados = ctx.linhas
    .filter((l) => l.ex_tipo === 'banco' && l.categoria === kind && alvos.has(l.c) && !ctx.usadasBanco.has(l.id))
    .filter((l) => dias(l.data, referencia) >= -5 && dias(l.data, referencia) <= 45)
    .sort((a, b) => Math.abs(dias(a.data, referencia)) - Math.abs(dias(b.data, referencia)));
  const banco = encontrados[0] || null;
  if (consumir) {
    ctx.gruposBanco.set(chaveGrupo, banco);
    if (banco) ctx.usadasBanco.add(banco.id);
  }
  return banco ? { ...banco, lote: { total, linhas: doGrupo.length, grupo: linha.grupo } } : null;
}

// Para a página dos extratos: a que movimento (ou lote) serve cada linha.
export function usoDasLinhas() {
  const ate = all('SELECT MAX(data) AS d FROM movimentos').find(Boolean)?.d;
  if (!ate) return new Map();
  const { resultados, ctx } = comprovativosAteDia(ate);
  const uso = new Map();
  for (const [dia, r] of resultados) {
    for (const i of r.itens.values()) {
      const deste = { dia, doc: i.doc, tipo: i.tipo, hospede: i.hospede || i.nome };
      // Linha do relatório (Booking/Stripe) ou crédito ligado directamente a um pagamento.
      if (i.detalhe && ['confirmado', 'parcial'].includes(i.estado)) uso.set(i.detalhe.id, deste);
      if (i.banco && i.estado === 'confirmado') {
        if (i.kind === 'transferencia' || i.direto) uso.set(i.banco.id, deste);
        else {
          // O crédito do banco prova o lote inteiro do relatório: vários pagamentos para a mesma linha.
          const atual = uso.get(i.banco.id);
          const lote = atual?.docs ? atual : { dia, tipo: i.tipo, lote: i.banco.lote, docs: [] };
          lote.docs.push(i.doc);
          uso.set(i.banco.id, lote);
        }
      }
    }
  }
  void ctx;
  // Créditos dos terminais TPA: servem de comprovativo ao fecho do terminal.
  const tpaDoFecho = new Map(all(`SELECT id, tpa, data FROM taloes WHERE tipo = 'fecho'`).map((f) => [f.id, f]));
  for (const [id, x] of liquidacoesAteDia(ate).mapa) {
    const f = tpaDoFecho.get(id);
    if (f) uso.set(x.linha.id, { fecho: true, tpa: f.tpa, dia: f.data });
  }
  return uso;
}

// ---------- Liquidação dos terminais TPA ----------
// O banco credita cada terminal ("CREDITO COMERCIANTE 0001234567 …") com o valor líquido do fecho (sem a comissão).
const terminalDe = (s) => String(s ?? '').replace(/\D/g, '').replace(/^0+/, '');

export function liquidacoesAteDia(data) {
  const creditos = carregarLinhas().filter((l) => l.ex_tipo === 'banco' && l.categoria === 'comerciante');
  const resultado = new Map();
  if (!creditos.length) return { mapa: resultado, temCreditos: false };
  const fechos = all(
    `SELECT t.id, t.tpa, t.data, t.hora, t.valor FROM taloes t JOIN envios e ON e.id = t.envio_id
     WHERE t.tipo = 'fecho' AND e.estado = 'confirmado' AND t.data <= ? AND t.valor > 0 ORDER BY t.data, t.hora, t.id`,
    data,
  );
  const usados = new Set();
  for (const f of fechos) {
    const bruto = centimos(f.valor);
    const terminal = terminalDe(f.tpa);
    const candidatos = creditos
      .filter((l) => !usados.has(l.id) && terminalDe(/comerciante\s+(\d+)/i.exec(l.descricao)?.[1]) === terminal)
      .filter((l) => l.c <= bruto && l.c >= Math.floor(bruto * 0.95) && dias(l.data, f.data) >= -1 && dias(l.data, f.data) <= 7)
      .sort((a, b) => Math.abs(dias(a.data, f.data)) - Math.abs(dias(b.data, f.data)) || b.c - a.c);
    if (candidatos[0]) {
      usados.add(candidatos[0].id);
      resultado.set(f.id, { linha: candidatos[0], comissao: bruto - candidatos[0].c });
    }
  }
  return { mapa: resultado, temCreditos: true, usados };
}

// Guarda as linhas de um extrato; as que já existem noutro extrato (datas sobrepostas) não se repetem.
export function guardarExtrato(nome, lido, userId) {
  const existentes = new Map(
    all('SELECT l.chave, COUNT(*) AS n FROM extrato_linhas l JOIN extratos e ON e.id = l.extrato_id WHERE e.tipo = ? GROUP BY l.chave', lido.tipo).map((r) => [r.chave, r.n]),
  );
  const novas = [];
  const noFicheiro = new Map();
  for (const l of lido.linhas) {
    const chave = chaveDaLinha(lido.tipo, l);
    const vistas = (noFicheiro.get(chave) || 0) + 1;
    noFicheiro.set(chave, vistas);
    if (vistas > (existentes.get(chave) || 0)) novas.push({ ...l, chave });
  }
  const repetidas = lido.linhas.length - novas.length;
  if (!novas.length) return { id: null, novas: 0, repetidas };
  let id;
  tx(() => {
    id = Number(
      run('INSERT INTO extratos (tipo, nome_original, criado_em, user_id, de, ate, colunas) VALUES (?, ?, ?, ?, ?, ?, ?)', lido.tipo, nome, agora(), userId, lido.de, lido.ate, JSON.stringify(lido.colunas)).lastInsertRowid,
    );
    novas.forEach((l, n) =>
      run(
        `INSERT INTO extrato_linhas (extrato_id, n, data, descricao, valor, saldo, categoria, referencia, hospede, checkin, checkout, grupo, grupo_data, liquido, taxa, convertido, chave)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, n, l.data, l.descricao, l.valor, l.saldo ?? null, l.categoria, l.referencia ?? null, l.hospede ?? null, l.checkin ?? null, l.checkout ?? null,
        l.grupo ?? null, l.grupoData ?? null, l.liquido ?? null, l.taxa ?? null, l.convertido ?? null, l.chave,
      ),
    );
  });
  return { id, novas: novas.length, repetidas };
}

