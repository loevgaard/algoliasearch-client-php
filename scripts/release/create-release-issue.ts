/* eslint-disable no-console */
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';
import semver from 'semver';

import openapitools from '../../openapitools.json';

import { RELEASED_TAG, MAIN_BRANCH, OWNER, REPO, LANGS, run } from './common';
import TEXT from './text';

dotenv.config();

type Version = {
  current: string;
  langName: string;
  next?: string;
  noCommit?: boolean;
  skipRelease?: boolean;
};

type Versions = {
  [lang: string]: Version;
};

function readVersions(): Versions {
  const versions = {};

  const generators = openapitools['generator-cli'].generators;

  Object.keys(generators).forEach((generator) => {
    const lang = generator.split('-')[0];
    if (!versions[lang]) {
      versions[lang] = {
        current: generators[generator].additionalProperties.packageVersion,
        langName: lang,
        next: undefined,
      };
    }
  });
  return versions;
}

if (!process.env.GITHUB_TOKEN) {
  throw new Error('Environment variable `GITHUB_TOKEN` does not exist.');
}

if (run('git rev-parse --abbrev-ref HEAD') !== MAIN_BRANCH) {
  throw new Error(
    `You can run this script only from \`${MAIN_BRANCH}\` branch.`
  );
}

if (run('git status --porcelain')) {
  throw new Error(
    'Working directory is not clean. Commit all the changes first.'
  );
}

run(`git rev-parse --verify refs/tags/${RELEASED_TAG}`, {
  errorMessage: '`released` tag is missing in this repository.',
});

// Reading versions from `openapitools.json`
const versions = readVersions();

console.log('Pulling from origin...');
run(`git pull origin ${MAIN_BRANCH}`);

console.log('Pushing to origin...');
run(`git push origin ${MAIN_BRANCH}`);

const commitsWithoutScope: string[] = [];
const commitsWithNonLanguageScope: string[] = [];

// Reading commits since last release
type LatestCommit = {
  hash: string;
  type: string;
  lang: string;
  message: string;
  raw: string;
};
const latestCommits = run(`git log --oneline ${RELEASED_TAG}..${MAIN_BRANCH}`)
  .split('\n')
  .filter(Boolean)
  .map((commit) => {
    const hash = commit.slice(0, 7);
    let message = commit.slice(8);
    let type = message.slice(0, message.indexOf(':'));
    const matchResult = type.match(/(.+)\((.+)\)/);
    if (!matchResult) {
      commitsWithoutScope.push(commit);
      return undefined;
    }
    message = message.slice(message.indexOf(':') + 1).trim();
    type = matchResult[1];
    const lang = matchResult[2];

    if (!LANGS.includes(lang)) {
      commitsWithNonLanguageScope.push(commit);
      return undefined;
    }

    return {
      hash,
      type, // `fix` | `feat` | `chore` | ...
      lang, // `javascript` | `php` | `java` | ...
      message,
      raw: commit,
    };
  })
  .filter(Boolean) as LatestCommit[];

console.log('[INFO] Skipping these commits due to lack of language scope:');
console.log(commitsWithoutScope.map((commit) => `  ${commit}`).join('\n'));

console.log('');
console.log('[INFO] Skipping these commits due to wrong scopes:');
console.log(
  commitsWithNonLanguageScope.map((commit) => `  ${commit}`).join('\n')
);

LANGS.forEach((lang) => {
  const commits = latestCommits.filter(
    (lastestCommit) => lastestCommit.lang === lang
  );
  const currentVersion = versions[lang].current;

  if (commits.length === 0) {
    versions[lang].next = currentVersion;
    versions[lang].noCommit = true;
    return;
  }

  if (semver.prerelease(currentVersion)) {
    // if version is like 0.1.2-beta.1, it increases to 0.1.2-beta.2, even if there's a breaking change.
    versions[lang].next = semver.inc(currentVersion, 'prerelease');
    return;
  }

  if (commits.some((commit) => commit.message.includes('BREAKING CHANGE'))) {
    versions[lang].next = semver.inc(currentVersion, 'major');
    return;
  }

  const commitTypes = new Set(commits.map(({ type }) => type));
  if (commitTypes.has('feat')) {
    versions[lang].next = semver.inc(currentVersion, 'minor');
    return;
  }

  versions[lang].next = semver.inc(currentVersion, 'patch');
  if (!commitTypes.has('fix')) {
    versions[lang].skipRelease = true;
  }
});

const versionChanges = LANGS.map((lang) => {
  const { current, next, noCommit, skipRelease, langName } = versions[lang];

  if (noCommit) {
    return `- ~${langName}: v${current} (${TEXT.noCommit})~`;
  }

  if (!current) {
    return `- ~${langName}: (${TEXT.currentVersionNotFound})~`;
  }

  const checked = skipRelease ? ' ' : 'x';
  return [
    `- [${checked}] ${langName}: v${current} -> v${next}`,
    skipRelease && TEXT.descriptionForSkippedLang(langName),
  ]
    .filter(Boolean)
    .join('\n');
}).join('\n');

const changelogs = LANGS.filter(
  (lang) => !versions[lang].noCommit && versions[lang].current
)
  .flatMap((lang) => {
    if (versions[lang].noCommit) {
      return [];
    }

    return [
      `### ${versions[lang].langName}`,
      ...latestCommits
        .filter((commit) => commit.lang === lang)
        .map((commit) => `- ${commit.raw}`),
    ];
  })
  .join('\n');

const body = [
  TEXT.header,
  TEXT.versionChangeHeader,
  versionChanges,
  TEXT.changelogHeader,
  TEXT.changelogDescription,
  changelogs,
  TEXT.approvalHeader,
  TEXT.approval,
].join('\n\n');

const octokit = new Octokit({
  auth: `token ${process.env.GITHUB_TOKEN}`,
});

octokit.rest.issues
  .create({
    owner: OWNER,
    repo: REPO,
    title: `chore: release ${new Date().toISOString().split('T')[0]}`,
    body,
  })
  .then((result) => {
    const {
      data: { number, html_url: url },
    } = result;

    console.log('');
    console.log(`Release issue #${number} is ready for review.`);
    console.log(`  > ${url}`);
  });