'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function createMetricsService({ getRepos, location, exec }) {
  let previousHostCpu;
  let previousRuntimeCpu;
  function hostMetrics() {
    const proc = process.env.HOST_PROC_DIR;
    if (!proc) return { error: 'Host metrics require HOST_PROC_DIR to point to the Docker host proc filesystem.' };
    try {
      const cpu = fs.readFileSync(path.join(proc, 'stat'), 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
      if (cpu.length < 4 || cpu.some(value => !Number.isFinite(value))) throw new Error('Invalid host CPU data');
      const total = cpu.slice(0, 8).reduce((sum, value) => sum + value, 0);
      const idle = cpu[3] + (cpu[4] || 0);
      const deltaTotal = previousHostCpu ? total - previousHostCpu.total : 0;
      const cpuPercent = deltaTotal > 0 ? 100 * (1 - (idle - previousHostCpu.idle) / deltaTotal) : null;
      previousHostCpu = { total, idle };
      const memory = fs.readFileSync(path.join(proc, 'meminfo'), 'utf8');
      const totalMatch = memory.match(/^MemTotal:\s+(\d+)\s+kB/m);
      const availableMatch = memory.match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (!totalMatch || !availableMatch) throw new Error('Host memory information unavailable');
      return { cpuPercent, memoryTotal: Number(totalMatch[1]) * 1024, memoryUsed: (Number(totalMatch[1]) - Number(availableMatch[1])) * 1024 };
    } catch (error) {
      return { error: `Host metrics unavailable: ${error.message}` };
    }
  }

  async function metrics() {
    const usage = process.cpuUsage();
    const now = process.hrtime.bigint();
    const runtimeCpu = previousRuntimeCpu ? 100 * ((usage.user + usage.system) - previousRuntimeCpu.used) / (Number(now - previousRuntimeCpu.time) / 1000) : null;
    previousRuntimeCpu = { used: usage.user + usage.system, time: now };
    const result = {
      runtime: { cpuPercent: runtimeCpu, rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, uptime: process.uptime(), platform: os.platform() },
      host: hostMetrics(),
      containers: []
    };
    for (const repo of getRepos()) {
      if ((!repo.lastDeployed && !repo.composeAttempted) || !fs.existsSync(path.join(location(repo), '.git'))) continue;
      try {
        const options = { cwd: location(repo), env: { ...process.env }, maxBuffer: 2 * 1024 * 1024 };
        delete options.env.DEPLOY_TOKEN;
        const ids = (await exec('docker', ['compose', 'ps', '-q'], options)).stdout.trim().split(/\s+/).filter(Boolean);
        if (!ids.length) continue;
        const output = (await exec('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...ids], options)).stdout.trim();
        for (const line of output.split('\n').filter(Boolean)) {
          const stat = JSON.parse(line);
          result.containers.push({ repoId: repo.id, id: stat.ID, name: stat.Name, cpu: stat.CPUPerc, memory: stat.MemUsage, memoryPercent: stat.MemPerc, network: stat.NetIO, block: stat.BlockIO });
        }
      } catch (error) {
        result.containers.push({ repoId: repo.id, error: `Container metrics unavailable: ${error.message}` });
      }
    }
    return result;
  }


  return { metrics };
}

module.exports = { createMetricsService };
