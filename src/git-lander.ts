import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface CompareAndSwapRefInput {
  owner: string;
  repo: string;
  ref: string;
  candidateRef: string;
  candidateSha: string;
  expectedSha: string;
  token: string;
  remoteUrl?: string;
}

export async function compareAndSwapRef(input: CompareAndSwapRefInput): Promise<'landed' | 'unknown'> {
  const directory = await mkdtemp(join(tmpdir(), 'merge-manager-land-'));
  const askpass = join(directory, 'askpass.sh');
  const environment = {
    ...process.env,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: '0',
    MERGE_MANAGER_GITHUB_TOKEN: input.token,
  };
  try {
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token;; *) printf "%s\\n" "$MERGE_MANAGER_GITHUB_TOKEN";; esac\n', { mode: 0o700 });
    await chmod(askpass, 0o700);
    await exec('git', ['init', '--bare', '--quiet', directory], { env: environment });
    await exec('git', ['-C', directory, 'remote', 'add', 'origin', input.remoteUrl ?? `https://github.com/${input.owner}/${input.repo}.git`], { env: environment });
    await exec('git', ['-C', directory, 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', `refs/heads/${input.candidateRef}`], { env: environment });
    const fetched = (await exec('git', ['-C', directory, 'rev-parse', 'FETCH_HEAD'], { env: environment })).stdout.trim();
    if (fetched !== input.candidateSha) throw new Error('fetched_candidate_does_not_match');
    try {
      await exec('git', [
        '-C', directory,
        'push', '--quiet',
        `--force-with-lease=refs/heads/${input.ref}:${input.expectedSha}`,
        'origin', `${input.candidateSha}:refs/heads/${input.ref}`,
      ], { env: environment });
      return 'landed';
    } catch {
      return 'unknown';
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
