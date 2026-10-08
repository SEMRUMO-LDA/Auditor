// Contagem de numerário: notas e moedas que o auditor conta no fim do dia, comparadas com o CASH do diário.
// Os valores são sempre em cêntimos, para a soma ser exata.
export const MEIO_NUMERARIO = 'CASH';
export const NOTAS = [50000, 20000, 10000, 5000, 2000, 1000, 500];
export const MOEDAS = [200, 100, 50, 20, 10, 5, 2, 1];
export const DENOMINACOES = [...NOTAS, ...MOEDAS];
export const MAX_QUANTIDADE = 99999;

export const rotuloDenominacao = (c) => (c >= 100 ? `${c / 100} €` : `${(c / 100).toFixed(2).replace('.', ',')} €`);
export const totalContado = (quantidades) => DENOMINACOES.reduce((s, c) => s + c * (quantidades[c] || 0), 0);
