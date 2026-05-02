import { defineConfig } from '@trigger.dev/sdk/v3';

export default defineConfig({
  project: 'globaltracker',
  dirs: ['./src/tasks'],
  // Duração máxima de execução de tasks em segundos (máximo conservador para workflows de automação)
  maxDuration: 300,
});
