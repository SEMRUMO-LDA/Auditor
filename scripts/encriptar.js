// Encriptação dos dados sensíveis já guardados (ver src/cifra.js).
//
//   npm run encriptar -- --gerar     escreve uma chave nova (guarde-a num gestor de palavras-passe; não a partilhe)
//   npm run encriptar                encripta o que ainda estiver em claro, com a ENCRYPTION_KEY do .env
//   npm run encriptar -- --estado    só mostra quantos valores estão cifrados e quantos estão em claro
//
// Para trocar de chave: ponha a chave antiga em ENCRYPTION_KEY_ANTERIOR e a nova em ENCRYPTION_KEY, e corra
// "npm run encriptar -- --rodar" (volta a cifrar tudo com a nova). Cada tabela é tratada numa transação e confirma-se,
// antes de gravar, que o valor cifrado volta ao original; se algo falhar, nada fica alterado.
import '../src/env.js';
import { gerarChave } from '../src/cifra.js';

if (process.argv.includes('--gerar')) {
  console.log(gerarChave());
  process.exit(0);
}
process.env.DATABASE_ESQUEMA = '0';
const { all, run, tx, DESTINO, fecharBaseDeDados } = await import('../src/db.js');
const { cifraAtiva, cifrarTexto, cifrarBytes } = await import('../src/cifra.js');

const soEstado = process.argv.includes('--estado');
const rodar = process.argv.includes('--rodar');
if (!soEstado && !cifraAtiva) {
  console.error('Defina ENCRYPTION_KEY no ficheiro .env (crie uma com: npm run encriptar -- --gerar).');
  process.exit(1);
}
console.log(`Base de dados: ${DESTINO === 'postgres' ? 'Postgres (DATABASE_URL)' : 'Postgres local (data/pglite)'}\n`);

const CAMPOS = [
  { tabela: 'taloes', chave: 'id', coluna: 'cartao', texto: true },
  { tabela: 'taloes', chave: 'id', coluna: 'ultimos4', texto: true },
  { tabela: 'inconsistencias', chave: 'id', coluna: 'detalhe_json', texto: true },
  { tabela: 'envio_ficheiros', chave: 'envio_id', coluna: 'conteudo', texto: false },
];
const igual = (a, b) => (Buffer.isBuffer(a) || a instanceof Uint8Array ? Buffer.from(a).equals(Buffer.from(b)) : a === b);

// "cif" diz se o valor guardado já está cifrado (a leitura devolve sempre o valor original, já decifrado)
const SQL_CIF = (coluna, texto) => (texto ? `${coluna} LIKE 'enc:v1:%'` : `substring(${coluna} from 1 for 4) = 'ENC1'::bytea`);
const ONDE = (coluna, texto) => `${coluna} IS NOT NULL${texto ? ` AND ${coluna} <> ''` : ''}`;
const contar = async ({ tabela, coluna, texto }) => ({
  total: (await all(`SELECT COUNT(*) AS n FROM ${tabela} WHERE ${ONDE(coluna, texto)}`))[0].n,
  cifrados: (await all(`SELECT COUNT(*) AS n FROM ${tabela} WHERE ${ONDE(coluna, texto)} AND ${SQL_CIF(coluna, texto)}`))[0].n,
});

try {
  for (const campo of CAMPOS) {
    const { tabela, chave, coluna, texto } = campo;
    let feitos = 0;
    if (!soEstado) {
      const linhas = await all(`SELECT ${chave} AS k, ${coluna} AS v, ${SQL_CIF(coluna, texto)} AS cif FROM ${tabela} WHERE ${ONDE(coluna, texto)}`);
      await tx(async () => {
        for (const { k, v, cif } of linhas) {
          if (cif && !rodar) continue; // já cifrado
          await run(`UPDATE ${tabela} SET ${coluna} = ? WHERE ${chave} = ?`, texto ? cifrarTexto(v) : cifrarBytes(v), k);
          feitos++;
        }
        // confirmação: lido de volta, cada valor tem de ser igual ao original
        const antes = new Map(linhas.map((l) => [l.k, l.v]));
        for (const d of await all(`SELECT ${chave} AS k, ${coluna} AS v FROM ${tabela} WHERE ${ONDE(coluna, texto)}`)) {
          if (!igual(d.v, antes.get(d.k))) throw new Error(`${tabela}.${coluna} (${chave} ${d.k}): o valor cifrado não volta ao original. Nada foi alterado.`);
        }
      });
    }
    const { total, cifrados } = await contar(campo);
    console.log(`${`${tabela}.${coluna}`.padEnd(30)} ${String(cifrados).padStart(6)} cifrados de ${String(total).padStart(6)}${soEstado ? '' : `  (${feitos} gravados agora)`}`);
  }
  if (!soEstado) console.log('\nConcluído.');
} catch (erro) {
  console.error(`\nFalhou: ${erro.message}`);
  process.exitCode = 1;
} finally {
  await fecharBaseDeDados();
}
