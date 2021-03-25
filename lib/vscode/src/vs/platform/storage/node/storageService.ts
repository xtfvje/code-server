/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises } from 'fs';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { ILogService, LogLevel } from 'vs/platform/log/common/log';
import { StorageScope, WillSaveStateReason, IS_NEW_KEY, AbstractStorageService } from 'vs/platform/storage/common/storage';
import { SQLiteStorageDatabase, ISQLiteStorageDatabaseLoggingOptions } from 'vs/base/parts/storage/node/storage';
import { Storage, IStorageDatabase, IStorage, StorageHint } from 'vs/base/parts/storage/common/storage';
import { mark } from 'vs/base/common/performance';
import { join } from 'vs/base/common/path';
import { copy, exists, writeFile } from 'vs/base/node/pfs';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, IWorkspaceInitializationPayload } from 'vs/platform/workspaces/common/workspaces';
import { assertIsDefined } from 'vs/base/common/types';
import { Promises } from 'vs/base/common/async';

export class NativeStorageService extends AbstractStorageService {

	private static readonly WORKSPACE_STORAGE_NAME = 'state.vscdb';
	private static readonly WORKSPACE_META_NAME = 'workspace.json';

	private readonly globalStorage = new Storage(this.globalStorageDatabase);

	private workspaceStoragePath: string | undefined;
	private workspaceStorage: IStorage | undefined;
	private workspaceStorageListener: IDisposable | undefined;

	constructor(
		private globalStorageDatabase: IStorageDatabase,
		private payload: IWorkspaceInitializationPayload | undefined,
		@ILogService private readonly logService: ILogService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService
	) {
		super();

		this.registerListeners();
	}

	private registerListeners(): void {

		// Global Storage change events
		this._register(this.globalStorage.onDidChangeStorage(key => this.emitDidChangeValue(StorageScope.GLOBAL, key)));
	}

	protected async doInitialize(): Promise<void> {

		// Init all storage locations
		await Promises.settled([
			this.initializeGlobalStorage(),
			this.payload ? this.initializeWorkspaceStorage(this.payload) : Promise.resolve()
		]);
	}

	private initializeGlobalStorage(): Promise<void> {
		return this.globalStorage.init();
	}

	private async initializeWorkspaceStorage(payload: IWorkspaceInitializationPayload): Promise<void> {

		// Prepare workspace storage folder for DB
		try {
			const result = await this.prepareWorkspaceStorageFolder(payload);

			const useInMemoryStorage = !!this.environmentService.extensionTestsLocationURI; // no storage during extension tests!

			// Create workspace storage and initialize
			mark('code/willInitWorkspaceStorage');
			try {
				const workspaceStorage = this.createWorkspaceStorage(
					useInMemoryStorage ? SQLiteStorageDatabase.IN_MEMORY_PATH : join(result.path, NativeStorageService.WORKSPACE_STORAGE_NAME),
					result.wasCreated ? StorageHint.STORAGE_DOES_NOT_EXIST : undefined
				);
				await workspaceStorage.init();

				// Check to see if this is the first time we are "opening" this workspace
				const firstWorkspaceOpen = workspaceStorage.getBoolean(IS_NEW_KEY);
				if (firstWorkspaceOpen === undefined) {
					workspaceStorage.set(IS_NEW_KEY, result.wasCreated);
				} else if (firstWorkspaceOpen) {
					workspaceStorage.set(IS_NEW_KEY, false);
				}
			} finally {
				mark('code/didInitWorkspaceStorage');
			}
		} catch (error) {
			this.logService.error(`[storage] initializeWorkspaceStorage(): Unable to init workspace storage due to ${error}`);
		}
	}

