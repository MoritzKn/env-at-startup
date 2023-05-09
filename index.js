const fs = require("fs/promise");

let args = null;
let allowList = [];

function printHelp() {
  console.log("");
  console.log("Usage ./env-at-startup [options] <file>...");
  console.log("");
  console.log("Options:");
  console.log("  --help              Show this screen.");
  console.log("  -v --verbose        Show all replacements.");
  console.log(
    "  --vars           Only replace these vars. Comma separated list, wildcards (*) allowed."
  );
  console.log("  --no-progress       Do not display file by file progress.");
  console.log("  --allow-missing     Missing env vars are set to undefined.");
  console.log(
    "  --allow-unreplaced  If process.env.ANY can not be replaced, it is ignored"
  );
  console.log("  --rollback          Rollback all replacements.");
  console.log("");
  console.log("Examples:");
  console.log("  ./env-at-startup dist/**.js --vars 'API_URL,NEXT_PUBLIC_*'");
  console.log("  ./env-at-startup dist/**.js --rollback");
  console.log("");
}

function parseArgs(argv) {
  const [node, script, ...args] = argv;

  let files = [];
  let flags = {
    progress: true,
  };
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
        case "--no-progress":
          flags.progress = false;
          break;
        case "--allow-missing":
          flags.allowMissing = true;
          break;
        case "--allow-unreplaced":
          flags.allowUnreplaced = true;
          break;
        case "--rollback":
          flags.rollback = true;
          break;
        case "-v":
        case "--verbose":
          flags.verbose = true;
          break;
        default:
          console.warn("Unknown flag:", arg);
          process.exit(1);
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
  let col = 0;
  let line = 0;
  for (let index = 0; index < Math.min(string.length, offset); index++) {
    const char = string[index];
    if (char == "\n") {
      line += 1;
      col = 0;
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
          throw new Error(`'${varName}' is not set.`);
        }
      } else if (args.flags.allowUnreplaced) {
        console.warn("Skipping", matchStr, "in", filePath);
        return matchStr;
      }

      throw new Error(`'${matchStr}' missing in --vars`);
    }
  );

  if (newContent === content) {
    return "UNTOUCHED";
  }

  if (args.flags.verbose) {
    console.log(filePath);
    changes.forEach((change) => {
      const { line, col } = getPosInFile(content, change.offset);
      console.log(`${line}:${col}`, change.matchStr, "->", change.replacement);
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
      throw new Error("Not a file " + backupPath);
    }
  } catch (error) {
    return "NOBAK";
  }

  const contentBuffer = await fs.readFile(filePath + ".envs");
  await fs.writeFile(filePath, contentBuffer);
  await fs.rm(filePath + ".envs");

  return "ROLLEDBACK";
}

function printUpdate(file, result) {
  if (result instanceof Error) {
    console.log(" -", file, "FAILED");
  } else {
    if (result === "UNTOUCHED" || result === "NOBAK") {
      // Skip
    } else if (typeof result === "string") {
      console.log(" -", file, result);
    } else if (typeof result === "object") {
      if (!args.flags.verbose) {
        console.log(" -", file, "REPLACED", result.count);
      } else {
        // Replacements are already logged
      }
    } else {
      console.log(" -", file, "DONE");
    }
  }
}

async function runAll(list, func) {
  const errors = [];
  const done = [];
  const proms = list.map(func).map((prom, index) =>
    prom
      .then((result) => {
        if (args.flags.progress) printUpdate(args.files[index], result);
        done.push({ index, result });
        return result;
      })
      .catch((error) => {
        if (args.flags.progress) printUpdate(args.files[index], error);
        errors.push({ index, error });
      })
  );

  const results = await Promise.all(proms);

  return { errors, done, results };
}

function printErrors(errors) {
  if (!args.flags.progress) {
    console.error("Failed files:");
    errors.forEach(({ index, error }) => {
      console.error(" -", args.files[index], `(${error.message})`);
    });
    console.error();
  }

  console.error("The first error was:");
  console.error(errors[0].error);
}

async function main() {
  args = parseArgs(process.argv);
  allowList = parseAllowList(args.flags.vars);

  if (args.flags.rollback) {
    const { errors, results } = await runAll(args.files, (file) =>
      rollback(file)
    );
    if (args.flags.progress) console.log();

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
        console.log(" -", k, `x${v}`);
      });
      process.exit(0);
    }
  }

  const { errors, results } = await runAll(args.files, (file) =>
    execSubstitution(file)
  );
  if (args.flags.progress) console.log();

  if (errors.length > 0) {
    console.error(
      `Substitution failed on ${errors.length}/${args.files.length} files`
    );
    const replaced = results.filter((res) => typeof res === "object");
    if (replaced.length > 0) {
      console.log("");
      console.log(
        `IMPORTANT: Some files where still updated. Run with --rollback to undo changes on ${replaced.length} files.`
      );
    }
    console.error();
    printErrors(errors);
    process.exit(1);
  } else {
    console.log(`Finished substitution on ${args.files.length} files`);
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
  console.error("Uncaught async error");
  console.error();
  console.error(error);
  process.exit(1);
});
