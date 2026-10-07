import { MultiDirectedGraph } from 'graphology';
import React from 'react';
import { describe, expect, it } from 'vitest';

window.graph = new MultiDirectedGraph();

describe('AppRoot', () => {
    it('unmounts the tools panel while the map is in overview mode', async () => {
        window.history.replaceState({}, '', import.meta.env.BASE_URL);
        const store = createStore();
        render(<AppRoot />, { store });

        expect(await screen.findByTestId('tools-panel')).toBeInTheDocument();

        act(() => store.dispatch(setMapOverview(true)));
        expect(screen.queryByTestId('tools-panel')).not.toBeInTheDocument();

        act(() => store.dispatch(setMapOverview(false)));
        expect(await screen.findByTestId('tools-panel')).toBeInTheDocument();
    });
});
