/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, DisposableStore, dispose } from 'vs/base/common/lifecycle';
import { Schemas } from 'vs/base/common/network';
import { URI } from 'vs/base/common/uri';
import { CellKind, INotebookDocumentPropertiesChangeData, MainThreadNotebookShape } from 'vs/workbench/api/common/extHost.protocol';
import { ExtHostDocumentsAndEditors, IExtHostModelAddedData } from 'vs/workbench/api/common/extHostDocumentsAndEditors';
import * as extHostTypeConverters from 'vs/workbench/api/common/extHostTypeConverters';
import * as extHostTypes from 'vs/workbench/api/common/extHostTypes';
import { IMainCellDto, IOutputDto, IOutputItemDto, NotebookCellMetadata, NotebookCellsChangedEventDto, NotebookCellsChangeType, NotebookCellsSplice2, notebookDocumentMetadataDefaults } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import * as vscode from 'vscode';

class RawContentChangeEvent {

	constructor(readonly start: number, readonly deletedCount: number, readonly deletedItems: vscode.NotebookCell[], readonly items: ExtHostCell[]) { }

	static asApiEvent(event: RawContentChangeEvent): vscode.NotebookCellsChangeData {
		return Object.freeze({
			start: event.start,
			deletedCount: event.deletedCount,
			deletedItems: event.deletedItems,
			items: event.items.map(data => data.cell)
		});
	}
}

export class ExtHostCell {

	static asModelAddData(notebook: vscode.NotebookDocument, cell: IMainCellDto): IExtHostModelAddedData {
		return {
			EOL: cell.eol,
			lines: cell.source,
			modeId: cell.language,
			uri: cell.uri,
			isDirty: false,
			versionId: 1,
			notebook
		};
	}

	private _onDidDispose = new Emitter<void>();
	readonly onDidDispose: Event<void> = this._onDidDispose.event;

	private _outputs: extHostTypes.NotebookCellOutput[];
	private _metadata: extHostTypes.NotebookCellMetadata;

	readonly handle: number;
	readonly uri: URI;
	readonly cellKind: CellKind;

	private _cell: vscode.NotebookCell | undefined;

	constructor(
		private readonly _notebook: ExtHostNotebookDocument,
		private readonly _extHostDocument: ExtHostDocumentsAndEditors,
		private readonly _cellData: IMainCellDto,
	) {
		this.handle = _cellData.handle;
		this.uri = URI.revive(_cellData.uri);
		this.cellKind = _cellData.cellKind;
		this._outputs = _cellData.outputs.map(extHostTypeConverters.NotebookCellOutput.to);
		this._metadata = extHostTypeConverters.NotebookCellMetadata.to(_cellData.metadata ?? {});
	}

	dispose() {
		this._onDidDispose.fire();
		this._onDidDispose.dispose();
	}

	get cell(): vscode.NotebookCell {
		if (!this._cell) {
			const that = this;
			const data = this._extHostDocument.getDocument(this.uri);
			if (!data) {
				throw new Error(`MISSING extHostDocument for notebook cell: ${this.uri}`);
			}
			this._cell = Object.freeze({
				get index() { return that._notebook.getCellIndex(that); },
				notebook: that._notebook.notebookDocument,
				uri: that.uri,
				cellKind: extHostTypeConverters.NotebookCellKind.to(this._cellData.cellKind),
				document: data.document,
				get language() { return data!.document.languageId; },
				get outputs() { return that._outputs.slice(0); },
				set outputs(_value) { throw new Error('Use WorkspaceEdit to update cell outputs.'); },
				get metadata() { return that._metadata; },
				set metadata(_value) { throw new Error('Use WorkspaceEdit to update cell metadata.'); },
			});
		}
		return this._cell;
	}

	setOutputs(newOutputs: IOutputDto[]): void {
		this._outputs = newOutputs.map(extHostTypeConverters.NotebookCellOutput.to);
	}

	setOutputItems(outputId: string, append: boolean, newOutputItems: IOutputItemDto[]) {
		const newItems = newOutputItems.map(extHostTypeConverters.NotebookCellOutputItem.to);
		const output = this._outputs.find(op => op.id === outputId);
		if (output) {
			if (!append) {
				output.outputs.length = 0;
			}
			output.outputs.push(...newItems);
		}
	}

