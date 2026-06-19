import { describe, expect, it } from 'vitest';

import { getCiRunUrl } from './getCiRunUrl';

describe('getCiRunUrl', () => {
  it('returns undefined when no CI variables are present', () => {
    expect(getCiRunUrl({})).toBeUndefined();
  });

  it('detects CircleCI', () => {
    expect(getCiRunUrl({ CIRCLE_BUILD_URL: 'https://circleci.com/gh/chromaui/cli/123' })).toBe(
      'https://circleci.com/gh/chromaui/cli/123'
    );
  });

  describe('GitHub Actions', () => {
    it('constructs the run URL', () => {
      expect(
        getCiRunUrl({
          GITHUB_ACTIONS: 'true',
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'chromaui/chromatic-cli',
          GITHUB_RUN_ID: '123456',
        })
      ).toBe('https://github.com/chromaui/chromatic-cli/actions/runs/123456');
    });

    it('includes the run attempt when available', () => {
      expect(
        getCiRunUrl({
          GITHUB_ACTIONS: 'true',
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'chromaui/chromatic-cli',
          GITHUB_RUN_ID: '123456',
          GITHUB_RUN_ATTEMPT: '2',
        })
      ).toBe('https://github.com/chromaui/chromatic-cli/actions/runs/123456/attempts/2');
    });

    it('defaults the server URL (GitHub Enterprise still works via GITHUB_SERVER_URL)', () => {
      expect(
        getCiRunUrl({
          GITHUB_ACTIONS: 'true',
          GITHUB_REPOSITORY: 'chromaui/chromatic-cli',
          GITHUB_RUN_ID: '123456',
        })
      ).toBe('https://github.com/chromaui/chromatic-cli/actions/runs/123456');
    });
  });

  describe('Buildkite', () => {
    it('uses the build URL', () => {
      expect(
        getCiRunUrl({ BUILDKITE_BUILD_URL: 'https://buildkite.com/acme/pipeline/builds/42' })
      ).toBe('https://buildkite.com/acme/pipeline/builds/42');
    });

    it('links to the specific job when a job ID is present', () => {
      expect(
        getCiRunUrl({
          BUILDKITE_BUILD_URL: 'https://buildkite.com/acme/pipeline/builds/42',
          BUILDKITE_JOB_ID: 'abc-def',
        })
      ).toBe('https://buildkite.com/acme/pipeline/builds/42#abc-def');
    });
  });

  describe('Travis CI', () => {
    it('prefers the job URL', () => {
      expect(
        getCiRunUrl({
          TRAVIS_JOB_WEB_URL: 'https://travis-ci.com/chromaui/cli/jobs/2',
          TRAVIS_BUILD_WEB_URL: 'https://travis-ci.com/chromaui/cli/builds/1',
        })
      ).toBe('https://travis-ci.com/chromaui/cli/jobs/2');
    });

    it('falls back to the build URL', () => {
      expect(
        getCiRunUrl({ TRAVIS_BUILD_WEB_URL: 'https://travis-ci.com/chromaui/cli/builds/1' })
      ).toBe('https://travis-ci.com/chromaui/cli/builds/1');
    });
  });

  describe('Azure Pipelines', () => {
    it('constructs the build results URL', () => {
      expect(
        getCiRunUrl({
          SYSTEM_COLLECTIONURI: 'https://dev.azure.com/myorg/',
          SYSTEM_TEAMPROJECT: 'My Project',
          BUILD_BUILDID: '789',
        })
      ).toBe('https://dev.azure.com/myorg/My%20Project/_build/results?buildId=789&view=logs');
    });
  });

  it('detects GitLab CI', () => {
    expect(
      getCiRunUrl({ GITLAB_CI: 'true', CI_JOB_URL: 'https://gitlab.com/acme/cli/-/jobs/5' })
    ).toBe('https://gitlab.com/acme/cli/-/jobs/5');
  });

  it('detects Jenkins', () => {
    expect(
      getCiRunUrl({
        JENKINS_URL: 'https://jenkins.example.com/',
        BUILD_URL: 'https://jenkins.example.com/job/cli/5/',
      })
    ).toBe('https://jenkins.example.com/job/cli/5/');
  });

  it('does not treat a bare BUILD_URL as Jenkins', () => {
    expect(getCiRunUrl({ BUILD_URL: 'https://example.com/5/' })).toBeUndefined();
  });

  it('constructs the Bitbucket Pipelines URL', () => {
    expect(
      getCiRunUrl({ BITBUCKET_REPO_FULL_NAME: 'acme/cli', BITBUCKET_BUILD_NUMBER: '17' })
    ).toBe('https://bitbucket.org/acme/cli/pipelines/results/17');
  });

  it('constructs the Semaphore URL', () => {
    expect(
      getCiRunUrl({
        SEMAPHORE_ORGANIZATION_URL: 'https://acme.semaphoreci.com',
        SEMAPHORE_WORKFLOW_ID: 'wf-1',
      })
    ).toBe('https://acme.semaphoreci.com/workflows/wf-1');
  });
});
