'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {NuclideUri} from '../commons-node/nuclideUri';
import type {FileChangeStatusValue} from '../nuclide-hg-git-bridge/lib/constants';

import classnames from 'classnames';
import {
 FileChangeStatus,
 FileChangeStatusToPrefix,
 FileChangeStatusToTextColor,
 RevertibleStatusCodes,
} from '../nuclide-hg-git-bridge/lib/constants';
import invariant from 'invariant';
import nuclideUri from '../commons-node/nuclideUri';
import {React} from 'react-for-atom';
import UniversalDisposable from '../commons-node/UniversalDisposable';
// eslint-disable-next-line nuclide-internal/no-cross-atom-imports
import {addPath, revertPath} from '../nuclide-hg-repository/lib/actions';

type ChangedFilesProps = {
  fileChanges: Map<NuclideUri, FileChangeStatusValue>,
  rootPath: NuclideUri,
  commandPrefix: string,
  selectedFile: ?NuclideUri,
  hideEmptyFolders: boolean,
  shouldShowFolderName: boolean,
  onFileChosen: (filePath: NuclideUri) => void,
};

type ChangedFilesState = {
  isCollapsed: boolean,
};

class ChangedFilesView extends React.Component {
  props: ChangedFilesProps;
  state: ChangedFilesState;

  constructor(props: ChangedFilesProps) {
    super(props);
    this.state = {
      isCollapsed: false,
    };
  }

  _getFileClassname(file: NuclideUri, fileChangeValue: FileChangeStatusValue): string {
    const {selectedFile} = this.props;
    return classnames(
      'list-item', {
        selected: file === selectedFile,
      },
      FileChangeStatusToTextColor[fileChangeValue],
    );
  }

  render(): ?React.Element<any> {
    const {fileChanges, commandPrefix} = this.props;
    if (fileChanges.size === 0 && this.props.hideEmptyFolders) {
      return null;
    }

    const rootClassName = classnames('list-nested-item', {
      collapsed: this.state.isCollapsed,
    });

    const fileClassName = classnames(
      'icon',
      'icon-file-text',
      'nuclide-file-changes-file-entry',
      `${commandPrefix}-file-entry`,
    );

    return (
      <ul className="list-tree has-collapsable-children">
        <li className={rootClassName}>
          {this.props.shouldShowFolderName ?
            <div
              className="list-item"
              key={this.props.rootPath}
              onClick={() => this.setState({isCollapsed: !this.state.isCollapsed})}>
              <span
                className="icon icon-file-directory nuclide-file-changes-root-entry"
                data-path={this.props.rootPath}>
                {nuclideUri.basename(this.props.rootPath)}
              </span>
            </div> :
            null
          }
          <ul className="list-tree has-flat-children">
            {Array.from(fileChanges.entries()).map(
              ([filePath, fileChangeValue]) =>
                <li
                  data-path={filePath}
                  className={this._getFileClassname(filePath, fileChangeValue)}
                  key={filePath}
                  onClick={() => this.props.onFileChosen(filePath)}>
                  <span
                    className={fileClassName}
                    data-path={filePath}
                    data-root={this.props.rootPath}>
                    {FileChangeStatusToPrefix[fileChangeValue]}{nuclideUri.basename(filePath)}
                  </span>
                </li>,
            )}
          </ul>
        </li>
      </ul>
    );
  }
}

type Props = {
  fileChanges: Map<NuclideUri, Map<NuclideUri, FileChangeStatusValue>>,
  commandPrefix: string,
  selectedFile: ?NuclideUri,
  hideEmptyFolders?: boolean,
  onFileChosen: (filePath: NuclideUri) => void,
};

export class MultiRootChangedFilesView extends React.Component {
  props: Props;
  _subscriptions: UniversalDisposable;

