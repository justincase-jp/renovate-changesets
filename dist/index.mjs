import path from 'node:path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { read, defaultConfig } from '@changesets/config';
import { getPackages } from '@manypkg/get-packages';
import fs, { mkdirp, stat, unlink, writeFile } from 'fs-extra';
import { diff, Operation } from 'json-diff-ts';
import sanitize from 'sanitize-filename';
import { coerce } from 'semver';
import { exec } from '@actions/exec';

async function setupGitCredentials(githubToken) {
  await fs.writeFile(
    `${process.env.HOME}/.netrc`,
    `machine github.com
login github-actions[bot]
password ${githubToken}`
  );
}
async function execWithOutput(command, args, options) {
  let myOutput = "";
  let myError = "";
  return {
    code: await exec(command, args, {
      listeners: {
        stdout: (data) => {
          myOutput += data.toString();
        },
        stderr: (data) => {
          myError += data.toString();
        }
      },
      ...options
    }),
    stdout: myOutput,
    stderr: myError
  };
}
const setupGitUser = async () => {
  await exec("git", ["config", "user.name", `"github-actions[bot]"`]);
  await exec("git", [
    "config",
    "user.email",
    `"github-actions[bot]@users.noreply.github.com"`
  ]);
};

const gitFetch = async () => {
  await exec("git", ["fetch"]);
};
const gitPush = async (branch, { force } = {}) => {
  await exec(
    "git",
    [
      "push",
      "origin",
      branch ? `HEAD:${branch}` : void 0,
      force && "--force"
    ].filter(Boolean)
  );
};
const switchToMaybeExistingBranch = async (branch) => {
  await execWithOutput("git", ["checkout", "-t", `origin/${branch}`]);
};
const commitAll = async (message) => {
  await exec("git", ["add", "."]);
  await exec("git", ["commit", "-m", message]);
};
const checkIfClean = async () => {
  const { stdout } = await execWithOutput("git", ["status", "--porcelain"]);
  return !stdout.length;
};
const readPackageJsonFromSha = async (baseRef, path) => {
  const { stdout } = await execWithOutput("git", [
    "show",
    `${baseRef}:${path}`
  ]);
  return JSON.parse(stdout);
};

function textify(diff2, location) {
  const link = `[\`${diff2.key}@${diff2.value}\` \u2197\uFE0E](https://www.npmjs.com/package/${diff2.key}/v/${coerce(diff2.value)?.version ?? diff2.value})`;
  switch (diff2.type) {
    case Operation.ADD: {
      return `Added dependency ${link} (to \`${location}\`)`;
    }
    case Operation.UPDATE: {
      return `Updated dependency ${link} (from \`${diff2.oldValue}\`, in \`${location}\`)`;
    }
    case Operation.REMOVE: {
      return `Removed dependency ${link} (from \`${location}\`)`;
    }
  }
  return "";
}
async function main() {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    core.setFailed("Please add the GITHUB_TOKEN to the changesets action");
    return;
  }
  const baseSha = github.context.payload.pull_request?.base.sha;
  if (!baseSha) {
    core.setFailed(
      "Please find base SHA, please make sure you are running in a PR context"
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
      `Failed to read changesets config: ${err.message}, using default config...`
    );
    return defaultConfig;
  });
  const relevantPackages = packages.packages.filter(
    (pkg) => !changesetsConfig.ignore.includes(pkg.packageJson.name) && !pkg.packageJson.private
  ).map((pkg) => ({
    ...pkg,
    absolutePath: `${pkg.dir}/package.json`,
    relativePath: path.relative(process.cwd(), `${pkg.dir}/package.json`)
  }));
  core.debug(
    `found relevant packages to check:${relevantPackages.map(
      (pkg) => pkg.packageJson?.name || pkg.dir
    )}`
  );
  const changes = /* @__PURE__ */ new Map();
  for (const pkg of relevantPackages) {
    const oldPackageFile = await readPackageJsonFromSha(
      baseSha,
      pkg.relativePath
    );
    if (oldPackageFile) {
      if (!changes.has(pkg.packageJson.name)) {
        changes.set(pkg.packageJson.name, {
          dependencies: [],
          peerDependencies: []
        });
      }
      changes.get(pkg.packageJson.name).dependencies = diff(
        oldPackageFile.dependencies || {},
        pkg.packageJson.dependencies || {}
      );
      changes.get(pkg.packageJson.name).peerDependencies = diff(
        oldPackageFile.peerDependencies || {},
        pkg.packageJson.peerDependencies || {}
      );
    } else {
      core.warning(
        `Failed to locate previous file content of ${pkg.relativePath}, skipping ${pkg.packageJson.name}...`
      );
    }
  }
  const branch = github.context.payload.pull_request.head.ref;
  await gitFetch();
  await switchToMaybeExistingBranch(branch);
  const changesetBase = path.resolve(process.cwd(), ".changeset");
  await mkdirp(changesetBase).catch(() => null);
  for (const [key, value] of changes) {
    const changes2 = [
      ...value.dependencies.map((diff2) => textify(diff2, "dependencies")),
      ...value.peerDependencies.map(
        (diff2) => textify(diff2, "peerDependencies")
      )
    ].map((t) => `- ${t}`);
    core.debug(
      `package update summary ${JSON.stringify({
        key,
        changes: changes2
      })}`
    );
    const cleanName = sanitize(key, {
      replacement: "_"
    });
    const filePath = path.resolve(
      changesetBase,
      `${cleanName}-${issueContext.number}-dependencies.md`
    );
    if (changes2.length === 0) {
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
          type: "patch"
        }
      ],
      summary: changes2.join("\n")
    };
    const changesetContents = `---
${changeset.releases.map((release) => `"${release.name}": ${release.type}`).join("\n")}
---

dependencies updates: 

${changeset.summary}
`;
    core.debug(`Writing changeset to ${filePath}: ${changesetContents}`);
    await writeFile(filePath, changesetContents);
  }
  if (!await checkIfClean()) {
    await commitAll(
      `chore(deps): updated changesets for modified dependencies`
    );
    await gitPush();
  }
}
main().catch((err) => {
  core.error(err);
  core.setFailed(err.message);
});
