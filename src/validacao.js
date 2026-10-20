// Validação dos valores do fecho pelo auditor: CASH, TPA, STRIPE, TBBOOKING e TRFBANCO.
// É a mesma validação em todo o lado onde o valor aparece (lista de fechos e página de cada fecho).
// Guarda-se o valor validado: se o diário for recarregado e o valor mudar, a validação deixa de contar.
import { all, run, agora } from './db.js';

// TPA junta todos os meios marcados como terminal em Configuração › Meios de pagamento.
export const CANAIS_FECHO = ['cash', 'tpa', 'stripe', 'tbbooking', 'trfbanco'];
export const ROTULO_CANAL = { cash: 'CASH', tpa: 'TPA', stripe: 'STRIPE', tbbooking: 'TBBOOKING', trfbanco: 'TRFBANCO' };
const MEIO_PARA_CANAL = { CASH: 'cash', STRIPE: 'stripe', TBBOOKING: 'tbbooking', TRFBANCO: 'trfbanco' };

export const centimos = (v) => Math.round((v ?? 0) * 100);
export const canalDoMeio = (tipo, eTPA) => (eTPA ? 'tpa' : MEIO_PARA_CANAL[tipo] || null);

export const mapaValidacoes = async () =>
  new Map((await all('SELECT v.*, u.nome AS autor FROM fecho_validacoes v JOIN users u ON u.id = v.user_id')).map((x) => [`${x.data}|${x.meio}`, x]));

// O TPA valida-se sozinho quando os talões comprovam o valor por inteiro: a mesma regra das validações "Os talões
// comprovam o valor do diário" e "Todos os pagamentos têm talão" da análise por meio. Cada talão conta logo que
// entra na app (também por confirmar) e só prova o que casou com um documento do diário.
async function tpaProvadoPorTaloes(data) {
  const meiosTPA = new Set((await all('SELECT codigo FROM meios WHERE tpa = 1')).map((m) => m.codigo));
  const movs = (await all('SELECT doc, tipo, valor FROM movimentos WHERE data = ? ORDER BY hora, id', data)).map((m) => ({ ...m, c: centimos(m.valor) }));
  const taloes = await all(`SELECT t.id, t.valor, t.doc_associado, e.estado FROM taloes t JOIN envios e ON e.id = t.envio_id WHERE t.data = ? AND t.tipo = 'compra'`, data);

  const tipoDoDoc = new Map();
  for (const m of movs) if (m.doc && !tipoDoDoc.has(m.doc)) tipoDoDoc.set(m.doc, m.tipo);
  const taloesDoDoc = new Map();
  const taloesDoMeio = new Map();
  for (const t of taloes) {
    const docs = (t.doc_associado || '').split(', ').filter(Boolean);
    for (const d of docs) taloesDoDoc.set(d, [...(taloesDoDoc.get(d) || []), t]);
    const tipo = docs.map((d) => tipoDoDoc.get(d)).find(Boolean);
    if (tipo) taloesDoMeio.set(tipo, [...(taloesDoMeio.get(tipo) || []), t]);
  }

  let meiosComMovimentos = 0;
  const usados = new Set();
  for (const tipo of meiosTPA) {
    const doMeio = movs.filter((m) => m.tipo === tipo);
    if (!doMeio.length) continue;
    meiosComMovimentos++;
    // Um pagamento anulado por uma nota de crédito do mesmo valor não precisa de talão.
    const negativos = doMeio.filter((m) => m.c < 0).map((m) => ({ m, usado: false }));
    for (const m of doMeio.filter((x) => x.c > 0)) {
      const n = negativos.find((x) => !x.usado && -x.m.c === m.c);
      if (n) {
        n.usado = true;
        m.anulado = true;
        n.m.anulado = true;
      }
    }
    const diario = doMeio.reduce((s, m) => s + m.c, 0);
    const doTipo = taloesDoMeio.get(tipo) || [];
    const soma = doTipo.reduce((s, t) => s + centimos(t.valor), 0);
    const semTalao = doMeio.filter((m) => m.c > 0 && !m.anulado && !(taloesDoDoc.get(m.doc) || []).length);
    if (soma !== diario || semTalao.length) return { provado: false };
    doTipo.forEach((t) => usados.add(t.id));
  }
  const porConfirmar = taloes.filter((t) => usados.has(t.id) && t.estado === 'rascunho').length;
  return { provado: meiosComMovimentos > 0, taloes: usados.size, porConfirmar };
}

// Estado da validação de um dia. O total só é válido quando todos os meios com movimentos estão validados
// e, somados, cobrem o total do diário (nenhum meio fica de fora).
export async function validacaoDoDia(data, mapaDado) {
  const mapa = mapaDado ?? (await mapaValidacoes());
  const valores = Object.fromEntries(CANAIS_FECHO.map((c) => [c, 0]));
  let total = 0;
  for (const m of await all('SELECT m.tipo, SUM(m.valor) AS v, COALESCE(x.tpa, 0) AS tpa FROM movimentos m LEFT JOIN meios x ON x.codigo = m.tipo WHERE m.data = ? GROUP BY m.tipo, x.tpa', data)) {
    total += m.v;
    const canal = canalDoMeio(m.tipo, m.tpa);
    if (canal) valores[canal] += m.v;
  }
  const canais = {};
  let exigidos = 0;
  let validados = 0;
  let coberto = 0;
  const proveTPA = valores.tpa ? await tpaProvadoPorTaloes(data) : { provado: false };
  for (const c of CANAIS_FECHO) {
    const valor = centimos(valores[c]);
    coberto += valor;
    if (!valor) {
      canais[c] = { valor: 0, validado: false, mudou: false };
      continue; // sem movimentos neste meio: não há nada a validar
    }
    exigidos++;
    const x = mapa.get(`${data}|${c}`);
    const manual = Boolean(x) && x.valor_cent === valor;
    // O auditor manda: se validou à mão, fica a validação dele. Sem ela, os talões podem validar o TPA.
    const auto = c === 'tpa' && !manual && proveTPA.provado;
    if (manual || auto) validados++;
    canais[c] = {
      valor, validado: manual || auto, mudou: Boolean(x) && !manual, autor: x?.autor, quando: x?.quando,
      ...(auto ? { auto: true, taloes: proveTPA.taloes, porConfirmar: proveTPA.porConfirmar } : {}),
    };
  }
  return { canais, exigidos, validados, validado: exigidos > 0 && validados === exigidos && coberto === centimos(total) };
}

// O auditor dá um valor como correto (guarda o valor atual do diário) ou retira a validação.
export async function definirValidacao(data, canal, validado, userId) {
  if (!CANAIS_FECHO.includes(canal)) return;
  if (!validado) {
    await run('DELETE FROM fecho_validacoes WHERE data = ? AND meio = ?', data, canal);
    return;
  }
  const { valor } = (await validacaoDoDia(data)).canais[canal];
  if (valor) await run('INSERT INTO fecho_validacoes (data, meio, valor_cent, user_id, quando) VALUES (?, ?, ?, ?, ?) ON CONFLICT (data, meio) DO UPDATE SET valor_cent = excluded.valor_cent, user_id = excluded.user_id, quando = excluded.quando', data, canal, valor, userId, agora());
}
