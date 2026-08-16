#!/usr/bin/env node
/**
 * translation-verifier CLI 入口。
 * 用法示例:
 *   npx tsx src/cli.ts --description description.json --source fixtures/code-corpus/xxx --target fixtures/target-system/xxx
 * 可选参数见 cli-helpers.ts 的 CliOptions / parseCliArgs。
 */
import { runCli } from "./cli-helpers.js";

const exitCode = await runCli(process.argv.slice(2));
process.exitCode = exitCode;
