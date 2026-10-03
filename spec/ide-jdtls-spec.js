const fs = require("node:fs");
const path = require("node:path");
const { createProject, removeProject } = require("./helpers/project");

const fakeDistribution = (directory) => {
  fs.mkdirSync(path.join(directory, "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "plugins", "org.eclipse.equinox.launcher_1.jar"),
    "launcher",
  );
  for (const config of [
    "config_win",
    "config_linux",
    "config_linux_arm",
    "config_mac",
    "config_mac_arm",
  ]) {
    fs.mkdirSync(path.join(directory, config));
    fs.writeFileSync(path.join(directory, config, "config.ini"), "config");
  }
};

describe("ide-jdtls server discovery and installation", () => {
  let fixture, server;
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    await lumine.packages.activatePackage("ide-jdtls");
    server = require("../lib/server");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-jdtls");
    removeProject(fixture.rootPath);
  });
  it("requires a supported runtime and validates explicit selections before switching", async () => {
    spyOn(server, "javaMajorVersion").and.resolveTo(21);
    expect(await server.resolveJava(process.execPath, { PATH: "" })).toBe(process.execPath);
    await expectAsync(server.resolveJava(fixture.rootPath)).toBeRejected();
    await expectAsync(server.resolveJava("relative/java")).toBeRejectedWithError(/absolute/);
    server.javaMajorVersion.and.resolveTo(17);
    await expectAsync(server.resolveJava(process.execPath)).toBeRejectedWithError(/Java 21/);
    expect(await server.resolveJava("", { PATH: "" })).toBeNull();
  });
  it("finds native PATH files and skips directories", () => {
    expect(
      server.findOnPath(path.basename(process.execPath, path.extname(process.execPath)), {
        PATH: path.dirname(process.execPath),
      }),
    ).toBeTruthy();
    fs.mkdirSync(path.join(fixture.rootPath, "java"));
    expect(server.findOnPath("java", { PATH: fixture.rootPath })).toBeNull();
  });
  it("continues past an older Java on PATH to a supported runtime", async () => {
    const oldDirectory = path.join(fixture.rootPath, "old"),
      newDirectory = path.join(fixture.rootPath, "new");
    const name = process.platform === "win32" ? "java.exe" : "java";
    for (const directory of [oldDirectory, newDirectory]) {
      fs.mkdirSync(directory);
      fs.copyFileSync(process.execPath, path.join(directory, name));
    }
    spyOn(server, "javaMajorVersion").and.callFake(async (command) =>
      command.startsWith(oldDirectory) ? 17 : 21,
    );
    expect(
      await server.resolveJava("", { PATH: `${oldDirectory}${path.delimiter}${newDirectory}` }),
    ).toBe(path.join(newDirectory, name));
  });
  it("prefers an explicit distribution, then managed, then JDTLS_HOME", async () => {
    const explicit = path.join(fixture.rootPath, "explicit"),
      managed = path.join(fixture.rootPath, "managed"),
      system = path.join(fixture.rootPath, "system");
    for (const directory of [explicit, managed, system]) fakeDistribution(directory);
    const installed = {
      modulePath: path.join(managed, "plugins", "org.eclipse.equinox.launcher_1.jar"),
    };
    expect(await server.resolveDirectory(explicit, installed, { JDTLS_HOME: system })).toBe(
      explicit,
    );
    expect(await server.resolveDirectory("", installed, { JDTLS_HOME: system })).toBe(managed);
    expect(await server.resolveDirectory("", null, { JDTLS_HOME: system, PATH: "" })).toBe(system);
    await expectAsync(
      server.resolveDirectory(path.join(fixture.rootPath, "missing"), installed),
    ).toBeRejected();
  });
  it("selects the published configuration for every supported architecture", async () => {
    fakeDistribution(fixture.configDirPath);
    for (const [platform, arch, expected] of [
      ["win32", "x64", "config_win"],
      ["linux", "x64", "config_linux"],
      ["linux", "arm64", "config_linux_arm"],
      ["darwin", "x64", "config_mac"],
      ["darwin", "arm64", "config_mac_arm"],
    ])
      expect(
        (await server.distribution(fixture.configDirPath, platform, arch)).sharedConfiguration,
      ).toBe(path.join(fixture.configDirPath, expected));
    await expectAsync(
      server.distribution(fixture.configDirPath, "win32", "arm64"),
    ).toBeRejectedWithError(/no supported configuration/);
  });
  it("isolates project and window locks while keeping restarts on the same caches", () => {
    const first = server.cachePaths(fixture.configDirPath, fixture.rootPath, "window-a");
    expect(server.cachePaths(fixture.configDirPath, fixture.rootPath, "window-a")).toEqual(first);
    expect(server.cachePaths(fixture.configDirPath, fixture.rootPath, "window-b").data).not.toBe(
      first.data,
    );
    expect(
      server.cachePaths(fixture.configDirPath, path.join(fixture.rootPath, "other"), "window-a")
        .data,
    ).not.toBe(first.data);
    expect(first.data.startsWith(fixture.rootPath)).toBe(false);
  });
  it("launches the JAR with read-only shared configuration and removes inherited socket variables", async () => {
    fakeDistribution(fixture.configDirPath);
    spyOn(server, "javaMajorVersion").and.resolveTo(25);
    const launch = await server.resolveServer({
      serverDirectory: fixture.configDirPath,
      javaPath: process.execPath,
      maxHeap: 512,
      context: fixture,
    });
    expect(launch.command).toBe(process.execPath);
    expect(launch.transport).toBe("stdio");
    expect(launch.args).toContain("-Xmx512m");
    expect(launch.args).toContain("-Dosgi.sharedConfiguration.area.readOnly=true");
    expect(launch.args).toContain("-Djdk.xml.totalEntitySizeLimit=0");
    expect(Object.hasOwn(launch.env, "CLIENT_PORT")).toBe(true);
    expect(launch.env.CLIENT_PORT).toBeUndefined();
  });
  it("selects the latest stable milestone numerically", async () => {
    spyOn(server, "fetchText").and.resolveTo(
      '<a href="/jdtls/milestones/1.9.0">old</a><a href="/jdtls/milestones/1.61.0">new</a><a href="snapshots">preview</a>',
    );
    expect(await server.latestServerVersion()).toBe("1.61.0");
    expect(() => server.stableVersion("1.62.0-SNAPSHOT")).toThrowError(/stable/);
  });
  it("requires the official digest and preserves the complete distribution tree", async () => {
    const archive = "jdt-language-server-1.61.0-202609031315.tar.gz",
      checksum = "a".repeat(64);
    spyOn(server, "fetchText").and.callFake(async (url) =>
      url.endsWith("latest.txt") ? archive : checksum,
    );
    const downloadFile = jasmine
      .createSpy("downloadFile")
      .and.callFake(async (_url, directory) => fakeDistribution(directory));
    const installed = await server.installServer({
      storagePath: fixture.configDirPath,
      version: "1.61.0",
      api: { downloadFile, setServerInstallationStatus() {} },
    });
    expect(downloadFile.calls.mostRecent().args[2]).toEqual({
      type: "gzip-tar",
      digest: `sha256:${checksum}`,
    });
    expect(installed.module).toBe(path.join("plugins", "org.eclipse.equinox.launcher_1.jar"));
    expect(fs.existsSync(path.join(fixture.configDirPath, "config_linux_arm", "config.ini"))).toBe(
      true,
    );
  });
  it("refuses unexpected archive names and absent checksums before downloading", async () => {
    spyOn(server, "fetchText").and.resolveTo("../malicious.tar.gz");
    const api = {
      downloadFile: jasmine.createSpy("downloadFile"),
      setServerInstallationStatus() {},
    };
    await expectAsync(
      server.installServer({ storagePath: fixture.configDirPath, version: "1.61.0", api }),
    ).toBeRejectedWithError(/archive name/);
    server.fetchText.and.callFake(async (url) =>
      url.endsWith("latest.txt") ? "jdt-language-server-1.61.0-202609031315.tar.gz" : "missing",
    );
    await expectAsync(
      server.installServer({ storagePath: fixture.configDirPath, version: "1.61.0", api }),
    ).toBeRejectedWithError(/SHA256/);
    expect(api.downloadFile).not.toHaveBeenCalled();
  });
});

