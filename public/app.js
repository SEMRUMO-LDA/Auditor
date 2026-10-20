// Comportamento no browser: envio de fotografias e formulário de confirmação dos talões.

// ----- Envio da fotografia -----
const ficheiro = document.getElementById('ficheiro');
if (ficheiro) {
  const form = document.getElementById('form-envio');
  const previa = document.getElementById('previa');
  const enviar = document.getElementById('enviar');
  const LADO_MAX = 2200;

  document.querySelector('[data-capturar]').addEventListener('click', () => {
    ficheiro.setAttribute('capture', 'environment');
    ficheiro.click();
  });
  document.querySelector('[data-escolher]').addEventListener('click', () => {
    ficheiro.removeAttribute('capture');
    ficheiro.click();
  });

  // As fotografias de telemóvel são grandes; reduzem-se antes do envio para poupar dados e caber na leitura automática.
  async function reduzir(original) {
    if (!original.type.startsWith('image/')) return original;
    try {
      const imagem = await createImageBitmap(original, { imageOrientation: 'from-image' });
      const escala = Math.min(1, LADO_MAX / Math.max(imagem.width, imagem.height));
      const tela = document.createElement('canvas');
      tela.width = Math.round(imagem.width * escala);
      tela.height = Math.round(imagem.height * escala);
      tela.getContext('2d').drawImage(imagem, 0, 0, tela.width, tela.height);
      const blob = await new Promise((ok) => tela.toBlob(ok, 'image/jpeg', 0.88));
      return blob ? new File([blob], 'talao.jpg', { type: 'image/jpeg' }) : original;
    } catch {
      return original;
    }
  }

  ficheiro.addEventListener('change', async () => {
    const original = ficheiro.files[0];
    if (!original) return;
    const pronto = await reduzir(original);
    if (pronto !== original) {
      try {
        const dt = new DataTransfer();
        dt.items.add(pronto);
        ficheiro.files = dt.files;
      } catch {
        // Browser sem DataTransfer: segue a fotografia original.
      }
    }
    const img = previa.querySelector('img');
    img.hidden = !pronto.type.startsWith('image/');
    if (!img.hidden) img.src = URL.createObjectURL(pronto);
    document.getElementById('previa-nome').textContent = img.hidden ? original.name : '';
    previa.hidden = false;
    enviar.hidden = false;
  });

  form.addEventListener('submit', () => {
    enviar.disabled = true;
    document.getElementById('a-ler').hidden = false;
  });
}

// ----- Confirmação dos talões -----
function ligarTalao(bloco) {
  const tipo = bloco.querySelector('[data-tipo]');
  const atualizar = () => {
    for (const el of bloco.querySelectorAll('[data-so-compra]')) el.hidden = tipo.value === 'fecho';
  };
  tipo.addEventListener('change', atualizar);
  atualizar();
}
document.querySelectorAll('[data-talao]').forEach(ligarTalao);

const adicionar = document.querySelector('[data-adicionar-talao]');
if (adicionar) {
  const lista = document.getElementById('taloes');
  const modelo = document.getElementById('modelo-talao');
  let proximo = lista.querySelectorAll('[data-talao]').length;
  adicionar.addEventListener('click', () => {
    const div = document.createElement('div');
    div.innerHTML = modelo.innerHTML.replaceAll('__i__', String(proximo++));
    const bloco = div.firstElementChild;
    lista.appendChild(bloco);
    ligarTalao(bloco);
  });
}

document.querySelectorAll('form[data-confirmar]').forEach((f) => {
  f.addEventListener('submit', (e) => {
    if (!confirm(f.dataset.confirmar)) e.preventDefault();
  });
});

// ----- Contagem de numerário -----
// A etiqueta da linha CASH abre a janela modal; sem JavaScript, é uma ligação que abre a página já com a janela aberta.
const modalContagem = document.getElementById('numerario');
if (modalContagem && typeof modalContagem.showModal === 'function') {
  const abrir = () => {
    if (modalContagem.open) modalContagem.close();
    modalContagem.showModal();
  };
  document.querySelectorAll('[data-abrir-contagem]').forEach((ligacao) => {
    ligacao.addEventListener('click', (e) => {
      e.preventDefault();
      abrir();
    });
  });
  modalContagem.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', () => modalContagem.close()));
  // Clicar fora da janela (no fundo escurecido) também fecha.
  modalContagem.addEventListener('click', (e) => {
    if (e.target === modalContagem) modalContagem.close();
  });
  if (modalContagem.dataset.abrir === '1') abrir();
}

