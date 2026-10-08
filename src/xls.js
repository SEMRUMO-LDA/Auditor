// Leitor mínimo de ficheiros Excel antigos (.xls binário, formato BIFF8 dentro de um contentor OLE2).
// Lê só a primeira folha e devolve uma tabela de texto (números e datas em série ficam como texto numérico).
export class ErroXLS extends Error {}

const FIM = 0xfffffffa;

// ---------- Contentor OLE2: devolve o fluxo "Workbook" ----------
function lerFluxoOLE(buf) {
  if (buf.length < 512 || buf.readUInt32BE(0) !== 0xd0cf11e0) throw new ErroXLS('Não é um ficheiro Excel válido.');
  const tam = 1 << buf.readUInt16LE(30);
  const miniTam = 1 << buf.readUInt16LE(32);
  const inicioDir = buf.readUInt32LE(48);
  const corte = buf.readUInt32LE(56);
  const inicioMiniFat = buf.readUInt32LE(60);
  let difat = buf.readUInt32LE(68);
  const nDifat = buf.readUInt32LE(72);
  const setor = (n) => {
    const ini = (n + 1) * tam;
    if (ini + tam > buf.length) throw new ErroXLS('O ficheiro Excel está incompleto ou corrompido.');
    return buf.subarray(ini, ini + tam);
  };
  const setoresFat = [];
  for (let i = 0; i < 109; i++) {
    const v = buf.readUInt32LE(76 + 4 * i);
    if (v < FIM) setoresFat.push(v);
  }
  for (let k = 0; k < nDifat && difat < FIM; k++) {
    const s = setor(difat);
    for (let j = 0; j < tam / 4 - 1; j++) {
      const v = s.readUInt32LE(4 * j);
      if (v < FIM) setoresFat.push(v);
    }
    difat = s.readUInt32LE(tam - 4);
  }
  const fat = [];
  for (const f of setoresFat) {
    const s = setor(f);
    for (let j = 0; j < tam / 4; j++) fat.push(s.readUInt32LE(4 * j));
  }
  const cadeia = (inicio) => {
    const partes = [];
    const vistos = new Set();
    for (let n = inicio; n < FIM && !vistos.has(n); n = fat[n]) {
      vistos.add(n);
      partes.push(setor(n));
    }
    return Buffer.concat(partes);
  };
  const dir = cadeia(inicioDir);
  let raiz = null;
  let fluxo = null;
  for (let i = 0; i + 128 <= dir.length; i += 128) {
    const tamNome = dir.readUInt16LE(i + 64);
    const nome = dir.toString('utf16le', i, i + Math.max(0, tamNome - 2));
    const tipo = dir[i + 66];
    const entrada = { inicio: dir.readUInt32LE(i + 116), tamanho: dir.readUInt32LE(i + 120) };
    if (tipo === 5) raiz = entrada;
    if (tipo === 2 && (nome === 'Workbook' || nome === 'Book')) fluxo = entrada;
  }
  if (!fluxo) throw new ErroXLS('Não encontrei a folha de cálculo dentro do ficheiro Excel.');
  if (fluxo.tamanho >= corte) return cadeia(fluxo.inicio).subarray(0, fluxo.tamanho);
  // Fluxos pequenos vivem no "mini fluxo" da raiz.
  const miniFatBuf = cadeia(inicioMiniFat);
  const miniFat = [];
  for (let j = 0; j + 4 <= miniFatBuf.length; j += 4) miniFat.push(miniFatBuf.readUInt32LE(j));
  const contentor = cadeia(raiz.inicio);
  const partes = [];
  const vistos = new Set();
  for (let n = fluxo.inicio; n < FIM && !vistos.has(n); n = miniFat[n]) {
    vistos.add(n);
    partes.push(contentor.subarray(n * miniTam, (n + 1) * miniTam));
  }
  return Buffer.concat(partes).subarray(0, fluxo.tamanho);
}

// ---------- Registos BIFF ----------
function registos(wb, desde = 0) {
  const lista = [];
  for (let pos = desde; pos + 4 <= wb.length; ) {
    const id = wb.readUInt16LE(pos);
    const len = wb.readUInt16LE(pos + 2);
    lista.push({ id, dados: wb.subarray(pos + 4, pos + 4 + len), pos });
    pos += 4 + len;
  }
  return lista;
}

