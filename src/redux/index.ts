import { combineReducers, configureStore, createListenerMiddleware, TypedStartListening } from '@reduxjs/toolkit';
import { enableMapSet } from 'immer';
import { TypedUseSelectorHook, useDispatch, useSelector, useStore } from 'react-redux';
import accountReducer from './account/account-slice';
import appReducer from './app/app-slice';
import fontsReducer from './fonts/fonts-slice';
import paramReducer from './param/param-slice';
import runtimeReducer from './runtime/runtime-slice';
import timelineReducer from './timeline/timeline-slice';
import viewportReducer from './viewport/viewport-slice';
import { lineDefinitionMiddleware } from './line-definition-middleware';

enableMapSet();

const rootReducer = combineReducers({
    account: accountReducer,
    app: appReducer,
    param: paramReducer,
    runtime: runtimeReducer,
    fonts: fontsReducer,
    timeline: timelineReducer,
    viewport: viewportReducer,
});
export type RootState = ReturnType<typeof rootReducer>;

const listenerMiddleware = createListenerMiddleware();

export const createStore = (preloadedState: Partial<RootState> = {}) =>
    configureStore({
        reducer: rootReducer,
        middleware: getDefaultMiddleware =>
            // undo slice contains MultiDirectedGraph instance, it is not meant to be serialized nor persisted.
            // Runtime state also deliberately contains transient Sets, so the serializable state check
            // is disabled and the line definition middleware is prepended.
            // https://stackoverflow.com/questions/61704805/getting-an-error-a-non-serializable-value-was-detected-in-the-state-when-using
            getDefaultMiddleware({ serializableCheck: false }).prepend(
                listenerMiddleware.middleware,
                lineDefinitionMiddleware
            ),
        preloadedState,
    });
export type RootStore = ReturnType<typeof createStore>;

export type RootDispatch = RootStore['dispatch'];
export const useRootDispatch = () => useDispatch<RootDispatch>();
export const useRootSelector: TypedUseSelectorHook<RootState> = useSelector;
export const useRootStore = () => useStore() as RootStore;

type RootStartListening = TypedStartListening<RootState, RootDispatch>;
export const startRootListening = listenerMiddleware.startListening as RootStartListening;
