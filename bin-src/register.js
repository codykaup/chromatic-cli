#!/usr/bin/env node

import 'dotenv/config';

const commands = {
  'generate-manifest': () =>
    import('./generateManifest').then(({ main }) => main(process.argv.slice(3))),
  'hash-stories': () =>
    import('./hashStories').then(({ main: hashStoriesMain }) =>
      hashStoriesMain(process.argv.slice(3))
    ),
  'hash-stories-esbuild': () =>
    import('./hashStoriesEsbuild').then(({ main: hashEsbuildMain }) =>
      hashEsbuildMain(process.argv.slice(3))
    ),
  'hash-stories-hybrid': () =>
    import('./hashStoriesHybrid').then(({ main: hashHybridMain }) =>
      hashHybridMain(process.argv.slice(3))
    ),
  init: () => import('./init').then(({ main: initMain }) => initMain(process.argv.slice(3))),
  main: () => import('./main').then(({ main }) => main(process.argv.slice(2))),
  'react-native-build': () =>
    import('./reactNativeBuild').then(({ main }) => main(process.argv.slice(3))),
  trace: () => import('./trace').then(({ main: traceMain }) => traceMain(process.argv.slice(3))),
  'trace-fidelity': () =>
    import('./traceFidelity').then(({ main: fidelityMain }) => fidelityMain(process.argv.slice(3))),
  'trim-stats-file': () =>
    import('./trimStatsFile').then(({ main: trimMain }) => trimMain(process.argv.slice(3))),
};

(commands[process.argv[2]] || commands.main)();