describe("ide-jdtls service edges and settings", () => {
  let main, adapter, edge, cleanup;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("ide-jdtls")).mainModule;
    cleanup = jasmine.createSpy("cleanup");
    edge = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose: cleanup };
      },
    });
  });
  afterEach(async () => {
    edge.dispose();
    for (const key of [
      "parameterHints",
      "buildConfigurationUpdates",
      "formatterProfileUrl",
      "formatterProfile",
    ])
      lumine.config.unset(`ide-jdtls.${key}`);
    await lumine.packages.deactivatePackage("ide-jdtls");
  });
  it("registers only Java and leaves unsupported client lenses unavailable", () => {
    expect(adapter.grammarScopes).toEqual(["source.java"]);
    expect(adapter.isFeatureAvailable("codeLens")).toBe(false);
    expect(require("../package.json").configSchema.features.properties.codeLens).toBeUndefined();
    expect(main.provideBackgroundTips().packageName).toBe("ide-jdtls");
    edge.dispose();
    expect(cleanup).toHaveBeenCalled();
  });
  it("preserves build defaults while enabling standard signature help", () => {
    expect(adapter.getSettings()).toEqual({
      java: {
        signatureHelp: { enabled: true },
        referencesCodeLens: { enabled: false },
        implementationCodeLens: "none",
        format: { onType: { enabled: true } },
      },
    });
    expect(adapter.getWorkspaceConfiguration("java.configuration")).toBeUndefined();
    expect(
      adapter.getInitializationOptions().extendedClientCapabilities.classFileContentsSupport,
    ).toBe(false);
  });
  it("sends supported overrides as Java settings", () => {
    lumine.config.set("ide-jdtls.parameterHints", "all");
    lumine.config.set("ide-jdtls.buildConfigurationUpdates", "automatic");
    lumine.config.set("ide-jdtls.formatterProfileUrl", "https://example.com/formatter.xml");
    lumine.config.set("ide-jdtls.formatterProfile", "Team");
    expect(adapter.getWorkspaceConfiguration("java.inlayHints.parameterNames.enabled")).toBe("all");
    expect(adapter.getWorkspaceConfiguration("java.configuration.updateBuildConfiguration")).toBe(
      "automatic",
    );
    expect(adapter.getWorkspaceConfiguration("java.format.settings")).toEqual({
      url: "https://example.com/formatter.xml",
      profile: "Team",
    });
    expect(adapter.getWorkspaceConfiguration("unrelated")).toBeUndefined();
  });
  it("cleans up provider edges independently and reacquires the generation after reload", async () => {
    const secondCleanup = jasmine.createSpy("secondCleanup");
    const second = main.consumeIdeClient({
      registerAdapter() {
        return { dispose: secondCleanup };
      },
    });
    edge.dispose();
    expect(secondCleanup).not.toHaveBeenCalled();
    second.dispose();
    const packagePath = lumine.packages.getActivePackage("ide-jdtls").path;
    await lumine.packages.deactivatePackage("ide-jdtls");
    await lumine.packages.unloadPackage("ide-jdtls");
    await lumine.packages.loadPackage(packagePath);
    const current = (await lumine.packages.activatePackage("ide-jdtls")).mainModule;
    expect(current).not.toBe(main);
    expect(current.provideBackgroundTips().packageName).toBe("ide-jdtls");
  });
  it("reports missing dependencies through the hub", async () => {
    spyOn(require("../lib/server"), "resolveServer").and.resolveTo(null);
    const missing = jasmine.createSpy("missing");
    let registered;
    const registration = main.consumeIdeClient({
      registerAdapter(value) {
        registered = value;
        return { dispose() {} };
      },
      reportMissingServer: missing,
    });
    try {
      expect(await registered.resolveServer({ rootPath: "/project" })).toBeNull();
      expect(missing.calls.mostRecent().args[0]).toBe("ide-jdtls");
    } finally {
      registration.dispose();
    }
  });
});
