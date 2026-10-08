// Importado antes de tudo o resto, para que o .env já esteja carregado quando os outros módulos arrancam.
import path from 'node:path';

try {
  process.loadEnvFile(path.join(import.meta.dirname, '..', '.env'));
} catch {
  // Sem ficheiro .env: usam-se as variáveis de ambiente que existirem.
}
