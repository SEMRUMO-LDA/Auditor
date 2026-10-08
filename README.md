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

## Leitura automática dos talões

Copie `.env.example` para `.env` e preencha `ANTHROPIC_API_KEY`. Sem chave a aplicação funciona, mas quem envia o talão tem de preencher os dados à mão. As fotografias são enviadas para a API da Anthropic para leitura.

## Utilização

1. **Receção:** Enviar talão › Tirar fotografia. Confirma os dados lidos (sobretudo o número da reserva) e submete.
2. **Auditor:** Fechos › Carregar ficheiros do PMS, escolhendo de uma vez todos os ficheiros do mesmo dia. Cada um é reconhecido pelo conteúdo:
   - diário de caixa e relatório de faturas por data da fatura;
   - lista de saídas e relatório de faturas por data de check-out;
   - lista de entradas e relatório de faturas por data de check-in.

   Em alternativa, `npm run importar -- "C:\pasta\com\os\ficheiros"` carrega tudo o que estiver numa pasta.
3. **Auditor:** em Configuração › Terminais, associa cada TPA às unidades onde é usado. Sem isso o fecho do terminal não é comparado com o diário.
4. **Auditor:** em Configuração › Agências, indica como cada agência é faturada (até à estadia, depois da saída dentro de um prazo, ou à parte). É isso que decide se uma reserva sem fatura é erro.
5. **Auditor:** abre cada inconsistência, escreve uma nota e só depois altera o estado (pendente, justificada, resolvida).

## Dados

Tudo fica na pasta `data/`: a base de dados (`caixas.db`) e as fotografias (`taloes/`). Fazer cópia de segurança é copiar essa pasta.

## Testes

```bash
npm test
```

Os testes usam os ficheiros de exemplo de 10/08/2026 que estão em `test/amostra`. Essa pasta tem dados reais de hóspedes e por isso não está no repositório; sem ela, os testes são ignorados. Para os correr, copie para lá os seis ficheiros do PMS desse dia.
