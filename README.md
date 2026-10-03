# ide-jdtls

Provide Java language features with Eclipse JDT Language Server.

Connects Java editors to Eclipse JDT LS through the shared ide-client service.

## Features

- **Diagnostics**: compiler errors and warnings from the project model.
- **Intelligence**: completion, documentation, method signatures and parameter hints.
- **Navigation**: project definitions, references, symbols, call hierarchies and type hierarchies.
- **Refactoring**: rename, quick fixes and standard workspace edits.
- **Formatting**: Eclipse formatting for documents, selections and typed input.
- **Project import**: Maven, Gradle and Eclipse projects using JDT LS defaults.
- **Managed installation**: stable milestones verified against Eclipse's SHA256 checksum, with the full server distribution preserved.

## Installation

To install ide-jdtls search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-jdtls`.

Install `ide-client` and `language-java` as well. Install a [Java 21 or newer JDK](https://adoptium.net/temurin/releases/?version=21), then use **Manage Servers** to install Eclipse JDT Language Server. The package discovers Java through `JDK_HOME`, `JAVA_HOME` and `PATH`; select its `java` executable in the package settings when it is elsewhere.

## Usage

Open the project folder containing `pom.xml`, `build.gradle`, `build.gradle.kts` or `.project`. The first import builds the project's classpath and can take longer than later requests. Build files and wrappers remain authoritative; the adapter does not replace Maven or Gradle defaults, dependencies or project Java versions.

An existing [JDT LS milestone](https://download.eclipse.org/jdtls/milestones/) can also be extracted and selected through **Server Directory**. That directory must contain `plugins` and the platform's `config_*` directories. Discovery prefers the explicit directory, the managed installation, then `JDTLS_HOME` and conventional system installations. The server runs directly through Java without Python or a shell wrapper.

The JDK that runs JDT LS needs Java 21 or newer; a project can still target an earlier Java version through its build configuration. Eclipse metadata and writable configuration are isolated for each project and editor window under the editor's `language-server-caches/ide-jdtls` directory, so windows sharing a project do not share an Eclipse workspace lock. These caches can be removed after closing editor windows.

Project source navigation is supported. JDT LS's virtual class-file documents and reference lenses require client extensions that the editor does not currently provide, so the adapter does not advertise those client extensions or show those lenses. Quick fixes that return ordinary workspace edits remain available.

## Services

- `ide-client`: consumed to register and manage Eclipse JDT Language Server sessions.
- `background-tips.provider`: provided to explain Java project import over the empty workspace.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