// Totais e diferença enquanto se escreve; o resultado (bate certo ou não) só aparece ao guardar.
document.querySelectorAll('form[data-contagem]').forEach((form) => {
  const euros = (cent) => (cent / 100).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const esperado = Number(form.dataset.esperado);
  const estado = form.querySelector('[data-estado]');
  form.addEventListener('input', () => {
    let total = 0;
    for (const campo of form.querySelectorAll('input[data-valor]')) {
      const quantidade = Math.max(0, Math.floor(Number(campo.value) || 0));
      const subtotal = quantidade * Number(campo.dataset.valor);
      total += subtotal;
      campo.closest('label').querySelector('[data-sub]').textContent = euros(subtotal);
    }
    form.querySelector('[data-contado]').textContent = euros(total);
    const celula = form.querySelector('[data-diferenca]');
    celula.textContent = euros(total - esperado);
    celula.classList.toggle('erro', total !== esperado);
    const aviso = document.createElement('p');
    aviso.className = 'aviso info';
    aviso.textContent = 'Alterações por guardar. Guarde para validar a contagem com o diário.';
    estado.replaceChildren(aviso);
  });
});

// ----- Tabelas compridas: depois de 12 linhas passa a haver scroll vertical -----
const LINHAS_VISIVEIS = 12;
function limitarPorLinhas(caixa) {
  const linhas = caixa.querySelectorAll('tbody tr');
  caixa.classList.toggle('rolavel', linhas.length > LINHAS_VISIVEIS);
  caixa.style.maxHeight = '';
  if (linhas.length <= LINHAS_VISIVEIS || !caixa.offsetParent) return; // tabela escondida: mede-se quando o separador abrir
  const cabecalho = caixa.querySelector('thead')?.offsetHeight || 0;
  const rodape = caixa.querySelector('tfoot')?.offsetHeight || 0;
  let altura = cabecalho + rodape;
  for (let i = 0; i < LINHAS_VISIVEIS; i++) altura += linhas[i].offsetHeight;
  caixa.style.maxHeight = `${altura + 2}px`;
}
function limitarTabelas() {
  document.querySelectorAll('.tabela-wrap').forEach(limitarPorLinhas);
}
limitarTabelas();
document.fonts?.ready.then(limitarTabelas);
window.addEventListener('resize', limitarTabelas);

// ----- Separadores (abas): mostram um painel de cada vez -----
document.querySelectorAll('[data-abas]').forEach((barra) => {
  const abas = [...barra.querySelectorAll('[data-aba]')];
  const paineis = new Map([...document.querySelectorAll('[data-painel]')].map((p) => [p.dataset.painel, p]));
  const nomes = abas.map((a) => a.dataset.aba);
  function ativar(nome, guardar = true) {
    if (!paineis.has(nome)) nome = nomes[0];
    for (const a of abas) {
      const ativa = a.dataset.aba === nome;
      a.setAttribute('aria-selected', String(ativa));
      a.tabIndex = ativa ? 0 : -1;
    }
    for (const [chave, painel] of paineis) painel.hidden = chave !== nome;
    if (guardar) history.replaceState(null, '', `${location.pathname}${location.search}#${nome}`);
    limitarTabelas();
  }
  abas.forEach((a, i) => {
    a.addEventListener('click', () => ativar(a.dataset.aba));
    a.addEventListener('keydown', (e) => {
      const passo = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!passo) return;
      const seguinte = abas[(i + passo + abas.length) % abas.length];
      seguinte.focus();
      ativar(seguinte.dataset.aba);
    });
  });
  // Ligações como "#incs" ou "#numerario" abrem o separador certo; os filtros das inconsistências também.
  const hash = location.hash.slice(1).split(':')[0];
  const filtrosIncs = ['estado', 'gravidade', 'tipo', 'utilizador', 'caixa'].some((k) => new URLSearchParams(location.search).has(k));
  const inicial = nomes.includes(hash) ? hash : hash === 'numerario' ? 'meios' : filtrosIncs ? 'incs' : nomes[0];
  ativar(inicial, false);
});

