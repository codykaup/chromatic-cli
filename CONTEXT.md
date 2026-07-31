# Chromatic CLI

The Chromatic CLI prepares and publishes Storybook builds. TurboSnap narrows a build to the stories
affected by its inputs when it has sufficient evidence to do so safely.

## Language

**Monitoring mode**:
A mode in which v1 and v2 are both evaluated as if each were authoritative, while v1's result alone
drives the build. The two prospective outcomes are recorded for comparison.

**Shadow outcome**:
The outcome an algorithm would choose if it were authoritative, recorded without applying its story
selection to the build.

**Authoritative algorithm**:
The TurboSnap algorithm whose story selection actually drives the build.

**Bail**:
An algorithm outcome that selects every story because narrowing would be unsafe or because all
stories are affected. A shadow bail records the same prospective decision without driving the build.

**Fallback**:
Monitoring control flow that hands execution to v1 when v2 cannot provide a trusted narrowed answer.
It is not an algorithm outcome.

**Comparison event**:
One flat, versioned, path-free analytics record containing V1's result, V2's result and which result
drove the build. The CLI sends it to the dedicated analytics Lambda; it does not pass through the
Index analytics mutation.

**Reason**:
The stable explanation supporting a non-applied TurboSnap outcome. A successful applied outcome has
no reason. Comparison analytics records exactly one reason per algorithm; when several v2
capture-all facts are present, the CLI selects one by the settled precedence.

**Subreason**:
A finite operational refinement of a reason. It is present only for reason families that define
distinct variants. When no refinement applies or can be classified, the analytics property is
omitted and therefore arrives in BigQuery as `NULL`.

**Invalid changed files**:
A condition in which the CLI cannot construct a trustworthy set of files changed from the selected
baseline. The files themselves need not be malformed; failures resolving or inspecting the baseline
also belong to this condition.
_Avoid_: Malformed changed files

**Missing stats file**:
A terminal user error in which no usable Storybook stats file is available to TurboSnap. V1 and V2
both stop the build rather than assuming a safe capture set. It is not a TurboSnap outcome and is
omitted from comparison analytics.
_Avoid_: Stats file not found

**Untrusted builder stats**:
Stats emitted by a recognized builder whose dependency graph is not safe for TurboSnap attribution.
The condition describes the evidence produced by the builder, not support for the builder itself.
_Avoid_: Unsupported builder

**No story files**:
A manifest condition in which TurboSnap recognizes no story files in the builder graph. It does not
assert whether the project truly has no stories or the graph failed to expose them.

**No Storybook config files**:
A manifest condition in which the Storybook configuration directory v2 was handed resolved to zero
files. It describes the input v2 received, not the project: a real Storybook always has a non-empty
configuration directory, so the derivation of that directory is what the condition indicts.
_Avoid_: Missing Storybook config

**No static files**:
A manifest condition in which at least one configured static directory collectively resolved to zero
files. It describes the evidence v2 received, not whether the directories are missing or legitimately
empty.
_Avoid_: Missing static files

**Index unavailable**:
A condition in which the CLI cannot obtain a TurboSnap answer from the Index after the request's
retry policy is exhausted. It describes communication availability, not the validity of a response.

**Index contract violation**:
A response from the Index that cannot be used because the request or response violates the agreed
TurboSnap protocol. It is distinct from a failure to communicate with the Index.

**Internal error**:
An unexpected V2 implementation failure for which narrowing cannot be trusted. Known failure sites
may provide a subreason and Sentry correlation ID; raw messages and stacks remain in Sentry.

**Changed package files**:
A v1 condition in which changed dependency metadata cannot be translated into traceable dependency
modules. It does not mean that any package-file edit necessarily causes a bail.
_Avoid_: Package metadata changed

**Changed Storybook files**:
A change to an explicit Storybook configuration input, including the preview subtree. The input can
be outside the configuration directory when it is imported by a preview file.
_Avoid_: Changed Storybook globals

**Changed Storybook globals**:
A change in bundled runtime evidence that cannot be attributed to a particular story or the preview
subtree. “Globals” refers to TurboSnap's catch-all bucket, not Storybook's user-facing globals API.
_Avoid_: Changed Storybook files

**Changed Storybook version**:
A change to the installed Storybook core version tracked independently of the builder's module graph.
It is not inferred from changed package metadata.

**Served static asset**:
File bytes exposed at the URL formed by a Storybook static directory's target plus the file's path
relative to that directory's source. Its browser-visible identity is the served URL, not the source
path on disk.

**Prebuilt Storybook**:
A Storybook compiled before Chromatic is invoked and supplied as built output while its source
checkout and Git history remain available. It is not an artifact-only execution mode.
_Avoid_: Artifact-only Storybook
