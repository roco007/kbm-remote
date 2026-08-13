/* Receiver-local ESLint overrides — extends the monorepo base.
 * The dashboard renderer is plain TSX (no react-scripts chain), so the
 * react-hooks plugin is not registered; screen files disable that rule
 * locally and comment each useEffect deps usage explicitly instead. */
module.exports = {
  overrides: [
    {
      // Dashboard renderer — JSX support; the react-hooks plugin is not part
      // of the monorepo toolchain, so screen useEffects are annotated manually
      // and any accidental rule reference must not fail the build.
      files: ["src/renderer/**/*.tsx", "src/renderer/**/*.ts"],
      parserOptions: { ecmaFeatures: { jsx: true } },
      rules: {
        "react-hooks/exhaustive-deps": "off",
        "@typescript-eslint/no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
        ],
      },
    },
    {
      // Main process uses Electron's module shim (`require('electron')`).
      files: ["src/main/**/*.ts", "src/preload/**/*.ts"],
      rules: {
        "@typescript-eslint/no-var-requires": "off",
      },
    },
  ],
  ignorePatterns: ["dist", "node_modules"],
};