	setMetadata(newMetadata: NotebookCellMetadata): void {
		this._metadata = extHostTypeConverters.NotebookCellMetadata.to(newMetadata);
	}
}

export interface INotebookEventEmitter {
	emitModelChange(events: vscode.NotebookCellsChangeEvent): void;
	emitDocumentMetadataChange(event: vscode.NotebookDocumentMetadataChangeEvent): void;
	emitCellOutputsChange(event: vscode.NotebookCellOutputsChangeEvent): void;
	emitCellLanguageChange(event: vscode.NotebookCellLanguageChangeEvent): void;
	emitCellMetadataChange(event: vscode.NotebookCellMetadataChangeEvent): void;
}


export class ExtHostNotebookDocument extends Disposable {

	private static _handlePool: number = 0;
	readonly handle = ExtHostNotebookDocument._handlePool++;

	private _cells: ExtHostCell[] = [];

	private _cellDisposableMapping = new Map<number, DisposableStore>();

	private _notebook: vscode.NotebookDocument | undefined;
	private _versionId: number = 0;
	private _isDirty: boolean = false;
	private _backup?: vscode.NotebookDocumentBackup;
	private _disposed: boolean = false;

	constructor(
		private readonly _proxy: MainThreadNotebookShape,
		private readonly _documentsAndEditors: ExtHostDocumentsAndEditors,
		private readonly _emitter: INotebookEventEmitter,
		private readonly _viewType: string,
		private readonly _contentOptions: vscode.NotebookDocumentContentOptions,
		private _metadata: extHostTypes.NotebookDocumentMetadata,
		readonly uri: URI,
	) {
		super();
	}

	dispose() {
		this._disposed = true;
		super.dispose();
		dispose(this._cellDisposableMapping.values());
	}


	get notebookDocument(): vscode.NotebookDocument {
		if (!this._notebook) {
			const that = this;
			this._notebook = Object.freeze({
				get uri() { return that.uri; },
				get version() { return that._versionId; },
				get fileName() { return that.uri.fsPath; },
				get viewType() { return that._viewType; },
				get isDirty() { return that._isDirty; },
				get isUntitled() { return that.uri.scheme === Schemas.untitled; },
				get cells(): ReadonlyArray<vscode.NotebookCell> { return that._cells.map(cell => cell.cell); },
				get metadata() { return that._metadata; },
				set metadata(_value: Required<vscode.NotebookDocumentMetadata>) { throw new Error('Use WorkspaceEdit to update metadata.'); },
				get contentOptions() { return that._contentOptions; },
				save() { return that._save(); }
			});
		}
		return this._notebook;
	}

	updateBackup(backup: vscode.NotebookDocumentBackup): void {
		this._backup?.delete();
		this._backup = backup;
	}

	disposeBackup(): void {
		this._backup?.delete();
		this._backup = undefined;
	}

	acceptDocumentPropertiesChanged(data: INotebookDocumentPropertiesChangeData) {
		const newMetadata = {
			...notebookDocumentMetadataDefaults,
			...data.metadata
		};
		this._metadata = this._metadata.with(newMetadata);
		this._emitter.emitDocumentMetadataChange({ document: this.notebookDocument });
	}

	acceptModelChanged(event: NotebookCellsChangedEventDto, isDirty: boolean): void {
		this._versionId = event.versionId;
		this._isDirty = isDirty;
		event.rawEvents.forEach(e => {
			if (e.kind === NotebookCellsChangeType.Initialize) {
				this._spliceNotebookCells(e.changes, true);
			} if (e.kind === NotebookCellsChangeType.ModelChange) {
				this._spliceNotebookCells(e.changes, false);
			} else if (e.kind === NotebookCellsChangeType.Move) {
				this._moveCell(e.index, e.newIdx);
			} else if (e.kind === NotebookCellsChangeType.Output) {
				this._setCellOutputs(e.index, e.outputs);
			} else if (e.kind === NotebookCellsChangeType.OutputItem) {
				this._setCellOutputItems(e.index, e.outputId, e.append, e.outputItems);
			} else if (e.kind === NotebookCellsChangeType.ChangeLanguage) {
				this._changeCellLanguage(e.index, e.language);
			} else if (e.kind === NotebookCellsChangeType.ChangeCellMetadata) {
				this._changeCellMetadata(e.index, e.metadata);
			}
		});
	}

