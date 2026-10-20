// Cruza os ficheiros de exemplo de 10/08/2026 (em test/amostra) e confirma o que se espera encontrar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AMOSTRA = path.join(import.meta.dirname, 'amostra');
const DIA = '2026-08-10';
const nomes = fs.existsSync(AMOSTRA) ? fs.readdirSync(AMOSTRA) : [];
const ficheiros = (filtro = () => true) => nomes.filter(filtro).map((nome) => ({ nome, buffer: fs.readFileSync(path.join(AMOSTRA, nome)) }));

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auditoria-teste-'));
process.env.PGLITE_MEMORIA = '1';
delete process.env.DATABASE_URL;
const db = await import('../src/db.js');
const { identificar, ErroFicheiro } = await import('../src/parsers.js');
const { importar } = await import('../src/fechos.js');
const { reconciliar, resumoReservas } = await import('../src/reconcile.js');

const incs = (tipo) => db.all('SELECT * FROM inconsistencias WHERE data = ? AND tipo = ? AND ativa = 1 ORDER BY chave', DIA, tipo);
const chaves = async (tipo) => (await incs(tipo)).map((i) => i.chave);
const valores = async (tipo) => (await incs(tipo)).map((i) => i.valor).sort((a, b) => a - b);

async function talao(tipo, valor, hora, reservas = '') {
  const envio = await db.inserir(
    `INSERT INTO envios (user_id, ficheiro, mime, criado_em, estado) VALUES (1, 'x.jpg', 'image/jpeg', ?, 'confirmado')`,
    db.agora(),
  );
  return db.inserir(
    `INSERT INTO taloes (envio_id, tipo, tpa, data, hora, valor, reservas) VALUES (?, ?, '01401347', ?, ?, ?, ?)`,
    envio, tipo, DIA, hora, valor, reservas,
  );
}

before(async () => {
  await db.run(`INSERT INTO users (username, nome, pass_hash, role, criado_em) VALUES ('teste', 'Teste', 'x', 'auditor', ?)`, db.agora());
});
after(() => db.fecharBaseDeDados());

