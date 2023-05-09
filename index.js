#!/usr/bin/env node

const fs = require("fs").promises;

let args = null;
let allowList = [];

class ReplaceError extends Error {}

function printHelp() {
  console.log(`
Usage ./env-at-startup <file>... [options]

Options:
  --help           Show this screen.
  -v --verbose     Show all replacements.
  --vars           Only replace these vars. Comma separated list, wildcards (*) allowed.
  --ignore-other   When using --vars, all other vars are ignored (by default we error out).
  --allow-missing  Missing env vars are set to undefined (by default we error out).
  --rollback       Rollback all replacements.
  --debug          Show debug logs

Examples:
  ./env-at-startup dist/*.js --vars 'API_URL,NEXT_PUBLIC_*'
  ./env-at-startup dist/*.js --rollback

Use 'find' to access files recursively:
./env-at-startup $(find . -name "*.js")
`);
}

function parseArgs(argv) {
  const [node, script, ...args] = argv;

  let files = [];
  let flags = {};
  let currentFlag = null;

  args.forEach((arg) => {
    if (currentFlag) {
      flags[currentFlag] = arg;
      currentFlag = null;
      return;
    }

    if (arg.startsWith("-")) {
      switch (arg) {
        case "--help":
          printHelp();
          process.exit(0);
        case "--vars":
          currentFlag = "vars";
          break;
        case "--ignore-other":
          flags.ignoreOther = true;
          break;
        case "--allow-missing":
          flags.allowMissing = true;
          break;
        case "--rollback":
          flags.rollback = true;
          break;
        case "-v":
        case "--verbose":
          flags.verbose = true;
          break;
        case "--debug":
          flags.debug = true;
          break;
        default:
          console.error("Unknown flag:", arg);
          process.exit(1);
          break;
      }
    } else {
      files.push(arg);
    }
  });

  return {
    files,
    flags,
  };
}

function parseAllowList(flagVars = "") {
  return flagVars
    .split(",")
    .filter(Boolean)
    .map((pattern) => {
      return new RegExp("^" + pattern.replace("*", ".*") + "$");
    });
}

function isAllowed(varName) {
  if (allowList.length === 0) {
    return true;
  }

  return allowList.some((regex) => regex.test(varName));
}

function getPosInFile(string, offset) {
  let line = 1;
  let col = 1;
  for (let index = 0; index < Math.min(string.length, offset); index++) {
    const char = string[index];
    if (char == "\n") {
      line += 1;
      col = 1;
      continue;
    }

    if (char == "\r") {
      // Ignore CRLF
      continue;
    }

    col += 1;
  }

  return { col, line };
}

async function execSubstitution(filePath) {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    return "SKIPPED";
  }

  const replacements = {};
  let count = 0;
  const contentBuffer = await fs.readFile(filePath);
  const content = contentBuffer.toString("utf8");

  const changes = [];
  const newContent = content.replace(
    /\bprocess\.env\.([\w\d_]+)\b/g,
    (matchStr, varName, offset) => {
      replacements[varName] = replacements[varName] || 0;

      if (isAllowed(varName)) {
        if (process.env[varName]) {
          replacements[varName] = replacements[varName] + 1;
          count += 1;
          const replacement = JSON.stringify(process.env[varName]);
          changes.push({ matchStr, offset, replacement });
          return replacement;
        } else if (args.flags.allowMissing) {
          replacements[varName] = replacements[varName] + 1;
          count += 1;
          const replacement = "undefined";
          changes.push({ matchStr, offset, replacement });
          return replacement;
        } else {
          throw new ReplaceError(`'${varName}' is not set.`);
        }
      } else if (args.flags.ignoreOther) {
        if (args.flags.debug) {
          console.warn("Skipping", matchStr, "in", filePath);
        }
        return matchStr;
      }

      throw new ReplaceError(`'${matchStr}' missing in --vars`);
    }
  );

  if (newContent === content) {
    return "UNTOUCHED";
  }

  if (args.flags.verbose) {
    changes.forEach((change) => {
      const { line, col } = getPosInFile(content, change.offset);
      console.log(`${filePath}:${line}:${col}`);
      console.log(change.matchStr, "->", change.replacement);
    });
    console.log();
  }

  const backupPath = filePath + ".envs";
  await fs.writeFile(backupPath, contentBuffer);
  await fs.writeFile(filePath, newContent, "utf8");

  return { replacements, count };
}

