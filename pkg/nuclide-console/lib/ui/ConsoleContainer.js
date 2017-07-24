/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type {Viewable} from '../../../nuclide-workspace-views/lib/types';
import type {
  AppState,
  ConsolePersistedState,
  DisplayableRecord,
  Executor,
  OutputProvider,
  OutputProviderStatus,
  Record,
  Source,
  Store,
} from '../types';
import type {CreatePasteFunction} from '../../../nuclide-paste-base';

import {viewableFromReactElement} from '../../../commons-atom/viewableFromReactElement';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import {nextAnimationFrame} from 'nuclide-commons/observable';
import getCurrentExecutorId from '../getCurrentExecutorId';
import * as Actions from '../redux/Actions';
import Console from './Console';
import escapeStringRegexp from 'escape-string-regexp';
import React from 'react';
import {Observable, Subject} from 'rxjs';
import invariant from 'assert';

type Props = {
  store: Store,
  initialFilterText?: string,
  initialEnableRegExpFilter?: boolean,
  initialUnselectedSourceIds?: Array<string>,
  createPasteFunction: ?CreatePasteFunction,
};

type State = {
  //
  // State shared between all Console instances
  //

  currentExecutor: ?Executor,
  providers: Map<string, OutputProvider>,
  providerStatuses: Map<string, OutputProviderStatus>,
  ready: boolean,
  history: Array<string>,
  sources: Array<Source>,
  executors: Map<string, Executor>,

  //
  // State unique to this particular Console instance
  //

  displayableRecords: Array<DisplayableRecord>,
  filterText: string,
  enableRegExpFilter: boolean,
  unselectedSourceIds: Array<string>,
};

type BoundActionCreators = {
  execute: (code: string) => void,
  selectExecutor: (executorId: string) => void,
  clearRecords: () => void,
};

export const WORKSPACE_VIEW_URI = 'atom://nuclide/console';

const INITIAL_RECORD_HEIGHT = 21;

// NOTE: We're not accounting for the "store" prop being changed.
export class ConsoleContainer extends React.Component {
  props: Props;
  state: State;

  _actionCreators: BoundActionCreators;

  // Associates Records with their display state (height, expansionStateId).
  _displayableRecords: WeakMap<Record, DisplayableRecord>;

  _nextRecordId: number;
  _statesSubscription: rxjs$ISubscription;
  _stateChanges: Subject<void>;
  _titleChanges: Observable<string>;

  constructor(props: Props) {
    super(props);
    const {
      initialFilterText,
      initialEnableRegExpFilter,
      initialUnselectedSourceIds,
    } = props;
    this.state = {
      ready: false,
      currentExecutor: null,
      providers: new Map(),
      providerStatuses: new Map(),
      executors: new Map(),
      displayableRecords: [],
      history: [],
      sources: [],
      filterText: initialFilterText == null ? '' : initialFilterText,
      enableRegExpFilter: Boolean(initialEnableRegExpFilter),
      unselectedSourceIds:
        initialUnselectedSourceIds == null ? [] : initialUnselectedSourceIds,
    };
    this._nextRecordId = 0;
    this._displayableRecords = new WeakMap();
    this._stateChanges = new Subject();
    this._titleChanges = this._stateChanges
      .map(() => this.state)
      .distinctUntilChanged()
      .map(() => this.getTitle())
      .distinctUntilChanged();
  }

  componentDidUpdate(): void {
    this._stateChanges.next();
  }

  getIconName(): string {
    return 'terminal';
  }

  getTitle(): string {
    // If there's only one source selected, use its name in the tab title.
    if (
      this.state.sources.length - this.state.unselectedSourceIds.length ===
      1
    ) {
      const selectedSource = this.state.sources.find(
        source => this.state.unselectedSourceIds.indexOf(source.id) === -1,
      );
      if (selectedSource) {
        return `Console: ${selectedSource.name}`;
      }
    }
    return 'Console';
  }

  getDefaultLocation(): string {
    return 'bottom';
  }

  getURI(): string {
    return WORKSPACE_VIEW_URI;
  }

  onDidChangeTitle(callback: (title: string) => mixed): IDisposable {
    return new UniversalDisposable(this._titleChanges.subscribe(callback));
  }

  componentDidMount() {
    // $FlowFixMe: How do we tell flow about Symbol.observable?
    this._statesSubscription = Observable.from(this.props.store)
      .audit(() => nextAnimationFrame)
      .subscribe(state => {
        const currentExecutorId = getCurrentExecutorId(state);
        const currentExecutor =
          currentExecutorId != null
            ? state.executors.get(currentExecutorId)
            : null;
        this.setState({
          ready: true,
          currentExecutor,
          executors: state.executors,
          providers: state.providers,
          providerStatuses: state.providerStatuses,
          displayableRecords: this._toDisplayableRecords(state.records),
          history: state.history,
          sources: getSources(state),
        });
      });
  }

