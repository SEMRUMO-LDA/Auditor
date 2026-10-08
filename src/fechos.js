import { run, tx, agora } from './db.js';
import { identificar, ErroFicheiro } from './parsers.js';
import { reconciliar, SEM_AGENCIA } from './reconcile.js';

// Só se comparam com talões os pagamentos por MB Way, Visa e Mastercard. Multibanco, numerário,
// transferências, Booking e Stripe não precisam de talão. O auditor pode alterar em Configuração.
export const MEIO_TPA = /^(VISA.*|MC|MASTERCARD|MB ?WAY)$/i;

function registarMeio(codigo, descricao) {
  if (!codigo) return;
  run(
    `INSERT INTO meios (codigo, descricao, tpa) VALUES (?, ?, ?)
     ON CONFLICT(codigo) DO UPDATE SET descricao = COALESCE(NULLIF(excluded.descricao, ''), meios.descricao)`,
    codigo,
    descricao || '',
    MEIO_TPA.test(codigo) ? 1 : 0,
  );
}

// Regra de faturação assumida para uma agência vista pela primeira vez. O auditor pode alterar.
function registarAgencia(nome) {
  const regra = nome === SEM_AGENCIA || /mirai/i.test(nome) ? 'imediata' : /booking/i.test(nome) ? 'prazo' : 'agencia';
  run('INSERT OR IGNORE INTO agencias (nome, regra) VALUES (?, ?)', nome, regra);
}

const criarFecho = (data) => run('INSERT INTO fechos (data) VALUES (?) ON CONFLICT(data) DO NOTHING', data);

export function guardarDiario(diario, nomeFicheiro, userId) {
  tx(() => {
    criarFecho(diario.data);
    run(
      'UPDATE fechos SET diario_ficheiro = ?, diario_em = ?, diario_por = ?, total_declarado = ? WHERE data = ?',
      nomeFicheiro, agora(), userId, diario.totalDeclarado, diario.data,
    );
    run('DELETE FROM movimentos WHERE data = ?', diario.data);
    run('DELETE FROM resumo_diario WHERE data = ?', diario.data);
    for (const r of diario.resumo) {
      run('INSERT OR REPLACE INTO resumo_diario (data, tipo, descricao, valor) VALUES (?, ?, ?, ?)', diario.data, r.tipo, r.descricao, r.valor);
      registarMeio(r.tipo, r.descricao);
    }
    for (const m of diario.movimentos) {
      run(
        `INSERT INTO movimentos (data, utilizador, secao, tipo, tipo_desc, hora, doc, obs, quarto, nome, valor, caixa, motivo, total_utilizador, doc_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        diario.data, m.utilizador, m.secao, m.tipo, m.tipo_desc, m.hora, m.doc, m.obs, m.quarto, m.nome, m.valor, m.caixa, m.motivo, m.total_utilizador, m.doc_data,
      );
      registarMeio(m.tipo, m.tipo_desc);
      if (m.caixa) run('INSERT OR IGNORE INTO caixas (codigo) VALUES (?)', m.caixa);
    }
  });
}

export function guardarFaturas(rel, nomeFicheiro, userId) {
  tx(() => {
    criarFecho(rel.data);
    run('UPDATE fechos SET faturas_ficheiro = ?, faturas_em = ?, faturas_por = ? WHERE data = ?', nomeFicheiro, agora(), userId, rel.data);
    run('DELETE FROM faturas WHERE data = ?', rel.data);
    for (const f of rel.faturas) {
      run(
        `INSERT INTO faturas (data, hotel, reserva, quarto, hospede, checkin, checkout, total_reserva, doc, valor, tipo, info)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rel.data, f.hotel, f.reserva, f.quarto, f.hospede, f.checkin, f.checkout, f.total_reserva, f.doc, f.valor, f.tipo, f.info,
      );
      registarMeio(f.tipo, '');
    }
  });
}

