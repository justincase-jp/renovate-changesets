import { exec } from '@actions/exec';

import { execWithOutput } from './utils';

import type { PackageJSON } from '@changesets/types';

export const gitFetch = async () => {
  await exec('git', ['fetch']);
};

export const gitPush = async () => {
  await exec('git', ['push', '-u', 'origin', 'HEAD']);
};

export const commitAll = async (message: string) => {
  await exec('git', ['add', '.']);
  await exec('git', ['commit', '-m', message]);
};

export const checkIfClean = async (): Promise<boolean> => {
  const { stdout } = await execWithOutput('git', ['status', '--porcelain']);
  return !stdout.length;
};

export const readFileFromSha = async (
  baseRef: string,
  path: string,
): Promise<PackageJSON> => {
  const { stdout } = await execWithOutput('git', [
    'show',
    `${baseRef}:${path}`,
  ]);

  return JSON.parse(stdout);
};

export const switchToMaybeExistingBranch = async (branch: string) => {
  const { stderr } = await execWithOutput('git', ['checkout', branch], {
    ignoreReturnCode: true,
  });
  const isCreatingBranch = !stderr
    .toString()
    .includes(`Switched to a new branch '${branch}'`);
  if (isCreatingBranch) {
    await exec('git', ['checkout', '-b', branch]);
  }
};
