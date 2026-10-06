const server = require("./server");
const setting = (name) => lumine.config.get(`ide-jdtls.${name}`);

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
      id: "ide-jdtls",
      displayName: "Eclipse JDT Language Server",
      grammarScopes: ["source.java"],
      languageId: "java",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-jdtls"],
      restartKeyPaths: ["ide-jdtls.serverDirectory", "ide-jdtls.javaPath", "ide-jdtls.maxHeap"],
      managedServerDisplayName: "Eclipse JDT Language Server",
      installServer: server.installServer,
      latestServerVersion: server.latestServerVersion,
      // JDT LS lenses invoke java.show.references, a client command that this
      // editor cannot execute. Do not display an action with no working route.
      isFeatureAvailable: (feature) => feature !== "codeLens",
      async resolveServer(context) {
        const launch = await server.resolveServer(context, {
          serverDirectory: setting("serverDirectory"),
          javaPath: setting("javaPath"),
          maxHeap: setting("maxHeap"),
        });
        if (!launch)
          client.reportMissingServer("ide-jdtls", {
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
    });
  },
  provideBackgroundTips() {
    return {
      packageName: "ide-jdtls",
      tips: [
        "Java projects get completion, navigation and refactorings from Eclipse JDT Language Server. Open the folder containing pom.xml or build.gradle so the server can import the project's dependencies.",
      ],
    };
  },
};
