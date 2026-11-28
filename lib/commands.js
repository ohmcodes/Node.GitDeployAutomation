'use strict';

const { execFile } = require('node:child_process');

// `onOutput(text)` (optional) receives stdout/stderr as it arrives, for live logs.
// The full output is still buffered and returned when the command finishes.
function exec(program, args, { onOutput, ...options } = {}) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let escalated = false;
    let pending;
    const finish = (error, stdout, stderr) => {
      if (timedOut && !escalated) {
        pending = [error, stdout, stderr];
        return;
      }
      if (timedOut && !error) error = new Error('Command timed out');
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    };
    const child = execFile(program, args, { ...options, detached: process.platform !== 'win32' }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') terminate('SIGKILL');
      finish(error, stdout, stderr);
    });
    // Commands never get input; without this, anything that reads stdin waits for the timeout.
    if (child.stdin) child.stdin.end();
    if (onOutput) {
      for (const stream of [child.stdout, child.stderr]) if (stream) stream.on('data', chunk => onOutput(chunk.toString('utf8')));
    }
    const terminate = signal => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else if (child.pid) process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') console.error(error);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      setTimeout(() => {
        terminate('SIGKILL');
        escalated = true;
        if (pending) finish(...pending);
      }, 1000).unref();
    }, 15 * 60 * 1000);
  });
}


module.exports = { exec };
