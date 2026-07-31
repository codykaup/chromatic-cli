import type { TurboSnapBailReason, TurboSnapStatus } from '../../types';
import type { TraceChangedFilesResult } from './types';

export type TurboSnapV1Reason =
  | 'noAncestorBuild'
  | 'rebuild'
  | 'invalidChangedFiles'
  | 'changedExternalFiles'
  | 'changedPackageFiles'
  | 'changedStorybookFiles'
  | 'changedStaticFiles';

export type TurboSnapV2Reason =
  | 'noAncestorBuild'
  | 'rebuild'
  | 'invalidChangedFiles'
  | 'changedExternalFiles'
  | 'changedStorybookFiles'
  | 'changedStaticFiles'
  | 'untrustedBuilderStats'
  | 'anchorMismatch'
  | 'noStoryFiles'
  | 'noStorybookConfigFiles'
  | 'noStaticFiles'
  | 'unresolvedStaticDirectories'
  | 'indexUnavailable'
  | 'indexContractViolation'
  | 'changedStorybookGlobals'
  | 'changedStorybookVersion'
  | 'internalError';

export type TurboSnapV1Subreason =
  | 'ancestorMissing'
  | 'baselineDirty'
  | 'networkError'
  | 'replacementFailed'
  | 'gitCommandFailed'
  | 'baselineCheckoutFailed'
  | 'lockfileParseFailed'
  | 'lockfileSizeExceeded'
  | 'nodeModulesMissingInStats';

export type TurboSnapV2Subreason =
  | 'ancestorMissing'
  | 'baselineDirty'
  | 'networkError'
  | 'replacementFailed'
  | 'gitCommandFailed'
  | 'packageNotFound'
  | 'invalidVersion'
  | 'unsupportedVersion'
  | 'invalidStoryFileHashes'
  | 'invalidBuildStatus'
  | 'invalidResponse'
  | 'builderCompatibilityCheckFailed'
  | 'manifestBuildFailed'
  | 'anchorCheckFailed'
  | 'builderMismatch'
  | 'statsFileOutsideProject'
  | 'statsEntryOutsideProject'
  | 'unresolvedSourceModules';

export interface TurboSnapComparisonEventInput {
  schemaVersion: 1;
  buildId: string;
  mode: 'monitoring';
  onlyStoryFilesSource: 'V1' | 'V2';
  v1: TraceChangedFilesResult;
  v2: TraceChangedFilesResult;
}

export interface TurboSnapComparisonEvent {
  schema_version: 1;
  build_id: string;
  mode: 'monitoring';
  only_story_files_source: 'V1' | 'V2';
  v1_outcome: TurboSnapStatus;
  v1_reason?: TurboSnapV1Reason | 'unavailable';
  v1_subreason?: TurboSnapV1Subreason;
  v1_sentry_event_id?: string;
  v2_outcome: TurboSnapStatus;
  v2_reason?: TurboSnapV2Reason | 'unavailable';
  v2_subreason?: TurboSnapV2Subreason;
  v2_sentry_event_id?: string;
  v2_builder_name?: string;
  v2_builder_version?: string;
}

function getOutcome(result: TraceChangedFilesResult): TurboSnapStatus {
  if (result.status === 'traced') return 'APPLIED';
  if (result.status === 'bailed') return 'BAILED';
  return 'turboSnap' in result && result.turboSnap?.unavailable ? 'UNAVAILABLE' : 'UNUSED';
}

function getBailReason(result: TraceChangedFilesResult) {
  return result.status === 'bailed' ? result.turboSnap.bailReason : undefined;
}

type BailReasonKey =
  | 'invalidChangedFiles'
  | 'changedPackageFiles'
  | 'changedStaticFiles'
  | 'changedStorybookFiles'
  | 'changedExternalFiles'
  | 'noAncestorBuild'
  | 'rebuild'
  | 'changedStorybookGlobals'
  | 'changedStorybookVersion'
  | 'indexContractViolation'
  | 'internalError'
  | 'indexUnavailable'
  | 'untrustedBuilderStats'
  | 'anchorMismatch'
  | 'noStoryFiles'
  | 'noStorybookConfigFiles'
  | 'noStaticFiles'
  | 'unresolvedStaticDirectories';

function selectReason<T extends string>(
  reason: TurboSnapBailReason | undefined,
  precedence: readonly (readonly [BailReasonKey, T])[]
): T | undefined {
  return reason && precedence.find(([key]) => reason[key] !== undefined)?.[1];
}

const V1_REASON_PRECEDENCE = [
  ['invalidChangedFiles', 'invalidChangedFiles'],
  ['changedPackageFiles', 'changedPackageFiles'],
  ['changedStaticFiles', 'changedStaticFiles'],
  ['changedStorybookFiles', 'changedStorybookFiles'],
  ['changedExternalFiles', 'changedExternalFiles'],
  ['noAncestorBuild', 'noAncestorBuild'],
  ['rebuild', 'rebuild'],
] as const satisfies readonly (readonly [BailReasonKey, TurboSnapV1Reason])[];