  componentWillUnmount() {
    this._statesSubscription.unsubscribe();
  }

  copy(): Viewable {
    return viewableFromReactElement(
      <ConsoleContainer
        store={this.props.store}
        createPasteFunction={this.props.createPasteFunction}
        initialFilterText={this.state.filterText}
        initialEnableRegExpFilter={this.state.enableRegExpFilter}
        initialUnselectedSourceIds={this.state.unselectedSourceIds}
      />,
    );
  }

  _getBoundActionCreators(): BoundActionCreators {
    if (this._actionCreators == null) {
      const {store} = this.props;
      this._actionCreators = {
        execute: code => {
          store.dispatch(Actions.execute(code));
        },
        selectExecutor: executorId => {
          store.dispatch(Actions.selectExecutor(executorId));
        },
        clearRecords: () => {
          store.dispatch(Actions.clearRecords());
        },
      };
    }
    return this._actionCreators;
  }

  _resetAllFilters = (): void => {
    this._selectSources(this.state.sources.map(s => s.id));
    this._updateFilterText('');
  };

  _createPaste = async (): Promise<void> => {
    if (this.props.createPasteFunction == null) {
      return;
    }

    const {displayableRecords} = this._getFilterInfo();
    const lines = displayableRecords
      .filter(
        displayable =>
          displayable.record.kind === 'message' ||
          displayable.record.kind === 'request' ||
          displayable.record.kind === 'response',
      )
      .map(displayable => {
        const record = displayable.record;
        const level =
          record.level != null ? record.level.toString().toUpperCase() : 'LOG';
        const timestamp = record.timestamp.toLocaleString();
        return `[${level}][${record.sourceId}][${timestamp}]\t ${record.text}`;
      })
      .join('\n');

    if (lines === '') {
      // Can't create an empty paste!
      atom.notifications.addWarning(
        'There is nothing in your console to Paste! Check your console filters and try again.',
      );
      return;
    }

    atom.notifications.addInfo('Creating Paste...');

    invariant(this.props.createPasteFunction != null);
    const uri = await this.props.createPasteFunction(
      lines,
      {
        title: 'Nuclide Console Paste',
      },
      'console paste',
    );

    atom.notifications.addSuccess(`Created Paste at ${uri}`);
  };

  _getFilterInfo(): {
    isValid: boolean,
    selectedSourceIds: Array<string>,
    displayableRecords: Array<DisplayableRecord>,
  } {
    const {pattern, isValid} = this._getFilterPattern(
      this.state.filterText,
      this.state.enableRegExpFilter,
    );

    const selectedSourceIds = this.state.sources
      .map(source => source.id)
      .filter(
        sourceId => this.state.unselectedSourceIds.indexOf(sourceId) === -1,
      );

    const displayableRecords = filterRecords(
      this.state.displayableRecords,
      selectedSourceIds,
      pattern,
      this.state.sources.length !== selectedSourceIds.length,
    );

    return {
      isValid,
      selectedSourceIds,
      displayableRecords,
    };
  }

  render(): ?React.Element<any> {
    if (!this.state.ready) {
      return <span />;
    }

    const actionCreators = this._getBoundActionCreators();
    const {
      isValid,
      selectedSourceIds,
      displayableRecords,
    } = this._getFilterInfo();
    const filteredRecordCount =
      this.state.displayableRecords.length - displayableRecords.length;

    const createPaste =
      this.props.createPasteFunction != null ? this._createPaste : null;

    return (
      <Console
        invalidFilterInput={!isValid}
        execute={actionCreators.execute}
        selectExecutor={actionCreators.selectExecutor}
        clearRecords={actionCreators.clearRecords}
        createPaste={createPaste}
        currentExecutor={this.state.currentExecutor}
        unselectedSourceIds={this.state.unselectedSourceIds}
        filterText={this.state.filterText}
        enableRegExpFilter={this.state.enableRegExpFilter}
        displayableRecords={displayableRecords}
        filteredRecordCount={filteredRecordCount}
        history={this.state.history}
        sources={this.state.sources}
        selectedSourceIds={selectedSourceIds}
        selectSources={this._selectSources}
        executors={this.state.executors}
        getProvider={id => this.state.providers.get(id)}
        toggleRegExpFilter={this._toggleRegExpFilter}
        updateFilterText={this._updateFilterText}
        onDisplayableRecordHeightChange={
          this._handleDisplayableRecordHeightChange
        }
        resetAllFilters={this._resetAllFilters}
      />
    );
  }

