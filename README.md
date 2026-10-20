# Auditoria de caixas

Cruza o diário de caixa e o relatório de faturas do PMS com os talões TPA enviados pela receção, e regista as inconsistências para o auditor tratar. Não altera dados nem decide: assinala.

## Arrancar

Precisa do Node.js 22.13 ou superior.

```bash
npm install
```

```bash
npm start
```

Abra `http://localhost:3000`. Na primeira vez é pedido que crie a conta do auditor; as restantes contas criam-se em Configuração › Utilizadores.

Para os telemóveis da receção, use o endereço "Na rede local" que aparece no terminal ao arrancar. O computador e os telemóveis têm de estar na mesma rede.

## Base de dados

A app usa **Postgres**, de duas formas (o SQL é o mesmo):

- **Supabase** (recomendado): defina `DATABASE_URL` no ficheiro `.env`. Os dados ficam no Supabase, com cópias de segurança geridas por eles e acessíveis de qualquer máquina.
- **Postgres local**: sem `DATABASE_URL`, a app usa um Postgres embebido na pasta `data/pglite`. Serve para experimentar ou para uma só máquina.

### Ligar ao Supabase

1. No painel do projeto, abra **Connect › Direct** e escolha **Session pooler**. Copie o URI.
2. Copie `.env.example` para `.env` e preencha `DATABASE_URL` com esse URI, trocando `[YOUR-PASSWORD]` pela palavra-passe da base de dados (se a esqueceu, use "Reset database password" nesse ecrã).
3. Arranque a app (`npm start`). Na primeira ligação cria as tabelas sozinha.
4. Se já tinha dados, copie-os (ver abaixo).

Ao ligar, a app liga o **RLS** (segurança por linha) em todas as tabelas, sem políticas: a chave pública do Supabase (`anon`) não consegue ler nem escrever nada pela API de dados. A app liga-se diretamente ao Postgres, que ignora o RLS. O `DATABASE_URL` é uma palavra-passe: não o partilhe nem o ponha no repositório (o `.env` está no `.gitignore`).

As fotografias e PDF dos talões continuam a ser guardados em ficheiros, na pasta `data/taloes`.

### Copiar dados existentes

```bash
npm run migrar
```

Copia a base de dados antiga (SQLite, `data/caixas.db`) para o destino atual (o Supabase, se houver `DATABASE_URL`; senão o Postgres local). Só copia se o destino estiver vazio, só lê a origem e, se alguma tabela ficar com um número de linhas diferente, não grava nada.

- `npm run migrar -- --origem local` copia o Postgres local (`data/pglite`) para o Supabase. É o caminho de quem começou localmente e depois liga o Supabase.
- `npm run migrar -- --substituir` apaga primeiro o que já estiver no destino.

Sem `DATABASE_URL`, se a base de dados local estiver vazia e existir `data/caixas.db`, a app copia-a sozinha no arranque.

## Leitura automática dos talões

Copie `.env.example` para `.env` e preencha `ANTHROPIC_API_KEY`. Sem chave a aplicação funciona, mas quem envia o talão tem de preencher os dados à mão. As fotografias são enviadas para a API da Anthropic para leitura.

## Utilização

1. **Receção:** Enviar talão › Tirar fotografia. Confirma os dados lidos (sobretudo o número da reserva) e submete. O talão conta logo para o cruzamento, mesmo antes de confirmado.
2. **Auditor:** Fechos › Carregar ficheiros do PMS, escolhendo de uma vez todos os ficheiros do mesmo dia. Cada um é reconhecido pelo conteúdo:
   - diário de caixa e relatório de faturas por data da fatura;
   - lista de saídas e relatório de faturas por data de check-out;
   - lista de entradas e relatório de faturas por data de check-in.

   Em alternativa, `npm run importar -- "C:\pasta\com\os\ficheiros"` carrega tudo o que estiver numa pasta.
3. **Auditor:** em Configuração › Terminais, associa cada TPA às unidades onde é usado. Sem isso o fecho do terminal não é comparado com o diário.
4. **Auditor:** em Fechos, valida o valor de cada meio de pagamento (CASH, TPA, STRIPE, TBBOOKING, TRFBANCO). O TPA valida-se sozinho quando os talões comprovam o valor por inteiro.
5. **Auditor:** abre cada inconsistência, escreve uma nota e só depois altera o estado (pendente, justificada, resolvida).

## Dados e cópias de segurança

- Com o Supabase, a base de dados é gerida por eles (cópias de segurança no painel do projeto).
- Os talões (fotografias e PDF) ficam em `data/taloes`: faça cópia dessa pasta.
- Com o Postgres local, faça cópia da pasta `data/` inteira.

## Testes

```bash
npm test
```

Os testes correm no Postgres embebido, em memória, com dados inventados: base de dados, cruzamento, validações e importação. O teste dos ficheiros de exemplo de 10/08/2026 (em `test/amostra`) tem dados reais de hóspedes e por isso não está no repositório; sem essa pasta, é ignorado. Para o correr, copie para lá os seis ficheiros do PMS desse dia.

Variáveis só para diagnóstico: `DEBUG_SQL=1` regista, por pedido, quantas consultas à base de dados foram feitas; `DEBUG_LATENCIA_MS=30` simula a latência de uma base de dados remota.
