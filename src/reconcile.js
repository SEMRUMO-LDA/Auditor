// Cruzamento de um dia: diário de caixa x faturas x talões TPA.
// Só deteta e regista inconsistências; nunca altera os dados de origem.
import { all, get, run, tx, agora, config } from './db.js';
import { cifrarTexto } from './cifra.js';
import { MEIO_NUMERARIO, totalContado } from './numerario.js';

export const SEM_AGENCIA = '(direto)';
export const PRAZO_OMISSAO = 6;
// Taxa turística mais alta praticada, em cêntimos por pessoa e noite. Faturado acima do total da
// reserva até este limite é tratado como taxa turística e não é assinalado.
const TAXA_MAX = 200;
const INATIVOS = new Set(['Cancelation', 'No-show']);

export const TIPOS = {
  DIARIO_TOTAL: 'Total do diário não confere',
  DIARIO_TOTAL_UTILIZADOR: 'Total do utilizador não confere',
  CONTAGEM_NUMERARIO: 'Contagem de numerário não confere',
  MOV_SEM_DOC: 'Movimento sem documento',
  MOV_SEM_FATURA: 'Movimento sem fatura',
  FATURA_SEM_MOV: 'Fatura sem movimento de caixa',
  DOC_DIVERGENTE: 'Documento com valores diferentes',
  NOTA_CREDITO: 'Nota de crédito',
  SEQ_DOCS: 'Falha na numeração',
  TALAO_SEM_FATURA: 'Talão sem registo no PMS',
  TALAO_DIVERGENTE: 'Talão diferente da fatura',
  TALAO_SEM_RESERVA: 'Talão sem reserva',
  CARTAO_SEM_TALAO: 'Cartão sem talão',
  FECHO_VS_COMPRAS: 'Fecho do TPA diferente dos talões',
  FECHO_VS_DIARIO: 'Fecho do TPA diferente do diário',
  FECHO_EM_FALTA: 'Falta o talão de fecho',
  TPA_SEM_UNIDADE: 'Terminal sem unidades',
  DOC_OUTRA_DATA: 'Documento emitido noutra data',
  RESERVA_SEM_FATURA: 'Reserva sem fatura',
  RESERVA_FATURADA_ABAIXO: 'Reserva faturada abaixo do total',
  RESERVA_FATURADA_ACIMA: 'Reserva faturada acima do total',
  CANCELADA_COM_FATURA: 'Reserva cancelada com fatura',
  RESERVAS_A_AGUARDAR: 'Reservas dentro do prazo de faturação',
  RESERVAS_AGENCIA: 'Reservas faturadas à agência',
};

const cent = (v) => Math.round((v ?? 0) * 100);
const soma = (arr) => arr.reduce((a, x) => a + cent(x.valor), 0);
const euros = (c) => (c / 100).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

