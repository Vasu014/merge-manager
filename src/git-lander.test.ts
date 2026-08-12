import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { compareAndSwapRef } from './git-lander.js';

const exec = promisify(execFile);
const directories: string[] = [];

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'merge-manager-lease-test-'));
  directories.push(root);
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  await exec('git', ['init', '--quiet', work]);
  await exec('git', ['-C', work, 'config', 'user.name', 'Merge Manager Test']);
  await exec('git', ['-C', work, 'config', 'user.email', 'merge-manager@example.test']);
  await exec('git', ['-C', work, 'commit', '--allow-empty', '--quiet', '-m', 'base']);
  const base = (await exec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
  await exec('git', ['-C', work, 'checkout', '--quiet', '-b', 'feature']);
  await exec('git', ['-C', work, 'commit', '--allow-empty', '--quiet', '-m', 'feature']);
  const head = (await exec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
  await exec('git', ['-C', work, 'checkout', '--quiet', '-b', 'candidate', base]);
  await exec('git', ['-C', work, 'merge', '--quiet', '--no-ff', 'feature', '-m', 'candidate']);
  const candidate = (await exec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
  await exec('git', ['init', '--bare', '--quiet', remote]);
  await exec('git', ['-C', work, 'push', '--quiet', remote, `${base}:refs/heads/main`, `${candidate}:refs/heads/merge-manager/candidates/test`]);
  return { remote, base, head, candidate };
}

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe('atomic git landing', () => {
  it('moves the target only when it still equals the expected SHA', async () => {
    const fixture = await repository();
    expect(await compareAndSwapRef({ owner: 'o', repo: 'r', ref: 'main', candidateRef: 'merge-manager/candidates/test', candidateSha: fixture.candidate, expectedSha: fixture.base, token: '', remoteUrl: fixture.remote })).toBe('landed');
    expect((await exec('git', ['--git-dir', fixture.remote, 'rev-parse', 'refs/heads/main'])).stdout.trim()).toBe(fixture.candidate);
  });

  it('rejects even a fast-forwardable candidate when the target moved', async () => {
    const fixture = await repository();
    await exec('git', ['--git-dir', fixture.remote, 'update-ref', 'refs/heads/main', fixture.head]);
    expect(await compareAndSwapRef({ owner: 'o', repo: 'r', ref: 'main', candidateRef: 'merge-manager/candidates/test', candidateSha: fixture.candidate, expectedSha: fixture.base, token: '', remoteUrl: fixture.remote })).toBe('unknown');
    expect((await exec('git', ['--git-dir', fixture.remote, 'rev-parse', 'refs/heads/main'])).stdout.trim()).toBe(fixture.head);
  });
});
