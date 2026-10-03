const server = require("./server");
const setting = (name) => lumine.config.get(`ide-java.${name}`);

const settings = () => {
  const java = {
    signatureHelp: { enabled: true },
    referencesCodeLens: { enabled: false },
    implementationCodeLens: "none",
    format: { onType: { enabled: true } },
  };
  const parameterHints = setting("parameterHints");
  if (parameterHints && parameterHints !== "server-default")
    java.inlayHints = { parameterNames: { enabled: parameterHints } };
  const update = setting("buildConfigurationUpdates");
  if (update && update !== "server-default")
    java.configuration = { updateBuildConfiguration: update };
  const formatter = setting("formatterProfileUrl");
  if (formatter)
    java.format.settings = { url: formatter, profile: setting("formatterProfile") || undefined };
  return { java };
};

module.exports = {
  consumeIdeClient(client) {
    return client.registerAdapter({
      id: "ide-java",
      displayName: "Eclipse JDT Language Server",
      grammarScopes: ["source.java"],
      languageId: "java",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-java"],
      restartKeyPaths: ["ide-java.serverDirectory", "ide-java.javaPath", "ide-java.maxHeap"],
      managedServerDisplayName: "Eclipse JDT Language Server",
      installServer: server.installServer,
      latestServerVersion: server.latestServerVersion,
      // JDT LS lenses invoke java.show.references, a client command that this
      // editor cannot execute. Do not display an action with no working route.
      isFeatureAvailable: (feature) => feature !== "codeLens",
      async resolveServer(context) {
        const launch = await server.resolveServer({
          serverDirectory: setting("serverDirectory"),
          javaPath: setting("javaPath"),
          maxHeap: setting("maxHeap"),
          context,
        });
        if (!launch)
          client.reportMissingServer("ide-java", {
            description:
              "Install Eclipse JDT Language Server through Manage Servers, and install a Java 21 or newer JDK. Set Java Path to its java executable and Server Directory to an existing JDT LS distribution if they are not discoverable.",
          });
        return launch;
      },
      getInitializationOptions: () => ({
        settings: settings(),
        extendedClientCapabilities: { classFileContentsSupport: false },
      }),
      getSettings: settings,
      getWorkspaceConfiguration(section) {
        const configuration = settings();
        if (!section) return configuration;
        return section.split(".").reduce((value, key) => value?.[key], configuration);
      },
    });
  },
  provideBackgroundTips() {
    return {
      packageName: "ide-java",
      tips: [
        "Java projects get completion, navigation and refactorings from Eclipse JDT Language Server. Open the folder containing pom.xml or build.gradle so the server can import the project's dependencies.",
      ],
    };
  },
};
