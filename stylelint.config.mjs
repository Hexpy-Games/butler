export default {
  extends: ["stylelint-config-standard"],
  ignoreFiles: ["packages/butler-app/client/ui/dist/**/*.css"],
  rules: {
    "alpha-value-notation": null,
    "at-rule-empty-line-before": null,
    "color-function-alias-notation": null,
    "color-function-notation": null,
    "color-hex-length": null,
    "comment-empty-line-before": null,
    "custom-property-empty-line-before": null,
    "custom-property-pattern": [
      "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      {
        message: "Expected custom property names to use kebab-case",
      },
    ],
    "declaration-empty-line-before": null,
    "keyframes-name-pattern": null,
    "property-no-vendor-prefix": null,
    "rule-empty-line-before": null,
    "no-descending-specificity": null,
    "selector-class-pattern": [
      "^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|[a-z][A-Za-z0-9]*|system_event)$",
      {
        message:
          "Expected class selectors to use kebab-case or CSS-module camelCase",
      },
    ],
    "selector-pseudo-class-no-unknown": [
      true,
      {
        ignorePseudoClasses: ["global"],
      },
    ],
    "value-keyword-case": null,
  },
};
