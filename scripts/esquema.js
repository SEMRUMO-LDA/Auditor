// Cria (ou atualiza) as tabelas na base de dados do DATABASE_URL e liga o RLS. Seguro de repetir.
// Na Vercel a app não cria o esquema a cada arranque: corra isto uma vez, e sempre que o esquema mudar.
//
//   npm run esquema                 só o esquema
//   npm run esquema -- --ficheiros  também copia os talões de data/taloes para a base de dados
import '../src/env.js';
process.env.DATABASE_ESQUEMA = '0'; // o esquema é criado aqui, de forma explícita
const { DESTINO, criarEsquema, fecharBaseDeDados } = await import('../src/db.js');
const { importarFicheirosLocais, preencherHashes } = await import('../src/migracao.js');

console.log(`Destino: ${DESTINO === 'postgres' ? 'Postgres (DATABASE_URL)' : 'Postgres local (data/pglite)'}`);
try {
  await criarEsquema();
  console.log('Esquema criado/atualizado.');
  const hashes = await preencherHashes();
  if (hashes) console.log(`Impressões digitais calculadas para ${hashes} ficheiro(s) já enviados.`);
  if (process.argv.includes('--ficheiros')) console.log(`Ficheiros de talões copiados: ${await importarFicheirosLocais()}`);
} catch (erro) {
  console.error(`Falhou: ${erro.message}`);
  process.exitCode = 1;
} finally {
  await fecharBaseDeDados();
}
