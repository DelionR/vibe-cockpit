#!/usr/bin/env node
// Независимая точка входа демо-режима. НЕ импортирует src/cli.js —
// только изолированный модуль src/demo/index.js. Так демо не влияет на
// разбор аргументов и команды production-клиента.

import { startDemo } from '../src/demo/index.js';

// Минимальный разбор --port / --host (демо-режим не нуждается в CLI панели).
const opts = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--port' || a === '-p') opts.port = Number(process.argv[++i]) || 5173;
  else if (a === '--host' || a === '-h') opts.host = process.argv[++i];
  else if (a === '--help' || a === '-?') {
    console.log('vibe-demo — демонстрационный дашборд на вымышленных данных\n\n' +
      '  --port N   порт (по умолчанию 5173)\n' +
      '  --host H   хост (по умолчанию 127.0.0.1)\n\n' +
      'Данные берутся из examples/demo-state.json (только просмотр).\n' +
      'Запуск production-дашборда: bin/vibe.js serve');
    process.exit(0);
  }
}

startDemo(opts).then((server) => {
  const stop = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}).catch((err) => {
  console.error(`\n\x1b[31mОшибка демо-режима:\x1b[0m ${err.message}`);
  if (process.env.VIBE_DEBUG) console.error(err.stack);
  process.exit(1);
});
