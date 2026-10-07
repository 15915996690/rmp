import { describe, expect, it } from 'vitest';
import { EdgeAttributes, GraphAttributes, NodeAttributes } from '../../constants/constants';
import { GlobalAlertId } from '../../constants/global-alerts';
import { LinePathType, LineStyleType } from '../../constants/lines';
import { MAX_MASTER_NODE_FREE } from '../../constants/master';
import { MiscNodeType } from '../../constants/nodes';
import { MAX_PARALLEL_LINES_FREE } from '../../util/parallel';
import { createStore } from '../index';
import store from '../store';
import { applyRedoAction, applyUndoAction, replaceProjectState } from '../param/param-slice';
import appReducer, {
    closeGlobalAlert,
    refreshEdgesThunk,
    refreshNodesThunk,
    setGlobalAlert,
    setMode,
} from './runtime-slice';

const realStore = store.getState();

describe('ParamSlice', () => {
    it('Can update refresh indicators on undo actions', () => {
        const nextState = appReducer(realStore.runtime, applyUndoAction());
        expect(nextState.refresh.nodes).not.toEqual(realStore.runtime.refresh.nodes);
        expect(nextState.refresh.edges).not.toEqual(realStore.runtime.refresh.edges);
    });

    it('Can update refresh indicators on redo actions', () => {
        const nextState = appReducer(realStore.runtime, applyRedoAction());
        expect(nextState.refresh.nodes).not.toEqual(realStore.runtime.refresh.nodes);
        expect(nextState.refresh.edges).not.toEqual(realStore.runtime.refresh.edges);
    });
});
