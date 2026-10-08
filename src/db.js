import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
export const UPLOAD_DIR = path.join(DATA_DIR, 'taloes');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'caixas.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nome TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('auditor', 'rececionista')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expira_em TEXT NOT NULL
);

-- Um fecho por dia, com as exportações do PMS.
CREATE TABLE IF NOT EXISTS fechos (
  data TEXT PRIMARY KEY,
  diario_ficheiro TEXT, diario_em TEXT, diario_por INTEGER,
  faturas_ficheiro TEXT, faturas_em TEXT, faturas_por INTEGER,
  total_declarado REAL
);
CREATE TABLE IF NOT EXISTS resumo_diario (
  data TEXT NOT NULL, tipo TEXT NOT NULL, descricao TEXT, valor REAL NOT NULL,
  PRIMARY KEY (data, tipo)
);
CREATE TABLE IF NOT EXISTS movimentos (
  id INTEGER PRIMARY KEY,
  data TEXT NOT NULL, utilizador TEXT, secao TEXT, tipo TEXT, tipo_desc TEXT, hora TEXT,
  doc TEXT, obs TEXT, quarto TEXT, nome TEXT, valor REAL NOT NULL, caixa TEXT, motivo TEXT,
  total_utilizador REAL
);
CREATE INDEX IF NOT EXISTS movimentos_data ON movimentos(data);
CREATE TABLE IF NOT EXISTS faturas (
  id INTEGER PRIMARY KEY,
  data TEXT NOT NULL, hotel TEXT, reserva TEXT, quarto TEXT, hospede TEXT,
  checkin TEXT, checkout TEXT, total_reserva REAL, doc TEXT, valor REAL NOT NULL, tipo TEXT, info TEXT
);
CREATE INDEX IF NOT EXISTS faturas_data ON faturas(data);

-- Extratos bancários e relatórios de pagamentos (Booking.com, Stripe): o comprovativo das transferências.
CREATE TABLE IF NOT EXISTS extratos (
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('banco', 'stripe', 'booking')),
  nome_original TEXT NOT NULL,
  criado_em TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  de TEXT, ate TEXT, colunas TEXT
);
CREATE TABLE IF NOT EXISTS extrato_linhas (
  id INTEGER PRIMARY KEY,
  extrato_id INTEGER NOT NULL REFERENCES extratos(id) ON DELETE CASCADE,
  n INTEGER,
  data TEXT NOT NULL,
  descricao TEXT, valor REAL NOT NULL, saldo REAL,
  categoria TEXT NOT NULL,           -- banco: transferencia | booking | stripe | saida; relatórios: detalhe | payout | outro
  referencia TEXT, hospede TEXT, checkin TEXT, checkout TEXT,
  grupo TEXT, grupo_data TEXT, liquido REAL, taxa REAL, convertido REAL,
  chave TEXT
);
CREATE INDEX IF NOT EXISTS extrato_linhas_cat ON extrato_linhas(categoria, data);
CREATE INDEX IF NOT EXISTS extrato_linhas_ext ON extrato_linhas(extrato_id);
-- Associações feitas à mão pelo auditor entre um movimento do diário e uma linha de extrato.
CREATE TABLE IF NOT EXISTS extrato_associacoes (
  id INTEGER PRIMARY KEY,
  data TEXT NOT NULL, doc TEXT NOT NULL, valor_cent INTEGER NOT NULL,
  linha_id INTEGER NOT NULL REFERENCES extrato_linhas(id) ON DELETE CASCADE,
  criado_em TEXT, user_id INTEGER,
  UNIQUE (data, doc, valor_cent)
);

-- Contagem de notas e moedas feita pelo auditor, por dia (valor da denominação em cêntimos).
CREATE TABLE IF NOT EXISTS contagens_numerario (
  data TEXT NOT NULL, valor INTEGER NOT NULL, quantidade INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (data, valor)
);