	private async _save(): Promise<boolean> {
		if (this._disposed) {
			return Promise.reject(new Error('Document has been closed'));
		}
		return this._proxy.$trySaveDocument(this.uri);
	}

	private _spliceNotebookCells(splices: NotebookCellsSplice2[], initialization: boolean): void {
		if (this._disposed) {
			return;
		}

		const contentChangeEvents: RawContentChangeEvent[] = [];
		const addedCellDocuments: IExtHostModelAddedData[] = [];
		const removedCellDocuments: URI[] = [];

		splices.reverse().forEach(splice => {
			const cellDtos = splice[2];
			const newCells = cellDtos.map(cell => {

				const extCell = new ExtHostCell(this, this._documentsAndEditors, cell);

				if (!initialization) {
					addedCellDocuments.push(ExtHostCell.asModelAddData(this.notebookDocument, cell));
				}

				if (!this._cellDisposableMapping.has(extCell.handle)) {
					const store = new DisposableStore();
					store.add(extCell);
					this._cellDisposableMapping.set(extCell.handle, store);
				}

				return extCell;
			});

			for (let j = splice[0]; j < splice[0] + splice[1]; j++) {
				this._cellDisposableMapping.get(this._cells[j].handle)?.dispose();
				this._cellDisposableMapping.delete(this._cells[j].handle);
			}

			const changeEvent = new RawContentChangeEvent(splice[0], splice[1], [], newCells);
			const deletedItems = this._cells.splice(splice[0], splice[1], ...newCells);
			for (let cell of deletedItems) {
				removedCellDocuments.push(cell.uri);
				changeEvent.deletedItems.push(cell.cell);
			}

			contentChangeEvents.push(changeEvent);
		});

		this._documentsAndEditors.acceptDocumentsAndEditorsDelta({
			addedDocuments: addedCellDocuments,
			removedDocuments: removedCellDocuments
		});

		if (!initialization) {
			this._emitter.emitModelChange({
				document: this.notebookDocument,
				changes: contentChangeEvents.map(RawContentChangeEvent.asApiEvent)
			});
		}
	}

	private _moveCell(index: number, newIdx: number): void {
		const cells = this._cells.splice(index, 1);
		this._cells.splice(newIdx, 0, ...cells);
		const changes: vscode.NotebookCellsChangeData[] = [{
			start: index,
			deletedCount: 1,
			deletedItems: cells.map(data => data.cell),
			items: []
		}, {
			start: newIdx,
			deletedCount: 0,
			deletedItems: [],
			items: cells.map(data => data.cell)
		}];
		this._emitter.emitModelChange({
			document: this.notebookDocument,
			changes
		});
	}

	private _setCellOutputs(index: number, outputs: IOutputDto[]): void {
		const cell = this._cells[index];
		cell.setOutputs(outputs);
		this._emitter.emitCellOutputsChange({ document: this.notebookDocument, cells: [cell.cell] });
	}

	private _setCellOutputItems(index: number, outputId: string, append: boolean, outputItems: IOutputItemDto[]): void {
		const cell = this._cells[index];
		cell.setOutputItems(outputId, append, outputItems);
		this._emitter.emitCellOutputsChange({ document: this.notebookDocument, cells: [cell.cell] });
	}

	private _changeCellLanguage(index: number, language: string): void {
		const cell = this._cells[index];
		const event: vscode.NotebookCellLanguageChangeEvent = { document: this.notebookDocument, cell: cell.cell, language };
		this._emitter.emitCellLanguageChange(event);
	}

	private _changeCellMetadata(index: number, newMetadata: NotebookCellMetadata | undefined): void {
		const cell = this._cells[index];
		cell.setMetadata(newMetadata || {});
		const event: vscode.NotebookCellMetadataChangeEvent = { document: this.notebookDocument, cell: cell.cell };
		this._emitter.emitCellMetadataChange(event);
	}

	getCellFromIndex(index: number): ExtHostCell | undefined {
		return this._cells[index];
	}

	getCell(cellHandle: number): ExtHostCell | undefined {
		return this._cells.find(cell => cell.handle === cellHandle);
	}

	getCellIndex(cell: ExtHostCell): number {
		return this._cells.indexOf(cell);
	}
}
