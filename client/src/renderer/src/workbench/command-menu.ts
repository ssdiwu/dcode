import type { ComposerCommand } from "./useCommands";

export type CommandGroup = "skill" | "command" | "prompt";
export const commandGroups: readonly CommandGroup[] = ["skill", "command", "prompt"];
export const commandGroupLabels = {skill:"技能",command:"命令",prompt:"模板"};
export interface CommandOption {
  key: string;
  command: ComposerCommand;
  group: CommandGroup;
  label: string;
}

/** A readable projection only: the original command.name remains the invocation. */
export function commandLabel(command: ComposerCommand): string {
  const name = command.name.replace(/^\//u, "");
  const readable = command.source === "skill" ? name.replace(/^skill:/u, "") : name;
  return readable.replace(/[-_]+/gu, " ").replace(/(^|\s)(\p{L})/gu, (_match, space: string, letter: string) => space + letter.toLocaleUpperCase());
}

export function commandOptions(commands: ComposerCommand[], query: string): CommandOption[] {
  const needle = query.trim().normalize("NFKC").toLocaleLowerCase();
  const options = commands.map((command, index): CommandOption => ({
    command, key:`${command.source}:${command.name}:${index}`,
    group:command.source === "skill" ? "skill" : command.source === "prompt" ? "prompt" : "command",
    label:commandLabel(command),
  })).filter(option => [option.command.name, option.label, option.command.description ?? ""].some(value => value.normalize("NFKC").toLocaleLowerCase().includes(needle)));
  return commandGroups.flatMap(group => options.filter(option => option.group === group));
}

/** A known invocation followed by whitespace is argument entry, not menu search. */
export function hasCommandArguments(text: string, commands: ComposerCommand[]): boolean {
  return commands.some(command => text.startsWith(`/${command.name}`) && /^\s/u.test(text.slice(command.name.length + 1)));
}
