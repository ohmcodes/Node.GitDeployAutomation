'use strict';

const qr = require('qrcode-terminal');

function provisioningUri(secret) {
  return `otpauth://totp/${encodeURIComponent('Git Deploy:administrator')}?secret=${secret}&issuer=${encodeURIComponent('Git Deploy')}&algorithm=SHA1&digits=6&period=30`;
}

function terminalQr(uri) {
  let output;
  qr.generate(uri, generated => { output = generated; });
  const lines = output.split('\n');
  const white = '\x1b[47m  \x1b[0m';
  const padding = white.repeat(3);
  const border = `${padding}${lines[0]}${padding}`;
  return [...Array(3).fill(border), ...lines.map(line => `${padding}${line}${padding}`), ...Array(3).fill(border)].join('\n');
}

module.exports = { provisioningUri, terminalQr };
