import { exec } from '@actions/exec';

import { execWithOutput } from './utils';

import type { PackageJSON } from '@changesets/types';

export const gitPush = async (
  branch?: string,
  { force }: { force?: boolean } = {},
) => {
  await exec(
    'git',
    [
      'push',
      'origin',
      branch ? `HEAD:${branch}` : undefined,
      force && '--force',
    ].filter<string>(Boolean as any),
  );
};

export const commitAll = async (message: string) => {
  await exec('git', ['add', '.']);
  await exec('git', ['commit', '-m', message]);
};

export const checkIfClean = async (): Promise<boolean> => {
  const { stdout } = await execWithOutput('git', ['status', '--porcelain']);
  return !stdout.length;
};

export const readPackageJsonFromSha = async (
  baseRef: string,
  path: string,
): Promise<PackageJSON> => {
  const { stdout } = await execWithOutput('git', [
    'show',
    `${baseRef}:${path}`,
  ]);

  return JSON.parse(stdout);
};
