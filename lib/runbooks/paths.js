const path = require('path');

// Everything user-created lives under LABS_DIR (the PVC / mounted volume),
// next to the lab files, so one volume backup captures all of it. Built-in
// runbooks ship inside the image and are copied into RUNBOOKS_DIR on boot.
const LABS_DIR = process.env.LABS_DIR || '/labs';

module.exports = {
  RUNBOOKS_DIR: path.join(LABS_DIR, '.runbooks'),
  RUNS_DIR: path.join(LABS_DIR, '.runs'),
  STORE_PATH: path.join(LABS_DIR, '.config', 'store.json'),
  BUILTIN_DIR: path.join(__dirname, '..', '..', 'runbooks', 'builtin'),
};
