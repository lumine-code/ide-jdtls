const { Point } = require("lumine");
const path = require("node:path");
const { createProject, removeProject, position } = require("./helpers/project");
const serverDirectory = process.env.JDTLS_HOME;
const javaPath =
  process.env.JAVA_LSP_PATH ||
  (process.env.JAVA_HOME &&
    path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java"));
const liveSuite = serverDirectory && javaPath ? describe : () => {};
const until = async (check, label) => {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
};

liveSuite("ide-jdtls actual editor routing", () => {
  let fixture, editor, paths, service, timeout, published, subscription;
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
    paths = lumine.project.getPaths();
    published = [];
    lumine.config.set("ide-jdtls.serverDirectory", serverDirectory);
    lumine.config.set("ide-jdtls.javaPath", javaPath);
    lumine.config.set("ide-jdtls.parameterHints", "all");
    for (const name of ["language-java", "ide-client", "ide-jdtls"])
      await lumine.packages.activatePackage(name);
    service = lumine.packages.getActivePackage("ide-client").mainModule.provideIdeClient();
    subscription = service.onDidPublishDiagnostics((value) => published.push(value));
    lumine.project.setPaths([fixture.rootPath]);
    editor = await lumine.workspace.open(fixture.filePath);
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.java"));
  });
  afterEach(async () => {
    subscription.dispose();
    editor?.destroy();
    for (const name of ["ide-jdtls", "ide-client", "language-java"])
      await lumine.packages.deactivatePackage(name);
    for (const key of [
      "serverDirectory",
      "javaPath",
      "parameterHints",
      "features.format",
      "features.hover",
      "features.diagnostics",
    ])
      lumine.config.unset(`ide-jdtls.${key}`);
    lumine.project.setPaths(paths);
    await lumine.fileWatchClient.settlePendingTeardown();
    removeProject(fixture.rootPath);
  });
  const sessionFor = () =>
    until(
      async () =>
        (await service.activeSessionsForEditor(editor)).find(
          ({ adapter }) => adapter.id === "ide-jdtls",
        ),
      "Java session",
    );
  const point = (fragment, inside = 1) => {
    const p = position(fixture.text, fragment, inside);
    return new Point(p.line, p.character);
  };
  it("routes real services, applies a quick fix and honours feature gates", async () => {
    const session = await sessionFor();
    await until(
      () =>
        published.some(
          ({ uri, diagnostics }) =>
            uri === fixture.uri &&
            diagnostics.some(({ message }) => message.includes("missingName")),
        ),
      "Java diagnostics in the editor",
    );
    const main = lumine.packages.getActivePackage("ide-client").mainModule;
    const suggestions = await main.provideAutocomplete().getSuggestions({
      editor,
      bufferPosition: point("doubleValue(3)", 3),
      prefix: "dou",
      activatedManually: true,
    });
    expect(
      suggestions.some((item) =>
        (item.displayText || item.text || item.snippet || "").includes("doubleValue"),
      ),
    ).toBe(true);
    expect(
      JSON.stringify(await main.provideHover().hover(editor, point("doubleValue(3)"))),
    ).toContain("doubleValue");
    expect(
      (await main.provideHoverSignature().getSignature(editor, point("doubleValue(3)", 12)))
        .signatures[0].label,
    ).toContain("value");
    const references = (
      await main.provideFindReferences().findReferences(editor, point("doubleValue(3)"))
    ).references;
    // The call resolves to Calculator's concrete override; the separate
    // protocol test queries the interface and includes its implementers.
    expect(
      references.some(
        ({ path, range }) => path === fixture.filePath && range[0][0] === 5 && range[0][1] === 12,
      ),
    ).toBe(true);
    expect(
      references.some(
        ({ path, range }) =>
          path === fixture.filePath &&
          range[0][0] === 6 &&
          range[0][1] === position(fixture.text, "doubleValue(3)", 0).character,
      ),
    ).toBe(true);
    const renamed = await main
      .provideRefactor()
      .rename(editor, point("doubleValue(3)"), "twice", { dryRun: true });
    expect(renamed.outcome).toBe("edits");
    expect(
      renamed.edits.get(fixture.filePath).some(({ newText }) => newText.includes("twice")),
    ).toBe(true);
    expect(
      (await main.provideInlayHints().inlayHints(editor, [0, 7])).some(({ label }) =>
        label.includes("value"),
      ),
    ).toBe(true);
    expect((await main.provideSemanticTokens().semanticTokens(editor)).length).toBeGreaterThan(0);
    const formatter = main.provideCodeFormatFile();
    expect((await formatter.formatEntireFile(editor)).length).toBeGreaterThan(0);
    lumine.config.set("ide-jdtls.features.format", false);
    expect(await service.activeSessionForFeature(editor, "textDocument/formatting")).toBeNull();
    expect(await formatter.formatEntireFile(editor)).toEqual([]);
    lumine.config.set("ide-jdtls.features.hover", false);
    expect(await main.provideHover().hover(editor, point("doubleValue(3)"))).toBeNull();
    expect(service.featureEnabled(session.adapter, "codeLens", editor)).toBe(false);
    const actions = await main
      .provideIntentionsList()
      .getIntentions({ textEditor: editor, bufferPosition: point("missingName") });
    const fix = actions.find(({ title }) => title.includes("Create local variable"));
    expect(fix).toBeTruthy();
    await fix.selected();
    expect(editor.getText()).toContain("int missingName;");
  });
  it("stops the discarded generation and serves the editor through a new module after unload", async () => {
    const previous = await sessionFor(),
      oldPackage = lumine.packages.getActivePackage("ide-jdtls"),
      oldMain = oldPackage.mainModule,
      packagePath = oldPackage.path;
    await lumine.packages.deactivatePackage("ide-jdtls");
    await until(() => previous.state === "stopped", "Java teardown");
    expect(service.adaptersForEditor(editor)).toEqual([]);
    await lumine.packages.unloadPackage("ide-jdtls");
    await lumine.packages.loadPackage(packagePath);
    const current = (await lumine.packages.activatePackage("ide-jdtls")).mainModule;
    expect(current).not.toBe(oldMain);
    const renewed = await sessionFor();
    expect(renewed).not.toBe(previous);
    const result = await until(
      () =>
        renewed.request("textDocument/hover", {
          textDocument: { uri: fixture.uri },
          position: position(fixture.text, "doubleValue(3)", 1),
        }),
      "Java hover after reload",
    );
    expect(JSON.stringify(result)).toContain("doubleValue");
  });
});
