// ESLint flat config — repo-wide quality gate (root fetcher, packages, backend).
//
// Enforces the architecture rules documented in AGENTS.md ("Architecture Rules" /
// "Shared Package Boundaries"):
//   shared-config ← shared-contracts ← aave-fetcher ← root/backend
//   shared-contracts ← aave-rpc-infra ← backend
// plus "No root dist imports".
//
// Two rules run at "warn" with a --max-warnings ratchet (see the `lint` script):
//   - complexity            (41 legacy functions above the max of 20)
//   - @typescript-eslint/no-unused-vars (legacy unused bindings/imports)
// The ratchet must never increase; drive it down over time, never up.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

// All first-party TS source and tests across every application in the monorepo.
const TS_GLOBS = [
  "src/**/*.ts",
  "tests/**/*.ts",
  "repro-consumer.ts",
  "scripts/**/*.ts",
  "scripts/**/*.mts",
  "packages/*/src/**/*.ts",
  "packages/*/tests/**/*.ts",
  "backend/src/**/*.ts",
  "backend/tests/**/*.ts",
  "backend/scripts/**/*.ts",
];

// Plain Node.js scripts (no TS type info available).
const JS_GLOBS = ["**/*.js", "**/*.mjs", "**/*.cjs"];

const DIST_PATTERN = {
  group: ["**/dist", "**/dist/**"],
  message:
    "Runtime code must not import compiled dist/ output (AGENTS.md: no root dist imports).",
};

// Dependency-direction rules per package (src is stricter than tests: tests may
// import their own package's compiled dist, matching the @internal/* convention
// whose package entry also resolves to dist).
const NO_FETCHER = {
  group: ["@internal/aave-fetcher", "@internal/aave-fetcher/*"],
  message:
    "This package must not depend on aave-fetcher (it sits above it in the dependency direction).",
};
const NO_RPC_INFRA = {
  group: ["@internal/aave-rpc-infra", "@internal/aave-rpc-infra/*"],
  message:
    "This package must not depend on aave-rpc-infra (it sits above it in the dependency direction).",
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      // Generated artifacts — do not hand-edit, lint noise only.
      "src/generated/**",
      "packages/*/src/generated/**",
      "backend/src/generated/**",
      // Large ABI JSON/data exports, not hand-written logic.
      "backend/src/abis/**",
      // Scratch/research area (gitignored or repro-only).
      "repro-src/**",
      "repro-dist/**",
      "packages/aave-fetcher/scripts/**",
      // Agent/tool scratch dirs (untracked or tool-managed).
      ".codeartsdoer/**",
      ".playwright-cli/**",
      ".cursor/**",
      ".opencode/**",
      ".trae/**",
      ".claude/**",
      ".agents/**",
      ".amp/**",
      ".arts/**",
      ".impeccable/**",
      ".codex/**",
      ".husky/**",
      ".worktrees/**",
    ],
  },

  // Base recommendations for every linted file (JS and TS).
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Node.js built-ins for plain JS scripts (TS files get no-undef disabled via
  // tseslint's eslint-recommended overrides).
  {
    files: JS_GLOBS,
    languageOptions: { globals: { ...globals.node, ...globals.commonjs } },
  },

  {
    files: TS_GLOBS,
    plugins: { import: importPlugin },
    languageOptions: {
      parserOptions: { sourceType: "module" },
    },
    rules: {
      // ── Naming consistency ────────────────────────────────────────────────
      // Properties are exempt: API payloads (Merkl/Merit/CoinGecko) use
      // snake_case and object shapes must mirror external contracts. Imports
      // may be PascalCase/UPPER_CASE for external namespace symbols
      // (e.g. AaveAddressBook). Leading underscores are an accepted
      // "internal/test-hook" convention (single or double).
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "default",
          format: ["camelCase"],
          leadingUnderscore: "allowSingleOrDouble",
        },
        {
          selector: "variable",
          format: ["camelCase", "UPPER_CASE", "PascalCase"],
          leadingUnderscore: "allowSingleOrDouble",
        },
        {
          selector: "parameter",
          format: ["camelCase"],
          leadingUnderscore: "allowSingleOrDouble",
        },
        {
          selector: "function",
          format: ["camelCase", "PascalCase"],
          leadingUnderscore: "allowSingleOrDouble",
        },
        {
          selector: "method",
          format: ["camelCase"],
          leadingUnderscore: "allowSingleOrDouble",
        },
        {
          selector: "typeLike",
          format: ["PascalCase"],
          leadingUnderscore: "allowSingleOrDouble",
        },
        { selector: "enumMember", format: ["PascalCase", "UPPER_CASE"] },
        {
          selector: "import",
          format: ["camelCase", "PascalCase", "UPPER_CASE"],
        },
        { selector: "property", format: null },
      ],

      // ── Cyclomatic complexity (ratcheted — see header) ────────────────────
      complexity: ["warn", { max: 20, variant: "classic" }],

      // ── Untyped external payloads (ratcheted — see header) ────────────────
      // Incentive APIs (Merkl/Merit/Brevis) and on-chain ABI decodes are
      // untyped by nature; `any` is endemic in legacy adapters. Warned and
      // ratcheted so new code is pushed toward proper types.
      "@typescript-eslint/no-explicit-any": "warn",

      // ── Unused code (ratcheted — see header) ──────────────────────────────
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],

      // ── Workspace boundaries (relative imports) ───────────────────────────
      // packages/* must not reach into root src, backend, or any dist.
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: ["./src", "./backend"],
              from: "./packages",
              message:
                "packages must not import the root CLI or backend (dependency direction: AGENTS.md)",
            },
            {
              target: "./backend/src",
              from: "./src",
              message:
                "backend must not import root CLI sources; use @internal/* packages",
            },
            {
              target: "./backend",
              from: "./packages",
              message:
                "backend must consume packages via @internal/* workspace deps, not relative paths into packages/",
            },
          ],
        },
      ],

      // ── Workspace boundaries (workspace-package imports) ──────────────────
      // Enforced via @typescript-eslint/no-restricted-imports because
      // @internal/* resolution is not visible to the default import resolver.
      // Test files may import their own package's dist (see overrides below).
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [DIST_PATTERN] },
      ],
    },
  },

  // Per-package dependency direction — src files (no dist imports at all).
  {
    files: ["packages/aave-shared-contracts/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [DIST_PATTERN, NO_FETCHER, NO_RPC_INFRA] },
      ],
    },
  },
  {
    files: ["packages/aave-rpc-infra/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [DIST_PATTERN, NO_FETCHER] },
      ],
    },
  },

  // Per-package dependency direction — tests (own-package dist allowed, per the
  // @internal/* convention whose package entry resolves to dist).
  {
    files: ["packages/aave-shared-contracts/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [NO_FETCHER, NO_RPC_INFRA] },
      ],
    },
  },
  {
    files: ["packages/aave-rpc-infra/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [NO_FETCHER] },
      ],
    },
  },

  // shared-config ships raw .js with zero internal dependencies.
  {
    files: ["packages/aave-shared-config/**/*.js"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@internal/*"],
              message:
                "aave-shared-config is a leaf package with no @internal dependencies.",
            },
          ],
        },
      ],
    },
  },

  // Formula-mirroring verification script: identifiers intentionally follow
  // Aave's rate-formula notation (D, L, S, *_pct) so results can be checked
  // against the protocol docs. Naming rules are relaxed for this file only.
  {
    files: ["scripts/verification/v4-sdk-calculations.ts"],
    rules: { "@typescript-eslint/naming-convention": "off" },
  }
);