async function rollback(filePath) {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) {
    return "SKIPPED";
  }

  const backupPath = filePath + ".envs";
  try {
    const statEnv = await fs.stat(backupPath);
    if (!statEnv.isFile()) {
      throw new ReplaceError("Not a file " + backupPath);
      return "NOT_A_FILE";
    }
  } catch (error) {
    return "NO_BAK";
  }

  const contentBuffer = await fs.readFile(filePath + ".envs");
  await fs.writeFile(filePath, contentBuffer);
  await fs.rm(filePath + ".envs");

  return "ROLLED_BACK";
}

function printUpdate(file, result) {
  if (result instanceof Error) {
    console.debug(" -", file, "FAILED");
  } else {
    if (typeof result === "string") {
      console.debug(" -", file, result);
    } else if (typeof result === "object") {
      console.debug(" -", file, "REPLACED", result.count);
    } else {
      console.debug(" -", file, "DONE");
    }
  }
}

async function runAll(list, func) {
  const errors = [];
  const done = [];
  const proms = list.map(func).map((prom, index) =>
    prom
      .then((result) => {
        if (args.flags.debug) printUpdate(list[index], result);
        done.push({ index, result });
        return result;
      })
      .catch((error) => {
        if (args.flags.debug) printUpdate(list[index], error);
        errors.push({ index, error });
      })
  );

  const results = await Promise.all(proms);

  return { errors, done, results };
}

function printErrors(errors) {
  console.error("Failed files:");
  errors.forEach(({ index, error }) => {
    console.error(" -", args.files[index], `(${error.message})`);
  });

  if (!(errors[0].error instanceof ReplaceError)) {
    console.error();
    console.error("The first error was:");
    console.error(errors[0].error);
  }
}

async function main() {
  args = parseArgs(process.argv);
  allowList = parseAllowList(args.flags.vars);

  if (args.flags.rollback) {
    const { errors, results } = await runAll(args.files, (file) =>
      rollback(file)
    );

    if (errors.length > 0) {
      console.error(
        `Rollback failed on ${errors.length}/${args.files.length} files`
      );
      console.error();
      printErrors(errors);
      process.exit(1);
    } else {
      console.log(`Finished rollback on ${args.files.length} files`);
      const stats = {};
      results.forEach((resCode) => {
        if (typeof resCode === "string") {
          stats[resCode] = (stats[resCode] || 0) + 1;
        }
      });
      Object.entries(stats).forEach(([k, v]) => {
        console.log(" -", k, `${v} times`);
      });
      process.exit(0);
    }
  }

  const { errors, results } = await runAll(args.files, (file) =>
    execSubstitution(file)
  );

  if (errors.length > 0) {
    console.error(
      `Substituting environment variables failed on ${errors.length}/${args.files.length} files`
    );
    const replaced = results.filter((res) => typeof res === "object");
    if (replaced.length > 0) {
      console.error("");
      console.error(
        `IMPORTANT: Some files where still updated. Run with --rollback to undo changes on ${replaced.length} files.`
      );
    }
    console.error();
    printErrors(errors);
    process.exit(1);
  } else {
    console.log(
      `Finished substituting environment variables in ${args.files.length} files`
    );
    const replacements = {};
    results.forEach((res) => {
      if (typeof res === "object") {
        Object.entries(res.replacements).forEach(([k, v]) => {
          replacements[k] = (replacements[k] || 0) + v;
        });
      }
    });
    Object.entries(replacements).forEach(([k, v]) => {
      console.log(" -", k, `replaced ${v} times`);
    });
    if (Object.values(replacements).length === 0) {
      console.log("No strings replaced");
    }
  }
}

main().catch((error) => {
  console.error("Uncaught async error:");
  console.error();
  console.error(error);
  process.exit(1);
});