-- Configuração.
CREATE TABLE IF NOT EXISTS caixas (codigo TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS meios (codigo TEXT PRIMARY KEY, descricao TEXT, tpa INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tpas (id INTEGER PRIMARY KEY, numero TEXT NOT NULL UNIQUE, nome TEXT);
-- Um TPA pode servir várias unidades (caixas) e uma unidade pode ter vários TPA.
CREATE TABLE IF NOT EXISTS tpa_caixas (
  tpa_id INTEGER NOT NULL REFERENCES tpas(id) ON DELETE CASCADE,
  caixa TEXT NOT NULL,
  PRIMARY KEY (tpa_id, caixa)
);

-- Um envio é uma fotografia (ou PDF); pode conter vários talões.
CREATE TABLE IF NOT EXISTS envios (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  ficheiro TEXT NOT NULL, mime TEXT NOT NULL, nome_original TEXT,
  criado_em TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'rascunho' CHECK (estado IN ('rascunho', 'confirmado')),
  confirmado_em TEXT, confirmado_por INTEGER,
  leitura_json TEXT, leitura_erro TEXT
);
CREATE TABLE IF NOT EXISTS taloes (
  id INTEGER PRIMARY KEY,
  envio_id INTEGER NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('compra', 'fecho')),
  tpa TEXT, data TEXT, hora TEXT, valor REAL, cartao TEXT, ultimos4 TEXT,
  reservas TEXT NOT NULL DEFAULT '',
  reserva_lida TEXT NOT NULL DEFAULT '',
  reserva_origem TEXT NOT NULL DEFAULT '',
  duvidoso INTEGER NOT NULL DEFAULT 0,
  doc_associado TEXT
);
CREATE INDEX IF NOT EXISTS taloes_data ON taloes(data);

CREATE TABLE IF NOT EXISTS inconsistencias (
  id INTEGER PRIMARY KEY,
  data TEXT NOT NULL, tipo TEXT NOT NULL, chave TEXT NOT NULL,
  gravidade TEXT NOT NULL, titulo TEXT NOT NULL, detalhe_json TEXT NOT NULL,
  utilizador TEXT, caixa TEXT, valor REAL,
  estado TEXT NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente', 'justificada', 'resolvida')),
  ativa INTEGER NOT NULL DEFAULT 1,
  criada_em TEXT NOT NULL, atualizada_em TEXT NOT NULL,
  UNIQUE (data, tipo, chave)
);
-- Notas e mudanças de estado: só se acrescenta, nunca se altera nem apaga.
CREATE TABLE IF NOT EXISTS historico (
  id INTEGER PRIMARY KEY,
  inconsistencia_id INTEGER NOT NULL REFERENCES inconsistencias(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  quando TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('nota', 'estado')),
  texto TEXT, estado_de TEXT, estado_para TEXT
);
`);

db.exec(`
-- Listas de saídas e de entradas do dia (uma linha por quarto) e todas as faturas dessas reservas.
CREATE TABLE IF NOT EXISTS reservas (
  id INTEGER PRIMARY KEY,
  data TEXT NOT NULL, lado TEXT NOT NULL CHECK (lado IN ('saida', 'entrada')),
  reserva TEXT NOT NULL, unidade TEXT, hospede TEXT, checkin TEXT, checkout TEXT, status TEXT,
  pax INTEGER, total REAL, agencia TEXT, mercado TEXT, canal TEXT, info TEXT, criada_por TEXT
);
CREATE INDEX IF NOT EXISTS reservas_data ON reservas(data, lado);
CREATE TABLE IF NOT EXISTS faturas_reserva (
  id INTEGER PRIMARY KEY,
  data TEXT NOT NULL, lado TEXT NOT NULL,
  reserva TEXT NOT NULL, quarto TEXT, doc TEXT, doc_data TEXT, valor REAL NOT NULL, tipo TEXT
);
CREATE INDEX IF NOT EXISTS faturas_reserva_data ON faturas_reserva(data, lado);
-- Como se espera que cada agência seja faturada: 'imediata' (até à estadia), 'prazo' (dias depois da saída)
-- ou 'agencia' (faturada à parte, fora deste relatório).
CREATE TABLE IF NOT EXISTS agencias (nome TEXT PRIMARY KEY, regra TEXT NOT NULL CHECK (regra IN ('imediata', 'prazo', 'agencia')));
CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
`);

// Colunas acrescentadas depois da primeira versão.
function coluna(tabela, nome, tipo) {
  if (!db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === nome)) {
    db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${nome} ${tipo}`);
  }
}
coluna('movimentos', 'doc_data', 'TEXT');
for (const f of ['saidas_lista', 'saidas_faturas', 'entradas_lista', 'entradas_faturas']) {
  coluna('fechos', f, 'TEXT');
  coluna('fechos', `${f}_em`, 'TEXT');
}

coluna('extrato_linhas', 'convertido', 'REAL');
coluna('fechos', 'contagem_por', 'INTEGER');
coluna('fechos', 'contagem_em', 'TEXT');

const stmts = new Map();
function st(sql) {
  let s = stmts.get(sql);
  if (!s) stmts.set(sql, (s = db.prepare(sql)));
  return s;
}
const limpar = (ps) => ps.map((p) => (p === undefined ? null : p));

export const all = (sql, ...ps) => st(sql).all(...limpar(ps));
export const get = (sql, ...ps) => st(sql).get(...limpar(ps));
export const run = (sql, ...ps) => st(sql).run(...limpar(ps));

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const agora = () => new Date().toISOString();

export function config(chave, omissao) {
  return get('SELECT valor FROM config WHERE chave = ?', chave)?.valor ?? omissao;
}
export function guardarConfig(chave, valor) {
  run('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor', chave, String(valor));
}