function agrupar(arr, chave) {
  const m = new Map();
  for (const x of arr) {
    const k = typeof chave === 'function' ? chave(x) : x[chave];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

const segundos = (hora) => {
  const [h, m, s] = String(hora || '').split(':').map(Number);
  return Number.isFinite(h) ? h * 3600 + (m || 0) * 60 + (s || 0) : null;
};

// Registos tal como são mostrados ao auditor.
const regMov = (m) => ({
  origem: 'Diário de caixa', Hora: m.hora, Documento: m.doc || '(sem documento)', Reserva: m.reserva, Meio: m.tipo, Valor: m.valor,
  Nome: m.nome, Quarto: m.quarto, Utilizador: m.utilizador, Caixa: m.caixa, Motivo: m.motivo, Observações: m.obs,
});
const regFat = (f) => ({
  origem: 'Faturas', Documento: f.doc, Meio: f.tipo, Valor: f.valor, Reserva: f.reserva, Hóspede: f.hospede,
  Unidade: f.hotel, Quarto: f.quarto, 'Total da reserva': f.total_reserva, Info: f.info,
});
const dataPT = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const noites = (de, ate) => Math.max(0, Math.round((new Date(ate) - new Date(de)) / 86400e3));
const somarDias = (iso, n) => new Date(new Date(iso).getTime() + n * 86400e3).toISOString().slice(0, 10);
const LADOS = { saida: 'Saída', entrada: 'Entrada' };
const regReserva = (l) => ({
  origem: 'Reserva', Reserva: l.reserva, Unidade: l.unidade, Hóspede: l.hospede, 'Check-in': dataPT(l.checkin), 'Check-out': dataPT(l.checkout),
  Estado: l.status, Pessoas: l.pax, Total: l.total, Agência: l.agencia || SEM_AGENCIA, Canal: l.canal, Notas: l.info,
});
const regFatReserva = (f) => ({
  origem: 'Faturas da reserva', Documento: f.doc, Data: dataPT(f.doc_data), Meio: f.tipo, Valor: f.valor, Quarto: f.quarto,
});

// Junta as linhas de cada reserva (uma por quarto) e as suas faturas.
export async function calcularReservas(data, lado) {
  const linhas = await all('SELECT * FROM reservas WHERE data = ? AND lado = ? ORDER BY id', data, lado);
  const faturas = agrupar(await all('SELECT * FROM faturas_reserva WHERE data = ? AND lado = ? ORDER BY doc_data, id', data, lado), 'reserva');
  const regras = new Map((await all('SELECT nome, regra FROM agencias')).map((a) => [a.nome, a.regra]));
  return [...agrupar(linhas, 'reserva')].map(([reserva, ls]) => {
    const ativas = ls.filter((l) => !INATIVOS.has(l.status));
    const trocas = new Set();
    let total = 0;
    let pessoasNoites = 0;
    for (const l of ativas) {
      pessoasNoites += (l.pax || 0) * noites(l.checkin, l.checkout);
      // Uma troca de quarto aparece em duas linhas (">>"), cada uma com o total inteiro: conta-se uma vez.
      if (l.unidade.includes('>>')) {
        const chave = `${l.hospede}|${cent(l.total)}`;
        if (trocas.has(chave)) continue;
        trocas.add(chave);
      }
      total += cent(l.total);
    }
    const fs = faturas.get(reserva) || [];
    const base = ativas[0] || ls[0];
    const agencia = base.agencia || SEM_AGENCIA;
    return {
      reserva, linhas: ls, ativas, faturas: fs, total, faturado: soma(fs), pessoasNoites, agencia,
      regra: regras.get(agencia) || 'agencia', hospede: base.hospede,
      checkout: ls.map((l) => l.checkout).filter(Boolean).sort().pop(),
    };
  });
}

// Números para o quadro de saídas e entradas na página do dia.
export async function resumoReservas(data) {
  return Promise.all(Object.keys(LADOS).map(async (lado) => {
    const rs = await calcularReservas(data, lado);
    const ativas = rs.filter((r) => r.ativas.length);
    return {
      lado, nome: LADOS[lado], reservas: rs.length, ativas: ativas.length, canceladas: rs.length - ativas.length,
      total: ativas.reduce((s, r) => s + r.total, 0) / 100,
      faturado: ativas.reduce((s, r) => s + r.faturado, 0) / 100,
      semFatura: ativas.filter((r) => r.total > 0 && !r.faturas.length).length,
    };
  }));
}

const regTalao = (t) => ({
  origem: 'Talão', Tipo: t.tipo === 'fecho' ? 'Fecho do terminal' : 'Compra', TPA: t.tpa, Hora: t.hora, Valor: t.valor,
  Cartão: [t.cartao, t.ultimos4 && `****${t.ultimos4}`].filter(Boolean).join(' '), Reserva: t.reservas, 'Enviado por': t.enviado_por,
});

export async function reconciliar(data) {
  const fecho = await get('SELECT * FROM fechos WHERE data = ?', data);
  if (!fecho) return;

  const mov = await all('SELECT * FROM movimentos WHERE data = ? ORDER BY hora, id', data);
  const fat = await all('SELECT * FROM faturas WHERE data = ? ORDER BY id', data);
  const taloes = await all(
    `SELECT t.*, u.nome AS enviado_por FROM taloes t JOIN envios e ON e.id = t.envio_id JOIN users u ON u.id = e.user_id
     WHERE t.data = ? ORDER BY t.hora, t.id`,
    data,
  );
  const meiosTPA = new Set((await all('SELECT codigo FROM meios WHERE tpa = 1')).map((m) => m.codigo));
  const temDiario = Boolean(fecho.diario_ficheiro);
  const temFaturas = Boolean(fecho.faturas_ficheiro);

  const achadas = [];
  const chavesUsadas = new Map();
  function add(tipo, chave, o) {
    // Duas linhas idênticas no mesmo dia geram a mesma chave; numera-se a partir da segunda.
    const base = `${tipo}|${chave}`;
    const n = (chavesUsadas.get(base) || 0) + 1;
    chavesUsadas.set(base, n);
    achadas.push({ tipo, chave: n > 1 ? `${chave}#${n}` : String(chave), gravidade: 'erro', ...o });
  }

  // O diário não traz o número da reserva. Chega-se a ele pelo documento (documento → fatura → reserva);
  // só quando o movimento não tem documento conhecido é que se recorre ao quarto, que é menos seguro
  // porque no mesmo dia um quarto pode ter um hóspede a sair e outro a entrar.
  const reservaDoDoc = new Map(fat.filter((f) => f.doc && f.reserva).map((f) => [f.doc, f.reserva]));
  for (const f of await all('SELECT doc, reserva FROM faturas_reserva WHERE data = ?', data)) {
    if (!reservaDoDoc.has(f.doc)) reservaDoDoc.set(f.doc, f.reserva);
  }
  for (const m of mov) m.reserva = (m.doc && reservaDoDoc.get(m.doc)) || '';
  const reservasDoDia = await all('SELECT * FROM reservas WHERE data = ? ORDER BY id', data);
  const doMovimento = (m) => {
    const porId = m.reserva ? reservasDoDia.filter((l) => l.reserva === m.reserva) : [];
    if (porId.length) return porId.map(regReserva);
    return m.quarto ? reservasDoDia.filter((l) => l.unidade.replace(/>>/g, '').trim() === m.quarto).map(regReserva) : [];
  };

  // ---------- Contagem de numerário feita pelo auditor contra o CASH do diário ----------
  const contagemNum = await all('SELECT valor, quantidade FROM contagens_numerario WHERE data = ?', data);
  if (contagemNum.length && temDiario) {
    const contado = totalContado(Object.fromEntries(contagemNum.map((c) => [c.valor, c.quantidade])));
    const esperado = soma(mov.filter((m) => m.tipo === MEIO_NUMERARIO));
    if (contado !== esperado) {
      add('CONTAGEM_NUMERARIO', MEIO_NUMERARIO, {
        titulo: `Numerário: contados ${euros(contado)} em notas e moedas, o diário regista ${euros(esperado)} em ${MEIO_NUMERARIO} (${contado > esperado ? 'sobram' : 'faltam'} ${euros(Math.abs(contado - esperado))})`,
        valor: (contado - esperado) / 100,
        detalhe: {
          texto: 'A contagem de notas e moedas feita pelo auditor não corresponde ao total em numerário registado no diário de caixa.',
          registos: [{ origem: 'Contagem', Contado: contado / 100, Diário: esperado / 100, Diferença: (contado - esperado) / 100 }],
        },
      });
    }
  }

  // ---------- A. Coerência interna do diário ----------
  if (temDiario) {
    const resumo = await all('SELECT * FROM resumo_diario WHERE data = ?', data);
    if (resumo.length) {
      const porTipo = agrupar(mov, 'tipo');
      const tipos = new Set([...resumo.map((r) => r.tipo), ...porTipo.keys()]);
      for (const tipo of tipos) {
        const declarado = cent(resumo.find((r) => r.tipo === tipo)?.valor);
        const calculado = soma(porTipo.get(tipo) || []);
        if (declarado !== calculado) {
          add('DIARIO_TOTAL', tipo, {
            titulo: `${tipo}: o resumo do diário indica ${euros(declarado)}, mas os movimentos somam ${euros(calculado)}`,
            valor: (calculado - declarado) / 100,
            detalhe: { texto: 'O total por meio de pagamento no topo do diário não corresponde à soma das linhas.' },
          });
        }
      }
    }
    for (const [utilizador, linhas] of agrupar(mov, 'utilizador')) {
      const declarado = linhas.find((l) => l.total_utilizador !== null)?.total_utilizador;
      if (declarado == null) continue;
      if (cent(declarado) !== soma(linhas)) {
        add('DIARIO_TOTAL_UTILIZADOR', utilizador, {
          titulo: `${utilizador}: total declarado ${euros(cent(declarado))}, movimentos somam ${euros(soma(linhas))}`,
          utilizador,
          valor: (soma(linhas) - cent(declarado)) / 100,
          detalhe: { texto: 'O total do utilizador no diário não corresponde à soma dos seus movimentos.' },
        });
      }
    }
    for (const m of mov.filter((x) => !x.doc)) {
      add('MOV_SEM_DOC', `${m.utilizador}|${m.hora}|${m.tipo}|${cent(m.valor)}`, {
        titulo: `${euros(cent(m.valor))} em ${m.tipo} sem documento (${m.nome || 'sem nome'}${m.quarto ? ', quarto ' + m.quarto : ''})`,
        utilizador: m.utilizador, caixa: m.caixa, valor: m.valor,
        detalhe: { texto: 'O movimento foi registado na caixa sem fatura, recibo ou nota de crédito associada.', registos: [regMov(m), ...doMovimento(m)] },
      });
    }
  }

  // ---------- B. Diário x faturas ----------
  if (temDiario && temFaturas) {
    const movDoc = agrupar(mov.filter((m) => m.doc), 'doc');
    const fatDoc = agrupar(fat, 'doc');
    for (const doc of new Set([...movDoc.keys(), ...fatDoc.keys()])) {
      const ms = [...(movDoc.get(doc) || [])];
      const fs = [...(fatDoc.get(doc) || [])];
      const dono = (movDoc.get(doc) || [])[0];
      for (let i = ms.length - 1; i >= 0; i--) {
        const j = fs.findIndex((f) => f.tipo === ms[i].tipo && cent(f.valor) === cent(ms[i].valor));
        if (j >= 0) {
          ms.splice(i, 1);
          fs.splice(j, 1);
        }
      }
      if (ms.length && fs.length) {
        add('DOC_DIVERGENTE', doc, {
          titulo: `${doc}: diário regista ${ms.map((m) => `${euros(cent(m.valor))} ${m.tipo}`).join(' + ')}, fatura indica ${fs.map((f) => `${euros(cent(f.valor))} ${f.tipo}`).join(' + ')}`,
          utilizador: dono?.utilizador, caixa: dono?.caixa, valor: (soma(ms) - soma(fs)) / 100,
          detalhe: { texto: 'O mesmo documento tem valor ou meio de pagamento diferente no diário de caixa e no relatório de faturas.', registos: [...ms.map(regMov), ...fs.map(regFat)] },
        });
      } else {
        for (const m of ms) {
          // O diário exportado mais tarde já mostra o documento que só foi emitido depois do dia.
          if (m.doc_data && m.doc_data !== data) {
            const dias = noites(data, m.doc_data);
            add('DOC_OUTRA_DATA', `${doc}|${m.tipo}|${cent(m.valor)}`, {
              gravidade: 'aviso',
              titulo: `${euros(cent(m.valor))} em ${m.tipo} recebidos neste dia, mas o documento ${doc} só foi emitido a ${dataPT(m.doc_data)}${dias > 0 ? ` (${dias} dias depois)` : ''}`,
              utilizador: m.utilizador, caixa: m.caixa, valor: m.valor,
              detalhe: { texto: 'O dinheiro entrou na caixa neste dia sem documento; o documento a que está agora ligado foi emitido noutra data.', registos: [regMov(m), ...doMovimento(m)] },
            });
            continue;
          }
          add('MOV_SEM_FATURA', `${doc}|${m.tipo}|${cent(m.valor)}`, {
            titulo: `${doc}: ${euros(cent(m.valor))} em ${m.tipo} no diário, sem linha correspondente nas faturas`,
            utilizador: m.utilizador, caixa: m.caixa, valor: m.valor,
            detalhe: { texto: 'O movimento existe no diário de caixa mas o documento não aparece no relatório de faturas do dia.', registos: [regMov(m)] },
          });
        }
        for (const f of fs) {
          add('FATURA_SEM_MOV', `${doc}|${f.tipo}|${cent(f.valor)}`, {
            titulo: `${doc}: ${euros(cent(f.valor))} em ${f.tipo} faturados (reserva ${f.reserva}), sem movimento no diário`,
            utilizador: dono?.utilizador, caixa: dono?.caixa, valor: f.valor,
            detalhe: { texto: 'A fatura foi emitida neste dia mas o pagamento não aparece no diário de caixa.', registos: [regFat(f)] },
          });
        }
      }
    }
  }

  // Notas de crédito: não são erro por si, mas o auditor deve vê-las.
  const notas = new Set([...mov, ...fat].map((x) => x.doc).filter((d) => /^NC\b/i.test(d || '')));
  for (const doc of notas) {
    const ms = mov.filter((m) => m.doc === doc);
    const fs = fat.filter((f) => f.doc === doc);
    const reservas = new Set(fs.map((f) => f.reserva));
    const relacionadas = fat.filter((f) => f.doc !== doc && reservas.has(f.reserva));
    const valor = ms.length ? soma(ms) : soma(fs);
    add('NOTA_CREDITO', doc, {
      gravidade: 'info',
      titulo: `${doc}: nota de crédito de ${euros(valor)}${ms[0]?.motivo ? ` (${ms[0].motivo})` : ''}`,
      utilizador: ms[0]?.utilizador, caixa: ms[0]?.caixa, valor: valor / 100,
      detalhe: {
        texto: relacionadas.length
          ? 'Nota de crédito emitida no dia. Abaixo estão os outros documentos da mesma reserva emitidos no mesmo dia.'
          : 'Nota de crédito emitida no dia. Não há outros documentos da mesma reserva neste dia.',
        registos: [...ms.map(regMov), ...fs.map(regFat), ...relacionadas.map(regFat)],
      },
    });
  }

  // Falhas na numeração dos documentos.
  const series = new Map();
  // Só contam os documentos emitidos no próprio dia; os de outra data pertencem à numeração desse outro dia.
  const doDia = [...mov.filter((m) => !m.doc_data || m.doc_data === data), ...fat];
  for (const doc of new Set(doDia.map((x) => x.doc).filter(Boolean))) {
    const m = /^(.+?)\/(\d+)$/.exec(doc);
    if (!m) continue;
    if (!series.has(m[1])) series.set(m[1], new Set());
    series.get(m[1]).add(Number(m[2]));
  }
  for (const [serie, nums] of series) {
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const falta = [];
    for (let n = min; n <= max && falta.length < 500; n++) if (!nums.has(n)) falta.push(n);
    if (falta.length) {
      add('SEQ_DOCS', serie, {
        gravidade: 'info',
        titulo: `Série ${serie}: ${falta.length} número(s) em falta entre ${min} e ${max}`,
        detalhe: {
          texto: `Números que não aparecem nem no diário nem nas faturas: ${falta.join(', ')}. Podem ser documentos sem pagamento no dia ou emitidos noutro contexto; convém confirmar.`,
        },
      });
    }
  }

  // ---------- C. Talões TPA ----------
  await run('UPDATE taloes SET doc_associado = NULL WHERE data = ?', data);
  if (temDiario) {
    const compras = taloes.filter((t) => t.tipo === 'compra');
    const fechosTPA = taloes.filter((t) => t.tipo === 'fecho');
    const cartaoMov = mov.filter((m) => meiosTPA.has(m.tipo) && m.valor > 0).map((m) => ({ ...m, usado: false }));
    const cartaoFat = fat.filter((f) => meiosTPA.has(f.tipo) && f.valor > 0).map((f) => ({ ...f, usado: false }));
    const caixasDoTPA = agrupar(
      await all('SELECT t.numero, c.caixa FROM tpas t JOIN tpa_caixas c ON c.tpa_id = t.id'),
      'numero',
    );

    const associar = async (t, docs) => await run('UPDATE taloes SET doc_associado = ? WHERE id = ?', [...new Set(docs)].join(', '), t.id);
    const usarMov = (f) => {
      const m = cartaoMov.find((x) => !x.usado && x.doc === f.doc && x.tipo === f.tipo && cent(x.valor) === cent(f.valor));
      if (m) m.usado = true;
    };

    // Sem reserva (ou sem faturas carregadas) procura-se o movimento de cartão com o mesmo valor e hora mais próxima.
    async function porValor(t) {
      const caixas = new Set((caixasDoTPA.get(t.tpa) || []).map((c) => c.caixa));
      const cands = cartaoMov.filter((m) => !m.usado && cent(m.valor) === cent(t.valor));
      if (!cands.length) return false;
      const hora = segundos(t.hora);
      const dist = (m) => (hora === null || segundos(m.hora) === null ? 0 : Math.abs(segundos(m.hora) - hora));
      cands.sort((a, b) => Number(caixas.has(b.caixa)) - Number(caixas.has(a.caixa)) || dist(a) - dist(b));
      cands[0].usado = true;
      const f = cartaoFat.find((x) => !x.usado && x.doc === cands[0].doc && cent(x.valor) === cent(t.valor));
      if (f) f.usado = true;
      await associar(t, [cands[0].doc]);
      return true;
    }

    const comReserva = compras.filter((t) => t.reservas);
    const semReserva = compras.filter((t) => !t.reservas);

    for (const t of comReserva) {
      const rs = t.reservas.split(',');
      if (!temFaturas) {
        if (!await porValor(t)) semRegisto(t, 'Não há nenhum movimento de cartão por associar com este valor no diário.');
        continue;
      }
      const cands = cartaoFat.filter((f) => !f.usado && rs.includes(f.reserva));
      let certos = cands.filter((f) => cent(f.valor) === cent(t.valor)).slice(0, 1);
      if (!certos.length && cands.length > 1 && soma(cands) === cent(t.valor)) certos = cands;
      if (certos.length) {
        for (const f of certos) {
          f.usado = true;
          usarMov(f);
        }
        await associar(t, certos.map((f) => f.doc));
        continue;
      }
      const daReserva = fat.filter((f) => rs.includes(f.reserva));
      if (!daReserva.length) {
        semRegisto(t, `A reserva ${t.reservas} não tem nenhuma fatura neste dia.`);
      } else {
        add('TALAO_DIVERGENTE', t.id, {
          titulo: `Talão de ${euros(cent(t.valor))} (reserva ${t.reservas}) não corresponde às faturas da reserva`,
          valor: t.valor,
          detalhe: {
            texto: 'A reserva tem faturas neste dia, mas nenhuma paga por cartão com o valor do talão. Pode ter sido registada com outro valor ou outro meio de pagamento.',
            registos: [regTalao(t), ...daReserva.map(regFat)],
            taloes: [t.id],
          },
        });
      }
    }

    for (const t of semReserva) {
      const encontrou = await porValor(t);
      if (!encontrou) semRegisto(t, 'O talão não tem reserva e não há nenhum movimento de cartão por associar com este valor.');
      add('TALAO_SEM_RESERVA', t.id, {
        gravidade: 'aviso',
        titulo: `Talão de ${euros(cent(t.valor))} às ${t.hora || '?'} sem número de reserva`,
        valor: t.valor,
        detalhe: {
          texto: encontrou
            ? 'O talão foi associado a um movimento apenas pelo valor e pela hora. Confirme que é o movimento certo.'
            : 'Sem número de reserva não é possível ligar o talão a uma fatura.',
          registos: [regTalao(t)],
          taloes: [t.id],
        },
      });
    }

    function semRegisto(t, motivo) {
      add('TALAO_SEM_FATURA', t.id, {
        titulo: `Talão de ${euros(cent(t.valor))} às ${t.hora || '?'}${t.reservas ? ` (reserva ${t.reservas})` : ''} sem registo no PMS`,
        valor: t.valor,
        detalhe: { texto: `Existe um talão de compra, mas não foi encontrado o pagamento correspondente. ${motivo}`, registos: [regTalao(t)], taloes: [t.id] },
      });
    }

    for (const m of cartaoMov.filter((x) => !x.usado)) {
      add('CARTAO_SEM_TALAO', `${m.doc}|${m.tipo}|${cent(m.valor)}|${m.hora}`, {
        gravidade: 'aviso',
        titulo: `${m.doc || '(sem documento)'}: ${euros(cent(m.valor))} em ${m.tipo} sem talão TPA`,
        utilizador: m.utilizador, caixa: m.caixa, valor: m.valor,
        detalhe: { texto: 'O diário regista um pagamento por cartão para o qual ainda não foi enviado nenhum talão de compra.', registos: [regMov(m)] },
      });
    }

    // Fecho de cada terminal contra os talões de compra desse terminal.
    const comprasTPA = agrupar(compras, 'tpa');
    const fechosPorTPA = agrupar(fechosTPA, 'tpa');
    for (const [tpa, fs] of fechosPorTPA) {
      const cs = comprasTPA.get(tpa) || [];
      if (soma(fs) !== soma(cs)) {
        add('FECHO_VS_COMPRAS', tpa, {
          gravidade: 'aviso',
          titulo: `TPA ${tpa}: fecho de ${euros(soma(fs))}, talões de compra enviados somam ${euros(soma(cs))} (${cs.length})`,
          valor: (soma(fs) - soma(cs)) / 100,
          detalhe: {
            texto: 'O total do talão de fecho não corresponde à soma dos talões de compra enviados para este terminal. Normalmente significa que faltam talões.',
            registos: [...fs.map(regTalao), ...cs.map(regTalao)],
            taloes: [...fs, ...cs].map((t) => t.id),
          },
        });
      }
    }
    for (const [tpa, cs] of comprasTPA) {
      if (fechosPorTPA.has(tpa)) continue;
      add('FECHO_EM_FALTA', tpa, {
        gravidade: 'aviso',
        titulo: `TPA ${tpa}: ${cs.length} talão(ões) de compra (${euros(soma(cs))}) sem talão de fecho`,
        valor: soma(cs) / 100,
        detalhe: { texto: 'Foram enviados talões de compra deste terminal, mas não o talão de fecho do dia.', registos: cs.map(regTalao), taloes: cs.map((t) => t.id) },
      });
    }

    // Fecho contra o diário. Como um TPA pode servir várias unidades e uma unidade pode ter vários TPA,
    // compara-se por grupo de terminais e unidades ligados entre si.
    const pai = new Map();
    const raiz = (x) => {
      if (!pai.has(x)) pai.set(x, x);
      while (pai.get(x) !== x) x = pai.get(x);
      return x;
    };
    for (const [numero, linhas] of caixasDoTPA) for (const l of linhas) pai.set(raiz(`T:${numero}`), raiz(`C:${l.caixa}`));
    const grupos = agrupar([...pai.keys()], raiz);
    for (const nos of grupos.values()) {
      const tpas = nos.filter((n) => n.startsWith('T:')).map((n) => n.slice(2)).sort();
      const caixas = nos.filter((n) => n.startsWith('C:')).map((n) => n.slice(2)).sort();
      const fs = fechosTPA.filter((t) => tpas.includes(t.tpa));
      if (!fs.length) continue;
      const ms = mov.filter((m) => meiosTPA.has(m.tipo) && caixas.includes(m.caixa));
      if (soma(fs) === soma(ms)) continue;
      const semFecho = tpas.filter((n) => !fechosPorTPA.has(n));
      add('FECHO_VS_DIARIO', tpas.join('+'), {
        titulo: `TPA ${tpas.join(', ')}: fecho de ${euros(soma(fs))}, diário regista ${euros(soma(ms))} em cartão (${caixas.join(', ')})`,
        caixa: caixas.length === 1 ? caixas[0] : null,
        valor: (soma(fs) - soma(ms)) / 100,
        detalhe: {
          texto:
            'O total dos talões de fecho não corresponde aos pagamentos por cartão registados no diário nas unidades associadas a estes terminais.' +
            (semFecho.length ? ` Atenção: ainda não há talão de fecho do(s) terminal(is) ${semFecho.join(', ')}.` : ''),
          registos: [...fs.map(regTalao), ...ms.map(regMov)],
          taloes: fs.map((t) => t.id),
        },
      });
    }

    for (const tpa of new Set(taloes.map((t) => t.tpa))) {
      if (caixasDoTPA.has(tpa)) continue;
      add('TPA_SEM_UNIDADE', tpa || '(desconhecido)', {
        gravidade: 'info',
        titulo: `TPA ${tpa || '(desconhecido)'} não está associado a nenhuma unidade`,
        detalhe: { texto: 'Sem saber a que unidades pertence este terminal, não é possível comparar o fecho do TPA com o diário. Associe-o em Configuração › Terminais.' },
      });
    }
  }

  // ---------- D. Reservas que saem e entram: total da reserva contra o que foi faturado ----------
  const prazo = Number(await config('prazo_dias', PRAZO_OMISSAO));
  for (const lado of Object.keys(LADOS)) {
    const col = lado === 'saida' ? 'saidas' : 'entradas';
    if (!fecho[`${col}_lista`] || !fecho[`${col}_faturas`]) continue;
    // O relatório de faturas é uma fotografia do momento em que foi carregado: é contra essa data que se mede o prazo.
    const exportado = fecho[`${col}_faturas_em`].slice(0, 10);
    const aAguardar = [];
    const deAgencia = [];
    for (const r of await calcularReservas(data, lado)) {
      const quem = `${LADOS[lado]} · reserva ${r.reserva} (${r.hospede || 'sem nome'}, ${r.agencia})`;
      const comum = { valor: (r.faturado - r.total) / 100 };
      const registos = [...r.linhas.map(regReserva), ...r.faturas.map(regFatReserva)];
      const chave = `${lado}|${r.reserva}`;
      if (!r.ativas.length) {
        if (r.faturado !== 0) {
          add('CANCELADA_COM_FATURA', chave, {
            gravidade: 'aviso',
            titulo: `${quem}: cancelada ou no-show com ${euros(r.faturado)} faturados`,
            valor: r.faturado / 100,
            detalhe: { texto: 'A reserva está cancelada ou em no-show, mas tem valor faturado sem nota de crédito que o anule. Pode ser uma penalização legítima; convém confirmar.', registos },
          });
        }
        continue;
      }
      if (r.regra === 'agencia') {
        if (r.total > 0 && !r.faturas.length) deAgencia.push(r);
        continue;
      }
      if (r.faturado < r.total) {
        if (r.regra === 'prazo' && exportado <= somarDias(r.checkout, prazo)) {
          aAguardar.push(r);
        } else if (!r.faturas.length) {
          add('RESERVA_SEM_FATURA', chave, {
            ...comum,
            titulo: `${quem}: ${euros(r.total)} sem nenhuma fatura`,
            detalhe: { texto: 'A reserva não está cancelada e não tem nenhuma fatura no relatório. Uma fatura de outra reserva do mesmo hóspede pode estar a cobri-la.', registos },
          });
        } else {
          add('RESERVA_FATURADA_ABAIXO', chave, {
            ...comum,
            titulo: `${quem}: total ${euros(r.total)}, faturado ${euros(r.faturado)}; faltam ${euros(r.total - r.faturado)}`,
            detalhe: { texto: 'O valor faturado é inferior ao total da reserva.', registos },
          });
        }
      } else if (r.faturado - r.total > r.pessoasNoites * TAXA_MAX) {
        add('RESERVA_FATURADA_ACIMA', chave, {
          ...comum,
          gravidade: 'aviso',
          titulo: `${quem}: total ${euros(r.total)}, faturado ${euros(r.faturado)}; ${euros(r.faturado - r.total)} acima`,
          detalhe: {
            texto: `O valor faturado excede o total da reserva em mais do que a taxa turística máxima esperada (${euros(r.pessoasNoites * TAXA_MAX)} para ${r.pessoasNoites} pessoa(s)·noite). Normalmente são extras (late check-out, upgrade, refeições); convém confirmar.`,
            registos,
          },
        });
      }
    }
    const resumo = (rs) => rs.map((r) => ({ origem: 'Reservas', Reserva: r.reserva, Hóspede: r.hospede, Agência: r.agencia, 'Check-out': dataPT(r.checkout), Total: r.total / 100, Faturado: r.faturado / 100 }));
    const totalDe = (rs) => euros(rs.reduce((s, r) => s + r.total - r.faturado, 0));
    if (aAguardar.length) {
      add('RESERVAS_A_AGUARDAR', lado, {
        gravidade: 'info',
        titulo: `${LADOS[lado]}s: ${aAguardar.length} reserva(s) ainda dentro do prazo de faturação de ${prazo} dias após a saída (${totalDe(aAguardar)} por faturar)`,
        detalhe: { texto: 'Estas agências são faturadas depois da saída. Volte a carregar o relatório de faturas depois do prazo para confirmar que ficaram todas faturadas.', registos: resumo(aAguardar) },
      });
    }
    if (deAgencia.length) {
      add('RESERVAS_AGENCIA', lado, {
        gravidade: 'info',
        titulo: `${LADOS[lado]}s: ${deAgencia.length} reserva(s) de agências faturadas à parte, sem fatura neste relatório (${totalDe(deAgencia)})`,
        detalhe: { texto: 'Reservas de agências marcadas em Configuração › Agências como faturadas fora deste relatório. Não são tratadas como erro.', registos: resumo(deAgencia) },
      });
    }
  }

  await guardar(data, achadas);
}

// Grava as inconsistências do dia em poucos comandos (lotes), em vez de um por inconsistência: com a base de dados
// no Supabase, cada comando é uma viagem pela rede.
const LOTE_INCS = 25;
async function guardar(data, achadas) {
  const quando = agora();
  await tx(async () => {
    await run('UPDATE inconsistencias SET ativa = 0 WHERE data = ?', data);
    for (let i = 0; i < achadas.length; i += LOTE_INCS) {
      const lote = achadas.slice(i, i + LOTE_INCS);
      const valores = lote.flatMap((a) => [data, a.tipo, a.chave, a.gravidade, a.titulo, cifrarTexto(JSON.stringify(a.detalhe || {})), a.utilizador || null, a.caixa || null, a.valor ?? null, quando, quando]);
      await run(
        `INSERT INTO inconsistencias (data, tipo, chave, gravidade, titulo, detalhe_json, utilizador, caixa, valor, ativa, criada_em, atualizada_em)
         VALUES ${lote.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').join(', ')}
         ON CONFLICT(data, tipo, chave) DO UPDATE SET
           gravidade = excluded.gravidade, titulo = excluded.titulo, detalhe_json = excluded.detalhe_json,
           utilizador = excluded.utilizador, caixa = excluded.caixa, valor = excluded.valor, ativa = 1, atualizada_em = excluded.atualizada_em`,
        ...valores,
      );
    }
    // O que deixou de ser detetado desaparece, exceto se o auditor já lá tiver escrito: aí fica guardado como histórico.
    await run(
      `DELETE FROM inconsistencias WHERE data = ? AND ativa = 0
       AND NOT EXISTS (SELECT 1 FROM historico h WHERE h.inconsistencia_id = inconsistencias.id)`,
      data,
    );
  });
}

// Vários dias em simultâneo (cada um na sua transação): com a base de dados remota, um a um seria muito lento.
export async function reconciliarTudo() {
  const dias = (await all('SELECT data FROM fechos ORDER BY data')).map((f) => f.data);
  const POR_VEZ = 4;
  for (let i = 0; i < dias.length; i += POR_VEZ) await Promise.all(dias.slice(i, i + POR_VEZ).map((d) => reconciliar(d)));
}
