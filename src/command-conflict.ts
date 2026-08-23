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
  const ours = autoresearch.find((command) => command.sourceInfo.source === PACKAGE_SOURCE);
  const other = autoresearch.find((command) =>
    command !== ours && command.sourceInfo.source !== PACKAGE_SOURCE,
  );
  return ours && other
    ? {
      ours: commandIdentity(ours),
      other: commandIdentity(other),
    }
    : undefined;
}

function commandBase(name: string): string {
  return name.replace(/:\d+$/, "");
}

function commandIdentity(command: CommandProvenance): string {
  return `${command.sourceInfo.source} (${command.sourceInfo.path})`;
}
