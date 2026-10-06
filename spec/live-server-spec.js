const path = require("node:path");
const fs = require("node:fs");
const { LiveLspClient } = require("./helpers/live-lsp-client");
const { createProject, removeProject } = require("./helpers/project");
const { exerciseServer } = require("./helpers/exercise-server");

const serverDirectory = process.env.JDTLS_HOME;
const javaPath =
  process.env.JAVA_LSP_PATH ||
  (process.env.JAVA_HOME &&
    path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java"));
if (process.env.REQUIRE_JDTLS && (!serverDirectory || !javaPath))
  throw new Error("CI requires a real JDT LS distribution and Java runtime.");
const liveSuite = serverDirectory && javaPath ? describe : () => {};

liveSuite("ide-jdtls real JDT LS protocol", () => {
  let fixture, client, adapter, edge, timeout;
  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 180000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    const main = (await lumine.packages.activatePackage("ide-jdtls")).mainModule;
    lumine.config.set("ide-jdtls.serverDirectory", serverDirectory);
    lumine.config.set("ide-jdtls.javaPath", javaPath);
    lumine.config.set("ide-jdtls.parameterHints", "all");
    edge = main.consumeIde({
      registerAdapter(value) {
        adapter = value;
        client = new LiveLspClient(value, fixture.rootPath);
        return { dispose() {} };
      },
    });
  });
  afterEach(async () => {
    await client.stop();
    edge.dispose();
    for (const key of ["serverDirectory", "javaPath", "parameterHints"])
      lumine.config.unset(`ide-jdtls.${key}`);
    await lumine.packages.deactivatePackage("ide-jdtls");
    removeProject(fixture.rootPath);
  });
  it("returns usable intelligence, edits, hints, tokens and dynamic hierarchies", async () => {
    const { serverInfo } = await client.start();
    expect(serverInfo.name).toContain("JDT Language Server");
    if (process.env.JDTLS_VERSION) expect(serverInfo.version).toContain(process.env.JDTLS_VERSION);
    const covered = await exerciseServer(client, fixture);
    expect(covered).toContain("Unicode completion positions");
    expect(covered).toContain("inlay hints");
    expect(covered).toContain("incoming calls");
    expect(covered).toContain("type subtypes");
    expect(
      client.registrations.some(({ method }) => method === "textDocument/prepareTypeHierarchy"),
    ).toBe(true);
  });
  it("installs the checksum-verified milestone through the real managed pipeline and launches its complete tree", async () => {
    const packagePath = (await lumine.packages.loadPackage("ide")).path;
    const ManagedServers = require(path.join(packagePath, "lib", "managed-servers"));
    const managed = new ManagedServers(
      {
        adapters: new Map([[adapter.id, adapter]]),
        allSessions: () => [],
        reattachAll: async () => {},
      },
      { storageRoot: path.join(fixture.configDirPath, "managed") },
    );
    try {
      const record = await managed.install("ide-jdtls", {
        version: process.env.JDTLS_VERSION || "1.61.0",
      });
      expect(record.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
      const installed = managed.installFor(adapter);
      expect(fs.existsSync(path.join(installed.directory, "config_linux_arm", "config.ini"))).toBe(
        true,
      );
      expect(
        fs
          .readdirSync(path.join(installed.directory, "plugins"))
          .some((name) => /^org\.eclipse\.osgi_.*\.jar$/.test(name)),
      ).toBe(true);
      lumine.config.set("ide-jdtls.serverDirectory", "");
      const { serverInfo } = await client.start(installed);
      expect(serverInfo.version).toContain(record.version);
      const covered = await exerciseServer(client, fixture);
      expect(covered).toContain("code actions");
    } finally {
      managed.emitter.dispose();
    }
  });
});