	private createWorkspaceStorage(workspaceStoragePath: string, hint?: StorageHint): IStorage {

		// Logger for workspace storage
		const workspaceLoggingOptions: ISQLiteStorageDatabaseLoggingOptions = {
			logTrace: (this.logService.getLevel() === LogLevel.Trace) ? msg => this.logService.trace(msg) : undefined,
			logError: error => this.logService.error(error)
		};

		// Dispose old (if any)
		dispose(this.workspaceStorage);
		dispose(this.workspaceStorageListener);

		// Create new
		this.workspaceStoragePath = workspaceStoragePath;
		this.workspaceStorage = new Storage(new SQLiteStorageDatabase(workspaceStoragePath, { logging: workspaceLoggingOptions }), { hint });
		this.workspaceStorageListener = this.workspaceStorage.onDidChangeStorage(key => this.emitDidChangeValue(StorageScope.WORKSPACE, key));

		return this.workspaceStorage;
	}

	private getWorkspaceStorageFolderPath(payload: IWorkspaceInitializationPayload): string {
		return join(this.environmentService.workspaceStorageHome.fsPath, payload.id); // workspace home + workspace id;
	}

	private async prepareWorkspaceStorageFolder(payload: IWorkspaceInitializationPayload): Promise<{ path: string, wasCreated: boolean }> {
		const workspaceStorageFolderPath = this.getWorkspaceStorageFolderPath(payload);

		const storageExists = await exists(workspaceStorageFolderPath);
		if (storageExists) {
			return { path: workspaceStorageFolderPath, wasCreated: false };
		}

		await promises.mkdir(workspaceStorageFolderPath, { recursive: true });

		// Write metadata into folder
		this.ensureWorkspaceStorageFolderMeta(payload);

		return { path: workspaceStorageFolderPath, wasCreated: true };
	}

	private ensureWorkspaceStorageFolderMeta(payload: IWorkspaceInitializationPayload): void {
		let meta: object | undefined = undefined;
		if (isSingleFolderWorkspaceIdentifier(payload)) {
			meta = { folder: payload.uri.toString() };
		} else if (isWorkspaceIdentifier(payload)) {
			meta = { workspace: payload.configPath.toString() };
		}

		if (meta) {
			(async () => {
				try {
					const workspaceStorageMetaPath = join(this.getWorkspaceStorageFolderPath(payload), NativeStorageService.WORKSPACE_META_NAME);
					const storageExists = await exists(workspaceStorageMetaPath);
					if (!storageExists) {
						await writeFile(workspaceStorageMetaPath, JSON.stringify(meta, undefined, 2));
					}
				} catch (error) {
					this.logService.error(error);
				}
			})();
		}
	}

	protected getStorage(scope: StorageScope): IStorage | undefined {
		return scope === StorageScope.GLOBAL ? this.globalStorage : this.workspaceStorage;
	}

	protected getLogDetails(scope: StorageScope): string | undefined {
		return scope === StorageScope.GLOBAL ? this.environmentService.globalStorageHome.fsPath : this.workspaceStoragePath;
	}

	async close(): Promise<void> {

		// Stop periodic scheduler and idle runner as we now collect state normally
		this.stopFlushWhenIdle();

		// Signal as event so that clients can still store data
		this.emitWillSaveState(WillSaveStateReason.SHUTDOWN);

		// Do it
		await Promises.settled([
			this.globalStorage.close(),
			this.workspaceStorage ? this.workspaceStorage.close() : Promise.resolve()
		]);
	}

	async migrate(toWorkspace: IWorkspaceInitializationPayload): Promise<void> {
		if (this.workspaceStoragePath === SQLiteStorageDatabase.IN_MEMORY_PATH) {
			return; // no migration needed if running in memory
		}

		// Close workspace DB to be able to copy
		await this.workspaceStorage?.close();

		// Prepare new workspace storage folder
		const result = await this.prepareWorkspaceStorageFolder(toWorkspace);

		const newWorkspaceStoragePath = join(result.path, NativeStorageService.WORKSPACE_STORAGE_NAME);

		// Copy current storage over to new workspace storage
		await copy(assertIsDefined(this.workspaceStoragePath), newWorkspaceStoragePath, { preserveSymlinks: false });

		// Recreate and init workspace storage
		return this.createWorkspaceStorage(newWorkspaceStoragePath).init();
	}
}
