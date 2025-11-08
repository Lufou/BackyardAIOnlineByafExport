import { defineConfig } from "eslint/config";
import globals from "globals";
import js from "@eslint/js";

export default defineConfig([
	{ files: ["**/*.js"], languageOptions: { sourceType: "commonjs", globals: globals.node } },
	{ files: ["**/*.js"], plugins: { js }, extends: ["js/recommended"] },
]);
