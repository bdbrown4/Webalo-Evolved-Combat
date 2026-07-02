// Minimal, pragmatic lint: catch real mistakes (undefined vars, unused symbols,
// accidental redeclares) without fighting the codebase's compact style.
export default [
  {
    files: ['src/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        localStorage: 'readonly', location: 'readonly', performance: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        console: 'readonly', URLSearchParams: 'readonly', AudioContext: 'readonly',
        RTCPeerConnection: 'readonly', btoa: 'readonly', atob: 'readonly',
        escape: 'readonly', unescape: 'readonly', Infinity: 'readonly',
        innerWidth: 'readonly', innerHeight: 'readonly', devicePixelRatio: 'readonly', Event: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-compare-neg-zero': 'error',
      'no-self-assign': 'error',
      'eqeqeq': ['warn', 'smart'],
    },
  },
];
