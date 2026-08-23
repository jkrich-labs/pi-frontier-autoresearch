import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandProvenance {
  readonly name: string;
  readonly source: string;
  readonly sourceInfo: {
    readonly source: string;
    readonly path: string;
  };
}

export interface CommandConflict {
  readonly ours: string;
  readonly other: string;
}

const PACKAGE_SOURCE = "pi-frontier-autoresearch";
const OWN_EXTENSION_PATH = fileURLToPath(
  new URL("../extensions/pi-frontier-autoresearch/index.ts", import.meta.url),
);

/**
 * Detect competing extension commands solely from Pi's command provenance.
 * It intentionally has no session, working-directory, store, or filesystem
 * inputs so collision handling cannot inspect either package's state.
 */
export function detectAutoresearchCommandConflict(
  commands: readonly CommandProvenance[],
): CommandConflict | undefined {
  const autoresearch = commands.filter((command) =>
    command.source === "extension" && commandBase(command.name) === "autoresearch",
  );
  const ours = autoresearch.find(isOurPackageCommand);
  const other = autoresearch.find((command) => command !== ours && !isOurPackageCommand(command));
  return ours && other
    ? {
      ours: commandIdentity(ours),
      other: commandIdentity(other),
    }
    : undefined;
}

function isOurPackageCommand(command: CommandProvenance): boolean {
  const source = command.sourceInfo.source;
  const npmPrefix = `npm:${PACKAGE_SOURCE}`;
  const packageSource = source === PACKAGE_SOURCE || source === npmPrefix || source.startsWith(`${npmPrefix}@`);
  // Local package sources retain their configured path as source. Compare the
  // canonical command provenance path to this exact installed extension module;
  // do not guess ownership from arbitrary parent-directory names.
  return packageSource || resolve(command.sourceInfo.path) === resolve(OWN_EXTENSION_PATH);
}

function commandBase(name: string): string {
  return name.replace(/:\d+$/, "");
}

function commandIdentity(command: CommandProvenance): string {
  return `${command.sourceInfo.source} (${command.sourceInfo.path})`;
}