// ----- Sub-separadores (um por meio de pagamento) dentro do separador "Por meio de pagamento" -----
document.querySelectorAll('[data-subabas]').forEach((barra) => {
  const raiz = barra.closest('.painel-aba') || document;
  const abas = [...barra.querySelectorAll('[data-subaba]')];
  const paineis = new Map([...raiz.querySelectorAll('[data-subpainel]')].map((p) => [p.dataset.subpainel, p]));
  const nomes = abas.map((a) => a.dataset.subaba);
  const pai = raiz.dataset?.painel;
  function ativar(nome, guardar = true) {
    if (!paineis.has(nome)) nome = nomes[0];
    for (const a of abas) {
      const ativa = a.dataset.subaba === nome;
      a.setAttribute('aria-selected', String(ativa));
      a.tabIndex = ativa ? 0 : -1;
    }
    for (const [chave, painel] of paineis) painel.hidden = chave !== nome;
    if (guardar && pai) history.replaceState(null, '', `${location.pathname}${location.search}#${pai}${nome === nomes[0] ? '' : ':' + nome}`);
    limitarTabelas();
  }
  abas.forEach((a, i) => {
    a.addEventListener('click', () => ativar(a.dataset.subaba));
    a.addEventListener('keydown', (e) => {
      const passo = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!passo) return;
      const seguinte = abas[(i + passo + abas.length) % abas.length];
      seguinte.focus();
      ativar(seguinte.dataset.subaba);
    });
  });
  const [base, sub] = location.hash.slice(1).split(':');
  ativar(base === pai && nomes.includes(sub) ? sub : nomes[0], false);
});

