'use strict';

const { execFile } = require('node:child_process');

function exec(program, args, options) {
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
