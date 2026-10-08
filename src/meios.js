// Análise por meio de pagamento de um dia: cruza o diário de caixa com as faturas e, nos meios TPA, com os talões
// enviados pela receção. Só lê os dados; quem decide é o auditor. Os valores são comparados em cêntimos.
import { MEIO_NUMERARIO } from './numerario.js';
import { MEIOS_BANCARIOS } from './comprovativos.js';

const cent = (v) => Math.round((v ?? 0) * 100);
const euros = (c) => (c / 100).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

export const chaveDoMeio = (tipo) => String(tipo).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'meio';

// movimentos: linhas do diário; faturas: linhas do relatório de faturas; taloes: talões de compra confirmados;
// numerario: { existe, contado, esperado } (contagem de notas e moedas, em cêntimos).
export function analisarMeios({ meios, movimentos, faturas, taloes, numerario, temFaturas, temDiario = true, terminais = new Map(), bancario = null }) {
  const tipoDoDoc = new Map();
  for (const m of movimentos) if (m.doc && !tipoDoDoc.has(m.doc)) tipoDoDoc.set(m.doc, m.tipo);

  // Cada talão fica no meio do primeiro documento a que foi associado.
  const taloesDoDoc = new Map();
  const taloesPorMeio = new Map();
  const taloesSemMeio = [];
  for (const t of taloes) {
    const docs = (t.doc_associado || '').split(', ').filter(Boolean);
    for (const d of docs) {
      if (!taloesDoDoc.has(d)) taloesDoDoc.set(d, []);
      taloesDoDoc.get(d).push(t);
    }
    const tipo = docs.map((d) => tipoDoDoc.get(d)).find(Boolean);
    // Terminal (nº do TPA) contra a caixa do diário: as caixas do terminal têm de incluir as caixas dos pagamentos do talão.
    const caixasTerminal = terminais.get(t.tpa)?.caixas || [];
    const caixasDiario = [...new Set(movimentos.filter((mv) => docs.includes(mv.doc)).map((mv) => mv.caixa).filter(Boolean))];
    t.caixasTerminal = caixasTerminal;
    t.caixasDiario = caixasDiario;
    t.terminalOk = !caixasTerminal.length || !caixasDiario.length ? null : caixasDiario.every((c) => caixasTerminal.includes(c));
    t.meio = tipo || '';
    if (tipo) {
      if (!taloesPorMeio.has(tipo)) taloesPorMeio.set(tipo, []);
      taloesPorMeio.get(tipo).push(t);
    } else taloesSemMeio.push(t);
  }

  // Notas de crédito: a reserva fica marcada (a rosa, como nos Diários) se tiver uma nota de crédito no mesmo dia.
  const eNC = (doc) => /^NC\b/i.test(doc || '');
  const reservaDoDoc = new Map(faturas.filter((f) => f.doc && f.reserva).map((f) => [f.doc, f.reserva]));
  const reservasComNC = new Set(faturas.filter((f) => eNC(f.doc) && f.reserva).map((f) => f.reserva));
  const comNC = (doc, reserva) => eNC(doc) || (reserva ? reservasComNC.has(reserva) : false);

  const porMeio = meios.map((meio) => {
    const movs = movimentos.filter((m) => m.tipo === meio.tipo).map((m) => ({ ...m, c: cent(m.valor) }));
    const fats = faturas.filter((f) => f.tipo === meio.tipo).map((f) => ({ ...f, c: cent(f.valor), usada: false }));

    // Diário contra faturas, documento a documento.
    for (const m of movs) {
      const f = fats.find((x) => !x.usada && x.doc === m.doc && x.c === m.c);
      if (f) {
        f.usada = true;
        m.fatura = f;
      }
    }
    // Um pagamento anulado por uma nota de crédito do mesmo valor não tem talão.
    const negativos = movs.filter((m) => m.c < 0).map((m) => ({ m, usado: false }));
    for (const m of movs.filter((x) => x.c > 0)) {
      const n = negativos.find((x) => !x.usado && -x.m.c === m.c);
      if (n) {
        n.usado = true;
        m.anulado = true;
        n.m.anulado = true;
      }
    }
    for (const m of movs) m.taloes = taloesDoDoc.get(m.doc) || [];
    for (const m of movs) {
      m.reserva = m.fatura?.reserva || reservaDoDoc.get(m.doc) || '';
      m.comNC = comNC(m.doc, m.reserva);
    }
    for (const f of fats) f.comNC = comNC(f.doc, f.reserva);

    const diario = movs.reduce((s, m) => s + m.c, 0);
    const faturado = fats.reduce((s, f) => s + f.c, 0);
    const taloesMeio = taloesPorMeio.get(meio.tipo) || [];
    const taloesSoma = taloesMeio.reduce((s, t) => s + cent(t.valor), 0);
    const semFatura = movs.filter((m) => !m.fatura);
    const faturasSemMovimento = fats.filter((f) => !f.usada);
    const semTalao = meio.tpa ? movs.filter((m) => m.c > 0 && !m.anulado && !m.taloes.length) : [];

    // Cada validação tem uma chave (a linha da matriz), um resultado curto para a célula e o detalhe para o tooltip.
    const verificacoes = [];
    const pagamentos = movs.filter((m) => m.c > 0 && !m.anulado);
    if (temFaturas) {
      verificacoes.push({
        chave: 'totais', ok: diario === faturado,
        titulo: diario === faturado ? 'Total do diário igual ao total das faturas' : 'Total do diário diferente do total das faturas',
        curto: diario === faturado ? euros(diario) : `${euros(diario)} ≠ ${euros(faturado)}`,
        detalhe: `Diário ${euros(diario)} · Faturas ${euros(faturado)}`,
      });
      const falhas = semFatura.length + faturasSemMovimento.length;
      verificacoes.push({
        chave: 'faturas', ok: falhas === 0,
        titulo: falhas === 0 ? 'Todos os movimentos têm a fatura correspondente' : 'Há movimentos e faturas sem correspondência',
        curto: `${movs.length - semFatura.length} de ${movs.length}${faturasSemMovimento.length ? ` · ${faturasSemMovimento.length} fatura(s) a mais` : ''}`,
        detalhe: `${movs.length} movimento(s) · ${semFatura.length} sem fatura · ${faturasSemMovimento.length} fatura(s) sem movimento`,
      });
    }
    if (meio.tpa) {
      const dif = taloesSoma - diario;
      verificacoes.push({
        chave: 'taloes', ok: dif === 0,
        titulo: dif === 0 ? 'Os talões comprovam o valor do diário' : `Talões ${dif > 0 ? 'a mais' : 'a menos'} do que o diário (${dif > 0 ? 'sobram' : 'faltam'} ${euros(Math.abs(dif))})`,
        curto: `${euros(taloesSoma)} de ${euros(diario)}`,
        detalhe: `${taloesMeio.length} talão(ões) somam ${euros(taloesSoma)} · Diário ${euros(diario)}`,
      });
      verificacoes.push({
        chave: 'pagamentos', ok: semTalao.length === 0,
        titulo: semTalao.length === 0 ? 'Todos os pagamentos têm talão' : `${semTalao.length} pagamento(s) sem talão`,
        curto: `${pagamentos.length - semTalao.length} de ${pagamentos.length}`,
        detalhe: semTalao.length ? `Valor sem talão: ${euros(semTalao.reduce((s, m) => s + m.c, 0))}` : 'Cada pagamento do diário está ligado a um talão',
      });
      if (taloesMeio.length) {
        const incoerentes = taloesMeio.filter((t) => t.terminalOk === false);
        const semCaixa = taloesMeio.filter((t) => !t.caixasTerminal.length);
        verificacoes.push({
          chave: 'terminal', ok: incoerentes.length ? false : semCaixa.length ? null : true,
          titulo: incoerentes.length ? `${incoerentes.length} talão(ões) de um terminal que não pertence à caixa do pagamento`
            : semCaixa.length ? `${semCaixa.length} talão(ões) de terminais sem caixa associada` : 'O terminal de cada talão pertence à caixa do pagamento',
          curto: incoerentes.length ? 'Não coincide' : semCaixa.length ? 'Terminal sem caixa' : 'Coincide',
          detalhe: incoerentes.length ? incoerentes.map((t) => `#${t.id}: terminal ${t.tpa} (${t.caixasTerminal.join(', ')}) · diário ${t.caixasDiario.join(', ')}`).join(' | ')
            : semCaixa.length ? `Terminais: ${[...new Set(semCaixa.map((t) => t.tpa))].join(', ')}. Associe cada terminal a uma caixa.` : 'Nº do TPA e caixa coincidem',
        });
      }
    }
    // Transferências, Booking e Stripe: comprovadas pelos extratos bancários e relatórios de pagamentos.
    const extrato = MEIOS_BANCARIOS[meio.tipo] && bancario ? bancario.dia.porTipo[meio.tipo] : null;
    if (extrato) {
      const itens = extrato.itens.filter((i) => i.estado !== 'anulado');
      const conta = (estado) => itens.filter((i) => i.estado === estado).length;
      const feitos = conta('confirmado');
      const falta = itens.length - feitos;
      const detalhe = [conta('parcial') && `${conta('parcial')} pago(s) mas sem crédito no extrato`, conta('provavel') && `${conta('provavel')} provável(is) por confirmar`, conta('ambiguo') && `${conta('ambiguo')} com várias hipóteses`, (conta('sem') + conta('nota')) && `${conta('sem') + conta('nota')} sem comprovativo`].filter(Boolean).join(' · ');
      if (!bancario.temExtratos) {
        verificacoes.push({ chave: 'extrato', ok: null, titulo: 'Sem extratos carregados', curto: 'Sem extratos', detalhe: 'Carregue o extrato bancário e o relatório de pagamentos em Extratos' });
        verificacoes.push({ chave: 'extratoTotal', ok: null, titulo: 'Valor comprovado por validar', curto: 'Por validar', detalhe: 'Sem extratos carregados' });
      } else {
        verificacoes.push({
          chave: 'extrato', ok: falta === 0,
          titulo: falta === 0 ? 'Todos os pagamentos têm comprovativo no extrato' : `${falta} pagamento(s) sem comprovativo no extrato`,
          curto: `${feitos} de ${itens.length}`, detalhe: falta === 0 ? 'Cada pagamento está ligado a uma linha do extrato' : detalhe,
        });
        verificacoes.push({
          chave: 'extratoTotal', ok: extrato.comprovado === extrato.exigido,
          titulo: extrato.comprovado === extrato.exigido ? 'O valor comprovado no extrato é igual ao diário' : 'O valor comprovado no extrato é diferente do diário',
          curto: `${euros(extrato.comprovado)} de ${euros(extrato.exigido)}`, detalhe: `Comprovado ${euros(extrato.comprovado)} · Diário ${euros(extrato.exigido)}`,
        });
      }
    }
    if (meio.tipo === MEIO_NUMERARIO) {
      const dif = numerario.contado - numerario.esperado;
      verificacoes.push(
        !numerario.existe
          ? { chave: 'contagem', ok: null, titulo: 'Contagem de numerário por validar', curto: 'Por validar', detalhe: 'Conte as notas e moedas da caixa e compare com o diário' }
          : {
              chave: 'contagem', ok: dif === 0,
              titulo: dif === 0 ? 'A contagem de notas e moedas bate certo com o diário' : `A contagem não bate certo (${dif > 0 ? 'sobram' : 'faltam'} ${euros(Math.abs(dif))})`,
              curto: dif === 0 ? euros(numerario.contado) : `${euros(numerario.contado)} ≠ ${euros(numerario.esperado)}`,
              detalhe: `Contado ${euros(numerario.contado)} · Diário ${euros(numerario.esperado)}`,
            },
      );
    }
    if (!temDiario) verificacoes.length = 0;
    const estado = verificacoes.some((v) => v.ok === false) ? 'erro' : verificacoes.some((v) => v.ok === null) ? 'pendente' : 'ok';

    return {
      tipo: meio.tipo, tpa: Boolean(meio.tpa), chave: chaveDoMeio(meio.tipo),
      movimentos: movs, faturasSemMovimento, semFatura, semTalao,
      diario, faturado, taloes: taloesMeio, taloesSoma, verificacoes, estado,
      extrato: extrato ? { ...extrato, temExtratos: bancario.temExtratos } : null,
    };
  });
  return { porMeio, taloesSemMeio };
}
