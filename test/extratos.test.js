// Leitura dos extratos e relatórios de pagamentos (não precisa dos ficheiros reais do PMS).
import test from 'node:test';
import assert from 'node:assert/strict';
import { numeroFlex, dataFlex, categoriaBanco, lerExtrato, ErroExtrato } from '../src/extratos.js';

test('números em formato português e inglês', () => {
  assert.equal(numeroFlex('1.234,56'), 1234.56);
  assert.equal(numeroFlex('1,234.56'), 1234.56);
  assert.equal(numeroFlex('200,00'), 200);
  assert.equal(numeroFlex('(12,50)'), -12.5);
  assert.equal(numeroFlex('59.00'), 59);
  assert.equal(numeroFlex('1.234'), 1234);
  assert.equal(numeroFlex('abc'), null);
});

test('datas em vários formatos', () => {
  assert.equal(dataFlex('07/10/2026'), '2026-10-07');
  assert.equal(dataFlex('2026-10-02 11:39'), '2026-10-02');
  assert.equal(dataFlex('7.10.26'), '2026-10-07');
  assert.equal(dataFlex('46302'), '2026-10-07'); // número de série do Excel
  assert.equal(dataFlex('32/13/2026'), null);
});

test('o que entra no banco é classificado', () => {
  assert.equal(categoriaBanco('TRF SEPA+ BOOKING.COM B.V.'), 'booking');
  assert.equal(categoriaBanco('STRIPE PAYMENTS EUROPE'), 'stripe');
  assert.equal(categoriaBanco('CREDITO COMERCIANTE 0001234567 HOTEL TESTE'), 'comerciante');
  assert.equal(categoriaBanco('TRF SEPA+ ANA SILVA'), 'transferencia');
});

test('extrato bancário com preâmbulo, débito e crédito separados', () => {
  const csv = 'Conta: 123;;;;\n\nData mov.;Data valor;Descrição;Débito;Crédito;Saldo\n05/10/2026;05/10/2026;TRF ANA;;150,00;1.150,00\n06/10/2026;06/10/2026;COMISSAO;12,50;;1.137,50\nTotal;;;;;\n';
  const r = lerExtrato(Buffer.from(csv));
  assert.equal(r.tipo, 'banco');
  // Os débitos (a comissão) não são guardados.
  assert.deepEqual(r.linhas.map((l) => [l.data, l.valor, l.categoria]), [['2026-10-05', 150, 'transferencia']]);
  assert.equal(r.debitos, 1);
});

test('um extrato só com débitos é recusado', () => {
  const csv = 'Data;Descrição;Montante\n05/10/2026;COMPRA LOJA;-12,50\n';
  assert.throws(() => lerExtrato(Buffer.from(csv)), /nenhum crédito/);
});

test('relatório "Transfers" do Stripe (formato real, com vírgula decimal)', () => {
  const csv = 'Type,ID,Created,Description,Amount,Currency,Converted Amount,Fees,Net,Converted Currency,Details,Customer ID,Customer Email,Customer Name\n'
    + 'Charge,ch_1,2026-09-30 16:24,Caução,"200,00",eur,"60,00","2,20","57,80",eur,a@b.com,cus_1,a@b.com,Ana Silva\n'
    + 'Charge,py_2,2026-10-02 10:42,,"130,00",eur,"130,00","2,20","127,80",eur,c@d.com,cus_2,c@d.com,\n';
  const r = lerExtrato(Buffer.from(csv));
  assert.equal(r.tipo, 'stripe');
  assert.deepEqual(r.linhas.map((l) => [l.valor, l.convertido, l.taxa, l.liquido, l.categoria]), [[200, 60, 2.2, 57.8, 'detalhe'], [130, null, 2.2, 127.8, 'detalhe']]);
  assert.equal(Math.round(r.linhas.reduce((s, l) => s + l.liquido, 0) * 100), 18560);
});

test('relatório de pagamentos da Booking.com', () => {
  const csv = 'Número da reserva;Nome do hóspede;Check-in;Check-out;Valor do pagamento;Data do pagamento;Identificador do pagamento\n5123456789;Maria Exemplo;29/09/2026;07/10/2026;377,88;12/10/2026;PAY1\n';
  const r = lerExtrato(Buffer.from(csv));
  assert.equal(r.tipo, 'booking');
  assert.deepEqual([r.linhas[0].referencia, r.linhas[0].valor, r.linhas[0].checkin, r.linhas[0].grupo, r.linhas[0].grupoData], ['5123456789', 377.88, '2026-09-29', 'PAY1', '2026-10-12']);
});

test('ficheiros que não dá para ler dão um erro claro', () => {
  assert.throws(() => lerExtrato(Buffer.from('%PDF-1.4 ...')), ErroExtrato);
  assert.throws(() => lerExtrato(Buffer.from('a;b\n1;2\n')), /colunas do extrato/);
  assert.throws(() => lerExtrato(Buffer.alloc(0)), ErroExtrato);
});

// O leitor do Excel antigo (.xls) é testado com o extrato real, quando ele existe nesta pasta.
import fs from 'node:fs';
const EXTRATO_REAL = new URL('../Caixa/07-10-2026/Extrato bancário 07-10-2026.xls', import.meta.url);
test('extrato real em Excel antigo (.xls)', { skip: !fs.existsSync(EXTRATO_REAL) && 'sem o extrato real nesta pasta' }, () => {
  const r = lerExtrato(fs.readFileSync(EXTRATO_REAL));
  assert.equal(r.tipo, 'banco');
  assert.equal(r.linhas.length, 95); // 292 movimentos menos 197 débitos
  assert.equal(r.debitos, 197);
  const por = (c) => r.linhas.filter((l) => l.categoria === c);
  assert.equal(por('comerciante').length, 19);
  assert.equal(Math.round(por('comerciante').reduce((s, l) => s + l.valor, 0) * 100), 1163031);
  assert.equal(por('booking').length, 60);
  assert.equal(por('stripe').length, 2);
});
