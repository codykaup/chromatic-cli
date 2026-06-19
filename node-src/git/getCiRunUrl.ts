type CiRunUrlResolver = (environment: NodeJS.ProcessEnv) => string | undefined;

const stripTrailingSlash = (url: string) => url.replace(/\/$/, '');

// CircleCI provides the full job URL.
// https://circleci.com/docs/variables/#built-in-environment-variables
const getCircleCiRunUrl: CiRunUrlResolver = (environment) => environment.CIRCLE_BUILD_URL;

// GitHub Actions: construct the workflow run URL, including the attempt when available.
// https://docs.github.com/en/actions/learn-github-actions/variables#default-environment-variables
const getGitHubActionsRunUrl: CiRunUrlResolver = (environment) => {
  if (
    environment.GITHUB_ACTIONS !== 'true' ||
    !environment.GITHUB_REPOSITORY ||
    !environment.GITHUB_RUN_ID
  ) {
    return undefined;
  }

  const serverUrl = stripTrailingSlash(environment.GITHUB_SERVER_URL || 'https://github.com');
  const runUrl = `${serverUrl}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}`;
  return environment.GITHUB_RUN_ATTEMPT
    ? `${runUrl}/attempts/${environment.GITHUB_RUN_ATTEMPT}`
    : runUrl;
};

// Buildkite: link to the specific job within the build when we have its ID.
// https://buildkite.com/docs/pipelines/environment-variables
const getBuildkiteRunUrl: CiRunUrlResolver = (environment) => {
  if (!environment.BUILDKITE_BUILD_URL) return undefined;
  return environment.BUILDKITE_JOB_ID
    ? `${environment.BUILDKITE_BUILD_URL}#${environment.BUILDKITE_JOB_ID}`
    : environment.BUILDKITE_BUILD_URL;
};

// Travis CI: the job URL links directly to the job log; fall back to the build URL.
// https://docs.travis-ci.com/user/environment-variables/#default-environment-variables
const getTravisRunUrl: CiRunUrlResolver = (environment) =>
  environment.TRAVIS_JOB_WEB_URL || environment.TRAVIS_BUILD_WEB_URL;

// Azure Pipelines: construct the build results URL, defaulting to the logs tab.
// https://learn.microsoft.com/en-us/azure/devops/pipelines/build/variables
const getAzurePipelinesRunUrl: CiRunUrlResolver = (environment) => {
  if (
    !environment.SYSTEM_COLLECTIONURI ||
    !environment.SYSTEM_TEAMPROJECT ||
    !environment.BUILD_BUILDID
  ) {
    return undefined;
  }

  const collectionUri = stripTrailingSlash(environment.SYSTEM_COLLECTIONURI);
  const project = encodeURIComponent(environment.SYSTEM_TEAMPROJECT);
  return `${collectionUri}/${project}/_build/results?buildId=${environment.BUILD_BUILDID}&view=logs`;
};

// GitLab CI provides the full job URL (which shows its log).
// https://docs.gitlab.com/ee/ci/variables/predefined_variables.html
const getGitLabRunUrl: CiRunUrlResolver = (environment) =>
  environment.GITLAB_CI === 'true' ? environment.CI_JOB_URL : undefined;

// Jenkins provides the build URL.
// https://www.jenkins.io/doc/book/pipeline/jenkinsfile/#using-environment-variables
const getJenkinsRunUrl: CiRunUrlResolver = (environment) =>
  environment.JENKINS_URL ? environment.BUILD_URL : undefined;

// Bitbucket Pipelines: construct the pipeline results URL.
// https://support.atlassian.com/bitbucket-cloud/docs/variables-and-secrets/
const getBitbucketRunUrl: CiRunUrlResolver = (environment) => {
  if (!environment.BITBUCKET_REPO_FULL_NAME || !environment.BITBUCKET_BUILD_NUMBER)
    return undefined;
  return `https://bitbucket.org/${environment.BITBUCKET_REPO_FULL_NAME}/pipelines/results/${environment.BITBUCKET_BUILD_NUMBER}`;
};

// Semaphore 2.0: construct the workflow URL.
// https://docs.semaphoreci.com/reference/env-vars/
const getSemaphoreRunUrl: CiRunUrlResolver = (environment) => {
  if (!environment.SEMAPHORE_ORGANIZATION_URL || !environment.SEMAPHORE_WORKFLOW_ID) {
    return undefined;
  }

  const orgUrl = stripTrailingSlash(environment.SEMAPHORE_ORGANIZATION_URL);
  return `${orgUrl}/workflows/${environment.SEMAPHORE_WORKFLOW_ID}`;
};

// Each resolver inspects the environment for a single CI provider, returning the run URL when that
// provider is detected or `undefined` otherwise. They're tried in order.
const CI_RUN_URL_RESOLVERS: CiRunUrlResolver[] = [
  getCircleCiRunUrl,
  getGitHubActionsRunUrl,
  getBuildkiteRunUrl,
  getTravisRunUrl,
  getAzurePipelinesRunUrl,
  getGitLabRunUrl,
  getJenkinsRunUrl,
  getBitbucketRunUrl,
  getSemaphoreRunUrl,
];

/**
 * Determine a URL pointing at the current CI run (and its logs).
 *
 * Most users run the CLI in CI and never look at the local logs, which are by far the most helpful
 * output when debugging TurboSnap (and other build) behavior. By passing a link to the CI run up to
 * Chromatic, we can surface it in the app so users can jump straight to the logs from a build.
 *
 * Each supported CI provider exposes the information we need through environment variables. Where a
 * provider supplies a ready-made URL we use it directly; otherwise we construct one from the
 * available parts. Returns `undefined` when we can't determine a URL (e.g. an unknown CI provider or
 * a local run).
 *
 * @param environment The environment variables to read from (defaults to `process.env`).
 *
 * @returns The URL of the current CI run, or `undefined` if it can't be determined.
 */
export function getCiRunUrl(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const resolve of CI_RUN_URL_RESOLVERS) {
    const url = resolve(environment);
    if (url) return url;
  }

  return undefined;
}
