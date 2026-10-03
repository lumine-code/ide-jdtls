const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const createProject = () => {
  const temporaryRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-java-"));
  const rootPath = path.join(temporaryRoot, "project");
  const source = path.join(rootPath, "src", "sample");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(
    path.join(rootPath, ".project"),
    '<?xml version="1.0"?><projectDescription><name>sample</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>',
  );
  fs.writeFileSync(
    path.join(rootPath, ".classpath"),
    '<?xml version="1.0"?><classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>',
  );
  const text = `package sample;

interface Adder { int doubleValue(int value); }

public class Calculator implements Adder {
 public int doubleValue(int value){return value * 2;}
 public int use(){String emoji="😀"; return doubleValue(3);}
 public int broken(){return missingName;}
}
`;
  const filePath = path.join(source, "Calculator.java");
  fs.writeFileSync(filePath, text);
  return {
    rootPath,
    filePath,
    text,
    uri: pathToFileURL(filePath).href,
    configDirPath: path.join(temporaryRoot, ".client"),
  };
};
const removeProject = (rootPath) => {
  const parent = fs.realpathSync.native(os.tmpdir());
  const target = path.dirname(path.resolve(rootPath));
  if (path.dirname(target) !== parent || !path.basename(target).startsWith("ide-java-"))
    throw new Error(`Refusing to remove a non-test directory: ${target}`);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
};
const position = (text, fragment, inside = 0) => {
  const offset = text.indexOf(fragment);
  if (offset < 0) throw new Error(`Missing fixture fragment ${fragment}`);
  const before = text.slice(0, offset + inside).split("\n");
  return { line: before.length - 1, character: before.at(-1).length };
};
module.exports = { createProject, removeProject, position };
