/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow strict
 * @format
 */

import type {Command} from './Command';
import type {DispatcherInterface} from './DispatcherInterface';

import invariant from 'assert';
import TokenizedLine from './TokenizedLine';

export default class CommandDispatcher implements DispatcherInterface {
  _commands: Command[] = [];
  _aliases: Map<string, string>;

  constructor(aliases: Map<string, string>) {
    this._aliases = aliases;
  }

  registerCommand(command: Command): void {
    this._commands.push(command);
  }

  getCommands(): Command[] {
    return this._commands;
  }

  getCommandsMatching(prefix: string): Command[] {
    const re = new RegExp(`^${prefix}`);
    return this._commands.filter(x => x.name.match(re));
  }

  commandListToString(commands: Command[]): string {
    const names = commands.map(_ => _.name);
    return `"${names.join('", "')}"`;
  }

  async execute(line: string): Promise<?Error> {
    const tokens = new TokenizedLine(line);
    return this.executeTokenizedLine(tokens);
  }

  async executeTokenizedLine(tokens: TokenizedLine): Promise<?Error> {
    // resolve aliases
    const alias = this.resolveAlias(tokens);
    if (alias != null) {
      return this.execute(alias);
    }

    const cmd = tokens.stringTokens()[0];
    if (cmd == null) {
      return;
    }

    const matches = this.getCommandsMatching(cmd);

    if (matches.length === 0) {
      return new Error(`No command matches "${cmd}".`);
    }

    if (matches.length > 1) {
      const list = this.commandListToString(matches);
      return new Error(`Multiple commands match "${cmd}": ${list}`);
    }

    return new Promise((resolve, reject) => {
      matches[0].execute(tokens).then(_ => resolve(null), _ => resolve(_));
    });
  }

  resolveAlias(tokens: TokenizedLine): ?string {
    const cmd = tokens.stringTokens()[0];
    if (cmd == null) {
      return null;
    }

    const alias = this._aliases.get(cmd);
    if (alias != null) {
      return `${alias} ${tokens.rest(1)}`;
    }

    // punctuation aliases are things like '=' for print ala hphpd
    // we have to be careful here since we want '=$x' to work to
    // print the value of x
    //
    // Find the longest punctuation alias match
    let puncMatch: ?string = null;

    for (const key of this._aliases.keys()) {
      if (key.match(/^[^a-zA-Z0-9]+$/)) {
        if (puncMatch != null && key.length < puncMatch.length) {
          continue;
        }
        if (cmd.startsWith(key)) {
          puncMatch = key;
        }
      }
    }

    if (puncMatch != null) {
      const puncAlias = this._aliases.get(puncMatch);
      invariant(puncAlias != null);
      return `${puncAlias} ${tokens.rest(0).substr(puncAlias.length)}`;
    }

    return null;
  }
}