// Lista de saídas ou de entradas do dia.
export function guardarLista(lista, nomeFicheiro) {
  const col = lista.lado === 'saida' ? 'saidas_lista' : 'entradas_lista';
  tx(() => {
    criarFecho(lista.data);
    run(`UPDATE fechos SET ${col} = ?, ${col}_em = ? WHERE data = ?`, nomeFicheiro, agora(), lista.data);
    run('DELETE FROM reservas WHERE data = ? AND lado = ?', lista.data, lista.lado);
    for (const r of lista.reservas) {
      run(
        `INSERT INTO reservas (data, lado, reserva, unidade, hospede, checkin, checkout, status, pax, total, agencia, mercado, canal, info, criada_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        lista.data, lista.lado, r.reserva, r.unidade, r.hospede, r.checkin, r.checkout, r.status, r.pax, r.total, r.agencia, r.mercado, r.canal, r.info, r.criada_por,
      );
      registarAgencia(r.agencia || SEM_AGENCIA);
    }
  });
}

// Todas as faturas (de qualquer data) das reservas que saem ou entram no dia.
export function guardarFaturasReserva(rel, nomeFicheiro) {
  const col = rel.lado === 'saida' ? 'saidas_faturas' : 'entradas_faturas';
  tx(() => {
    criarFecho(rel.data);
    run(`UPDATE fechos SET ${col} = ?, ${col}_em = ? WHERE data = ?`, nomeFicheiro, agora(), rel.data);
    run('DELETE FROM faturas_reserva WHERE data = ? AND lado = ?', rel.data, rel.lado);
    for (const f of rel.faturas) {
      run(
        'INSERT INTO faturas_reserva (data, lado, reserva, quarto, doc, doc_data, valor, tipo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        rel.data, rel.lado, f.reserva, f.quarto, f.doc, f.data, f.valor, f.tipo,
      );
    }
  });
}

const dataPT = (iso) => iso.split('-').reverse().join('/');
const DESCRICAO = {
  diario: 'diário de caixa',
  faturas: 'faturas do dia',
  'lista|saida': 'lista de saídas',
  'lista|entrada': 'lista de entradas',
  'faturas_reserva|saida': 'faturas das saídas',
  'faturas_reserva|entrada': 'faturas das entradas',
};

// Recebe os ficheiros de um dia (qualquer subconjunto, por qualquer ordem), reconhece cada um pelo
// conteúdo, guarda-os e cruza o dia. Devolve o dia e o que foi reconhecido.
export function importar(ficheiros, userId) {
  if (!ficheiros.length) throw new ErroFicheiro('Escolha pelo menos um ficheiro.');
  const lidos = [];
  const erros = [];
  for (const f of ficheiros) {
    try {
      const dados = identificar(f.buffer);
      const papel = dados.lado ? `${dados.tipo}|${dados.lado}` : dados.tipo;
      if (lidos.some((l) => l.papel === papel)) erros.push(`"${f.nome}": já foi escolhido outro ficheiro com ${DESCRICAO[papel]}.`);
      else lidos.push({ nome: f.nome, papel, dados });
    } catch (erro) {
      if (!(erro instanceof ErroFicheiro)) throw erro;
      erros.push(`"${f.nome}": ${erro.message}`);
    }
  }
  if (erros.length) throw new ErroFicheiro(erros.join(' '));
  const dias = [...new Set(lidos.map((l) => l.dados.data))];
  if (dias.length > 1) {
    throw new ErroFicheiro(`Os ficheiros são de dias diferentes: ${lidos.map((l) => `"${l.nome}" é ${DESCRICAO[l.papel]} de ${dataPT(l.dados.data)}`).join('; ')}.`);
  }
  for (const { nome, dados } of lidos) {
    if (dados.tipo === 'diario') guardarDiario(dados, nome, userId);
    else if (dados.tipo === 'faturas') guardarFaturas(dados, nome, userId);
    else if (dados.tipo === 'lista') guardarLista(dados, nome);
    else guardarFaturasReserva(dados, nome);
  }
  reconciliar(dias[0]);
  return { data: dias[0], ficheiros: lidos.map((l) => ({ nome: l.nome, descricao: DESCRICAO[l.papel] })) };
}
