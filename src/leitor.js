// Leitura automática das fotografias de talões TPA com o Claude.
import Anthropic from '@anthropic-ai/sdk';
import { config, guardarConfig, run } from './db.js';
import { cifrarTexto, decifrarTexto } from './cifra.js';

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

// ---------- Fornecedores e chaves ----------
// O administrador escolhe em Configuração › Leitura de talões que serviço lê os talões (Anthropic/Claude ou Google
// Gemini) e adiciona a respetiva chave de API. As chaves ficam na base de dados (encriptadas se houver ENCRYPTION_KEY).
// Se não houver chave guardada, usam-se as variáveis de ambiente (ANTHROPIC_API_KEY, GEMINI_API_KEY).
export const FORNECEDORES = {
  anthropic: { nome: 'Anthropic (Claude)', cfg: 'anthropic_api_key', env: ['ANTHROPIC_API_KEY'], formato: /^sk-ant-[\w-]{20,}$/, dica: 'começa por "sk-ant-"' },
  gemini: { nome: 'Google Gemini', cfg: 'gemini_api_key', env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], formato: /^[\w.-]{20,}$/, dica: 'a chave do Google AI Studio' },
};
const CFG_ATIVO = 'leitura_fornecedor';
const CFG_MODELO_GEMINI = 'gemini_modelo';
export const MODELO_GEMINI_OMISSAO = 'gemini-3.8-flash';
const API_GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

const fornecedorValido = (f) => {
  if (!FORNECEDORES[f]) throw new ErroLeitura('Fornecedor desconhecido.');
  return f;
};

async function chaveGuardada(fornecedor) {
  const guardada = await config(FORNECEDORES[fornecedor].cfg, '');
  return guardada ? decifrarTexto(guardada) : '';
}

const chaveDoAmbiente = (fornecedor) => FORNECEDORES[fornecedor].env.map((n) => process.env[n]).find(Boolean) || '';
const chaveDe = async (fornecedor) => (await chaveGuardada(fornecedor)) || chaveDoAmbiente(fornecedor);

// Estado de um fornecedor: de onde vem a chave (base de dados ou ambiente) e os 4 últimos caracteres.
export async function estadoChave(fornecedor = 'anthropic') {
  fornecedorValido(fornecedor);
  const guardada = await chaveGuardada(fornecedor);
  if (guardada) return { origem: 'base', fim: guardada.slice(-4) };
  const ambiente = chaveDoAmbiente(fornecedor);
  if (ambiente) return { origem: 'ambiente', fim: ambiente.slice(-4) };
  if (fornecedor === 'anthropic' && process.env.ANTHROPIC_AUTH_TOKEN) return { origem: 'ambiente', fim: '' };
  return { origem: null, fim: '' };
}

// O fornecedor em uso: o escolhido pelo administrador (se tiver chave); senão o primeiro que tenha chave.
export async function estadoLeitura() {
  const fornecedores = {};
  for (const f of Object.keys(FORNECEDORES)) fornecedores[f] = await estadoChave(f);
  fornecedores.gemini.modelo = await config(CFG_MODELO_GEMINI, MODELO_GEMINI_OMISSAO);
  const escolhido = await config(CFG_ATIVO, '');
  const ativo = fornecedores[escolhido]?.origem ? escolhido : Object.keys(FORNECEDORES).find((f) => fornecedores[f].origem) || null;
  return { ativo, fornecedores };
}

const rejeitada = () => new ErroLeitura('O serviço não aceitou esta chave. Confirme que está completa e ativa.');