test('ficheiros de 10/08/2026', { skip: nomes.length < 6 && 'ficheiros de exemplo não encontrados' }, async (t) => {
  await t.test('cada ficheiro é reconhecido pelo conteúdo', () => {
    const papeis = ficheiros().map((f) => {
      const r = identificar(f.buffer);
      assert.equal(r.data, DIA, f.nome);
      return r.lado ? `${r.tipo}|${r.lado}` : r.tipo;
    });
    assert.deepEqual(papeis.sort(), ['diario', 'faturas', 'faturas_reserva|entrada', 'faturas_reserva|saida', 'lista|entrada', 'lista|saida']);
    assert.throws(() => identificar(Buffer.from('isto não é um ficheiro do PMS')), ErroFicheiro);
  });

  await t.test('só o diário e as faturas do dia', async () => {
    await importar(ficheiros((n) => /^(Diario|invoice)/.test(n)), 1);
    const fecho = await db.get('SELECT * FROM fechos WHERE data = ?', DIA);
    assert.equal(fecho.total_declarado, 80693.82);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM movimentos WHERE data = ?', DIA)).n, 264);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM faturas WHERE data = ?', DIA)).n, 262);
    assert.equal((await incs('DIARIO_TOTAL')).length, 0);
    assert.equal((await incs('DOC_DIVERGENTE')).length, 0);
    assert.equal((await incs('FATURA_SEM_MOV')).length, 0);
    assert.equal((await incs('NOTA_CREDITO')).length, 5);
    // Dois late check-outs recebidos em numerário a 10/08 e só faturados a 15/08 e a 11/09.
    assert.equal((await incs('MOV_SEM_FATURA')).length, 0);
    assert.deepEqual(await chaves('DOC_OUTRA_DATA'), ['FR 1021200/15378|CASH|2000', 'FR 1021200/21972|CASH|2000']);
    // A numeração só olha para os documentos emitidos no dia.
    const seq = await incs('SEQ_DOCS');
    assert.equal(seq.length, 1);
    assert.match(seq[0].titulo, /^Série FR 1021200: 26 número/);
    assert.equal((await incs('CARTAO_SEM_TALAO')).length, 8);
    assert.equal((await incs('RESERVA_SEM_FATURA')).length, 0);
  });

  await t.test('ficheiros de dias diferentes ou repetidos são recusados', async () => {
    const diario = ficheiros((n) => /^Diario/.test(n))[0];
    await assert.rejects(() => importar([diario, { ...diario, nome: 'copia.csv' }], 1), /já foi escolhido outro ficheiro/);
    const outroDia = Buffer.from(diario.buffer.toString('utf8').replaceAll('10-08-2026', '11-08-2026'));
    await assert.rejects(() => importar([{ nome: 'd.csv', buffer: outroDia }, ...ficheiros((n) => /^invoice/.test(n))], 1), /dias diferentes/);
  });

  await t.test('saídas: total da reserva contra o faturado', async () => {
    await importar(ficheiros((n) => /^Checkout/.test(n)), 1);
    const saidas = (await resumoReservas(DIA)).find((r) => r.lado === 'saida');
    assert.equal(saidas.reservas, 220);
    assert.equal(saidas.canceladas, 8);

    const semFatura = (await chaves('RESERVA_SEM_FATURA')).filter((c) => c.startsWith('saida|'));
    assert.deepEqual(semFatura, ['saida|170024', 'saida|174273', 'saida|176091', 'saida|176346', 'saida|176609']);
    assert.equal((await incs('RESERVA_SEM_FATURA')).find((i) => i.chave === 'saida|174273').valor, -1650);

    // As trocas de quarto (">>") não duplicam o total: a 172010 está certa e a 168644 fica 63 € abaixo.
    assert.deepEqual(await chaves('RESERVA_FATURADA_ABAIXO'), ['saida|168644']);
    assert.equal((await incs('RESERVA_FATURADA_ABAIXO'))[0].valor, -63);

    // Booking já passou o prazo e está todo faturado; os operadores vão para uma lista única.
    assert.equal((await incs('RESERVAS_A_AGUARDAR')).length, 0);
    const agencia = await incs('RESERVAS_AGENCIA');
    assert.equal(agencia.length, 1);
    assert.match(agencia[0].titulo, /^Saídas: 25 reserva/);

    // A taxa turística não é assinalada; ficam os casos acima dela.
    const acima = await chaves('RESERVA_FATURADA_ACIMA');
    assert.ok(acima.includes('saida|174157'));
    assert.ok(!acima.includes('saida|172010'));
    assert.deepEqual(await chaves('CANCELADA_COM_FATURA'), ['saida|171063', 'saida|174814', 'saida|176323']);
  });

  await t.test('entradas e detalhe dos movimentos com quarto', async () => {
    await importar(ficheiros((n) => /^Check ?in/i.test(n)), 1);
    const entradas = (await resumoReservas(DIA)).find((r) => r.lado === 'entrada');
    assert.equal(entradas.reservas, 281);
    assert.deepEqual((await chaves('RESERVA_SEM_FATURA')).filter((c) => c.startsWith('entrada|')), ['entrada|176484', 'entrada|176641', 'entrada|176646', 'entrada|176679']);
    assert.ok((await chaves('RESERVA_FATURADA_ACIMA')).includes('entrada|176126'));
    // O late check-out do quarto 420HUMA passa a mostrar a reserva que o ocupava.
    const lco = (await incs('DOC_OUTRA_DATA')).find((i) => i.chave.startsWith('FR 1021200/15378'));
    assert.ok(JSON.parse(lco.detalhe_json).registos.some((r) => r.origem === 'Reserva' && r.Reserva === '176799'));
  });

  await t.test('dentro do prazo, o Booking fica a aguardar em vez de dar erro', async () => {
    // Como se o relatório das saídas tivesse sido exportado dois dias depois da saída.
    await db.run(`UPDATE fechos SET saidas_faturas_em = '2026-08-12T10:00:00.000Z' WHERE data = ?`, DIA);
    await db.run(`DELETE FROM faturas_reserva WHERE data = ? AND lado = 'saida' AND doc_data > '2026-08-12'`, DIA);
    await reconciliar(DIA);
    const aguardar = await incs('RESERVAS_A_AGUARDAR');
    assert.equal(aguardar.length, 1);
    assert.match(aguardar[0].titulo, /^Saídas: \d+ reserva/);
    assert.ok(!(await chaves('RESERVA_SEM_FATURA')).some((c) => c === 'saida|168644'));
  });

  await t.test('talões: ligação pela reserva e fecho do terminal', async () => {
    const fatura = await db.get(`SELECT * FROM faturas WHERE data = ? AND doc = 'FR 1021300/3441'`, DIA);
    assert.equal(fatura.valor, 901);
    const id = await talao('compra', 901, '12:00:00', fatura.reserva);
    await talao('fecho', 901, '23:00:00');
    await reconciliar(DIA);
    assert.equal((await db.get('SELECT doc_associado FROM taloes WHERE id = ?', id)).doc_associado, 'FR 1021300/3441');
    assert.equal((await incs('CARTAO_SEM_TALAO')).length, 7);
    assert.equal((await incs('FECHO_VS_COMPRAS')).length, 0);
    assert.equal((await incs('TPA_SEM_UNIDADE')).length, 1);

    const tpa = await db.inserir(`INSERT INTO tpas (numero) VALUES ('01401347')`);
    await db.run(`INSERT INTO tpa_caixas (tpa_id, caixa) VALUES (?, 'Huma Hotel')`, tpa);
    await reconciliar(DIA);
    // A caixa Huma Hotel tem 1 082,00 € em cartão no diário e o fecho enviado só soma 901,00 €.
    assert.deepEqual(await valores('FECHO_VS_DIARIO'), [-181]);

    await talao('compra', 50, '10:00:00', '999999');
    await reconciliar(DIA);
    assert.equal((await incs('TALAO_SEM_FATURA')).length, 1);
    assert.equal((await incs('FECHO_VS_COMPRAS')).length, 1);
  });

  await t.test('as notas sobrevivem a um novo cruzamento', async () => {
    const inc = (await incs('DOC_OUTRA_DATA'))[0];
    await db.run(`INSERT INTO historico (inconsistencia_id, user_id, quando, kind, texto) VALUES (?, 1, ?, 'nota', 'verificado')`, inc.id, db.agora());
    await db.run(`UPDATE inconsistencias SET estado = 'justificada' WHERE id = ?`, inc.id);
    await reconciliar(DIA);
    const depois = await db.get('SELECT * FROM inconsistencias WHERE id = ?', inc.id);
    assert.equal(depois.estado, 'justificada');
    assert.equal(depois.ativa, 1);
  });
});
