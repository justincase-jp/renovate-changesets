import path from 'node:path';

import * as core from '@actions/core';
import * as github from '@actions/github';
import { defaultConfig, read } from '@changesets/config';
import { getPackages } from '@manypkg/get-packages';
import { mkdirp, stat, unlink, writeFile } from 'fs-extra';
import { Operation, diff } from 'json-diff-ts';
import sanitize from 'sanitize-filename';
import { coerce as coerceVersion } from 'semver';

import {
  checkIfClean,
  commitAll,
  gitFetch,
  gitPush,
  readFileFromSha,
  switchToMaybeExistingBranch,
} from './git';
import { setupGitCredentials, setupGitUser } from './utils';

import type { IChange } from 'json-diff-ts';

function textify(diff: IChange, location: string) {
  const link = `[\`${diff.key}@${
    diff.value
  }\` ↗︎](https://www.npmjs.com/package/${diff.key}/v/${
    coerceVersion(diff.value)?.version ?? diff.value
  })`;

  switch (diff.type) {
    case Operation.ADD: {
      return `Added dependency ${link} (to \`${location}\`)`;
    }
    case Operation.UPDATE: {
      return `Updated dependency ${link} (from \`${diff.oldValue}\`, in \`${location}\`)`;
    }
    case Operation.REMOVE: {
      return `Removed dependency ${link} (from \`${location}\`)`;
    }
  }

  return '';
}

async function main() {
  const githubToken = core.getInput('token') || process.env.GITHUB_TOKEN;

  if (!githubToken) {
    core.setFailed('Please add the GITHUB_TOKEN to the changesets action');
    return;
  }

  const baseSha = github.context.payload.pull_request?.base.sha;

  if (!baseSha) {
    core.setFailed(
      'Please find base SHA, please make sure you are running in a PR context',
    );
    return;
  }

  await setupGitUser();
  await setupGitCredentials(githubToken);

  const issueContext = github.context.issue;

  if (!issueContext?.number) {
    core.warning(`Failed to locate a PR associated with the Action context:`);
    core.setFailed(`Failed to locate a PR associated with the Action context`);

    return;
  }

  const packages = await getPackages(process.cwd());
  const changesetsConfig = await read(process.cwd(), packages).catch((err) => {
    core.warning(
      `Failed to read changesets config: ${err.message}, using default config...`,
    );

    return defaultConfig;
  });
  const relevantPackages = packages.packages
    .filter(
      (pkg) =>
        !changesetsConfig.ignore.includes(pkg.packageJson.name) &&
        !pkg.packageJson.private,
    )
    .map((pkg) => ({
      ...pkg,
      absolutePath: `${pkg.dir}/package.json`,
      relativePath: path.relative(process.cwd(), `${pkg.dir}/package.json`),
    }));

  core.info(
    `found relevant packages to check:${relevantPackages.map(
      (pkg) => pkg.packageJson?.name || pkg.dir,
    )}`,
  );

  const changes = new Map<
    string,
    {
      dependencies: IChange[];
      peerDependencies: IChange[];
    }
  >();

  for (const pkg of relevantPackages) {
    const oldPackageFile = await readFileFromSha(baseSha, pkg.relativePath);

    if (oldPackageFile) {
      if (!changes.has(pkg.packageJson.name)) {
        changes.set(pkg.packageJson.name, {
          dependencies: [],
          peerDependencies: [],
        });
      }

      core.debug(
        `package row: ${JSON.stringify({
          old: oldPackageFile.dependencies || {},
          new: pkg.packageJson.dependencies || {},
        })}`,
      );
      core.debug(
        `package diff: ${JSON.stringify(
          diff(
            oldPackageFile.dependencies || {},
            pkg.packageJson.dependencies || {},
          ),
        )}`,
      );

      changes.get(pkg.packageJson.name)!.dependencies = diff(
        oldPackageFile.dependencies || {},
        pkg.packageJson.dependencies || {},
      );
      changes.get(pkg.packageJson.name)!.peerDependencies = diff(
        oldPackageFile.peerDependencies || {},
        pkg.packageJson.peerDependencies || {},
      );
    } else {
      core.warning(
        `Failed to locate previous file content of ${pkg.relativePath}, skipping ${pkg.packageJson.name}...`,
      );
    }
  }

  // eslint-disable-next-line n/no-unsupported-features/es-builtins
  core.debug(`changes: ${JSON.stringify(Object.fromEntries(changes))}`);

  const branch = github.context.payload.pull_request!.head.ref;
  await gitFetch();
  await switchToMaybeExistingBranch(branch);

  const changesetBase = path.resolve(process.cwd(), '.changeset');
  await mkdirp(changesetBase).catch(() => null);

  for (const [key, value] of changes) {
    const changes = [
      ...value.dependencies.map((diff) => textify(diff, 'dependencies')),
      ...value.peerDependencies.map((diff) =>
        textify(diff, 'peerDependencies'),
      ),
    ].map((t) => `- ${t}`);

    core.debug(
      `package update core.summary ${JSON.stringify({
        key,
        changes,
      })}`,
    );

    const cleanName = sanitize(key, {
      replacement: '_',
    });
    const filePath = path.resolve(
      changesetBase,
      `${cleanName}-${issueContext.number}-dependencies.md`,
    );

    if (changes.length === 0) {
      const stats = await stat(filePath).catch(() => null);

      if (stats && stats.isFile()) {
        await unlink(filePath);
      }

      continue;
    }

    const changeset = {
      releases: [
        {
          name: key,
          type: 'patch',
        },
      ],
      summary: changes.join('\n'),
    };

    const changesetContents = `---
${changeset.releases
  .map((release) => `"${release.name}": ${release.type}`)
  .join('\n')}
---

dependencies updates: 

${changeset.summary}
`;

    core.debug(`Writing changeset to ${filePath}: ${changesetContents}`);

    await writeFile(filePath, changesetContents);
  }

  if (!(await checkIfClean())) {
    await commitAll(
      `chore(deps): updated changesets for modified dependencies`,
    );
    await gitPush();
  }
}

main().catch((err) => {
  core.error(err);
  core.setFailed(err.message);
});
