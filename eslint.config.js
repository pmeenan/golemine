import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const LIBHEIF_JS_MESSAGE =
  "Use isolated same-origin vendor files under public/vendor/libheif-js; do not bundle libheif-js into app source.";

// Shared LGPL guardrail: block `libheif-js` (and subpaths) from app source, both
// as static/dynamic imports with a string-literal specifier and as a dynamic
// import with a no-substitution template literal specifier (e.g.
// `import(\`libheif-js\`)`), which Vite still statically bundles even though it
// evades a source.value string check.
const noBundledLibheifJsRules = {
  "no-restricted-imports": [
    "error",
    {
      paths: [
        {
          name: "libheif-js",
          message: LIBHEIF_JS_MESSAGE,
        },
      ],
      patterns: [
        {
          group: ["libheif-js/*"],
          message: LIBHEIF_JS_MESSAGE,
        },
      ],
    },
  ],
  "no-restricted-syntax": [
    "error",
    {
      selector: "ImportExpression[source.value=/^libheif-js(?:\\/.*)?$/]",
      message: LIBHEIF_JS_MESSAGE,
    },
    {
      selector:
        'ImportExpression[source.type="TemplateLiteral"][source.expressions.length=0][source.quasis.0.value.raw=/^libheif-js(?:\\/.*)?$/]',
      message: LIBHEIF_JS_MESSAGE,
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      "dist",
      "dev-dist",
      "node_modules",
      "playwright-report",
      "public/vendor",
      "test-results",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      ...noBundledLibheifJsRules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      ...noBundledLibheifJsRules,
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: globals.browser,
    },
  },
);
