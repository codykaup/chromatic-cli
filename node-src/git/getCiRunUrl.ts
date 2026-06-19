const stripTrailingSlash = (url: string) => url.replace(/\/$/, '');

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
// eslint-disable-next-line complexity
export function getCiRunUrl(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  // CircleCI provides the full job URL.
  // https://circleci.com/docs/variables/#built-in-environment-variables
  if (environment.CIRCLE_BUILD_URL) return environment.CIRCLE_BUILD_URL;

  // GitHub Actions: construct the workflow run URL, including the attempt when available.
  // https://docs.github.com/en/actions/learn-github-actions/variables#default-environment-variables
  if (
    environment.GITHUB_ACTIONS === 'true' &&
    environment.GITHUB_REPOSITORY &&
    environment.GITHUB_RUN_ID
  ) {
    const serverUrl = stripTrailingSlash(environment.GITHUB_SERVER_URL || 'https://github.com');
    const runUrl = `${serverUrl}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}`;
    return environment.GITHUB_RUN_ATTEMPT
      ? `${runUrl}/attempts/${environment.GITHUB_RUN_ATTEMPT}`
      : runUrl;
  }

  // Buildkite: link to the specific job within the build when we have its ID.
  // https://buildkite.com/docs/pipelines/environment-variables
  if (environment.BUILDKITE_BUILD_URL) {
    return environment.BUILDKITE_JOB_ID
      ? `${environment.BUILDKITE_BUILD_URL}#${environment.BUILDKITE_JOB_ID}`
      : environment.BUILDKITE_BUILD_URL;
  }

  // Travis CI: the job URL links directly to the job log; fall back to the build URL.
  // https://docs.travis-ci.com/user/environment-variables/#default-environment-variables
  if (environment.TRAVIS_JOB_WEB_URL || environment.TRAVIS_BUILD_WEB_URL) {
    return environment.TRAVIS_JOB_WEB_URL || environment.TRAVIS_BUILD_WEB_URL;
  }

  // Azure Pipelines: construct the build results URL, defaulting to the logs tab.
  // https://learn.microsoft.com/en-us/azure/devops/pipelines/build/variables
  if (
    environment.SYSTEM_COLLECTIONURI &&
    environment.SYSTEM_TEAMPROJECT &&
    environment.BUILD_BUILDID
  ) {
    const collectionUri = stripTrailingSlash(environment.SYSTEM_COLLECTIONURI);
    const project = encodeURIComponent(environment.SYSTEM_TEAMPROJECT);
    return `${collectionUri}/${project}/_build/results?buildId=${environment.BUILD_BUILDID}&view=logs`;
  }

  // GitLab CI provides the full job URL (which shows its log).
  // https://docs.gitlab.com/ee/ci/variables/predefined_variables.html
  if (environment.GITLAB_CI === 'true' && environment.CI_JOB_URL) return environment.CI_JOB_URL;

  // Jenkins provides the build URL.
  // https://www.jenkins.io/doc/book/pipeline/jenkinsfile/#using-environment-variables
  if (environment.JENKINS_URL && environment.BUILD_URL) return environment.BUILD_URL;

  // Bitbucket Pipelines: construct the pipeline results URL.
  // https://support.atlassian.com/bitbucket-cloud/docs/variables-and-secrets/
  if (environment.BITBUCKET_REPO_FULL_NAME && environment.BITBUCKET_BUILD_NUMBER) {
    return `https://bitbucket.org/${environment.BITBUCKET_REPO_FULL_NAME}/pipelines/results/${environment.BITBUCKET_BUILD_NUMBER}`;
  }

  // Bitrise provides the build URL.
  // https://devcenter.bitrise.io/en/references/available-environment-variables.html
  if (environment.BITRISE_BUILD_URL) return environment.BITRISE_BUILD_URL;

  // Drone provides the build link.
  // https://docs.drone.io/pipeline/environment/reference/
  if (environment.DRONE_BUILD_LINK) return environment.DRONE_BUILD_LINK;

  // Codefresh provides the build URL.
  // https://codefresh.io/docs/docs/codefresh-yaml/variables/
  if (environment.CF_BUILD_URL) return environment.CF_BUILD_URL;

  // AppVeyor: construct the build URL.
  // https://www.appveyor.com/docs/environment-variables/
  if (
    environment.APPVEYOR_ACCOUNT_NAME &&
    environment.APPVEYOR_PROJECT_SLUG &&
    environment.APPVEYOR_BUILD_ID
  ) {
    const appVeyorUrl = stripTrailingSlash(environment.APPVEYOR_URL || 'https://ci.appveyor.com');
    return `${appVeyorUrl}/project/${environment.APPVEYOR_ACCOUNT_NAME}/${environment.APPVEYOR_PROJECT_SLUG}/builds/${environment.APPVEYOR_BUILD_ID}`;
  }

  // Semaphore 2.0: construct the workflow URL.
  // https://docs.semaphoreci.com/reference/env-vars/
  if (environment.SEMAPHORE_ORGANIZATION_URL && environment.SEMAPHORE_WORKFLOW_ID) {
    const orgUrl = stripTrailingSlash(environment.SEMAPHORE_ORGANIZATION_URL);
    return `${orgUrl}/workflows/${environment.SEMAPHORE_WORKFLOW_ID}`;
  }

  // Cirrus CI: construct the task URL.
  // https://cirrus-ci.org/guide/writing-tasks/#environment-variables
  if (environment.CIRRUS_CI === 'true' && environment.CIRRUS_TASK_ID) {
    return `https://cirrus-ci.com/task/${environment.CIRRUS_TASK_ID}`;
  }

  return undefined;
}
