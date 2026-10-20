// Leitura automática das fotografias de talões TPA com o Claude.
import Anthropic from '@anthropic-ai/sdk';

export const MIMES_IMAGEM = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGEM = 5 * 1024 * 1024;

const INSTRUCOES = `Vais ler fotografias ou digitalizações de talões de terminais de pagamento (TPA) portugueses, enviadas pela receção de um grupo hoteleiro. Os valores que extraíres são cruzados com a contabilidade e depois confirmados por uma pessoa, por isso um valor errado é pior do que um valor em falta: quando não conseguires ler um campo com segurança, devolve null nesse campo.

Uma imagem pode conter vários talões lado a lado. Devolve um registo por talão.

Tipos de talão:
- "compra": uma transação de cartão. Tem a palavra COMPRA, a marca do cartão (por exemplo VISA, MASTERCARD, MULTIBANCO) e o número do cartão mascarado.
- "fecho": o fecho do terminal, com cabeçalho como "TOTAIS TPA" ou "FECHO". Resume as transações do período.
- "outro": qualquer outra coisa (devolução, cópia ilegível, papel que não é um talão).

Campos:
- tpa: o identificador do terminal, que aparece depois de "Ident. TPA:". Só os dígitos, mantendo zeros à esquerda.
- data: nestes talões a data vem no formato AA-MM-DD ("26-10-05" é 5 de outubro de 2026). Devolve AAAA-MM-DD.
- hora: HH:MM:SS.
- valor: num talão de compra, o valor da compra. Num talão de fecho, o total bruto das compras (linha COMPRA ou "Valor"), e não o "TOTAL A MOVIMENTAR", que já vem deduzido da comissão.
- cartao: a marca do cartão tal como está impressa (só em compras).
- ultimos4: os últimos quatro dígitos do cartão (só em compras).
- num_compras: num talão de fecho, o número de compras indicado; nos outros, null.
- id_reserva: a receção escreve à mão no talão de compra o número da reserva no sistema do hotel, normalmente com seis dígitos. Devolve só os dígitos. Se houver vários números manuscritos, separa-os por vírgulas. Se não houver nenhum número manuscrito, devolve null; não uses números impressos no talão como reserva.
- id_reserva_duvidoso: true se algum dígito manuscrito for ambíguo (por exemplo, não se distingue um 1 de um 7). Nesse caso devolve a tua melhor leitura em id_reserva.
- legivel: false se o talão estiver cortado, desbotado ou desfocado ao ponto de algum campo impresso importante (terminal, data, valor) ficar por ler.`;

const texto = { type: ['string', 'null'] };
const ESQUEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['taloes'],
  properties: {
    taloes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tipo', 'tpa', 'data', 'hora', 'valor', 'cartao', 'ultimos4', 'num_compras', 'id_reserva', 'id_reserva_duvidoso', 'legivel'],
        properties: {
          tipo: { type: 'string', enum: ['compra', 'fecho', 'outro'] },
          tpa: texto,
          data: texto,
          hora: texto,
          valor: { type: ['number', 'null'] },
          cartao: texto,
          ultimos4: texto,
          num_compras: { type: ['integer', 'null'] },
          id_reserva: texto,
          id_reserva_duvidoso: { type: 'boolean' },
          legivel: { type: 'boolean' },
        },
      },
    },
  },
};

export class ErroLeitura extends Error {}

let cliente;

// O ficheiro chega como Buffer (o conteúdo vem da base de dados ou do pedido), já não como caminho em disco.
export async function lerTaloes(bytes, mime) {
  const eImagem = MIMES_IMAGEM.includes(mime);
  if (!eImagem && mime !== 'application/pdf') throw new ErroLeitura('Tipo de ficheiro não suportado pela leitura automática.');
  if (eImagem && bytes.length > MAX_IMAGEM) throw new ErroLeitura('A fotografia é demasiado grande para a leitura automática.');

  const data = bytes.toString('base64');
  const ficheiro = eImagem
    ? { type: 'image', source: { type: 'base64', media_type: mime, data } }
    : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };

  let resposta;
  try {
    cliente ??= new Anthropic({ maxRetries: 1, timeout: 90_000 });
    resposta = await cliente.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      // Se o modelo recusar o pedido por engano, a API repete-o noutro modelo em vez de devolver a recusa.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: ESQUEMA } },
      system: INSTRUCOES,
      messages: [{ role: 'user', content: [ficheiro, { type: 'text', text: 'Extrai os talões deste ficheiro.' }] }],
    });
  } catch (erro) {
    if (erro instanceof Anthropic.AuthenticationError) throw new ErroLeitura('A chave da API não é válida.');
    if (erro instanceof Anthropic.RateLimitError) throw new ErroLeitura('O serviço de leitura está ocupado. Tente daqui a pouco.');
    if (erro instanceof Anthropic.APIError) throw new ErroLeitura(`O serviço de leitura devolveu um erro (${erro.status ?? 'sem resposta'}).`);
    throw new ErroLeitura('A leitura automática não está configurada (falta a chave da API).');
  }

  if (resposta.stop_reason === 'refusal') throw new ErroLeitura('O serviço de leitura recusou este ficheiro.');
  if (resposta.stop_reason === 'max_tokens') throw new ErroLeitura('A leitura ficou incompleta.');
  const bloco = resposta.content.find((b) => b.type === 'text');
  let lido;
  try {
    lido = JSON.parse(bloco?.text ?? '');
  } catch {
    throw new ErroLeitura('A leitura devolveu um resultado que não foi possível interpretar.');
  }
  return (lido.taloes || []).filter((t) => t.tipo === 'compra' || t.tipo === 'fecho').map(normalizar);
}

// O modelo segue o esquema, mas os formatos de data, hora e reserva são validados aqui antes de chegarem ao ecrã.
function normalizar(t) {
  const so = (v, re) => (typeof v === 'string' && re.test(v.trim()) ? v.trim() : null);
  const reserva = String(t.id_reserva ?? '').split(/[^\d]+/).filter(Boolean).join(',');
  return {
    tipo: t.tipo,
    tpa: String(t.tpa ?? '').replace(/\D/g, '') || null,
    data: so(t.data, /^\d{4}-\d{2}-\d{2}$/),
    hora: so(t.hora, /^\d{2}:\d{2}(:\d{2})?$/),
    valor: typeof t.valor === 'number' && Number.isFinite(t.valor) ? Math.round(t.valor * 100) / 100 : null,
    cartao: t.tipo === 'compra' ? so(t.cartao, /\S/) : null,
    ultimos4: t.tipo === 'compra' ? so(t.ultimos4, /^\d{4}$/) : null,
    reserva: t.tipo === 'compra' ? reserva : '',
    duvidoso: Boolean(t.id_reserva_duvidoso) || t.legivel === false,
  };
}
