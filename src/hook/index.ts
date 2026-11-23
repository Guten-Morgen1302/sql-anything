import { install } from './install.js';

// Kill switch: checked first, before anything is patched or any file is opened.
if (process.env.SQL_ANYTHING_DISABLE !== '1') {
  try {
    install();
  } catch {
    // a broken hook must never take the app down
  }
}
