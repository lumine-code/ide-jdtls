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

const javaMajorVersion = (command, signal) =>
  new Promise((resolve, reject) => {
    childProcess.execFile(
      command,
      ["-version"],
      { windowsHide: true, timeout: 10000, signal },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`Could not run Java: ${error.message}`));
        const match = `${stderr}\n${stdout}`.match(/version\s+"(\d+)(?:\.(\d+))?/);
        if (!match) return reject(new Error("Could not determine the Java runtime version."));
        resolve(Number(match[1] === "1" ? match[2] : match[1]));
      },
    );
  });

const validateJava = async (command, { signal } = {}) => {
  if (!path.isAbsolute(command)) throw new Error("Java Path must be an absolute executable path.");
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command))
    throw new Error("Java Path must name java.exe, not a shell wrapper.");
  if (!(await fs.promises.stat(command)).isFile())
    throw new Error("Java Path must name a Java executable, not a directory.");
  await fs.promises.access(command, fs.constants.X_OK);
  const major = await exports.javaMajorVersion(command, signal);
  if (major < 21) throw new Error(`Eclipse JDT LS requires Java 21 or newer; found Java ${major}.`);
  return { major };
};

const resolveJava = async (context, configuredPath = "", env = process.env) => {
  const executable = process.platform === "win32" ? "java.exe" : "java";
  return context.resolver.select({
    configuredPath,
    kind: "executable",
    label: "Java executable",
    candidates: () =>
      [env.JDK_HOME, env.JAVA_HOME]
        .filter(Boolean)
        .map((home) => path.join(home, "bin", executable)),
    names: ["java"],
    env,
    signal: context.signal,
    validate: exports.validateJava,
  });
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

const systemDirectories = (context, env = process.env, platform = process.platform) => {
  const wrapper = context.resolver.findExecutables("jdtls", { env, platform })[0];
  return [
    env.JDTLS_HOME,
    wrapper ? path.dirname(path.dirname(fs.realpathSync(wrapper))) : null,
    ...(platform === "linux" ? ["/usr/share/java/jdtls", "/usr/share/jdtls"] : []),
    ...(platform === "darwin"
      ? ["/opt/homebrew/opt/jdtls/libexec", "/usr/local/opt/jdtls/libexec"]
      : []),
  ].filter(Boolean);
};

const resolveDirectory = async (context, configured = "", env = process.env) =>
  context.resolver.select({
    configuredPath: configured,
    managed: () => {
      const installed = context.getManagedServer();
      return installed
        ? { path: path.dirname(path.dirname(installed.modulePath)), version: installed.version }
        : null;
    },
    kind: "directory",
    candidates: () => systemDirectories(context, env),
    signal: context.signal,
    validate: (directory) => distribution(directory),
  });

const cachePaths = (configDirPath, rootPath, token = windowToken) => {
  const project = crypto
    .createHash("sha256")
    .update(path.resolve(rootPath))
    .digest("hex")
    .slice(0, 24);
  const directory = path.join(configDirPath, "language-server-caches", "ide-jdtls", token, project);
  return {
    configuration: path.join(directory, "configuration"),
    data: path.join(directory, "data"),
  };
};

const resolveServer = async (
  context,
  { serverDirectory, javaPath, maxHeap, env = process.env } = {},
) => {
  const directory = await resolveDirectory(context, serverDirectory, env);
  const runtime = await resolveJava(context, javaPath, env);
  if (!directory || !runtime) return null;
  const { launcher, sharedConfiguration } = directory.data;
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
  if (runtime.data.major >= 24)
    args.unshift("-Djdk.xml.maxGeneralEntitySizeLimit=0", "-Djdk.xml.totalEntitySizeLimit=0");
  return context.resolver.launch(runtime, {
    signal: context.signal,
    args,
    cwd: context.rootPath,
    transport: "stdio",
    version: directory.version,
    // Explicitly select stdio despite shell environments left by other clients.
    env: {
      CLIENT_PORT: undefined,
      CLIENT_HOST: undefined,
      CLIENT_PIPE: undefined,
      SERVER_PORT: undefined,
      SERVER_HOST: undefined,
      SERVER_PIPE: undefined,
    },
  });
};

const fetchText = async (url, { signal: callerSignal } = {}) => {
  callerSignal?.throwIfAborted();
  const timeout = AbortSignal.timeout(30000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const response = await fetch(url, { signal });
    signal.throwIfAborted();
    if (!response.ok) throw new Error(`Eclipse downloads answered ${response.status} for ${url}.`);
    const text = await response.text();
    signal.throwIfAborted();
    return text;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
};
const stableVersion = (value) => {
  const version = String(value).replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`Choose a stable JDT LS milestone, not '${value}'.`);
  return version;
};
const latestServerVersion = async ({ signal } = {}) => {
  signal?.throwIfAborted();
  const index = await exports.fetchText(MILESTONES, { signal });
  signal?.throwIfAborted();
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
const installServer = async ({ storagePath, version, api, signal: callerSignal }) => {
  const signal =
    callerSignal && api.signal
      ? AbortSignal.any([callerSignal, api.signal])
      : callerSignal || api.signal;
  signal?.throwIfAborted();
  if (!CONFIGURATIONS[`${process.platform}-${process.arch}`])
    throw new Error(
      `Eclipse JDT LS has no supported configuration for ${process.platform}-${process.arch}.`,
    );
  const selected = stableVersion(version || (await latestServerVersion({ signal })));
  signal?.throwIfAborted();
  const base = `${MILESTONES}${selected}/`;
  const archiveText = await exports.fetchText(`${base}latest.txt`, { signal });
  signal?.throwIfAborted();
  const archive = archiveText.trim();
  if (
    !new RegExp(`^jdt-language-server-${selected.replaceAll(".", "\\.")}-\\d{12}\\.tar\\.gz$`).test(
      archive,
    )
  )
    throw new Error("Eclipse returned an unexpected JDT LS archive name.");
  const checksumText = await exports.fetchText(`${base}${archive}.sha256`, { signal });
  signal?.throwIfAborted();
  const checksum = checksumText.trim().split(/\s/)[0];
  if (!/^[0-9a-f]{64}$/i.test(checksum))
    throw new Error("Eclipse did not publish a valid SHA256 checksum.");
  api.setServerInstallationStatus("downloading");
  signal?.throwIfAborted();
  await api.downloadFile(`${base}${archive}`, storagePath, {
    type: "gzip-tar",
    digest: `sha256:${checksum}`,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  const { launcher } = await distribution(storagePath);
  signal?.throwIfAborted();
  return {
    version: selected,
    module: path.relative(storagePath, launcher),
    checksum: `sha256:${checksum}`,
    archive,
  };
};

Object.assign(exports, {
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
