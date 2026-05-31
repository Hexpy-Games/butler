import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "data/**",
      "node_modules/**",
      "src/**/node_modules/**",
      "packages/butler-app/client/ui/dist/**",
      "bun.lock",
      "*.lockb",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,cjs,mjs,ts,tsx}"],
    plugins: {
      "@stylistic": stylistic,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.bun,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-empty": ["error", { "allowEmptyCatch": true }],
      "no-undef": "off",
      "no-useless-assignment": "warn",
      "no-useless-escape": "warn",
      "prefer-const": "warn",
      "@stylistic/semi": ["warn", "always"],
      "@stylistic/quotes": ["warn", "double", { avoidEscape: true }],
      "@stylistic/comma-dangle": ["warn", "always-multiline"],
      "@stylistic/object-curly-spacing": ["warn", "always"],
      "@stylistic/comma-spacing": ["warn", { before: false, after: true }],
    },
  },
);
