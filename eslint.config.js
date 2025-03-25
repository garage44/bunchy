import {defineConfig} from "eslint/config"
import config from "@garage44/eslint-config"

export default defineConfig([
	{
		files: ["**/*.js"],
		extends: [config],
	},
]);