const V2_REASON_PRECEDENCE = [
  ['changedStorybookGlobals', 'changedStorybookGlobals'],
  ['changedStaticFiles', 'changedStaticFiles'],
  ['changedStorybookFiles', 'changedStorybookFiles'],
  ['changedStorybookVersion', 'changedStorybookVersion'],
  ['indexContractViolation', 'indexContractViolation'],
  ['internalError', 'internalError'],
  ['indexUnavailable', 'indexUnavailable'],
  // Ahead of the other pre-manifest reasons: a wrong anchor makes their evidence unreliable too,
  // since both read packages resolved from it.
  ['anchorMismatch', 'anchorMismatch'],
  ['untrustedBuilderStats', 'untrustedBuilderStats'],
  ['unresolvedStaticDirectories', 'unresolvedStaticDirectories'],
  ['noStorybookConfigFiles', 'noStorybookConfigFiles'],
  ['noStaticFiles', 'noStaticFiles'],
  ['noStoryFiles', 'noStoryFiles'],
  ['invalidChangedFiles', 'invalidChangedFiles'],
  ['changedExternalFiles', 'changedExternalFiles'],
  ['noAncestorBuild', 'noAncestorBuild'],
  ['rebuild', 'rebuild'],
] as const satisfies readonly (readonly [BailReasonKey, TurboSnapV2Reason])[];

function getV1Reason(reason: TurboSnapBailReason | undefined): TurboSnapV1Reason | undefined {
  return selectReason(reason, V1_REASON_PRECEDENCE);
}

function getV2Reason(reason: TurboSnapBailReason | undefined): TurboSnapV2Reason | undefined {
  return selectReason(reason, V2_REASON_PRECEDENCE);
}

const V1_SUBREASON_REASONS = new Set<TurboSnapV1Reason>([
  'invalidChangedFiles',
  'changedPackageFiles',
]);

function getV1Subreason(
  reason: TurboSnapV1Reason | 'unavailable' | undefined,
  bailReason: TurboSnapBailReason | undefined
) {
  return reason && reason !== 'unavailable' && V1_SUBREASON_REASONS.has(reason)
    ? (bailReason?.bailSubreason as TurboSnapV1Subreason | undefined)
    : undefined;
}

function getV1Properties(result: TraceChangedFilesResult) {
  const bailReason = getBailReason(result);
  const outcome = getOutcome(result);
  const reason: TurboSnapV1Reason | 'unavailable' | undefined =
    outcome === 'UNAVAILABLE' ? 'unavailable' : getV1Reason(bailReason);
  if (outcome === 'BAILED' && !reason) {
    throw new Error('A BAILED v1 result must have an analytics reason');
  }
  const subreason = getV1Subreason(reason, bailReason);
  return {
    v1_outcome: outcome,
    ...(reason && { v1_reason: reason }),
    ...(subreason && { v1_subreason: subreason }),
    ...(bailReason?.sentryEventId && { v1_sentry_event_id: bailReason.sentryEventId }),
  };
}

const V2_SUBREASON_REASONS = new Set<TurboSnapV2Reason>([
  'invalidChangedFiles',
  'untrustedBuilderStats',
  'anchorMismatch',
  'indexUnavailable',
  'indexContractViolation',
  'internalError',
]);

function getV2Subreason(
  reason: TurboSnapV2Reason | 'unavailable' | undefined,
  bailReason: TurboSnapBailReason | undefined
) {
  return reason && reason !== 'unavailable' && V2_SUBREASON_REASONS.has(reason)
    ? (bailReason?.bailSubreason as TurboSnapV2Subreason | undefined)
    : undefined;
}

function getV2BuilderProperties(
  reason: TurboSnapV2Reason | 'unavailable' | undefined,
  bailReason: TurboSnapBailReason | undefined
) {
  if (reason !== 'untrustedBuilderStats') return {};
  return {
    ...(bailReason?.builderName && { v2_builder_name: bailReason.builderName }),
    ...(bailReason?.builderVersion && { v2_builder_version: bailReason.builderVersion }),
  };
}

function getV2DetailProperties(
  bailReason: TurboSnapBailReason | undefined,
  reason: TurboSnapV2Reason | 'unavailable' | undefined
) {
  const subreason = getV2Subreason(reason, bailReason);
  return {
    ...(subreason && { v2_subreason: subreason }),
    ...(bailReason?.sentryEventId && { v2_sentry_event_id: bailReason.sentryEventId }),
    ...getV2BuilderProperties(reason, bailReason),
  };
}

function getV2Properties(result: TraceChangedFilesResult) {
  const bailReason = getBailReason(result);
  const outcome = getOutcome(result);
  const reason: TurboSnapV2Reason | 'unavailable' | undefined =
    outcome === 'UNAVAILABLE' ? 'unavailable' : getV2Reason(bailReason);
  if (outcome === 'BAILED' && !reason) {
    throw new Error('A BAILED v2 result must have an analytics reason');
  }
  return {
    v2_outcome: outcome,
    ...(reason && { v2_reason: reason }),
    ...getV2DetailProperties(bailReason, reason),
  };
}

/** Builds the flat, path-free event sent to the dedicated TurboSnap analytics pipeline. */
export function createTurboSnapComparisonEvent(
  input: TurboSnapComparisonEventInput
): TurboSnapComparisonEvent {
  return {
    schema_version: input.schemaVersion,
    build_id: input.buildId,
    mode: input.mode,
    only_story_files_source: input.onlyStoryFilesSource,
    ...getV1Properties(input.v1),
    ...getV2Properties(input.v2),
  };
}