// Valida o formato e confirma com o fornecedor que a chave funciona (listar modelos não gasta créditos nem quota).
export async function validarChave(chave, fornecedor = 'anthropic', modelo = '') {
  fornecedorValido(fornecedor);
  const c = String(chave || '').trim();
  const { nome, formato, dica } = FORNECEDORES[fornecedor];
  if (!formato.test(c)) throw new ErroLeitura(`Isto não parece uma chave da API de ${nome} (${dica}).`);
  if (fornecedor === 'anthropic') {
    try {
      await new Anthropic({ apiKey: c, maxRetries: 0, timeout: 15_000 }).models.list({ limit: 1 });
    } catch (erro) {
      if (erro instanceof Anthropic.AuthenticationError || erro instanceof Anthropic.PermissionDeniedError) throw rejeitada();
      return { confirmada: false }; // rede ou serviço indisponível: a chave pode estar boa; guarda-se na mesma
    }
    return { confirmada: true };
  }
  try {
    const r = await fetch(`${API_GEMINI}/models?pageSize=1`, { headers: { 'x-goog-api-key': c }, signal: AbortSignal.timeout(15_000) });
    if ([400, 401, 403].includes(r.status)) throw rejeitada();
    if (!r.ok) return { confirmada: false };
    const m = String(modelo || '').trim();
    if (m) {
      const rm = await fetch(`${API_GEMINI}/models/${encodeURIComponent(m)}`, { headers: { 'x-goog-api-key': c }, signal: AbortSignal.timeout(15_000) });
      if (rm.status === 404) throw new ErroLeitura(`O modelo "${m}" não existe. Deixe o campo em branco para usar ${MODELO_GEMINI_OMISSAO}.`);
    }
    return { confirmada: true };
  } catch (erro) {
    if (erro instanceof ErroLeitura) throw erro;
    return { confirmada: false };
  }
}

// Guarda a chave e passa a usar esse fornecedor.
export async function guardarChave(chave, fornecedor = 'anthropic', { modelo } = {}) {
  fornecedorValido(fornecedor);
  await guardarConfig(FORNECEDORES[fornecedor].cfg, cifrarTexto(String(chave).trim()));
  if (fornecedor === 'gemini') await guardarConfig(CFG_MODELO_GEMINI, String(modelo || '').trim() || MODELO_GEMINI_OMISSAO);
  await guardarConfig(CFG_ATIVO, fornecedor);
  clienteAnthropic = null;
}

export async function removerChave(fornecedor = 'anthropic') {
  fornecedorValido(fornecedor);
  await run('DELETE FROM config WHERE chave = ?', FORNECEDORES[fornecedor].cfg);
  if ((await config(CFG_ATIVO, '')) === fornecedor) await run('DELETE FROM config WHERE chave = ?', CFG_ATIVO);
  clienteAnthropic = null;
}

// Escolhe qual dos fornecedores (com chave) lê os talões.
export async function definirAtivo(fornecedor) {
  fornecedorValido(fornecedor);
  if (!(await estadoChave(fornecedor)).origem) throw new ErroLeitura('Adicione primeiro a chave deste fornecedor.');
  await guardarConfig(CFG_ATIVO, fornecedor);
}

const NAO_CONFIGURADA = 'A leitura automática não está configurada. O administrador pode adicionar a chave da API em Configuração › Leitura de talões.';

// ---------- Leitura com a Anthropic (Claude) ----------
let clienteAnthropic;
let clienteChave;

async function obterClienteAnthropic() {
  const chave = await chaveDe('anthropic');
  if (!chave && !process.env.ANTHROPIC_AUTH_TOKEN) throw new ErroLeitura(NAO_CONFIGURADA);
  if (!clienteAnthropic || clienteChave !== chave) {
    clienteAnthropic = new Anthropic({ ...(chave && { apiKey: chave }), maxRetries: 1, timeout: 90_000 });
    clienteChave = chave;
  }
  return clienteAnthropic;
}

