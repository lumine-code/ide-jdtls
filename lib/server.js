const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");

const MILESTONES = "https://download.eclipse.org/jdtls/milestones/";
const CONFIGURATIONS = {
  "win32-x64": "config_win",
  "linux-x64": "config_linux",
  "linux-arm64": "config_linux_arm",
  "darwin-x64": "config_mac",
  "darwin-arm64": "config_mac_arm",
};
// Each renderer has its own token; concurrent windows must never share an
// Eclipse workspace lock, even when both are editing the same project.
const windowToken = crypto.randomUUID();

const executablesOnPath = (name, env = process.env, platform = process.platform) => {
  const candidates = [];
  for (const directory of (env.PATH || env.Path || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of platform === "win32" ? ["", ".exe"] : [""]) {
      const candidate = path.join(directory, name + extension);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        candidates.push(candidate);
      } catch {
        // Try the next executable rather than accepting a directory or wrapper.
      }
    }
  }
  return candidates;
};
const findOnPath = (name, env = process.env, platform = process.platform) =>
  executablesOnPath(name, env, platform)[0] || null;

const javaMajorVersion = (command) =>
  new Promise((resolve, reject) => {
    childProcess.execFile(
      command,
      ["-version"],
      { windowsHide: true, timeout: 10000 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`Could not run Java: ${error.message}`));
        const match = `${stderr}\n${stdout}`.match(/version\s+"(\d+)(?:\.(\d+))?/);
        if (!match) return reject(new Error("Could not determine the Java runtime version."));
        resolve(Number(match[1] === "1" ? match[2] : match[1]));
      },
    );
  });

const validateJava = async (command) => {
  if (!path.isAbsolute(command)) throw new Error("Java Path must be an absolute executable path.");
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command))
    throw new Error("Java Path must name java.exe, not a shell wrapper.");
  if (!(await fs.promises.stat(command)).isFile())
    throw new Error("Java Path must name a Java executable, not a directory.");
  await fs.promises.access(command, fs.constants.X_OK);
  const major = await exports.javaMajorVersion(command);
  if (major < 21) throw new Error(`Eclipse JDT LS requires Java 21 or newer; found Java ${major}.`);
  return command;
};

const resolveJava = async (configuredPath = "", env = process.env) => {
  if (configuredPath) return validateJava(configuredPath);
  const executable = process.platform === "win32" ? "java.exe" : "java";
  const candidates = [
    ...[env.JDK_HOME, env.JAVA_HOME]
      .filter(Boolean)
      .map((home) => path.join(home, "bin", executable)),
    ...executablesOnPath("java", env),
  ];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      return await validateJava(candidate);
    } catch {
      // An old system JRE must not hide a supported JDK elsewhere on PATH.
    }
  }
  return null;
};

const distribution = async (directory, platform = process.platform, arch = process.arch) => {
  if (!path.isAbsolute(directory)) throw new Error("Server Directory must be an absolute path.");
  const configuration = CONFIGURATIONS[`${platform}-${arch}`];
  if (!configuration)
    throw new Error(`Eclipse JDT LS has no supported configuration for ${platform}-${arch}.`);
  const plugins = await fs.promises.readdir(path.join(directory, "plugins"));
  const launchers = plugins.filter(
    (name) =>
      /^org\.eclipse\.equinox\.launcher(?:_[^/]+)?\.jar$/.test(name) &&
      fs.statSync(path.join(directory, "plugins", name)).isFile(),
  );
  if (launchers.length !== 1)
    throw new Error("Server Directory must contain exactly one Equinox launcher JAR.");
  const sharedConfiguration = path.join(directory, configuration);
  await fs.promises.access(path.join(sharedConfiguration, "config.ini"));
  return { launcher: path.join(directory, "plugins", launchers[0]), sharedConfiguration };
};

const systemDirectories = (env = process.env, platform = process.platform) => {
  const wrapper = findOnPath("jdtls", env, platform);
  return [
    env.JDTLS_HOME,
    wrapper ? path.dirname(path.dirname(fs.realpathSync(wrapper))) : null,
    ...(platform === "linux" ? ["/usr/share/java/jdtls", "/usr/share/jdtls"] : []),
    ...(platform === "darwin"
      ? ["/opt/homebrew/opt/jdtls/libexec", "/usr/local/opt/jdtls/libexec"]
      : []),
  ].filter(Boolean);
};

const resolveDirectory = async (configured = "", managed = null, env = process.env) => {
  if (configured) {
    await distribution(configured);
    return configured;
  }
  if (managed?.modulePath) {
    const directory = path.dirname(path.dirname(managed.modulePath));
    await distribution(directory);
    return directory;
  }
  for (const directory of systemDirectories(env)) {
    try {
      await distribution(directory);
      return directory;
    } catch {
      // Keep looking for a complete installation.
    }
  }
  return null;
};

