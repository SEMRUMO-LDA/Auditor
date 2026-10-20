// Copia os dados de uma base de dados de origem para o Postgres atual (o do DATABASE_URL, ou o local).
// A origem pode ser o SQLite antigo (um ficheiro .db) ou o Postgres local (data/pglite), para quem começou
// a usar a app localmente e depois liga o Supabase. A origem só é lida; nunca é alterada.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, DATA_DIR, UPLOAD_DIR } from './db.js';
import { TABELAS } from './esquema.js';
import { cifrarColuna, cifrarBytes } from './cifra.js';

const LOTE = 400; // linhas por INSERT

async function abrirOrigem(origem) {
  if (origem === 'local') {
    const { PGlite, types } = await import('@electric-sql/pglite');
    const pasta = path.join(DATA_DIR, 'pglite');
    if (!fs.existsSync(pasta)) throw new Error(`Não existe nenhum Postgres local em ${pasta}.`);
    const bd = await PGlite.create(pasta, { parsers: { [types.INT8]: (v) => Number(v), [types.NUMERIC]: (v) => Number(v) } });
    const existentes = new Set((await bd.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((t) => t.table_name));
    return { existe: (t) => existentes.has(t), linhas: async (t) => (await bd.query(`SELECT * FROM ${t}`)).rows, fechar: () => bd.close() };
  }
  const ficheiro = path.resolve(origem);
  if (!fs.existsSync(ficheiro)) throw new Error(`Não encontro a base de dados de origem: ${ficheiro}`);
  const { DatabaseSync } = await import('node:sqlite'); // só aqui: não é preciso (nem carrega) no dia a dia
  const antiga = new DatabaseSync(ficheiro, { readOnly: true });
  const existentes = new Set(antiga.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
  return { existe: (t) => existentes.has(t), linhas: async (t) => antiga.prepare(`SELECT * FROM ${t}`).all(), fechar: () => antiga.close() };
}

export async function contarDestino() {
  const contagens = {};
  for (const t of TABELAS) contagens[t] = (await get(`SELECT COUNT(*) AS n FROM ${t}`)).n;
  return contagens;
}

// Devolve [{ tabela, origem, destino }]. Falha (sem alterar nada) se o destino já tiver dados e não se pedir "substituir".
export async function migrar({ origem, substituir = false }) {
  const contagens = await contarDestino();
  const nDestino = Object.values(contagens).reduce((a, b) => a + b, 0);
  if (nDestino > 0 && !substituir) {
    const com = Object.entries(contagens).filter(([, n]) => n).map(([t, n]) => `${t}: ${n}`).join(', ');
    throw new Error(`O destino já tem dados (${com}). Para o apagar e copiar de novo, use --substituir.`);
  }
  const fonte = await abrirOrigem(origem);
  const resultado = [];
  try {
    await tx(async () => {
      if (substituir) for (const t of [...TABELAS].reverse()) await run(`DELETE FROM ${t}`);
      for (const tabela of TABELAS) {
        if (!fonte.existe(tabela)) { resultado.push({ tabela, origem: 0, destino: 0 }); continue; }
        const linhas = await fonte.linhas(tabela);
        // só as colunas que existem nos dois lados
        const colunasDestino = new Set((await all('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?', tabela)).map((c) => c.column_name));
        const colunas = linhas.length ? Object.keys(linhas[0]).filter((c) => colunasDestino.has(c)) : [];
        for (let i = 0; i < linhas.length; i += LOTE) {
          const grupo = linhas.slice(i, i + LOTE);
          const marcadores = grupo.map(() => `(${colunas.map(() => '?').join(', ')})`).join(', ');
          const valores = grupo.flatMap((l) => colunas.map((c) => cifrarColuna(c, l[c] === undefined ? null : l[c])));
          await run(`INSERT INTO ${tabela} (${colunas.join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${marcadores}`, ...valores);
        }
        // os ids copiados à mão obrigam a acertar a sequência, para os próximos ids não colidirem
        if (colunasDestino.has('id')) {
          await get(`SELECT setval(pg_get_serial_sequence('${tabela}', 'id'), COALESCE((SELECT MAX(id) FROM ${tabela}), 1), (SELECT MAX(id) FROM ${tabela}) IS NOT NULL)`);
        }
        resultado.push({ tabela, origem: linhas.length, destino: (await get(`SELECT COUNT(*) AS n FROM ${tabela}`)).n });
      }
      // Se alguma tabela ficou com contagem diferente, desfaz tudo (a transação é revertida ao lançar o erro).
      const diferentes = resultado.filter((r) => r.origem !== r.destino);
      if (diferentes.length) throw new Error(`Contagens diferentes em: ${diferentes.map((r) => r.tabela).join(', ')}. Nada foi alterado.`);
    });
  } finally {
    await fonte.fechar();
  }
  return resultado;
}

// Os talões de antes de os ficheiros irem para a base de dados estão em data/taloes. Copia-os para envio_ficheiros
// (só os que ainda não lá estão) para que a app os mostre também quando não há disco, como na Vercel.
// Devolve quantos ficheiros foram copiados.
export async function importarFicheirosLocais() {
  if (!fs.existsSync(UPLOAD_DIR)) return 0;
  const pendentes = await all(
    'SELECT e.id, e.ficheiro FROM envios e LEFT JOIN envio_ficheiros f ON f.envio_id = e.id WHERE f.envio_id IS NULL',
  );
  let copiados = 0;
  for (const e of pendentes) {
    const origem = path.join(UPLOAD_DIR, path.basename(e.ficheiro));
    if (!fs.existsSync(origem)) continue;
    await run('INSERT INTO envio_ficheiros (envio_id, conteudo) VALUES (?, ?) ON CONFLICT (envio_id) DO NOTHING', e.id, cifrarBytes(fs.readFileSync(origem)));
    copiados++;
  }
  return copiados;
}