// ----- Seletor de período: um dia, uma semana, um mês, um ano ou um intervalo livre -----
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DIAS_SEMANA = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const MODOS = [['dia', 'Dia'], ['semana', 'Semana'], ['mes', 'Mês'], ['ano', 'Ano'], ['intervalo', 'Intervalo']];
const dois = (n) => String(n).padStart(2, '0');
const paraIso = (d) => `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
const deIso = (s) => {
  const [a, m, d] = s.split('-').map(Number);
  return new Date(a, m - 1, d);
};
const paraPT = (s) => s.split('-').reverse().join('/');
const elemento = (tag, classe, texto) => {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined) e.textContent = texto;
  return e;
};
const botao = (texto, aoClicar, classe = '') => {
  const b = elemento('button', classe, texto);
  b.type = 'button';
  b.addEventListener('click', aoClicar);
  return b;
};

function iniciarPeriodo(raiz) {
  const campoDe = raiz.querySelector('input[name="de"]');
  const campoAte = raiz.querySelector('input[name="ate"]');
  const gatilho = raiz.querySelector('.periodo-botao');
  const texto = raiz.querySelector('[data-texto]');
  const painel = raiz.querySelector('.periodo-painel');
  const diasComDados = new Set((raiz.dataset.dias || '').split(',').filter(Boolean));

  let de = campoDe.value;
  let ate = campoAte.value || de;
  let aEspera = false; // no modo "intervalo", depois do primeiro clique
  const ultimoDia = [...diasComDados].sort().pop();
  const referencia = de ? deIso(de) : ultimoDia ? deIso(ultimoDia) : new Date();
  let vista = new Date(referencia.getFullYear(), referencia.getMonth(), 1); // mês mostrado no calendário
  let anoVista = referencia.getFullYear(); // ano mostrado na grelha dos meses
  let blocoAnos = Math.floor(referencia.getFullYear() / 12) * 12; // primeiro ano da grelha dos anos

  const segunda = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  function detetarModo() {
    if (!de) return 'dia';
    if (de === ate) return 'dia';
    const a = deIso(de);
    const b = deIso(ate);
    if (paraIso(segunda(a)) === de && paraIso(new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6)) === ate) return 'semana';
    if (a.getDate() === 1 && paraIso(new Date(a.getFullYear(), a.getMonth() + 1, 0)) === ate) return 'mes';
    if (a.getMonth() === 0 && a.getDate() === 1 && b.getMonth() === 11 && b.getDate() === 31 && a.getFullYear() === b.getFullYear()) return 'ano';
    return 'intervalo';
  }
  let modo = detetarModo();

  function rotulo() {
    if (!de) return 'Todos os dias';
    if (de === ate) return paraPT(de);
    return `${paraPT(de)} – ${paraPT(ate)}`;
  }
  function descricao() {
    if (!de) return 'Sem período: todos os dias';
    const a = deIso(de);
    if (modo === 'mes') return `${MESES[a.getMonth()]} de ${a.getFullYear()}`;
    if (modo === 'ano') return `Ano ${a.getFullYear()}`;
    if (modo === 'semana') return `Semana de ${paraPT(de)}`;
    return rotulo();
  }
  function definir(novoDe, novoAte) {
    de = novoDe;
    ate = novoAte;
    campoDe.value = de;
    campoAte.value = ate;
    texto.textContent = rotulo();
    desenhar();
  }

  function escolherDia(d) {
    const dia = paraIso(d);
    if (modo === 'dia') return definir(dia, dia);
    if (modo === 'semana') {
      const inicio = segunda(d);
      return definir(paraIso(inicio), paraIso(new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + 6)));
    }
    // intervalo: primeiro clique abre, segundo fecha
    if (!aEspera) {
      aEspera = true;
      return definir(dia, dia);
    }
    aEspera = false;
    return dia < de ? definir(dia, de) : definir(de, dia);
  }

  function desenharModos() {
    const barra = elemento('div', 'periodo-modos');
    for (const [chave, nome] of MODOS) {
      const b = botao(nome, () => {
        modo = chave;
        aEspera = false;
        desenhar();
      });
      b.setAttribute('aria-pressed', String(modo === chave));
      barra.append(b);
    }
    return barra;
  }

  function desenharCalendario() {
    const caixa = elemento('div');
    const nav = elemento('div', 'periodo-nav');
    nav.append(
      botao('‹', () => {
        vista = new Date(vista.getFullYear(), vista.getMonth() - 1, 1);
        desenhar();
      }),
      elemento('strong', '', `${MESES[vista.getMonth()]} ${vista.getFullYear()}`),
      botao('›', () => {
        vista = new Date(vista.getFullYear(), vista.getMonth() + 1, 1);
        desenhar();
      }),
    );
    nav.firstChild.setAttribute('aria-label', 'Mês anterior');
    nav.lastChild.setAttribute('aria-label', 'Mês seguinte');
    const semana = elemento('div', 'periodo-semana');
    for (const nome of DIAS_SEMANA) semana.append(elemento('span', '', nome));
    const grelha = elemento('div', 'periodo-dias');
    const primeiro = segunda(vista);
    for (let i = 0; i < 42; i++) {
      const d = new Date(primeiro.getFullYear(), primeiro.getMonth(), primeiro.getDate() + i);
      const dia = paraIso(d);
      const b = botao(String(d.getDate()), () => escolherDia(d));
      b.setAttribute('aria-label', paraPT(dia));
      if (d.getMonth() !== vista.getMonth()) b.classList.add('fora');
      if (diasComDados.has(dia)) b.classList.add('tem-dados');
      if (de && dia >= de && dia <= ate) b.classList.add('no-periodo');
      if (de && dia === de) b.classList.add('inicio');
      if (de && dia === ate) b.classList.add('fim');
      grelha.append(b);
    }
    caixa.append(nav, semana, grelha);
    return caixa;
  }

  function desenharMeses() {
    const caixa = elemento('div');
    const nav = elemento('div', 'periodo-nav');
    nav.append(
      botao('‹', () => {
        anoVista--;
        desenhar();
      }),
      elemento('strong', '', String(anoVista)),
      botao('›', () => {
        anoVista++;
        desenhar();
      }),
    );
    const grelha = elemento('div', 'periodo-grelha');
    MESES.forEach((nome, i) => {
      const inicio = paraIso(new Date(anoVista, i, 1));
      const fim = paraIso(new Date(anoVista, i + 1, 0));
      const b = botao(nome.slice(0, 3), () => definir(inicio, fim));
      b.setAttribute('aria-label', `${nome} de ${anoVista}`);
      b.setAttribute('aria-pressed', String(de === inicio && ate === fim));
      if ([...diasComDados].some((x) => x >= inicio && x <= fim)) b.classList.add('tem-dados');
      grelha.append(b);
    });
    caixa.append(nav, grelha);
    return caixa;
  }

  function desenharAnos() {
    const caixa = elemento('div');
    const nav = elemento('div', 'periodo-nav');
    nav.append(
      botao('‹', () => {
        blocoAnos -= 12;
        desenhar();
      }),
      elemento('strong', '', `${blocoAnos} – ${blocoAnos + 11}`),
      botao('›', () => {
        blocoAnos += 12;
        desenhar();
      }),
    );
    const grelha = elemento('div', 'periodo-grelha');
    for (let ano = blocoAnos; ano < blocoAnos + 12; ano++) {
      const inicio = `${ano}-01-01`;
      const fim = `${ano}-12-31`;
      const b = botao(String(ano), () => definir(inicio, fim));
      b.setAttribute('aria-pressed', String(de === inicio && ate === fim));
      if ([...diasComDados].some((x) => x >= inicio && x <= fim)) b.classList.add('tem-dados');
      grelha.append(b);
    }
    caixa.append(nav, grelha);
    return caixa;
  }

  function desenhar() {
    const rodape = elemento('div', 'periodo-rodape');
    const resumo = elemento('div', 'periodo-resumo');
    resumo.append(elemento('strong', '', descricao()));
    if (modo === 'intervalo' && aEspera) resumo.append('Escolha o último dia do intervalo');
    else if (diasComDados.size) resumo.append('Os dias com um ponto têm dados');
    const limpar = botao('Limpar', () => {
      aEspera = false;
      definir('', '');
    });
    const aplicar = botao('Aplicar', () => {
      fechar();
      raiz.closest('form')?.requestSubmit();
    }, 'primario');
    rodape.append(resumo, limpar, aplicar);
    const vistaAtual = modo === 'mes' ? desenharMeses() : modo === 'ano' ? desenharAnos() : desenharCalendario();
    painel.replaceChildren(desenharModos(), vistaAtual, rodape);
  }

  function abrir() {
    desenhar();
    painel.hidden = false;
    gatilho.setAttribute('aria-expanded', 'true');
  }
  function fechar() {
    painel.hidden = true;
    gatilho.setAttribute('aria-expanded', 'false');
  }
  gatilho.addEventListener('click', (e) => {
    e.preventDefault();
    if (painel.hidden) abrir();
    else fechar();
  });
  document.addEventListener('click', (e) => {
    // composedPath(): o botão clicado já pode ter sido substituído ao redesenhar o calendário.
    if (!painel.hidden && !e.composedPath().includes(raiz)) fechar();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !painel.hidden) {
      fechar();
      gatilho.focus();
    }
  });
  texto.textContent = rotulo();
}
document.querySelectorAll('[data-periodo]').forEach(iniciarPeriodo);

// ----- Fechos: marcar a caixa de um valor valida-o (grava logo, sem botão) -----
// Enquanto a página recarrega as caixas ficam bloqueadas, para que um segundo clique não se perca.
const caixasValidar = document.querySelectorAll('form[data-validar] input[type="checkbox"]');
caixasValidar.forEach((caixa) => {
  caixa.addEventListener('change', () => {
    if (caixa.form.elements.hash) caixa.form.elements.hash.value = location.hash; // volta ao mesmo separador
    caixa.form.requestSubmit();
    caixasValidar.forEach((c) => { c.disabled = true; });
  });
});
window.addEventListener('pageshow', () => caixasValidar.forEach((c) => { c.disabled = false; })); // voltar atrás no browser

// ----- Menu (hambúrguer) em ecrãs estreitos -----
const botaoMenu = document.querySelector('.hamburguer');
if (botaoMenu) {
  const larguraMovel = window.matchMedia('(max-width: 900px)');
  const definir = (aberto) => {
    document.body.classList.toggle('menu-aberto', aberto);
    botaoMenu.setAttribute('aria-expanded', String(aberto));
    botaoMenu.setAttribute('aria-label', aberto ? 'Fechar o menu' : 'Abrir o menu');
  };
  botaoMenu.addEventListener('click', () => definir(!document.body.classList.contains('menu-aberto')));
  document.querySelectorAll('#menu-principal a').forEach((a) => a.addEventListener('click', () => definir(false)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('menu-aberto')) {
      definir(false);
      botaoMenu.focus();
    }
  });
  // Ao passar a um ecrã largo (ou rodar o telemóvel) o menu volta a ser a barra lateral fixa.
  larguraMovel.addEventListener('change', (e) => { if (!e.matches) definir(false); });
}