  serialize(): ConsolePersistedState {
    const {filterText, enableRegExpFilter, unselectedSourceIds} = this.state;
    return {
      deserializer: 'nuclide.ConsoleContainer',
      filterText,
      enableRegExpFilter,
      unselectedSourceIds,
    };
  }

  _selectSources = (selectedSourceIds: Array<string>): void => {
    const sourceIds = this.state.sources.map(source => source.id);
    const unselectedSourceIds = sourceIds.filter(
      sourceId => selectedSourceIds.indexOf(sourceId) === -1,
    );
    this.setState({unselectedSourceIds});
  };

  _toggleRegExpFilter = (): void => {
    this.setState({enableRegExpFilter: !this.state.enableRegExpFilter});
  };

  _updateFilterText = (filterText: string): void => {
    this.setState({filterText});
  };

  _getFilterPattern(
    filterText: string,
    isRegExp: boolean,
  ): {pattern: ?RegExp, isValid: boolean} {
    if (filterText === '') {
      return {pattern: null, isValid: true};
    }
    const source = isRegExp ? filterText : escapeStringRegexp(filterText);
    try {
      return {
        pattern: new RegExp(source, 'i'),
        isValid: true,
      };
    } catch (err) {
      return {
        pattern: null,
        isValid: false,
      };
    }
  }

  _handleDisplayableRecordHeightChange = (
    recordId: number,
    newHeight: number,
    callback: () => void,
  ): void => {
    const newDisplayableRecords = [];
    this.state.displayableRecords.forEach(displayableRecord => {
      if (displayableRecord.id === recordId) {
        // Update the changed record.
        const newDisplayableRecord = {
          ...displayableRecord,
          height: newHeight,
        };
        newDisplayableRecords.push(newDisplayableRecord);
        this._displayableRecords.set(
          displayableRecord.record,
          newDisplayableRecord,
        );
      } else {
        newDisplayableRecords.push(displayableRecord);
      }
    });
    this.setState(
      {
        displayableRecords: newDisplayableRecords,
      },
      callback,
    );
  };

  /**
   * Transforms the Records from the store into DisplayableRecords. This caches the result
   * per-ConsoleContainer instance because the same record can have different heights in different
   * containers.
   */
  _toDisplayableRecords(records: Array<Record>): Array<DisplayableRecord> {
    return records.map(record => {
      const displayableRecord = this._displayableRecords.get(record);
      if (displayableRecord != null) {
        return displayableRecord;
      }
      const newDisplayableRecord = {
        id: this._nextRecordId++,
        record,
        height: INITIAL_RECORD_HEIGHT,
        expansionStateId: {},
      };
      this._displayableRecords.set(record, newDisplayableRecord);
      return newDisplayableRecord;
    });
  }
}

function getSources(state: AppState): Array<Source> {
  // Convert the providers to a map of sources.
  const mapOfSources = new Map(
    Array.from(state.providers.entries()).map(([k, provider]) => {
      const source = {
        id: provider.id,
        name: provider.id,
        status: state.providerStatuses.get(provider.id) || 'stopped',
        start:
          typeof provider.start === 'function' ? provider.start : undefined,
        stop: typeof provider.stop === 'function' ? provider.stop : undefined,
      };
      return [k, source];
    }),
  );

  // Some providers may have been unregistered, but still have records. Add sources for them too.
  // TODO: Iterating over all the records to get this every time we get a new record is inefficient.
  for (let i = 0, len = state.records.length; i < len; i++) {
    const record = state.records[i];
    if (!mapOfSources.has(record.sourceId)) {
      mapOfSources.set(record.sourceId, {
        id: record.sourceId,
        name: record.sourceId,
        status: 'stopped',
        start: undefined,
        stop: undefined,
      });
    }
  }

  return Array.from(mapOfSources.values());
}

function filterRecords(
  displayableRecords: Array<DisplayableRecord>,
  selectedSourceIds: Array<string>,
  filterPattern: ?RegExp,
  filterSources: boolean,
): Array<DisplayableRecord> {
  if (!filterSources && filterPattern == null) {
    return displayableRecords;
  }

  return displayableRecords.filter(({record}) => {
    // Only filter regular messages
    if (record.kind !== 'message') {
      return true;
    }

    const sourceMatches = selectedSourceIds.indexOf(record.sourceId) !== -1;
    return (
      sourceMatches &&
      (filterPattern == null || filterPattern.test(record.text))
    );
  });
}