async function lerComAnthropic(ficheiro) {
  let resposta;
  try {
    resposta = await (await obterClienteAnthropic()).beta.messages.create({
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
    if (erro instanceof ErroLeitura) throw erro;
    if (erro instanceof Anthropic.AuthenticationError) throw new ErroLeitura('A chave da API não é válida. O administrador pode atualizá-la em Configuração › Leitura de talões.');
    if (erro instanceof Anthropic.RateLimitError) throw new ErroLeitura('O serviço de leitura está ocupado. Tente daqui a pouco.');
    if (erro instanceof Anthropic.APIError) throw new ErroLeitura(`O serviço de leitura devolveu um erro (${erro.status ?? 'sem resposta'}).`);
    throw new ErroLeitura('Não foi possível usar o serviço de leitura automática.');
  }
  if (resposta.stop_reason === 'refusal') throw new ErroLeitura('O serviço de leitura recusou este ficheiro.');
  if (resposta.stop_reason === 'max_tokens') throw new ErroLeitura('A leitura ficou incompleta.');
  return resposta.content.find((b) => b.type === 'text')?.text ?? '';
}

// ---------- Leitura com o Google Gemini ----------
// O Gemini devolve JSON (responseMimeType); o formato exato vai descrito nas instruções e, como em todos os
// fornecedores, é validado em normalizar() antes de chegar ao ecrã.
const FORMATO_JSON = `

Responde apenas com JSON, sem texto à volta, neste formato (um objeto por talão; usa null quando não souberes):
{"taloes":[{"tipo":"compra"|"fecho"|"outro","tpa":string|null,"data":string|null,"hora":string|null,"valor":number|null,"cartao":string|null,"ultimos4":string|null,"num_compras":number|null,"id_reserva":string|null,"id_reserva_duvidoso":boolean,"legivel":boolean}]}`;

async function lerComGemini(bytes, mime) {
  const chave = await chaveDe('gemini');
  if (!chave) throw new ErroLeitura(NAO_CONFIGURADA);
  const modelo = await config(CFG_MODELO_GEMINI, MODELO_GEMINI_OMISSAO);
  let r;
  try {
    r = await fetch(`${API_GEMINI}/models/${encodeURIComponent(modelo)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': chave, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: INSTRUCOES + FORMATO_JSON }] },
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data: bytes.toString('base64') } }, { text: 'Extrai os talões deste ficheiro.' }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 8192 },
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new ErroLeitura('Não foi possível contactar o serviço de leitura (Google Gemini). Tente de novo.');
  }
  if ([401, 403].includes(r.status) || (r.status === 400 && /API_KEY_INVALID|API key not valid/i.test(await r.clone().text()))) {
    throw new ErroLeitura('A chave da API não é válida. O administrador pode atualizá-la em Configuração › Leitura de talões.');
  }
  if (r.status === 429) throw new ErroLeitura('Foi atingido o limite de uso do serviço de leitura (Google Gemini). Tente daqui a pouco.');
  if (r.status === 404) throw new ErroLeitura(`O modelo "${modelo}" não está disponível. O administrador pode mudá-lo em Configuração › Leitura de talões.`);
  if (!r.ok) throw new ErroLeitura(`O serviço de leitura devolveu um erro (${r.status}).`);

  const j = await r.json().catch(() => ({}));
  if (j.promptFeedback?.blockReason) throw new ErroLeitura('O serviço de leitura recusou este ficheiro.');
  const candidato = j.candidates?.[0];
  if (candidato?.finishReason === 'MAX_TOKENS') throw new ErroLeitura('A leitura ficou incompleta.');
  return (candidato?.content?.parts ?? []).map((p) => p.text ?? '').join('');
}

// O ficheiro chega como Buffer (o conteúdo vem da base de dados ou do pedido), já não como caminho em disco.
export async function lerTaloes(bytes, mime) {
  const eImagem = MIMES_IMAGEM.includes(mime);
  if (!eImagem && mime !== 'application/pdf') throw new ErroLeitura('Tipo de ficheiro não suportado pela leitura automática.');
  if (eImagem && bytes.length > MAX_IMAGEM) throw new ErroLeitura('A fotografia é demasiado grande para a leitura automática.');

  const { ativo } = await estadoLeitura();
  if (!ativo) throw new ErroLeitura(NAO_CONFIGURADA);
  let texto;
  if (ativo === 'gemini') {
    texto = await lerComGemini(bytes, mime);
  } else {
    const data = bytes.toString('base64');
    texto = await lerComAnthropic(eImagem
      ? { type: 'image', source: { type: 'base64', media_type: mime, data } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
  }

  let lido;
  try {
    // alguns modelos põem o JSON dentro de um bloco de código
    lido = JSON.parse(texto.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    throw new ErroLeitura('A leitura devolveu um resultado que não foi possível interpretar.');
  }
  const lista = Array.isArray(lido) ? lido : lido?.taloes;
  return (Array.isArray(lista) ? lista : []).filter((t) => t?.tipo === 'compra' || t?.tipo === 'fecho').map(normalizar);
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