const cachePaths = (configDirPath, rootPath, token = windowToken) => {
  const project = crypto
    .createHash("sha256")
    .update(path.resolve(rootPath))
    .digest("hex")
    .slice(0, 24);
  const directory = path.join(configDirPath, "language-server-caches", "ide-java", token, project);
  return {
    configuration: path.join(directory, "configuration"),
    data: path.join(directory, "data"),
  };
};

const resolveServer = async ({
  serverDirectory,
  javaPath,
  maxHeap,
  context,
  env = process.env,
}) => {
  const directory = await resolveDirectory(serverDirectory, context.managedServer, env);
  const command = await resolveJava(javaPath, env);
  if (!directory || !command) return null;
  const { launcher, sharedConfiguration } = await distribution(directory);
  const caches = cachePaths(context.configDirPath, context.rootPath);
  await fs.promises.mkdir(caches.configuration, { recursive: true });
  await fs.promises.mkdir(caches.data, { recursive: true });
  const args = [
    "-Declipse.application=org.eclipse.jdt.ls.core.id1",
    "-Dosgi.bundles.defaultStartLevel=4",
    "-Declipse.product=org.eclipse.jdt.ls.core.product",
    "-Dosgi.checkConfiguration=true",
    `-Dosgi.sharedConfiguration.area=${sharedConfiguration}`,
    "-Dosgi.sharedConfiguration.area.readOnly=true",
    "-Dosgi.configuration.cascaded=true",
    `-Xmx${maxHeap || 1024}m`,
    "--add-modules=ALL-SYSTEM",
    "--add-opens",
    "java.base/java.util=ALL-UNNAMED",
    "--add-opens",
    "java.base/java.lang=ALL-UNNAMED",
    "-jar",
    launcher,
    "-configuration",
    caches.configuration,
    "-data",
    caches.data,
  ];
  if ((await exports.javaMajorVersion(command)) >= 24)
    args.unshift("-Djdk.xml.maxGeneralEntitySizeLimit=0", "-Djdk.xml.totalEntitySizeLimit=0");
  return {
    command,
    args,
    cwd: context.rootPath,
    transport: "stdio",
    version: serverDirectory ? undefined : context.managedServer?.version,
    // Explicitly select stdio despite shell environments left by other clients.
    env: {
      CLIENT_PORT: undefined,
      CLIENT_HOST: undefined,
      CLIENT_PIPE: undefined,
      SERVER_PORT: undefined,
      SERVER_HOST: undefined,
      SERVER_PIPE: undefined,
    },
  };
};

const fetchText = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Eclipse downloads answered ${response.status} for ${url}.`);
  return response.text();
};
const stableVersion = (value) => {
  const version = String(value).replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`Choose a stable JDT LS milestone, not '${value}'.`);
  return version;
};
const latestServerVersion = async () => {
  const index = await exports.fetchText(MILESTONES);
  const versions = [
    ...index.matchAll(/href=['"](?:\/jdtls\/milestones\/)?(\d+\.\d+\.\d+)\/?['"]/g),
  ].map((match) => match[1]);
  versions.sort((a, b) => {
    const first = a.split(".").map(Number),
      second = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (first[i] !== second[i]) return second[i] - first[i];
    return 0;
  });
  if (!versions.length) throw new Error("Eclipse did not list any stable JDT LS milestones.");
  return versions[0];
};
const installServer = async ({ storagePath, version, api }) => {
  if (!CONFIGURATIONS[`${process.platform}-${process.arch}`])
    throw new Error(
      `Eclipse JDT LS has no supported configuration for ${process.platform}-${process.arch}.`,
    );
  const selected = stableVersion(version || (await latestServerVersion()));
  const base = `${MILESTONES}${selected}/`;
  const archive = (await exports.fetchText(`${base}latest.txt`)).trim();
  if (
    !new RegExp(`^jdt-language-server-${selected.replaceAll(".", "\\.")}-\\d{12}\\.tar\\.gz$`).test(
      archive,
    )
  )
    throw new Error("Eclipse returned an unexpected JDT LS archive name.");
  const checksum = (await exports.fetchText(`${base}${archive}.sha256`)).trim().split(/\s/)[0];
  if (!/^[0-9a-f]{64}$/i.test(checksum))
    throw new Error("Eclipse did not publish a valid SHA256 checksum.");
  api.setServerInstallationStatus("downloading");
  await api.downloadFile(`${base}${archive}`, storagePath, {
    type: "gzip-tar",
    digest: `sha256:${checksum}`,
  });
  const { launcher } = await distribution(storagePath);
  return {
    version: selected,
    module: path.relative(storagePath, launcher),
    checksum: `sha256:${checksum}`,
    archive,
  };
};

Object.assign(exports, {
  findOnPath,
  executablesOnPath,
  javaMajorVersion,
  validateJava,
  resolveJava,
  distribution,
  systemDirectories,
  resolveDirectory,
  cachePaths,
  resolveServer,
  fetchText,
  stableVersion,
  latestServerVersion,
  installServer,
});
