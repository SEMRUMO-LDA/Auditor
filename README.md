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

As fotografias e PDF dos talões ficam na própria base de dados (tabela `envio_ficheiros`), por isso não há ficheiros em disco para perder nem para copiar. Os talões antigos da pasta `data/taloes` são copiados sozinhos no arranque (ou com `npm run esquema -- --ficheiros`).

### Copiar dados existentes

```bash
npm run migrar
```

Copia a base de dados antiga (SQLite, `data/caixas.db`) para o destino atual (o Supabase, se houver `DATABASE_URL`; senão o Postgres local). Só copia se o destino estiver vazio, só lê a origem e, se alguma tabela ficar com um número de linhas diferente, não grava nada.

- `npm run migrar -- --origem local` copia o Postgres local (`data/pglite`) para o Supabase. É o caminho de quem começou localmente e depois liga o Supabase.
- `npm run migrar -- --substituir` apaga primeiro o que já estiver no destino.

Sem `DATABASE_URL`, se a base de dados local estiver vazia e existir `data/caixas.db`, a app copia-a sozinha no arranque.

### Publicar na Vercel

A app corre como função da Vercel (o `server.js` exporta a aplicação e o `vercel.json` define o essencial).

1. Crie o esquema no Supabase uma vez (e sempre que o esquema mudar): `npm run esquema`. Na Vercel a app **não** cria tabelas a cada arranque, para os arranques a frio serem rápidos.
2. No projeto da Vercel, defina as variáveis de ambiente `DATABASE_URL` (e `ENCRYPTION_KEY`, ver "Encriptação"). A chave da Anthropic (leitura de talões) adiciona-se depois na própria app, em Configuração › Leitura de talões.
3. Use no `DATABASE_URL` o **Transaction pooler** do Supabase (porta `6543`, em Connect › Direct), que é o indicado para funções sem estado. O `aws-1-…pooler.supabase.com:6543` usa o mesmo utilizador e palavra-passe do Session pooler.
4. Publique. `/saude` responde `{"ok":true}` quando a ligação à base de dados está boa.

Limites na Vercel: cada ficheiro carregado pode ter até 4 MB (limite de 4,5 MB por pedido da plataforma), a função tem 60 s por pedido, e a cada função corresponde uma única ligação à base de dados. O limite de tentativas de login guarda-se na base de dados, por isso vale entre instâncias.

## Notas nos talões

Quem envia um talão pode escrever uma nota para o auditor (até 500 caracteres) antes de o enviar, e pode editá-la ao confirmar. A nota aparece na confirmação do talão, em "Os meus envios", na lista de Talões, nos talões de cada fecho e nos detalhes das inconsistências ligadas a esse talão.

## Pagamentos da Booking.com

O relatório de pagamentos da Booking.com ("Payout", CSV) carrega-se com os outros ficheiros do PMS: é reconhecido pelo conteúdo. Cada linha é uma reserva paga (referência da Booking, check-in, check-out, valor) e fica guardada na base de dados; carregar o mesmo relatório outra vez não duplica nada.

Cruza-se com as **faturas TBBOOKING** do PMS pela propriedade (os nomes do PMS e da Booking reconhecem-se apesar das diferenças de escrita), pelas datas de check-in e check-out e pelo valor. Como a Booking paga no dia do check-out e o PMS só emite a fatura TBBOOKING alguns dias depois, cada fatura procura o seu pagamento em todos os relatórios carregados, de qualquer dia:

- no separador TBBOOKING de cada fecho aparece quantas faturas têm pagamento da Booking, o valor pago e quantas não têm relatório carregado para o seu check-out;
- fatura TBBOOKING com relatório carregado para esse check-out mas sem linha igual: aviso "TBBOOKING sem pagamento da Booking.com";
- pagamentos de um dia ainda sem fatura TBBOOKING: informação ("Pagamentos da Booking.com sem fatura TBBOOKING"); passa a aviso se já passaram mais de 5 dias até ao último dia carregado.

## Documentos FA

Os documentos **FA** são faturas dos operadores, em conta corrente e com pagamento a 30 dias: não têm pagamento no dia (vêm com valor 0,00 e sem meio de pagamento). Por isso uma reserva com documento FA conta como faturada (não aparece como "sem fatura" nem "faturada abaixo do total"), e uma FA emitida no dia não exige movimento no diário de caixa. As reservas faturadas assim aparecem agrupadas numa inconsistência informativa ("Reservas faturadas a operadores (FA)") para o auditor acompanhar o recebimento. As faturas FR continuam a exigir o seu pagamento.

## Talões repetidos

Ao enviar um talão, a app recusa-o (com uma mensagem a explicar porquê) se:

- **o ficheiro é o mesmo** que já foi enviado (impressão digital SHA-256); neste caso nem chega a ser lido, o que poupa a leitura automática;
- **o talão lido já existe** noutro envio, mesmo que seja outra fotografia do mesmo papel: mesmo tipo, terminal, dia, hora e valor, e os mesmos últimos 4 dígitos do cartão quando existem. Dois clientes com o mesmo valor no mesmo minuto, mas cartões diferentes, não contam como repetidos.

