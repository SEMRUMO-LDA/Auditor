// Copia os dados para o Postgres atual: o do DATABASE_URL (Supabase), ou o Postgres local se não houver DATABASE_URL.
//
//   npm run migrar                       copia o SQLite antigo (data/caixas.db); só se o destino estiver vazio
//   npm run migrar -- --origem local     copia o Postgres local (data/pglite) para o Supabase (DATABASE_URL)
//   npm run migrar -- --origem outro.db  outra base de dados SQLite de origem
//   npm run migrar -- --substituir       apaga primeiro o que já estiver no destino
//
// A origem só é lida; nunca é alterada. Se alguma tabela ficar com um número de linhas diferente, nada é gravado.
import '../src/env.js';
import path from 'node:path';
import { DATA_DIR, DESTINO, fecharBaseDeDados } from '../src/db.js';
import { migrar } from '../src/migracao.js';

const args = process.argv.slice(2);
const opcao = (nome) => (args.includes(nome) ? args[args.indexOf(nome) + 1] : null);
const origem = opcao('--origem') || path.join(DATA_DIR, 'caixas.db');
const substituir = args.includes('--substituir');

if (origem === 'local' && DESTINO !== 'postgres') {
  console.error('Para copiar do Postgres local é preciso um destino: defina o DATABASE_URL no ficheiro .env (Supabase).');
  process.exit(1);
}
console.log(`Origem : ${origem === 'local' ? 'Postgres local (data/pglite)' : path.resolve(origem)}`);
console.log(`Destino: ${DESTINO === 'postgres' ? 'Postgres (DATABASE_URL)' : 'Postgres local (data/pglite)'}`);

try {
  const resultado = await migrar({ origem, substituir });
  console.log('\nTabela                  origem  destino');
  for (const r of resultado) console.log(`${r.tabela.padEnd(22)} ${String(r.origem).padStart(7)} ${String(r.destino).padStart(8)}  ✓`);
  console.log('\nMigração concluída: todas as tabelas têm o mesmo número de linhas.');
} catch (erro) {
  console.error(`\n${erro.message}`);
  process.exitCode = 1;
} finally {
  await fecharBaseDeDados();
}
