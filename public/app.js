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
