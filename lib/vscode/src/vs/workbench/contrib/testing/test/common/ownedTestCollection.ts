/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Iterable } from 'vs/base/common/iterator';
import { OwnedTestCollection, SingleUseTestCollection, TestTree } from 'vs/workbench/contrib/testing/common/ownedTestCollection';
import { TestsDiff } from 'vs/workbench/contrib/testing/common/testCollection';
import { MainThreadTestCollection } from 'vs/workbench/contrib/testing/common/testServiceImpl';
import { testStubs } from 'vs/workbench/contrib/testing/common/testStubs';

export class TestSingleUseCollection extends SingleUseTestCollection {
	public get itemToInternal() {
		return this.testItemToInternal;
	}

	public get currentDiff() {
		return this.diff;
	}

	public setDiff(diff: TestsDiff) {
		this.diff = diff;
	}
}

export class TestOwnedTestCollection extends OwnedTestCollection {
	public get idToInternal() {
		return Iterable.first(this.testIdsToInternal)!;
	}

	public createForHierarchy(publishDiff: (diff: TestsDiff) => void = () => undefined) {
		return new TestSingleUseCollection(this.createIdMap(), publishDiff);
	}
}

/**
 * Gets a main thread test collection initialized with the given set of
 * roots/stubs.
 */
export const getInitializedMainTestCollection = (root = testStubs.nested()) => {
	const c = new MainThreadTestCollection(0);
	const singleUse = new TestSingleUseCollection({ object: new TestTree(), dispose: () => undefined }, () => undefined);
	singleUse.addRoot(root, 'provider');
	c.apply(singleUse.collectDiff());
	return c;
};
