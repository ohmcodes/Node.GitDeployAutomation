'use strict';

// Custom scripts are restricted to a small allowlist so a script can only act on the
// project's own Compose services, never on the Git Deploy runtime (which holds the Docker
// socket, credentials and the authenticator secret). Scripts are parsed into argument
// lists and run without a shell, so pipes, redirects, variables and chaining cannot work.
//
// One command per line; blank lines and lines starting with # are ignored. Allowed:
//   echo <text>
//   sleep <seconds 1-300>
//   docker compose exec [-T] <service> <command...>    (runs inside the service container)
//   docker compose run --rm [-T] <service> <command...> (one-off container from the service)
//   docker compose restart [<service>...]

const FORBIDDEN = /[;&|`$<>(){}\\\r\x00-\x08\x0b-\x1f\x7f]/;
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const MAX_LINES = 50;

function tokenize(line) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error('unclosed quote');
  if (started) tokens.push(current);
  return tokens;
}

function parseLine(line) {
  if (FORBIDDEN.test(line)) throw new Error('shell features (; & | ` $ < > ( ) { } \\) and control characters are not allowed');
  const tokens = tokenize(line);
  const [first, ...rest] = tokens;
  if (first === 'echo') return { type: 'echo', text: rest.join(' ') };
  if (first === 'sleep') {
    if (rest.length !== 1 || !/^\d{1,3}$/.test(rest[0]) || Number(rest[0]) < 1 || Number(rest[0]) > 300) throw new Error('sleep takes 1-300 seconds');
    return { type: 'sleep', seconds: Number(rest[0]) };
  }
  if (first !== 'docker' || rest[0] !== 'compose') throw new Error('only echo, sleep and docker compose exec/run/restart are allowed');
  const [, sub, ...args] = rest;
  if (sub === 'restart') {
    if (!args.every(item => SERVICE.test(item))) throw new Error('restart takes service names only');
    return { type: 'command', program: 'docker', args: ['compose', 'restart', ...args] };
  }
  if (sub === 'exec' || sub === 'run') {
    const flags = [];
    while (args.length && args[0].startsWith('-')) flags.push(args.shift());
    const allowed = sub === 'exec' ? ['-T'] : ['--rm', '-T'];
    if (!flags.every(flag => allowed.includes(flag))) throw new Error(`docker compose ${sub} only allows ${allowed.join(' and ')}`);
    if (sub === 'run' && !flags.includes('--rm')) throw new Error('docker compose run requires --rm');
    const [service, ...command] = args;
    if (!service || !SERVICE.test(service)) throw new Error(`docker compose ${sub} needs a service name`);
    if (!command.length) throw new Error(`docker compose ${sub} needs a command to run in ${service}`);
    // Scripts have no terminal, so always disable TTY allocation.
    const base = sub === 'exec' ? ['compose', 'exec', '-T'] : ['compose', 'run', '--rm', '-T'];
    return { type: 'command', program: 'docker', args: [...base, service, ...command] };
  }
  throw new Error('only docker compose exec, run and restart are allowed');
}

// Returns the parsed steps, or throws an Error naming the first bad line.
function parseScript(script) {
  if (typeof script !== 'string') throw new Error('Script must be text');
  const lines = script.split('\n');
  const steps = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    try {
      steps.push(parseLine(line));
    } catch (error) {
      throw new Error(`Script line ${index + 1}: ${error.message}`);
    }
  });
  if (steps.length > MAX_LINES) throw new Error(`Scripts are limited to ${MAX_LINES} commands`);
  return steps;
}

function scriptError(script) {
  try {
    parseScript(script);
    return null;
  } catch (error) {
    return error.message;
  }
}

module.exports = { parseScript, scriptError };
