const assert = require("node:assert/strict");
const { position } = require("./project");

const exerciseServer = async (client, fixture) => {
  const covered = [];
  const check = (feature, condition) => {
    assert.ok(condition, `${feature} produced no usable result`);
    covered.push(feature);
  };
  const at = (method, fragment, inside = 1, extra = {}) =>
    client.request(method, {
      textDocument: { uri: fixture.uri },
      position: position(fixture.text, fragment, inside),
      ...extra,
    });
  const document = { textDocument: { uri: fixture.uri } };
  client.open(fixture.uri, "java", fixture.text);
  const diagnostics = await client.waitFor(
    () =>
      client
        .messages("textDocument/publishDiagnostics")
        .find(
          ({ params }) =>
            params.uri === fixture.uri &&
            params.diagnostics.some(({ message }) => message.includes("missingName")),
        )?.params.diagnostics,
    "Java diagnostics",
    90000,
  );
  check(
    "diagnostics",
    diagnostics.some(({ message }) => message.includes("missingName")),
  );
  const completion = await at("textDocument/completion", "doubleValue(3)", 3);
  const item = (completion.items || completion).find(({ label }) => label.includes("doubleValue"));
  check("completion", item?.textEdit?.newText.includes("doubleValue"));
  check(
    "Unicode completion positions",
    item.textEdit.range.start.character === position(fixture.text, "doubleValue(3)", 0).character,
  );
  check(
    "hover",
    JSON.stringify(await at("textDocument/hover", "doubleValue(3)")).includes("doubleValue"),
  );
  check(
    "signature",
    (await at("textDocument/signatureHelp", "doubleValue(3)", 12)).signatures.some(({ label }) =>
      label.includes("int value"),
    ),
  );
  check(
    "definition",
    (await at("textDocument/definition", "doubleValue(3)")).some(
      (value) => (value.uri || value.targetUri) === fixture.uri,
    ),
  );
  const references = await at("textDocument/references", "doubleValue(int value)", 1, {
    context: { includeDeclaration: true },
  });
  check("references", references.length >= 3);
  check(
    "Unicode reference positions",
    references.some(
      ({ range }) =>
        range.start.line === 6 &&
        range.start.character === position(fixture.text, "doubleValue(3)", 0).character,
    ),
  );
  const rename = await at("textDocument/rename", "doubleValue(3)", 1, { newName: "twice" });
  const renamed = [
    ...Object.values(rename.changes || {}).flat(),
    ...(rename.documentChanges || []).flatMap((value) => value.edits || []),
  ];
  check(
    "rename",
    renamed.some(({ newText }) => (newText.match(/twice/g) || []).length >= 2),
  );
  const symbols = await client.request("textDocument/documentSymbol", document);
  check(
    "document symbols",
    symbols.some(
      ({ name, children }) =>
        name === "Calculator" && children.some(({ name }) => name.includes("doubleValue")),
    ),
  );
  check(
    "workspace symbols",
    (await client.request("workspace/symbol", { query: "Calculator" })).some(
      ({ name }) => name === "Calculator",
    ),
  );
  check(
    "formatting",
    (
      await client.request("textDocument/formatting", {
        ...document,
        options: { tabSize: 4, insertSpaces: true },
      })
    ).length > 0,
  );
  check(
    "range formatting",
    (
      await client.request("textDocument/rangeFormatting", {
        ...document,
        range: { start: { line: 4, character: 0 }, end: { line: 8, character: 1 } },
        options: { tabSize: 4, insertSpaces: true },
      })
    ).length > 0,
  );
  check(
    "on-type formatting",
    (
      await client.request("textDocument/onTypeFormatting", {
        ...document,
        position: position(fixture.text, "return value * 2;", 16),
        ch: ";",
        options: { tabSize: 4, insertSpaces: true },
      })
    ).length > 0,
  );
  const actions = await client.request("textDocument/codeAction", {
    ...document,
    range: diagnostics.find(({ message }) => message.includes("missingName")).range,
    context: {
      diagnostics: diagnostics.filter(({ message }) => message.includes("missingName")),
      only: ["quickfix"],
    },
  });
  check(
    "code actions",
    actions.some(
      ({ title, edit }) =>
        title.includes("Create local variable") &&
        Object.values(edit?.changes || {})
          .flat()
          .some(({ newText }) => newText.includes("int missingName")),
    ),
  );
  const hints = await client.request("textDocument/inlayHint", {
    ...document,
    range: {
      start: { line: 0, character: 0 },
      end: { line: fixture.text.split("\n").length - 1, character: 0 },
    },
  });
  check(
    "inlay hints",
    hints.some(({ label }) => JSON.stringify(label).includes("value")),
  );
  const tokens = await client.request("textDocument/semanticTokens/full", document);
  check("semantic tokens", tokens.data.length > 0 && tokens.data.length % 5 === 0);
  const callee = await at(
    "textDocument/prepareCallHierarchy",
    "public int doubleValue(int value)",
    12,
  );
  check("prepare call hierarchy", callee[0]?.name.includes("doubleValue"));
  check(
    "incoming calls",
    (await client.request("callHierarchy/incomingCalls", { item: callee[0] })).some(({ from }) =>
      from.name.includes("use"),
    ),
  );
  const caller = await at("textDocument/prepareCallHierarchy", "public int use()", 12);
  check(
    "outgoing calls",
    (await client.request("callHierarchy/outgoingCalls", { item: caller[0] })).some(({ to }) =>
      to.name.includes("doubleValue"),
    ),
  );
  const parent = await at("textDocument/prepareTypeHierarchy", "Adder {");
  check("prepare type hierarchy", parent[0]?.name === "Adder");
  check(
    "type subtypes",
    (await client.request("typeHierarchy/subtypes", { item: parent[0] })).some(
      ({ name }) => name === "Calculator",
    ),
  );
  const child = await at("textDocument/prepareTypeHierarchy", "Calculator implements");
  check(
    "type supertypes",
    (await client.request("typeHierarchy/supertypes", { item: child[0] })).some(
      ({ name }) => name === "Adder",
    ),
  );
  return covered;
};
module.exports = { exerciseServer };
