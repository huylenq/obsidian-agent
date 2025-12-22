import { SlashCommand } from "./types";

class CommandRegistry {
  private commands: Map<string, SlashCommand> = new Map();

  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
    command.aliases?.forEach((alias) => {
      this.commands.set(alias, command);
    });
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name.toLowerCase());
  }

  getAll(): SlashCommand[] {
    // Return unique commands (filter out aliases)
    return [...new Set(this.commands.values())];
  }
}

export const commandRegistry = new CommandRegistry();