  componentDidMount(): void {
    this._subscriptions = new UniversalDisposable();
    const {commandPrefix} = this.props;
    this._subscriptions.add(atom.contextMenu.add({
      [`.${commandPrefix}-file-entry`]: [
        {type: 'separator'},
        {
          label: 'Add to Mercurial',
          command: `${commandPrefix}:add`,
          shouldDisplay: event => {
            // The context menu has the `currentTarget` set to `document`.
            // Hence, use `target` instead.
            const filePath = event.target.getAttribute('data-path');
            const rootPath = event.target.getAttribute('data-root');
            const fileChangesForRoot = this.props.fileChanges.get(rootPath);
            invariant(fileChangesForRoot, 'Invalid rootpath');
            const statusCode = fileChangesForRoot.get(filePath);
            return statusCode === FileChangeStatus.UNTRACKED;
          },
        },
        {
          label: 'Revert',
          command: `${commandPrefix}:revert`,
          shouldDisplay: event => {
            // The context menu has the `currentTarget` set to `document`.
            // Hence, use `target` instead.
            const filePath = event.target.getAttribute('data-path');
            const rootPath = event.target.getAttribute('data-root');
            const fileChangesForRoot = this.props.fileChanges.get(rootPath);
            invariant(fileChangesForRoot, 'Invalid rootpath');
            const statusCode = fileChangesForRoot.get(filePath);
            if (statusCode == null) {
              return false;
            }
            return RevertibleStatusCodes.includes(statusCode);
          },
        },
        {
          label: 'Goto File',
          command: `${commandPrefix}:goto-file`,
        },
        {
          label: 'Copy File Name',
          command: `${commandPrefix}:copy-file-name`,
        },
        {
          label: 'Copy Full Path',
          command: `${commandPrefix}:copy-full-path`,
        },
        {type: 'separator'},
      ],
    }));

    this._subscriptions.add(atom.commands.add(
      `.${commandPrefix}-file-entry`,
      `${commandPrefix}:goto-file`,
      event => {
        const filePath = this._getFilePathFromEvent(event);
        if (filePath != null && filePath.length) {
          atom.workspace.open(filePath);
        }
      },
    ));

    this._subscriptions.add(atom.commands.add(
      `.${commandPrefix}-file-entry`,
      `${commandPrefix}:copy-full-path`,
      event => {
        atom.clipboard.write(nuclideUri.getPath(this._getFilePathFromEvent(event) || ''));
      },
    ));
    this._subscriptions.add(atom.commands.add(
      `.${commandPrefix}-file-entry`,
      `${commandPrefix}:copy-file-name`,
      event => {
        atom.clipboard.write(nuclideUri.basename(this._getFilePathFromEvent(event) || ''));
      },
    ));
    this._subscriptions.add(atom.commands.add(
      `.${commandPrefix}-file-entry`,
      `${commandPrefix}:add`,
      event => {
        const filePath = this._getFilePathFromEvent(event);
        if (filePath != null && filePath.length) {
          addPath(filePath);
        }
      },
    ));
    this._subscriptions.add(atom.commands.add(
      `.${commandPrefix}-file-entry`,
      `${commandPrefix}:revert`,
      event => {
        const filePath = this._getFilePathFromEvent(event);
        if (filePath != null && filePath.length) {
          revertPath(filePath);
        }
      },
    ));
  }

  _getFilePathFromEvent(event: Event): NuclideUri {
    const eventTarget: HTMLElement = (event.currentTarget: any);
    return eventTarget.getAttribute('data-path');
  }

  render(): React.Element<any> {
    if (this.props.fileChanges.size === 0) {
      return <div>No changes</div>;
    }

    return (
      <div className="nuclide-ui-multi-root-file-tree-container">
        {Array.from(this.props.fileChanges.entries()).map(([root, fileChanges]) =>
          <ChangedFilesView
            key={root}
            fileChanges={fileChanges}
            rootPath={root}
            commandPrefix={this.props.commandPrefix}
            selectedFile={this.props.selectedFile}
            hideEmptyFolders={this.props.hideEmptyFolders}
            shouldShowFolderName={this.props.fileChanges.size > 1}
            onFileChosen={this.props.onFileChosen}
          />,
        )}
      </div>
    );
  }

  componentWillUnmount(): void {
    this._subscriptions.dispose();
  }
}
