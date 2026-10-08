// Carrega para a aplicação os ficheiros do PMS que estiverem numa pasta, sem passar pelo browser.
// Uso: npm run importar -- "C:\caminho\da\pasta"   (por omissão, a pasta acima desta)
import './src/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { all } from './src/db.js';
import { importar } from './src/fechos.js';
import { ErroFicheiro } from './src/parsers.js';

const pasta = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'));
const ficheiros = fs
  .readdirSync(pasta)
  .filter((f) => /\.(csv|xls)$/i.test(f))
  .map((f) => ({ nome: f, buffer: fs.readFileSync(path.join(pasta, f)) }));

try {
  const { data, ficheiros: lidos } = importar(ficheiros, null);
  console.log(`Dia ${data.split('-').reverse().join('/')} carregado a partir de ${pasta}`);
  for (const f of lidos) console.log(`  ${f.descricao.padEnd(22)} ${f.nome}`);
  const porGravidade = all('SELECT gravidade, COUNT(*) AS n FROM inconsistencias WHERE data = ? AND ativa = 1 GROUP BY gravidade', data);
  console.log(`Inconsistências: ${porGravidade.map((g) => `${g.n} ${g.gravidade}`).join(', ') || 'nenhuma'}`);
} catch (erro) {
  if (!(erro instanceof ErroFicheiro)) throw erro;
  console.error(erro.message);
  process.exitCode = 1;
}
