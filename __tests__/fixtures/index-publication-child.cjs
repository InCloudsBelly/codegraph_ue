'use strict';

const fs = require('node:fs');
const { createPublicationService } = require('../../scripts/publish-validated-index.cjs');
const directoryApi = require('../../dist/directory.js');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const options = document.options;
options.onPhase = phase => { if (phase === document.exitAfter) process.exit(91); };
try {
  const service = createPublicationService(directoryApi, () => {});
  const result = service[document.action](options);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error.stack || String(error));
  process.exitCode = 1;
}
