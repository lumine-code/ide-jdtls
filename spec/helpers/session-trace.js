const crypto = require("node:crypto");

// Failure-only diagnostics for the real reload test. These wrappers forward
// the original calls and promises; they do not retry or change lifecycle policy.
module.exports = function sessionTrace(manager, editor, uri) {
  const events = [],
    cleanups = [],
    identities = new WeakMap(),
    sessions = new Set(),
    controllers = new Set();
  let nextIdentity = 1,
    reported = false,
    disposed = false;
  const id = (value) => {
    if (!value || !["object", "function"].includes(typeof value)) return null;
    if (!identities.has(value)) identities.set(value, nextIdentity++);
    return identities.get(value);
  };
  const attempt = (read) => {
    try {
      return read();
    } catch (error) {
      return { diagnosticError: error.message };
    }
  };
  const editorState = () =>
    attempt(() => ({
      id: id(editor),
      destroyed: editor.isDestroyed(),
      path: editor.getPath(),
      grammar: { id: id(editor.getGrammar()), scope: editor.getGrammar()?.scopeName },
      textLength: editor.getText().length,
      textSha256: crypto.createHash("sha256").update(editor.getText()).digest("hex"),
    }));
  const controllerState = (controller) =>
    controller && {
      id: id(controller),
      session: id(controller.session),
      cancelled: controller.cancelled,
      revision: controller.revision,
      requestedGeneration: controller.requestedGeneration,
      completedGeneration: controller.completedGeneration,
      folders: [...controller.folders],
    };
  const sessionState = (session) =>
    attempt(() => ({
      id: id(session),
      adapter: { id: id(session.adapter), name: session.adapter.id },
      state: session.state,
      rootPath: session.rootPath,
      pid: session.process?.pid,
      processExited: session.processExited,
      stateError: session.stateError?.message,
      startFailure: session.startFailure?.message,
      controller: controllerState(manager.controllerForSession(session)),
      documents: [...session.documents.values()].map((document) => ({
        id: id(document),
        uri: document.uri,
        version: document.version,
        editor: id(document.editor),
        current: session.documentSync.isCurrentDocument(document),
      })),
      requestedDocument: id(session.documents.get(uri)),
    }));
  const record = (event, detail = {}) => {
    events.push({ time: new Date().toISOString(), event, ...detail });
    if (events.length > 96) events.shift();
  };
  const argument = (value) => {
    if (value?.adapter) return { id: id(value), adapter: value.adapter.id, state: value.state };
    if (value instanceof Error)
      return { name: value.name, message: value.message, code: value.code };
    if (value && typeof value === "object")
      return {
        id: id(value),
        type: value.type,
        path: value.path,
        rootPath: value.rootPath,
        rootPaths: Array.isArray(value.rootPaths) ? value.rootPaths.slice(0, 10) : undefined,
        uri: value.uri,
        version: value.version,
        reason: value.reason,
        generation: value.generation,
      };
    return value;
  };
  const wrap = (owner, method, prefix) => {
    const original = owner?.[method];
    if (typeof original !== "function") return;
    const own = Object.hasOwn(owner, method);
    const wrapped = function (...args) {
      attempt(() =>
        record(`${prefix}.${method}`, {
          owner: id(owner),
          arguments: args.slice(0, 3).map(argument),
          editor: editorState(),
          roots: lumine.project.getPaths(),
          session:
            owner.adapter?.id === "ide-jdtls" && owner.documents ? sessionState(owner) : undefined,
          controller: owner.folders && owner.host ? controllerState(owner) : undefined,
          stack: new Error().stack.split("\n").slice(2, 16).join("\n"),
        }),
      );
      return Reflect.apply(original, this, args);
    };
    owner[method] = wrapped;
    cleanups.push(() => {
      if (owner[method] !== wrapped) return;
      if (own) owner[method] = original;
      else delete owner[method];
    });
  };
  const watchSession = (session) => {
    if (session.adapter?.id !== "ide-jdtls" || sessions.has(session)) return;
    sessions.add(session);
    for (const method of [
      "setState",
      "stop",
      "kill",
      "failSession",
      "onProcessExit",
      "onConnectionClose",
    ])
      wrap(session, method, "session");
    for (const method of ["closeDocument", "changeDocument", "useEditor"])
      wrap(session.documentSync, method, "documents");
    const controller = manager.controllerForSession(session);
    if (controller && !controllers.has(controller)) {
      controllers.add(controller);
      for (const method of [
        "restart",
        "shutdown",
        "cancel",
        "documentClosed",
        "structureChanged",
        "settingsChanged",
      ])
        wrap(controller, method, "controller");
    }
    record("session.observed", { session: sessionState(session) });
  };
  for (const method of [
    "restart",
    "reclaim",
    "stopSession",
    "unregisterAdapter",
    "cancelController",
    "stopIfUnreachable",
    "recoverFileWatching",
    "projectPathsChanged",
    "restartAdapter",
  ])
    wrap(manager, method, "manager");
  for (const session of manager.allSessions()) watchSession(session);
  const sessionSubscription = manager.onDidChangeSession(({ session, state, error }) => {
    watchSession(session);
    if (session.adapter?.id === "ide-jdtls")
      record("session.event", { state, error: argument(error), session: sessionState(session) });
  });
  cleanups.push(() => sessionSubscription.dispose());
  const observe = (owner, method, event) => {
    const subscription = owner[method]((value) =>
      record(event, {
        detail: Array.isArray(value) ? value.slice(0, 5).map(argument) : argument(value),
        editor: editorState(),
        roots: lumine.project.getPaths(),
      }),
    );
    cleanups.push(() => subscription.dispose());
  };
  observe(editor, "onDidChangeGrammar", "editor.grammar");
  observe(editor, "onDidChangePath", "editor.path");
  observe(editor, "onDidDestroy", "editor.destroyed");
  observe(lumine.project, "onDidChangePaths", "project.paths");
  observe(lumine.project, "onDidInvalidateFiles", "project.invalidated");
  record("trace.started", { editor: editorState(), roots: lumine.project.getPaths() });
  return {
    record,
    sessionState,
    report(error) {
      if (reported) return;
      reported = true;
      console.error(
        "JDT_RELOAD_FAILURE " +
          JSON.stringify({
            error: argument(error),
            editor: editorState(),
            roots: lumine.project.getPaths(),
            sessions: [...sessions].map(sessionState),
            events,
            serverLogTail: (manager.logs.get("ide-jdtls") || [])
              .slice(-12)
              .map((line) => line.slice(-2000)),
          }),
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups.reverse()) cleanup();
    },
  };
};