Ao confirmar um talão (ou ao preencher à mão), a mesma verificação impede guardar um talão que já existe noutro envio ou que está duplicado na mesma fotografia. Para os envios feitos antes desta verificação, `npm run esquema` calcula as impressões digitais em falta.

## Encriptação dos dados

Em trânsito, a ligação ao Supabase e o site na Vercel usam TLS/HTTPS; em repouso, o Supabase e a Vercel encriptam os discos. Além disso, a app encripta com **AES-256-GCM**, antes de os gravar na base de dados, os dados mais sensíveis:

- os dados do cartão dos talões (`taloes.cartao`, `taloes.ultimos4`);
- o detalhe das inconsistências (`inconsistencias.detalhe_json`: nomes de hóspedes, reservas e cartões);
- as fotografias e PDF dos talões (`envio_ficheiros.conteudo`).

Quem aceder à base de dados (painel do Supabase, cópias de segurança) só vê texto cifrado; a app decifra ao ler. As palavras-passe dos utilizadores já ficam apenas como hash (scrypt).

1. Crie uma chave: `npm run encriptar -- --gerar`. Guarde uma cópia num gestor de palavras-passe: **sem a chave, os dados encriptados não se recuperam**.
2. Defina `ENCRYPTION_KEY` no `.env` **e** nas variáveis da Vercel (marcada *Sensitive*). Tem de ser a mesma nos dois sítios.
3. Faça deploy e corra `npm run encriptar`: encripta o que já estava gravado em claro (é seguro repetir, e confirma que cada valor volta ao original antes de gravar). `npm run encriptar -- --estado` mostra quantos valores estão cifrados.

Os dados novos ficam cifrados assim que a chave estiver definida; os antigos continuam a ler-se até serem encriptados. Para trocar de chave: ponha a antiga em `ENCRYPTION_KEY_ANTERIOR`, a nova em `ENCRYPTION_KEY` e corra `npm run encriptar -- --rodar`. Como os campos cifrados não se podem pesquisar na base de dados, nenhum deles é usado em filtros ou ordenações (nomes de hóspedes, quartos e reservas em tabelas como `faturas` e `reservas` não estão cifrados pela app, porque a pesquisa e os cruzamentos dependem deles).

## Fora dos motores de pesquisa

A app é interna e está escondida dos motores de pesquisa: todas as respostas levam `X-Robots-Tag: noindex, nofollow`, as páginas têm `<meta name="robots" content="noindex">`, o `robots.txt` bloqueia tudo e os robôs de pesquisa e de recolha de dados para IA conhecidos (Google, Bing, GPTBot, etc.) recebem 404. Nada disto é uma barreira de segurança; o acesso aos dados exige sempre login.

## Leitura automática dos talões

O auditor escolhe o serviço e adiciona a chave da API na própria app, em **Configuração › Leitura de talões**. Há dois fornecedores:

- **Google Gemini** (modelo por omissão `gemini-3.6-flash`, mudável na mesma página; se um modelo falhar, a app tenta automaticamente outros): chave do Google AI Studio (aistudio.google.com/apikey). Tem nível gratuito, mas **no nível gratuito a Google pode usar o conteúdo enviado para melhorar os seus produtos**; como os talões incluem dados de clientes, ative a faturação (nível pago) se não quiser isso.
- **Anthropic (Claude)**: chave em console.anthropic.com (a conta precisa de crédito). É o que dá melhor leitura da reserva escrita à mão.

A chave é validada com o fornecedor antes de guardar, fica na base de dados (encriptada, se houver `ENCRYPTION_KEY`) e passa a valer logo, em Enviar talão, para todos os utilizadores. Nunca volta a ser mostrada (só os últimos 4 caracteres) e pode ser substituída ou removida. Com as duas chaves guardadas, escolhe-se qual está em uso.

Como alternativa às chaves da app, podem definir-se no servidor as variáveis `ANTHROPIC_API_KEY` ou `GEMINI_API_KEY` (a chave guardada na app tem prioridade). Sem nenhuma chave a aplicação funciona, mas quem envia o talão tem de preencher os dados à mão. As fotografias e PDF são enviados ao fornecedor escolhido para leitura, e o resultado é sempre mostrado para confirmação antes de ser usado.

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
- Os talões (fotografias e PDF) ficam na base de dados, juntamente com tudo o resto.
- Com o Postgres local, faça cópia da pasta `data/` inteira.

## Testes

```bash
npm test
```

Os testes correm no Postgres embebido, em memória, com dados inventados: base de dados, cruzamento, validações e importação. O teste dos ficheiros de exemplo de 10/08/2026 (em `test/amostra`) tem dados reais de hóspedes e por isso não está no repositório; sem essa pasta, é ignorado. Para o correr, copie para lá os seis ficheiros do PMS desse dia.

Variáveis só para diagnóstico: `DEBUG_SQL=1` regista, por pedido, quantas consultas à base de dados foram feitas; `DEBUG_LATENCIA_MS=30` simula a latência de uma base de dados remota.
