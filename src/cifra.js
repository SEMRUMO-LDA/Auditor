// Encriptação ao nível da aplicação (AES-256-GCM) dos dados mais sensíveis, antes de irem para a base de dados:
//   - taloes.cartao e taloes.ultimos4 (dados do cartão)
//   - inconsistencias.detalhe_json (nomes de hóspedes, reservas e cartões copiados para o detalhe)
//   - envio_ficheiros.conteudo (fotografias e PDF dos talões)
// Assim, quem tiver acesso à base de dados (painel do Supabase, cópias de segurança) vê apenas texto cifrado.
//
// A chave vem da variável ENCRYPTION_KEY (32 bytes em hexadecimal ou base64; "npm run encriptar -- --gerar" cria uma).
// Sem chave a encriptação fica desligada e os dados gravam-se como antes. Os valores antigos (sem cifra) continuam a
// ler-se, por isso a mudança pode fazer-se por fases. ENCRYPTION_KEY_ANTERIOR permite trocar de chave sem perder dados.
// ATENÇÃO: sem a chave, os dados cifrados não se recuperam. Guarde uma cópia da chave num gestor de palavras-passe.
import crypto from 'node:crypto';

const PREFIXO = 'enc:v1:'; // texto cifrado
const MAGIA = Buffer.from('ENC1'); // ficheiros cifrados
const IV = 12;
const TAG = 16;

function lerChave(valor, nome) {
  const v = (valor || '').trim();
  if (!v) return null;
  const bytes = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (bytes.length !== 32) {
    console.error(`\nErro de configuração: ${nome} tem de ter 32 bytes (64 caracteres hexadecimais). Crie uma com: npm run encriptar -- --gerar\n`);
    process.exit(1);
  }
  return bytes;
}

const CHAVE = lerChave(process.env.ENCRYPTION_KEY, 'ENCRYPTION_KEY');
const CHAVES = [CHAVE, lerChave(process.env.ENCRYPTION_KEY_ANTERIOR, 'ENCRYPTION_KEY_ANTERIOR')].filter(Boolean);
export const cifraAtiva = Boolean(CHAVE);

export const gerarChave = () => crypto.randomBytes(32).toString('hex');

function cifrar(bytes) {
  const iv = crypto.randomBytes(IV);
  const c = crypto.createCipheriv('aes-256-gcm', CHAVE, iv);
  const dados = Buffer.concat([c.update(bytes), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), dados]);
}

function decifrar(pacote) {
  if (!CHAVES.length) throw new Error('Há dados encriptados mas falta a variável ENCRYPTION_KEY.');
  const iv = pacote.subarray(0, IV);
  const tag = pacote.subarray(IV, IV + TAG);
  const dados = pacote.subarray(IV + TAG);
  for (const chave of CHAVES) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', chave, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(dados), d.final()]);
    } catch {
      // chave errada (ou dados alterados): tenta a seguinte
    }
  }
  throw new Error('Não foi possível decifrar os dados: ENCRYPTION_KEY errada ou dados alterados.');
}

export function cifrarTexto(texto) {
  if (!cifraAtiva || texto === null || texto === undefined || texto === '') return texto;
  const t = String(texto);
  return t.startsWith(PREFIXO) ? t : PREFIXO + cifrar(Buffer.from(t, 'utf8')).toString('base64');
}

export function decifrarTexto(texto) {
  if (typeof texto !== 'string' || !texto.startsWith(PREFIXO)) return texto;
  return decifrar(Buffer.from(texto.slice(PREFIXO.length), 'base64')).toString('utf8');
}

export function cifrarBytes(bytes) {
  if (!cifraAtiva || !bytes) return bytes;
  const b = Buffer.from(bytes);
  return b.subarray(0, MAGIA.length).equals(MAGIA) ? b : Buffer.concat([MAGIA, cifrar(b)]);
}

export function decifrarBytes(bytes) {
  if (!bytes) return bytes;
  const b = Buffer.from(bytes);
  return b.subarray(0, MAGIA.length).equals(MAGIA) ? decifrar(b.subarray(MAGIA.length)) : b;
}

// Colunas cifradas. Nenhuma é usada em filtros, ordenações ou agrupamentos do SQL, por isso podem ficar cifradas sem
// afetar as pesquisas da app.
export const COLUNAS_TEXTO = ['cartao', 'ultimos4', 'detalhe_json'];
export const COLUNAS_BYTES = ['conteudo'];

// Aplica-se a cada linha lida da base de dados (ver db.js): decifra as colunas acima, se estiverem cifradas.
export function decifrarLinha(linha) {
  for (const c of COLUNAS_TEXTO) if (typeof linha[c] === 'string' && linha[c].startsWith(PREFIXO)) linha[c] = decifrarTexto(linha[c]);
  for (const c of COLUNAS_BYTES) if (linha[c] && typeof linha[c] === 'object') linha[c] = decifrarBytes(linha[c]);
  return linha;
}

// Cifra um valor de uma coluna pelo nome (para a migração de dados); outras colunas passam sem alteração.
export function cifrarColuna(nome, valor) {
  if (COLUNAS_TEXTO.includes(nome)) return cifrarTexto(valor);
  if (COLUNAS_BYTES.includes(nome)) return cifrarBytes(valor);
  return valor;
}
