#!/usr/bin/env node

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const MIN_NODE_MAJOR = 20;

function log(message) {
  console.log(`[opencli] ${message}`);
}

function warn(message) {
  console.warn(`[opencli] ${message}`);
}

function run(args) {
  return spawnSync(npmCmd, args, {
    cwd: serverRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

function parseInstalledVersion(lsOutput) {
  const match = lsOutput.match(/@jackwener\/opencli@([0-9]+\.[0-9]+\.[0-9]+)/);
  return match?.[1];
}

if (process.env.AGENT_MONITOR_SKIP_OPENCLI === '1') {
  log('Skipped by AGENT_MONITOR_SKIP_OPENCLI=1');
  process.exit(0);
}

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
if (Number.isNaN(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
  warn(`Skipping OpenCLI bootstrap: Node.js >= ${MIN_NODE_MAJOR} is required (current ${process.versions.node}).`);
  process.exit(0);
}

log('Ensuring latest @jackwener/opencli is installed...');
const installResult = run(['install', '--no-save', '--ignore-scripts', '@jackwener/opencli@latest']);
if (installResult.status !== 0) {
  warn('Failed to install @jackwener/opencli@latest. Agent Monitor will continue without hard failure.');
  if (installResult.stderr?.trim()) {
    warn(installResult.stderr.trim());
  }
  process.exit(0);
}

const listResult = run(['ls', '@jackwener/opencli', '--depth=0']);
const combined = `${listResult.stdout || ''}\n${listResult.stderr || ''}`;
const version = parseInstalledVersion(combined);

if (version) {
  log(`Ready: @jackwener/opencli@${version}`);
} else {
  log('Ready: @jackwener/opencli installed.');
}