// Leitor da tabela de textos partilhados (SST), que pode estar dividida em vários registos CONTINUE.
class LeitorSST {
  constructor(pedacos) {
    this.pedacos = pedacos;
    this.c = 0;
    this.p = 0;
  }
  avancarSePreciso() {
    while (this.c < this.pedacos.length - 1 && this.p >= this.pedacos[this.c].length) {
      this.c++;
      this.p = 0;
    }
  }
  byte() {
    this.avancarSePreciso();
    return this.pedacos[this.c][this.p++];
  }
  u16() {
    return this.byte() | (this.byte() << 8);
  }
  u32() {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  saltar(n) {
    while (n > 0 && this.c < this.pedacos.length) {
      const resto = this.pedacos[this.c].length - this.p;
      const k = Math.min(n, resto);
      this.p += k;
      n -= k;
      if (n > 0) {
        this.c++;
        this.p = 0;
      }
    }
  }
  // Ao passar para um novo registo a meio de um texto, o primeiro byte repete o indicador de 8/16 bits.
  caracteres(n, largo) {
    let texto = '';
    while (n > 0) {
      if (this.p >= this.pedacos[this.c].length) {
        if (this.c >= this.pedacos.length - 1) break;
        this.c++;
        largo = (this.pedacos[this.c][0] & 1) === 1;
        this.p = 1;
      }
      const largura = largo ? 2 : 1;
      const k = Math.min(n, Math.floor((this.pedacos[this.c].length - this.p) / largura));
      if (k <= 0) {
        this.p = this.pedacos[this.c].length;
        continue;
      }
      texto += this.pedacos[this.c].toString(largo ? 'utf16le' : 'latin1', this.p, this.p + k * largura);
      this.p += k * largura;
      n -= k;
    }
    return texto;
  }
}

function lerSST(pedacos) {
  const l = new LeitorSST(pedacos);
  l.u32();
  const unicos = l.u32();
  const textos = [];
  for (let i = 0; i < unicos; i++) {
    if (l.c >= pedacos.length - 1 && l.p >= pedacos[l.c].length) break;
    const cch = l.u16();
    const opcoes = l.byte();
    const largo = (opcoes & 1) === 1;
    const rico = (opcoes & 8) !== 0;
    const ext = (opcoes & 4) !== 0;
    const runs = rico ? l.u16() : 0;
    const extLen = ext ? l.u32() : 0;
    textos.push(l.caracteres(cch, largo));
    l.saltar(runs * 4 + extLen);
  }
  return textos;
}

function textoUnicode(dados, desde) {
  const cch = dados.readUInt16LE(desde);
  const opcoes = dados[desde + 2];
  const largo = (opcoes & 1) === 1;
  let pos = desde + 3;
  if (opcoes & 8) pos += 2;
  if (opcoes & 4) pos += 4;
  return dados.toString(largo ? 'utf16le' : 'latin1', pos, pos + cch * (largo ? 2 : 1));
}

function valorRK(rk) {
  let v;
  if (rk & 2) v = (rk | 0) >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = b.readDoubleLE(0);
  }
  return rk & 1 ? v / 100 : v;
}

// Números sem ruído de vírgula flutuante: 150.5 em vez de 150.50000000000003.
const comoTexto = (n) => String(Number.isInteger(n) ? n : Number(n.toPrecision(12)));

export function tabelaXLS(buffer) {
  const wb = lerFluxoOLE(buffer);
  const todos = registos(wb);
  // Folhas e tabela de textos
  const folhas = [];
  let pedacosSST = null;
  let dentroSST = false;
  let nivel = 0;
  for (const r of todos) {
    if (r.id === 0x0809) {
      nivel++;
      if (nivel > 1) break;
    } else if (r.id === 0x000a) break;
    else if (r.id === 0x00fc) {
      pedacosSST = [r.dados];
      dentroSST = true;
    } else if (r.id === 0x003c && dentroSST) pedacosSST.push(r.dados);
    else {
      dentroSST = false;
      if (r.id === 0x0085) {
        const tipo = r.dados[5];
        const visivel = r.dados[4];
        if (tipo === 0 && visivel === 0) folhas.push(r.dados.readUInt32LE(0));
      }
    }
  }
  if (!folhas.length) throw new ErroXLS('O ficheiro Excel não tem nenhuma folha visível.');
  const sst = pedacosSST ? lerSST(pedacosSST) : [];

  const celulas = new Map();
  const por = (linha, coluna, valor) => {
    if (valor === null || valor === undefined || valor === '') return;
    if (!celulas.has(linha)) celulas.set(linha, []);
    celulas.get(linha)[coluna] = typeof valor === 'number' ? comoTexto(valor) : String(valor);
  };
  const registosFolha = registos(wb, folhas[0]);
  let profundidade = 0;
  let aEsperarTexto = null;
  for (const r of registosFolha) {
    if (r.id === 0x0809) {
      profundidade++;
      continue;
    }
    if (r.id === 0x000a) {
      profundidade--;
      if (profundidade <= 0) break;
      continue;
    }
    if (profundidade !== 1) continue;
    const d = r.dados;
    if (r.id === 0x00fd) por(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)]);
    else if (r.id === 0x0204 || r.id === 0x00d6) por(d.readUInt16LE(0), d.readUInt16LE(2), textoUnicode(d, 6));
    else if (r.id === 0x0203) por(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
    else if (r.id === 0x027e) por(d.readUInt16LE(0), d.readUInt16LE(2), valorRK(d.readUInt32LE(6)));
    else if (r.id === 0x00bd) {
      const linha = d.readUInt16LE(0);
      const primeira = d.readUInt16LE(2);
      const n = (d.length - 6) / 6;
      for (let k = 0; k < n; k++) por(linha, primeira + k, valorRK(d.readUInt32LE(4 + 6 * k + 2)));
    } else if (r.id === 0x0006) {
      const linha = d.readUInt16LE(0);
      const coluna = d.readUInt16LE(2);
      if (d.readUInt16LE(12) === 0xffff) {
        if (d[6] === 0) aEsperarTexto = { linha, coluna }; // o texto vem no registo STRING seguinte
      } else por(linha, coluna, d.readDoubleLE(6));
    } else if (r.id === 0x0207 && aEsperarTexto) {
      por(aEsperarTexto.linha, aEsperarTexto.coluna, textoUnicode(d, 0));
      aEsperarTexto = null;
    }
  }
  const linhas = [...celulas.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => Array.from(l, (x) => x ?? ''));
  if (!linhas.length) throw new ErroXLS('A folha do ficheiro Excel está vazia.');
  return linhas;
}
