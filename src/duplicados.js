// Deteção de talões (pay slips) repetidos.
//  - Mesmo ficheiro: a mesma fotografia/PDF (impressão digital SHA-256) já enviada antes.
//  - Mesmo talão: o mesmo terminal, dia, hora, valor e tipo (e os mesmos últimos 4 dígitos do cartão, quando existem)
//    já registado noutro envio, mesmo que seja outra fotografia do mesmo papel.
import crypto from 'node:crypto';
import { all, get } from './db.js';
import { dataPT, euros, quandoPT } from './views.js';

export const hashFicheiro = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// O ficheiro já foi enviado? Devolve o envio anterior, ou undefined.
export const envioComFicheiro = (hash, excluirEnvioId = 0) =>
  get('SELECT id, criado_em FROM envios WHERE hash = ? AND id <> ? ORDER BY id LIMIT 1', hash, excluirEnvioId);

const horaCompleta = (h) => (/^\d{2}:\d{2}$/.test(String(h || '')) ? `${h}:00` : String(h || ''));
const cent = (v) => Math.round(Number(v) * 100);
// Dois talões com os últimos 4 dígitos diferentes são talões diferentes (dois clientes, mesmo valor, mesmo minuto).
const mesmoCartao = (a, b) => !a || !b || String(a) === String(b);

// Só se pode afirmar que é repetido com terminal, dia, hora e valor conhecidos.
const comparavel = (t) => Boolean(t.tpa && t.data && t.hora && t.valor !== null && t.valor !== undefined && Number.isFinite(Number(t.valor)));

// Para cada talão da lista, o talão igual já registado noutro envio ({ envio_id, criado_em }), ou o índice do talão
// anterior da própria lista que é igual. Devolve um array com o mesmo tamanho: null quando não é repetido.
export async function taloesRepetidos(taloes, excluirEnvioId = 0) {
  const resultado = [];
  for (let i = 0; i < taloes.length; i++) {
    const t = taloes[i];
    if (!comparavel(t)) {
      resultado.push(null);
      continue;
    }
    const hora = horaCompleta(t.hora);
    const iguais = (o) => comparavel(o) && o.tipo === t.tipo && String(o.tpa) === String(t.tpa) && o.data === t.data
      && horaCompleta(o.hora) === hora && cent(o.valor) === cent(t.valor) && mesmoCartao(o.ultimos4, t.ultimos4);
    const dentro = taloes.findIndex((o, j) => j < i && iguais(o));
    if (dentro >= 0) {
      resultado.push({ dentro: dentro + 1 });
      continue;
    }
    const candidatos = await all(
      `SELECT t.id, t.envio_id, t.ultimos4, e.criado_em FROM taloes t JOIN envios e ON e.id = t.envio_id
       WHERE t.tipo = ? AND t.tpa = ? AND t.data = ? AND t.envio_id <> ?
         AND CASE WHEN length(t.hora) = 5 THEN t.hora || ':00' ELSE t.hora END = ? AND ABS(t.valor - ?) < 0.005
       ORDER BY t.envio_id, t.id`,
      t.tipo, String(t.tpa), t.data, excluirEnvioId, hora, Number(t.valor),
    );
    const igual = candidatos.find((c) => mesmoCartao(c.ultimos4, t.ultimos4));
    resultado.push(igual ? { envio_id: igual.envio_id, criado_em: igual.criado_em } : null);
  }
  return resultado;
}

// Texto para o utilizador: o que é o talão e onde já está.
export function descreverRepetido(t, r, n) {
  const quem = `${t.tipo === 'fecho' ? 'fecho do terminal' : 'compra'} do terminal ${t.tpa}, ${dataPT(t.data)} às ${horaCompleta(t.hora)}, ${euros(t.valor)}`;
  const onde = r.dentro ? `é igual ao talão ${r.dentro} desta mesma fotografia` : `já foi enviado (envio #${r.envio_id}, em ${quandoPT(r.criado_em)})`;
  return `${n ? `Talão ${n}: ` : ''}${quem} ${onde}.`;
}
